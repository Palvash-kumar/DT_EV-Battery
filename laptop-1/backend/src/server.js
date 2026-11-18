import './loadEnv.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { startBackend } from './runtime.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  logger.fatal(err.message);
  process.exit(1);
}

logger.info(
  { stationId: config.stationId, broker: `${config.mqtt.host}:${config.mqtt.port}`, corsOrigins: config.corsOrigins },
  'starting backend',
);

let backend;
try {
  backend = await startBackend({ config, logger });
} catch (err) {
  logger.fatal({ err: err.message }, 'backend failed to start');
  process.exit(1);
}

const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 5000);
  await backend.stop();
  clearTimeout(force);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
