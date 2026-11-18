import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { PredictionRequest, PREDICTION_STATUSES } from '../models/index.js';
import { toPublicPrediction } from '../services/predictionService.js';
import { chargingRequestBody, requestIdParam } from '../validators/chargingRequest.js';

const historyQuery = z.object({
  stationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  status: z.enum(PREDICTION_STATUSES).optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function predictionRoutes({ config, predictions }) {
  const router = Router();

  const createLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.predictionRateLimitPerMin,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many prediction requests, slow down.' } },
  });

  const respond = (res, view) => {
    const location = `/api/predictions/${view.requestId}`;
    if (view.status === 'pending') {
      return res.status(202).location(location).json({ ...view, links: { self: location } });
    }
    return res.status(200).location(location).json({ ...view, links: { self: location } });
  };

  // ?wait=true holds the HTTP request until the result arrives or the request
  // times out (handy for curl). Without it the API answers 202 straight away
  // and the browser follows the request over Socket.IO or by polling.
  router.post('/charging', createLimiter, async (req, res) => {
    const body = chargingRequestBody.parse(req.body);
    let view = await predictions.create(body);
    if (req.query.wait === 'true' && view.status === 'pending') {
      view =
        (await predictions.waitForOutcome(view.requestId, config.requestTimeoutMs + 500)) ||
        (await predictions.get(view.requestId));
    }
    respond(res, view);
  });

  // History list, newest first. `before` is the createdAt of the last item on
  // the previous page (keyset paging, so new requests don't shift pages).
  router.get('/', async (req, res) => {
    const q = historyQuery.parse(req.query);
    const filter = { stationId: q.stationId || config.stationId };
    if (q.status) filter.status = q.status;
    if (q.before) filter.createdAt = { $lt: q.before };
    const docs = await PredictionRequest.find(filter, { statusHistory: 0 }).sort({ createdAt: -1 }).limit(q.limit).lean();
    const items = docs.map(toPublicPrediction);
    res.json({ items, nextBefore: items.length === q.limit ? items.at(-1).createdAt : null });
  });

  router.get('/:requestId', async (req, res) => {
    const requestId = requestIdParam.parse(req.params.requestId);
    res.json(await predictions.get(requestId));
  });

  router.post('/:requestId/retry', createLimiter, async (req, res) => {
    const requestId = requestIdParam.parse(req.params.requestId);
    respond(res, await predictions.retry(requestId));
  });

  return router;
}
