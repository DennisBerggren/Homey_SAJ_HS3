'use strict';

const { Driver } = require('homey');
const { ModbusTcpClient } = require('../../lib/modbus-tcp');
const SAJ = require('../../lib/saj-hs3');

class SajHs3Driver extends Driver {

  async onInit() {
    // --- Triggers ---
    this._batteryStateTrigger = this.homey.flow.getDeviceTriggerCard('battery_state_changed');
    this._batteryStateTrigger.registerRunListener(async (args, state) => args.state === 'any' || args.state === state.state);

    this._appModeTrigger = this.homey.flow.getDeviceTriggerCard('app_mode_changed');

    // --- Villkor ---
    this.homey.flow.getConditionCard('battery_state_is')
      .registerRunListener(async args => args.device.getBatteryState() === args.state);

    this.homey.flow.getConditionCard('app_mode_is')
      .registerRunListener(async args => args.device.getAppMode() === args.mode);

    // --- Åtgärder (kräver "Läs och skriv") ---
    this.homey.flow.getActionCard('charge_battery')
      .registerRunListener(async args => args.device.chargeBattery(args.watts));

    this.homey.flow.getActionCard('discharge_battery')
      .registerRunListener(async args => args.device.dischargeBattery(args.watts));

    this.homey.flow.getActionCard('standby_battery')
      .registerRunListener(async args => args.device.standby());

    this.homey.flow.getActionCard('release_control')
      .registerRunListener(async args => args.device.releaseControl());

    this.homey.flow.getActionCard('set_app_mode')
      .registerRunListener(async args => args.device.setAppMode(args.mode));

    this.homey.flow.getActionCard('set_soc_limits')
      .registerRunListener(async args => args.device.setSocLimits(args.min_soc, args.max_soc));

    this.log('SAJ HS3-drivrutin initierad');
  }

  triggerBatteryState(device, { state, power }) {
    const label = this.homey.__(`battery_state.${state}`) || state;
    return this._batteryStateTrigger.trigger(device, { state: label, power }, { state });
  }

  triggerAppMode(device, { mode }) {
    return this._appModeTrigger.trigger(device, { mode });
  }

  async onPair(session) {
    session.setHandler('test_connection', async ({ host, port, unitId }) => {
      if (!host || !String(host).trim()) throw new Error(this.homey.__('errors.host_required'));

      const client = new ModbusTcpClient({
        host: String(host).trim(),
        port: Number(port) || 502,
        unitId: Number(unitId) || 1,
        timeout: 6000,
      });

      try {
        const bat = SAJ.decodeBattery(await client.readHoldingRegisters(SAJ.BLOCKS.battery.address, SAJ.BLOCKS.battery.count));

        let info = {};
        try {
          info = SAJ.decodeInfo(await client.readHoldingRegisters(SAJ.BLOCKS.info.address, SAJ.BLOCKS.info.count));
        } catch (err) {
          this.log('Kunde inte läsa enhetsinfo (inte kritiskt):', err.message);
        }

        const id = info.serial || `saj-${String(host).trim()}`;
        return {
          soc: bat.soc,
          serial: info.serial || null,
          device: {
            name: 'SAJ HS3',
            data: { id },
            settings: {
              host: String(host).trim(),
              port: Number(port) || 502,
              unit_id: Number(unitId) || 1,
            },
          },
        };
      } catch (err) {
        if (/stängdes|closed|ECONNRESET/i.test(err.message)) throw new Error(this.homey.__('errors.slot_taken'));
        throw err;
      } finally {
        client.close();
      }
    });
  }

}

module.exports = SajHs3Driver;
