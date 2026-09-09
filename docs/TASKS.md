# Task Tracker

Single source of truth for what is done, in progress and pending. Update this file
in the same commit as the work it describes — a phase is not "done" until its row
here says so and its tests pass.

**Status key:** `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked

Last updated: 2026-09-08 — P8, P9 and P10 complete. 475 unit and API tests plus 13
end-to-end tests passing; 0 npm vulnerabilities. This is v1.0.0.

---

## Progress

| Phase | Title | Status |
| ----- | ----- | ------ |
| P0 | Repo foundation & tooling | `[x]` done |
| P1 | Authentication & users | `[x]` done |
| P2 | Data model & asset CRUD | `[x]` done |
| P3 | Dashboard & analytics | `[x]` done |
| P4 | Zero-knowledge vault | `[x]` done |
| P5 | Nominees, dead-man switch & claim kit | `[x]` done |
| P6 | Household & partner merge | `[x]` done |
| P7 | Price providers | `[x]` done |
| P8 | Backup & restore | `[x]` done |
| P9 | India-specific features | `[x]` done |
| P10 | Polish & v1.0.0 release | `[x]` done |

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

- **Warnings are emailed, and recorded.** The 50/75/90% stages, the grace period opening and
  the release each queue an email as well as writing an audit row and raising a banner; the
  heirs are told separately when an escrow opens. On an instance with no `SMTP_HOST` the
  messages are recorded as `suppressed` and the banner is all there is, which the admin
  Email panel states rather than leaving anyone to assume otherwise.
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

Delivered together with P7: neither touches the other's tables, and both are additive
features sitting on top of scoping and pricing infrastructure P2 and P3 already built —
`resolveScope`, `access_grants` and `ownershipBps` for this phase; `instrument_prices` and
holding valuation for the next one. There was no reason to ship them apart.

- [x] Household creation, partner invite, two-sided consent
- [x] Settings toggle to enable/disable merged view
- [x] Merged net worth with attribution (yours / partner / joint, via the `shared` flag
      `asset.service.ts` has carried since P2)
- [x] `ownershipBps` splits so joint assets are not double-counted (unchanged from P2/P3 —
      this phase adds the grants that let a second person see the split, not the split itself)
- [x] `shareMode` (full / summary / none) enforcement
- [x] Instant revocation
- [x] Tests: revocation cuts access immediately; no double counting

Worth stating about what this phase turned out to be:

- **The merged dashboard, the `Shared` pill and the read-only guard already existed.** P2 and
  P3 built every consumer of `access_grants` generically, anticipating a household grantee
  alongside a nominee one — `readableOwnerIds`, `assertCanSeeDetail` and `AssetSummary.shared`
  never mention "household" by name. What this phase actually added is `household.service.ts`:
  the consent flow that writes and revokes the grants those consumers already knew how to
  read. That is a smaller phase than P4/P5 in code, and it is why P6 and P7 fit in one push.
- **Two consents, not one.** Joining a household (`acceptedAt`) and sharing your own data with
  it (`shareMode` + `consentedAt`) are separate acts — a member can accept an invitation and
  still share nothing, which is the Settings toggle TASKS.md called for. A grant only exists
  once the sharer has done both *and* the recipient has joined.
- **A grant is re-derived, never hand-edited.** Every mutation — accepting, changing a share
  mode, leaving — recomputes every directed grant a household's current membership implies,
  from scratch (`syncHouseholdGrants`). That is more database work than patching one row and
  removes an entire class of "the grant and the membership drifted apart" bugs.

Deliberately not in this phase:

- **A vault for household partners**, exactly as P4/P5 said: sharing a vault between two living
  people is a different consent problem than handing one to an heir, and it is not this
  phase's problem either. A household grant's `scope` is only ever `full` or `summary`.
- **A second invite system.** Inviting a partner requires an existing account on this
  instance — self-hosted, invite-only, small circle — so there is no new-account flow to
  build here the way there was for a nominee who might not exist yet.

## P7 — Price providers

- [x] Provider interface with `manual` always available as fallback (the existing manual
      valuation and instrument-price write paths; nothing new to build for it)
- [x] AMFI NAV ingest (parse `NAVAll.txt`, upsert `instrument_prices`)
- [x] Scheme search / autocomplete by AMFI code, ISIN, name (built in P2 — `GET /instruments`
      already searches all three)
- [x] Stock price provider (pluggable; Yahoo-style default, off unless `STOCK_PRICE_PROVIDER`
      is set to `yahoo`)
- [x] Nightly refresh scheduler + manual "refresh now"
- [x] Staleness badges and last-updated timestamps
- [x] Tests: parser against a fixture, fallback on provider failure

Worth stating about this phase too:

- **A holding was already priced from `instrument_prices`.** `valuation.service.ts` has taken
  units times "the most recent price on or before `asOf`" since P3. This phase only had to
  make that table's rows fresher; the moment AMFI ingest writes one, every holding of that
  scheme revalues on its next read with no other code path touching it.
- **`NAV_REFRESH_CRON` is a real cron schedule, not a plain interval.** The dead-man sweep
  gets away with `setInterval` because it only needs to run *often enough*; AMFI publishes
  once a day, after the market closes, and a job firing at a random hour would mostly re-fetch
  an unchanged file. `lib/cron.ts` is a small 5-field cron matcher rather than a dependency —
  matched against the server's local time, so an operator wanting 20:30 IST sets
  `TZ=Asia/Kolkata`, same as they would for `cron(8)` itself.
- **The Yahoo quote endpoint is unauthenticated best-effort.** It is exactly what
  `STOCK_PRICE_PROVIDER=yahoo` opts into and what PLAN.md called "Yahoo-style" rather than a
  commitment to a stable third-party API; a provider that starts blocking these requests fails
  the way any unreachable provider does — an error entry in the refresh result, manual pricing
  untouched. It is off by default, and `manual` needs no configuration to work.

## P8 — Backup & restore

- [x] Online snapshot via `db.backup()` — SQLite's own backup API, so the snapshot is
      consistent while the server keeps serving
- [x] Bundle: snapshot + uploads + manifest (applied migration list, app version, per-table
      row counts, SHA-256 of the snapshot and of every blob)
- [x] AES-256-GCM passphrase encryption of the bundle, keyed by Argon2id at the same
      parameters as a login password
- [x] Restore: verify every checksum, refuse a newer schema, write a safety bundle, then
      replace the data in one transaction
- [x] Nightly scheduled backups with retention
- [x] JSON + per-class CSV export
- [x] Tests: backup → wipe → restore → row counts and totals match, plus the container
      format on its own — wrong passphrase, flipped bit, edited header, unknown version

Worth stating about this phase:

- **It is a tar, not a zip, and that is the whole point.** Decrypted, a bundle is an ordinary
  `.tar.gz` that opens with tools that were on the machine before this application and will
  still be there after it. A backup format only its own program can read is a close relative
  of no backup at all, so `bundle.test.ts` asserts it against the system `tar` rather than
  leaving it as a comment.
- **A restore is a transaction, not a file swap.** The plan said "atomic swap"; swapping the
  file under a process that has it open leaves a running server holding a handle to a
  database nobody else can see. Instead the snapshot is attached and copied in inside a
  single transaction with `defer_foreign_keys`, so either every table is replaced or none is.
  Getting the ordering wrong here was caught by a test: deleting and inserting table by table
  meant emptying `users` — late in an alphabetical walk — cascaded away the assets restored a
  few tables earlier. Every delete now happens before any insert.
- **The schema check compares migration names, not a version number.** A name list says
  *which* schema rather than how far along it was, so a bundle whose migrations are a subset
  restores with newer columns taking their defaults, and one containing a migration this
  build has never seen is refused outright.
- **A scheduled backup needs a passphrase, and there is no fallback.** With `BACKUP_CRON` set
  and `BACKUP_PASSPHRASE` empty the job does not run, because writing an unencrypted copy of
  every account in the household to disk is not a default this application is willing to
  have. The boot log and the Settings screen both say the schedule is inactive — a household
  believing it has nightly backups it has never had is the worst available failure.

Deliberately not in this phase:

- **Rotating the vault's data key**, which P5 parked here on the grounds that it wanted a
  snapshot taken first. It still does, and the snapshot now exists — but re-encrypting every
  item and every document under a new key is a migration with its own failure modes, and
  bolting it onto the end of the backup work would have meant shipping it with the least
  testing of anything in this phase. It stays in the backlog, next to the CAS import.
- **Incremental or deduplicated backups.** A household's database is a few megabytes and
  compresses by roughly a factor of five; nightly full bundles at that size are cheaper than
  the bookkeeping required to avoid them.

## P9 — India-specific features

- [x] Nomination hygiene dashboard (value at risk, registration steps), grouped by
      institution because one visit usually fixes several
- [x] Maturity & due calendar (next 90 days by default), with recurring obligations expanded
      into one row per occurrence
- [x] Financial year reporting (Apr–Mar) with assessment year labels
- [x] Tax estimates: LTCG/STCG at the 12- and 24-month boundaries, the ₹1.25L exemption
      applied once across the portfolio, debt MF bought since April 2023 at slab
- [x] FD interest accrual, TDS per payer, 15G/15H reminder
- [x] 80C bucket tracker against ₹1.5L; 80D
- [x] Indian number formatting + lakh/crore toggle

Worth stating about the tax figures:

- **The exemption belongs to the year, not to the asset.** ₹1.25 lakh of equity long-term
  gain is free across the whole portfolio, once. Applying it per holding — the obvious
  mistake — would under-report the tax of anybody holding more than one fund, and there is a
  test that says so.
- **TDS is deducted on the whole interest once the threshold is crossed, not on the excess.**
  One rupee over and ₹5,000 is withheld rather than ten paise. That cliff is the entire
  reason Form 15G and 15H exist, and getting it wrong would understate the deduction by a
  factor of fifty thousand.
- **The threshold is per payer.** Four deposits at one branch cross it together while each
  sits under it alone, which is exactly what surprises people, so the report groups by
  institution rather than by deposit.
- **A slab rate is reported as unknown rather than as zero.** This application has never been
  told anybody's income. Those buckets show the gain and no tax figure, because zero would
  read as "not taxed", which is the opposite of what slab treatment means.
- **Interest is not a capital gain.** Deposits, EPF and insurance are excluded from the gains
  report and appear in the interest section instead, so the same rupee is never taxed twice
  on one screen — and PPF and SSY interest, exempt under section 10, is listed there but kept
  out of the taxable total.

Deliberately not in this phase:

- **Realized gains.** Everything here is unrealized, because the question worth answering in
  March is "if I sold this today, where would it land". A record of what has already been
  sold is a different report, and it needs disposal records this application does not keep.
- **Loss carry-forward and set-off across years.** Losses net within a bucket, which is what
  set-off does inside a year. Carrying them forward depends on what was realised and when,
  and on returns filed elsewhere.
- **A complete 80C picture.** Tuition fees, stamp duty on a house purchase and five-year
  tax-saver deposits are all eligible and none is something this app can see. The bucket
  reports what it found and says on the screen that it is not the whole story.

## P10 — Polish & v1.0.0 release

- [x] PWA manifest, icons, offline shell
- [x] Privacy blur mode (shipped in P3; the lakh/crore toggle beside it is new here)
- [x] Accessibility pass (WCAG AA, keyboard, focus states)
- [x] Playwright E2E covering the full happy path
- [x] README screenshots, deployment guide (`docs/DEPLOYMENT.md`)
- [x] `CHANGELOG.md` + version 1.0.0 across every workspace

Worth stating about this phase:

- **The accessibility pass found real failures rather than confirming a claim.** Contrast was
  measured by converting each oklch token to sRGB and computing the WCAG ratio, not by
  eyeballing it. In the light theme the semantic green came out at 2.3:1, amber at 2.0:1 and
  the brand accent at 2.8:1 against a white card; muted text passed only as large text in
  both themes; and white on the primary button was 3.8:1. Every token is now measured against
  the *darkest* surface it can appear on rather than the lightest — a colour that only passes
  on white is a colour that fails in the sidebar.
- **`Field` was putting hint text into every control's accessible name.** Nested inside the
  `<label>`, a hint becomes part of the name, so a screen reader announced "Value" as "Value
  Optional — deposits and funds are computed for you., edit text". Hints and errors are now
  attached with `aria-describedby`.
- **The service worker caches the shell and never an API response.** A cached net worth would
  survive a sign-out and outlive a revoked session. That means the app *launches* offline but
  does not *work* offline, which is stated in the file rather than implied by the word "PWA".
- **The end-to-end suite earned its runtime on its first run**, by finding that a brand-new
  installation showed the sign-in form to the one visitor who cannot use it. It is the only
  test that exercises the vault's Argon2id and WebCrypto as they actually ship.
- **The tab bar swapped Household for Planner.** Six tabs already share a phone's width;
  Household is configured once rather than checked, so it moved to the sidebar's secondary
  group with Settings and Admin.

Deliberately not in this phase:

- **A tagged release.** The version is 1.0.0 everywhere and the changelog entry is written,
  but `git tag` is left to the repository's owner rather than done on their behalf.
- **Cross-browser E2E.** One browser. Three would triple the runtime to re-test the same
  server, and the engine differences that remain are not what this suite is for.

---

## Notifications

- [x] SMTP transport with a Gmail-first setup path: App Password handling, `SMTP_SECURE`
      inferred from the port, STARTTLS required rather than attempted, and boot-time checks
      for the combinations that would otherwise fail at the first send
- [x] `email_outbox` — nothing sends on the request thread. Queued rows are delivered by a
      background loop with exponential backoff, retried for about two hours, then abandoned
      with an `email.failed` audit row
- [x] Bodies sealed at rest with `SECRET_ENCRYPTION_KEY` and cleared on delivery, because a
      pending row holds a live reset link or an unredeemed invite code
- [x] Twelve messages: admin invite, nominee invite, household invite, welcome, password
      reset, password changed, 2FA changed, dead-man warning / grace / fired, escrow
      released to an heir, and the admin's test message
- [x] Password reset end to end — no enumeration, single-use hourly links, second factor
      still required, every session revoked, and an alert to the account afterwards
- [x] Admin Email panel: whether mail is configured, the queue, the failures with the mail
      server's own words, a retry button, and a test send to the admin's own address
- [x] Suppressed rather than dropped when no transport is configured, so an operator can see
      what their household was not told
- [x] Emailed check-in links, so answering a dead-man warning needs no sign-in. Single use,
      30 days, and deliberately two steps — the link opens a page and a human presses a
      button, because mail scanners prefetch links and one answering on a dead owner's
      behalf would stop the switch ever firing

## Backlog (post-v1)

- [ ] CAS PDF import (CAMS / KFintech, NSDL / CDSL)
- [ ] Push notifications. Email now exists — see "Notifications" above — but a phone that
      buzzes is a better dead-man warning than an inbox somebody is not reading either
- [ ] Rotating the vault's **data** key, which is the only real answer to a released escrow.
      Deferred from P5 to P8 to here: it re-encrypts every item and every document at once,
      and it wanted a backup taken first — which now exists
- [ ] Rewriting `holdings.units` and average cost from transaction history, which belongs next
      to the CAS import that would produce the volume of transactions to justify it
- [ ] Realized capital gains, which need disposal records this application does not keep
- [ ] Goal tracking (retirement, child education)
- [ ] Multi-currency for NRI and RSU holdings
- [ ] Mobile app shell
