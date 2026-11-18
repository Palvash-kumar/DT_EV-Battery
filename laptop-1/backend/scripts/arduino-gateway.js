// Live Arduino ambient temperature -> MQTT (Implementation plan, Phase 10).
// Runs on the laptop the Arduino's USB cable is plugged into.
//
//   npm run gateway:arduino                 auto-detect the Arduino's port
//   npm run gateway:arduino -- --list       list serial ports and exit
//   npm run gateway:arduino -- --port=COM6  use a specific port
//   npm run gateway:arduino -- --quiet      only log problems, not every reading
//
// Close the Arduino IDE Serial Monitor first: Windows lets only one program
// open a serial port. Settings come from laptop-1/backend/.env (see .env.example).
import '../src/loadEnv.js';
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { SerialPort } from 'serialport';
import { ArduinoGateway } from '../src/gateway/arduinoGateway.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const log = (...m) => console.log(`[arduino-gateway] ${new Date().toLocaleTimeString()}`, ...m);

if (args.list) {
  const ports = await SerialPort.list();
  if (!ports.length) console.log('No serial ports found.');
  for (const p of ports) {
    console.log(`${p.path}\t${p.friendlyName || p.manufacturer || ''}\tvendor=${p.vendorId || '-'} product=${p.productId || '-'}`);
  }
  process.exit(0);
}

const env = process.env;
const CALIBRATION = ['calibrated', 'uncalibrated', 'unknown'];
const calibrationStatus = env.SENSOR_CALIBRATION || 'uncalibrated';
if (!CALIBRATION.includes(calibrationStatus)) {
  console.error(`SENSOR_CALIBRATION must be one of ${CALIBRATION.join(', ')}`);
  process.exit(1);
}
const offsetC = Number(env.SENSOR_OFFSET_C || 0);
if (!Number.isFinite(offsetC) || Math.abs(offsetC) > 10) {
  console.error('SENSOR_OFFSET_C must be a number between -10 and 10');
  process.exit(1);
}
const username = env.SENSOR_MQTT_USERNAME || 'sensor';
const password = env.SENSOR_MQTT_PASSWORD;
if (!password) {
  console.error('Set SENSOR_MQTT_PASSWORD in laptop-1/backend/.env (the broker password of the "sensor" user).');
  process.exit(1);
}

const host = env.MQTT_HOST || '127.0.0.1';
const port = Number(env.MQTT_PORT || 1883);
const topic = env.MQTT_TOPIC_TELEMETRY_TEMP || 'evdt/v1/telemetry/temperature';

const client = mqtt.connect(`mqtt://${host}:${port}`, {
  clientId: `arduino-gateway-${randomUUID().slice(0, 8)}`,
  username,
  password,
  reconnectPeriod: 2000,
  connectTimeout: 10_000,
});
client.on('connect', () => log(`MQTT connected to ${host}:${port} as "${username}", publishing to ${topic}`));
client.on('reconnect', () => log(`MQTT reconnecting to ${host}:${port} ...`));
client.on('offline', () => log('MQTT offline - readings are NOT published until the broker is back'));
client.on('error', (err) => log(`MQTT error: ${err.message}`));

const gateway = new ArduinoGateway({
  SerialPortClass: SerialPort,
  mqttClient: client,
  topic,
  stationId: env.STATION_ID || 'STATION-001',
  sensorId: env.SENSOR_ID || 'LM35-A0-01',
  serialPath: args.port || env.ARDUINO_SERIAL_PORT || 'auto',
  baudRate: Number(env.ARDUINO_BAUD || 9600),
  calibrationStatus,
  offsetC,
});

gateway.on('status', ({ state, detail }) => log(`serial ${state}: ${detail}`));
gateway.on('invalid', (reason) => log(`REJECTED reading (not published): ${reason}`));
gateway.on('dropped', ({ message, reason }) => log(`${message.temperatureC} °C not published: ${reason}`));
if (!args.quiet) {
  gateway.on('published', (m) => log(`${m.temperatureC.toFixed(2)} °C  ${m.sensorId}  -> published (source: sensor)`));
}

log(`station ${gateway.stationId}, sensor ${gateway.sensorId}, calibration ${calibrationStatus}${offsetC ? `, offset ${offsetC} °C` : ''}`);
await gateway.start();

const shutdown = async () => {
  log(`stopping. published=${gateway.stats.published} rejected=${gateway.stats.invalid} not-published=${gateway.stats.dropped}`);
  await gateway.stop();
  client.end(false, () => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
