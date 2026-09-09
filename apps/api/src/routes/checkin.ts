/**
 * "Yes, I am still here."
 *
 * The one router in this application that is reachable with no session at all and still
 * changes something. It exists because the dead-man switch has a problem its own design
 * creates: it measures people who have stopped opening the app, so telling those people to
 * open the app in order to prove they are alive asks for precisely the behaviour whose
 * absence is the entire signal. The warning email therefore carries the answer with it.
 *
 * The token is the credential, and it can do exactly one thing — reset the clock on the
 * account it was issued for. It reads nothing, returns nothing about anybody's money, and
 * cannot be turned into a session.
 *
 * **The split between these two endpoints is the whole point of the file.** Gmail, Outlook
 * Safe Links and every antivirus gateway in between fetch the URLs in a message before a
 * human sees it. If the `GET` performed the check-in, a scanner would answer each warning
 * on the morning it arrived, the switch would never advance past `warned_50`, and the
 * escrows would never open. That failure is silent and happens only to somebody who has
 * died — which is the worst combination available. So the `GET` is a read, and a person
 * pressing a button issues the `POST`.
 */

import { Router } from 'express';
import { checkInSchema, checkInTokenSchema } from '@networth/shared';
import type { AppContext } from '../context.js';
import { clientIp } from '../lib/request.js';
import { consumeCheckInToken, describeCheckInToken } from '../services/deadman.service.js';

export function checkinRouter(ctx: AppContext): Router {
  const router = Router();

  /**
   * What the page shows before anybody presses anything. Safe to prefetch, by design —
   * this is what a link scanner gets, and it changes nothing.
   */
  router.get('/', (req, res) => {
    const token = checkInTokenSchema.safeParse(req.query.token);
    if (!token.success) {
      res.json({
        valid: false,
        name: null,
        stage: null,
        daysUntilRelease: null,
        alreadyFired: false,
      });
      return;
    }
    res.json(describeCheckInToken(ctx, token.data));
  });

  /**
   * The button.
   *
   * Rate limited on the client address. The token is 256 random bits and will not be
   * guessed, but this is an unauthenticated endpoint that writes, and it costs nothing to
   * make grinding it pointless.
   */
  router.post('/', (req, res) => {
    const ip = clientIp(req);
    const key = `checkin:${ip ?? 'unknown'}`;
    ctx.loginLimiter.assertAllowed(key);

    const body = checkInSchema.parse(req.body);
    try {
      const deadman = consumeCheckInToken(ctx, body.token, ip);
      ctx.loginLimiter.reset(key);
      res.json({ deadman });
    } catch (error) {
      ctx.loginLimiter.recordFailure(key);
      throw error;
    }
  });

  return router;
}
