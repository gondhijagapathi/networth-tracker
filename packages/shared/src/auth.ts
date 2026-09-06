/**
 * Authentication contracts shared by the API and the web client.
 *
 * These schemas are the single definition of what a valid credential looks like. The
 * browser uses them to give instant feedback; the server re-parses every request body
 * with the same schema and trusts nothing the client claims to have checked.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `admin`   — manages users and invites, sees only their own financial data.
 * `member`  — an ordinary household account.
 * `nominee` — read-only heir account; may never write anything, anywhere.
 */
export const ROLES = ['admin', 'member', 'nominee'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** A suspended user keeps their data but cannot authenticate. Rows are never deleted. */
export const USER_STATUSES = ['active', 'suspended'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Email is the login identifier, so it is normalised before it is ever compared or
 * stored: trimmed and lowercased. Without this, `A@b.com` and `a@b.com` become two
 * accounts that look identical in the admin list.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

/** Minimum login password length. Long over complex — no character-class theatre. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Argon2id hashes whatever it is given, so an unbounded password is an unbounded amount
 * of hashing work. The cap is a denial-of-service guard, not a security opinion.
 */
export const PASSWORD_MAX_LENGTH = 200;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Passwords are limited to ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => value.trim().length >= PASSWORD_MIN_LENGTH, {
    message: 'Password cannot be mostly whitespace',
  })
  .refine((value) => new Set(value).size > 4, {
    message: 'Password repeats too few distinct characters',
  });

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(80, 'Name is too long');

/**
 * Invite codes are generated server-side and mailed or read out loud, so they are
 * accepted case-insensitively and with the grouping dashes optional.
 */
export const inviteCodeSchema = z
  .string()
  .trim()
  .min(8, 'Invite code is too short')
  .max(128, 'Invite code is too long');

/** A device label lets a user recognise a session in the "signed-in devices" list. */
export const deviceLabelSchema = z.string().trim().max(80).optional();

/** Either a six-digit TOTP code or one of the user's recovery codes. */
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator app');

export const recoveryCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{5}-[a-z0-9]{5}$/, 'Recovery codes look like "a1b2c-d3e4f"');

/** Second factor at login: an authenticator code, or a recovery code if the phone is gone. */
export const secondFactorSchema = z.union([totpCodeSchema, recoveryCodeSchema]);

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

export const registerSchema = z
  .object({
    inviteCode: inviteCodeSchema,
    email: emailSchema,
    name: displayNameSchema,
    password: passwordSchema,
    deviceLabel: deviceLabelSchema,
  })
  .refine((body) => !sharesLocalPart(body.password, body.email), {
    message: 'Password must not contain your email address',
    path: ['password'],
  });
export type RegisterBody = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately not `passwordSchema`: an existing password predates any policy change,
  // and rejecting it here would tell an attacker the policy instead of just failing.
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
  totp: secondFactorSchema.optional(),
  deviceLabel: deviceLabelSchema,
});
export type LoginBody = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((body) => body.currentPassword !== body.newPassword, {
    message: 'New password must be different from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

export const enrolTotpSchema = z.object({
  code: totpCodeSchema,
});
export type EnrolTotpBody = z.infer<typeof enrolTotpSchema>;

export const disableTotpSchema = z.object({
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
  code: secondFactorSchema,
});
export type DisableTotpBody = z.infer<typeof disableTotpSchema>;

/** Admin issues an invite. An unbound invite (no email) may be redeemed by anyone holding it. */
export const createInviteSchema = z.object({
  email: emailSchema.optional(),
  role: roleSchema.default('member'),
  expiresInDays: z.coerce.number().int().min(1).max(90).default(7),
  note: z.string().trim().max(200).optional(),
});
export type CreateInviteBody = z.infer<typeof createInviteSchema>;

export const updateUserSchema = z
  .object({
    status: userStatusSchema.optional(),
    role: roleSchema.optional(),
  })
  .refine((body) => body.status !== undefined || body.role !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateUserBody = z.infer<typeof updateUserSchema>;

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

/** The only representation of a user that ever crosses the wire. No hashes, no secrets. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  totpEnabled: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

/** One row in the "signed-in devices" list. */
export interface SessionSummary {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  current: boolean;
}

export interface InviteSummary {
  id: string;
  email: string | null;
  role: Role;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedByUserId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** True when the password embeds the local part of the email (`jaga` in `jaga@x.com`). */
function sharesLocalPart(password: string, email: string): boolean {
  const localPart = email.split('@')[0] ?? '';
  if (localPart.length < 4) return false;
  return password.toLowerCase().includes(localPart.toLowerCase());
}
