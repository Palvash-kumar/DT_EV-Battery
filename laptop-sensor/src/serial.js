// Reads the Arduino UNO R4 ambient temperature from the USB serial port.
//
// The board runs laptop-1/arduino/temperature_lm35/temperature_lm35.ino and
// prints one line every ~2.2 s:   Temperature: 31.26 °C
// Each valid line becomes a reading stamped with the time it arrived (the
// board has no clock). Nothing is ever invented: if the port is closed,
// unplugged or sends nothing usable, there simply are no readings.
import { EventEmitter } from 'node:events';
import { ReadlineParser } from 'serialport';

// Arduino SA / Arduino LLC USB vendor ids (UNO R4 WiFi is 2341:1002).
export const ARDUINO_VENDOR_IDS = ['2341', '2a03'];

// Same limits as shared/schemas/telemetry-temperature.schema.json. A value
// outside them is impossible for this setup (an LM35 with a loose or missing
// wire on A0 reads anywhere from 0 to ~500 °C), so it is dropped.
export const SCHEMA_MIN_C = -50;
export const SCHEMA_MAX_C = 85;

const LINE_RE = /^\s*Temperature\s*:\s*(-?\d+(?:\.\d+)?|nan|inf|ovf)\b/i;

// Returns { kind: 'reading', temperatureC } | { kind: 'invalid', reason } | { kind: 'other' }.
// `offsetC` is the one-point calibration offset, applied before the range check.
export function parseLine(line, offsetC = 0) {
  const text = String(line).replace(/\r/g, '').trim();
  if (!text) return { kind: 'other' };
  const m = LINE_RE.exec(text);
  if (!m) return { kind: 'other' };
  const raw = Number(m[1]);
  if (!Number.isFinite(raw)) return { kind: 'invalid', reason: `sensor printed "${m[1]}"` };
  const value = +(raw + offsetC).toFixed(2);
  if (value < SCHEMA_MIN_C || value > SCHEMA_MAX_C) {
    return {
      kind: 'invalid',
      reason: `${value} °C is outside ${SCHEMA_MIN_C}..${SCHEMA_MAX_C} °C - check the sensor wiring on the Arduino`,
    };
  }
  return { kind: 'reading', temperatureC: value };
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
    return `${path} does not exist. Is the Arduino plugged in? Run "npm run list-ports" to see the ports.`;
  }
  return msg;
}

// Events:
//   'reading'  { temperatureC, receivedAt: Date }   every valid line
//   'invalid'  reason                                a temperature line that was rejected
//   'status'   { state, detail }                     waiting | open | disconnected | silent | error
//   'line'     raw text
export class SerialReader extends EventEmitter {
  constructor({ SerialPortClass, serialPath = 'auto', baudRate = 9600, offsetC = 0, retryMs = 5000, silenceWarnMs = 15000 }) {
    super();
    Object.assign(this, { SerialPortClass, serialPath, baudRate, offsetC, retryMs, silenceWarnMs });
    this.port = null;
    this.path = null;
    this.stopped = false;
    this.retryTimer = null;
    this.silenceTimer = null;
    this.lastLineAt = 0;
    this.stats = { readings: 0, invalid: 0, ignoredLines: 0 };
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
    this.path = path;
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

  handleLine(line, receivedAt = new Date()) {
    this.lastLineAt = Date.now();
    this.emit('line', line);
    const parsed = parseLine(line, this.offsetC);
    if (parsed.kind === 'other') {
      this.stats.ignoredLines += 1;
      return null;
    }
    if (parsed.kind === 'invalid') {
      this.stats.invalid += 1;
      this.emit('invalid', parsed.reason);
      return null;
    }
    const reading = { temperatureC: parsed.temperatureC, receivedAt };
    this.stats.readings += 1;
    this.emit('reading', reading);
    return reading;
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
