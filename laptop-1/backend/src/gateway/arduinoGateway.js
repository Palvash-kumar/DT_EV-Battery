// Serial -> MQTT gateway for the Arduino UNO R4 ambient temperature sensor.
//
// The board runs laptop-1/arduino/temperature_lm35/temperature_lm35.ino and
// prints one line every ~2 s:   Temperature: 31.26 °C
// This module reads those lines from the USB serial port, checks them, stamps
// them with the time they arrived (the board has no clock) and publishes them
// to evdt/v1/telemetry/temperature with source "sensor".
//
// It never invents a value: if the port is closed, unplugged or sends nothing
// usable, nothing is published and the backend's sensor monitor reports the
// sensor as offline.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ReadlineParser } from 'serialport';
import { check } from '../contracts.js';

// Arduino SA / Arduino LLC USB vendor ids (UNO R4 WiFi is 2341:1002).
export const ARDUINO_VENDOR_IDS = ['2341', '2a03'];

// The telemetry schema accepts -50..85 °C. A value outside that is not
// "suspect", it is impossible for this setup (an LM35 with a loose or missing
// wire on A0 reads anywhere from 0 to ~500 °C), so it is dropped.
export const SCHEMA_MIN_C = -50;
export const SCHEMA_MAX_C = 85;

const LINE_RE = /^\s*Temperature\s*:\s*(-?\d+(?:\.\d+)?|nan|inf|ovf)\b/i;

// Returns { kind: 'reading', temperatureC } | { kind: 'invalid', reason } | { kind: 'other' }.
export function parseLine(line) {
  const text = String(line).replace(/\r/g, '').trim();
  if (!text) return { kind: 'other' };
  const m = LINE_RE.exec(text);
  if (!m) return { kind: 'other' };
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return { kind: 'invalid', reason: `sensor printed "${m[1]}"` };
  if (value < SCHEMA_MIN_C || value > SCHEMA_MAX_C) {
    return {
      kind: 'invalid',
      reason: `${value} °C is outside ${SCHEMA_MIN_C}..${SCHEMA_MAX_C} °C - check the sensor wiring on the Arduino`,
    };
  }
  return { kind: 'reading', temperatureC: value };
}

export function buildReading({ temperatureC, stationId, sensorId, calibrationStatus, offsetC = 0, now = new Date() }) {
  return {
    schemaVersion: '1.0',
    messageId: randomUUID(),
    stationId,
    sensorId,
    timestamp: now.toISOString(),
    temperatureC: +(temperatureC + offsetC).toFixed(2),
    source: 'sensor',
    calibrationStatus,
    simulated: false,
  };
}

// Picks the serial port: the configured one, or the first Arduino found.
export async function findPort(SerialPortClass, configured) {
  const ports = await SerialPortClass.list();
  if (configured && configured.toLowerCase() !== 'auto') {
    return ports.find((p) => p.path.toLowerCase() === configured.toLowerCase())?.path ?? null;
  }
  const arduino = ports.find((p) => ARDUINO_VENDOR_IDS.includes(String(p.vendorId || '').toLowerCase()));
  return arduino?.path ?? null;
}

export function explainOpenError(err, path) {
  const msg = err?.message || String(err);
  if (/access denied|resource busy|EBUSY|EACCES/i.test(msg)) {
    return `${path} is in use by another program. Close the Arduino IDE Serial Monitor / Serial Plotter (only one program can use a serial port at a time).`;
  }
  if (/file not found|cannot find|no such file|ENOENT/i.test(msg)) {
    return `${path} does not exist. Is the Arduino plugged in? Run "npm run gateway:arduino -- --list" to see the ports.`;
  }
  return msg;
}

// Events: 'status' ({ state, detail }), 'reading' (message), 'invalid' (reason),
// 'published' (message), 'dropped' ({ message, reason }), 'line' (raw).
export class ArduinoGateway extends EventEmitter {
  constructor({
    SerialPortClass,
    mqttClient,
    topic,
    stationId,
    sensorId,
    serialPath = 'auto',
    baudRate = 9600,
    calibrationStatus = 'uncalibrated',
    offsetC = 0,
    retryMs = 5000,
    silenceWarnMs = 15000,
  }) {
    super();
    Object.assign(this, {
      SerialPortClass,
      mqttClient,
      topic,
      stationId,
      sensorId,
      serialPath,
      baudRate,
      calibrationStatus,
      offsetC,
      retryMs,
      silenceWarnMs,
    });
    this.port = null;
    this.stopped = false;
    this.retryTimer = null;
    this.silenceTimer = null;
    this.lastLineAt = 0;
    this.stats = { published: 0, invalid: 0, dropped: 0, ignoredLines: 0 };
  }

  status(state, detail) {
    this.emit('status', { state, detail });
  }

  async start() {
    this.stopped = false;
    await this.open();
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open().catch((err) => this.status('error', err.message));
    }, this.retryMs);
  }

  async open() {
    if (this.stopped || this.port) return;
    let path;
    try {
      path = await findPort(this.SerialPortClass, this.serialPath);
    } catch (err) {
      this.status('waiting', `could not list serial ports: ${err.message}`);
      return this.scheduleRetry();
    }
    if (!path) {
      const what = this.serialPath && this.serialPath !== 'auto' ? this.serialPath : 'an Arduino';
      this.status('waiting', `${what} not found on any serial port; retrying every ${this.retryMs / 1000}s`);
      return this.scheduleRetry();
    }

    const port = new this.SerialPortClass({ path, baudRate: this.baudRate, autoOpen: false });
    try {
      await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      this.status('waiting', `${explainOpenError(err, path)} Retrying every ${this.retryMs / 1000}s`);
      return this.scheduleRetry();
    }
    if (this.stopped) {
      port.close(() => {});
      return undefined;
    }

    this.port = port;
    this.lastLineAt = Date.now();
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n', encoding: 'utf8' }));
    parser.on('data', (line) => this.handleLine(line));
    port.on('close', () => {
      this.port = null;
      clearInterval(this.silenceTimer);
      if (this.stopped) return;
      this.status('disconnected', `${path} closed (USB unplugged?); waiting for it to come back`);
      this.scheduleRetry();
    });
    port.on('error', (err) => this.status('error', `${path}: ${err.message}`));

    clearInterval(this.silenceTimer);
    this.silenceTimer = setInterval(() => {
      if (this.port && Date.now() - this.lastLineAt > this.silenceWarnMs) {
        this.status(
          'silent',
          `no data from ${path} for ${Math.round((Date.now() - this.lastLineAt) / 1000)}s - is the sketch running at ${this.baudRate} baud?`,
        );
      }
    }, this.silenceWarnMs);
    this.silenceTimer.unref?.();

    this.status('open', `reading ${path} at ${this.baudRate} baud`);
    return undefined;
  }

  handleLine(line) {
    this.lastLineAt = Date.now();
    this.emit('line', line);
    const parsed = parseLine(line);
    if (parsed.kind === 'other') {
      this.stats.ignoredLines += 1;
      return null;
    }
    if (parsed.kind === 'invalid') {
      this.stats.invalid += 1;
      this.emit('invalid', parsed.reason);
      return null;
    }
    const message = buildReading({
      temperatureC: parsed.temperatureC,
      stationId: this.stationId,
      sensorId: this.sensorId,
      calibrationStatus: this.calibrationStatus,
      offsetC: this.offsetC,
    });
    const contract = check('telemetryTemperature', message);
    if (!contract.ok) {
      this.stats.invalid += 1;
      this.emit('invalid', `does not match telemetry schema: ${contract.message}`);
      return null;
    }
    this.emit('reading', message);

    // Readings are not queued while the broker is down: a stale burst on
    // reconnect would look live for a moment. The gap is visible instead.
    if (!this.mqttClient.connected) {
      this.stats.dropped += 1;
      this.emit('dropped', { message, reason: 'MQTT broker not connected' });
      return message;
    }
    this.mqttClient.publish(this.topic, JSON.stringify(message), { qos: 1 }, (err) => {
      if (err) {
        this.stats.dropped += 1;
        this.emit('dropped', { message, reason: err.message });
      } else {
        this.stats.published += 1;
        this.emit('published', message);
      }
    });
    return message;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.silenceTimer);
    const port = this.port;
    this.port = null;
    if (port?.isOpen) await new Promise((r) => port.close(() => r()));
  }
}
