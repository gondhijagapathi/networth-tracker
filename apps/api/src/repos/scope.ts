/**
 * Scope resolution: what this caller is allowed to see.
 *
 * ARCHITECTURE.md puts this between authentication and the data layer for a reason. The
 * auth middleware answers *who is calling*; this answers *whose rows may they read*; the
 * repository applies the answer. Route handlers never write their own
 * `WHERE owner_user_id = ?`, because the one that gets forgotten is the one that leaks a
 * household's finances to somebody else.
 *
 * A scope is always read-only beyond the caller's own rows. There is no grant that confers
 * writes — a partner in P6 and a nominee in P5 both read, and only the owner writes.
 */

import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { AccessScope, Role } from '@networth/shared';
import type { AppContext } from '../context.js';
import { accessGrants } from '../db/schema.js';
import { forbidden } from '../lib/errors.js';
import { isoNow } from '../lib/time.js';
import type { AuthContext } from '../middleware/auth.js';

export interface Scope {
  /** The caller. Their own rows are always fully readable and the only ones they may write. */
  userId: string;
  role: Role;
  /** Every owner whose rows are readable, the caller included. Never empty. */
  readableOwnerIds: string[];
  /** Owner id -> what was granted. The caller's own id is deliberately absent. */
  grants: ReadonlyMap<string, AccessScope>;
}

/**
 * Build the scope for a request.
 *
 * One indexed read of `access_grants`, filtered to live grants — not revoked, not expired.
 * Expiry is compared as an ISO-8601 string, which is exactly why every instant in this
 * database is stored in that format: lexical order is chronological order.
 */
export function resolveScope(ctx: AppContext, auth: AuthContext): Scope {
  const now = isoNow(ctx.now());

  const rows = ctx.db
    .select({ ownerUserId: accessGrants.ownerUserId, scope: accessGrants.scope })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.granteeUserId, auth.userId),
        isNull(accessGrants.revokedAt),
        or(isNull(accessGrants.expiresAt), gt(accessGrants.expiresAt, now)),
      ),
    )
    .all();

  const grants = new Map<string, AccessScope>();
  for (const row of rows) {
    // A user could hold two grants from the same owner — a household one and a nominee one.
    // The wider wins; narrowing is the revoking side's job, not an accident of row order.
    const existing = grants.get(row.ownerUserId);
    if (existing === undefined || SCOPE_RANK[row.scope] > SCOPE_RANK[existing]) {
      grants.set(row.ownerUserId, row.scope);
    }
  }
  // Never grant to yourself through this table: self-access is not a grant and must not be
  // revocable by one.
  grants.delete(auth.userId);

  return {
    userId: auth.userId,
    role: auth.role,
    readableOwnerIds: [auth.userId, ...grants.keys()],
    grants,
  };
}

const SCOPE_RANK: Record<AccessScope, number> = { summary: 1, full: 2, vault: 3 };

/** True when the caller owns this row outright. Only owners write. */
export function owns(scope: Scope, ownerUserId: string): boolean {
  return scope.userId === ownerUserId;
}

/**
 * Whether the caller may see more than a name and a number for this owner's rows.
 *
 * A `summary` grantee sees an asset on a merged dashboard but not its policy number or its
 * sub-registrar office. The distinction is what makes `share_mode: 'summary'` mean anything
 * in P6.
 */
export function canSeeDetail(scope: Scope, ownerUserId: string): boolean {
  if (owns(scope, ownerUserId)) return true;
  const granted = scope.grants.get(ownerUserId);
  return granted === 'full' || granted === 'vault';
}

/**
 * Refuse a detail read the caller only has a summary grant for.
 *
 * A `403` rather than the usual `404` — and deliberately so. The blanket rule is that
 * existence is private, but this caller already saw the asset in their own list, so
 * pretending it does not exist would confuse rather than conceal.
 */
export function assertCanSeeDetail(scope: Scope, ownerUserId: string): void {
  if (!canSeeDetail(scope, ownerUserId)) {
    throw forbidden('This is shared with you as a summary only');
  }
}
