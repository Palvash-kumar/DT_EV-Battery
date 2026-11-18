import mongoose from 'mongoose';
import { statusEntry } from './statusEntry.js';

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'];

const alertSchema = new mongoose.Schema(
  {
    alertId: { type: String, required: true, unique: true },
    stationId: { type: String, default: null },
    severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
    type: { type: String, required: true },
    // Service that raised it, e.g. "mlworker" or "backend" (alert.schema.json).
    raisedBy: { type: String, required: true },
    affectedAsset: { type: String, default: null },
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    recommendedAction: { type: String, default: null },
    status: { type: String, enum: ALERT_STATUSES, default: 'open' },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    occurrences: { type: Number, default: 1 },
    lastMessageId: { type: String, default: null },
    statusHistory: { type: [statusEntry], default: [] },
    // An alert is a signal to look at something, not a diagnosed fault.
    isConfirmedFault: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'alerts' },
);

alertSchema.index({ status: 1, lastSeenAt: -1 });

export const Alert = mongoose.models.Alert || mongoose.model('Alert', alertSchema);
