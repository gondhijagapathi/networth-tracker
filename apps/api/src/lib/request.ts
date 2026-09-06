/**
 * Small request helpers shared by the routers.
 */

import type { Request } from 'express';
import { notFound } from './errors.js';

/**
 * The caller's address, for rate-limit keys and the audit log.
 *
 * `req.ip` honours `X-Forwarded-For` only when Express is told to trust a proxy, which
 * `createApp` sets from configuration. That default matters: trusting the header
 * unconditionally would let any caller spoof their address and walk straight past the
 * per-address login backoff.
 */
export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

/**
 * A required path parameter, as a string.
 *
 * Express types `req.params` loosely enough to include arrays and `undefined`. Rather than
 * casting at each call site, every route reads its parameters through here, so a missing
 * segment fails as a 404 instead of reaching a query as `undefined`.
 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw notFound('Not found');
  }
  return value;
}
