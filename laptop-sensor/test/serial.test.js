import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SerialPortMock } from 'serialport';
import { loadConfig } from '../src/config.js';
import { LatestEvery } from '../src/sampler.js';
import { explainOpenError, findPort, parseLine, SerialReader } from '../src/serial.js';

const waitFor = async (fn, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('Arduino serial line parsing', () => {
  it('reads the line the sketch prints', () => {
    assert.deepEqual(parseLine('Temperature: 31.26 °C\r'), { kind: 'reading', temperatureC: 31.26 });
    // the same bytes decoded as Latin-1 by a misconfigured terminal
    assert.deepEqual(parseLine('Temperature: 31.10 Â°C'), { kind: 'reading', temperatureC: 31.1 });
    assert.deepEqual(parseLine('  Temperature:-4.5 °C'), { kind: 'reading', temperatureC: -4.5 });
  });

  it('applies the calibration offset', () => {
    assert.deepEqual(parseLine('Temperature: 31.26 °C', -0.8), { kind: 'reading', temperatureC: 30.46 });
  });

  it('ignores anything that is not a temperature line', () => {
    assert.equal(parseLine('').kind, 'other');
    assert.equal(parseLine('booting...').kind, 'other');
    assert.equal(parseLine('perature: 31.26 °C').kind, 'other'); // cut-off first line after opening the port
  });

  it('rejects impossible values', () => {
    const high = parseLine('Temperature: 312.40 °C'); // LM35 with A0 floating
    assert.equal(high.kind, 'invalid');
    assert.match(high.reason, /wiring/);
    assert.equal(parseLine('Temperature: nan °C').kind, 'invalid');
    assert.equal(parseLine('Temperature: -60.00 °C').kind, 'invalid');
  });

  it('explains a port that another program holds', () => {
    assert.match(explainOpenError(new Error('Opening COM6: Access denied'), 'COM6'), /Serial Monitor/);
  });
});

describe('serial reader with a mock port', () => {
  beforeEach(() => SerialPortMock.binding.reset());

  it('finds the Arduino by USB vendor id', async () => {
    SerialPortMock.binding.createPort('COM3', { vendorId: '8087' });
    SerialPortMock.binding.createPort('COM6', { vendorId: '2341', productId: '1002' });
    assert.equal(await findPort(SerialPortMock, 'auto'), 'COM6');
    assert.equal(await findPort(SerialPortMock, 'com3'), 'COM3');
    assert.equal(await findPort(SerialPortMock, 'COM9'), null);
  });

  it('emits each valid line once with its arrival time, and rejects bad ones', async () => {
    SerialPortMock.binding.createPort('COM6', { vendorId: '2341' });
    const reader = new SerialReader({ SerialPortClass: SerialPortMock, retryMs: 50 });
    const readings = [];
    const invalid = [];
    reader.on('reading', (r) => readings.push(r));
    reader.on('invalid', (r) => invalid.push(r));
    await reader.start();
    assert.ok(reader.port, 'port opened');
    const before = Date.now();
    reader.port.port.emitData(Buffer.from('perature: 31.0 °C\r\nTemperature: 31.26 °C\r\nTemperature: 312.00 °C\r\nTempera'));
    reader.port.port.emitData(Buffer.from('ture: 31.28 °C\r\n'));
    await waitFor(() => readings.length === 2, 3000, 'two readings');
    assert.deepEqual(readings.map((r) => r.temperatureC), [31.26, 31.28]);
    assert.ok(readings.every((r) => r.receivedAt instanceof Date && r.receivedAt.getTime() >= before - 5));
    assert.equal(invalid.length, 1);
    await reader.stop();
  });

  it('waits for the port and opens it when it appears', async () => {
    const reader = new SerialReader({ SerialPortClass: SerialPortMock, retryMs: 50 });
    const states = [];
    reader.on('status', (s) => states.push(s.state));
    await reader.start();
    assert.equal(reader.port, null);
    SerialPortMock.binding.createPort('COM7', { vendorId: '2341' });
    await waitFor(() => reader.port !== null, 2000, 'port opened after it appeared');
    assert.deepEqual([states[0], states.at(-1)], ['waiting', 'open']);
    await reader.stop();
  });
});

describe('latest-every sampler (the 5 s update interval)', () => {
  it('passes on only the newest reading per interval, and nothing when no reading arrived', async () => {
    const out = [];
    const s = new LatestEvery(150, (r) => out.push(r.temperatureC));
    s.start();
    s.push({ temperatureC: 30.1 });
    s.push({ temperatureC: 30.2 });
    s.push({ temperatureC: 30.3 });
    assert.deepEqual(out, [], 'nothing before the interval is over');
    await waitFor(() => out.length === 1, 1000, 'first sample');
    assert.deepEqual(out, [30.3]);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(out, [30.3], 'no new reading, nothing re-sent');
    s.push({ temperatureC: 30.4 });
    s.clear(); // e.g. USB unplugged before the beat
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(out, [30.3]);
    s.stop();
  });

  it('interval 0 passes every reading straight through', () => {
    const out = [];
    const s = new LatestEvery(0, (r) => out.push(r.temperatureC));
    s.start();
    s.push({ temperatureC: 1 });
    s.push({ temperatureC: 2 });
    assert.deepEqual(out, [1, 2]);
  });
});

describe('config', () => {
  it('defaults: 5 s interval, 30 s stale, port 4840', () => {
    const c = loadConfig({});
    assert.equal(c.publishIntervalSec, 5);
    assert.equal(c.staleAfterSec, 30);
    assert.equal(c.opcuaPort, 4840);
    assert.equal(c.resourcePath, '/evdt');
  });

  it('refuses bad values instead of guessing', () => {
    assert.throws(() => loadConfig({ SENSOR_CALIBRATION: 'maybe' }), /SENSOR_CALIBRATION/);
    assert.throws(() => loadConfig({ SENSOR_OFFSET_C: '50' }), /SENSOR_OFFSET_C/);
    assert.throws(() => loadConfig({ OPCUA_PORT: 'abc' }), /OPCUA_PORT/);
  });
});
