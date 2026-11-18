// OPC UA server for the Arduino ambient temperature (sensor laptop).
//
// Address space (namespace urn:evdt:sensor):
//   Objects/EVChargingStation                    s=Station
//     StationId                                  s=Station.StationId
//     AmbientSensor                              s=AmbientSensor
//       TemperatureC   Double, °C (AnalogItem)   s=AmbientSensor.TemperatureC
//       SensorId / Source / Quality / CalibrationStatus / Measures / SensorState
//
// Rules (same as the rest of the project):
// - TemperatureC's SourceTimestamp is the time the reading arrived from the Arduino.
// - Before the first reading its status is BadWaitingForInitialData.
// - No reading for staleAfterSec (or the USB port closed) -> BadNoCommunication
//   and SensorState "offline". The old number is never shown as Good and is
//   never replaced by a simulated one.
// - Everything is read-only. Security: none / anonymous (LAN demo decision,
//   see OPC-UA_implementation-plan.md section 5.5).
import {
  DataType,
  MessageSecurityMode,
  OPCUAServer,
  SecurityPolicy,
  StatusCodes,
  standardUnits,
} from 'node-opcua';
import { SCHEMA_MAX_C, SCHEMA_MIN_C } from './serial.js';

export const NAMESPACE_URI = 'urn:evdt:sensor';
export const NODE_IDS = {
  station: 's=Station',
  stationId: 's=Station.StationId',
  sensor: 's=AmbientSensor',
  temperatureC: 's=AmbientSensor.TemperatureC',
  sensorId: 's=AmbientSensor.SensorId',
  source: 's=AmbientSensor.Source',
  quality: 's=AmbientSensor.Quality',
  calibrationStatus: 's=AmbientSensor.CalibrationStatus',
  measures: 's=AmbientSensor.Measures',
  sensorState: 's=AmbientSensor.SensorState',
};
export const MEASURES_TEXT = 'Ambient / charger-area air temperature (not battery temperature)';

// Narrower than the schema: air around a charger outside this is implausible.
// Such a reading is still served (Good status) but its Quality says "suspect";
// the backend makes the final quality decision when it stores the reading.
const AMBIENT_MIN_C = -30;
const AMBIENT_MAX_C = 55;

export function qualityOf(temperatureC, calibrationStatus) {
  if (temperatureC < AMBIENT_MIN_C || temperatureC > AMBIENT_MAX_C) return 'suspect';
  return calibrationStatus === 'calibrated' ? 'good' : 'unknown';
}

const readOnly = { accessLevel: 'CurrentRead', userAccessLevel: 'CurrentRead' };

export class SensorOpcUaServer {
  constructor({
    port = 4840,
    resourcePath = '/evdt',
    hostname,
    alternateHostname,
    stationId,
    sensorId,
    calibrationStatus = 'uncalibrated',
    staleAfterSec = 30,
    watchdogMs = 1000,
    logger = () => {},
  }) {
    Object.assign(this, { port, resourcePath, hostname, alternateHostname, stationId, sensorId, calibrationStatus, staleAfterSec, watchdogMs, logger });
    this.server = null;
    this.nodes = {};
    this.state = 'none';
    this.lastReadingAt = null;
    this.lastValue = null;
    this.watchdog = null;
  }

  get endpointUrl() {
    return this.server?.getEndpointUrl();
  }

  async start() {
    this.server = new OPCUAServer({
      port: this.port,
      resourcePath: this.resourcePath,
      ...(this.hostname ? { hostname: this.hostname } : {}),
      ...(this.alternateHostname?.length ? { alternateHostname: this.alternateHostname } : {}),
      securityPolicies: [SecurityPolicy.None],
      securityModes: [MessageSecurityMode.None],
      allowAnonymous: true,
      buildInfo: {
        productName: 'EVDT Arduino ambient temperature',
        manufacturerName: 'EV Charging Station Digital Twin',
        softwareVersion: '1.0.0',
        buildNumber: '1',
        buildDate: new Date(),
      },
    });
    await this.server.initialize();
    this.buildAddressSpace();
    await this.server.start();
    this.watchdog = setInterval(() => this.checkStale(), this.watchdogMs);
    this.watchdog.unref?.();
  }

  buildAddressSpace() {
    const addressSpace = this.server.engine.addressSpace;
    const ns = addressSpace.registerNamespace(NAMESPACE_URI);
    const str = (parent, name, nodeId, value) => {
      const v = ns.addVariable({ componentOf: parent, browseName: name, nodeId, dataType: 'String', minimumSamplingInterval: 0, ...readOnly });
      v.setValueFromSource({ dataType: DataType.String, value });
      return v;
    };

    const station = ns.addObject({ organizedBy: addressSpace.rootFolder.objects, browseName: 'EVChargingStation', nodeId: NODE_IDS.station });
    this.nodes.stationId = str(station, 'StationId', NODE_IDS.stationId, this.stationId);
    const sensor = ns.addObject({ componentOf: station, browseName: 'AmbientSensor', nodeId: NODE_IDS.sensor });

    this.nodes.temperatureC = ns.addAnalogDataItem({
      componentOf: sensor,
      browseName: 'TemperatureC',
      nodeId: NODE_IDS.temperatureC,
      dataType: 'Double',
      engineeringUnits: standardUnits.degree_celsius,
      engineeringUnitsRange: { low: SCHEMA_MIN_C, high: SCHEMA_MAX_C },
      minimumSamplingInterval: 0,
      description: MEASURES_TEXT,
      ...readOnly,
    });
    this.nodes.temperatureC.setValueFromSource({ dataType: DataType.Double, value: 0 }, StatusCodes.BadWaitingForInitialData);

    this.nodes.sensorId = str(sensor, 'SensorId', NODE_IDS.sensorId, this.sensorId);
    // Only real Arduino readings are ever served here; the simulator uses MQTT directly.
    this.nodes.source = str(sensor, 'Source', NODE_IDS.source, 'sensor');
    this.nodes.quality = str(sensor, 'Quality', NODE_IDS.quality, 'unknown');
    this.nodes.calibrationStatus = str(sensor, 'CalibrationStatus', NODE_IDS.calibrationStatus, this.calibrationStatus);
    this.nodes.measures = str(sensor, 'Measures', NODE_IDS.measures, MEASURES_TEXT);
    this.nodes.sensorState = str(sensor, 'SensorState', NODE_IDS.sensorState, 'none');
  }

  setString(node, value) {
    node.setValueFromSource({ dataType: DataType.String, value });
  }

  // A valid reading from the Arduino: { temperatureC, receivedAt }.
  update({ temperatureC, receivedAt }) {
    if (!this.server) return;
    this.lastReadingAt = receivedAt.getTime();
    this.lastValue = temperatureC;
    this.nodes.temperatureC.setValueFromSource({ dataType: DataType.Double, value: temperatureC }, StatusCodes.Good, receivedAt);
    this.setString(this.nodes.quality, qualityOf(temperatureC, this.calibrationStatus));
    if (this.state !== 'live') {
      this.logger(`sensor live (${temperatureC} °C)`);
      this.state = 'live';
      this.setString(this.nodes.sensorState, 'live');
    }
  }

  markOffline(reason) {
    if (!this.server || this.state === 'offline') return;
    const value = this.lastValue ?? 0;
    this.nodes.temperatureC.setValueFromSource({ dataType: DataType.Double, value }, StatusCodes.BadNoCommunication, new Date());
    this.state = 'offline';
    this.setString(this.nodes.sensorState, 'offline');
    this.logger(`sensor OFFLINE: ${reason} - TemperatureC status is now BadNoCommunication`);
  }

  checkStale(now = Date.now()) {
    if (this.state === 'live' && now - this.lastReadingAt > this.staleAfterSec * 1000) {
      this.markOffline(`no valid reading for ${Math.round((now - this.lastReadingAt) / 1000)} s`);
    }
  }

  async stop() {
    clearInterval(this.watchdog);
    const server = this.server;
    this.server = null;
    if (server) await server.shutdown(0);
  }
}
