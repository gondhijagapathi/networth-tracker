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

- Passwords hashed with **Argon2id** (memory-hard; resistant to GPU cracking).
- No open registration. Accounts exist only via an **admin-issued invite code**; the very
  first admin comes from `BOOTSTRAP_INVITE_CODE`, which is consumed once.
- Short-lived access JWT in an **httpOnly, SameSite=Strict** cookie, plus a rotating
  refresh token stored **hashed** in the DB and revocable per device. Reuse of a rotated
  refresh token invalidates the whole family.
- **CSRF** double-submit token on every mutating request.
- **Rate limiting with backoff** on login and vault unlock.
- Optional **TOTP 2FA** with recovery codes.

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
  **auto-locks after 15 minutes idle**.
- Request schemas reject plaintext-shaped payloads on vault endpoints, so a client bug
  cannot silently upload secrets in the clear.

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
- Release happens on exactly two triggers:
  1. the owner explicitly grants it, or
  2. the **dead-man switch** fires — no login for `inactivity_days` (default 90), with
     warning emails at 50%, 75% and 90% of the window, then a **7-day final grace period**
     that a single login cancels.
- Every state change and every vault read is written to `audit_log`.

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

## Operational hygiene

- `data/` is gitignored in full: DB, uploads and backups can never be committed.
- A pre-commit hook scans staged files for `.env`, `.db` and common secret patterns.
- Secrets come only from environment variables. `.env.example` documents every one and holds
  no real values.
- `helmet` with a strict CSP; no third-party scripts, no analytics, no telemetry. The app
  makes exactly two kinds of outbound request: AMFI NAV and (if enabled) stock prices.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md) in the repository root.
