/**
 * Instrument endpoints — the catalogue a holding points into.
 *
 * Readable by any authenticated user because an instrument is public reference data: a
 * scheme code, an ISIN and a name. What somebody *holds* of it is on `assets`, and that is
 * scoped.
 */

import { Router } from 'express';
import { createInstrumentSchema, instrumentQuerySchema } from '@networth/shared';
import type { AppContext } from '../context.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { denyNomineeWrites } from '../middleware/readonly.js';
import {
  findOrCreateInstrument,
  getInstrument,
  searchInstruments,
} from '../services/instrument.service.js';

export function instrumentsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx), denyNomineeWrites());

  router.get('/', (req, res) => {
    const query = instrumentQuerySchema.parse(req.query);
    res.json({ instruments: searchInstruments(ctx, query) });
  });

  /**
   * Find or create. A second household adding a fund this instance already knows gets the
   * existing row — and a `200` rather than a `201`, so the client can tell which happened.
   */
  router.post('/', (req, res) => {
    const auth = requireAuthContext(req);
    const body = createInstrumentSchema.parse(req.body);
    const { instrument, created } = findOrCreateInstrument(ctx, auth.userId, body, clientIp(req));
    res.status(created ? 201 : 200).json({ instrument, created });
  });

  router.get('/:id', (req, res) => {
    res.json({ instrument: getInstrument(ctx, pathParam(req, 'id')) });
  });

  return router;
}
