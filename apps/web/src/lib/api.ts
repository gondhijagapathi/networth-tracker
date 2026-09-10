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

/**
 * Send, and if the access token had expired, refresh once and send again.
 *
 * Everything that talks to the API goes through here — JSON and raw bytes alike. A helper
 * that skipped it would work for the first fifteen minutes of a session and then fail on
 * exactly the long operations that are hardest to retry by hand: a 10 MB document upload,
 * or a backup restore that has already streamed half a gigabyte.
 */
async function sendWithRefresh(send: () => Promise<Response>, noRetry = false): Promise<Response> {
  const response = await send();
  if (!shouldRefresh(response) || noRetry) return response;
  return (await refreshSession()) ? send() : response;
}

/**
 * Whether a 401 means "your token aged out" or "that credential is wrong".
 *
 * Only the first is worth refreshing for. A mistyped password and a missing second factor
 * both answer 401 too, and rotating a perfectly good refresh token because somebody fumbled
 * the login form spends a credential to learn nothing.
 */
function shouldRefresh(response: Response): boolean {
  if (response.status !== 401) return false;
  const code = response.headers.get('x-error-code');
  // The header is advisory: an older server, or a proxy that stripped it, leaves us with
  // the status alone, and refreshing then is the behaviour this client has always had.
  return code === null || code === 'unauthenticated';
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

  const response = await sendWithRefresh(send, options.noRetry === true);

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
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** The refresh endpoint must not recurse into its own retry. */
  refresh: () => request<unknown>('/auth/refresh', { method: 'POST', noRetry: true }),
};

/* -------------------------------------------------------------------------- */
/* Binary transfers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Upload an already-encrypted file.
 *
 * The bytes go up raw rather than base64 inside JSON, which would inflate a 10 MB scan to
 * 13 MB and buy nothing. The encrypted `{filename, mime}` envelope rides in a header
 * instead: it is a few hundred bytes, and putting it in the body would mean a multipart
 * encoding on both sides to find it again.
 */
export async function upload<T>(path: string, bytes: Uint8Array, meta: unknown): Promise<T> {
  const response = await sendWithRefresh(() =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/octet-stream',
        'x-vault-meta': base64Url(JSON.stringify(meta)),
        ...csrfHeader(),
      },
      body: bytes as BodyInit,
    }),
  );

  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/**
 * POST raw bytes, with the rest of the request in headers.
 *
 * The one case is a backup bundle, which can be hundreds of megabytes: base64 inside JSON
 * would inflate it by a third and force the server to buffer a string that large before it
 * could look at the first byte.
 */
export async function sendBytes<T>(
  path: string,
  bytes: ArrayBuffer,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await sendWithRefresh(() =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/octet-stream', ...headers, ...csrfHeader() },
      body: bytes,
    }),
  );

  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/** Fetch a document's ciphertext. The caller decrypts it; this never sees a plaintext. */
export async function binary(path: string): Promise<ArrayBuffer> {
  const response = await sendWithRefresh(() => fetch(`/api${path}`, { credentials: 'include' }));
  if (!response.ok) throw await toApiError(response);
  return response.arrayBuffer();
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = (safeParse(await response.text()) as ApiErrorBody | null)?.error;
  return new ApiError(
    response.status,
    body ?? { code: 'internal', message: 'Something went wrong.' },
  );
}

/** UTF-8 to unpadded base64url, for the metadata header. */
function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binaryString = '';
  for (const byte of bytes) binaryString += String.fromCharCode(byte);
  return btoa(binaryString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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
