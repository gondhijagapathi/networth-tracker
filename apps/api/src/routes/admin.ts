/**
 * Administration endpoints.
 *
 * Every route here is gated on the `admin` role. Note what is absent: nothing in this
 * router reads or writes another user's financial data. Admin is an operational role —
 * who may sign in — not a privileged view of the household's assets.
 */

import { Router } from 'express';
import { createInviteSchema, updateUserSchema } from '@networth/shared';
import type { AppContext } from '../context.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext, requireRole } from '../middleware/auth.js';
import { createInvite, listInvites, revokeInvite } from '../services/invite.service.js';
import { listUsers, revokeUserSessions, updateUser } from '../services/user.service.js';

export function adminRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx), requireRole('admin'));

  router.get('/users', (_req, res) => {
    res.json({ users: listUsers(ctx) });
  });

  router.patch('/users/:id', (req, res) => {
    const auth = requireAuthContext(req);
    const body = updateUserSchema.parse(req.body);
    res.json({ user: updateUser(ctx, auth.userId, pathParam(req, 'id'), body, clientIp(req)) });
  });

  router.post('/users/:id/revoke-sessions', (req, res) => {
    const auth = requireAuthContext(req);
    const revoked = revokeUserSessions(ctx, auth.userId, pathParam(req, 'id'), clientIp(req));
    res.json({ revoked });
  });

  router.get('/invites', (_req, res) => {
    res.json({ invites: listInvites(ctx) });
  });

  router.post('/invites', (req, res) => {
    const auth = requireAuthContext(req);
    const body = createInviteSchema.parse(req.body);
    const { invite, code } = createInvite(ctx, auth.userId, body);
    // `code` is returned exactly once. It is stored only as a hash and cannot be re-read;
    // a lost code is re-issued, never recovered.
    res.status(201).json({ invite, code });
  });

  router.delete('/invites/:id', (req, res) => {
    const auth = requireAuthContext(req);
    revokeInvite(ctx, auth.userId, pathParam(req, 'id'));
    res.status(204).end();
  });

  return router;
}
