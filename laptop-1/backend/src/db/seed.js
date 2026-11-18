import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA_DIR } from '../contracts.js';
import { DEFAULT_HEALTH_NOTES } from '../domain/labels.js';
import { Battery, Charger, HealthEstimate, Station, Vehicle } from '../models/index.js';

// Demo data for the dashboard. Every record is isDemo: true and source
// 'manual'. Running it twice changes nothing (upserts by id).
//
// Deliberately NOT seeded: telemetry readings and alerts. Fake "live" values
// would be exactly what the plan says to avoid.

const DEMO = { isDemo: true, source: 'manual', quality: 'unknown' };

export const DEMO_CHARGERS = [
  { bay: 1, chargerType: 'Level 2', maxPowerKw: 11, connector: 'Type 2' },
  { bay: 2, chargerType: 'Level 2', maxPowerKw: 11, connector: 'Type 2' },
  { bay: 3, chargerType: 'DC Fast Charger', maxPowerKw: 50, connector: 'CCS2' },
  { bay: 4, chargerType: 'DC Fast Charger', maxPowerKw: 150, connector: 'CCS2' },
];

// Typical usable capacities, rounded. Profiles for the form, not real cars.
const DEMO_VEHICLES = [
  { model: 'Tesla Model 3', batteryCapacityKwh: 75, vehicleAgeYears: 3 },
  { model: 'Nissan Leaf', batteryCapacityKwh: 40, vehicleAgeYears: 5 },
  { model: 'Chevy Bolt', batteryCapacityKwh: 65, vehicleAgeYears: 4 },
  { model: 'Hyundai Kona', batteryCapacityKwh: 64, vehicleAgeYears: 2 },
  { model: 'BMW i3', batteryCapacityKwh: 42, vehicleAgeYears: 6 },
];

const slug = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-');

export async function seedDemo(stationId) {
  const upsert = (Model, key, doc) =>
    Model.updateOne({ [key]: doc[key] }, { $set: doc }, { upsert: true });

  await upsert(Station, 'stationId', {
    stationId,
    name: 'Demo charging station (not a real site)',
    city: 'Demo city',
    maxPowerKw: 180,
    status: 'online',
    ...DEMO,
  });

  for (const c of DEMO_CHARGERS) {
    const chargerId = `${stationId}-BAY-${c.bay}`;
    // Static facts are always (re)written; live state only on first insert,
    // so re-seeding doesn't stop a running simulated session.
    await Charger.updateOne(
      { chargerId },
      {
        $set: { chargerId, stationId, ...c, ...DEMO },
        $setOnInsert: { status: 'available', statusSource: 'manual', statusUpdatedAt: new Date() },
      },
      { upsert: true },
    );
  }

  for (const v of DEMO_VEHICLES) {
    const vehicleId = `DEMO-${slug(v.model)}`;
    const batteryId = `${vehicleId}-PACK`;
    await upsert(Vehicle, 'vehicleId', { vehicleId, label: `${v.model} (demo profile)`, batteryId, ...v, ...DEMO });
    await upsert(Battery, 'batteryId', {
      batteryId,
      vehicleId,
      chemistry: 'unknown',
      nominalCapacityKwh: v.batteryCapacityKwh,
      notes: 'Demo pack. Chemistry not recorded. The SOH/RUL model was trained on Li-ion 18650 LiCoO2 lab cells, so its estimates do not transfer to this pack without calibration.',
      ...DEMO,
    });
  }

  // One health estimate copied from the schema example, so the Battery Health
  // page has something to render before the worker publishes real ones.
  const example = JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'examples', 'health-result.json'), 'utf8'));
  await upsert(HealthEstimate, 'healthEstimateId', {
    healthEstimateId: `DEMO-${example.messageId}`,
    requestId: example.requestId,
    status: example.status,
    ...example.health,
    model: example.model,
    warnings: ['Demo record copied from shared/schemas/examples/health-result.json. Not produced by the model.'],
    applicabilityNotes: example.applicabilityNotes?.length ? example.applicabilityNotes : DEFAULT_HEALTH_NOTES,
    processedAt: new Date(example.processedAt),
    ...DEMO,
  });

  return {
    stations: 1,
    chargers: DEMO_CHARGERS.length,
    vehicles: DEMO_VEHICLES.length,
    batteries: DEMO_VEHICLES.length,
    healthEstimates: 1,
  };
}
