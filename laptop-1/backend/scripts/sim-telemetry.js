// Publishes SIMULATED ambient temperature readings so the telemetry path can
// be tested before the Arduino exists (Phase 10 adds the real sensor).
// Every message has source "simulation" and simulated: true.
//
//   npm run dev:sim-telemetry                 one reading every 5 s
//   npm run dev:sim-telemetry -- --every=2    every 2 s
//   npm run dev:sim-telemetry -- --spike      one implausible 70 °C value, to see quality=suspect
import '../src/loadEnv.js';
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const everyMs = Number(args.every || 5) * 1000;
const host = process.env.MQTT_HOST || '127.0.0.1';
const port = Number(process.env.MQTT_PORT || 1883);
const topic = process.env.MQTT_TOPIC_TELEMETRY_TEMP || 'evdt/v1/telemetry/temperature';
const stationId = process.env.STATION_ID || 'STATION-001';

const client = mqtt.connect(`mqtt://${host}:${port}`, {
  clientId: `sim-telemetry-${randomUUID().slice(0, 8)}`,
  username: process.env.SIM_MQTT_USERNAME || 'sensor',
  password: process.env.SIM_MQTT_PASSWORD || 'dev',
});

let t = 0;
function reading(value) {
  return {
    schemaVersion: '1.0',
    messageId: randomUUID(),
    stationId,
    sensorId: 'SIM-AMBIENT-01',
    timestamp: new Date().toISOString(),
    temperatureC: +value.toFixed(2),
    source: 'simulation',
    calibrationStatus: 'unknown',
    simulated: true,
  };
}

client.on('connect', () => {
  console.log(`[sim-telemetry] SIMULATED readings -> ${topic} every ${everyMs / 1000}s`);
  if (args.spike) {
    client.publish(topic, JSON.stringify(reading(70)), { qos: 1 }, () => client.end());
    return;
  }
  setInterval(() => {
    t += 1;
    // slow daily-ish wave plus a little noise, around 26 °C
    const value = 26 + 3 * Math.sin(t / 30) + (Math.random() - 0.5) * 0.4;
    client.publish(topic, JSON.stringify(reading(value)), { qos: 1 });
  }, everyMs);
});
