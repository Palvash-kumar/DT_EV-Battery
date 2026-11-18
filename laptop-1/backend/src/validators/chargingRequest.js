import { z } from 'zod';
import { ENUMS, LIMITS } from '../contracts.js';

// Body accepted by POST /api/predictions/charging. The MQTT envelope fields
// (messageId, requestId, sentAt, schemaVersion) are added by the server, never
// trusted from the browser.
export const chargingRequestBody = z
  .object({
    stationId: z.string().trim().min(1).max(64).optional(),
    chargerId: z.string().trim().min(1).max(64).optional(),
    vehicle: z.object({
      model: z.enum(ENUMS.vehicleModels),
      batteryCapacityKwh: z.number().positive().max(LIMITS.batteryCapacityKwhMax),
      vehicleAgeYears: z.number().min(0).max(LIMITS.vehicleAgeYearsMax),
    }),
    charging: z.object({
      startSocPct: z.number().min(0).max(100),
      targetSocPct: z.number().min(0).max(100),
      chargerType: z.enum(ENUMS.chargerTypes),
      requestedRateKw: z.number().positive().max(LIMITS.requestedRateKwMax),
    }),
    environment: z.object({
      temperatureC: z.number().min(LIMITS.temperatureCMin).max(LIMITS.temperatureCMax),
      source: z.enum(ENUMS.temperatureSources),
    }),
  })
  .refine((b) => b.charging.targetSocPct > b.charging.startSocPct, {
    message: 'targetSocPct must be greater than startSocPct',
    path: ['charging', 'targetSocPct'],
  });

export const requestIdParam = z.string().uuid();
