// Logs every MQTT message into MongoDB Atlas (database `mosquitto`, collection
// `messages`). Runs next to the backend and changes nothing about it.
//
//   npm run archive:mqtt
//
// Needs in .env (the `backend` MQTT user is not allowed to read the request
// topic, so a user with read access to evdt/v1/# is required):
//   ARCHIVER_MQTT_USERNAME=admin
//   ARCHIVER_MQTT_PASSWORD=...
// Optional: ARCHIVER_TOPIC (evdt/v1/#), ARCHIVER_TTL_DAYS (7),
//           ARCHIVER_DB (mosquitto), ARCHIVER_COLLECTION (messages)
import '../src/loadEnv.js';
import { startArchiver } from '../src/services/mqttArchiver.js';

const need = ['MQTT_HOST', 'MONGODB_URI', 'ARCHIVER_MQTT_USERNAME', 'ARCHIVER_MQTT_PASSWORD'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[archiver] missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

let archiver;
try {
  archiver = await startArchiver({
    mqttHost: process.env.MQTT_HOST,
    mqttPort: Number(process.env.MQTT_PORT || 1883),
    mqttUsername: process.env.ARCHIVER_MQTT_USERNAME,
    mqttPassword: process.env.ARCHIVER_MQTT_PASSWORD,
    mongoUri: process.env.MONGODB_URI,
    dbName: process.env.ARCHIVER_DB || 'mosquitto',
    collection: process.env.ARCHIVER_COLLECTION || 'messages',
    topic: process.env.ARCHIVER_TOPIC || 'evdt/v1/#',
    ttlDays: Number(process.env.ARCHIVER_TTL_DAYS || 7),
  });
} catch (err) {
  console.error(`[archiver] could not start: ${err.message}`);
  process.exit(1);
}

const report = () => {
  const s = archiver.stats;
  console.log(`[archiver] stored=${s.stored} duplicates=${s.duplicates} failed=${s.failed} since ${s.startedAt}`);
};
const timer = setInterval(report, 60_000);

const stop = async () => {
  clearInterval(timer);
  report();
  await archiver.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
