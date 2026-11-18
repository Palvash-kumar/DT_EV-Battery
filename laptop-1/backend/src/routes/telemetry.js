import { Router } from 'express';
import { z } from 'zod';
import { TelemetryReading } from '../models/index.js';

const query = z.object({
  stationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  source: z.enum(['sensor', 'simulation']).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

export function telemetryRoutes({ config, stations }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const q = query.parse(req.query);
    const filter = { stationId: q.stationId || config.stationId };
    if (q.source) filter.source = q.source;
    if (q.since) filter.timestamp = { $gte: q.since };
    const rows = await TelemetryReading.find(filter).sort({ timestamp: -1 }).limit(q.limit).lean();
    res.json({ items: rows.reverse().map((r) => stations.readingView(r)) });
  });

  router.get('/latest', async (req, res) => {
    const q = query.parse(req.query);
    const latest = await TelemetryReading.findOne({ stationId: q.stationId || config.stationId })
      .sort({ timestamp: -1 })
      .lean();
    res.json(latest ? stations.readingView(latest) : null);
  });

  return router;
}
