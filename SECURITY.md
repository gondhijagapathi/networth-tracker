# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Report it privately through
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository, or by contacting the maintainer directly.

Please include what you found, how to reproduce it, and what an attacker could achieve.
You will get an acknowledgement, and credit in the release notes unless you would rather not
be named.

## Supported versions

This is pre-1.0 software. Only `main` receives fixes.

## Deployment expectations

This application is designed to be **self-hosted for a small trusted circle**. It stores an
inventory of a household's wealth and the credentials needed to claim it.

- **Do not expose it directly to the internet.** Run it on loopback or a LAN, or behind a
  reverse proxy that terminates TLS. Set `COOKIE_SECURE=true` when served over HTTPS.
- **Encrypt the disk** on the host machine.
- **Keep backups off the machine** and test a restore. Backup bundles are encrypted, but a
  strong passphrase still matters.
- **There is no open signup by design.** Accounts exist only via admin-issued invite codes.

## What is protected

Vault contents are encrypted in the browser with a key derived from a vault passphrase that
is never transmitted. The server stores ciphertext only.

## What is not protected

Stated plainly because it matters: someone with **root on your host** can alter the
application to capture a passphrase or release a nominee escrow early, and a **compromised
browser** can read the key while the vault is unlocked. Asset names and amounts are stored
unencrypted so the app can sum and chart them — only vault items are ciphertext.

The full threat model is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
