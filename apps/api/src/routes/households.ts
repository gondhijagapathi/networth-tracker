/**
 * Household management: create, invite a partner, accept, share, leave.
 *
 * Every handler here acts on the household as its own member — there is no `resolveScope`
 * in this file, because a grant a household produces lets somebody read a household*'s data*
 * through `/analytics` and `/assets`; it does not let them administer the household itself.
 */

import { Router } from 'express';
import {
  createHouseholdSchema,
  invitePartnerSchema,
  updateShareModeSchema,
} from '@networth/shared';
import type { AppContext } from '../context.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { denyNomineeWrites } from '../middleware/readonly.js';
import {
  acceptHousehold,
  createHousehold,
  getHousehold,
  invitePartner,
  leaveHousehold,
  listHouseholds,
  updateShareMode,
} from '../services/household.service.js';

export function householdsRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx), denyNomineeWrites());

  router.get('/', (req, res) => {
    res.json({ households: listHouseholds(ctx, requireAuthContext(req).userId) });
  });

  router.post('/', (req, res) => {
    const auth = requireAuthContext(req);
    const body = createHouseholdSchema.parse(req.body);
    res.status(201).json({ household: createHousehold(ctx, auth.userId, body, clientIp(req)) });
  });

  router.get('/:id', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ household: getHousehold(ctx, auth.userId, pathParam(req, 'id')) });
  });

  router.post('/:id/invite', (req, res) => {
    const auth = requireAuthContext(req);
    const body = invitePartnerSchema.parse(req.body);
    res.status(201).json({
      member: invitePartner(ctx, auth.userId, pathParam(req, 'id'), body, clientIp(req)),
    });
  });

  router.post('/:id/accept', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({
      member: acceptHousehold(ctx, auth.userId, pathParam(req, 'id'), clientIp(req)),
    });
  });

  /** The Settings toggle: how much of the caller's own data the household sees. */
  router.patch('/:id/share', (req, res) => {
    const auth = requireAuthContext(req);
    const body = updateShareModeSchema.parse(req.body);
    res.json({
      member: updateShareMode(ctx, auth.userId, pathParam(req, 'id'), body, clientIp(req)),
    });
  });

  /** Leave (own id) or remove (owner acting on somebody else). Grants close immediately. */
  router.delete('/:id/members/:userId', (req, res) => {
    const auth = requireAuthContext(req);
    leaveHousehold(ctx, auth.userId, pathParam(req, 'id'), pathParam(req, 'userId'), clientIp(req));
    res.status(204).end();
  });

  return router;
}
