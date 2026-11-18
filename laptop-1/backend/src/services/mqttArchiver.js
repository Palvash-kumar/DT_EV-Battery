import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import mqtt from 'mqtt';

// Copies every MQTT message on `topic` into MongoDB (database `mosquitto`,
// collection `messages`), as a cloud log of what went over the broker.
//
// It is deliberately separate from the backend and harmless to it:
//   - it only subscribes, it never publishes (no Last Will either)
//   - clean session: when it's not running the broker keeps nothing for it,
//     so mosquitto.db does not grow because of it
//   - its own database; the backend's `evdt` database is never touched
//   - old rows expire after `ttlDays` so a free Atlas cluster doesn't fill up
//
// Mosquitto itself can't store its data in MongoDB; mosquitto.db stays on
// Laptop 2. Retained messages kept in mosquitto.db are sent to every new
// subscriber, so they land here on the first run, marked retained: true.

const messageSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: null }, // parsed JSON
    payloadText: { type: String, default: null }, // only when it isn't JSON
    payloadBytes: { type: Number, required: true },
    qos: { type: Number, required: true },
    retained: { type: Boolean, required: true }, // replayed from the broker's store
    messageId: { type: String, default: undefined }, // from the JSON body, if any
    requestId: { type: String, default: undefined },
    stationId: { type: String, default: undefined },
    broker: { type: String, required: true },
    receivedAt: { type: Date, required: true },
  },
  { versionKey: false },
);

function parse(buf) {
  const text = buf.toString('utf8');
  try {
    const json = JSON.parse(text);
    return { payload: json, payloadText: null };
  } catch {
    return { payload: null, payloadText: text.slice(0, 10_000) };
  }
}

export function toArchiveDoc(topic, buf, packet, broker, now = new Date()) {
  const { payload, payloadText } = parse(buf);
  const pick = (k) => (payload && typeof payload[k] === 'string' ? payload[k] : undefined);
  return {
    topic,
    payload,
    payloadText,
    payloadBytes: buf.length,
    qos: packet?.qos ?? 0,
    retained: Boolean(packet?.retain),
    messageId: pick('messageId'),
    requestId: pick('requestId'),
    stationId: pick('stationId'),
    broker,
    receivedAt: now,
  };
}

export async function startArchiver({
  mqttHost,
  mqttPort = 1883,
  mqttUsername,
  mqttPassword,
  mongoUri,
  dbName = 'mosquitto',
  collection = 'messages',
  topic = 'evdt/v1/#',
  ttlDays = 7,
  logger = console,
}) {
  const broker = `${mqttHost}:${mqttPort}`;
  const stats = { stored: 0, duplicates: 0, failed: 0, startedAt: new Date().toISOString() };

  // 1. MongoDB first, so no message arrives before we can store it.
  const conn = mongoose.createConnection(mongoUri, { dbName, serverSelectionTimeoutMS: 8000 });
  await conn.asPromise();
  const schema = messageSchema.clone(); // fresh copy: the TTL depends on ttlDays
  schema.index({ receivedAt: 1 }, { name: 'ttl_receivedAt', expireAfterSeconds: Math.round(ttlDays * 86400) });
  schema.index({ topic: 1, receivedAt: -1 });
  // QoS 1 can deliver a message twice, and retained messages come again on
  // every reconnect. Same messageId + topic is stored once.
  schema.index(
    { topic: 1, messageId: 1 },
    { name: 'unique_topic_messageId', unique: true, partialFilterExpression: { messageId: { $type: 'string' } } },
  );
  const Message = conn.model('Message', schema, collection);
  await Message.syncIndexes();

  // 2. MQTT, subscribe only.
  const client = mqtt.connect(`mqtt://${broker}`, {
    clientId: `archiver-${randomUUID().slice(0, 8)}`,
    clean: true,
    username: mqttUsername,
    password: mqttPassword,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  });

  const ready = new Promise((resolve, reject) => {
    const onFirstError = (err) => reject(err);
    client.once('error', onFirstError);
    client.once('connect', () => {
      client.off('error', onFirstError);
      resolve();
    });
  });

  client.on('connect', () => {
    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) logger.error(`[archiver] subscribe to ${topic} failed: ${err.message}`);
      else logger.info(`[archiver] connected to ${broker}, archiving ${topic} -> ${dbName}.${collection} (kept ${ttlDays} days)`);
    });
  });
  client.on('error', (err) => logger.error(`[archiver] mqtt: ${err.message}`));
  client.on('close', () => logger.warn?.('[archiver] broker connection closed, retrying'));

  const pending = new Set();
  client.on('message', (t, buf, packet) => {
    const job = Message.create(toArchiveDoc(t, buf, packet, broker))
      .then(() => {
        stats.stored += 1;
      })
      .catch((err) => {
        if (err?.code === 11000) stats.duplicates += 1;
        else {
          stats.failed += 1;
          logger.error(`[archiver] could not store message on ${t}: ${err.message}`);
        }
      })
      .finally(() => pending.delete(job));
    pending.add(job);
  });

  try {
    await ready;
  } catch (err) {
    client.end(true);
    await conn.close();
    throw err;
  }

  return {
    stats,
    Message,
    async stop() {
      await client.endAsync(true).catch(() => {});
      await Promise.allSettled([...pending]);
      await conn.close();
    },
  };
}
