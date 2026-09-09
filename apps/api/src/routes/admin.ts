/**
 * Administration endpoints.
 *
 * Every route here is gated on the `admin` role. Note what is absent: nothing in this
 * router reads or writes another user's financial data. Admin is an operational role —
 * who may sign in — not a privileged view of the household's assets.
 */

import { Router } from 'express';
import { createInviteSchema, updateUserSchema } from '@networth/shared';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { testEmail } from '../lib/mailTemplates.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext, requireRole } from '../middleware/auth.js';
import { createInvite, listInvites, revokeInvite } from '../services/invite.service.js';
import { mailStatus, retryEmail, sendTestEmail } from '../services/mail.service.js';
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
    const actor = ctx.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, auth.userId))
      .get();

    const { invite, code, emailQueued } = createInvite(ctx, auth.userId, body, {
      kind: 'admin',
      invitedBy: actor?.name ?? null,
    });

    // `code` is returned exactly once. It is stored only as a hash and cannot be re-read;
    // a lost code is re-issued, never recovered. `emailQueued` is what lets the screen say
    // whether the admin still has to deliver it by hand.
    res.status(201).json({ invite, code, emailQueued });
  });

  router.delete('/invites/:id', (req, res) => {
    const auth = requireAuthContext(req);
    revokeInvite(ctx, auth.userId, pathParam(req, 'id'));
    res.status(204).end();
  });

  /* ---------------------------------------------------------------------- */
  /* Mail                                                                   */
  /* ---------------------------------------------------------------------- */

  router.get('/mail', (_req, res) => {
    res.json(mailStatus(ctx));
  });

  /**
   * Send a test message to the caller's own address.
   *
   * To their own address and nowhere else, deliberately: an admin endpoint that takes a
   * recipient is an open relay wearing a badge, and this instance's whole security posture
   * is that it never emails anyone the household did not add.
   *
   * Answers 200 with `ok: false` rather than an error status when the send fails. The
   * request succeeded — it did exactly what was asked and found out that mail is broken —
   * and the transport's complaint is the payload the operator needs, not an exception.
   */
  router.post('/mail/test', async (req, res) => {
    const auth = requireAuthContext(req);
    const actor = ctx.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, auth.userId))
      .get();

    const result = await sendTestEmail(
      ctx,
      auth.userId,
      testEmail(
        { baseUrl: ctx.config.appBaseUrl },
        {
          name: actor?.name ?? 'there',
          host: ctx.config.mail?.host ?? 'not configured',
          from: ctx.config.mail?.from ?? 'not configured',
        },
      ),
      clientIp(req),
    );

    res.json(result);
  });

  /** Put a failed message back in the queue. Only works while its body still exists. */
  router.post('/mail/:id/retry', (req, res) => {
    if (!retryEmail(ctx, pathParam(req, 'id'))) {
      throw notFound('That message cannot be sent again — issue a new one instead');
    }
    res.status(202).json(mailStatus(ctx));
  });

  return router;
}
