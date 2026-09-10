# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Fill in SIP months.** A running SIP is one identical transaction a month, and nobody
  types forty-eight of those by hand — so what actually gets recorded is a single lump sum,
  which prices every instalment as if it were paid on the first day and reports an XIRR that
  is not merely rough but wrong. The asset page now takes the instalment, the day it debits
  and the window it ran, and writes the months itself. Months already carrying a `sip` row
  are skipped, so a re-run or a widened window adds what is missing rather than doubling the
  invested figure, and the whole set lands in one database transaction. Units are not split
  across the instalments: each bought whatever that day's NAV allowed, and a made-up share
  would be a made-up cost basis.
- **A screen to turn two-factor authentication on.** The TOTP machinery — enrol, confirm,
  disable, recovery codes, and a sign-in form that asks for a code — has been complete since
  P1, but nothing in the interface could reach it, which means the installation did not
  really have it. Settings now runs the enrolment conversation, confirms a live code before
  switching anything on, and shows the recovery codes once, on their own. The QR is drawn in
  the browser from an encoder imported on demand: an `otpauth` URI carries the secret, so it
  never goes to a rendering service, and the main bundle does not carry the encoder for the
  sessions that never enrol.

- `scripts/deploy.sh`, one command that installs, configures, upgrades and operates a
  container deployment. It checks Docker is present and reachable, downloads the source,
  generates the three secrets itself, asks only the four questions that have no safe default
  — invite code, port, whether an HTTPS proxy sits in front, backup passphrase — writes a
  `.env` at mode 600, then builds, starts and waits for the API to report healthy, printing
  the log and the offending variable if it does not. `upgrade` takes a backup *before*
  fetching, because migrations run at boot and are not reversible, and reconciles new
  settings into an existing `.env` without ever overwriting it. Also `status`, `logs`,
  `backup`, `start`, `stop`, `restart` and an `uninstall` that asks about the data volume
  separately, twice.
- Docker deployment as a supported alternative to running from source: a multi-stage
  `Dockerfile` building an `api` image and an nginx `web` image, a `docker-compose.yml`
  wiring them together over a named volume, and a Docker section in `docs/DEPLOYMENT.md`.
  The layout mirrors the bare-metal one rather than inventing a second architecture — the
  API publishes no port and is reachable only through nginx, which is what makes the single
  trusted proxy hop it assumes actually true. The container runs as the unprivileged `node`
  user and carries a healthcheck against `/api/health`.

### Fixed

- `COOKIE_SECURE=false` was read as **true**. The variable was parsed with
  `z.coerce.boolean()`, which is `Boolean(value)` — under which every non-empty string,
  including the literal `false` shipped in `.env.example`, is true. Two consequences: the
  documented boot-time refusal of `COOKIE_SECURE=false` in production could never fire, and
  a plain-HTTP installation set the `Secure` flag on its session cookies, so the browser
  dropped them and sign-in silently did nothing. Missed by the test suites because browsers
  treat `localhost` as a secure context and accept the cookie there regardless; it would
  have bitten the first person to run this on a LAN address. The value is now parsed as the
  word `true` or `false`, and anything else is a boot-time error.
- A first `docker compose up` following the documented steps could not start. Compose sets
  `NODE_ENV=production`, which requires `COOKIE_SECURE=true`, while `.env.example` ships
  `false` — correct for `npm run dev`, fatal here — so a copied `.env` produced a
  crash-looping container whose reason was only visible in `docker compose logs`. Compose
  now pins `COOKIE_SECURE` alongside the other container-shaped values it already owned.

## [1.0.0] — 2026-09-08

The first release. Every phase in `docs/TASKS.md` is complete: assets, analytics, the
zero-knowledge vault, nominees and the dead-man switch, household merge, price providers,
encrypted backup and restore, the India-specific reports, and the installable front end.

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
- An administration screen at `/admin`, admin-only: issue and withdraw invites (the code is
  shown once, because only its hash is stored), and see every account with controls to change
  a role, suspend or reactivate, and sign somebody out of every device. The API behind it has
  existed since P1 and had no UI. It is reachable from the foot of the sidebar rather than the
  bottom tab bar — administration is operational chrome, not a section you check — and it
  shows nobody's assets, because no endpoint under `/api/admin` can read them.

- Backup and restore (P8): a single passphrase-encrypted `.ntb` bundle holding a consistent
  `db.backup()` snapshot, every uploaded blob, and a manifest carrying the applied migration
  list, per-table row counts and SHA-256 checksums. Argon2id at the same parameters as a
  login password derives the key; AES-256-GCM seals it with the plaintext header
  authenticated as additional data, so weakening the recorded work factor breaks the bundle
  rather than cheapening it.
- The bundle is a gzipped tar rather than a zip, deliberately: decrypted, it opens with
  `tar` on any machine, so the data outlives this application. A test asserts that against
  the system `tar` rather than the claim being a comment.
- Restore verifies every checksum, refuses a bundle whose migration list contains anything
  this installation has not applied, writes a `pre-restore-` safety bundle, and only then
  replaces the data — by attaching the snapshot and copying it in **inside one transaction**
  with foreign keys deferred to commit, rather than swapping a file under a running process.
  Row counts are reported back against the manifest, with any mismatch surfaced as a warning.
- Nightly backups on `BACKUP_CRON`, with retention that prunes only the automatic bundles.
  They require `BACKUP_PASSPHRASE`: with none set the schedule does not run, and both the
  boot log and the Settings screen say so rather than implying a safety net that does not
  exist.
- `npm run backup`, `npm run backup:list` and `npm run restore` open the database directly
  rather than the HTTP API, so they work when the server does not — which is the situation
  the disaster checklist in `docs/BACKUP.md` assumes.
- Portable exports: full JSON with exact integer paise and typed detail, and per-asset-class
  CSV in rupees with a UTF-8 BOM so Excel on Windows reads a rupee sign correctly. Scoped to
  the caller's own rows rather than their household's, and carrying vault items as the
  ciphertext they are stored as.
- India-specific reports (P9) at `/api/india`: a nomination hygiene report ranking
  unnominated assets by value at risk with the registration steps for each institution; a
  due calendar expanding maturities, premiums, EMIs, SIPs, RD instalments, SGB coupons and
  the PPF and SSY minimums into one row per occurrence; and a financial-year report with
  unrealized gains split by treatment, deposit interest accrued to date, and the 80C and 80D
  buckets against their limits.
- `TAX_RATES`, one entry per financial year, so a Budget change is a data edit. A year with
  no entry uses the most recent earlier one **and the response says so**, rather than showing
  last year's figures as though they were this year's.
- Every tax figure is labelled an estimate, and the rates used are printed on the page.
  Buckets whose rate depends on an income slab this application has never been told report
  the gain and no tax figure at all, rather than a misleading zero.
- A Planner screen carrying all three reports, and a Settings screen with backup, restore,
  export, and display preferences.
- Progressive web app (P10): a manifest, generated icons, an `apple-touch-icon`, and an
  offline shell served by a hand-written service worker that caches the app shell and
  **never** an `/api` response — a cached net worth would outlive a sign-out and a session
  revocation.
- A lakh/crore toggle. Amounts follow the reader's preference unless a screen has a reason to
  override it, and the exact figure stays in the element's `title` either way.
- Playwright end-to-end coverage of the whole journey in a real browser: register with the
  bootstrap code, add assets, read the planner, create a vault with real Argon2id and
  WebCrypto, invite a nominee, confirm the server refuses their writes, back up, archive an
  asset, restore, and check the net worth comes back to the same figure.
- `npm run screenshots -w @networth/e2e` regenerates the README's screenshots from a
  throwaway database, so they cannot age into a picture of a version that no longer exists.
- `docs/DEPLOYMENT.md`: reverse proxy, systemd unit, upgrades, and where the default data
  paths actually land.

### Changed

- **Accessibility.** A measured contrast pass replaced tokens that were failing WCAG AA: in
  the light theme the semantic green, amber and brand colours were between 2.0:1 and 2.8:1
  against a white card, and muted text passed only as large text in both themes. Every text
  token is now measured against the *darkest* surface it can land on rather than the
  lightest, and white on the primary button moved from 3.8:1 to 5.3:1.
- `Field` associates its hint and error with `aria-describedby` instead of nesting them
  inside the `<label>`, where they became part of each control's accessible name — a screen
  reader announced the "Value" field as "Value Optional — deposits and funds are computed for
  you., edit text".
- A skip link, a focusable `<main>`, and named navigation landmarks.
- The bottom tab bar swaps Household for Planner; Household, Settings and Admin now sit
  together as the sidebar's secondary group, since none of them is a section you *check*.
- `documents` is now always encrypted: the plaintext `filename`, `mime` and `encrypted`
  columns are replaced by a single encrypted `meta` envelope. The table had never been
  written to, so the migration rebuilds it rather than carrying dead columns.

### Fixed

- A fresh installation showed the **sign-in** form to the one visitor who cannot use it,
  under a paragraph telling them to enter the bootstrap invite code, with no field to enter
  it into. The mode was seeded from `bootstrapRequired` on first render, before the request
  that answers it had returned; it is now derived, so it follows the answer whenever the
  visitor has not chosen otherwise. Found by the end-to-end suite on its first run.
- The financial-year report's interest headline included tax-exempt PPF and SSY interest
  while the per-payer breakdown beneath it did not, so a tax page showed two totals that
  could not be reconciled. The headline is now the taxable figure, with the exempt part
  stated separately.
- `BACKUP_CRON` and `NAV_REFRESH_CRON` are parsed at boot rather than at their first tick, so
  a typo stops the process with a clear message instead of throwing at 02:00.
