import { Router } from 'express';
import { z } from 'zod';

const stationIdParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid station id');
const chargerIdParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid charger id');
const statusBody = z.object({
  // 'charging' is not settable by hand; only a simulated session puts a bay in that state.
  status: z.enum(['available', 'fault', 'offline']),
  note: z.string().trim().max(200).optional(),
});

export function stationRoutes({ stations }) {
  const router = Router();

  // Everything the overview page and the 3D scene need in one call.
  router.get('/:stationId', async (req, res) => {
    res.json(await stations.view(stationIdParam.parse(req.params.stationId)));
  });

  router.get('/:stationId/chargers', async (req, res) => {
    const view = await stations.view(stationIdParam.parse(req.params.stationId));
    res.json(view.chargers);
  });

  router.patch('/:stationId/chargers/:chargerId', async (req, res) => {
    const stationId = stationIdParam.parse(req.params.stationId);
    const chargerId = chargerIdParam.parse(req.params.chargerId);
    res.json(await stations.setChargerStatus(stationId, chargerId, statusBody.parse(req.body)));
  });

  return router;
}
