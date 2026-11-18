import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import request from 'supertest';
import { PredictionRequest } from '../src/models/PredictionRequest.js';
import {
  mongoAvailable,
  sampleBody,
  startBroker,
  startFakeWorker,
  startTestBackend,
  waitFor,
} from './helpers.js';

const hasMongo = await mongoAvailable();

describe('prediction flow (Express + MQTT + MongoDB)', { skip: !hasMongo && 'no MongoDB reachable' }, () => {
  let broker;
  let backend;
  let worker;
  let api;

  before(async () => {
    broker = await startBroker();
    backend = await startTestBackend({ brokerPort: broker.port, timeoutSec: 0.8 });
    worker = await startFakeWorker(broker.port, backend.config);
    api = request(backend.server);
  });

  after(async () => {
    await worker?.close();
    await backend?.stop();
    await broker?.close();
  });

  beforeEach(() => {
    worker.mode = 'answer';
    worker.received.length = 0;
  });

  it('creates a pending request, publishes it, and stores the correlated result', async () => {
    const res = await api.post('/api/predictions/charging').send(sampleBody()).expect(202);
    assert.equal(res.body.status, 'pending');
    assert.match(res.body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.location, `/api/predictions/${res.body.requestId}`);

    await waitFor(async () => (await api.get(res.headers.location)).body.status === 'completed');
    const done = (await api.get(res.headers.location).expect(200)).body;
    assert.equal(done.result.predictions.energyKwh, 40.2);
    assert.equal(done.result.model.durationVersion, '2026-11-17');
    assert.equal(done.result.lateResult, false);

    const sent = worker.received.find((r) => r.requestId === res.body.requestId);
    assert.ok(sent, 'worker received the request');
    assert.equal(sent.stationId, 'STATION-TEST');
    assert.equal(sent.schemaVersion, '1.0');
  });

  it('labels results from the dev stub worker as simulation, not ml_estimate', async () => {
    worker.mode = 'silent';
    const res = await api.post('/api/predictions/charging').send(sampleBody()).expect(202);
    await worker.publish(
      worker.resultFor(res.body, { model: { durationVersion: 'dev-stub', energyVersion: 'dev-stub' } }),
    );
    await waitFor(async () => (await api.get(res.headers.location)).body.status === 'completed');
    assert.equal((await api.get(res.headers.location)).body.result.source, 'simulation');
  });

  it('?wait=true returns the finished result in the same HTTP call', async () => {
    const res = await api.post('/api/predictions/charging?wait=true').send(sampleBody()).expect(200);
    assert.equal(res.body.status, 'completed');
  });

  it('ignores a QoS 1 duplicate of the same result', async () => {
    worker.mode = 'twice';
    const before = backend.services.predictions.stats.duplicates;
    const res = await api.post('/api/predictions/charging?wait=true').send(sampleBody()).expect(200);
    await waitFor(() => backend.services.predictions.stats.duplicates > before, 2000, 'duplicate to be counted');

    const count = await PredictionRequest.countDocuments({ requestId: res.body.requestId });
    assert.equal(count, 1);
    const doc = await PredictionRequest.findOne({ requestId: res.body.requestId }).lean();
    assert.equal(doc.status, 'completed');
  });

  it('ignores a second, different result once the request is completed', async () => {
    const res = await api.post('/api/predictions/charging?wait=true').send(sampleBody()).expect(200);
    const first = res.body.result.resultMessageId;
    await worker.publish(worker.resultFor({ requestId: res.body.requestId }, { predictions: { durationHours: 9, energyKwh: 99 } }));
    await new Promise((r) => setTimeout(r, 200));
    const doc = (await api.get(`/api/predictions/${res.body.requestId}`)).body;
    assert.equal(doc.result.resultMessageId, first);
    assert.equal(doc.result.predictions.energyKwh, 40.2);
  });

  it('marks a request timed_out when no result arrives, and a retry completes it', async () => {
    worker.mode = 'silent';
    const res = await api.post('/api/predictions/charging').send(sampleBody()).expect(202);
    const url = `/api/predictions/${res.body.requestId}`;
    await waitFor(async () => (await api.get(url)).body.status === 'timed_out', 3000, 'timeout');

    worker.mode = 'answer';
    const retry = await api.post(`${url}/retry`).expect(202);
    assert.equal(retry.body.attempts, 2);
    await waitFor(async () => (await api.get(url)).body.status === 'completed', 3000, 'retry result');

    const doc = await PredictionRequest.findOne({ requestId: res.body.requestId }).lean();
    assert.equal(doc.messageIds.length, 2, 'retry used a new messageId');
    assert.notEqual(doc.messageIds[0], doc.messageIds[1]);
    const retried = worker.received.filter((r) => r.requestId === res.body.requestId);
    assert.equal(retried.length, 2, 'same requestId published twice');
  });

  it('keeps a late result that arrives after the timeout', async () => {
    worker.mode = 'silent';
    const res = await api.post('/api/predictions/charging').send(sampleBody()).expect(202);
    const url = `/api/predictions/${res.body.requestId}`;
    await waitFor(async () => (await api.get(url)).body.status === 'timed_out', 3000, 'timeout');

    await worker.publish(worker.resultFor({ requestId: res.body.requestId }));
    await waitFor(async () => (await api.get(url)).body.status === 'completed', 2000, 'late result');
    assert.equal((await api.get(url)).body.result.lateResult, true);
  });

  it('stores a worker validation error as failed and refuses to retry it', async () => {
    worker.mode = 'error';
    const res = await api.post('/api/predictions/charging?wait=true').send(sampleBody()).expect(200);
    assert.equal(res.body.status, 'failed');
    assert.equal(res.body.error.code, 'BUSINESS_RULE');
    const retry = await api.post(`/api/predictions/${res.body.requestId}/retry`).expect(409);
    assert.equal(retry.body.error.code, 'NOT_RETRYABLE');
  });

  it('drops results that break the schema or belong to nobody', async () => {
    const before = backend.services.predictions.stats.rejected;
    await worker.client.publishAsync(backend.config.topics.resultsCharging, 'not json', { qos: 1 });
    await worker.publish({ status: 'error', requestId: 'unknown', error: { code: 'INVALID_JSON', message: 'x' } });
    await waitFor(() => backend.services.predictions.stats.rejected >= before + 2, 2000, 'rejections');

    // valid shape, but no such request in the database
    await worker.publish(worker.resultFor({ requestId: '00000000-0000-4000-8000-000000000000' }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await PredictionRequest.countDocuments({ requestId: '00000000-0000-4000-8000-000000000000' }), 0);
  });

  it('pushes status changes to a subscribed Socket.IO client', async () => {
    const socket = ioClient(`http://127.0.0.1:${backend.port}`, { transports: ['websocket'] });
    await new Promise((r) => socket.on('connect', r));
    await new Promise((r) => socket.emit('subscribe', { stationId: 'STATION-TEST' }, r));

    const seen = [];
    socket.on('prediction:update', (u) => seen.push(u.status));
    await api.post('/api/predictions/charging').send(sampleBody()).expect(202);
    await waitFor(() => seen.includes('completed'), 3000, 'socket completed event');
    assert.deepEqual(seen, ['pending', 'completed']);
    socket.close();
  });

  it('validates input and returns field-level errors', async () => {
    const body = sampleBody();
    body.charging.targetSocPct = 10;
    body.vehicle.model = 'Unknown Car';
    const res = await api.post('/api/predictions/charging').send(body).expect(400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    const paths = res.body.error.details.map((d) => d.path);
    assert.ok(paths.includes('vehicle.model'));
  });

  it('rejects malformed JSON, oversized bodies and bad ids cleanly', async () => {
    const bad = await api.post('/api/predictions/charging').set('content-type', 'application/json').send('{oops').expect(400);
    assert.equal(bad.body.error.code, 'INVALID_JSON');

    const big = await api
      .post('/api/predictions/charging')
      .send({ ...sampleBody(), padding: 'x'.repeat(20_000) })
      .expect(413);
    assert.equal(big.body.error.code, 'PAYLOAD_TOO_LARGE');

    await api.get('/api/predictions/not-a-uuid').expect(400);
    await api.get('/api/predictions/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('reports health and station details', async () => {
    const health = await api.get('/api/health').expect(200);
    assert.equal(health.body.mongo.state, 'connected');
    assert.equal(health.body.mqtt.connected, true);
    const station = await api.get('/api/stations/STATION-TEST').expect(200);
    assert.equal(station.body.station.stationId, 'STATION-TEST');
    assert.ok(Array.isArray(station.body.chargers));
  });

  it('only lets allow-listed origins through CORS', async () => {
    const ok = await api.get('/api/health/live').set('Origin', 'http://localhost:5173');
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173');
    const other = await api.get('/api/health/live').set('Origin', 'http://evil.example');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });
});

describe('broker down', { skip: !hasMongo && 'no MongoDB reachable' }, () => {
  it('saves the request as failed with BROKER_UNAVAILABLE and answers 503', async () => {
    const broker = await startBroker();
    const backend = await startTestBackend({ brokerPort: broker.port });
    const api = request(backend.server);
    try {
      await broker.close();
      await waitFor(() => !backend.services.mqtt.connected, 3000, 'disconnect');

      const res = await api.post('/api/predictions/charging').send(sampleBody()).expect(503);
      assert.equal(res.body.error.code, 'BROKER_UNAVAILABLE');
      const { requestId } = res.body.error.details;
      const saved = await api.get(`/api/predictions/${requestId}`).expect(200);
      assert.equal(saved.body.status, 'failed');

      const health = await api.get('/api/health').expect(503);
      assert.equal(health.body.status, 'degraded');
    } finally {
      await backend.stop();
    }
  });
});
