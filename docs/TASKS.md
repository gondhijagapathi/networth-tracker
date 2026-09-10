# Task Tracker

What is still open, and what has to be true before something moves. Update this file in
the same commit as the work it describes — a task is not done until its line here says so
and its tests pass.

**Status key:** `[ ]` pending · `[~]` in progress · `[x]` done, kept only until it ships in
a release · `[!]` blocked

Last updated: 2026-09-10 — 537 unit and API tests across 32 files, plus 13 end-to-end
tests, passing. Shipping version is 1.0.0.

> The v1.0.0 checklists that used to fill this file are gone; every one of them was
> ticked. The reasoning behind them — why each phase is shaped the way it is, and what it
> deliberately left out — moved to [`DECISIONS.md`](DECISIONS.md). Read that before
> reopening a settled question.

---

## Shipped

| Area | Where it lives |
| ---- | -------------- |
| Auth, invites, TOTP, admin user management | `apps/api/src/routes/auth.ts`, `admin.ts` |
| Asset, liability, transaction and valuation model | `apps/api/src/db/schema.ts`, `services/asset.service.ts` |
| Dashboard, allocation, XIRR/CAGR, deposit accrual | `services/analytics.service.ts`, `apps/web/src/routes/Dashboard.tsx` |
| Zero-knowledge vault and encrypted documents | `apps/web/src/lib/vault.tsx`, `vaultCrypto.ts`, `apps/api/src/routes/vault.ts` |
| Nominees, DEK escrow, dead-man switch, claim kit | `services/nominee.service.ts`, `deadman.service.ts` |
| Household merge, share modes, instant revocation | `services/household.service.ts` |
| AMFI NAV ingest, stock provider, nightly refresh | `services/priceProvider.service.ts`, `lib/cron.ts` |
| Encrypted backup bundles, restore, export | `services/backup.service.ts`, `lib/bundle.ts` |
| India: nomination hygiene, FY reports, tax estimates | `services/india.service.ts` |
| PWA, privacy blur, accessibility, Playwright E2E | `apps/web/src/lib/pwa.ts`, `apps/e2e/` |
| SMTP transport, `email_outbox`, twelve messages, password reset | `lib/mailer.ts`, `services/mail.service.ts` |
| Docker deployment and one-command install | `Dockerfile`, `docker/`, `scripts/` |

Phase-by-phase history is in the git log and in [`DECISIONS.md`](DECISIONS.md).

---

## In progress

- [~] Vault state now waits for the session before reading `/vault`, and re-reads after a
      sign-in. Without it a first visit in a fresh browser asked for a *new* passphrase
      until the page was reloaded (`apps/web/src/lib/vault.tsx`). Needs a regression test
      covering "provider mounts anonymous, user signs in, vault reports locked".

## Next

Small, and each one is a known gap rather than an idea.

- [ ] Tag `v1.0.0` in git. The version and changelog entry have been in place since the
      release commit; only the tag is missing, and it is the owner's to push
- [ ] Expose whether SMTP is configured to the web app. Three screens currently hedge in
      prose — dead-man warnings, nominee invites, password reset — because none of them can
      ask. One boolean on `/auth/me` or a `/config` read would let each say what is true
- [ ] Regression tests for the provider-mounts-before-session class of bug, which the vault
      fix above is one instance of
- [ ] Cross-browser E2E, deliberately skipped for 1.0.0. Worth revisiting only if a
      rendering bug is reported that one browser cannot reproduce

## Backlog (post-v1)

Ordered by how much each would change the product, not by effort.

- [ ] CAS PDF import (CAMS / KFintech, NSDL / CDSL). The largest single reduction in manual
      entry available, and the reason the two items below wait for it
- [ ] Rewriting `holdings.units` and average cost from transaction history. It belongs next
      to the CAS import that would produce the volume of transactions to justify it
- [ ] Realized capital gains, which need disposal records this application does not keep —
      records the CAS import would also supply
- [ ] Rotating the vault's **data** key, the only real answer to a released escrow. Deferred
      from P5 to P8 to here: it re-encrypts every item and every document at once, and it
      wanted a backup taken first, which now exists. Take a bundle, rewrap, verify, then
      swap — and treat a half-finished rotation as the failure mode to design against
- [ ] Push notifications. Email exists, but a phone that buzzes is a better dead-man warning
      than an inbox somebody is not reading either
- [ ] Goal tracking (retirement, child education)
- [ ] Multi-currency for NRI and RSU holdings
- [ ] Mobile app shell

## Not planned

Recorded so they are not re-proposed as oversights. The reasoning is in
[`DECISIONS.md`](DECISIONS.md).

- A vault shared between household partners. Sharing with a living person is a different
  consent problem than handing one to an heir; a household grant's scope stays `full` or
  `summary`
- Server-rendered claim-kit PDFs, which would require the server to hold vault plaintext
- Loss carry-forward and set-off across financial years, which depend on returns filed
  elsewhere
- Incremental or deduplicated backups; nightly full bundles are cheaper than the
  bookkeeping that avoids them

---

## Working agreement

- One task here per unit of shippable behaviour. If a line cannot be finished in a single
  PR, split it before starting rather than leaving it `[~]` across releases.
- A task moves to `[x]` only with its tests. When the release that carries it is cut, drop
  the line — this file tracks what is left, and the git log holds what was done.
- When a decision is worth keeping — why something is shaped this way, or why it was left
  out — write it in [`DECISIONS.md`](DECISIONS.md), not as a comment on a checkbox that is
  about to be deleted.
