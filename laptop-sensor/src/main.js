// Sensor laptop: Arduino (USB serial) -> OPC UA server.
//
//   npm run opcua:server               start (auto-detects the Arduino's port)
//   npm run opcua:server -- --port=COM6
//   npm run opcua:server -- --quiet    only log problems and state changes
//   npm run list-ports                 list serial ports and exit
//
// Close the Arduino IDE Serial Monitor first: only one program can open the port.
// The Mac's bridge (laptop-2/opcua_bridge) connects to the endpoint printed below.
import { SerialPort } from 'serialport';
import { lanAddresses, loadConfig } from './config.js';
import { SensorOpcUaServer } from './opcuaServer.js';
import { LatestEvery } from './sampler.js';
import { SerialReader } from './serial.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const log = (...m) => console.log(`[sensor] ${new Date().toLocaleTimeString()}`, ...m);

if (args.list) {
  const ports = await SerialPort.list();
  if (!ports.length) console.log('No serial ports found.');
  for (const p of ports) {
    console.log(`${p.path}\t${p.friendlyName || p.manufacturer || ''}\tvendor=${p.vendorId || '-'} product=${p.productId || '-'}`);
  }
  process.exit(0);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[sensor] bad setting in laptop-sensor/.env: ${err.message}`);
  process.exit(1);
}

const addresses = lanAddresses();
const server = new SensorOpcUaServer({
  port: config.opcuaPort,
  resourcePath: config.resourcePath,
  hostname: config.hostname,
  alternateHostname: addresses,
  stationId: config.stationId,
  sensorId: config.sensorId,
  calibrationStatus: config.calibrationStatus,
  staleAfterSec: config.staleAfterSec,
  logger: (m) => log(m),
});

const sampler = new LatestEvery(Math.round(config.publishIntervalSec * 1000), (reading) => {
  server.update(reading);
  if (!args.quiet) log(`${reading.temperatureC.toFixed(2)} °C  ${config.sensorId}  -> OPC UA TemperatureC (Good)`);
});

const reader = new SerialReader({
  SerialPortClass: SerialPort,
  serialPath: args.port || config.serialPath,
  baudRate: config.baudRate,
  offsetC: config.offsetC,
});
reader.on('reading', (r) => sampler.push(r));
reader.on('invalid', (reason) => log(`REJECTED reading (not served): ${reason}`));
reader.on('status', ({ state, detail }) => {
  log(`serial ${state}: ${detail}`);
  if (state === 'disconnected') {
    sampler.clear();
    server.markOffline('USB serial port closed');
  }
});

try {
  await server.start();
} catch (err) {
  console.error(`[sensor] could not start the OPC UA server on port ${config.opcuaPort}: ${err.message}`);
  if (/EADDRINUSE/.test(err.message)) console.error('[sensor] another program (maybe a second copy of this one) already uses that port.');
  process.exit(1);
}

log(`OPC UA server running. Security: none, anonymous, read-only (LAN demo).`);
log(`Endpoints for the Mac bridge (OPCUA_URL in laptop-2/opcua_bridge/.env):`);
for (const a of addresses) log(`   opc.tcp://${a}:${config.opcuaPort}${config.resourcePath}`);
log(`   (this laptop only: opc.tcp://localhost:${config.opcuaPort}${config.resourcePath})`);
log(
  `station ${config.stationId}, sensor ${config.sensorId}, calibration ${config.calibrationStatus}` +
    `${config.offsetC ? `, offset ${config.offsetC} °C` : ''}, ` +
    (config.publishIntervalSec > 0 ? `value updated every ${config.publishIntervalSec} s` : 'value updated on every Arduino line') +
    `, offline after ${config.staleAfterSec} s without a reading`,
);

sampler.start();
await reader.start();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log(`stopping. readings=${reader.stats.readings} rejected=${reader.stats.invalid}`);
  sampler.stop();
  await reader.stop();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
