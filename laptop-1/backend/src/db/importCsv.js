import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { ChargingSession } from '../models/index.js';

// Imports Data/ev_charging_patterns.csv into chargingSessions with
// source 'historical_csv'. The file itself is only read, never changed.
//
// Checks are the Phase 1 domain rules. Rows are never dropped or "fixed":
// a problem lowers the row's quality and is written to qualityNotes.

const num = (v) => (v === undefined || v === '' ? null : Number(v));
// The CSV has no timezone. Times are stored as if they were UTC so that every
// machine shows the same hour; the summary endpoint labels hours as UTC.
const time = (v) => (v ? new Date(`${v.replace(' ', 'T')}Z`) : null);

export function assessRow(r) {
  const bad = [];
  const suspect = [];
  for (const [field, value] of Object.entries({
    energyKwh: r.energyKwh,
    chargingRateKw: r.chargingRateKw,
    distanceDrivenKm: r.distanceDrivenKm,
  })) {
    if (value === null || Number.isNaN(value)) suspect.push(`missing ${field}`);
  }
  if (!(r.batteryCapacityKwh > 0)) bad.push('battery capacity is not > 0');
  if (!(r.startSocPct >= 0 && r.startSocPct < r.endSocPct && r.endSocPct <= 100)) {
    bad.push(`SOC rule broken (start ${r.startSocPct?.toFixed(1)}%, end ${r.endSocPct?.toFixed(1)}%)`);
  }
  for (const k of ['energyKwh', 'durationHours', 'chargingRateKw', 'costUsd']) {
    if (r[k] !== null && r[k] < 0) bad.push(`${k} is negative`);
  }
  if (!(r.endedAt > r.startedAt)) bad.push('end time is not after start time');

  if (r.endedAt > r.startedAt && r.durationHours !== null) {
    const clockHours = (r.endedAt - r.startedAt) / 3_600_000;
    if (Math.abs(clockHours - r.durationHours) > 0.25) {
      suspect.push(`recorded duration ${r.durationHours.toFixed(2)} h vs end-start ${clockHours.toFixed(2)} h`);
    }
  }
  if (r.energyKwh > 0 && r.durationHours > 0 && r.chargingRateKw > 0) {
    const approx = r.durationHours * r.chargingRateKw;
    if (Math.abs(approx - r.energyKwh) / r.energyKwh > 0.5) {
      suspect.push(`energy ${r.energyKwh.toFixed(1)} kWh vs duration x rate ${approx.toFixed(1)} kWh`);
    }
  }
  const quality = bad.length ? 'bad' : suspect.length ? 'suspect' : 'good';
  return { quality, qualityNotes: [...bad, ...suspect] };
}

export function rowToSession(raw, index) {
  const s = {
    sessionId: `CSV-${String(index + 1).padStart(4, '0')}`,
    stationId: null, // the CSV's stations are not our station
    status: 'historical',
    startedAt: time(raw['Charging Start Time']),
    endedAt: time(raw['Charging End Time']),
    vehicleModel: raw['Vehicle Model'],
    batteryCapacityKwh: num(raw['Battery Capacity (kWh)']),
    vehicleAgeYears: num(raw['Vehicle Age (years)']),
    chargerType: raw['Charger Type'],
    startSocPct: num(raw['State of Charge (Start %)']),
    endSocPct: num(raw['State of Charge (End %)']),
    energyKwh: num(raw['Energy Consumed (kWh)']),
    durationHours: num(raw['Charging Duration (hours)']),
    chargingRateKw: num(raw['Charging Rate (kW)']),
    costUsd: num(raw['Charging Cost (USD)']),
    temperatureC: num(raw['Temperature (°C)']),
    distanceDrivenKm: num(raw['Distance Driven (since last charge) (km)']),
    timeOfDay: raw['Time of Day'],
    dayOfWeek: raw['Day of Week'],
    userType: raw['User Type'],
    location: raw['Charging Station Location'],
    csv: { row: index + 2, userId: raw['User ID'], stationRef: raw['Charging Station ID'] },
    source: 'historical_csv',
    isDemo: false,
  };
  return { ...s, ...assessRow(s) };
}

export async function importCsv(file) {
  const rows = parse(readFileSync(file), { columns: true, bom: true, skip_empty_lines: true, trim: true });
  const sessions = rows.map(rowToSession);

  let upserted = 0;
  let matched = 0;
  for (let i = 0; i < sessions.length; i += 500) {
    const ops = sessions.slice(i, i + 500).map((s) => ({
      updateOne: { filter: { sessionId: s.sessionId }, update: { $set: s }, upsert: true },
    }));
    const res = await ChargingSession.bulkWrite(ops, { ordered: false });
    upserted += res.upsertedCount;
    matched += res.matchedCount;
  }

  const quality = sessions.reduce((acc, s) => ({ ...acc, [s.quality]: (acc[s.quality] || 0) + 1 }), {});
  return { rows: rows.length, inserted: upserted, alreadyPresent: matched, quality };
}
