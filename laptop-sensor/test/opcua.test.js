// Starts the real OPC UA server and checks it with a real OPC UA client.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  AttributeIds,
  ClientMonitoredItem,
  ClientSubscription,
  DataChangeFilter,
  DataChangeTrigger,
  DataType,
  DeadbandType,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  TimestampsToReturn,
} from 'node-opcua';
import { MEASURES_TEXT, NAMESPACE_URI, NODE_IDS, qualityOf, SensorOpcUaServer } from '../src/opcuaServer.js';

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('quality text', () => {
  it('uncalibrated -> unknown, calibrated -> good, implausible ambient -> suspect', () => {
    assert.equal(qualityOf(31, 'uncalibrated'), 'unknown');
    assert.equal(qualityOf(31, 'calibrated'), 'good');
    assert.equal(qualityOf(70, 'calibrated'), 'suspect');
  });
});

describe('OPC UA server', () => {
  let server;
  let client;
  let session;
  let ns;
  const id = (key) => `ns=${ns};${NODE_IDS[key]}`;
  const read = (key) => session.read({ nodeId: id(key), attributeId: AttributeIds.Value });

  before(async () => {
    const port = await freePort();
    server = new SensorOpcUaServer({
      port,
      resourcePath: '/evdt',
      stationId: 'STATION-TEST',
      sensorId: 'LM35-A0-01',
      calibrationStatus: 'uncalibrated',
      staleAfterSec: 1,
      watchdogMs: 100,
    });
    await server.start();
    client = OPCUAClient.create({
      endpointMustExist: false,
      securityMode: MessageSecurityMode.None,
      securityPolicy: SecurityPolicy.None,
      connectionStrategy: { maxRetry: 2, initialDelay: 100 },
    });
    await client.connect(`opc.tcp://localhost:${port}/evdt`);
    session = await client.createSession(); // anonymous
    const namespaces = (await session.read({ nodeId: 'ns=0;i=2255', attributeId: AttributeIds.Value })).value.value;
    ns = namespaces.indexOf(NAMESPACE_URI);
    assert.ok(ns > 0, 'namespace urn:evdt:sensor is registered');
  });

  after(async () => {
    await session?.close();
    await client?.disconnect();
    await server?.stop();
  });

  it('serves identity and labels, and has no value before the first reading', async () => {
    assert.equal((await read('stationId')).value.value, 'STATION-TEST');
    assert.equal((await read('sensorId')).value.value, 'LM35-A0-01');
    assert.equal((await read('source')).value.value, 'sensor');
    assert.equal((await read('calibrationStatus')).value.value, 'uncalibrated');
    assert.equal((await read('measures')).value.value, MEASURES_TEXT);
    assert.equal((await read('sensorState')).value.value, 'none');
    assert.equal((await read('temperatureC')).statusCode.name, 'BadWaitingForInitialData');
  });

  it('a reading becomes a Good value with the arrival time as SourceTimestamp', async () => {
    const receivedAt = new Date(Date.now() - 1500);
    server.update({ temperatureC: 31.26, receivedAt });
    const dv = await session.read({ nodeId: id('temperatureC'), attributeId: AttributeIds.Value }, 0);
    assert.equal(dv.statusCode.name, 'Good');
    assert.equal(dv.value.value, 31.26);
    assert.equal(dv.value.dataType, DataType.Double);
    assert.equal(dv.sourceTimestamp.getTime(), receivedAt.getTime());
    assert.equal((await read('sensorState')).value.value, 'live');
    assert.equal((await read('quality')).value.value, 'unknown');
  });

  it('is read-only', async () => {
    const status = await session.write({
      nodeId: id('temperatureC'),
      attributeId: AttributeIds.Value,
      value: { value: { dataType: DataType.Double, value: 99 } },
    });
    assert.equal(status.name, 'BadNotWritable');
    assert.equal((await read('temperatureC')).value.value, 31.26);
  });

  it('a subscriber gets every update, even when the number repeats', async () => {
    const sub = ClientSubscription.create(session, {
      requestedPublishingInterval: 100,
      requestedMaxKeepAliveCount: 10,
      requestedLifetimeCount: 100,
      publishingEnabled: true,
    });
    const item = ClientMonitoredItem.create(
      sub,
      { nodeId: id('temperatureC'), attributeId: AttributeIds.Value },
      {
        samplingInterval: 0,
        queueSize: 10,
        discardOldest: true,
        filter: new DataChangeFilter({ trigger: DataChangeTrigger.StatusValueTimestamp, deadbandType: DeadbandType.None }),
      },
      TimestampsToReturn.Both,
    );
    const seen = [];
    item.on('changed', (dv) => seen.push(dv.sourceTimestamp.getTime()));
    await sleep(300);
    const t1 = new Date(Date.now() - 200);
    server.update({ temperatureC: 31.3, receivedAt: t1 });
    await sleep(300);
    const t2 = new Date();
    server.update({ temperatureC: 31.3, receivedAt: t2 });
    await sleep(300);
    await sub.terminate();
    assert.ok(seen.includes(t1.getTime()) && seen.includes(t2.getTime()), 'both updates delivered');
  });

  it('goes BadNoCommunication / offline when readings stop, and recovers', async () => {
    server.update({ temperatureC: 31.4, receivedAt: new Date() });
    await sleep(1500); // staleAfterSec = 1
    const dv = await read('temperatureC');
    assert.equal(dv.statusCode.name, 'BadNoCommunication');
    assert.equal((await read('sensorState')).value.value, 'offline');

    server.update({ temperatureC: 31.5, receivedAt: new Date() });
    const back = await read('temperatureC');
    assert.equal(back.statusCode.name, 'Good');
    assert.equal(back.value.value, 31.5);
    assert.equal((await read('sensorState')).value.value, 'live');
  });

  it('markOffline (USB port closed) is immediate', async () => {
    server.markOffline('USB serial port closed');
    assert.equal((await read('temperatureC')).statusCode.name, 'BadNoCommunication');
    assert.equal((await read('sensorState')).value.value, 'offline');
  });
});
