import mongoose from 'mongoose';
import { provenanceFields, SOURCES } from './provenance.js';

export const CHARGER_STATUSES = ['available', 'charging', 'fault', 'offline'];

const chargerSchema = new mongoose.Schema(
  {
    chargerId: { type: String, required: true, unique: true },
    stationId: { type: String, required: true },
    bay: { type: Number, required: true, min: 1 },
    chargerType: { type: String, enum: ['Level 1', 'Level 2', 'DC Fast Charger'], required: true },
    maxPowerKw: { type: Number, required: true, min: 0 },
    connector: { type: String, default: null },

    status: { type: String, enum: CHARGER_STATUSES, default: 'available' },
    // Who set the current status: 'manual' (operator/API) or 'simulation'
    // (a simulated session). Nothing in this project reads a real charger.
    statusSource: { type: String, enum: SOURCES, default: 'manual' },
    statusNote: { type: String, default: null },
    statusUpdatedAt: { type: Date, default: Date.now },

    currentSessionId: { type: String, default: null },
    currentRequestId: { type: String, default: null },
    lastRequestId: { type: String, default: null },

    ...provenanceFields('manual'),
  },
  { timestamps: true, collection: 'chargers' },
);

chargerSchema.index({ stationId: 1, bay: 1 }, { unique: true });

export const Charger = mongoose.models.Charger || mongoose.model('Charger', chargerSchema);
