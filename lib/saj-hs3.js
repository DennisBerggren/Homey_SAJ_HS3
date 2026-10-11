'use strict';

const FAULT_MESSAGES = require('./fault-messages');

/**
 * Registerkarta för SAJ HS3, hämtad från stanus74/home-assistant-saj-h2-modbus
 * (modbus_readers.py, const.py). Alla läsningar är FC03 holding registers, unit id 1.
 *
 * Teckenkonvention VERIFIERAD mot Dennis HS3 (HA-historik 2026-10-03, 15:21–15:30):
 * batteryPower (0x40A6) var negativ (−4172 → −602 W) medan SOC steg 91,16 → 93,76 %.
 * => Negativt råvärde = laddning, positivt = urladdning.
 * (Integrationens wiki säger motsatsen — den stämmer inte för HS3.)
 *
 * Passivt läge (verifierat 2026-10-11 mot Dennis HS3, Tibber Smartstyrning avstängd):
 * Urladdningseffekten begränsas i praktiken av nätgränsen 0x3638, inte av batterigränsen 0x363A.
 * Med 0x363A = 167 ‰ och 0x3638 = 1000 ‰ rampade batteriet förbi 5,8 kW; med båda på 167 ‰ låg det stabilt kring 2 kW.
 * Laddning från nätet antas på samma sätt styras av 0x3637 (inte verifierat).
 * Med Tibber Smartstyrning PÅ accepteras skrivningarna men växelriktaren agerar inte på dem.
 *
 * Batteriblocket 0xA000 (Bat1SOC, kapacitet m.m.) returnerar 0 på HS3 och används därför inte.
 * SOC läses i stället från 0x406F (batEnergyPercent, ×0,01).
 */

const BLOCKS = {
  realtime: { address: 0x4004, count: 14 }, // läge, felregister, temperaturer
  battery: { address: 0x406E, count: 2 }, // batteritemp, SOC
  flow: { address: 0x4095, count: 25 }, // riktningar + effekter 0x40A0–0x40AD
  config: { address: 0x3636, count: 18 }, // passivt läge, SOC-gränser, app-läge
  energy: { address: 0x40BF, count: 32 }, // energiräknare (uint32, ×0,01 kWh)
  meter: { address: 0xA03F, count: 13 }, // SAJ-mätarens effekt per fas (A03F, A045, A04B)
  info: { address: 0x8F00, count: 29 }, // enhetsinfo, serienummer
};

const REG = {
  PASSIVE_ENABLE: 0x3636, // 0 = standby, 1 = urladdning, 2 = laddning (gäller i passivt läge)
  PASSIVE_GRID_CHARGE: 0x3637,
  PASSIVE_GRID_DISCHARGE: 0x3638,
  PASSIVE_BAT_CHARGE: 0x3639, // promille av märkeffekt (1000 = 100 %)
  PASSIVE_BAT_DISCHARGE: 0x363A, // promille av märkeffekt
  ON_GRID_DISCHARGE_DEPTH: 0x3644, // min-SOC vid nätdrift (%)
  OFF_GRID_DISCHARGE_DEPTH: 0x3645, // min-SOC vid ödrift (%)
  CHARGE_DEPTH: 0x3646, // max-SOC (%)
  APP_MODE: 0x3647,
};

const APP_MODES = {
  0: 'self_use',
  1: 'time_of_use',
  2: 'backup',
  3: 'passive',
};
const APP_MODE_VALUES = { self_use: 0, time_of_use: 1, backup: 2, passive: 3 };

// --- hjälpfunktioner ----------------------------------------------------------

const s16 = v => (v > 0x7FFF ? v - 0x10000 : v);
const u32 = (hi, lo) => hi * 0x10000 + lo;
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function decodeFaults(f0, f1, f2) {
  const msgs = [];
  [f0, f1, f2].forEach((code, i) => {
    if (!code) return;
    for (const [bit, msg] of Object.entries(FAULT_MESSAGES[i])) {
      // eslint-disable-next-line no-bitwise
      if ((code & Number(bit)) >>> 0) msgs.push(msg);
    }
  });
  return msgs;
}

// --- avkodning per block ------------------------------------------------------

function decodeRealtime(r) {
  const fault0 = u32(r[1], r[2]);
  const fault1 = u32(r[3], r[4]);
  const fault2 = u32(r[5], r[6]);
  return {
    workingMode: r[0],
    faultCodes: [fault0, fault1, fault2],
    faults: decodeFaults(fault0, fault1, fault2),
    inverterTemp: round(s16(r[12]) * 0.1, 1),
    ambientTemp: round(s16(r[13]) * 0.1, 1),
  };
}

function decodeBattery(r) {
  return {
    batteryTemp: round(s16(r[0]) * 0.1, 1),
    soc: round(r[1] * 0.01, 2),
  };
}

function decodeFlow(r) {
  return {
    directionBattery: s16(r[1]),
    totalLoadPower: s16(r[11]),
    pvPower: s16(r[16]),
    batteryPowerRaw: s16(r[17]), // negativ = laddar (verifierat)
    inverterAcPower: s16(r[20]),
    gridLoadPower: s16(r[24]),
  };
}

function decodeConfig(r) {
  return {
    passiveEnable: r[0],
    passiveGridChargePermille: r[1],
    passiveGridDischargePermille: r[2],
    passiveBatChargePermille: r[3],
    passiveBatDischargePermille: r[4],
    minSocOnGrid: r[14],
    minSocOffGrid: r[15],
    maxSoc: r[16],
    appModeRaw: r[17],
    appMode: APP_MODES[r[17]] || 'other',
  };
}

function decodeEnergy(r) {
  const kwh = i => round(u32(r[i], r[i + 1]) * 0.01, 2);
  return {
    batteryChargedToday: kwh(8), // 0x40C7
    batteryChargedTotal: kwh(14), // 0x40CD
    batteryDischargedToday: kwh(16), // 0x40CF
    batteryDischargedTotal: kwh(22), // 0x40D5
  };
}

function decodeMeter(r) {
  return {
    meterPower: s16(r[0]) + s16(r[6]) + s16(r[12]),
  };
}

function decodeInfo(r) {
  const ascii = regs => regs
    .map(v => String.fromCharCode((v >> 8) & 0xFF, v & 0xFF))
    .join('')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
  return {
    deviceType: r[0],
    subType: r[1],
    serial: ascii(r.slice(3, 13)),
    productCode: ascii(r.slice(13, 23)),
  };
}

module.exports = {
  BLOCKS,
  REG,
  APP_MODES,
  APP_MODE_VALUES,
  decodeRealtime,
  decodeBattery,
  decodeFlow,
  decodeConfig,
  decodeEnergy,
  decodeMeter,
  decodeInfo,
  s16,
};
