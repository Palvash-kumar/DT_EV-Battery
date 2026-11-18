import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { ChargingSession } from '../models/index.js';

const listQuery = z.object({
  source: z.enum(['historical_csv', 'simulation']).optional(),
  chargerType: z.string().max(40).optional(),
  vehicleModel: z.string().max(40).optional(),
  status: z.enum(['active', 'completed', 'stopped', 'historical']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
});

const startBody = z.object({
  requestId: z.string().uuid(),
  chargerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

export function sessionRoutes({ stations }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = {};
    for (const k of ['source', 'chargerType', 'vehicleModel', 'status']) if (q[k]) filter[k] = q[k];
    const [items, total] = await Promise.all([
      ChargingSession.find(filter, { _id: 0, __v: 0 })
        .sort({ startedAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      ChargingSession.countDocuments(filter),
    ]);
    res.json({ total, page: q.page, limit: q.limit, items: items.map((s) => stations.sessionView(s)) });
  });

  // Aggregates over the historical CSV for the dashboard charts.
  router.get('/summary', async (req, res) => {
    const historical = { source: 'historical_csv' };
    const group = (key) => [
      { $match: historical },
      {
        $group: {
          _id: key,
          sessions: { $sum: 1 },
          avgEnergyKwh: { $avg: '$energyKwh' },
          avgDurationHours: { $avg: '$durationHours' },
          avgRateKw: { $avg: '$chargingRateKw' },
        },
      },
      { $sort: { _id: 1 } },
    ];
    const [byChargerType, byVehicleModel, byHour, quality, simulated] = await Promise.all([
      ChargingSession.aggregate(group('$chargerType')),
      ChargingSession.aggregate(group('$vehicleModel')),
      ChargingSession.aggregate([
        { $match: historical },
        { $group: { _id: { $hour: '$startedAt' }, sessions: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      ChargingSession.aggregate([{ $match: historical }, { $group: { _id: '$quality', count: { $sum: 1 } } }]),
      ChargingSession.countDocuments({ source: 'simulation' }),
    ]);
    const round = (rows) =>
      rows.map((r) => ({
        key: r._id,
        sessions: r.sessions,
        ...(r.avgEnergyKwh !== undefined && {
          avgEnergyKwh: +r.avgEnergyKwh?.toFixed(2),
          avgDurationHours: +r.avgDurationHours?.toFixed(2),
          avgRateKw: +r.avgRateKw?.toFixed(2),
        }),
      }));
    res.json({
      source: 'historical_csv',
      totalSessions: quality.reduce((n, q) => n + q.count, 0),
      quality: Object.fromEntries(quality.map((q) => [q._id, q.count])),
      byChargerType: round(byChargerType),
      byVehicleModel: round(byVehicleModel),
      byHourUtc: byHour.map((h) => ({ hour: h._id, sessions: h.sessions })),
      simulatedSessions: simulated,
    });
  });

  router.get('/:sessionId', async (req, res) => {
    const session = await ChargingSession.findOne({ sessionId: req.params.sessionId }, { _id: 0, __v: 0 }).lean();
    if (!session) throw notFound('Session');
    res.json(stations.sessionView(session));
  });

  router.post('/simulated', async (req, res) => {
    res.status(201).json(await stations.startSimulated(startBody.parse(req.body)));
  });

  router.post('/:sessionId/stop', async (req, res) => {
    res.json(await stations.stopSession(z.string().uuid().parse(req.params.sessionId)));
  });

  return router;
}
