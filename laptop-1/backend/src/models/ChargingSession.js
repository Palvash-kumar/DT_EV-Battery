import mongoose from 'mongoose';
import { provenanceFields } from './provenance.js';

// Two kinds of session live here, told apart by `source`:
//   historical_csv - the 1,320 rows of Data/ev_charging_patterns.csv
//   simulation     - sessions started from the dashboard; SOC and progress
//                    come from a clock, not from a car or a meter
const chargingSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    stationId: { type: String, default: null },
    chargerId: { type: String, default: null },
    requestId: { type: String, default: null },

    status: { type: String, enum: ['active', 'completed', 'stopped', 'historical'], default: 'historical' },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    vehicleModel: String,
    batteryCapacityKwh: Number,
    vehicleAgeYears: Number,
    chargerType: String,
    startSocPct: Number,
    endSocPct: Number,
    energyKwh: Number,
    durationHours: Number,
    chargingRateKw: Number,
    costUsd: Number,
    temperatureC: Number,
    distanceDrivenKm: Number,
    timeOfDay: String,
    dayOfWeek: String,
    userType: String,
    location: String,

    // Only for historical_csv rows: where they came from in the file.
    csv: {
      type: new mongoose.Schema({ row: Number, userId: String, stationRef: String }, { _id: false }),
      default: undefined,
    },

    // Only for simulated sessions.
    simulation: {
      type: new mongoose.Schema(
        {
          timeScale: Number,
          predictedDurationHours: Number,
          predictedEnergyKwh: Number,
          targetSocPct: Number,
          expectedEndAt: Date,
        },
        { _id: false },
      ),
      default: undefined,
    },

    ...provenanceFields('historical_csv'),
  },
  { timestamps: true, collection: 'chargingSessions' },
);

chargingSessionSchema.index({ source: 1, startedAt: -1 });
chargingSessionSchema.index({ stationId: 1, status: 1 });
chargingSessionSchema.index({ chargerType: 1 });

export const ChargingSession =
  mongoose.models.ChargingSession || mongoose.model('ChargingSession', chargingSessionSchema);
