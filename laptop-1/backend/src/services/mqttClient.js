import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import mqtt from 'mqtt';
import { SCHEMA_VERSION } from '../contracts.js';

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

// Owns the single MQTT connection of the backend.
//
// Emits: 'connected', 'disconnected', 'message' (topic, Buffer).
// The browser never talks MQTT; everything goes through this object.
export class MqttService extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.config = config;
    this.log = logger.child({ component: 'mqtt' });
    this.client = null;
    this.connected = false;
    this.lastConnectedAt = null;
    this.lastMessageAt = null;
    this.backoffMs = MIN_BACKOFF_MS;
    this.subscriptions = [];
  }

  get state() {
    return {
      connected: this.connected,
      broker: `${this.config.mqtt.host}:${this.config.mqtt.port}`,
      lastConnectedAt: this.lastConnectedAt,
      lastMessageAt: this.lastMessageAt,
    };
  }

  subscribe(topic) {
    this.subscriptions.push(topic);
  }

  connect() {
    const { host, port, username, password } = this.config.mqtt;
    const { stationId } = this.config;
    const statusTopic = this.config.topics.stationStatus(stationId);

    // Fixed client id + clean:false means Mosquitto keeps QoS 1 results that
    // arrive while the backend is restarting and hands them over on reconnect.
    this.client = mqtt.connect(`mqtt://${host}:${port}`, {
      clientId: `backend-${stationId}`,
      clean: false,
      username,
      password,
      protocolVersion: 4,
      keepalive: 30,
      connectTimeout: 10_000,
      reconnectPeriod: MIN_BACKOFF_MS,
      will: {
        topic: statusTopic,
        payload: JSON.stringify(this.offlineStatus()),
        qos: 1,
        retain: true,
      },
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.lastConnectedAt = new Date().toISOString();
      this.backoffMs = MIN_BACKOFF_MS;
      this.client.options.reconnectPeriod = MIN_BACKOFF_MS;
      this.log.info({ broker: `${host}:${port}` }, 'connected to broker');
      for (const topic of this.subscriptions) {
        this.client.subscribe(topic, { qos: 1 }, (err) => {
          if (err) this.log.error({ topic, err: err.message }, 'subscribe failed');
          else this.log.info({ topic }, 'subscribed');
        });
      }
      this.emit('connected');
    });

    this.client.on('close', () => {
      if (this.connected) {
        this.log.warn('broker connection closed');
        this.emit('disconnected');
      }
      this.connected = false;
    });

    // mqtt.js only has a fixed reconnect period, so stretch it on every
    // attempt to get exponential backoff (1s, 2s, 4s ... capped at 30s).
    this.client.on('reconnect', () => {
      this.log.info({ nextRetryMs: this.backoffMs }, 'reconnecting to broker');
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.client.options.reconnectPeriod = this.backoffMs;
    });

    this.client.on('error', (err) => {
      this.log.error({ err: err.message }, 'mqtt error');
    });

    this.client.on('message', (topic, payload) => {
      this.lastMessageAt = new Date().toISOString();
      this.emit('message', topic, payload);
    });

    return this;
  }

  // Resolves once the broker has acknowledged (PUBACK). Fails fast instead of
  // letting mqtt.js queue the message forever while the broker is down.
  async publish(topic, payload, { retain = false, timeoutMs = 5000 } = {}) {
    if (!this.client || !this.connected) {
      const err = new Error('MQTT broker is not connected');
      err.code = 'BROKER_UNAVAILABLE';
      throw err;
    }
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let timer;
    try {
      await Promise.race([
        this.client.publishAsync(topic, body, { qos: 1, retain }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error('Broker did not acknowledge the publish in time');
            err.code = 'BROKER_UNAVAILABLE';
            reject(err);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  offlineStatus() {
    return {
      schemaVersion: SCHEMA_VERSION,
      messageId: randomUUID(),
      stationId: this.config.stationId,
      updatedAt: new Date().toISOString(),
      status: 'offline',
    };
  }

  // A normal end() waits for in-flight QoS 1 messages to be acknowledged. If
  // the broker is already gone that never happens, so don't wait forever.
  async close(graceMs = 2000) {
    if (!this.client) return;
    const client = this.client;
    let timer;
    const graceful = client.endAsync(!this.connected).then(() => true, () => true);
    const gaveUp = new Promise((r) => {
      timer = setTimeout(() => r(false), graceMs);
    });
    const clean = await Promise.race([graceful, gaveUp]);
    clearTimeout(timer);
    if (!clean) {
      this.log.warn('broker did not confirm shutdown in time, closing connection forcefully');
      await client.endAsync(true).catch(() => {});
    }
    this.connected = false;
  }
}
