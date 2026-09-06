/**
 * Everything a route handler needs that is not the request itself.
 *
 * Passed explicitly to router factories rather than reached for through module-level
 * singletons, so a test can stand up an app against an in-memory database and a frozen
 * clock without touching global state.
 */

import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { INVITE_POLICY, LOGIN_POLICY, RateLimiter } from './lib/rateLimit.js';

export interface AppContext {
  config: Config;
  db: Db;
  sqlite: Database.Database;
  /** Backoff on failed sign-ins, keyed by email and by client address. */
  loginLimiter: RateLimiter;
  /** Backoff on invalid invite codes, keyed by client address. */
  inviteLimiter: RateLimiter;
  /** Injectable clock. Tests advance it; production reads the wall clock. */
  now: () => Date;
}

export function createContext(
  config: Config,
  db: Db,
  sqlite: Database.Database,
  overrides: Partial<Pick<AppContext, 'now'>> = {},
): AppContext {
  const now = overrides.now ?? (() => new Date());
  const clockMs = () => now().getTime();

  return {
    config,
    db,
    sqlite,
    loginLimiter: new RateLimiter(LOGIN_POLICY, clockMs),
    inviteLimiter: new RateLimiter(INVITE_POLICY, clockMs),
    now,
  };
}
