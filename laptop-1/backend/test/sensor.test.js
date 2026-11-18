// Phase 10: Arduino ambient temperature sensor, backend side.
// The serial reading and OPC UA parts are tested in laptop-sensor/ and
// laptop-2/tests/test_opcua_bridge.py.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import request from 'supertest';
import { sensorHealth } from '../src/domain/sensorHealth.js';
import { Alert, PredictionRequest, TelemetryReading } from '../src/models/index.js';
import { IngestService } from '../src/services/ingestService.js';
import { mongoAvailable, sampleBody, startBroker, startTestBackend, waitFor } from './helpers.js';

const hasMongo = await mongoAvailable();

describe('sensor health rule', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const at = (sec) => new Date(now - sec * 1000).toISOString();

  it('none / live / offline / suspect', () => {
    assert.equal(sensorHealth(null, 30, now).state, 'none');
    assert.deepEqual(sensorHealth({ timestamp: at(3), quality: 'unknown' }, 30, now), { state: 'live', usable: true, ageSec: 3 });
    const off = sensorHealth({ timestamp: at(31), quality: 'unknown' }, 30, now);
    assert.equal(off.state, 'offline');
    assert.equal(off.usable, false);
    const sus = sensorHealth({ timestamp: at(2), quality: 'suspect', qualityNotes: ['jumped'] }, 30, now);
    assert.equal(sus.state, 'suspect');
    assert.match(sus.reason, /jumped/);
  });
});

describe('telemetry rate-of-change check', () => {
  const base = { source: 'sensor', simulated: false, calibrationStatus: 'uncalibrated', temperatureC: 31 };
  const t0 = '2026-11-18T12:00:00.000Z';
  const t2 = '2026-11-18T12:00:02.200Z';

  it('a normal drift passes, a jump of several degrees in 2 s is suspect', () => {
    const prev = { timestamp: t0, temperatureC: 31 };
    assert.equal(IngestService.assessReading({ ...base, temperatureC: 31.3, timestamp: t2 }, Date.parse(t2), prev).quality, 'unknown');
    const jump = IngestService.assessReading({ ...base, temperatureC: 4.2, timestamp: t2 }, Date.parse(t2), prev);
    assert.equal(jump.quality, 'suspect');
    assert.match(jump.qualityNotes.join(' '), /°C\/s/);
  });

  it('does not compare with a reading from long ago', () => {
    const prev = { timestamp: '2026-11-18T11:00:00.000Z', temperatureC: 10 };
    assert.equal(IngestService.assessReading({ ...base, timestamp: t2 }, Date.parse(t2), prev).quality, 'unknown');
  });
});

describe('live sensor in the backend', { skip: !hasMongo && 'MongoDB not running' }, () => {
  let broker;
  let backend;
  let api;
  let sensor;
  const topic = 'evdt/v1/telemetry/temperature';

  const reading = (temperatureC, ageSec = 0, extra = {}) => ({
    schemaVersion: '1.0',
    messageId: randomUUID(),
    stationId: 'STATION-TEST',
    sensorId: 'LM35-A0-01',
    timestamp: new Date(Date.now() - ageSec * 1000).toISOString(),
    temperatureC,
    source: 'sensor',
    calibrationStatus: 'uncalibrated',
    simulated: false,
    ...extra,
  });
  const send = async (msg) => {
    const before = await TelemetryReading.countDocuments();
    await sensor.publishAsync(topic, JSON.stringify(msg), { qos: 1 });
    await waitFor(async () => (await TelemetryReading.countDocuments()) > before, 3000, 'reading stored');
  };
  const sensorBody = (temperatureC = 25) => ({ ...sampleBody(), environment: { temperatureC, source: 'sensor' } });

  before(async () => {
    broker = await startBroker();
    backend = await startTestBackend({ brokerPort: broker.port, extraEnv: { SENSOR_STALE_SEC: '30' } });
    api = request(backend.app);
    sensor = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`);
    await new Promise((r) => sensor.once('connect', r));
  });

  after(async () => {
    await sensor?.endAsync();
    await backend?.stop();
    await broker?.close();
  });

  it('refuses a "live sensor" request when no sensor reading exists', async () => {
    const res = await api.post('/api/predictions/charging').send(sensorBody()).expect(409);
    assert.equal(res.body.error.code, 'SENSOR_NOT_LIVE');
    assert.equal(res.body.error.details[0].path, 'environment.temperatureSource');
    assert.equal(await PredictionRequest.countDocuments(), 0);
  });

  it('a simulated reading never counts as the sensor', async () => {
    await send(reading(22, 0, { source: 'simulation', simulated: true, sensorId: 'SIM-AMBIENT-01' }));
    await api.post('/api/predictions/charging').send(sensorBody()).expect(409);
    const view = (await api.get('/api/stations/STATION-TEST').expect(200)).body;
    assert.equal(view.sensorTelemetry, null);
    assert.equal(view.telemetry.source, 'simulation');
  });

  it('uses the stored sensor reading, not the number the browser sent', async () => {
    const r = reading(31.26);
    await send(r);
    const res = await api.post('/api/predictions/charging').send(sensorBody(25)).expect(202);
    assert.deepEqual(res.body.input.environment, { temperatureC: 31.26, source: 'sensor' });
    assert.equal(res.body.sensorReading.messageId, r.messageId);
    assert.equal(res.body.sensorReading.sensorId, 'LM35-A0-01');

    const view = (await api.get('/api/stations/STATION-TEST').expect(200)).body;
    assert.equal(view.sensorTelemetry.temperatureC, 31.26);
    assert.equal(view.sensorTelemetry.source, 'sensor');
    const meta = (await api.get('/api/meta').expect(200)).body;
    assert.equal(meta.sensor.staleAfterSec, 30);
    const latest = (await api.get('/api/telemetry/latest?stationId=STATION-TEST&source=sensor').expect(200)).body;
    assert.equal(latest.temperatureC, 31.26);
  });

  it('refuses a suspect reading (sudden jump)', async () => {
    await send(reading(4.1));
    const stored = await TelemetryReading.findOne({ source: 'sensor' }).sort({ timestamp: -1 }).lean();
    assert.equal(stored.quality, 'suspect');
    const res = await api.post('/api/predictions/charging').send(sensorBody()).expect(409);
    assert.match(res.body.error.message, /failed its checks/);
  });

  it('raises one sensor_offline alert when readings stop and resolves it when they resume', async () => {
    await send(reading(31.3));
    const monitor = backend.services.sensors;
    assert.equal(await monitor.check(), 'live');

    // 45 s later with no new reading
    assert.equal(await monitor.check(Date.now() + 45_000), 'offline');
    assert.equal(await monitor.check(Date.now() + 50_000), 'offline');
    const open = await Alert.find({ type: 'sensor_offline' }).lean();
    assert.equal(open.length, 1, 'one alert, not one per check');
    assert.equal(open[0].status, 'open');
    assert.equal(open[0].affectedAsset, 'LM35-A0-01');

    const res = await api.post('/api/predictions/charging').send(sensorBody());
    // still within 30 s on the real clock, so this one is accepted
    assert.equal(res.status, 202);

    await send(reading(31.4));
    await waitFor(async () => (await Alert.findOne({ alertId: open[0].alertId }).lean()).status === 'resolved', 3000, 'alert resolved');
  });

  it('an old reading is offline and cannot be used', async () => {
    await TelemetryReading.deleteMany({ source: 'sensor' });
    await send(reading(30, 120));
    const res = await api.post('/api/predictions/charging').send(sensorBody()).expect(409);
    assert.match(res.body.error.message, /old/);
  });
});
