# Task Tracker

Single source of truth for what is done, in progress and pending. Update this file
in the same commit as the work it describes — a phase is not "done" until its row
here says so and its tests pass.

**Status key:** `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked

Last updated: 2026-09-06 — P0 complete, 0 npm vulnerabilities

---

## Progress

| Phase | Title | Status |
| ----- | ----- | ------ |
| P0 | Repo foundation & tooling | `[x]` done |
| P1 | Authentication & users | `[~]` next |
| P2 | Data model & asset CRUD | `[ ]` pending |
| P3 | Dashboard & analytics | `[ ]` pending |
| P4 | Zero-knowledge vault | `[ ]` pending |
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

- [ ] `users`, `invites`, `refresh_tokens`, `settings` tables
- [ ] Argon2id password hashing
- [ ] Bootstrap admin from `BOOTSTRAP_INVITE_CODE` on first run
- [ ] Invite-code registration (no open signup)
- [ ] Login / logout, httpOnly cookies, rotating refresh tokens
- [ ] CSRF double-submit token
- [ ] Rate limiting + backoff on login and vault unlock
- [ ] Optional TOTP 2FA (enrol, verify, recovery codes)
- [ ] Admin user management (invite, suspend, revoke sessions)
- [ ] Auth middleware + `requireRole` guard
- [ ] Tests: full auth flow, expiry, rotation, replay rejection

## P2 — Data model & asset CRUD

- [ ] Drizzle schema for all identity, asset, liability and audit tables
- [ ] Migration runner applied on boot; seed script for demo data
- [ ] Scoped repository layer (owner + `access_grants`) used by every query
- [ ] CRUD: bank accounts, deposits (FD/RD/PPF/SSY/NSC/KVP/MIS/SCSS)
- [ ] CRUD: holdings + instruments (MF by AMFI code, equity by symbol)
- [ ] CRUD: insurance policies, properties, retirement accounts
- [ ] CRUD: precious metals, other assets, liabilities
- [ ] `transactions` and append-only `valuations`
- [ ] Zod schemas in `@networth/shared` shared by client and server
- [ ] Tests: cross-user isolation returns 404 on every asset type

## P3 — Dashboard & analytics

- [ ] Net worth over time (from `valuations`)
- [ ] Allocation by class / institution / liquidity
- [ ] XIRR (Newton–Raphson) and CAGR per asset, class, portfolio
- [ ] Deposit accrual engine (FD/RD/PPF/SSY compounding)
- [ ] Asset list with filter, sort, search
- [ ] Asset detail pages per type
- [ ] Concentration and emergency-fund indicators

## P4 — Zero-knowledge vault

- [ ] Argon2id KDF in browser (WASM), AES-256-GCM item encryption
- [ ] Per-user RSA-OAEP keypair; private key wrapped by KEK
- [ ] Vault unlock / auto-lock (15 min idle), key held in memory only
- [ ] Vault item CRUD — server accepts ciphertext only
- [ ] Encrypted document upload
- [ ] Tests: round-trip, wrong passphrase fails, plaintext payloads rejected

## P5 — Nominees, dead-man switch & claim kit

- [ ] Nominee invite and acceptance
- [ ] Read-only nominee portal (`summary` / `full` access levels)
- [ ] DEK escrow wrapped to nominee public key, `sealed` state
- [ ] Dead-man switch: check-in, warning stages, grace period, cancel
- [ ] Owner-initiated manual release
- [ ] Claim-kit PDF generation (per asset and per household)
- [ ] Audit log for every vault read, release and state change
- [ ] Tests: state machine, nominee writes rejected, escrow unwrap

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
