import mongoose from 'mongoose';
import { statusEntry } from './statusEntry.js';

const { Schema } = mongoose;

export const PREDICTION_STATUSES = ['pending', 'completed', 'failed', 'timed_out'];
const LOCKED_PATHS = ['requestId', 'input', 'sensorReading', 'stationId', 'createdAt'];

const inputSchema = new Schema(
  {
    vehicle: {
      model: { type: String, required: true },
      batteryCapacityKwh: { type: Number, required: true },
      vehicleAgeYears: { type: Number, required: true },
    },
    charging: {
      startSocPct: { type: Number, required: true },
      targetSocPct: { type: Number, required: true },
      chargerType: { type: String, required: true },
      requestedRateKw: { type: Number, required: true },
    },
    environment: {
      temperatureC: { type: Number, required: true },
      // Where the temperature in the request came from: sensor | simulation | manual
      source: { type: String, required: true },
    },
  },
  { _id: false },
);

const resultSchema = new Schema(
  {
    predictions: {
      durationHours: Number,
      energyKwh: Number,
      costUsd: Number,
      estimatedSohPct: Number,
      batteryWearPct: Number,
      wearFactor: Number,
    },
    units: {
      durationHours: { type: String, default: 'h' },
      energyKwh: { type: String, default: 'kWh' },
      costUsd: { type: String, default: 'USD' },
      estimatedSohPct: { type: String, default: '%' },
      batteryWearPct: { type: String, default: 'SOH percentage points' },
    },
    // Set from the duration model version: "physics-*" (DC fast charging) →
    // physics_estimate, "dev-stub*" → simulation, anything else → ml_estimate.
    source: { type: String, enum: ['ml_estimate', 'physics_estimate', 'simulation'], default: 'ml_estimate' },
    model: { durationVersion: String, energyVersion: String, costVersion: String, wearVersion: String },
    warnings: [String],
    processedAt: Date,
    receivedAt: Date,
    resultMessageId: String,
    lateResult: { type: Boolean, default: false },
  },
  { _id: false },
);

const predictionRequestSchema = new Schema(
  {
    requestId: { type: String, required: true, unique: true, immutable: true },
    stationId: { type: String, required: true, immutable: true },
    chargerId: { type: String, default: null },
    input: { type: inputSchema, required: true, immutable: true },
    // When input.environment.source is "sensor": the exact Arduino reading
    // whose temperature was used, so the request can be traced to it.
    sensorReading: {
      type: new Schema(
        {
          messageId: String,
          sensorId: String,
          timestamp: Date,
          temperatureC: Number,
          quality: String,
          calibrationStatus: String,
        },
        { _id: false },
      ),
      default: null,
      immutable: true,
    },

    status: { type: String, enum: PREDICTION_STATUSES, default: 'pending' },
    statusHistory: { type: [statusEntry], default: [] },
    attempts: { type: Number, default: 1 },
    messageIds: [{ type: String }],
    sentAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    timedOutAt: { type: Date, default: null },

    result: { type: resultSchema, default: null },
    error: {
      type: new Schema({ code: String, message: String }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true, collection: 'predictionRequests' },
);

predictionRequestSchema.index({ stationId: 1, createdAt: -1 });
predictionRequestSchema.index({ status: 1, createdAt: -1 });

// Mongoose quietly drops writes to `immutable` paths in update queries. For an
// audit record I'd rather fail loudly, so any update touching the original
// input or ids throws.
function rejectLockedPaths() {
  const update = this.getUpdate() || {};
  const touched = new Set();
  for (const [key, value] of Object.entries(update)) {
    // $setOnInsert only applies when a new document is created, so it can't
    // change an existing record. (Mongoose's timestamps add one on every update.)
    if (key === '$setOnInsert') continue;
    if (key.startsWith('$') && value && typeof value === 'object') {
      Object.keys(value).forEach((p) => touched.add(p.split('.')[0]));
    } else {
      touched.add(key.split('.')[0]);
    }
  }
  const hit = LOCKED_PATHS.filter((p) => touched.has(p));
  if (hit.length) {
    throw new Error(`predictionRequests is audit data; cannot modify ${hit.join(', ')}`);
  }
}
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
  predictionRequestSchema.pre(op, rejectLockedPaths);
}

export const PredictionRequest =
  mongoose.models.PredictionRequest || mongoose.model('PredictionRequest', predictionRequestSchema);
