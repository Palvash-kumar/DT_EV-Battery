import mongoose from 'mongoose';
import { provenanceFields } from './provenance.js';

// Demo vehicles used to pre-fill the request form. They are profiles, not
// connected cars: nothing is read from a vehicle or its BMS.
const vehicleSchema = new mongoose.Schema(
  {
    vehicleId: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    model: { type: String, required: true },
    batteryCapacityKwh: { type: Number, required: true, min: 0 },
    vehicleAgeYears: { type: Number, required: true, min: 0 },
    batteryId: { type: String, default: null },
    ...provenanceFields('manual'),
  },
  { timestamps: true, collection: 'vehicles' },
);

export const Vehicle = mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);
