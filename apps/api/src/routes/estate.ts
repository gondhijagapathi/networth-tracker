/**
 * The estate: an heir's view outward, and an owner's dead-man switch.
 *
 * Two audiences on one router because they are two ends of the same thing. An owner
 * configures how long their silence has to last; a nominee reads what that silence
 * eventually released.
 *
 * There is no write operation here at all. `POST /:ownerId/key` is a read that is spelled as
 * a POST so it carries a CSRF token and is not prefetched by a browser — fetching an
 * escrowed key is the single most consequential read in the application and it writes an
 * audit row every time. That is also why `denyNomineeWrites` is not mounted: it would block
 * that POST, and the router has nothing for it to protect.
 */

import { Router } from 'express';
import { claimKitQuerySchema, configureDeadManSchema } from '@networth/shared';
import type { AppContext } from '../context.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { resolveScope } from '../repos/scope.js';
import { claimKit } from '../services/claimkit.service.js';
import { checkIn, configureDeadMan, deadManStatus } from '../services/deadman.service.js';
import { assertVaultReleased, listEstates, readEscrowKey } from '../services/nominee.service.js';
import { listVaultItems } from '../services/vault.service.js';
import { listDocuments, readDocument } from '../services/document.service.js';

export function estateRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx));

  /* ---------------------------------------------------------------------- */
  /* The heir's side                                                        */
  /* ---------------------------------------------------------------------- */

  /** Estates this user has been named in, and whether each vault has been released. */
  router.get('/', (req, res) => {
    res.json({ estates: listEstates(ctx, requireAuthContext(req).userId) });
  });

  /**
   * The printable claim kit — for your own estate, or for one you have been named in with
   * `full` or `vault` access. The vault plaintext is merged into it in the browser.
   */
  router.get('/claim-kit', (req, res) => {
    const auth = requireAuthContext(req);
    const scope = resolveScope(ctx, auth);
    const query = claimKitQuerySchema.parse(req.query);
    res.json(claimKit(ctx, scope, { ...query, ip: clientIp(req) }));
  });

  /* ---------------------------------------------------------------------- */
  /* The owner's switch                                                     */
  /* ---------------------------------------------------------------------- */

  router.get('/deadman', (req, res) => {
    res.json({ deadman: deadManStatus(ctx, requireAuthContext(req).userId) });
  });

  router.put('/deadman', (req, res) => {
    const auth = requireAuthContext(req);
    const body = configureDeadManSchema.parse(req.body);
    res.json({ deadman: configureDeadMan(ctx, auth.userId, body, clientIp(req)) });
  });

  /** "I am still here." Resets the clock and unwinds any warning stage. */
  router.post('/deadman/checkin', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ deadman: checkIn(ctx, auth.userId, clientIp(req)) });
  });

  /** The same operation during the grace period, recorded under its own audit action. */
  router.post('/deadman/cancel', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ deadman: checkIn(ctx, auth.userId, clientIp(req), 'cancel') });
  });

  /* ---------------------------------------------------------------------- */
  /* The escrowed key                                                       */
  /* ---------------------------------------------------------------------- */

  router.post('/:ownerId/key', (req, res) => {
    const auth = requireAuthContext(req);
    res.json(readEscrowKey(ctx, auth.userId, pathParam(req, 'ownerId'), clientIp(req)));
  });

  /* ---------------------------------------------------------------------- */
  /* The released vault                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * An owner's vault items, as ciphertext, for an heir whose escrow has opened.
   *
   * The server is doing no more here than it does for the owner: handing over bytes it
   * cannot read. What makes this safe is that `assertVaultReleased` requires both the
   * owner's stated intent and the event that released it, and what makes it *useful* is
   * that the heir holds a key that opens them.
   */
  router.get('/:ownerId/items', (req, res) => {
    const auth = requireAuthContext(req);
    const ownerId = pathParam(req, 'ownerId');
    assertVaultReleased(ctx, auth.userId, ownerId);
    res.json({ items: listVaultItems(ctx, ownerId) });
  });

  router.get('/:ownerId/documents', (req, res) => {
    const auth = requireAuthContext(req);
    const ownerId = pathParam(req, 'ownerId');
    assertVaultReleased(ctx, auth.userId, ownerId);
    res.json({ documents: listDocuments(ctx, ownerId) });
  });

  router.get('/:ownerId/documents/:id/content', (req, res) => {
    const auth = requireAuthContext(req);
    const ownerId = pathParam(req, 'ownerId');
    assertVaultReleased(ctx, auth.userId, ownerId);

    // Read as the owner, logged as the heir: the audit row that matters is "the heir
    // fetched the will", and passing the owner's id would record the wrong actor.
    const { row, content } = readDocument(
      ctx,
      ownerId,
      pathParam(req, 'id'),
      clientIp(req),
      auth.userId,
    );
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(row.sizeBytes));
    res.setHeader('x-document-sha256', row.sha256);
    res.send(content);
  });

  return router;
}
