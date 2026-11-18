import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { check, SCHEMA_DIR } from '../src/contracts.js';
import { chargingRequestBody } from '../src/validators/chargingRequest.js';

const example = (name) => JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'examples', name), 'utf8'));

describe('shared schema examples', () => {
  it('charging-request example matches its schema', () => {
    const res = check('chargingRequest', example('charging-request.json'));
    assert.equal(res.ok, true, res.message);
  });

  it('charging-result example matches its schema', () => {
    const res = check('chargingResult', example('charging-result.json'));
    assert.equal(res.ok, true, res.message);
  });

  it('health-result example matches its schema', () => {
    const res = check('healthResult', example('health-result.json'));
    assert.equal(res.ok, true, res.message);
  });

  it('rejects the worker error reply that uses requestId "unknown"', () => {
    const res = check('chargingResult', {
      schemaVersion: '1.0',
      messageId: '6487b02c-5bdc-479b-b4e3-2ef304998ff4',
      requestId: 'unknown',
      status: 'error',
      processedAt: '2026-11-17T16:35:15.878323+00:00',
      error: { code: 'INVALID_JSON', message: 'Payload is not valid JSON.' },
    });
    assert.equal(res.ok, false);
  });

  it('accepts the Python worker timestamp format (microseconds + offset)', () => {
    const res = check('chargingResult', {
      schemaVersion: '1.0',
      messageId: '6487b02c-5bdc-479b-b4e3-2ef304998ff4',
      requestId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      status: 'completed',
      processedAt: '2026-11-17T16:35:15.878323+00:00',
      predictions: { durationHours: 2.1737, energyKwh: 38.8176 },
    });
    assert.equal(res.ok, true, res.message);
  });
});

describe('POST body validator', () => {
  const good = {
    vehicle: { model: 'Tesla Model 3', batteryCapacityKwh: 75, vehicleAgeYears: 3 },
    charging: { startSocPct: 25, targetSocPct: 80, chargerType: 'DC Fast Charger', requestedRateKw: 50 },
    environment: { temperatureC: 30, source: 'simulation' },
  };

  it('accepts a normal request', () => {
    assert.equal(chargingRequestBody.safeParse(good).success, true);
  });

  it('rejects target SOC that is not above start SOC', () => {
    const bad = { ...good, charging: { ...good.charging, targetSocPct: 25 } };
    const res = chargingRequestBody.safeParse(bad);
    assert.equal(res.success, false);
    assert.equal(res.error.issues[0].path.join('.'), 'charging.targetSocPct');
  });

  it('rejects a vehicle model the models were not trained on', () => {
    const bad = { ...good, vehicle: { ...good.vehicle, model: 'Ford Mustang Mach-E' } };
    assert.equal(chargingRequestBody.safeParse(bad).success, false);
  });

  it('rejects "simulated" as a temperature source (schema says "simulation")', () => {
    const bad = { ...good, environment: { temperatureC: 30, source: 'simulated' } };
    assert.equal(chargingRequestBody.safeParse(bad).success, false);
  });
});
