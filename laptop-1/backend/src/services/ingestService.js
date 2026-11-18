import { EventEmitter } from 'node:events';
import { check } from '../contracts.js';
import { DEFAULT_HEALTH_NOTES } from '../domain/labels.js';
import { Alert, HealthEstimate, TelemetryReading } from '../models/index.js';
import { entry } from '../models/statusEntry.js';

// Plausible range for ambient air around a charger. The schema allows -50..85;
// anything outside this narrower band is stored but marked suspect.
const AMBIENT_MIN_C = -30;
const AMBIENT_MAX_C = 55;
const FUTURE_SKEW_MS = 2 * 60 * 1000;

const isDuplicateKey = (err) => err?.code === 11000;

function parse(payload) {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return undefined;
  }
}

// Handles the "everything except charging results" MQTT topics.
// Emits 'telemetry', 'alert', 'health' with the stored document.
export class IngestService extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.log = logger.child({ component: 'ingest' });
    this.stats = { telemetry: 0, alerts: 0, health: 0, duplicates: 0, rejected: 0 };
  }

  reject(kind, reason, extra = {}) {
    this.stats.rejected += 1;
    this.log.warn({ kind, reason, ...extra }, 'message rejected');
    return { outcome: 'rejected' };
  }

  // Quality is decided here, once, and stored with the reading.
  static assessReading(msg, now = Date.now()) {
    const notes = [];
    let quality = msg.calibrationStatus === 'calibrated' ? 'good' : 'unknown';
    if (msg.calibrationStatus !== 'calibrated') notes.push(`sensor calibration: ${msg.calibrationStatus || 'unknown'}`);
    if (msg.temperatureC < AMBIENT_MIN_C || msg.temperatureC > AMBIENT_MAX_C) {
      quality = 'suspect';
      notes.push(`outside plausible ambient range ${AMBIENT_MIN_C}..${AMBIENT_MAX_C} °C`);
    }
    if (new Date(msg.timestamp).getTime() - now > FUTURE_SKEW_MS) {
      quality = 'suspect';
      notes.push('timestamp is ahead of the server clock');
    }
    if (typeof msg.simulated === 'boolean' && msg.simulated !== (msg.source === 'simulation')) {
      quality = 'bad';
      notes.push(`"simulated: ${msg.simulated}" contradicts source "${msg.source}"`);
    }
    return { quality, qualityNotes: notes.length ? notes : undefined };
  }

  async handleTelemetry(payload) {
    const msg = parse(payload);
    if (msg === undefined) return this.reject('telemetry', 'not JSON');
    const contract = check('telemetryTemperature', msg);
    if (!contract.ok) return this.reject('telemetry', contract.message);

    const { quality, qualityNotes } = IngestService.assessReading(msg);
    try {
      const doc = await TelemetryReading.create({
        messageId: msg.messageId,
        stationId: msg.stationId,
        sensorId: msg.sensorId ?? null,
        timestamp: new Date(msg.timestamp),
        temperatureC: msg.temperatureC,
        calibrationStatus: msg.calibrationStatus || 'unknown',
        source: msg.source,
        quality,
        qualityNotes,
      });
      this.stats.telemetry += 1;
      this.emit('telemetry', doc.toObject());
      return { outcome: 'stored', doc };
    } catch (err) {
      if (isDuplicateKey(err)) {
        this.stats.duplicates += 1;
        return { outcome: 'duplicate' };
      }
      throw err;
    }
  }

  async handleAlert(payload) {
    const msg = parse(payload);
    if (msg === undefined) return this.reject('alert', 'not JSON');
    const contract = check('alert', msg);
    if (!contract.ok) return this.reject('alert', contract.message);

    const existing = await Alert.findOne({ alertId: msg.alertId }).lean();
    if (existing?.lastMessageId === msg.messageId) {
      this.stats.duplicates += 1;
      return { outcome: 'duplicate' };
    }
    const seenAt = new Date(msg.timestamp);

    let doc;
    if (!existing) {
      try {
        doc = await Alert.create({
          alertId: msg.alertId,
          stationId: this.config.stationId,
          severity: msg.severity,
          type: msg.type,
          raisedBy: msg.source,
          affectedAsset: msg.affectedAsset ?? null,
          evidence: msg.evidence ?? {},
          recommendedAction: msg.recommendedAction ?? null,
          status: msg.status,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
          lastMessageId: msg.messageId,
          statusHistory: [entry(msg.status, { by: msg.source, messageId: msg.messageId, note: 'raised' })],
        });
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        return this.handleAlert(payload); // created by a parallel message; treat as repeat
      }
    } else {
      // Same alert again: count it instead of creating a new row (no alert storm).
      const update = {
        $set: {
          lastSeenAt: seenAt,
          lastMessageId: msg.messageId,
          severity: msg.severity,
          evidence: msg.evidence ?? existing.evidence,
        },
        $inc: { occurrences: 1 },
      };
      // A service may resolve its own alert, or a new occurrence re-opens a resolved one.
      const reopen = existing.status === 'resolved' && msg.status === 'open';
      if (msg.status === 'resolved' || reopen) {
        update.$set.status = msg.status;
        update.$push = {
          statusHistory: entry(msg.status, { by: msg.source, messageId: msg.messageId, note: reopen ? 'condition seen again' : 'resolved by service' }),
        };
      }
      doc = await Alert.findOneAndUpdate({ alertId: msg.alertId }, update, { new: true });
    }
    this.stats.alerts += 1;
    this.emit('alert', doc.toObject());
    return { outcome: 'stored', doc };
  }

  async handleHealth(payload) {
    const msg = parse(payload);
    if (msg === undefined) return this.reject('health', 'not JSON');
    const contract = check('healthResult', msg);
    if (!contract.ok) return this.reject('health', contract.message);

    const notes = msg.applicabilityNotes?.length ? msg.applicabilityNotes : DEFAULT_HEALTH_NOTES;
    try {
      const doc = await HealthEstimate.create({
        healthEstimateId: msg.messageId,
        requestId: msg.requestId,
        status: msg.status,
        sohPct: msg.health?.sohPct ?? null,
        capacityLossAh: msg.health?.capacityLossAh ?? null,
        rulCycles: msg.health?.rulCycles ?? null,
        eolThresholdSohPct: msg.health?.eolThresholdSohPct ?? null,
        model: msg.model ?? {},
        warnings: msg.warnings ?? [],
        applicabilityNotes: notes,
        processedAt: new Date(msg.processedAt),
        source: 'ml_estimate',
        quality: msg.status === 'completed' ? 'unknown' : 'bad',
      });
      this.stats.health += 1;
      this.emit('health', doc.toObject());
      return { outcome: 'stored', doc };
    } catch (err) {
      if (isDuplicateKey(err)) {
        this.stats.duplicates += 1;
        return { outcome: 'duplicate' };
      }
      throw err;
    }
  }
}
