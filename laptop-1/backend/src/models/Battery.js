import mongoose from 'mongoose';
import { provenanceFields } from './provenance.js';

const batterySchema = new mongoose.Schema(
  {
    batteryId: { type: String, required: true, unique: true },
    vehicleId: { type: String, default: null },
    // Kept as 'unknown' for the demo vehicles: we have no BMS or spec sheet,
    // and the SOH model only knows Li-ion 18650 LiCoO2 lab cells.
    chemistry: { type: String, default: 'unknown' },
    nominalCapacityKwh: { type: Number, default: null },
    notes: { type: String, default: null },
    latestEstimate: {
      type: new mongoose.Schema(
        { healthEstimateId: String, sohPct: Number, rulCycles: Number, estimatedAt: Date },
        { _id: false },
      ),
      default: null,
    },
    ...provenanceFields('manual'),
  },
  { timestamps: true, collection: 'batteries' },
);

export const Battery = mongoose.models.Battery || mongoose.model('Battery', batterySchema);
