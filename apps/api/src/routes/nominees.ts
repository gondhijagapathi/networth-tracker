/**
 * Nominee management, from the owner's side.
 *
 * Everything here is an owner acting on their own estate, so the router is scoped to the
 * caller rather than through `resolveScope` — a grant lets somebody *read* an estate, never
 * administer its nominations. The heir's own view lives on `/api/estate`.
 */

import { Router } from 'express';
import { createNomineeSchema, sealEscrowSchema, updateNomineeSchema } from '@networth/shared';
import type { AppContext } from '../context.js';
import { notFound } from '../lib/errors.js';
import { clientIp, pathParam } from '../lib/request.js';
import { requireAuth, requireAuthContext } from '../middleware/auth.js';
import { denyNomineeWrites } from '../middleware/readonly.js';
import {
  createNominee,
  getNominee,
  inviteNominee,
  listNominees,
  releaseEscrow,
  revokeNominee,
  sealEscrow,
  updateNominee,
} from '../services/nominee.service.js';
import { publicKeyOfUser } from '../services/vault.service.js';

export function nomineesRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireAuth(ctx), denyNomineeWrites());

  router.get('/', (req, res) => {
    res.json({ nominees: listNominees(ctx, requireAuthContext(req).userId) });
  });

  router.post('/', (req, res) => {
    const auth = requireAuthContext(req);
    const body = createNomineeSchema.parse(req.body);
    res.status(201).json({ nominee: createNominee(ctx, auth.userId, body, clientIp(req)) });
  });

  router.get('/:id', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ nominee: getNominee(ctx, auth.userId, pathParam(req, 'id')) });
  });

  router.patch('/:id', (req, res) => {
    const auth = requireAuthContext(req);
    const body = updateNomineeSchema.parse(req.body);
    res.json({
      nominee: updateNominee(ctx, auth.userId, pathParam(req, 'id'), body, clientIp(req)),
    });
  });

  /** Revoke: the record, the access grant and the escrow, in one transaction. */
  router.delete('/:id', (req, res) => {
    const auth = requireAuthContext(req);
    res.json({ nominee: revokeNominee(ctx, auth.userId, pathParam(req, 'id'), clientIp(req)) });
  });

  /** Issue a one-time code so this nominee can create their own read-only account. */
  router.post('/:id/invite', (req, res) => {
    const auth = requireAuthContext(req);
    res.status(201).json(inviteNominee(ctx, auth.userId, pathParam(req, 'id'), clientIp(req)));
  });

  /**
   * The nominee's public key, so the owner's browser can wrap the data key to it.
   *
   * Served through the nomination rather than by user id: an owner may read the public key
   * of somebody they have named, and of nobody else. A public key is not a secret, but a
   * lookup endpoint over every account is still an enumeration tool.
   */
  router.get('/:id/public-key', (req, res) => {
    const auth = requireAuthContext(req);
    const nominee = getNominee(ctx, auth.userId, pathParam(req, 'id'));
    if (!nominee.nomineeUserId) throw notFound('That nominee has not accepted their invite yet');

    const publicKeyJwk = publicKeyOfUser(ctx, nominee.nomineeUserId);
    if (!publicKeyJwk) throw notFound('That nominee has not set up their own vault yet');

    res.json({ publicKeyJwk });
  });

  /** Store the wrapped data key. Sealed — held by the server, openable by nobody. */
  router.post('/:id/escrow', (req, res, next) => {
    void (async () => {
      try {
        const auth = requireAuthContext(req);
        const body = sealEscrowSchema.parse(req.body);
        const escrow = await sealEscrow(
          ctx,
          auth.userId,
          pathParam(req, 'id'),
          body,
          clientIp(req),
        );
        res.status(201).json({ escrow });
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * Hand it over, now, deliberately.
   *
   * The other way an escrow opens is the dead-man switch, and the two are the same call
   * with a different reason — which is what keeps "the timer released this" and "they
   * released this" the same shape in the audit log.
   */
  router.post('/:id/release', (req, res) => {
    const auth = requireAuthContext(req);
    const escrow = releaseEscrow(ctx, auth.userId, pathParam(req, 'id'), 'owner', clientIp(req));
    res.json({ escrow });
  });

  return router;
}
