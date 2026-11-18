// Settings from laptop-sensor/.env (see .env.example). Shell variables win over the file.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env'), quiet: true });

const CALIBRATION = ['calibrated', 'uncalibrated', 'unknown'];

function number(env, key, fallback, { min, max, integer = false }) {
  const raw = env[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

// This laptop's IPv4 addresses, advertised in the OPC UA endpoints so a client
// that connects by IP (the Mac bridge) sees a matching endpoint.
export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

export function loadConfig(env = process.env) {
  const calibrationStatus = env.SENSOR_CALIBRATION || 'uncalibrated';
  if (!CALIBRATION.includes(calibrationStatus)) {
    throw new Error(`SENSOR_CALIBRATION must be one of ${CALIBRATION.join(', ')}`);
  }
  let resourcePath = env.OPCUA_RESOURCE_PATH || '/evdt';
  if (!resourcePath.startsWith('/')) resourcePath = `/${resourcePath}`;
  return {
    stationId: env.STATION_ID || 'STATION-001',
    sensorId: env.SENSOR_ID || 'LM35-A0-01',
    serialPath: env.ARDUINO_SERIAL_PORT || 'auto',
    baudRate: number(env, 'ARDUINO_BAUD', 9600, { min: 300, max: 2_000_000, integer: true }),
    calibrationStatus,
    offsetC: number(env, 'SENSOR_OFFSET_C', 0, { min: -10, max: 10 }),
    publishIntervalSec: number(env, 'SENSOR_PUBLISH_INTERVAL_SEC', 5, { min: 0, max: 300 }),
    staleAfterSec: number(env, 'SENSOR_STALE_SEC', 30, { min: 5, max: 3600, integer: true }),
    opcuaPort: number(env, 'OPCUA_PORT', 4840, { min: 1, max: 65535, integer: true }),
    resourcePath,
    hostname: env.OPCUA_HOSTNAME || undefined,
  };
}
