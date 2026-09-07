# Architecture

## Shape

An npm-workspaces monorepo running as two processes in development and one in production
(the API serves the built web bundle).

```
apps/web       Vite + React 19 + TypeScript + Tailwind v4 + Recharts
apps/api       Express + better-sqlite3 + Drizzle ORM
packages/shared  zod schemas, types, money / XIRR / financial-year helpers
data/          SQLite DB, uploads, backups (gitignored, never leaves the host)
```

`packages/shared` is imported by both sides, so a validation rule is written once and
enforced on the client *and* the server. The client's copy is a convenience; the server
always revalidates.

## Runtime

- **Development** — `npm run dev` runs both workspaces via `concurrently`. Vite proxies
  `/api` to the Express port, so the browser sees a single origin and cookies work without
  CORS gymnastics.
- **Production** — `npm run build` then `npm start`. Express serves the static bundle and
  the API from one port. Put it behind a reverse proxy with TLS.

## Data layer

- One SQLite file, WAL mode, `foreign_keys = ON`, `synchronous = NORMAL`.
- Drizzle ORM for typed queries. `drizzle-kit` generates plain SQL migrations that are
  committed to `apps/api/migrations/` and applied on boot by `src/db/migrate.ts` — no
  magic, and the schema history is readable in a diff.
- **`drizzle-kit` is not a dependency.** `npm run db:generate` fetches it on demand
  (`npx drizzle-kit@<pinned>`) because its dependency tree still carries an
  advisory-flagged `esbuild` that npm will not let an override reach. Only the generated
  SQL is committed, so a fresh clone installs nothing extra and `npm audit` stays clean.
  The cost is that `schema.ts` and the SQL could drift, so
  `src/db/__tests__/schema.test.ts` builds a database from the migrations alone and
  compares its real columns, nullability and keys against the Drizzle definitions.
- **Money is integer paise** in `BIGINT` columns. Never floats: `0.1 + 0.2` problems in a
  net worth tracker are unacceptable. Conversion and formatting live in
  `packages/shared/src/money.ts` and happen only at the edges.
- **Dates** are ISO-8601 `TEXT` (`YYYY-MM-DD` for dates, full timestamps in UTC for
  instants). SQLite has no date type; a sortable string is the honest representation.

## Access control

Every read goes through a scoped repository layer. Route handlers never write ad-hoc
`WHERE owner_user_id = ?` clauses — the scoping is applied in one place so a forgotten
filter cannot leak another household's data.

```
request → auth middleware (who) → scope resolver (what they may see) → repository → SQLite
```

The auth middleware verifies the access JWT and then re-reads the user row, so role
changes and suspensions take effect on the very next request rather than whenever the
token happens to expire. One indexed primary-key lookup buys that.

The scope resolver reads `access_grants`, which is the union of:

- the caller's own assets,
- assets shared through an accepted `household_members` row, subject to `share_mode`,
- assets exposed to an active nominee grant (read-only, never writable).

A caller who is not in scope gets `404`, not `403` — existence itself is private.

## The vault is opaque to the server

Vault ciphertext passes through the API as bytes. There is no server-side code path that
can decrypt it, and the request schemas reject anything plaintext-shaped. See
[SECURITY-MODEL.md](./SECURITY-MODEL.md).

All of the cryptography lives in `apps/web/src/lib/vaultCrypto.ts` and nowhere else; one
React provider (`lib/vault.tsx`) holds the keys in refs, and screens ask it to encrypt or
decrypt rather than ever touching a `CryptoKey`. On the server, `lib/envelope.ts` is the only
module that turns a ciphertext column into an object and back, which makes "nothing here
inspects or transforms the ciphertext" a claim you can check by reading one short file.

The module is code-split: Argon2id's WASM is fetched the first time a vault is touched, not
on first paint, for the same reason the charts are.

## Two locks on an inherited vault

An heir reading an owner's secrets requires two independent things to be true, and they are
deliberately kept apart:

- the **nomination's access level** is `vault` — the owner's stated intent, enforced by the
  API through `access_grants` like every other read; and
- the **escrow is released** — the event that actually happened, enforced by cryptography,
  because until then the wrapped key is never served.

`assertVaultReleased` in `services/nominee.service.ts` is the one function that checks both,
so no route can accidentally satisfy only half of the rule.

## The dead-man switch is derived, not driven

`evaluateDeadManSwitches` recomputes each user's stage from elapsed silence every time it
runs, and only writes when the stage changes. That makes the hourly sweep in `index.ts`
idempotent and safe to miss: a server that was off for a fortnight catches up on its next
tick, and a test moves the clock instead of waiting ninety days.

It also means an ordinary sign-in cancels a grace period on its own — below the inactivity
window the stage is a function of silence in both directions — rather than requiring the
owner to find a button while the clock runs down.

## Valuations are append-only

`valuations` is never updated in place. Every price refresh, manual edit or computed
accrual writes a new `(asset_id, as_of, value_paise, source)` row. The net-worth-over-time
chart is therefore real history rather than a reconstruction, and a bad price import can be
rolled back without losing anything.

## Price providers

One interface, three implementations:

| Provider | Covers | Notes |
| -------- | ------ | ----- |
| `manual` | everything | Always available. The fallback when a network provider fails. |
| `amfi` | mutual funds | Daily `NAVAll.txt`, free, no API key, ~38k schemes by scheme code / ISIN. |
| `yahoo` | equity / ETF | NSE/BSE have no official free REST API; this is best-effort and degrades to `manual`. |

A provider failure is never fatal. The holding keeps its last known price and the UI shows
a staleness badge with the `as_of` date.

## Directory conventions

```
apps/api/src/
  db/         schema, migrations runner, connection
  routes/     thin HTTP handlers — parse, delegate, respond
  services/   business logic (accrual, XIRR, escrow, backup)
  repos/      scoped data access
  middleware/ auth, csrf, rate limit, error handler
  providers/  price providers

apps/web/src/
  routes/     page components
  components/ reusable UI
  features/   feature-local state + hooks (assets, vault, nominees)
  lib/        api client, crypto, formatting
```

## Sessions

Two credentials with deliberately different designs:

| | Access token | Refresh token |
| --- | --- | --- |
| Form | Signed JWT (HS256) | Opaque 256-bit random string |
| Lifetime | `ACCESS_TOKEN_TTL` (15m) | `REFRESH_TOKEN_TTL` (30d) |
| Stored | Nowhere — stateless | HMAC only, in `refresh_tokens` |
| Cookie | `nt_access`, httpOnly, path `/` | `nt_refresh`, httpOnly, path `/api/auth` |

A JWT on the hot path keeps ordinary requests to one signature check. The refresh token
is *not* a JWT precisely because it must be revocable, and a self-validating token cannot
be taken back.

One login opens a **family**. Every refresh spends the current token and issues its
successor inside that family, so a captured token is useful only until the real client
next refreshes. Presenting an already-rotated token means either replay or a leaked
database — indistinguishable, and both answered the same way: the whole family is revoked
and that device chain must sign in again.

The family id is also the session id in the "signed-in devices" list, so a month-old
session shows as one device rather than the hundreds of token rows rotation has produced.
