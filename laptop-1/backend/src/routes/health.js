import { Router } from 'express';
import mongoose from 'mongoose';

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export function healthRoutes({ mqtt, predictions, stationStatus, ingest }) {
  const router = Router();
  const startedAt = new Date().toISOString();

  // Liveness: the process is up. Used by scripts that just want to know
  // whether to restart the backend.
  router.get('/live', (req, res) => res.json({ status: 'ok' }));

  // Readiness: can the backend actually do its job right now?
  router.get('/', (req, res) => {
    const mongoState = MONGO_STATES[mongoose.connection.readyState] || 'unknown';
    const ready = mongoState === 'connected' && mqtt.connected;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      startedAt,
      uptimeSec: Math.round(process.uptime()),
      mongo: { state: mongoState },
      mqtt: mqtt.state,
      mlWorker: {
        lastResultAt: predictions.lastResultAt,
        lastOfflineNoticeAt: stationStatus.mlWorker.lastOfflineNoticeAt,
      },
      predictions: predictions.stats,
      ingest: ingest?.stats,
    });
  });

  return router;
}
