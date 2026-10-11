'use strict';

const { Device } = require('homey');
const { ModbusTcpClient } = require('../../lib/modbus-tcp');
const SAJ = require('../../lib/saj-hs3');

const IDLE_THRESHOLD_W = 50; // under detta räknas batteriet som vilande (brus ±40 W observerat)
const MAX_FAILURES_BEFORE_UNAVAILABLE = 3;
const PAUSE_BETWEEN_REQUESTS_MS = 100;
const GRID_LIMIT_MAX = 1000; // promille = 100 % av märkeffekten

const sleep = ms => new Promise(r => setTimeout(r, ms));

class SajHs3Device extends Device {

  async onInit() {
    this._failures = 0;
    this._polling = false;
    this._lastState = null;
    this._lastAppMode = null;
    this._energyBlockOk = true;

    await this._syncOptionalCapabilities(this.getSettings());
    this._createClient();
    this._startPolling();

    this.log(`SAJ HS3 initierad (${this.getSetting('host')}:${this.getSetting('port')}, läge: ${this.getSetting('write_mode')})`);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some(k => ['host', 'port', 'unit_id'].includes(k))) {
      if (!newSettings.host || !String(newSettings.host).trim()) {
        throw new Error(this.homey.__('errors.host_required'));
      }
      this._client.close();
      this._createClient(newSettings);
    }
    if (changedKeys.includes('show_grid_meter')) {
      await this._syncOptionalCapabilities(newSettings);
    }
    if (changedKeys.includes('poll_interval')) {
      this._startPolling(newSettings.poll_interval);
    }
    // kör en poll direkt med nya inställningar
    this.homey.setTimeout(() => this.poll().catch(this.error), 500);
  }

  async onUninit() {
    this._stop();
  }

  async onDeleted() {
    this._stop();
  }

  // ---------------------------------------------------------------------------
  // Uppsättning

  _createClient(settings = this.getSettings()) {
    this._client = new ModbusTcpClient({
      host: String(settings.host).trim(),
      port: settings.port,
      unitId: settings.unit_id,
      timeout: 5000,
    });
  }

  _startPolling(intervalSec = this.getSetting('poll_interval')) {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    const sec = Math.max(10, Number(intervalSec) || 60);
    this._pollTimer = this.homey.setInterval(() => this.poll().catch(this.error), sec * 1000);
    this.poll().catch(this.error);
  }

  _stop() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this._client) this._client.close();
  }

  async _syncOptionalCapabilities(settings) {
    const want = !!settings.show_grid_meter;
    const has = this.hasCapability('measure_power.grid');
    if (want && !has) await this.addCapability('measure_power.grid');
    if (!want && has) await this.removeCapability('measure_power.grid');
  }

  // ---------------------------------------------------------------------------
  // Läsning

  async _read(block) {
    const { address, count } = SAJ.BLOCKS[block];
    const regs = await this._client.readHoldingRegisters(address, count);
    await sleep(PAUSE_BETWEEN_REQUESTS_MS);
    return regs;
  }

  async poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const rt = SAJ.decodeRealtime(await this._read('realtime'));
      const bat = SAJ.decodeBattery(await this._read('battery'));
      const flow = SAJ.decodeFlow(await this._read('flow'));
      const cfg = SAJ.decodeConfig(await this._read('config'));

      let energy = null;
      if (this._energyBlockOk !== false) {
        try {
          energy = SAJ.decodeEnergy(await this._read('energy'));
        } catch (err) {
          this.error('Energiräknare kunde inte läsas, hoppar över dem framöver:', err.message);
          this._energyBlockOk = false;
        }
      }

      let meter = null;
      if (this.getSetting('show_grid_meter')) {
        try {
          meter = SAJ.decodeMeter(await this._read('meter'));
        } catch (err) {
          this.error('SAJ-mätaren kunde inte läsas:', err.message);
        }
      }

      await this._apply({ rt, bat, flow, cfg, energy, meter });

      this._failures = 0;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this._failures = (this._failures || 0) + 1;
      this.error(`Poll misslyckades (${this._failures}):`, err.message);
      if (this._failures >= MAX_FAILURES_BEFORE_UNAVAILABLE && this.getAvailable()) {
        await this.setUnavailable(this.homey.__('errors.no_contact', { error: this._explain(err) })).catch(this.error);
      }
    } finally {
      this._client.close(); // frigör Modbus-platsen i AIO3 mellan pollningar
      this._polling = false;
    }
  }

  async _apply({ rt, bat, flow, cfg, energy, meter }) {
    // Homey: positivt = laddar, negativt = laddar ur. HS3 rapporterar tvärtom.
    const batteryPower = -flow.batteryPowerRaw;
    let state = 'idle';
    if (batteryPower > IDLE_THRESHOLD_W) state = 'charging';
    else if (batteryPower < -IDLE_THRESHOLD_W) state = 'discharging';

    const statusKey = `status.${rt.workingMode}`;
    const translated = this.homey.__(statusKey);
    const statusText = translated && translated !== statusKey ? translated : `Unknown (${rt.workingMode})`;
    const status = rt.faults.length
      ? `${statusText} – ${rt.faults.join(', ')}`.slice(0, 250)
      : statusText;

    const set = (cap, val) => (this.hasCapability(cap) && val != null && !Number.isNaN(val)
      ? this.setCapabilityValue(cap, val).catch(e => this.error(`${cap}:`, e.message))
      : null);

    await Promise.all([
      set('measure_battery', bat.soc),
      set('measure_power', batteryPower),
      set('saj_battery_state', state),
      set('measure_temperature', bat.batteryTemp),
      set('measure_temperature.inverter', rt.inverterTemp),
      set('saj_app_mode', cfg.appMode),
      set('saj_soc_min', cfg.minSocOnGrid),
      set('saj_soc_max', cfg.maxSoc),
      set('saj_status', status),
      set('alarm_generic', rt.faults.length > 0),
      energy && set('meter_power.charged', energy.batteryChargedTotal),
      energy && set('meter_power.discharged', energy.batteryDischargedTotal),
      meter && set('measure_power.grid', this.getSetting('invert_grid') ? -meter.meterPower : meter.meterPower),
    ]);

    this._cfg = cfg;

    // Triggers
    if (this._lastState != null && state !== this._lastState) {
      this.driver.triggerBatteryState(this, { state, power: batteryPower })
        .catch(e => this.error('Trigger batteriläge:', e.message));
    }
    this._lastState = state;

    if (this._lastAppMode != null && cfg.appMode !== this._lastAppMode) {
      this.driver.triggerAppMode(this, { mode: cfg.appMode })
        .catch(e => this.error('Trigger app-läge:', e.message));
    }
    this._lastAppMode = cfg.appMode;

    this.log(`SOC=${bat.soc}% Batteri=${batteryPower}W (${state}) Läge=${cfg.appMode} `
      + `Min/Max=${cfg.minSocOnGrid}/${cfg.maxSoc}% Status=${status}`);
  }

  // ---------------------------------------------------------------------------
  // Skrivning (endast när write_mode = readwrite)

  _assertWritable() {
    if (this.getSetting('write_mode') !== 'readwrite') {
      throw new Error(this.homey.__('errors.write_disabled'));
    }
  }

  _wattsToPermille(watts) {
    const rated = Number(this.getSetting('rated_power')) || 12000;
    const w = Math.max(0, Number(watts) || 0);
    let p = Math.round((w / rated) * 1000);
    if (w > 0 && p === 0) p = 1;
    return Math.min(1000, p);
  }

  async _write(address, value) {
    this.log(`Skriver 0x${address.toString(16)} = ${value}`);
    await this._client.writeSingleRegister(address, value);
    await sleep(PAUSE_BETWEEN_REQUESTS_MS);
  }

  async _withConnection(fn) {
    // vänta in eventuell pågående poll
    for (let i = 0; i < 50 && this._polling; i++) await sleep(100);
    this._polling = true;
    try {
      return await fn();
    } finally {
      this._client.close();
      this._polling = false;
      this.homey.setTimeout(() => this.poll().catch(this.error), 1500);
    }
  }

  async _readConfig() {
    return SAJ.decodeConfig(await this._read('config'));
  }

  async _rememberModeBeforePassive(cfg) {
    if (cfg.appModeRaw !== SAJ.APP_MODE_VALUES.passive) {
      await this.setStoreValue('appModeBeforePassive', cfg.appModeRaw);
    }
  }

  async _restoreGridLimits() {
    // Släpp nätgränserna till max så att de inte stryper Tibber eller andra lägen efteråt.
    await this._write(SAJ.REG.PASSIVE_GRID_CHARGE, GRID_LIMIT_MAX);
    await this._write(SAJ.REG.PASSIVE_GRID_DISCHARGE, GRID_LIMIT_MAX);
  }

  async chargeBattery(watts) {
    this._assertWritable();
    const permille = this._wattsToPermille(watts);
    await this._withConnection(async () => {
      const cfg = await this._readConfig();
      await this._rememberModeBeforePassive(cfg);
      // Batteri- och nätgräns sätts båda; nätgränsen (0x3637) antas styra laddning från nätet.
      await this._write(SAJ.REG.PASSIVE_BAT_CHARGE, permille);
      await this._write(SAJ.REG.PASSIVE_GRID_CHARGE, permille);
      if (cfg.appModeRaw !== SAJ.APP_MODE_VALUES.passive) await this._write(SAJ.REG.APP_MODE, SAJ.APP_MODE_VALUES.passive);
      await this._write(SAJ.REG.PASSIVE_ENABLE, 2);
      await this._verify({
        appModeRaw: 3, passiveEnable: 2, passiveBatChargePermille: permille, passiveGridChargePermille: permille,
      });
    });
    this.log(`Laddar med ${watts} W (${permille} ‰)`);
  }

  async dischargeBattery(watts) {
    this._assertWritable();
    const permille = this._wattsToPermille(watts);
    await this._withConnection(async () => {
      const cfg = await this._readConfig();
      await this._rememberModeBeforePassive(cfg);
      // Verifierat: urladdningseffekten begränsas av nätgränsen 0x3638, inte bara batterigränsen.
      await this._write(SAJ.REG.PASSIVE_BAT_DISCHARGE, permille);
      await this._write(SAJ.REG.PASSIVE_GRID_DISCHARGE, permille);
      if (cfg.appModeRaw !== SAJ.APP_MODE_VALUES.passive) await this._write(SAJ.REG.APP_MODE, SAJ.APP_MODE_VALUES.passive);
      await this._write(SAJ.REG.PASSIVE_ENABLE, 1);
      await this._verify({
        appModeRaw: 3, passiveEnable: 1, passiveBatDischargePermille: permille, passiveGridDischargePermille: permille,
      });
    });
    this.log(`Laddar ur med ${watts} W (${permille} ‰)`);
  }

  async standby() {
    this._assertWritable();
    await this._withConnection(async () => {
      const cfg = await this._readConfig();
      await this._rememberModeBeforePassive(cfg);
      if (cfg.appModeRaw !== SAJ.APP_MODE_VALUES.passive) await this._write(SAJ.REG.APP_MODE, SAJ.APP_MODE_VALUES.passive);
      await this._write(SAJ.REG.PASSIVE_ENABLE, 0);
      await this._restoreGridLimits();
      await this._verify({
        appModeRaw: 3, passiveEnable: 0, passiveGridChargePermille: GRID_LIMIT_MAX, passiveGridDischargePermille: GRID_LIMIT_MAX,
      });
    });
    this.log('Batteriet i vila (passivt läge, standby)');
  }

  async releaseControl() {
    this._assertWritable();
    const stored = this.getStoreValue('appModeBeforePassive');
    const target = Number.isInteger(stored) && stored !== SAJ.APP_MODE_VALUES.passive
      ? stored
      : SAJ.APP_MODE_VALUES.self_use;
    await this._withConnection(async () => {
      await this._write(SAJ.REG.PASSIVE_ENABLE, 0);
      await this._restoreGridLimits();
      await this._write(SAJ.REG.APP_MODE, target);
      await this._verify({
        appModeRaw: target, passiveGridChargePermille: GRID_LIMIT_MAX, passiveGridDischargePermille: GRID_LIMIT_MAX,
      });
    });
    await this.unsetStoreValue('appModeBeforePassive');
    this.log(`Släppte kontrollen, app-läge = ${SAJ.APP_MODES[target]}`);
  }

  async setAppMode(mode) {
    this._assertWritable();
    const value = SAJ.APP_MODE_VALUES[mode];
    if (value === undefined) throw new Error(this.homey.__('errors.unknown_mode', { mode }));
    await this._withConnection(async () => {
      if (value === SAJ.APP_MODE_VALUES.passive) await this._rememberModeBeforePassive(await this._readConfig());
      await this._write(SAJ.REG.APP_MODE, value);
      await this._verify({ appModeRaw: value });
    });
  }

  async setSocLimits(minSoc, maxSoc) {
    this._assertWritable();
    const min = Math.round(Number(minSoc));
    const max = Math.round(Number(maxSoc));
    if (!(min >= 0 && min <= 100 && max >= 0 && max <= 100)) throw new Error(this.homey.__('errors.soc_range'));
    if (!(max > min + 5)) throw new Error(this.homey.__('errors.soc_gap'));

    await this._withConnection(async () => {
      const cfg = await this._readConfig();
      if (!(min > cfg.minSocOffGrid + 5)) {
        throw new Error(this.homey.__('errors.soc_offgrid', { limit: cfg.minSocOffGrid }));
      }
      // Skriv i en ordning som håller villkoret max > min + 5 uppfyllt även mellan stegen.
      if (min > cfg.minSocOnGrid) {
        await this._write(SAJ.REG.CHARGE_DEPTH, max);
        await this._write(SAJ.REG.ON_GRID_DISCHARGE_DEPTH, min);
      } else {
        await this._write(SAJ.REG.ON_GRID_DISCHARGE_DEPTH, min);
        await this._write(SAJ.REG.CHARGE_DEPTH, max);
      }
      await this._verify({ minSocOnGrid: min, maxSoc: max });
    });
  }

  async _verify(expected) {
    const cfg = await this._readConfig();
    const wrong = Object.entries(expected).filter(([k, v]) => cfg[k] !== v);
    if (wrong.length) {
      const details = wrong.map(([k, v]) => `${k}: ${v} → ${cfg[k]}`).join('; ');
      throw new Error(this.homey.__('errors.verify_failed', { details }));
    }
  }

  _explain(err) {
    // AIO3 accepterar TCP men stänger direkt när alla Modbus-platser är upptagna.
    if (/stängdes|closed|ECONNRESET/i.test(err.message)) return this.homey.__('errors.slot_taken');
    return err.message;
  }

  // Används av flödesvillkor
  getBatteryState() {
    return this.getCapabilityValue('saj_battery_state');
  }

  getAppMode() {
    return this.getCapabilityValue('saj_app_mode');
  }

}

module.exports = SajHs3Device;
