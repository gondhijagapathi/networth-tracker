# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo scaffold: `apps/web`, `apps/api`, `packages/shared`.
- Toolchain: TypeScript project references, ESLint 9 flat config, Prettier,
  Conventional Commits via commitlint, husky hooks.
- Documentation set: architecture, data model, security model, backup/restore,
  India domain notes, and the phased build plan with a task tracker.
- GitHub CI running lint, typecheck, test and build.
- Auth and users (P1): invite-only registration, Argon2id password hashing,
  short-lived access JWTs in httpOnly cookies with rotating refresh tokens,
  refresh-token replay detection, CSRF double-submit, exponential login backoff,
  optional TOTP 2FA with single-use recovery codes, per-device session
  management, and admin user/invite management.
- SQLite schema and migration runner for `users`, `invites`, `refresh_tokens`,
  `recovery_codes`, `settings` and `audit_log`, applied on boot.
- `SECRET_ENCRYPTION_KEY` for encrypting server-readable secrets at rest,
  starting with TOTP seeds.
- Data model and asset CRUD (P2): `assets` plus a typed detail table for each of
  the nine types — bank accounts, deposits (FD/RD/PPF/SSY/NSC/KVP/MIS/SCSS),
  fund and equity holdings, insurance policies, property, retirement accounts,
  precious metals, the long tail, and liabilities — with `transactions`,
  append-only `valuations`, `instruments`, `instrument_prices` and `documents`.
- Identity tables the sharing features build on: `households`,
  `household_members`, `nominees` and `access_grants`.
- A scoped repository layer consulted by every read, and the nominee read-only
  guard. Rows outside a caller's scope answer `404`; grants never carry writes.
- Shared Zod contracts for every asset type, used unchanged by the client and
  re-parsed by the server, including account-number masking at the schema so no
  write path can store a full number.
- Scaled-integer quantities: units and per-unit prices in millionths, so a
  four-decimal NAV survives to the paise.
- `npm run db:seed -- --email you@example.com` for demo data.
- Dashboard and analytics (P3): net worth over time, allocation by class,
  institution, liquidity and type, XIRR and CAGR per asset, class and portfolio,
  and concentration, liquidity and nomination risk indicators — served from
  `/api/analytics` and assembled from a single scoped portfolio load, so the
  summary card, the allocation chart and the last point on the chart are the same
  figure computed once.
- A valuation engine that accrues rather than remembers: FD, RD, PPF, SSY, NSC,
  KVP, MIS and SCSS compound from their own terms, anchored on a reconciled
  valuation where the owner recorded one; holdings are priced at the most recent
  NAV or quote on or before the date, falling back to average cost; balances and
  manual figures are used as written, newest wins and ties go to the human.
- History is recomputed rather than replayed — every point on the net worth chart
  is the whole portfolio valued as of that date, so a deposit curves upward from a
  single opening entry instead of sitting flat until somebody updates it.
- Web application proper: routing, session-gated shell, dashboard, asset list with
  filter, sort and search held in the URL, per-type asset detail pages, create and
  edit forms driven by the shared Zod contracts, a returns page, and a privacy
  blur toggle.
- Zero-knowledge vault (P4): Argon2id key derivation in the browser via WASM, AES-256-GCM
  item encryption, a per-user RSA-OAEP-2048 keypair with the private half wrapped by the
  same derived key, unlock with a 15-minute idle auto-lock, and encrypted document upload
  where even the filename and MIME type are ciphertext. The server accepts a `{v, iv, ct}`
  envelope and nothing else — enforced at the Zod schema and again as a SQLite `CHECK` — and
  holds no value it could check a passphrase against.
- Changing the vault passphrase rewraps the data key rather than re-encrypting every item,
  and vault-unlock rate limiting, deferred from P1, now that there is an endpoint to meter.
- Nominees, escrow and the dead-man switch (P5): nominee invite and acceptance, a read-only
  heir portal at `summary` or `full`, the owner's data key wrapped to a nominee's public key
  and held sealed, owner-initiated release, and a switch that fires after a configurable
  silence (default 90 days, floor 30) with warnings at 50/75/90% and a grace period an
  ordinary sign-in cancels.
- The escrow records the fingerprint of the key it was wrapped to, recomputed server-side
  from the key on record, so an owner cannot be tricked into wrapping their data key to a
  substituted public key.
- Access level and escrow state are independent locks: a nominee with `vault` access before
  release sees ciphertext, and a released escrow under a narrower access level yields
  nothing. Both must open.
- Claim kit per asset and per household — institution, masked reference, the forms each
  Indian institution actually asks for (bank DA-1, LIC 3783, EPF Form 20, demat transmission
  annexures, MF T3), the documents required, and value sitting in unnominated assets. It
  prints from the browser rather than rendering server-side, because the vault plaintext it
  merges in exists only there.
- Audit rows for every vault read, escrow read, release and switch transition.
- Vault, nominee, inheritance and printable claim-kit screens, with the crypto module
  code-split so Argon2id's WASM is fetched when a vault is first touched rather than on
  first paint.
- Household and partner merge (P6): household creation, a partner invite an existing account
  accepts, and a per-member share-mode toggle (full / summary / none) that is entirely
  separate from joining — a member can be part of a household and share nothing. Every
  directed grant a household's membership implies is recomputed from scratch on each change
  (`syncHouseholdGrants`) rather than patched in place, so it can never drift from what the
  members currently consent to. Leaving or being removed closes access in both directions
  immediately. A `Household` screen exposes all of it.
- Price providers (P7): an AMFI `NAVAll.txt` parser and ingest that upserts `instrument_prices`
  by scheme code, a pluggable stock quote provider (off by default; `STOCK_PRICE_PROVIDER=yahoo`
  turns it on), a "refresh now" endpoint, and `NAV_REFRESH_CRON` driving both nightly via a
  small dependency-free cron matcher (`lib/cron.ts`). Manual pricing needed no new code — it
  is the existing write paths — and stays the fallback whenever a provider cannot reach the
  network or has never heard of an instrument. The asset list shows a "Refresh prices" action
  and flags a `market`-sourced price as stale once it is more than five days old.

### Changed

- `documents` is now always encrypted: the plaintext `filename`, `mime` and `encrypted`
  columns are replaced by a single encrypted `meta` envelope. The table had never been
  written to, so the migration rebuilds it rather than carrying dead columns.
