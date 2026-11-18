import { describe, expect, it } from 'vitest';
import { lifecycleSteps } from '../src/components/Lifecycle.jsx';
import { hoursToHm } from '../src/lib/format.js';
import { badgeFor } from '../src/lib/sources.js';
import { serverFieldErrors, toRequestBody, validateRequest } from '../src/lib/validateRequest.js';

const meta = {
  enums: {
    vehicleModels: ['BMW i3', 'Chevy Bolt', 'Hyundai Kona', 'Nissan Leaf', 'Tesla Model 3'],
    chargerTypes: ['Level 1', 'Level 2', 'DC Fast Charger'],
    temperatureSources: ['sensor', 'simulation', 'manual'],
  },
  limits: { batteryCapacityKwhMax: 300, vehicleAgeYearsMax: 30, requestedRateKwMax: 350, temperatureCMin: -50, temperatureCMax: 60 },
};
const form = {
  model: 'Tesla Model 3',
  batteryCapacityKwh: '75',
  vehicleAgeYears: '3',
  startSocPct: '25',
  targetSocPct: '80',
  chargerType: 'DC Fast Charger',
  chargerId: '',
  requestedRateKw: '50',
  temperatureC: '25',
  temperatureSource: 'manual',
};

describe('source badges', () => {
  it('uses the four names from the plan', () => {
    expect(badgeFor('sensor').text).toBe('Live sensor');
    expect(badgeFor('simulation').text).toBe('Simulated');
    expect(badgeFor('ml_estimate').text).toBe('ML estimate');
    expect(badgeFor('historical_csv').text).toBe('Historical');
  });
  it('demo wins over the stored source', () => {
    expect(badgeFor('manual', { isDemo: true }).text).toBe('Demo data');
  });
  it('never shows an unlabelled value', () => {
    expect(badgeFor(undefined).text).toBe('Unknown source');
  });
});

describe('request lifecycle', () => {
  const states = (stage) => lifecycleSteps(stage).map((s) => s.state);
  it('draft is the current step at the start', () => {
    expect(states('draft')).toEqual(['current', 'todo', 'todo', 'todo']);
  });
  it('pending shows processing as current, not success', () => {
    expect(states('pending')).toEqual(['done', 'done', 'current', 'todo']);
  });
  it.each([
    ['completed', 'Completed', 'ok'],
    ['timed_out', 'Timed out', 'warn'],
    ['failed', 'Failed', 'bad'],
  ])('%s ends on its own label', (stage, label, kind) => {
    const last = lifecycleSteps(stage).at(-1);
    expect(last).toMatchObject({ label, kind, state: 'final' });
  });
});

describe('form validation', () => {
  it('accepts a sensible request', () => {
    expect(validateRequest(form, meta)).toEqual({});
  });
  it('target SOC must be above start SOC', () => {
    expect(validateRequest({ ...form, targetSocPct: '20' }, meta).targetSocPct).toMatch(/higher/);
  });
  it('caps the rate at the chosen bay rating', () => {
    const bay = { chargerId: 'B3', chargerType: 'DC Fast Charger', maxPowerKw: 50 };
    expect(validateRequest({ ...form, requestedRateKw: '120' }, meta, bay).requestedRateKw).toMatch(/50 kW/);
  });
  it('rejects empty and out-of-range numbers', () => {
    const e = validateRequest({ ...form, batteryCapacityKwh: '', temperatureC: '80' }, meta);
    expect(e.batteryCapacityKwh).toBeTruthy();
    expect(e.temperatureC).toBeTruthy();
  });
  it('builds the API body with numbers, not strings', () => {
    const body = toRequestBody(form);
    expect(body.charging.startSocPct).toBe(25);
    expect(body.environment).toEqual({ temperatureC: 25, source: 'manual' });
    expect(body.chargerId).toBeUndefined();
  });
  it('maps server error paths onto form fields', () => {
    expect(serverFieldErrors([{ path: 'charging.targetSocPct', message: 'too low' }])).toEqual({ targetSocPct: 'too low' });
  });
});

describe('formatting', () => {
  it('shows hours as h + min', () => {
    expect(hoursToHm(2.1731)).toBe('2 h 10 min');
    expect(hoursToHm(0.5)).toBe('30 min');
    expect(hoursToHm(null)).toBe('–');
  });
});
