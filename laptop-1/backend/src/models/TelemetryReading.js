import mongoose from 'mongoose';
import { provenanceFields } from './provenance.js';

const SIM_TTL_DAYS = Number(process.env.TELEMETRY_SIM_TTL_DAYS || 7);

const telemetryReadingSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true, unique: true },
    stationId: { type: String, required: true },
    sensorId: { type: String, default: null },
    timestamp: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
    temperatureC: { type: Number, required: true },
    units: { type: String, default: '°C' },
    // The Arduino sits in the charger area. It never measures cell temperature.
    measures: { type: String, enum: ['ambient'], default: 'ambient' },
    calibrationStatus: { type: String, enum: ['calibrated', 'uncalibrated', 'unknown'], default: 'unknown' },
    ...provenanceFields('sensor'),
  },
  { collection: 'telemetryReadings' },
);

telemetryReadingSchema.index({ stationId: 1, timestamp: -1 });
// Simulated readings are throw-away and expire; real sensor readings are kept.
telemetryReadingSchema.index(
  { receivedAt: 1 },
  {
    name: 'sim_readings_ttl',
    expireAfterSeconds: SIM_TTL_DAYS * 24 * 3600,
    partialFilterExpression: { source: 'simulation' },
  },
);

export const TelemetryReading =
  mongoose.models.TelemetryReading || mongoose.model('TelemetryReading', telemetryReadingSchema);
