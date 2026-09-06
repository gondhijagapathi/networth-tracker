/**
 * The nominee read-only guard.
 *
 * A nominee account exists to *read* an estate — before the owner dies, so the heir can see
 * what they will have to claim; after, so they can claim it. It has no business writing
 * anything, anywhere, ever.
 *
 * That rule is enforced twice on purpose. The scoped repository refuses a write to a row the
 * caller does not own, which already covers the case; this middleware refuses the request
 * outright, before any handler runs. Defence in depth is worth a few lines when the failure
 * mode is an heir quietly editing the estate they stand to inherit.
 *
 * Deferred here from P1 deliberately: mounted before the data routes existed, it would have
 * been dead middleware that looked like protection without providing any.
 */

import type { RequestHandler } from 'express';
import { forbidden, unauthenticated } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function denyNomineeWrites(): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!req.auth) return next(unauthenticated());
    if (req.auth.role === 'nominee') {
      return next(forbidden('Nominee accounts have read-only access'));
    }
    return next();
  };
}
