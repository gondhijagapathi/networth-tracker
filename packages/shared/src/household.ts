/**
 * Household contracts: partner merge by mutual, revocable consent.
 *
 * A household is not a shared account — it is a query-time union over two people's own data,
 * built on the same `access_grants` table a nominee reads through. Everything that already
 * consults `scope.readableOwnerIds` (the dashboard, the asset list, allocation) already knows
 * how to render a merged view; this file is only what creates and revokes the grants.
 *
 * Two separate consents, not one:
 *
 *   - **Joining** (`acceptedAt`) says "I am part of this household." An invited member who
 *     has not accepted is not merged into anything, no matter what their share mode is set to.
 *   - **Sharing** (`shareMode` + `consentedAt`) says "and here is how much of *my* data the
 *     rest of the household may see." A member can join and still choose `none` — visible in
 *     the household, sharing nothing — which is the Settings toggle TASKS.md describes.
 *
 * A grant flows in one direction per pair: from a sharing member to every other *joined*
 * member, at the sharing member's own `shareMode`. Two partners who both share `full` end up
 * with two grants, one each way — not one shared row — because either side can narrow or
 * revoke their own without needing the other's consent to do so.
 */

import { z } from 'zod';
import { emailSchema } from './auth.js';
import { labelSchema } from './assets.js';

export const HOUSEHOLD_MEMBER_ROLES = ['owner', 'partner', 'member'] as const;
export const householdMemberRoleSchema = z.enum(HOUSEHOLD_MEMBER_ROLES);
export type HouseholdMemberRole = z.infer<typeof householdMemberRoleSchema>;

/**
 * `full` and `summary` mirror the two useful `AccessScope` values a household grant can carry
 * — never `vault`, which stays a nominee-and-escrow concept. `none` shares nothing and writes
 * no grant at all.
 */
export const SHARE_MODES = ['full', 'summary', 'none'] as const;
export const shareModeSchema = z.enum(SHARE_MODES);
export type ShareMode = z.infer<typeof shareModeSchema>;

export const createHouseholdSchema = z.object({
  name: labelSchema,
});
export type CreateHouseholdBody = z.infer<typeof createHouseholdSchema>;

export const invitePartnerSchema = z.object({
  email: emailSchema,
});
export type InvitePartnerBody = z.infer<typeof invitePartnerSchema>;

export const updateShareModeSchema = z.object({
  shareMode: shareModeSchema,
});
export type UpdateShareModeBody = z.infer<typeof updateShareModeSchema>;

export interface HouseholdMemberRecord {
  id: string;
  householdId: string;
  userId: string;
  name: string;
  email: string;
  role: HouseholdMemberRole;
  /** What this member currently shares with the rest of the household. */
  shareMode: ShareMode;
  /** Set once this member has turned sharing on at their current `shareMode`. */
  consentedAt: string | null;
  /** Set once this member has accepted membership. Null means an invite is still pending. */
  acceptedAt: string | null;
  createdAt: string;
}

export interface HouseholdRecord {
  id: string;
  name: string;
  createdByUserId: string | null;
  members: HouseholdMemberRecord[];
  createdAt: string;
}
