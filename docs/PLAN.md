# Net Worth Tracker (India) — Design & Build Plan

## Context

`/home/jagapathi/MyProjects/networth-tracker` is an empty git repo (branch `main`, zero commits). Nothing to reuse; everything below is greenfield.

The goal is a **self-hosted, multi-user net worth tracker built for Indian households**. Indian personal finance is spread across instruments no global tracker models well — PPF, EPF, NPS, SSY, post-office schemes, LIC endowment policies, SGBs, physical gold, land with survey/khata numbers, and mutual funds tracked by AMFI scheme code rather than ticker. Worse, a large share of Indian household wealth goes **unclaimed after death** because heirs don't know the accounts exist, nomination was never registered, or the papers can't be found. RBI runs an entire portal (UDGAM) for unclaimed deposits; shares drift to IEPF; LIC policies lapse unclaimed.

So this app has two jobs:

1. **Know what you own** — every asset and liability in one place, valued, charted, with XIRR and allocation.
2. **Make sure it can be claimed** — nomination hygiene per asset, an encrypted vault for credentials and document locations, a nominee who can actually log in and see it, and a printable claim kit per institution.

Plus: partner accounts that can merge into one household view by mutual consent, SQLite as the only datastore, one-click encrypted backup/restore, and an ultra-modern mobile-first UI.

### Decisions locked with the user

| Decision | Choice |
|---|---|
| Deployment | Self-hosted, small circle. Admin invite codes, no open signup. |
| Secrets | **Zero-knowledge vault** — Argon2id → AES-256-GCM in the browser; server stores ciphertext only. |
| Prices | Manual entry is the always-available baseline; **AMFI NAV auto-refresh** and **stock price auto-refresh** layer on top behind one provider interface. |
| Stack | npm workspaces monorepo: Vite + React + TS + Tailwind web, Express + better-sqlite3 API. |

Not selected, parked in backlog: CAS PDF import (CAMS/KFintech, NSDL/CDSL).

---

## Architecture

```
networth-tracker/
├── apps/
│   ├── web/                 Vite + React 19 + TS + Tailwind v4 + Recharts
│   └── api/                 Express + better-sqlite3 + Drizzle ORM
├── packages/
│   └── shared/              zod schemas, TS types, money/XIRR/FY utils (imported by both)
├── data/                    gitignored — networth.db, uploads/, backups/
├── docs/                    PLAN.md, TASKS.md, ARCHITECTURE.md, SECURITY-MODEL.md,
│                            BACKUP.md, DATA-MODEL.md, INDIA-NOTES.md
└── .github/                 workflows/ci.yml, PR + issue templates
```

- **Single `npm run dev`** at root runs both workspaces concurrently; web proxies `/api` to the API port.
- **SQLite in WAL mode**, one file at `data/networth.db`. Drizzle ORM for typed queries; `drizzle-kit` generates plain numbered SQL migrations checked into `apps/api/migrations/` and applied on boot.
- **All money in integer paise** (`BIGINT`), never floats. Formatting to `₹1,23,45,678` happens only at the view layer via `Intl.NumberFormat('en-IN')`.
- **Every read is scoped** by `owner_user_id` plus explicit access grants, enforced in one repository layer — never ad-hoc in route handlers.

---

## Data model

Base + typed detail tables (not one JSON blob) — Indian instruments differ too much to share columns.

**Identity & access**
- `users` — email, argon2id password hash, name, role (`admin|member|nominee`), status, `last_active_at`, TOTP secret (encrypted).
- `invites` — code, email, role, expiry, consumed_by. Admin-issued; the only path to an account.
- `refresh_tokens` — hashed, rotating, revocable per device.
- `settings` — per-user KV: theme, lakh/crore display, privacy blur, FY start, partner-merge toggle.
- `households` / `household_members` — `role` (owner|partner|member), `share_mode` (full|summary|none), consent timestamps.
- `nominees` — owner → nominee user (or invitee), relation, share %, `access_level` (summary|full|vault), status.
- `access_grants` — the single table every scoped query consults. Owner, grantee, scope, granted/expires.
- `audit_log` — actor, action, entity, at, meta. Vault reads, nominee access, exports and dead-man events are all logged.

**Assets**
- `assets` (base) — owner, type, name, institution, `nominee_registered` (the flag the whole nomination dashboard hangs on), ownership %, joint-with, status, opened_on, tags, notes.
- Typed details, keyed 1:1 off `assets.id`:
  - `bank_accounts` — account no (masked at rest), IFSC, branch, CIF, type.
  - `deposits` — FD, RD, PPF, SSY, NSC, KVP, MIS, SCSS: principal, rate, compounding, start, maturity, payout mode, auto-renew. Accrued value is **computed**, not typed in.
  - `holdings` + `instruments` + `instrument_prices` — MF (AMFI scheme code, ISIN, folio, AMC, SIP) and equity/ETF (NSE/BSE symbol, DP ID, client ID, depository).
  - `insurance_policies` — LIC/private: policy no, plan, sum assured, premium & due date, term, maturity, type (term|endowment|ULIP|money-back). Term policies carry ₹0 asset value but still appear in the claim kit.
  - `properties` — land/flat: survey no, khata/patta, registration doc no, sub-registrar office, area, guideline vs market value, co-owners.
  - `retirement_accounts` — EPF (UAN, member ID), VPF, NPS (PRAN, Tier I/II, scheme mix).
  - `precious_metals` — physical/digital/SGB/jewellery: grams, purity, making charges, SGB maturity + 2.5% interest dates.
  - `other_assets` — crypto, ESOP/RSU (vesting), chit funds, loans given to relatives, vehicles.
- `liabilities` — home/car/personal/gold loan, credit card, loan against FD/property: principal, rate, EMI, tenure, next due. **Net worth = assets − liabilities.**
- `transactions` — buy/sell/SIP/dividend/interest/deposit/withdrawal, with units, amount, charges. Drives cost basis and XIRR.
- `valuations` — append-only `(asset_id, as_of, value_paise, source)`. This is what makes the net-worth-over-time chart real rather than reconstructed.
- `documents` — encrypted blobs on disk under `data/uploads/`, sha256 + metadata in DB.

---

## Zero-knowledge vault

The security-critical piece. Full write-up goes in `docs/SECURITY-MODEL.md`.

```
KEK  = Argon2id(vault passphrase, per-user salt, m=64MB t=3 p=4)   [browser only]
DEK  = random AES-256 key, encrypts every vault item (AES-256-GCM)
DB stores: wrapped_dek = AES-GCM(DEK, KEK)   +   {iv, ciphertext, tag} per item
```

- Passphrase and DEK **never leave the browser**. The API only ever receives opaque ciphertext. `POST /vault/items` with anything resembling plaintext is rejected by schema.
- Each user also gets an **RSA-OAEP-2048 keypair** (WebCrypto): public key stored plaintext, private key wrapped by their own KEK.
- **Nominee escrow**: owner wraps their DEK to the nominee's public key → stored in `vault_escrow` in `sealed` state. Server refuses to hand it over until either (a) the owner explicitly grants release, or (b) the dead-man switch fires.
- **Dead-man switch**: `enabled`, `inactivity_days` (default 90), `last_checkin_at`. Warning emails at 50%/75%/90% of the window, then a 7-day final grace period the owner can cancel with a single login. Every state change is audit-logged.
- **Honest limitation to document**: because you run the server, a person with root on the box could release an escrow early. The crypto protects the *data at rest and in backups* — it is not a defence against your own compromised host. `SECURITY-MODEL.md` says this in plain words rather than overclaiming.
- Vault auto-locks after 15 min idle; the key lives in memory only, never in `localStorage`.

---

## India-specific features

These are what separate this from a generic tracker.

- **Nomination hygiene dashboard** — "7 of 23 assets have no registered nominee", ranked by value at risk, with per-institution registration steps (EPFO e-nomination, bank Form DA-1, MF nomination via RTA, demat nomination, LIC endorsement).
- **Claim kit** — printable PDF per asset or per household: institution, masked account no, branch, registered nominee, exact forms needed (bank DA-1/DA-2, LIC 3783/3801, EPF Form 20/10D, demat transmission TRF + annexures, MF transmission T3), documents required (death certificate, KYC, indemnity, succession certificate thresholds), and where the physical papers are. Generated from vault data, so it renders client-side while the vault is unlocked.
- **Maturity & due calendar** — next 90 days: FD maturity, LIC premium, PPF ₹500 minimum before Mar 31, SSY deposit, SGB interest, EMI dates, insurance renewal.
- **Financial year everywhere** — Apr 1–Mar 31, labelled with the assessment year.
- **Tax estimates (clearly labelled estimates, not advice)** — unrealized LTCG/STCG split at the 12-month equity boundary with the ₹1.25L exemption; debt MF at slab post-Apr-2023; FD interest accrual with TDS and a 15G/15H reminder; an 80C bucket tracker (PPF + ELSS + LIC premium + SSY + home loan principal) against ₹1.5L; 80D.
- **Indian number formatting** — lakh/crore grouping and a compact "₹1.23 Cr" toggle.
- **XIRR / CAGR** — Newton–Raphson over `transactions`, per asset, per class, and portfolio-wide.
- **Allocation & risk** — equity/debt/gold/real-estate/cash mix, liquidity buckets, emergency-fund months, single-holding concentration warnings.
- **Privacy blur** — one tap hides every amount; essential for checking your net worth on a phone in public.

---

## Partner & nominee sharing

- **Partner merge is opt-in on both sides.** Owner enables in Settings → invites partner → partner accepts. Either can revoke instantly.
- Data ownership never transfers. The merged view is a **query-time union** with attribution (yours / partner's / joint), and joint assets are split by `ownership_percent` so nothing is double-counted.
- Per-member `share_mode` lets a partner expose `summary` (totals and allocation only) rather than `full` (every account).
- **Nominees log in as themselves** with a read-only portal — `summary` or `full` per the grant, and vault plaintext only after release. They can never write.

---

## Backup & restore

- **Online backup** via better-sqlite3's `db.backup()` — consistent snapshot while the app is running, no downtime, no file-copy corruption risk.
- Bundle = `snapshot.db` + `uploads/` + `manifest.json` (schema version, app version, row counts, sha256) → zip → **AES-256-GCM encrypted with a passphrase** → downloaded from Settings.
- **Restore** = upload → verify checksum → check schema version → take a pre-restore safety snapshot → run forward migrations → atomic swap. Refuses a newer-schema bundle rather than corrupting data.
- **Scheduled**: nightly `node-cron` job to `data/backups/` with configurable retention (default 14).
- **Portable exports**: full JSON, plus per-asset-class CSV, so the data is never trapped in this app.

---

## UI / theme

Dark-first, light mode supported, **mobile-first at every breakpoint**.

- Tailwind v4 CSS-variable tokens; a single palette defined once, dark/light swapped by token — no color hardcoded inside a media query.
- Layout: bottom tab bar on mobile → collapsible sidebar ≥ `lg`. Number-forward cards, generous whitespace, subtle depth (soft shadows + hairline borders), no heavy glassmorphism that hurts contrast.
- Inter / Geist with tabular numerals so amounts align in columns.
- Recharts for net worth over time, allocation donut, and per-asset growth; framer-motion for restrained micro-interactions; skeleton loaders on every async panel.
- Wide tables scroll inside their own container — the page body never scrolls horizontally.
- Installable **PWA** with an offline shell.
- WCAG AA contrast; every interactive element keyboard-reachable.

---

## Security baseline

Argon2id password hashing · short-lived access JWT in httpOnly `SameSite=Strict` cookies with rotating hashed refresh tokens · CSRF double-submit · rate limiting + backoff on login and vault unlock · optional TOTP 2FA · helmet + strict CSP · zod validation on every request body · account numbers masked at rest, full value only inside the vault · secrets only via `.env` (never committed; `.env.example` checked in) · `data/` fully gitignored.

---

## Build phases

Tracked as checkboxes in `docs/TASKS.md`, kept current as work lands.

| Phase | Deliverable |
|---|---|
| **P0** | Repo scaffold, workspaces, TS/ESLint/Prettier, husky + commitlint, CI, all `docs/`, LICENSE, README, SECURITY.md, `.gitignore`, `.env.example` |
| **P1** | Auth: invite-code registration, login, sessions, refresh rotation, TOTP, admin user management |
| **P2** | Full schema + migrations + seed; CRUD for every asset type and liabilities; `valuations`; `transactions` |
| **P3** | Dashboard: net worth over time, allocation, XIRR/CAGR, per-asset detail, filters |
| **P4** | Zero-knowledge vault: keypairs, Argon2id/WebCrypto, item CRUD, auto-lock, document encryption |
| **P5** | Nominees: invites, read-only portal, escrow wrapping, dead-man switch + warnings, claim-kit PDF |
| **P6** | Household/partner: consent flow, merged view with attribution, joint-ownership splits, revocation |
| **P7** | Price providers: AMFI NAV ingest, stock provider, nightly scheduler, staleness badges, manual fallback |
| **P8** | Backup/restore: encrypted bundle, scheduled backups, JSON/CSV export |
| **P9** | India extras: FY reports, tax estimates, maturity calendar, nomination hygiene dashboard |
| **P10** | Polish: PWA, privacy blur, a11y pass, Playwright E2E, docs, v1.0.0 release |

Backlog (post-v1): CAS PDF import, push notifications, goal tracking, multi-currency for NRI/RSU holdings, mobile app shell.

---

## Repo guidelines (in place before the first push)

- `README.md` — what it is, screenshots, quickstart, backup/restore, security posture.
- `CONTRIBUTING.md` — Conventional Commits, `feat/…` `fix/…` branch naming, PR checklist.
- `SECURITY.md` — threat model summary, responsible disclosure, explicit "self-hosted only, do not expose to the internet without TLS + reverse proxy".
- `CODE_OF_CONDUCT.md`, `LICENSE` (MIT), `CHANGELOG.md` (Keep a Changelog).
- `.github/` — PR template, bug/feature issue templates, `ci.yml` running lint + typecheck + test + build on push and PR.
- `.gitignore` — `node_modules/`, `data/`, `*.db*`, `.env*` (except `.env.example`), `dist/`, `coverage/`.
- Pre-commit: `lint-staged` (eslint + prettier) and a **secret scan** so no `.db` or `.env` is ever committed.
- `.nvmrc` pinned to Node 22 LTS.

---

## Verification

- **Unit (Vitest)** — XIRR against known cashflow sets; FD/PPF/SSY accrual against published maturity tables; Indian number formatting (`₹1,23,45,678`, "1.23 Cr"); FY boundary math; LTCG/STCG classification at the 12-month edge; vault encrypt→decrypt round-trip; escrow wrap→unwrap with a second keypair.
- **API (Supertest)** — auth flows; **isolation tests that assert user B gets 404 on every one of user A's assets**; nominee read-only enforcement (writes rejected); vault endpoints reject plaintext-shaped payloads; dead-man switch state machine including owner cancellation.
- **E2E (Playwright)** — register via invite → add an FD, an MF holding and a land record → see net worth → unlock vault → add credentials → invite a nominee → nominee logs in and sees summary but not vault → back up → restore into a clean DB → totals match exactly.
- **Manual** — `npm run dev`, walk the app at 375px and 1440px in both themes; trigger an AMFI NAV refresh and confirm holdings revalue with a fresh `as_of`; download an encrypted backup, wipe `data/`, restore, confirm row counts match the manifest.
- **CI gate** — lint, typecheck, unit + API tests, and a production build must pass before merge.
