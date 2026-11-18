import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Aedes } from 'aedes';
import mongoose from 'mongoose';
import mqtt from 'mqtt';
import { startArchiver, toArchiveDoc } from '../src/services/mqttArchiver.js';
import { mongoAvailable, TEST_MONGO, waitFor } from './helpers.js';

const hasMongo = await mongoAvailable();
const silent = { info() {}, warn() {}, error() {} };

describe('toArchiveDoc', () => {
  it('keeps JSON as an object and pulls out the ids', () => {
    const d = toArchiveDoc('evdt/v1/results/charging', Buffer.from('{"messageId":"m1","requestId":"r1","stationId":"S"}'), { qos: 1, retain: false }, 'h:1883');
    assert.deepEqual(d.payload, { messageId: 'm1', requestId: 'r1', stationId: 'S' });
    assert.equal(d.payloadText, null);
    assert.equal(d.messageId, 'm1');
    assert.equal(d.requestId, 'r1');
    assert.equal(d.retained, false);
  });

  it('keeps non-JSON payloads as text', () => {
    const d = toArchiveDoc('t', Buffer.from('not json'), { qos: 0 }, 'h:1883');
    assert.equal(d.payload, null);
    assert.equal(d.payloadText, 'not json');
    assert.equal(d.messageId, undefined);
  });
});

describe('MQTT archiver', { skip: !hasMongo && 'no MongoDB reachable' }, () => {
  let broker;
  let server;
  let port;
  let archiver;
  let pub;
  const archiverPublishes = [];
  const dbName = `mosquitto_test_${randomUUID().slice(0, 8)}`;
  const sockets = new Set();

  before(async () => {
    broker = await Aedes.createBroker();
    // reject one specific bad login, like Mosquitto's password file would
    broker.authenticate = (client, username, password, cb) => {
      if (username === 'wrong') {
        const err = new Error('Not authorized');
        err.returnCode = 5;
        return cb(err, false);
      }
      cb(null, true);
    };
    broker.on('publish', (packet, client) => {
      if (client?.id?.startsWith('archiver-')) archiverPublishes.push(packet.topic);
    });
    server = createServer(broker.handle);
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    pub = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'test-pub' });
    await new Promise((r) => pub.once('connect', r));

    // A retained message that exists BEFORE the archiver starts, like the
    // station status sitting in mosquitto.db on Laptop 2.
    await pub.publishAsync(
      'evdt/v1/stations/STATION-001/status',
      JSON.stringify({ schemaVersion: '1.0', messageId: 'status-001', stationId: 'STATION-001', status: 'online' }),
      { qos: 1, retain: true },
    );

    archiver = await startArchiver({
      mqttHost: '127.0.0.1',
      mqttPort: port,
      mqttUsername: 'admin',
      mqttPassword: 'x',
      mongoUri: `${TEST_MONGO}/evdt_test_should_not_be_used`,
      dbName,
      ttlDays: 7,
      logger: silent,
    });
  });

  after(async () => {
    await archiver?.Message.db.dropDatabase().catch(() => {});
    await archiver?.stop();
    await pub?.endAsync();
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(() => r()));
    await new Promise((r) => broker.close(() => r()));
  });

  it('stores retained messages that were on the broker before it started', async () => {
    await waitFor(async () => (await archiver.Message.countDocuments({ messageId: 'status-001' })) === 1, 3000, 'retained replay');
    const d = await archiver.Message.findOne({ messageId: 'status-001' }).lean();
    assert.equal(d.retained, true);
    assert.equal(d.topic, 'evdt/v1/stations/STATION-001/status');
    assert.equal(d.payload.status, 'online');
  });

  it('stores live messages with topic, ids and payload', async () => {
    const requestId = randomUUID();
    const messageId = randomUUID();
    await pub.publishAsync('evdt/v1/requests/charging', JSON.stringify({ messageId, requestId, stationId: 'STATION-001' }), { qos: 1 });
    await waitFor(async () => (await archiver.Message.countDocuments({ messageId })) === 1, 3000, 'live message');
    const d = await archiver.Message.findOne({ messageId }).lean();
    assert.equal(d.requestId, requestId);
    assert.equal(d.retained, false);
    assert.equal(d.qos, 1);
  });

  it('stores a QoS 1 duplicate only once', async () => {
    const messageId = randomUUID();
    const body = JSON.stringify({ messageId, requestId: randomUUID() });
    const before = archiver.stats.duplicates;
    await pub.publishAsync('evdt/v1/results/charging', body, { qos: 1 });
    await pub.publishAsync('evdt/v1/results/charging', body, { qos: 1 });
    await waitFor(() => archiver.stats.duplicates > before, 3000, 'duplicate counted');
    assert.equal(await archiver.Message.countDocuments({ messageId }), 1);
  });

  it('keeps payloads that are not JSON (e.g. a corrupt message)', async () => {
    await pub.publishAsync('evdt/v1/alerts', 'garbage{', { qos: 1 });
    await waitFor(async () => (await archiver.Message.countDocuments({ payloadText: 'garbage{' })) === 1, 3000, 'raw text');
  });

  it('never publishes anything to the broker', () => {
    assert.deepEqual(archiverPublishes, []);
  });

  it('writes to its own database only', async () => {
    assert.equal(archiver.Message.db.name, dbName);
    const evdt = mongoose.createConnection(`${TEST_MONGO}/evdt_test_should_not_be_used`);
    await evdt.asPromise();
    const names = (await evdt.db.listCollections().toArray()).map((c) => c.name);
    await evdt.close();
    assert.deepEqual(names, []);
  });

  it('has a TTL index and a unique index on topic + messageId', async () => {
    const idx = await archiver.Message.collection.indexes();
    const ttl = idx.find((i) => i.name === 'ttl_receivedAt');
    assert.equal(ttl.expireAfterSeconds, 7 * 86400);
    const uniq = idx.find((i) => i.name === 'unique_topic_messageId');
    assert.equal(uniq.unique, true);
  });

  it('refuses to start with a login the broker rejects', async () => {
    await assert.rejects(
      startArchiver({
        mqttHost: '127.0.0.1',
        mqttPort: port,
        mqttUsername: 'wrong',
        mqttPassword: 'x',
        mongoUri: `${TEST_MONGO}/x`,
        dbName: `${dbName}_bad`,
        logger: silent,
      }),
      /Not authorized/i,
    );
  });
});
