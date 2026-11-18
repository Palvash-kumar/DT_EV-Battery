import { Router } from 'express';
import { z } from 'zod';
import { ENUMS, LIMITS, SCHEMA_VERSION } from '../contracts.js';
import { AGING_DOMAIN, DEFAULT_HEALTH_NOTES, LABELS, NOT_CLAIMED } from '../domain/labels.js';
import { modelCards } from '../domain/modelCards.js';
import {
  Alert,
  Battery,
  Charger,
  ChargingSession,
  HealthEstimate,
  OptimizationPlan,
  PredictionRequest,
  Station,
  TelemetryReading,
  Vehicle,
} from '../models/index.js';

// Small read-only endpoints the dashboard uses for forms, labels and provenance.
export function referenceRoutes({ config }) {
  const router = Router();

  // The request form is built from this, so it always matches the schema.
  router.get('/meta', (req, res) => {
    res.json({
      schemaVersion: SCHEMA_VERSION,
      stationId: config.stationId,
      enums: ENUMS,
      limits: LIMITS,
      requestTimeoutSec: config.requestTimeoutMs / 1000,
      simTimeScale: config.simTimeScale,
      sensor: { staleAfterSec: config.sensorStaleSec },
      labels: LABELS,
      models: modelCards(),
    });
  });

  router.get('/vehicles', async (req, res) => {
    res.json(await Vehicle.find({}, { _id: 0, __v: 0 }).sort({ label: 1 }).lean());
  });

  router.get('/battery-health', async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(200).default(20).parse(req.query.limit);
    const [estimates, batteries] = await Promise.all([
      HealthEstimate.find({}, { _id: 0, __v: 0 }).sort({ processedAt: -1 }).limit(limit).lean(),
      Battery.find({}, { _id: 0, __v: 0 }).lean(),
    ]);
    res.json({
      labels: { soh: LABELS.soh, rul: LABELS.rul },
      domain: AGING_DOMAIN,
      notes: DEFAULT_HEALTH_NOTES,
      notClaimed: NOT_CLAIMED,
      estimates,
      batteries,
    });
  });

  router.get('/optimization/plans', async (req, res) => {
    const items = await OptimizationPlan.find({ stationId: config.stationId }, { _id: 0, __v: 0 })
      .sort({ generatedAt: -1 })
      .limit(20)
      .lean();
    res.json({ advisoryOnly: true, items });
  });

  // How much of what is stored came from where. Powers the Data Provenance page.
  router.get('/provenance', async (req, res) => {
    const bySource = (Model) =>
      Model.aggregate([
        {
          $group: {
            _id: { source: '$source', quality: '$quality', isDemo: { $ifNull: ['$isDemo', false] } },
            count: { $sum: 1 },
          },
        },
      ]);
    const collections = {
      stations: Station,
      chargers: Charger,
      vehicles: Vehicle,
      batteries: Battery,
      chargingSessions: ChargingSession,
      telemetryReadings: TelemetryReading,
      healthEstimates: HealthEstimate,
    };
    const out = {};
    for (const [name, Model] of Object.entries(collections)) {
      out[name] = (await bySource(Model)).map((r) => ({ ...r._id, count: r.count }));
    }
    // Prediction results carry their source on the result itself.
    const [results, alerts, plans] = await Promise.all([
      PredictionRequest.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: { $ifNull: ['$result.source', 'ml_estimate'] }, count: { $sum: 1 } } },
      ]),
      Alert.countDocuments(),
      OptimizationPlan.countDocuments(),
    ]);
    out.predictionRequests = results.map((r) => ({ source: r._id, quality: 'unknown', isDemo: false, count: r.count }));
    out.alerts = [{ source: 'service', count: alerts }];
    out.optimizationPlans = [{ source: 'advisory', count: plans }];
    res.json({ generatedAt: new Date().toISOString(), collections: out });
  });

  return router;
}
