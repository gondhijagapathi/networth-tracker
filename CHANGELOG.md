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
