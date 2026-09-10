/**
 * Terminal error handling.
 *
 * Two rules, both about not leaking:
 *   - An `ApiError` is intentional and its message is safe to show the user.
 *   - Anything else is a bug. It is logged server-side and answered with a bare 500, so a
 *     stack trace or a SQL fragment never reaches the wire.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError, notFound } from '../lib/errors.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, string[]> };
}

/** Mounted last: any URL that matched no route is a 404 in the same shape as everything else. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('No such endpoint'));
};

export function errorHandler(options: { exposeStack: boolean }): ErrorRequestHandler {
  // Express identifies error middleware by arity, so `next` must stay in the signature.

  return (error, _req, res, _next) => {
    if (error instanceof ZodError) {
      return res.status(400).json(bodyFromZod(error));
    }

    if (error instanceof ApiError) {
      if (error.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      // The same code the body carries, in a header, so a client can read it without
      // consuming the body. Three of these codes are 401s that mean quite different things,
      // and the browser client refreshes its token for one of them and not the others.
      res.setHeader('X-Error-Code', error.code);
      return res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details },
      } satisfies ErrorBody);
    }

    console.error('Unhandled error:', error);

    return res.status(500).json({
      error: {
        code: 'internal',
        message: 'Something went wrong.',
        ...(options.exposeStack && error instanceof Error
          ? { details: { stack: [error.stack ?? ''] } }
          : {}),
      },
    } satisfies ErrorBody);
  };
}

/** Turn a Zod failure into field-keyed messages the client can render next to inputs. */
export function bodyFromZod(error: ZodError): ErrorBody {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (details[key] ??= []).push(issue.message);
  }
  return { error: { code: 'bad_request', message: 'Check the highlighted fields.', details } };
}
