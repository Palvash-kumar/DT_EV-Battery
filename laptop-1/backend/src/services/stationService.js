import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { LABELS } from '../domain/labels.js';
import { AppError, notFound } from '../errors.js';
import { Charger, ChargingSession, PredictionRequest, Station, TelemetryReading } from '../models/index.js';

const SWEEP_MS = 2000;

// Simulated SOC/energy for an active simulated session, worked out from the
// clock. Nothing here comes from a car or an energy meter.
export function simulatedProgress(session, now = Date.now()) {
  const sim = session.simulation;
  if (!sim || session.source !== 'simulation') return null;
  const totalMs = (sim.predictedDurationHours * 3600 * 1000) / sim.timeScale;
  const end = session.endedAt ? new Date(session.endedAt).getTime() : now;
  const elapsed = Math.max(0, end - new Date(session.startedAt).getTime());
  const fraction = totalMs > 0 ? Math.min(1, elapsed / totalMs) : 1;
  return {
    label: LABELS.simulatedSoc,
    source: 'simulation',
    timeScale: sim.timeScale,
    progressPct: +(fraction * 100).toFixed(1),
    socPct: +(session.startSocPct + (sim.targetSocPct - session.startSocPct) * fraction).toFixed(1),
    energyKwh: +(sim.predictedEnergyKwh * fraction).toFixed(2),
    expectedEndAt: sim.expectedEndAt,
  };
}

export class StationService extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.log = logger.child({ component: 'station' });
    this.timer = null;
  }

  async view(stationId) {
    const station = await Station.findOne({ stationId }, { _id: 0, __v: 0 }).lean();
    if (!station) throw notFound('Station');
    const [chargers, sessions, latest, latestSensor] = await Promise.all([
      Charger.find({ stationId }, { _id: 0, __v: 0 }).sort({ bay: 1 }).lean(),
      ChargingSession.find({ stationId, source: 'simulation', status: 'active' }).lean(),
      TelemetryReading.findOne({ stationId }).sort({ timestamp: -1 }).lean(),
      // The newest REAL Arduino reading, kept apart so a running simulator
      // can never hide it or stand in for it.
      TelemetryReading.findOne({ stationId, source: 'sensor' }).sort({ timestamp: -1 }).lean(),
    ]);
    const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
    return {
      station,
      chargers: chargers.map((c) => {
        const s = c.currentSessionId ? bySession.get(c.currentSessionId) : null;
        return { ...c, session: s ? this.sessionView(s) : null };
      }),
      telemetry: latest ? this.readingView(latest) : null,
      sensorTelemetry: latestSensor ? this.readingView(latestSensor) : null,
      generatedAt: new Date().toISOString(),
    };
  }

  readingView(r) {
    return {
      temperatureC: r.temperatureC,
      units: r.units,
      measures: r.measures,
      label: LABELS.ambientTemperature,
      source: r.source,
      quality: r.quality,
      qualityNotes: r.qualityNotes,
      sensorId: r.sensorId,
      calibrationStatus: r.calibrationStatus,
      messageId: r.messageId,
      timestamp: r.timestamp,
      ageSec: Math.round((Date.now() - new Date(r.timestamp).getTime()) / 1000),
    };
  }

  sessionView(s) {
    const { _id, __v, ...rest } = s;
    return { ...rest, simulated: simulatedProgress(s) };
  }

  // Shape required by station-status.schema.json (retained MQTT message).
  async mqttState() {
    const stationId = this.config.stationId;
    const [chargers, latest] = await Promise.all([
      Charger.find({ stationId }).sort({ bay: 1 }).lean(),
      TelemetryReading.findOne({ stationId }).sort({ timestamp: -1 }).lean(),
    ]);
    return {
      chargers: chargers.map((c) => ({
        chargerId: c.chargerId,
        status: c.status,
        currentSessionRequestId: c.currentRequestId || null,
      })),
      telemetry: {
        temperatureC: latest?.temperatureC ?? null,
        temperatureSource: latest?.source ?? 'unknown',
        lastTemperatureAt: latest ? new Date(latest.timestamp).toISOString() : null,
      },
    };
  }

  async setChargerStatus(stationId, chargerId, { status, note }) {
    const charger = await Charger.findOne({ stationId, chargerId });
    if (!charger) throw notFound('Charger');
    if (charger.status === 'charging' && status === 'available') {
      throw new AppError(409, 'CHARGER_BUSY', 'Stop the running simulated session instead of marking the bay available');
    }
    if (charger.status === 'charging' && charger.currentSessionId) {
      await this.finishSession(charger.currentSessionId, 'stopped', `charger set to ${status}`);
    }
    const updated = await Charger.findOneAndUpdate(
      { chargerId },
      {
        $set: {
          status,
          statusSource: 'manual',
          statusNote: note || null,
          statusUpdatedAt: new Date(),
          currentSessionId: null,
          currentRequestId: null,
        },
      },
      { new: true },
    ).lean();
    this.log.info({ chargerId, status }, 'charger status changed by operator');
    this.emit('changed', { stationId, chargerId });
    return updated;
  }

  // Starts a simulated session from a completed prediction. The predicted
  // duration drives the clock, sped up by SIM_TIME_SCALE so a 2 h charge
  // plays out in about 2 minutes on screen.
  async startSimulated({ requestId, chargerId }) {
    const prediction = await PredictionRequest.findOne({ requestId }).lean();
    if (!prediction) throw notFound('Prediction request');
    if (prediction.status !== 'completed') {
      throw new AppError(409, 'PREDICTION_NOT_COMPLETED', `Prediction is ${prediction.status}; only completed predictions can start a session`);
    }
    const bay = chargerId || prediction.chargerId;
    if (!bay) throw new AppError(400, 'CHARGER_REQUIRED', 'Choose a charger bay for the session');

    const charger = await Charger.findOne({ chargerId: bay, stationId: prediction.stationId }).lean();
    if (!charger) throw notFound('Charger');
    if (charger.chargerType !== prediction.input.charging.chargerType) {
      throw new AppError(400, 'CHARGER_TYPE_MISMATCH', `${bay} is a ${charger.chargerType}`);
    }

    const sessionId = randomUUID();
    // Atomic: only one session can grab an available bay.
    const claimed = await Charger.findOneAndUpdate(
      { chargerId: bay, status: 'available' },
      {
        $set: {
          status: 'charging',
          statusSource: 'simulation',
          statusNote: 'simulated session',
          statusUpdatedAt: new Date(),
          currentSessionId: sessionId,
          currentRequestId: requestId,
        },
      },
      { new: true },
    );
    if (!claimed) throw new AppError(409, 'CHARGER_BUSY', `${bay} is ${charger.status}, not available`);

    const { predictions } = prediction.result;
    const timeScale = this.config.simTimeScale;
    const startedAt = new Date();
    const session = await ChargingSession.create({
      sessionId,
      stationId: prediction.stationId,
      chargerId: bay,
      requestId,
      status: 'active',
      startedAt,
      vehicleModel: prediction.input.vehicle.model,
      batteryCapacityKwh: prediction.input.vehicle.batteryCapacityKwh,
      vehicleAgeYears: prediction.input.vehicle.vehicleAgeYears,
      chargerType: charger.chargerType,
      startSocPct: prediction.input.charging.startSocPct,
      chargingRateKw: prediction.input.charging.requestedRateKw,
      temperatureC: prediction.input.environment.temperatureC,
      simulation: {
        timeScale,
        predictedDurationHours: predictions.durationHours,
        predictedEnergyKwh: predictions.energyKwh,
        targetSocPct: prediction.input.charging.targetSocPct,
        expectedEndAt: new Date(startedAt.getTime() + (predictions.durationHours * 3600 * 1000) / timeScale),
      },
      source: 'simulation',
      quality: 'unknown',
      qualityNotes: ['Progress is simulated from the predicted duration; no meter or BMS data.'],
    });
    this.log.info({ sessionId, chargerId: bay, requestId, timeScale }, 'simulated session started');
    this.emit('changed', { stationId: prediction.stationId, chargerId: bay, sessionId });
    return this.sessionView(session.toObject());
  }

  async finishSession(sessionId, status, note) {
    const session = await ChargingSession.findOneAndUpdate(
      { sessionId, status: 'active' },
      { $set: { status, endedAt: new Date() }, $push: { qualityNotes: note } },
      { new: true },
    ).lean();
    if (!session) return null;
    const p = simulatedProgress(session);
    await ChargingSession.updateOne({ sessionId }, { $set: { endSocPct: p.socPct, energyKwh: p.energyKwh } });
    await Charger.updateOne(
      { chargerId: session.chargerId, currentSessionId: sessionId },
      {
        $set: {
          status: 'available',
          statusSource: 'simulation',
          statusNote: `simulated session ${status}`,
          statusUpdatedAt: new Date(),
          currentSessionId: null,
          currentRequestId: null,
        },
      },
    );
    this.log.info({ sessionId, status }, 'simulated session finished');
    this.emit('changed', { stationId: session.stationId, chargerId: session.chargerId, sessionId });
    return { ...session, endSocPct: p.socPct, energyKwh: p.energyKwh };
  }

  async stopSession(sessionId) {
    const done = await this.finishSession(sessionId, 'stopped', 'stopped from dashboard');
    if (!done) throw new AppError(409, 'SESSION_NOT_ACTIVE', 'Session is not running');
    return this.sessionView(done);
  }

  // Ends simulated sessions whose simulated time is up. Also catches up after
  // a restart, because it only looks at expectedEndAt in the database.
  async sweep() {
    const due = await ChargingSession.find(
      { source: 'simulation', status: 'active', 'simulation.expectedEndAt': { $lte: new Date() } },
      { sessionId: 1 },
    ).lean();
    for (const s of due) await this.finishSession(s.sessionId, 'completed', 'reached predicted duration');
  }

  start() {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.log.error({ err: err.message }, 'session sweep failed'));
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
