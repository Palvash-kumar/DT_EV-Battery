import { Router } from 'express';
import { z } from 'zod';
import { AppError, notFound } from '../errors.js';
import { Alert } from '../models/index.js';
import { entry } from '../models/statusEntry.js';

const NEXT = { open: ['acknowledged', 'resolved'], acknowledged: ['resolved'], resolved: [] };

const listQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const patchBody = z.object({
  status: z.enum(['acknowledged', 'resolved']),
  note: z.string().trim().max(300).optional(),
  by: z.string().trim().min(1).max(60).default('operator'),
});

export function alertRoutes({ events }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = q.status ? { status: q.status } : {};
    const items = await Alert.find(filter, { _id: 0, __v: 0 }).sort({ lastSeenAt: -1 }).limit(q.limit).lean();
    res.json({ items });
  });

  router.patch('/:alertId', async (req, res) => {
    const body = patchBody.parse(req.body);
    const current = await Alert.findOne({ alertId: req.params.alertId }).lean();
    if (!current) throw notFound('Alert');
    if (!NEXT[current.status].includes(body.status)) {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot go from ${current.status} to ${body.status}`);
    }
    const doc = await Alert.findOneAndUpdate(
      { alertId: current.alertId, status: current.status },
      { $set: { status: body.status }, $push: { statusHistory: entry(body.status, { by: body.by, note: body.note || null }) } },
      { new: true, projection: { _id: 0, __v: 0 } },
    ).lean();
    if (!doc) throw new AppError(409, 'INVALID_TRANSITION', 'Alert changed meanwhile, reload it');
    events.emit('alert', doc);
    res.json(doc);
  });

  return router;
}
