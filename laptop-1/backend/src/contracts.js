// Loads the JSON Schemas from shared/schemas (written in Phase 4) so the
// backend checks MQTT payloads against exactly the same contract the Python
// worker uses. Nothing here is duplicated by hand.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = process.env.SHARED_SCHEMA_DIR
  ? path.resolve(process.env.SHARED_SCHEMA_DIR)
  : path.resolve(here, '../../../shared/schemas');

export function readSchema(name) {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);

const schemas = {
  chargingRequest: readSchema('charging-request.schema.json'),
  chargingResult: readSchema('charging-result.schema.json'),
  healthResult: readSchema('health-result.schema.json'),
  stationStatus: readSchema('station-status.schema.json'),
  telemetryTemperature: readSchema('telemetry-temperature.schema.json'),
  alert: readSchema('alert.schema.json'),
};

const compiled = Object.fromEntries(
  Object.entries(schemas).map(([key, schema]) => [key, ajv.compile(schema)]),
);

function describe(errors = []) {
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
}

// Returns { ok: true } or { ok: false, message }.
export function check(kind, payload) {
  const validate = compiled[kind];
  if (!validate) throw new Error(`Unknown contract: ${kind}`);
  return validate(payload) ? { ok: true } : { ok: false, message: describe(validate.errors) };
}

// Enumerations the HTTP layer reuses, so the API can never accept a vehicle
// model or charger type that the trained pipelines have not seen.
const req = schemas.chargingRequest.properties;
export const ENUMS = {
  vehicleModels: req.vehicle.properties.model.enum,
  chargerTypes: req.charging.properties.chargerType.enum,
  temperatureSources: req.environment.properties.source.enum,
};
export const LIMITS = {
  batteryCapacityKwhMax: req.vehicle.properties.batteryCapacityKwh.maximum,
  vehicleAgeYearsMax: req.vehicle.properties.vehicleAgeYears.maximum,
  requestedRateKwMax: req.charging.properties.requestedRateKw.maximum,
  temperatureCMin: req.environment.properties.temperatureC.minimum,
  temperatureCMax: req.environment.properties.temperatureC.maximum,
};
export const SCHEMA_VERSION = schemas.chargingRequest.properties.schemaVersion.const;
