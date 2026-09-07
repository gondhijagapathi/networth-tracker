# Security Model

This app stores the two most sensitive things a household owns: a complete inventory of its
wealth, and the credentials needed to claim it. This document states plainly what is
protected, how, and — just as importantly — what is *not* protected.

## Deployment assumption

**This is self-hosted software for a small trusted circle.** It is designed to run on a
machine you control, bound to loopback or a LAN, or behind a TLS-terminating reverse proxy
that you operate. It is not hardened for open public signup, and there is no such mode.

Do not expose it directly to the internet without TLS and a reverse proxy.

## Authentication

- Passwords hashed with **Argon2id** (m=64 MiB, t=3, p=4 — memory-hard, resistant to GPU
  cracking). A login for an address with no account still performs a hash, so response
  time cannot be used to enumerate accounts.
- No open registration. Accounts exist only via an **admin-issued invite code**; the very
  first admin comes from `BOOTSTRAP_INVITE_CODE`, which is materialised into an ordinary
  invite row and consumed once. Only the SHA-256 of a code is stored — a lost code is
  re-issued, never recovered.
- Short-lived access JWT in an **httpOnly, SameSite=Strict** cookie, plus a rotating
  refresh token stored **HMAC'd** in the DB (under `JWT_REFRESH_SECRET`, so a leaked
  database cannot be attacked offline) and revocable per device. Reuse of a rotated
  refresh token invalidates the whole family.
- Authorisation is re-read from the database on every request, so a **suspension or role
  change takes effect immediately** rather than when the access token expires.
- **CSRF** double-submit token on every mutating request.
- **Rate limiting with exponential backoff** on login — keyed by email *and* by client
  address, so neither one account nor one host can be ground down — and on invite
  redemption. Vault unlock is metered too; what that does and does not buy is set out
  below.
- Optional **TOTP 2FA** with ten single-use recovery codes. The shared secret is
  encrypted at rest under `SECRET_ENCRYPTION_KEY`, and 2FA is only switched on once a
  live code confirms enrolment, so an abandoned enrolment cannot lock anyone out.
- Changing a password **revokes every session**, including the one that made the change.

## Two kinds of encryption at rest

These are easy to confuse, and the difference is the whole security story:

| | `SECRET_ENCRYPTION_KEY` | The vault |
| --- | --- | --- |
| Protects | TOTP seeds, later provider credentials | Bank logins, policy numbers, instructions for heirs |
| Key lives | In the server's environment | Only in the owner's browser |
| Server can read it | Yes, by design | **No, and there is no code path that could** |
| Defends against | A leaked `networth.db` or backup file | A leaked database *and* the server operator |

The first is ordinary at-rest encryption: it makes a stolen database file useless without
the environment, but someone with the running host has the key. The second is the real
guarantee, and it is described next.

## The vault: zero-knowledge

Vault items — bank logins, policy numbers, demat credentials, locker locations, instructions
for heirs — are encrypted **in the browser**. The server never sees plaintext and has no
code path that could.

```
KEK = Argon2id(vault passphrase, per-user salt, m=64MB, t=3, p=4)   [browser only]
DEK = random AES-256 key
item ciphertext = AES-256-GCM(plaintext, DEK)     → {iv, ct, tag} stored in SQLite
wrapped_dek     = AES-256-GCM(DEK, KEK)           → stored in SQLite
```

- The **vault passphrase is separate from the login password** and is never transmitted.
  Losing it means losing the vault contents — that is the point, and the UI says so before
  you set it.
- The DEK lives in memory only, never in `localStorage` or `sessionStorage`, and the vault
  **auto-locks after 15 minutes idle**. A page reload locks it.
- Request schemas reject plaintext-shaped payloads on vault endpoints, so a client bug
  cannot silently upload secrets in the clear. The database repeats the check as a `CHECK`
  constraint on every ciphertext column.
- **There is no verifier.** Nothing is stored that the server could compare a passphrase
  against; a wrong passphrase surfaces as an AES-GCM authentication failure in the browser.
  A verifier column would hand anyone who copied `networth.db` a free offline oracle.
- Documents are encrypted before upload, **filename and MIME type included**, and the
  ciphertext carries its own IV as a prefix — a blob recovered from a backup is decryptable
  without the database.

### What the unlock rate limit does, and does not, do

Retrieving the wrapped key material is metered per user with exponential backoff, and every
retrieval is audit-logged. Because the server cannot tell a correct passphrase from a wrong
one, each retrieval costs a slot until the client reports that the vault opened.

That bounds a **stolen session cookie** quietly pulling key material over and over, and it
leaves a trail. It does **nothing at all** about an attacker who has copied the database
file: against that, the only defence is Argon2id's cost — 64 MiB, three passes, four lanes,
about a second per guess in WASM — which is why the parameters are what they are and why
they are stored per vault rather than hard-coded.

### What is *not* encrypted in the vault

A vault item's `kind` and its link to an asset are stored in the clear, so the app can show
"this fixed deposit has two vault items" on a locked screen. A stolen database therefore
reveals that you hold a bank login for some account; it does not reveal the bank, the
username, the password, or anything else. The label lives inside the ciphertext with the
rest.

Because the ciphertext is what lives in the DB, **backups are safe by construction**: a
stolen backup bundle without the passphrase is noise.

## Nominee escrow and the dead-man switch

The point of this app is that heirs can actually claim what they inherit. That requires
handing over vault access — carefully.

- Every user has an **RSA-OAEP-2048 keypair**. The public key is stored in the clear; the
  private key is wrapped by that user's own KEK.
- To name a nominee, the owner wraps their DEK to the nominee's public key. The result is
  stored in `vault_escrow` in a **`sealed`** state. The server holds it but will not deliver
  it.
- The escrow records the **fingerprint of the key it was wrapped to**, and the server
  recomputes that fingerprint from the JWK it holds rather than trusting the request. This
  closes the one substitution attack an otherwise end-to-end flow leaves open: a compromised
  client handing the owner an attacker's public key to wrap to.
- **Two locks, independent by design.** The nomination's `access_level` governs the API; the
  escrow state governs the cryptography. A nominee with `vault` access before release sees
  ciphertext and can do nothing with it; a released escrow with a narrower access level
  yields nothing to read. Both must open, and no single mistake in either produces access on
  its own.
- Release happens on exactly two triggers:
  1. the owner explicitly grants it, or
  2. the **dead-man switch** fires — no sign-in for `inactivity_days` (default 90, floor 30),
     with warnings at 50%, 75% and 90% of the window, then a **grace period** (default 7
     days) that a single ordinary sign-in cancels.
- Aliveness is measured as the later of `users.last_active_at` and an explicit check-in, so
  somebody who uses the app normally never has to think about the feature. Below the
  inactivity window the stage is a pure function of elapsed silence in both directions —
  signing in during the grace period cancels it without finding a button.
- Every state change and every vault read, including each fetch of an escrowed key and each
  document download, is written to `audit_log`.

**Release is one-way.** Revoking a nominee closes their access grant and marks the escrow
revoked, which stops the server serving it again — but an heir who already fetched the
wrapped key holds a copy of the data key. Genuinely taking that back means re-encrypting
every vault item under a new key, which this build does not do. The UI says so at the point
of release rather than implying otherwise with a green tick.

**Warnings are recorded, not delivered.** This build has no mail transport, so the 50/75/90%
stages write `audit_log` rows and raise a banner the owner sees on their next visit. Email
and push are in the backlog; until then the warning is weaker than the design intends, and
`docs/TASKS.md` says so rather than letting a checked box imply an email that never went
out.

## What this does *not* protect against

Stated plainly rather than glossed over:

- **You own the server.** Someone with root on the host can modify the application code to
  release an escrow early, or capture a passphrase as it is typed. The cryptography protects
  data **at rest and in backups**; it is not a defence against a compromised host. Keep the
  machine patched and the disk encrypted.
- **A compromised browser** (malicious extension, malware) can read the DEK while the vault
  is unlocked. Unlock only on devices you trust.
- **Metadata is not encrypted.** Asset names, institutions, and amounts live in normal
  columns so the app can sum, sort and chart them. Only vault items are ciphertext. If the
  DB file leaks, an attacker learns *what you own* even though they cannot learn *how to log
  in to it*.
- **Account numbers are masked at rest** (last four retained for identification); the full
  number belongs in the vault.
- **A nominee account can write its own key material.** The blanket read-only guard makes
  one exception — vault setup, unlock and rekey — because an owner cannot wrap a data key to
  a public key that does not exist. It covers nothing else: a nominee cannot create, edit or
  delete anything, on their own estate or anybody else's.

## Operational hygiene

- `data/` is gitignored in full: DB, uploads and backups can never be committed.
- A pre-commit hook scans staged files for `.env`, `.db` and common secret patterns.
- Secrets come only from environment variables. `.env.example` documents every one and holds
  no real values.
- `helmet` with a strict CSP; no third-party scripts, no analytics, no telemetry. The app
  makes exactly two kinds of outbound request: AMFI NAV and (if enabled) stock prices.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md) in the repository root.
