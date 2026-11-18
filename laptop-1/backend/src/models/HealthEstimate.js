import mongoose from 'mongoose';
import { LABELS } from '../domain/labels.js';
import { provenanceFields } from './provenance.js';

// One document per SOH/RUL result from evdt/v1/results/health. Kept out of
// the batteries collection so the history can grow without huge documents.
const healthEstimateSchema = new mongoose.Schema(
  {
    healthEstimateId: { type: String, required: true, unique: true }, // = result messageId
    requestId: { type: String, required: true, index: true },
    batteryId: { type: String, default: null },
    status: { type: String, enum: ['completed', 'error'], required: true },
    sohPct: { type: Number, default: null },
    capacityLossAh: { type: Number, default: null },
    rulCycles: { type: Number, default: null },
    eolThresholdSohPct: { type: Number, default: null },
    eolThresholdIsAssumption: { type: Boolean, default: true },
    units: {
      sohPct: { type: String, default: '%' },
      capacityLossAh: { type: String, default: 'Ah' },
      rulCycles: { type: String, default: 'cycles' },
    },
    sohLabel: { type: String, default: LABELS.soh },
    rulLabel: { type: String, default: LABELS.rul },
    model: { sohVersion: String, rulVersion: String },
    warnings: [String],
    applicabilityNotes: [String],
    processedAt: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
    ...provenanceFields('ml_estimate'),
  },
  { timestamps: true, collection: 'healthEstimates' },
);

healthEstimateSchema.index({ processedAt: -1 });

export const HealthEstimate =
  mongoose.models.HealthEstimate || mongoose.model('HealthEstimate', healthEstimateSchema);
