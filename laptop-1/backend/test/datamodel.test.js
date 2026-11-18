import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import request from 'supertest';
import { check, SCHEMA_DIR } from '../src/contracts.js';
import { assessRow, rowToSession } from '../src/db/importCsv.js';
import { seedDemo } from '../src/db/seed.js';
import { Alert, Charger, ChargingSession, PredictionRequest, TelemetryReading } from '../src/models/index.js';
import { mongoAvailable, sampleBody, startBroker, startFakeWorker, startTestBackend, waitFor } from './helpers.js';

const hasMongo = await mongoAvailable();

describe('CSV row checks', () => {
  const base = {
    batteryCapacityKwh: 75,
    startSocPct: 20,
    endSocPct: 80,
    energyKwh: 40,
    durationHours: 1,
    chargingRateKw: 40,
    costUsd: 10,
    distanceDrivenKm: 100,
    startedAt: new Date('2024-01-01T00:00:00Z'),
    endedAt: new Date('2024-01-01T01:00:00Z'),
  };

  it('a consistent row is good', () => {
    assert.deepEqual(assessRow(base), { quality: 'good', qualityNotes: [] });
  });

  it('SOC going down is bad, not dropped', () => {
    const r = assessRow({ ...base, startSocPct: 80, endSocPct: 20 });
    assert.equal(r.quality, 'bad');
    assert.match(r.qualityNotes[0], /SOC rule/);
  });

  it('a missing value or a duration mismatch is suspect', () => {
    assert.equal(assessRow({ ...base, energyKwh: null }).quality, 'suspect');
    assert.equal(assessRow({ ...base, durationHours: 3 }).quality, 'suspect');
  });

  it('maps a real CSV line, keeping its row number', () => {
    const s = rowToSession(
      {
        'User ID': 'User_1',
        'Vehicle Model': 'BMW i3',
        'Battery Capacity (kWh)': '108.46',
        'Charging Station ID': 'Station_391',
        'Charging Station Location': 'Houston',
        'Charging Start Time': '2024-01-01 00:00:00',
        'Charging End Time': '2024-01-01 00:39:00',
        'Energy Consumed (kWh)': '60.71',
        'Charging Duration (hours)': '0.59',
        'Charging Rate (kW)': '36.39',
        'Charging Cost (USD)': '13.09',
        'State of Charge (Start %)': '29.37',
        'State of Charge (End %)': '86.12',
        'Temperature (°C)': '27.95',
        'Vehicle Age (years)': '2.0',
        'Charger Type': 'DC Fast Charger',
        'User Type': 'Commuter',
      },
      0,
    );
    assert.equal(s.sessionId, 'CSV-0001');
    assert.equal(s.source, 'historical_csv');
    assert.equal(s.csv.row, 2);
    assert.equal(s.startedAt.toISOString(), '2024-01-01T00:00:00.000Z');
    assert.equal(s.quality, 'suspect'); // distance column missing in this sample
  });
});

describe('data model + ingestion', { skip: !hasMongo && 'no MongoDB reachable' }, () => {
  let broker;
  let backend;
  let worker;
  let api;
  let pub;

  before(async () => {
    broker = await startBroker();
    // 3600x: a 1.5 h predicted charge plays out in 1.5 s
    backend = await startTestBackend({ brokerPort: broker.port, extraEnv: { SIM_TIME_SCALE: '3600' } });
    await seedDemo('STATION-TEST');
    worker = await startFakeWorker(broker.port, backend.config);
    api = request(backend.server);
    pub = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'test-publisher' });
    await new Promise((r) => pub.once('connect', r));
  });

  after(async () => {
    await pub?.endAsync();
    await worker?.close();
    await backend?.stop();
    await broker?.close();
  });

  const send = (topic, msg) => pub.publishAsync(topic, typeof msg === 'string' ? msg : JSON.stringify(msg), { qos: 1 });

  it('seeding twice gives the same 4 chargers, all flagged as demo', async () => {
    await seedDemo('STATION-TEST');
    const view = (await api.get('/api/stations/STATION-TEST').expect(200)).body;
    assert.equal(view.chargers.length, 4);
    assert.ok(view.chargers.every((c) => c.isDemo && c.source === 'manual'));
    assert.equal(view.station.isDemo, true);
    assert.equal(view.telemetry, null, 'no fake telemetry is seeded');
  });

  it('keeps an audit trail and refuses edits to the original input', async () => {
    const res = await api.post('/api/predictions/charging?wait=true').send(sampleBody()).expect(200);
    const doc = await PredictionRequest.findOne({ requestId: res.body.requestId }).lean();
    assert.deepEqual(
      doc.statusHistory.map((h) => h.status),
      ['pending', 'pending', 'completed'],
    );
    assert.ok(doc.statusHistory[1].messageId, 'publish step records its messageId');
    assert.equal(doc.result.source, 'ml_estimate');
    assert.equal(doc.result.units.energyKwh, 'kWh');

    await assert.rejects(
      PredictionRequest.updateOne({ requestId: doc.requestId }, { $set: { 'input.vehicle.model': 'BMW i3' } }),
      /audit data/,
    );
    await assert.rejects(
      PredictionRequest.create({ ...doc, _id: undefined }),
      (err) => err.code === 11000,
      'requestId is unique',
    );
  });

  it('lists request history newest first with keyset paging', async () => {
    const older = (await api.post('/api/predictions/charging?wait=true').send(sampleBody())).body;
    const newer = (await api.post('/api/predictions/charging?wait=true').send(sampleBody())).body;
    const first = (await api.get('/api/predictions?limit=1').expect(200)).body;
    assert.equal(first.items[0].requestId, newer.requestId);
    assert.equal(first.items.length, 1);
    assert.ok(first.nextBefore);
    const second = (await api.get(`/api/predictions?limit=1&before=${encodeURIComponent(first.nextBefore)}`)).body;
    assert.equal(second.items[0].requestId, older.requestId);
  });

  it('checks the chosen bay against type and rating', async () => {
    const tooFast = sampleBody();
    tooFast.chargerId = 'STATION-TEST-BAY-3'; // DC 50 kW
    tooFast.charging.requestedRateKw = 120;
    const r1 = await api.post('/api/predictions/charging').send(tooFast).expect(400);
    assert.equal(r1.body.error.code, 'RATE_ABOVE_CHARGER_RATING');

    const wrongType = sampleBody();
    wrongType.chargerId = 'STATION-TEST-BAY-1'; // Level 2
    const r2 = await api.post('/api/predictions/charging').send(wrongType).expect(400);
    assert.equal(r2.body.error.code, 'CHARGER_TYPE_MISMATCH');
  });

  it('runs a simulated session on a bay and frees it when the time is up', async () => {
    const body = sampleBody();
    body.chargerId = 'STATION-TEST-BAY-3';
    const pred = (await api.post('/api/predictions/charging?wait=true').send(body).expect(200)).body;

    const session = (await api.post('/api/sessions/simulated').send({ requestId: pred.requestId }).expect(201)).body;
    assert.equal(session.source, 'simulation');
    assert.equal(session.simulated.label, 'Simulated SOC progress');

    let bay = await Charger.findOne({ chargerId: 'STATION-TEST-BAY-3' }).lean();
    assert.equal(bay.status, 'charging');
    assert.equal(bay.statusSource, 'simulation');
    assert.equal(bay.currentRequestId, pred.requestId);

    const busy = await api.post('/api/sessions/simulated').send({ requestId: pred.requestId }).expect(409);
    assert.equal(busy.body.error.code, 'CHARGER_BUSY');
    await api.patch('/api/stations/STATION-TEST/chargers/STATION-TEST-BAY-3').send({ status: 'available' }).expect(409);

    // 1.5 h predicted at 3600x = 1.5 s
    await new Promise((r) => setTimeout(r, 1700));
    await backend.services.stations.sweep();
    bay = await Charger.findOne({ chargerId: 'STATION-TEST-BAY-3' }).lean();
    assert.equal(bay.status, 'available');
    const done = await ChargingSession.findOne({ sessionId: session.sessionId }).lean();
    assert.equal(done.status, 'completed');
    assert.equal(done.endSocPct, 80);
  });

  it('putting a busy bay into fault stops its session; "charging" cannot be set by hand', async () => {
    const body = sampleBody();
    body.chargerId = 'STATION-TEST-BAY-4';
    const pred = (await api.post('/api/predictions/charging?wait=true').send(body).expect(200)).body;
    const session = (await api.post('/api/sessions/simulated').send({ requestId: pred.requestId }).expect(201)).body;

    await api.patch('/api/stations/STATION-TEST/chargers/STATION-TEST-BAY-4').send({ status: 'charging' }).expect(400);
    const bay = (
      await api.patch('/api/stations/STATION-TEST/chargers/STATION-TEST-BAY-4').send({ status: 'fault', note: 'test' }).expect(200)
    ).body;
    assert.equal(bay.status, 'fault');
    const s = await ChargingSession.findOne({ sessionId: session.sessionId }).lean();
    assert.equal(s.status, 'stopped');
    await api.patch('/api/stations/STATION-TEST/chargers/STATION-TEST-BAY-4').send({ status: 'available' }).expect(200);
  });

  it('stores telemetry with source and quality, and ignores repeats', async () => {
    const topic = backend.config.topics.telemetryTemperature;
    const reading = {
      schemaVersion: '1.0',
      messageId: randomUUID(),
      stationId: 'STATION-TEST',
      sensorId: 'SIM-1',
      timestamp: new Date().toISOString(),
      temperatureC: 24.5,
      source: 'simulation',
      calibrationStatus: 'unknown',
      simulated: true,
    };
    await send(topic, reading);
    await send(topic, reading); // QoS 1 redelivery
    await send(topic, { ...reading, messageId: randomUUID(), temperatureC: 70 });
    await send(topic, { ...reading, messageId: randomUUID(), source: 'sensor', simulated: true });
    await send(topic, { ...reading, messageId: randomUUID(), temperatureC: 'hot' });

    await waitFor(async () => (await TelemetryReading.countDocuments()) === 3, 3000, '3 readings');
    const rows = await TelemetryReading.find().sort({ receivedAt: 1 }).lean();
    assert.deepEqual(rows.map((r) => r.quality), ['unknown', 'suspect', 'bad']);
    assert.ok(rows.every((r) => r.measures === 'ambient'));

    const latest = (await api.get('/api/telemetry/latest?stationId=STATION-TEST').expect(200)).body;
    assert.match(latest.label, /not battery temperature/);
  });

  it('turns repeated alerts into one record and follows its lifecycle', async () => {
    const alertId = randomUUID();
    const alert = {
      schemaVersion: '1.0',
      alertId,
      timestamp: new Date().toISOString(),
      severity: 'warning',
      type: 'temperature_threshold',
      source: 'mlworker',
      status: 'open',
      affectedAsset: 'STATION-TEST',
      evidence: { temperatureC: 47 },
      recommendedAction: 'Check ventilation around the charger cabinet.',
    };
    await send(backend.config.topics.alerts, { ...alert, messageId: randomUUID() });
    await waitFor(async () => !!(await Alert.findOne({ alertId })), 2000, 'alert stored');
    await send(backend.config.topics.alerts, { ...alert, messageId: randomUUID() });
    await waitFor(async () => (await Alert.findOne({ alertId }).lean()).occurrences === 2, 2000, 'second occurrence');
    assert.equal(await Alert.countDocuments({ alertId }), 1);

    await api.patch(`/api/alerts/${alertId}`).send({ status: 'acknowledged', by: 'tester' }).expect(200);
    const resolved = (await api.patch(`/api/alerts/${alertId}`).send({ status: 'resolved' }).expect(200)).body;
    assert.deepEqual(resolved.statusHistory.map((h) => h.status), ['open', 'acknowledged', 'resolved']);
    assert.equal(resolved.isConfirmedFault, false);
    await api.patch(`/api/alerts/${alertId}`).send({ status: 'acknowledged' }).expect(409);
  });

  it('stores health estimates with the limitation wording', async () => {
    const example = JSON.parse(readFileSync(path.join(SCHEMA_DIR, 'examples', 'health-result.json'), 'utf8'));
    const msg = { ...example, messageId: randomUUID(), applicabilityNotes: [] };
    await send(backend.config.topics.resultsHealth, msg);
    await send(backend.config.topics.resultsHealth, msg);
    await waitFor(async () => backend.services.ingest.stats.health >= 1 && backend.services.ingest.stats.duplicates >= 1, 2000, 'health stored');

    const page = (await api.get('/api/battery-health').expect(200)).body;
    assert.equal(page.labels.soh, 'Model estimate from aging-data domain');
    assert.equal(page.labels.rul, 'Estimated RUL (model, lab conditions)');
    const stored = page.estimates.find((e) => e.healthEstimateId === msg.messageId);
    assert.equal(stored.source, 'ml_estimate');
    assert.ok(stored.applicabilityNotes.length > 0, 'default notes added when the worker sent none');
    assert.equal(stored.eolThresholdIsAssumption, true);
  });

  it('publishes a schema-valid retained station status with charger states', async () => {
    await backend.services.stationStatus.publish('online');
    const sub = mqtt.connect(`mqtt://127.0.0.1:${broker.port}`, { clientId: 'status-reader' });
    const msg = await new Promise((resolve) => {
      sub.on('connect', () => sub.subscribe('evdt/v1/stations/STATION-TEST/status'));
      sub.on('message', (t, p) => resolve(JSON.parse(p.toString())));
    });
    await sub.endAsync();
    assert.equal(check('stationStatus', msg).ok, true);
    assert.equal(msg.chargers.length, 4);
    assert.equal(msg.telemetry.temperatureSource, 'simulation');
  });

  it('reports provenance counts per collection and source', async () => {
    const p = (await api.get('/api/provenance').expect(200)).body.collections;
    const chargers = p.chargers.find((r) => r.source === 'manual' && r.isDemo);
    assert.equal(chargers.count, 4);
    assert.ok(p.telemetryReadings.some((r) => r.source === 'simulation'));
    assert.ok(p.chargingSessions.some((r) => r.source === 'simulation'));
  });

  it('exposes form metadata straight from the shared schema', async () => {
    const meta = (await api.get('/api/meta').expect(200)).body;
    assert.deepEqual(meta.enums.chargerTypes, ['Level 1', 'Level 2', 'DC Fast Charger']);
    assert.equal(meta.limits.requestedRateKwMax, 350);
    assert.equal(meta.requestTimeoutSec, 1);
  });

  it('has a TTL index that only expires simulated telemetry', async () => {
    const idx = (await TelemetryReading.collection.indexes()).find((i) => i.name === 'sim_readings_ttl');
    assert.ok(idx.expireAfterSeconds > 0);
    assert.deepEqual(idx.partialFilterExpression, { source: 'simulation' });
  });
});
