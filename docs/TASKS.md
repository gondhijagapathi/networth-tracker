# Task Tracker

Single source of truth for what is done, in progress and pending. Update this file
in the same commit as the work it describes — a phase is not "done" until its row
here says so and its tests pass.

**Status key:** `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked

Last updated: 2026-09-07 — P4 and P5 complete, 375 tests passing, 0 npm vulnerabilities

---

## Progress

| Phase | Title | Status |
| ----- | ----- | ------ |
| P0 | Repo foundation & tooling | `[x]` done |
| P1 | Authentication & users | `[x]` done |
| P2 | Data model & asset CRUD | `[x]` done |
| P3 | Dashboard & analytics | `[x]` done |
| P4 | Zero-knowledge vault | `[~]` next |
| P5 | Nominees, dead-man switch & claim kit | `[ ]` pending |
| P6 | Household & partner merge | `[ ]` pending |
| P7 | Price providers | `[ ]` pending |
| P8 | Backup & restore | `[ ]` pending |
| P9 | India-specific features | `[ ]` pending |
| P10 | Polish & v1.0.0 release | `[ ]` pending |

---

## P0 — Repo foundation & tooling

- [x] Create npm workspaces monorepo (`apps/web`, `apps/api`, `packages/shared`)
- [x] `.gitignore` covering `data/`, `*.db`, `.env`
- [x] `.nvmrc`, root `package.json`, engines
- [x] TypeScript project references + strict `tsconfig.base.json`
- [x] ESLint 9 flat config + Prettier + `eslint-config-prettier`
- [x] Commitlint (Conventional Commits) with scope enum
- [x] `.env.example` with every variable documented
- [x] `docs/PLAN.md` (approved design) and `docs/TASKS.md` (this file)
- [x] `docs/ARCHITECTURE.md`, `DATA-MODEL.md`, `SECURITY-MODEL.md`, `BACKUP.md`, `INDIA-NOTES.md`
- [x] `README.md`, `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`
- [x] `.github/` — CI workflow, PR template, issue templates
- [x] Husky hooks: pre-commit (lint-staged + secret scan), commit-msg (commitlint)
- [x] Workspace scaffolds build and typecheck clean
- [x] Verify `better-sqlite3` loads on the installed Node version (Node 26.8.1, SQLite 3.53.4)
- [x] Initial commit on `main`
- [x] Money / financial-year / XIRR helpers in `@networth/shared` with 33 passing tests
- [x] Theme tokens (dark-first, light supported) and responsive app shell
- [x] Pinned `allowScripts` approvals for `better-sqlite3` and `esbuild` (npm 12 blocks
      install scripts by default; pinning means a new version needs re-approval)

## P1 — Authentication & users

- [x] `users`, `invites`, `refresh_tokens`, `settings` tables (plus `recovery_codes`
      and `audit_log`), with SQLite `CHECK` constraints on every enum column
- [x] Migration runner applying committed SQL on boot, with `db:migrate` / `db:status`
- [x] Argon2id password hashing (m=64MB, t=3, p=4) with a constant-time miss path
- [x] Bootstrap admin from `BOOTSTRAP_INVITE_CODE` on first run
- [x] Invite-code registration (no open signup); codes stored hashed, shown once
- [x] Login / logout, httpOnly `SameSite=Strict` cookies, rotating refresh tokens
- [x] Refresh-token families with replay detection (a replayed token revokes the family)
- [x] CSRF double-submit token
- [x] Rate limiting + exponential backoff on login (per email *and* per address) and
      on invite redemption
- [x] Optional TOTP 2FA (enrol, confirm, recovery codes); seed encrypted at rest
- [x] Admin user management (invite, suspend, reactivate, change role, revoke sessions)
      with guards against locking out the last admin
- [x] Auth middleware + `requireRole` guard; role and status re-read per request so
      suspension takes effect immediately
- [x] Per-device session list and single-device revocation
- [x] Tests: full auth flow, expiry, rotation, replay rejection, CSRF, backoff,
      2FA, admin guards, and a schema/migration drift check

Deferred to the phase that needs it:

- Vault-unlock rate limiting moves to **P4**, where the unlock endpoint exists. The
  limiter itself is built and covered by tests.
- The blanket nominee read-only guard moves to **P2**, where the data routes it must
  wrap are introduced. Mounting it in P1 would have been dead middleware that looked
  like protection without providing any.

## P2 — Data model & asset CRUD

- [x] Drizzle schema for all identity, asset, liability and audit tables —
      `households`, `household_members`, `nominees`, `access_grants`, `assets` and its nine
      detail tables, `instruments`, `instrument_prices`, `transactions`, `valuations`,
      `documents`, with a SQLite `CHECK` on every enum column
- [x] Migration runner applied on boot; `db:seed` fills an existing account with a
      household's worth of demo assets, refusing to run twice or against production
- [x] Scoped repository layer (owner + `access_grants`) used by every query; no route
      handler writes its own owner filter
- [x] CRUD: bank accounts, deposits (FD/RD/PPF/SSY/NSC/KVP/MIS/SCSS)
- [x] CRUD: holdings + instruments (MF by AMFI code, equity by symbol), find-or-create so a
      second household adding the same fund shares one NAV history
- [x] CRUD: insurance policies, properties, retirement accounts
- [x] CRUD: precious metals, other assets, liabilities
- [x] `transactions` and append-only `valuations`; a same-day correction wins over what it
      corrects, and nothing updates a valuation in place
- [x] Zod schemas in `@networth/shared` shared by client and server, including the
      account-number masking SECURITY-MODEL.md requires — enforced at the schema, so no
      write path (routes, seed, future imports) can store a full number
- [x] Units and per-unit prices as integers scaled by a million, so a four-decimal NAV
      survives multiplication to the paise
- [x] The nominee read-only guard, deferred from P1, now that there are data routes to wrap
- [x] Tests: cross-user isolation returns 404 on every asset type, on every endpoint;
      grants open reads and never writes; a summary grant stops short of detail; revoking or
      expiring a grant closes access immediately

Deliberately not in this phase:

- **Transactions do not move a holding's units or average cost.** Recording an SIP writes a
  cashflow; `holdings.units` stays whatever the owner set. Wiring the two together is the
  cost-basis engine, and it belongs with XIRR in **P3** rather than as a side effect of a
  CRUD endpoint.
- **No asset UI.** P2 is the data model and the API; the asset list, detail pages and forms
  are P3's work, alongside the dashboard they sit next to.

## P3 — Dashboard & analytics

- [x] Net worth over time (from `valuations`), recomputed per sample date rather than
      replayed, so a deposit curves upward from a single opening entry
- [x] Allocation by class / institution / liquidity — and by type; every dimension
      available in one round trip
- [x] XIRR (Newton–Raphson) and CAGR per asset, class, portfolio
- [x] Deposit accrual engine (FD/RD/PPF/SSY compounding), anchored on a reconciled
      valuation where the owner has recorded one
- [x] Asset list with filter, sort, search — state in the URL, so a filtered list is a link
- [x] Asset detail pages per type
- [x] Concentration and emergency-fund indicators, plus value sitting in unnominated assets

Worth stating about the returns figures:

- **CAGR is reported only where it is true.** It describes one sum in and one value out, so
  an asset with instalments gets XIRR and no CAGR, and the class and portfolio rollups —
  many assets, many purchase dates — carry XIRR alone. Averaging members' CAGRs would
  produce a number that looks like a return and is not one.
- **Returns are gross; net worth is not.** Performance runs full cashflows against the full
  value, because pairing an ownership-adjusted value with unadjusted transactions yields a
  rate that is simply wrong. The `ownership_percent` split belongs on net worth, where it
  is applied.
- **Liabilities are left out of returns entirely.** A home loan's XIRR is its interest rate:
  a true number, and a confusing one on a page headed "how are my investments doing".

Deliberately not in this phase:

- **The cost-basis engine still does not move a holding's units or average cost.** P2
  deferred it here on the grounds that it belonged with XIRR; in the event, XIRR is
  computed from the recorded cashflows directly and needs no running average to do it.
  Rewriting `holdings.units` from transaction history is a data-migration question rather
  than an analytics one, and it is better answered next to the CAS import in the backlog
  that would produce the volume of transactions to justify it.

## P4 — Zero-knowledge vault

Delivered together with P5: the escrow in P5 is the reason the keypair in P4 exists, and
building the two apart would have meant shipping a keypair with nothing to wrap to.

- [x] Argon2id KDF in the browser (`hash-wasm`, no `SharedArrayBuffer`, so no cross-origin
      isolation headers to configure), AES-256-GCM item encryption
- [x] Per-user RSA-OAEP-2048 keypair; public key plaintext, private key wrapped by the KEK
- [x] Vault unlock, auto-lock after 15 minutes idle, keys held in refs and never in
      `localStorage`; a reload locks the vault
- [x] Vault item CRUD — the server accepts a `{v, iv, ct}` envelope and nothing else, at the
      Zod schema and again as a SQLite `CHECK`
- [x] Encrypted document upload: filename and MIME encrypted too, ciphertext IV-prefixed on
      disk so a blob restored from a backup needs nothing from the database
- [x] Passphrase change that rewraps the key rather than re-encrypting every item
- [x] Vault-unlock rate limiting, deferred here from P1, plus an audit row per retrieval
- [x] Tests: round-trip through the real API, wrong passphrase fails, seven shapes of
      plaintext-looking payload rejected, one user's vault invisible to another — plus the
      browser's `vaultCrypto.ts` tested as it ships (Argon2id at the real parameters,
      tampered ciphertext rejected, private keys non-extractable), so the mirror the API
      tests use cannot drift away from it unnoticed

## P5 — Nominees, dead-man switch & claim kit

- [x] Nominee invite (an ordinary invite with `role: 'nominee'`) and acceptance, which links
      on registration by email address and writes the access grant
- [x] Read-only nominee portal; `summary` stops short of asset detail and of the claim kit
- [x] DEK escrow wrapped to the nominee's public key, `sealed` until released, with the key
      fingerprint recomputed server-side so an owner cannot be tricked into wrapping to a
      substituted key
- [x] Dead-man switch: check-in, warning stages at 50/75/90%, grace period, cancel — and an
      hourly sweep that derives the stage from elapsed silence, so an ordinary sign-in during
      the grace period cancels it without the owner finding a button
- [x] Owner-initiated manual release
- [x] Claim kit per asset and per household, printed from the browser
- [x] Audit log for every vault read, escrow read, release and state change
- [x] Tests: the full state machine over a moved clock, nominee writes rejected everywhere,
      escrow unwrap end to end — an heir decrypting a secret they could not read one request
      earlier

Worth stating plainly about both phases:

- **Warnings are recorded, not emailed.** There is no mail transport in this build, so the
  50/75/90% stages write audit rows and raise a banner the owner sees on their next visit.
  That is weaker than the design in PLAN.md intends. Email and push are in the backlog, and
  saying so here is better than a checked box implying an email that never went out.
- **Release is one-way.** Revoking a nominee closes their grant and revokes the escrow, so
  the server will not serve the key again — but an heir who already fetched it holds a copy
  of the data key. Taking that back would mean re-encrypting every item under a new key. The
  UI says so at the point of release.
- **The claim kit prints from the browser rather than rendering a PDF on the server.** The
  kit is only complete once vault plaintext is merged into it, and the only place that
  plaintext exists is the browser. A server-rendered PDF would require the server to hold it,
  and the zero-knowledge claim would stop being true. `window.print()` against a print
  stylesheet produces the same PDF and keeps the guarantee.

Deliberately not in these phases:

- **Re-encrypting the vault under a new data key.** A passphrase change rewraps the key, which
  is the operation people actually want. Rotating the *data* key — the only real answer to a
  released escrow — touches every item and every document at once, and belongs next to the
  backup and restore machinery in **P8** that can take a snapshot before it starts.
- **A vault for household partners.** Sharing a vault between two living people is not the
  same problem as handing one to an heir, and the consent flow it needs is **P6**'s.

## P6 — Household & partner merge

- [ ] Household creation, partner invite, two-sided consent
- [ ] Settings toggle to enable/disable merged view
- [ ] Merged net worth with attribution (yours / partner / joint)
- [ ] `ownership_percent` splits so joint assets are not double-counted
- [ ] `share_mode` (full / summary / none) enforcement
- [ ] Instant revocation
- [ ] Tests: revocation cuts access immediately; no double counting

## P7 — Price providers

- [ ] Provider interface with `manual` always available as fallback
- [ ] AMFI NAV ingest (parse `NAVAll.txt`, upsert `instrument_prices`)
- [ ] Scheme search / autocomplete by AMFI code, ISIN, name
- [ ] Stock price provider (pluggable; Yahoo-style default)
- [ ] Nightly refresh scheduler + manual "refresh now"
- [ ] Staleness badges and last-updated timestamps
- [ ] Tests: parser against a fixture, fallback on provider failure

## P8 — Backup & restore

- [ ] Online snapshot via `db.backup()`
- [ ] Bundle: snapshot + uploads + manifest (schema version, checksums)
- [ ] AES-256-GCM passphrase encryption of the bundle
- [ ] Restore: verify, version check, safety snapshot, atomic swap
- [ ] Nightly scheduled backups with retention
- [ ] JSON + per-class CSV export
- [ ] Tests: backup → wipe → restore → row counts and totals match

## P9 — India-specific features

- [ ] Nomination hygiene dashboard (value at risk, registration steps)
- [ ] Maturity & due calendar (next 90 days)
- [ ] Financial year reporting (Apr–Mar) with assessment year labels
- [ ] Tax estimates: LTCG/STCG, ₹1.25L exemption, debt MF at slab
- [ ] FD interest accrual, TDS, 15G/15H reminder
- [ ] 80C bucket tracker against ₹1.5L; 80D
- [ ] Indian number formatting + lakh/crore toggle

## P10 — Polish & v1.0.0 release

- [ ] PWA manifest, icons, offline shell
- [ ] Privacy blur mode
- [ ] Accessibility pass (WCAG AA, keyboard, focus states)
- [ ] Playwright E2E covering the full happy path
- [ ] README screenshots, deployment guide
- [ ] `CHANGELOG.md` + tag `v1.0.0`

---

## Backlog (post-v1)

- [ ] CAS PDF import (CAMS / KFintech, NSDL / CDSL)
- [ ] Email and push notifications
- [ ] Goal tracking (retirement, child education)
- [ ] Multi-currency for NRI and RSU holdings
- [ ] Mobile app shell
