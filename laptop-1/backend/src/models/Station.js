import mongoose from 'mongoose';
import { provenanceFields } from './provenance.js';

const stationSchema = new mongoose.Schema(
  {
    stationId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    city: { type: String, default: null },
    // Grid connection limit for the whole site. Used by the optimiser (Phase 11).
    maxPowerKw: { type: Number, min: 0, default: null },
    status: {
      type: String,
      enum: ['online', 'offline', 'maintenance', 'fault'],
      default: 'online',
    },
    ...provenanceFields('manual'),
  },
  { timestamps: true, collection: 'stations' },
);

export const Station = mongoose.models.Station || mongoose.model('Station', stationSchema);
