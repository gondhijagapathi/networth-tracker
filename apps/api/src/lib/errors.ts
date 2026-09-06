/**
 * Application errors.
 *
 * Route handlers throw these; the error middleware turns them into a response. Anything
 * that is *not* an `ApiError` is a bug, and is reported as a bare 500 with no detail —
 * a stack trace on the wire is a gift to an attacker.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'totp_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  totp_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Field-level messages, keyed by path, for form rendering. */
  readonly details?: Record<string, string[]>;
  /** Seconds until the caller may retry; sent as `Retry-After` on 429. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, string[]>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const badRequest = (message: string, details?: Record<string, string[]>): ApiError =>
  new ApiError('bad_request', message, { details });

export const unauthenticated = (message = 'Sign in to continue'): ApiError =>
  new ApiError('unauthenticated', message);

/**
 * Deliberately identical for "no such user" and "wrong password". Distinguishing them
 * turns the login form into an account-enumeration oracle.
 */
export const invalidCredentials = (): ApiError =>
  new ApiError('invalid_credentials', 'Email or password is incorrect');

export const forbidden = (message = 'You do not have access to this'): ApiError =>
  new ApiError('forbidden', message);

/**
 * Used where a `403` would itself leak information. Per docs/ARCHITECTURE.md, a caller
 * outside the scope of a record is told it does not exist — existence is private.
 */
export const notFound = (message = 'Not found'): ApiError => new ApiError('not_found', message);

export const conflict = (message: string): ApiError => new ApiError('conflict', message);

export const rateLimited = (message: string, retryAfterSeconds: number): ApiError =>
  new ApiError('rate_limited', message, { retryAfterSeconds });
