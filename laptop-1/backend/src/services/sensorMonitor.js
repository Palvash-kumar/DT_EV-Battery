import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { sensorHealth } from '../domain/sensorHealth.js';
import { Alert, TelemetryReading } from '../models/index.js';
import { entry } from '../models/statusEntry.js';

const CHECK_MS = 5000;
const ACTIVE = ['open', 'acknowledged'];

// Watches the real Arduino sensor. When readings stop arriving it opens one
// "sensor_offline" alert, and resolves it when readings come back. It never
// fills the gap with simulated values. Emits 'alert' with the stored alert.
export class SensorMonitor extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.log = logger.child({ component: 'sensor-monitor' });
    this.staleAfterSec = config.sensorStaleSec;
    this.timer = null;
    // An offline alert is only raised after the sensor was seen live while
    // this backend runs, so a site that never plugged one in gets no alert.
    this.seenLive = false;
    this.running = null;
  }

  latest(stationId = this.config.stationId) {
    return TelemetryReading.findOne({ stationId, source: 'sensor' }).sort({ timestamp: -1 }).lean();
  }

  async health(stationId = this.config.stationId, now = Date.now()) {
    const reading = await this.latest(stationId);
    return { reading, ...sensorHealth(reading, this.staleAfterSec, now) };
  }

  // Serialised so two overlapping checks can't open two alerts.
  check(now = Date.now()) {
    if (this.stopped) return Promise.resolve(null);
    if (!this.running) {
      this.running = this.runCheck(now).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async runCheck(now) {
    const stationId = this.config.stationId;
    const { reading, state, ageSec } = await this.health(stationId, now);
    const open = await Alert.findOne({ stationId, type: 'sensor_offline', status: { $in: ACTIVE } }).lean();

    if (state === 'live' || state === 'suspect') {
      this.seenLive = true;
      if (open) await this.resolve(open, reading);
      return state;
    }
    if (state === 'offline' && !open && this.seenLive) await this.raise(stationId, reading, ageSec, now);
    return state;
  }

  async raise(stationId, reading, ageSec, now) {
    const at = new Date(now);
    const doc = await Alert.create({
      alertId: randomUUID(),
      stationId,
      severity: 'warning',
      type: 'sensor_offline',
      raisedBy: 'backend',
      affectedAsset: reading.sensorId || 'arduino-temperature-sensor',
      evidence: {
        lastReadingAt: new Date(reading.timestamp).toISOString(),
        lastTemperatureC: reading.temperatureC,
        secondsSinceLastReading: ageSec,
        staleAfterSec: this.staleAfterSec,
      },
      recommendedAction:
        'Check the Arduino USB cable and sensor wiring, and that "npm run gateway:arduino" is running on the laptop the Arduino is plugged into (with the Arduino IDE Serial Monitor closed). No simulated value is used in its place.',
      status: 'open',
      firstSeenAt: at,
      lastSeenAt: at,
      statusHistory: [entry('open', { note: `no sensor reading for ${ageSec} s` })],
    });
    this.log.warn({ sensorId: reading.sensorId, ageSec }, 'Arduino sensor offline');
    this.emit('alert', doc.toObject());
  }

  async resolve(open, reading) {
    const doc = await Alert.findOneAndUpdate(
      { alertId: open.alertId, status: { $in: ACTIVE } },
      {
        $set: { status: 'resolved', lastSeenAt: new Date() },
        $push: { statusHistory: entry('resolved', { note: `sensor readings resumed (${reading.temperatureC} °C)` }) },
      },
      { new: true, projection: { _id: 0, __v: 0 } },
    ).lean();
    if (!doc) return;
    this.log.info({ sensorId: reading.sensorId }, 'Arduino sensor back online');
    this.emit('alert', doc);
  }

  start() {
    this.timer = setInterval(() => {
      this.check().catch((err) => this.log.error({ err: err.message }, 'sensor check failed'));
    }, CHECK_MS);
    this.timer.unref?.();
  }

  // Waits for a check in flight, so it never runs after MongoDB is closed.
  async stop() {
    clearInterval(this.timer);
    this.stopped = true;
    await this.running?.catch(() => {});
  }
}
