import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Aedes } from 'aedes';
import mongoose from 'mongoose';
import mqtt from 'mqtt';
import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { startBackend } from '../src/runtime.js';

export const TEST_MONGO = process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017';

// Integration tests need a MongoDB. If none is reachable they are skipped
// rather than failing, so `npm test` still runs the pure unit tests.
export async function mongoAvailable() {
  const conn = mongoose.createConnection(`${TEST_MONGO}/evdt_probe`, { serverSelectionTimeoutMS: 1500 });
  try {
    await conn.asPromise();
    return true;
  } catch {
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

export async function startBroker() {
  const broker = await Aedes.createBroker();
  const server = createServer(broker.handle);
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    // Kills live connections too, like a broker process that died.
    async close() {
      const closed = new Promise((r) => server.close(() => r()));
      for (const s of sockets) s.destroy();
      await closed;
      await new Promise((r) => broker.close(() => r()));
    },
  };
}

export async function startTestBackend({ brokerPort, timeoutSec = 1, extraEnv = {} }) {
  const dbName = `evdt_test_${randomUUID().slice(0, 8)}`;
  const config = loadConfig({
    NODE_ENV: 'test',
    MQTT_HOST: '127.0.0.1',
    MQTT_PORT: String(brokerPort),
    MQTT_USERNAME: 'backend',
    MQTT_PASSWORD: 'test',
    MONGODB_URI: `${TEST_MONGO}/${dbName}`,
    STATION_ID: 'STATION-TEST',
    REQUEST_TIMEOUT_SEC: String(timeoutSec),
    CORS_ORIGIN: 'http://localhost:5173',
    PREDICTION_RATE_LIMIT_PER_MIN: '1000',
    ...extraEnv,
  });
  const logger = pino({ level: process.env.TEST_LOG_LEVEL || 'silent' });
  const backend = await startBackend({ config, logger, port: 0 });
  await waitFor(() => backend.services.mqtt.connected, 5000, 'backend MQTT connect');
  return {
    ...backend,
    config,
    async stop() {
      await mongoose.connection.dropDatabase().catch(() => {});
      await backend.stop();
    },
  };
}

// A fake ML worker living inside the test. `mode` can be changed between
// tests: 'answer' | 'silent' | 'error' | 'twice' (sends the same result twice)
export async function startFakeWorker(brokerPort, config) {
  const client = mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`, { clientId: `fake-worker-${randomUUID().slice(0, 6)}` });
  await new Promise((r) => client.once('connect', r));
  await client.subscribeAsync(config.topics.requests, { qos: 1 });

  const worker = { mode: 'answer', received: [], client };
  worker.resultFor = (req, overrides = {}) => ({
    schemaVersion: '1.0',
    messageId: randomUUID(),
    requestId: req.requestId,
    status: 'completed',
    processedAt: new Date().toISOString(),
    predictions: { durationHours: 1.5, energyKwh: 40.2 },
    model: { durationVersion: '2026-11-17', energyVersion: '2026-11-17' },
    warnings: ['test worker'],
    ...overrides,
  });
  worker.publish = (msg) => client.publishAsync(config.topics.resultsCharging, JSON.stringify(msg), { qos: 1 });

  client.on('message', async (topic, payload) => {
    const req = JSON.parse(payload.toString());
    worker.received.push(req);
    if (worker.mode === 'silent') return;
    if (worker.mode === 'error') {
      await worker.publish(
        worker.resultFor(req, {
          status: 'invalid_request',
          predictions: undefined,
          model: undefined,
          warnings: undefined,
          error: { code: 'BUSINESS_RULE', message: 'targetSocPct must be > startSocPct.' },
        }),
      );
      return;
    }
    const result = worker.resultFor(req);
    await worker.publish(result);
    if (worker.mode === 'twice') await worker.publish(result);
  });

  worker.close = () => client.endAsync();
  return worker;
}

export async function waitFor(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export const sampleBody = () => ({
  vehicle: { model: 'Tesla Model 3', batteryCapacityKwh: 75, vehicleAgeYears: 3 },
  charging: { startSocPct: 25, targetSocPct: 80, chargerType: 'DC Fast Charger', requestedRateKw: 50 },
  environment: { temperatureC: 30, source: 'simulation' },
});
