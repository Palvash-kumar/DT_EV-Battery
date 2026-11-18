import mongoose from 'mongoose';

// One line of an audit trail: what the status became, when, and why.
export const statusEntry = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, required: true, default: Date.now },
    by: { type: String, default: 'backend' },
    note: { type: String, default: null },
    messageId: { type: String, default: null },
  },
  { _id: false },
);

export const entry = (status, extra = {}) => ({ status, at: new Date(), by: 'backend', ...extra });
