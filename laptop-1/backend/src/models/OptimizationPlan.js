import mongoose from 'mongoose';
import { statusEntry } from './statusEntry.js';

// Filled in Phase 11. The shape is fixed now so the dashboard and the
// optimiser agree on it. Plans are advice only: nothing here switches a charger.
const allocationSchema = new mongoose.Schema(
  {
    chargerId: String,
    requestId: String,
    assignedKw: { type: Number, min: 0 },
    predictedCompletionAt: Date,
    reason: String,
  },
  { _id: false },
);

const optimizationPlanSchema = new mongoose.Schema(
  {
    planId: { type: String, required: true, unique: true },
    stationId: { type: String, required: true },
    generatedAt: { type: Date, required: true },
    advisory: { type: Boolean, default: true, immutable: true },
    requiresHumanApproval: { type: Boolean, default: true, immutable: true },
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    stationLimitKw: Number,
    allocations: [allocationSchema],
    assumptions: [String],
    usesSimulatedInputs: { type: Boolean, default: true },
    inputSources: [String],
    statusHistory: { type: [statusEntry], default: [] },
  },
  { timestamps: true, collection: 'optimizationPlans' },
);

optimizationPlanSchema.index({ stationId: 1, generatedAt: -1 });

export const OptimizationPlan =
  mongoose.models.OptimizationPlan || mongoose.model('OptimizationPlan', optimizationPlanSchema);
