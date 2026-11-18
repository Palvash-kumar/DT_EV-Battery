import { randomUUID } from 'node:crypto';
import { check, SCHEMA_VERSION } from '../contracts.js';

// Publishes the retained evdt/v1/stations/{id}/status message and watches the
// same topic for the Python worker's Last Will.
//
// The worker's will is {"mlworker":"offline"}, which does not follow
// station-status.schema.json. When it shows up we remember that the worker
// went away and put a valid retained status back on the topic.
export class StationStatusService {
  constructor({ config, mqtt, logger }) {
    this.config = config;
    this.mqtt = mqtt;
    this.log = logger.child({ component: 'station-status' });
    this.lastPublishedId = null;
    this.mlWorker = { lastOfflineNoticeAt: null };
    this.buildExtra = () => ({});
  }

  // Phase 7 plugs charger/telemetry state in here.
  setStateBuilder(fn) {
    this.buildExtra = fn;
  }

  async publish(status = 'online') {
    const extra = await this.buildExtra();
    const msg = {
      schemaVersion: SCHEMA_VERSION,
      messageId: randomUUID(),
      stationId: this.config.stationId,
      updatedAt: new Date().toISOString(),
      status,
      ...extra,
    };
    const contract = check('stationStatus', msg);
    if (!contract.ok) {
      this.log.error({ reason: contract.message }, 'station status does not match schema, not published');
      return;
    }
    this.lastPublishedId = msg.messageId;
    try {
      await this.mqtt.publish(this.config.topics.stationStatus(this.config.stationId), msg, { retain: true });
    } catch (err) {
      this.log.warn({ err: err.message }, 'could not publish station status');
    }
  }

  async handleMessage(topic, payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (msg?.mlworker === 'offline') {
      this.mlWorker.lastOfflineNoticeAt = new Date().toISOString();
      this.log.warn({ topic }, 'ML worker last will received');
      if (topic === this.config.topics.stationStatus(this.config.stationId)) await this.publish('online');
      return;
    }
    if (msg?.messageId === this.lastPublishedId) return;
    const contract = check('stationStatus', msg);
    if (!contract.ok) this.log.warn({ topic, reason: contract.message }, 'unexpected station status payload');
  }
}
