/**
 * The API client.
 *
 * Three things the rest of the app should never have to think about:
 *
 *   - **Cookies do the authenticating.** The access token is httpOnly, so there is no token
 *     to attach and nothing to keep in `localStorage` for a script to steal. Every request
 *     is `credentials: 'include'` and the browser does the rest.
 *   - **CSRF is a double submit.** The server sets a readable `nt_csrf` cookie; every
 *     mutating request echoes it in `x-csrf-token`. A cross-site form post cannot read the
 *     cookie, so it cannot forge the header.
 *   - **Expiry is invisible.** The access token lasts fifteen minutes. When one runs out
 *     mid-session the client rotates it and replays the request, so a user filling in a
 *     form does not lose it to a token they never knew existed.
 */

/** The error shape every endpoint answers with — see `middleware/error.ts` on the server. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, string[]> };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Field-keyed messages, for rendering next to the input that caused them. */
  readonly details: Record<string, string[]>;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details ?? {};
  }

  /** The first message for a field, which is all a form has room to show. */
  fieldError(path: string): string | undefined {
    return this.details[path]?.[0];
  }
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skip the refresh-and-retry dance. Used by the refresh call itself. */
  noRetry?: boolean;
  signal?: AbortSignal;
}

/**
 * One in-flight refresh, shared.
 *
 * A dashboard fires four requests at once; when the access token has expired they all come
 * back 401 together. Without this they would each rotate the refresh token, and rotation
 * with replay detection means the second one to arrive looks like a stolen token and
 * revokes the whole family — signing the user out for being logged in.
 */
let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: csrfHeader(),
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared in a microtask so everyone waiting on this attempt sees its result.
      queueMicrotask(() => {
        refreshing = null;
      });
    }
  })();
  return refreshing;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';

  const send = (): Promise<Response> =>
    fetch(`/api${path}`, {
      method,
      credentials: 'include',
      signal: options.signal,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(MUTATING.has(method) ? csrfHeader() : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  let response = await send();

  if (response.status === 401 && options.noRetry !== true && (await refreshSession())) {
    response = await send();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text === '' ? null : safeParse(text);

  if (!response.ok) {
    const body = (parsed as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      body ?? { code: 'internal', message: 'Something went wrong.' },
    );
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** The refresh endpoint must not recurse into its own retry. */
  refresh: () => request<unknown>('/auth/refresh', { method: 'POST', noRetry: true }),
};

function csrfHeader(): Record<string, string> {
  const token = readCookie('nt_csrf');
  return token === null ? {} : { 'x-csrf-token': token };
}

/** The CSRF cookie is deliberately readable; every other session cookie is httpOnly. */
function readCookie(name: string): string | null {
  for (const part of document.cookie.split('; ')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index) === name)
      return decodeURIComponent(part.slice(index + 1));
  }
  return null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A proxy or a crash can return HTML where JSON was promised. Losing the body is
    // better than throwing a parse error over whatever the real failure was.
    return null;
  }
}

/** Build a query string, dropping anything the caller left undefined. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}
