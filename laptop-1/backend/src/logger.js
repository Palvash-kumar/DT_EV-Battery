import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', 'mqtt.password'],
});
