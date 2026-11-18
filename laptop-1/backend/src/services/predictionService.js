import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { check, SCHEMA_VERSION } from '../contracts.js';
import { AppError, notFound } from '../errors.js';
import { Charger, PredictionRequest } from '../models/index.js';
import { entry } from '../models/statusEntry.js';

const FINAL = new Set(['completed', 'failed']);

// scripts/stub-worker.js marks its output with this model version.
const isStubResult = (msg) =>
  [msg.model?.durationVersion, msg.model?.energyVersion].some((v) => String(v || '').startsWith('dev-stub'));
const SEEN_LIMIT = 5000;

// Small insertion-ordered set that forgets the oldest ids once it is full.
class RecentIds {
  constructor(limit) {
    this.limit = limit;
    this.ids = new Set();
  }
  has(id) {
    return this.ids.has(id);
  }
  add(id) {
    this.ids.add(id);
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value);
  }
}

export function toPublicPrediction(doc) {
  if (!doc) return null;
  const d = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    requestId: d.requestId,
    stationId: d.stationId,
    chargerId: d.chargerId,
    status: d.status,
    attempts: d.attempts,
    statusHistory: d.statusHistory,
    input: d.input,
    result: d.result,
    error: d.error,
    sentAt: d.sentAt,
    completedAt: d.completedAt,
    timedOutAt: d.timedOutAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export class PredictionService extends EventEmitter {
  constructor({ config, mqtt, logger }) {
    super();
    this.config = config;
    this.mqtt = mqtt;
    this.log = logger.child({ component: 'predictions' });
    this.timers = new Map();
    this.seenResultMessages = new RecentIds(SEEN_LIMIT);
    this.waiters = new EventEmitter();
    this.waiters.setMaxListeners(0);
    this.stats = { published: 0, completed: 0, failed: 0, timedOut: 0, duplicates: 0, rejected: 0 };
    this.lastResultAt = null;
  }

  buildEnvelope(doc, messageId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      messageId,
      requestId: doc.requestId,
      sentAt: new Date().toISOString(),
      stationId: doc.stationId,
      vehicle: { ...doc.input.vehicle },
      charging: { ...doc.input.charging },
      environment: { ...doc.input.environment },
    };
  }

  // A request may name a charger bay. If it does, the bay has to exist at this
  // station, be of the requested type, and be able to deliver the rate.
  async checkCharger(stationId, chargerId, charging) {
    const charger = await Charger.findOne({ chargerId, stationId }).lean();
    if (!charger) throw new AppError(400, 'UNKNOWN_CHARGER', `Charger ${chargerId} does not exist at ${stationId}`);
    if (charger.chargerType !== charging.chargerType) {
      throw new AppError(400, 'CHARGER_TYPE_MISMATCH', `${chargerId} is a ${charger.chargerType}, not a ${charging.chargerType}`);
    }
    if (charging.requestedRateKw > charger.maxPowerKw) {
      throw new AppError(
        400,
        'RATE_ABOVE_CHARGER_RATING',
        `${chargerId} is rated ${charger.maxPowerKw} kW; requested ${charging.requestedRateKw} kW`,
      );
    }
  }

  async create(body) {
    const stationId = body.stationId || this.config.stationId;
    const chargerId = body.chargerId || null;
    if (chargerId) await this.checkCharger(stationId, chargerId, body.charging);

    const doc = await PredictionRequest.create({
      requestId: randomUUID(),
      stationId,
      chargerId,
      input: { vehicle: body.vehicle, charging: body.charging, environment: body.environment },
      status: 'pending',
      statusHistory: [entry('pending', { note: 'created from dashboard request' })],
      sentAt: new Date(),
    });
    if (chargerId) await Charger.updateOne({ chargerId }, { $set: { lastRequestId: doc.requestId } });
    return this.send(doc);
  }

  // Publishes the request for an existing pending document. Used by create()
  // and retry(). If the broker is down the request is persisted as failed so
  // the UI can show it and offer a retry.
  async send(doc) {
    const messageId = randomUUID();
    const envelope = this.buildEnvelope(doc, messageId);

    const contract = check('chargingRequest', envelope);
    if (!contract.ok) {
      // Should never happen: the HTTP validator uses the same enums/limits.
      throw new AppError(500, 'CONTRACT_MISMATCH', `Request does not match shared schema: ${contract.message}`);
    }

    await PredictionRequest.updateOne({ requestId: doc.requestId }, { $push: { messageIds: messageId } });

    try {
      await this.mqtt.publish(this.config.topics.requests, envelope);
    } catch (err) {
      const updated = await PredictionRequest.findOneAndUpdate(
        { requestId: doc.requestId, status: 'pending' },
        {
          $set: {
            status: 'failed',
            error: { code: 'BROKER_UNAVAILABLE', message: 'Could not reach the MQTT broker. The request was saved; retry when the broker is back.' },
          },
          $push: { statusHistory: entry('failed', { note: 'BROKER_UNAVAILABLE', messageId }) },
        },
        { new: true },
      );
      this.stats.failed += 1;
      this.log.warn({ requestId: doc.requestId, messageId, reason: err.message }, 'publish failed');
      this.announce(updated);
      throw new AppError(503, 'BROKER_UNAVAILABLE', 'MQTT broker is unavailable', {
        requestId: doc.requestId,
      });
    }

    this.stats.published += 1;
    this.log.info(
      { requestId: doc.requestId, messageId, topic: this.config.topics.requests, stationId: doc.stationId },
      'request published',
    );
    this.armTimeout(doc.requestId, this.config.requestTimeoutMs);
    const fresh = await PredictionRequest.findOneAndUpdate(
      { requestId: doc.requestId },
      { $push: { statusHistory: entry('pending', { note: `published to ${this.config.topics.requests}`, messageId }) } },
      { new: true },
    );
    this.announce(fresh);
    return toPublicPrediction(fresh);
  }

  async retry(requestId) {
    const current = await PredictionRequest.findOne({ requestId });
    if (!current) throw notFound('Prediction request');

    const retryable =
      current.status === 'timed_out' ||
      (current.status === 'failed' && current.error?.code === 'BROKER_UNAVAILABLE');
    if (!retryable) {
      throw new AppError(409, 'NOT_RETRYABLE', `A ${current.status} request cannot be retried`);
    }

    // Same requestId, new messageId. The worker re-publishes its cached result
    // if it already processed this requestId, so a retry never runs the model twice.
    const doc = await PredictionRequest.findOneAndUpdate(
      { requestId, status: current.status },
      {
        $set: { status: 'pending', error: null, timedOutAt: null, sentAt: new Date() },
        $inc: { attempts: 1 },
        $push: { statusHistory: entry('pending', { note: `retry after ${current.status}` }) },
      },
      { new: true },
    );
    if (!doc) throw new AppError(409, 'NOT_RETRYABLE', 'Request changed while retrying, reload it');
    return this.send(doc);
  }

  armTimeout(requestId, ms) {
    clearTimeout(this.timers.get(requestId));
    const timer = setTimeout(() => {
      this.timers.delete(requestId);
      this.expire(requestId).catch((err) =>
        this.log.error({ requestId, err: err.message }, 'timeout handling failed'),
      );
    }, ms);
    timer.unref?.();
    this.timers.set(requestId, timer);
  }

  async expire(requestId) {
    const doc = await PredictionRequest.findOneAndUpdate(
      { requestId, status: 'pending' },
      {
        $set: { status: 'timed_out', timedOutAt: new Date() },
        $push: { statusHistory: entry('timed_out', { note: `no result within ${this.config.requestTimeoutMs} ms` }) },
      },
      { new: true },
    );
    if (!doc) return;
    this.stats.timedOut += 1;
    this.log.warn({ requestId, timeoutMs: this.config.requestTimeoutMs }, 'request timed out');
    this.announce(doc);
  }

  // Called for every message on the charging results topic.
  async handleResult(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      this.stats.rejected += 1;
      this.log.warn('result is not valid JSON, ignored');
      return { outcome: 'rejected' };
    }

    const contract = check('chargingResult', msg);
    if (!contract.ok) {
      // e.g. the worker answers requestId "unknown" when it could not parse a
      // request; there is nothing to correlate that with.
      this.stats.rejected += 1;
      this.log.warn({ requestId: msg?.requestId, reason: contract.message }, 'result failed schema check');
      return { outcome: 'rejected' };
    }

    if (this.seenResultMessages.has(msg.messageId)) {
      this.stats.duplicates += 1;
      this.log.info({ requestId: msg.requestId, messageId: msg.messageId }, 'duplicate result message ignored');
      return { outcome: 'duplicate' };
    }
    this.seenResultMessages.add(msg.messageId);
    this.lastResultAt = new Date().toISOString();

    const existing = await PredictionRequest.findOne({ requestId: msg.requestId }).lean();
    if (!existing) {
      this.log.warn({ requestId: msg.requestId }, 'result for unknown requestId ignored');
      return { outcome: 'unknown' };
    }
    if (FINAL.has(existing.status)) {
      this.stats.duplicates += 1;
      this.log.info({ requestId: msg.requestId, status: existing.status }, 'result for finished request ignored');
      return { outcome: 'duplicate' };
    }

    const now = new Date();
    const update =
      msg.status === 'completed'
        ? {
            status: 'completed',
            completedAt: now,
            error: null,
            result: {
              source: isStubResult(msg) ? 'simulation' : 'ml_estimate',
              predictions: msg.predictions,
              model: msg.model || {},
              warnings: msg.warnings || [],
              processedAt: new Date(msg.processedAt),
              receivedAt: now,
              resultMessageId: msg.messageId,
              lateResult: existing.status === 'timed_out',
            },
          }
        : {
            status: 'failed',
            completedAt: now,
            error: {
              code: msg.error?.code || (msg.status === 'invalid_request' ? 'INVALID_REQUEST' : 'WORKER_ERROR'),
              message: msg.error?.message || 'The ML worker could not process this request.',
            },
          };

    // Only a pending or timed-out request can be finalised. If two copies of
    // a result race, exactly one of them matches this filter.
    const doc = await PredictionRequest.findOneAndUpdate(
      { requestId: msg.requestId, status: { $in: ['pending', 'timed_out'] } },
      {
        $set: update,
        $push: {
          statusHistory: entry(update.status, {
            messageId: msg.messageId,
            note: existing.status === 'timed_out' ? 'late result, arrived after the timeout' : `worker status: ${msg.status}`,
          }),
        },
      },
      { new: true },
    );
    if (!doc) {
      this.stats.duplicates += 1;
      return { outcome: 'duplicate' };
    }

    clearTimeout(this.timers.get(msg.requestId));
    this.timers.delete(msg.requestId);
    if (doc.status === 'completed') this.stats.completed += 1;
    else this.stats.failed += 1;

    const latencyMs = now.getTime() - new Date(existing.sentAt).getTime();
    this.log.info(
      {
        requestId: doc.requestId,
        messageId: msg.messageId,
        status: doc.status,
        latencyMs,
        durationModel: msg.model?.durationVersion,
        energyModel: msg.model?.energyVersion,
        late: existing.status === 'timed_out',
      },
      'result stored',
    );
    this.announce(doc);
    return { outcome: doc.status, doc };
  }

  announce(doc) {
    if (!doc) return;
    const view = toPublicPrediction(doc);
    this.emit('update', view);
    if (view.status !== 'pending') this.waiters.emit(view.requestId, view);
  }

  // Waits until the request leaves "pending" or the wait expires.
  waitForOutcome(requestId, ms) {
    return new Promise((resolve) => {
      const done = (view) => {
        clearTimeout(timer);
        resolve(view);
      };
      const timer = setTimeout(() => {
        this.waiters.off(requestId, done);
        resolve(null);
      }, ms);
      this.waiters.once(requestId, done);
    });
  }

  async get(requestId) {
    const doc = await PredictionRequest.findOne({ requestId });
    if (!doc) throw notFound('Prediction request');
    return toPublicPrediction(doc);
  }

  // After a restart there are no timers. Anything already older than the
  // timeout is marked timed_out; younger requests get a timer for the rest.
  async recoverPending() {
    const pending = await PredictionRequest.find({ status: 'pending' }, { requestId: 1, sentAt: 1 }).lean();
    const now = Date.now();
    for (const p of pending) {
      const left = this.config.requestTimeoutMs - (now - new Date(p.sentAt).getTime());
      if (left <= 0) await this.expire(p.requestId);
      else this.armTimeout(p.requestId, left);
    }
    if (pending.length) this.log.info({ count: pending.length }, 'recovered pending requests');
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
