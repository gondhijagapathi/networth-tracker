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
  committed to `apps/api/migrations/` and applied on boot — no magic, and the schema
  history is readable in a diff.
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

The scope resolver reads `access_grants`, which is the union of:

- the caller's own assets,
- assets shared through an accepted `household_members` row, subject to `share_mode`,
- assets exposed to an active nominee grant (read-only, never writable).

A caller who is not in scope gets `404`, not `403` — existence itself is private.

## The vault is opaque to the server

Vault ciphertext passes through the API as bytes. There is no server-side code path that
can decrypt it, and the request schemas reject anything plaintext-shaped. See
[SECURITY-MODEL.md](./SECURITY-MODEL.md).

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
