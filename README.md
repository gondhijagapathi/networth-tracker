# Net Worth Tracker

A self-hosted net worth tracker built for **Indian households** — every asset and liability
in one place, and a plan for the day someone else has to claim them.

> **Status:** in active development. See [`docs/TASKS.md`](docs/TASKS.md) for what is done
> and what is pending.

## Why

Indian household wealth is scattered across instruments that no general-purpose tracker
models properly: PPF, EPF, NPS, Sukanya Samriddhi, post-office schemes, LIC endowment
policies, sovereign gold bonds, physical gold, land with survey and khata numbers, and
mutual funds identified by AMFI scheme code rather than a ticker.

And a large share of it goes **unclaimed after a death** — because heirs did not know the
asset existed, no nominee was ever registered, or nobody could find the paperwork. The RBI
runs an entire portal for unclaimed deposits; shares drift to the IEPF; policies lapse.

So this app does two things:

1. **Know what you own** — every asset and liability, valued, charted, with XIRR and
   allocation.
2. **Make sure it can be claimed** — nomination tracking per asset, an encrypted vault for
   credentials and document locations, nominees who can actually log in, and a printable
   claim kit per institution.

## Features

**Assets** — bank accounts · FD, RD, PPF, SSY, NSC, KVP, MIS, SCSS · mutual funds (auto NAV
from AMFI) · stocks and ETFs · EPF, VPF, NPS · LIC and insurance policies · land and property
· gold, silver, SGB · crypto, ESOPs, chit funds, loans given · and liabilities, because net
worth is assets minus debts.

**Insight** — net worth over time, allocation by class and institution, XIRR and CAGR,
maturity and premium-due calendar, financial-year reporting (Apr–Mar), and clearly-labelled
tax estimates including LTCG/STCG splits and an 80C headroom tracker.

**Succession** — a nomination hygiene dashboard that ranks un-nominated assets by value at
risk, a zero-knowledge vault for credentials, nominee accounts with read-only access, an
optional dead-man switch, and generated claim kits listing the exact forms each institution
wants.

**Household** — partners can merge their data into one household view by mutual consent,
with joint assets split by ownership so nothing is double-counted. Either side can revoke
instantly.

**Yours** — one SQLite file, one-click encrypted backup and restore, JSON and CSV export, no
telemetry, no third-party scripts, no cloud account.

## Quick start

Requires Node 22 or newer (`.nvmrc` pins the tested version).

```bash
git clone <your-repo-url> networth-tracker
cd networth-tracker
npm install

cp .env.example .env
# Generate the two JWT secrets and set a bootstrap invite code:
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET

npm run dev
```

Open http://localhost:5173 and register the first admin account with the
`BOOTSTRAP_INVITE_CODE` you set. Every account after that is created by an admin-issued
invite — there is no open signup.

### Production

```bash
npm run build
npm start          # Express serves the API and the built web bundle on one port
```

Put it behind a reverse proxy with TLS and set `COOKIE_SECURE=true`.

## Backup and restore

Settings → Backup produces a single passphrase-encrypted bundle containing a consistent
SQLite snapshot, your uploaded documents, and a manifest with checksums. Restore verifies
the checksum, refuses a newer schema, takes a safety snapshot first, then swaps atomically.
Nightly automated backups are configurable via `BACKUP_CRON`.

Full details, including a disaster-recovery checklist: [`docs/BACKUP.md`](docs/BACKUP.md).

## Security

Vault contents — bank logins, policy numbers, demat credentials, locker locations — are
encrypted **in your browser** with a key derived from a separate vault passphrase. The server
stores ciphertext and has no code path that can decrypt it, which also means backups are safe
by construction.

This is self-hosted software for a small trusted circle. It assumes you control the machine.
Read [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md) — including the section on what it
deliberately does **not** protect against — before putting real data in it.

## Documentation

| Document | Contents |
| -------- | -------- |
| [PLAN.md](docs/PLAN.md) | The full approved design and build plan |
| [TASKS.md](docs/TASKS.md) | Phase-by-phase task tracker — done, in progress, pending |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, runtime, access control, conventions |
| [DATA-MODEL.md](docs/DATA-MODEL.md) | Every table and relationship |
| [SECURITY-MODEL.md](docs/SECURITY-MODEL.md) | Threat model, vault crypto, escrow, limits |
| [BACKUP.md](docs/BACKUP.md) | Backup, restore, exports, disaster recovery |
| [INDIA-NOTES.md](docs/INDIA-NOTES.md) | Domain reference: instruments, claims, tax, data sources |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Conventional Commits, and CI must be green.

## Disclaimer

This software helps you **record and organise** your own financial information. It is not
financial, tax or legal advice. Tax figures are estimates for planning only — verify against
current rules and consult a professional. Claim procedures vary by institution and change
over time; always confirm with the institution.

## License

MIT — see [LICENSE](LICENSE).
