import { z } from 'zod';

const csv = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MQTT_HOST: z.string().min(1),
  MQTT_PORT: z.coerce.number().int().min(1).max(65535).default(1883),
  MQTT_USERNAME: z.string().min(1),
  MQTT_PASSWORD: z.string().min(1),

  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must start with mongodb:// or mongodb+srv://'),

  STATION_ID: z.string().min(1).max(64).default('STATION-001'),

  MQTT_TOPIC_REQUESTS: z.string().default('evdt/v1/requests/charging'),
  MQTT_TOPIC_RESULTS_CHARGING: z.string().default('evdt/v1/results/charging'),
  MQTT_TOPIC_RESULTS_HEALTH: z.string().default('evdt/v1/results/health'),
  MQTT_TOPIC_RESULTS_OPTIMIZATION: z.string().default('evdt/v1/results/optimization'),
  MQTT_TOPIC_TELEMETRY_TEMP: z.string().default('evdt/v1/telemetry/temperature'),
  MQTT_TOPIC_ALERTS: z.string().default('evdt/v1/alerts'),

  REQUEST_TIMEOUT_SEC: z.coerce.number().positive().max(300).default(15),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  PREDICTION_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),

  // 60 = one real second plays one simulated minute of a simulated session.
  SIM_TIME_SCALE: z.coerce.number().min(1).max(3600).default(60),

  // A real sensor reading older than this counts as offline: it can no longer
  // be used in a request and a sensor_offline alert is raised. The Arduino
  // sketch prints every ~2 s, so 30 s is about 13 missed readings.
  SENSOR_STALE_SEC: z.coerce.number().int().min(5).max(3600).default(30),
});

// Turns process.env into a typed config object. Throws a readable error
// listing every bad variable so the backend never starts half-configured.
export function loadConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid backend environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    corsOrigins: csv(e.CORS_ORIGIN),
    logLevel: e.LOG_LEVEL,
    mqtt: {
      host: e.MQTT_HOST,
      port: e.MQTT_PORT,
      username: e.MQTT_USERNAME,
      password: e.MQTT_PASSWORD,
    },
    mongoUri: e.MONGODB_URI,
    stationId: e.STATION_ID,
    topics: {
      requests: e.MQTT_TOPIC_REQUESTS,
      resultsCharging: e.MQTT_TOPIC_RESULTS_CHARGING,
      resultsHealth: e.MQTT_TOPIC_RESULTS_HEALTH,
      resultsOptimization: e.MQTT_TOPIC_RESULTS_OPTIMIZATION,
      telemetryTemperature: e.MQTT_TOPIC_TELEMETRY_TEMP,
      alerts: e.MQTT_TOPIC_ALERTS,
      stationStatus: (stationId) => `evdt/v1/stations/${stationId}/status`,
      stationStatusWildcard: 'evdt/v1/stations/+/status',
    },
    requestTimeoutMs: Math.round(e.REQUEST_TIMEOUT_SEC * 1000),
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    predictionRateLimitPerMin: e.PREDICTION_RATE_LIMIT_PER_MIN,
    simTimeScale: e.SIM_TIME_SCALE,
    sensorStaleSec: e.SENSOR_STALE_SEC,
  };
}
