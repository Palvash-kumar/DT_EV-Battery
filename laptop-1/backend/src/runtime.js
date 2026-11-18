import http from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { Station } from './models/index.js';
import { IngestService } from './services/ingestService.js';
import { MqttService } from './services/mqttClient.js';
import { PredictionService } from './services/predictionService.js';
import { attachRealtime } from './services/realtime.js';
import { SensorMonitor } from './services/sensorMonitor.js';
import { StationService } from './services/stationService.js';
import { StationStatusService } from './services/stationStatusService.js';

const STATUS_PUBLISH_DEBOUNCE_MS = 1000;

// Starts MongoDB, MQTT, HTTP and Socket.IO in the right order.
// MongoDB is required at startup; the broker is not. If the broker is down the
// API still serves history and reports "degraded" on /api/health, and the MQTT
// client keeps retrying in the background.
export async function startBackend({ config, logger, port = config.port }) {
  const log = logger.child({ component: 'runtime' });

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  log.info({ db: mongoose.connection.name }, 'connected to MongoDB');
  mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => log.info('MongoDB reconnected'));
  await mongoose.connection.syncIndexes();

  await Station.updateOne(
    { stationId: config.stationId },
    {
      $setOnInsert: {
        stationId: config.stationId,
        name: `Station ${config.stationId}`,
        status: 'online',
        source: 'manual',
      },
    },
    { upsert: true },
  );

  const mqtt = new MqttService({ config, logger });
  const sensors = new SensorMonitor({ config, logger });
  const predictions = new PredictionService({ config, mqtt, logger, sensors });
  const stationStatus = new StationStatusService({ config, mqtt, logger });
  const stations = new StationService({ config, logger });
  const ingest = new IngestService({ config, logger });
  const services = { mqtt, predictions, stationStatus, stations, ingest, sensors };

  const app = createApp({ config, logger, services });
  const server = http.createServer(app);
  const realtime = attachRealtime(server, { config, logger });
  services.realtime = realtime;

  // The retained station status carries charger states and the latest
  // temperature. Bursts of changes are folded into one publish.
  stationStatus.setStateBuilder(() => stations.mqttState());
  let statusTimer = null;
  const publishStatusSoon = () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => stationStatus.publish('online'), STATUS_PUBLISH_DEBOUNCE_MS);
    statusTimer.unref?.();
  };

  const pushStation = async (stationId) => {
    try {
      realtime.toStation(stationId, 'station:update', await stations.view(stationId));
    } catch (err) {
      log.warn({ stationId, err: err.message }, 'could not build station view');
    }
  };

  predictions.on('update', (view) => {
    realtime.prediction(view);
    if (view.chargerId) pushStation(view.stationId);
  });
  stations.on('changed', ({ stationId }) => {
    pushStation(stationId);
    publishStatusSoon();
  });
  ingest.on('telemetry', (r) => {
    realtime.toStation(r.stationId, 'telemetry:reading', stations.readingView(r));
    publishStatusSoon();
    if (r.source === 'sensor') {
      sensors.check().catch((err) => log.error({ err: err.message }, 'sensor check failed'));
    }
  });
  ingest.on('alert', (a) => realtime.broadcast('alert:update', a));
  sensors.on('alert', (a) => realtime.broadcast('alert:update', a));
  ingest.on('health', (h) => realtime.broadcast('health:update', h));

  const { topics } = config;
  const handlers = new Map([
    [topics.resultsCharging, (p) => predictions.handleResult(p)],
    [topics.telemetryTemperature, (p) => ingest.handleTelemetry(p)],
    [topics.alerts, (p) => ingest.handleAlert(p)],
    [topics.resultsHealth, (p) => ingest.handleHealth(p)],
  ]);
  for (const topic of handlers.keys()) mqtt.subscribe(topic);
  mqtt.subscribe(topics.stationStatusWildcard);

  mqtt.on('message', (topic, payload) => {
    const handler = handlers.get(topic);
    const job = handler
      ? handler(payload)
      : topic.startsWith('evdt/v1/stations/')
        ? stationStatus.handleMessage(topic, payload)
        : null;
    job?.catch((err) => log.error({ topic, err: err.message }, 'message handling failed'));
  });
  mqtt.on('connected', () => {
    realtime.broadcast('service:status', { mqtt: mqtt.state });
    stationStatus.publish('online');
  });
  mqtt.on('disconnected', () => realtime.broadcast('service:status', { mqtt: mqtt.state }));
  mqtt.connect();

  await predictions.recoverPending();
  await stations.sweep();
  stations.start();
  await sensors.check().catch((err) => log.error({ err: err.message }, 'sensor check failed'));
  sensors.start();

  await new Promise((resolve) => server.listen(port, resolve));
  const address = server.address();
  log.info({ port: address.port }, 'backend listening');

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(statusTimer);
    predictions.stop();
    stations.stop();
    await sensors.stop();
    if (mqtt.connected) await stationStatus.publish('offline');
    await mqtt.close();
    await realtime.close(); // also closes the HTTP server
    await mongoose.disconnect();
    log.info('backend stopped');
  }

  return { app, server, services, port: address.port, stop };
}
