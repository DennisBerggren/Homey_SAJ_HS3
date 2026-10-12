'use strict';

const net = require('net');

/**
 * Minimal Modbus TCP-klient (FC03 läs holding registers, FC06 skriv ett register).
 *
 * - En förfrågan åt gången (köad). SAJ:s AIO3-modul är känslig, så vi pipelinar inte.
 * - Inga externa beroenden.
 * - Appen ansluter per pollcykel och stänger efteråt, så att Homey inte håller
 *   en Modbus-plats i AIO3 öppen i onödan (Tibber Bridge och HA använder också modulen).
 */

function closedError() {
  const err = new Error('Modbus connection closed');
  err.code = 'CLOSED';
  return err;
}

class ModbusException extends Error {
  constructor(code, fc) {
    const names = {
      1: 'Illegal function',
      2: 'Illegal data address',
      3: 'Illegal data value',
      4: 'Server device failure',
      6: 'Server device busy',
      11: 'Gateway target device failed to respond',
    };
    super(`Modbus exception ${code} (${names[code] || 'unknown'}) on function ${fc}`);
    this.modbusCode = code;
    this.code = 'MODBUS_EXCEPTION';
    this.fc = fc;
  }
}

class ModbusTcpClient {

  constructor({ host, port = 502, unitId = 1, timeout = 5000 }) {
    this.host = host;
    this.port = Number(port) || 502;
    this.unitId = Number(unitId) || 1;
    this.timeout = timeout;

    this._socket = null;
    this._connected = false;
    this._connecting = null;
    this._buf = Buffer.alloc(0);
    this._tid = 0;
    this._pending = new Map();
    this._queue = Promise.resolve();
  }

  get connected() {
    return this._connected;
  }

  connect() {
    if (this._connected) return Promise.resolve();
    if (this._connecting) return this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this._socket = socket;
      this._buf = Buffer.alloc(0);
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        const err = new Error(`Connection to ${this.host}:${this.port} timed out`);
        err.code = 'CONNECT_TIMEOUT';
        socket.destroy(err);
      }, this.timeout);

      const onConnectError = err => {
        clearTimeout(timer);
        this._connecting = null;
        this._connected = false;
        reject(err);
      };

      socket.once('error', onConnectError);

      socket.connect(this.port, this.host, () => {
        clearTimeout(timer);
        socket.removeListener('error', onConnectError);
        this._connected = true;
        this._connecting = null;

        socket.on('data', chunk => {
          if (this._socket === socket) this._onData(chunk);
        });
        socket.on('error', err => {
          if (this._socket === socket) this._failAll(err);
        });
        socket.on('close', () => {
          if (this._socket === socket) {
            this._connected = false;
            this._failAll(closedError());
          }
        });
        resolve();
      });
    });

    return this._connecting;
  }

  close() {
    const socket = this._socket;
    this._socket = null;
    this._connected = false;
    this._connecting = null;
    this._buf = Buffer.alloc(0);
    this._failAll(closedError());
    if (socket) socket.destroy();
  }

  async readHoldingRegisters(address, count) {
    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(address, 0);
    payload.writeUInt16BE(count, 2);
    const body = await this._request(0x03, payload);
    const byteCount = body.readUInt8(0);
    if (byteCount !== count * 2 || body.length < 1 + byteCount) {
      throw new Error(`Unexpected response reading 0x${address.toString(16)} (${byteCount} bytes, expected ${count * 2})`);
    }
    const regs = new Array(count);
    for (let i = 0; i < count; i++) regs[i] = body.readUInt16BE(1 + i * 2);
    return regs;
  }

  async writeSingleRegister(address, value) {
    const v = Number(value);
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFF) {
      throw new Error(`Invalid register value ${value} for 0x${address.toString(16)}`);
    }
    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(address, 0);
    payload.writeUInt16BE(v, 2);
    const body = await this._request(0x06, payload);
    if (body.length < 4 || body.readUInt16BE(0) !== address || body.readUInt16BE(2) !== v) {
      throw new Error(`Inverter did not confirm write to 0x${address.toString(16)}`);
    }
    return true;
  }

  // ---------------------------------------------------------------------------

  _request(fc, payload) {
    const run = () => this._send(fc, payload);
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async _send(fc, payload) {
    await this.connect();

    this._tid = (this._tid + 1) & 0xFFFF;
    const tid = this._tid;
    const pdu = Buffer.concat([Buffer.from([fc]), payload]);
    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(tid, 0); // transaction id
    mbap.writeUInt16BE(0, 2); // protocol id
    mbap.writeUInt16BE(pdu.length + 1, 4); // längd (unit id + PDU)
    mbap.writeUInt8(this.unitId, 6);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(tid)) {
          const err = new Error(`No Modbus response (function ${fc})`);
          err.code = 'RESPONSE_TIMEOUT';
          reject(err);
          this.close(); // tvinga ny anslutning nästa gång
        }
      }, this.timeout);

      this._pending.set(tid, { fc, resolve, reject, timer });
      this._socket.write(Buffer.concat([mbap, pdu]));
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 7) {
      const len = this._buf.readUInt16BE(4);
      const total = 6 + len;
      if (this._buf.length < total) break;

      const frame = this._buf.subarray(0, total);
      this._buf = this._buf.subarray(total);

      const tid = frame.readUInt16BE(0);
      const pending = this._pending.get(tid);
      if (!pending) continue; // sent svar efter timeout
      this._pending.delete(tid);
      clearTimeout(pending.timer);

      const fc = frame.readUInt8(7);
      const body = frame.subarray(8);
      if (fc & 0x80) {
        pending.reject(new ModbusException(body.length ? body.readUInt8(0) : 0, pending.fc));
      } else if (fc !== pending.fc) {
        pending.reject(new Error(`Unexpected function code ${fc} (expected ${pending.fc})`));
      } else {
        pending.resolve(body);
      }
    }
  }

  _failAll(err) {
    for (const [tid, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this._pending.delete(tid);
    }
  }

}

module.exports = { ModbusTcpClient, ModbusException };
