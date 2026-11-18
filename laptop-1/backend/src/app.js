import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRoutes } from './routes/health.js';
import { predictionRoutes } from './routes/predictions.js';
import { alertRoutes } from './routes/alerts.js';
import { referenceRoutes } from './routes/reference.js';
import { sessionRoutes } from './routes/sessions.js';
import { stationRoutes } from './routes/stations.js';
import { telemetryRoutes } from './routes/telemetry.js';

export function createApp({ config, logger, services }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
      autoLogging: { ignore: (req) => req.url.startsWith('/api/health') },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Requests without an Origin header (curl, server-to-server) are allowed.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.rateLimitPerMin,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => req.path.startsWith('/health'),
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    }),
  );

  app.use('/api/health', healthRoutes(services));
  app.use('/api/predictions', predictionRoutes({ config, ...services }));
  app.use('/api/stations', stationRoutes(services));
  app.use('/api/sessions', sessionRoutes(services));
  app.use('/api/telemetry', telemetryRoutes({ config, ...services }));
  app.use('/api/alerts', alertRoutes({ events: services.ingest }));
  app.use('/api', referenceRoutes({ config }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
