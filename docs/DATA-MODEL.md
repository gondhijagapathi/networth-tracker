# Data Model

SQLite, WAL mode, foreign keys on. Drizzle ORM defines the schema in
`apps/api/src/db/schema.ts`; `drizzle-kit` generates the SQL migrations committed under
`apps/api/migrations/`.

## Conventions

- **Money is `BIGINT` paise.** ₹1,234.56 is stored as `123456`. Never a float.
- **Quantities and per-unit prices are integers scaled by a million.** 1.5 units is
  `1500000`; a NAV of ₹123.4567 is `123456700` micro-rupees. AMFI publishes four decimals
  and rounding them to paise before multiplying by ten thousand units loses real money.
- **Percentages are basis points.** A 33.33% ownership share is `3333`. The one calculation
  that must add back to exactly 100% does not get a float.
- **Dates** are ISO-8601 `TEXT`: `YYYY-MM-DD` for calendar dates, `YYYY-MM-DDTHH:MM:SSZ`
  (UTC) for instants.
- Primary keys are UUIDv7 `TEXT` — sortable by creation time and safe to generate client-side.
- Every table carries `created_at` and `updated_at`.
- Soft deletes via `status` (`active` / `closed` / `archived`) rather than row removal, so
  history and past valuations survive.
- Enum columns carry a SQLite `CHECK` constraint as well as a TypeScript union. The
  compiler does not supervise a restore, a migration or a manual fix; the database does.
- **Account, policy and folio numbers are stored masked** — everything but the last four
  digits replaced with `X`. The masking lives in the shared Zod schema, which is the only
  door into these columns, so no write path can skip it. Full numbers belong in the vault.
- Deleting a user cascades to their sessions, recovery codes and settings, but only
  *nulls* the actor on their `audit_log` rows — an audit trail that disappears with its
  subject is not an audit trail.

## Identity & access

| Table | Purpose |
| ----- | ------- |
| `users` | email (lowercased, unique), argon2id `password_hash`, name, role (`admin`/`member`/`nominee`), status (`active`/`suspended`), `last_active_at`, encrypted TOTP secret. The RSA keypair columns arrive with the vault in P4 |
| `invites` | code hash, email, role, expiry, `consumed_by`. The only path to an account |
| `refresh_tokens` | HMAC'd token, family id, device label, expiry, revoked flag, successor id. One row per issued token; rotation writes a new row and revokes the old |
| `recovery_codes` | hashed single-use TOTP recovery codes, `used_at` |
| `settings` | per-user KV: theme, lakh/crore display, privacy blur, partner-merge toggle |
| `households` | id, name, created_by |
| `household_members` | household, user, role (`owner`/`partner`/`member`), `share_mode` (`full`/`summary`/`none`), consent + accepted timestamps |
| `nominees` | owner → nominee user (null until they accept), email, name, relation, `share_percent_bps`, `access_level` (`summary`/`full`/`vault`), status (`invited`/`accepted`/`revoked`) |
| `access_grants` | the one table every scoped query consults: owner, grantee, `scope` (`summary`/`full`/`vault`), `source` (`household`/`nominee`/`manual`) and the row that created it, granted_at, expires_at, revoked_at. Read-only in every case — no scope confers a write |
| `audit_log` | actor, action, entity type + id, at, ip, meta JSON |

## Vault

| Table | Purpose |
| ----- | ------- |
| `vault_keys` | user, `wrapped_dek`, KDF params (salt, m, t, p) |
| `vault_items` | owner, optional `asset_id`, kind (`login`/`policy`/`locker`/`contact`/`instruction`), label, `{iv, ciphertext, tag}` |
| `vault_escrow` | owner, grantee, DEK wrapped to grantee public key, state (`sealed`/`released`/`revoked`), released_at |
| `dead_man_switch` | user, enabled, `inactivity_days`, `last_checkin_at`, warn stage, state (`armed`/`warning`/`grace`/`triggered`) |

Only `vault_items` and `vault_escrow` hold ciphertext the server cannot read. Labels are
plaintext so the vault list is browsable while locked.

## Assets

`assets` is the base table; each type has a 1:1 detail table keyed on `assets.id`, created
and deleted with it in one transaction. A base row without its detail is a corrupt asset and
every read path treats it as one.

**`assets`** — owner, `type`, name, institution, **`nominee_registered`** (boolean; the flag
the whole nomination dashboard hangs on), `ownership_bps`, `joint_with`, status,
`opened_on`, `closed_on`, tags (JSON array), notes.

A **liability is an asset row** with `type: 'liability'`. That reads oddly and pays for
itself: a home loan has an institution, documents, transactions (the EMIs) and a balance
history, all of which the base table already provides. `outstanding_paise` is stored
positive and net worth subtracts these rows rather than storing negative values.

| Detail table | Key columns |
| ------------ | ----------- |
| `bank_accounts` | masked account no, IFSC, branch, CIF, account type (`savings`/`current`/`salary`/`nre`/`nro`/`fcnr`) |
| `deposits` | kind (`fd`/`rd`/`ppf`/`ssy`/`nsc`/`kvp`/`mis`/`scss`), principal, instalment, rate (bps), compounding, start, maturity, payout mode, auto-renew |
| `holdings` | instrument, units (×10⁶), avg cost (micro-rupees), masked folio, SIP amount + day, masked demat account |
| `instruments` | kind (`mf`/`equity`/`etf`/`bond`), AMFI scheme code, ISIN, NSE/BSE symbol, name, AMC, category. Global reference data, owned by nobody |
| `instrument_prices` | `(instrument_id, date)` primary key, price (micro-rupees), source — one row per instrument per day, so an import is idempotent |
| `insurance_policies` | masked policy no, insurer, plan, kind (`term`/`endowment`/`ulip`/`money_back`/`health`), sum assured, premium + frequency + next due, start, maturity |
| `properties` | kind (land/plot/flat/house/commercial), survey no, khata/patta, registration doc no, sub-registrar office, area (×10⁶) + unit, guideline value, co-owners |
| `retirement_accounts` | kind (EPF/VPF/NPS), masked UAN, member id and PRAN, tier, scheme mix (JSON), employer + employee balance |
| `precious_metals` | form (physical/digital/SGB/jewellery), metal, weight in milligrams, purity, making charges, SGB maturity + coupon dates |
| `other_assets` | kind (crypto/ESOP/RSU/chit/loan_given/vehicle) plus JSON detail — free-form column, but validated by a Zod union discriminated on `kind` |
| `liabilities` | kind (home/car/personal/education/gold/credit_card/loan_against/business), lender, masked account no, principal, outstanding, rate (bps), EMI, tenure, next due |

## Movement & value

| Table | Purpose |
| ----- | ------- |
| `transactions` | asset, date, type (`buy`/`sell`/`sip`/`dividend`/`interest`/`deposit`/`withdrawal`/`premium`/`emi`), units, amount, price, charges, notes. Signed — a sell carries negative units — because sign, not the type name, is what the cost-basis and XIRR maths reads |
| `valuations` | **append-only** `(asset_id, as_of, value_paise, source)`. Source is `manual`, `amfi`, `yahoo` or `computed`. Never updated in place |
| `documents` | asset, filename, mime, size, `storage_path`, sha256, encrypted flag |

## Key relationships

```
users ──< assets ──< valuations
             │
             ├──< transactions
             ├──< documents
             ├──1 (one typed detail table per asset.type)
             └──< vault_items

users ──< nominees ──< vault_escrow
users ──< household_members >── households
users ──< access_grants   (owner → grantee; consulted by every scoped read)
```

## Indexes that matter

- `assets(owner_user_id, status, type)` — the asset list and every scoped read.
- `assets(owner_user_id, nominee_registered)` — the nomination dashboard's "what is at risk".
- `valuations(asset_id, as_of DESC)` — latest value per asset, and the history chart.
- `instrument_prices(instrument_id, date DESC)` — NAV lookup during revaluation.
- `instruments(amfi_scheme_code)` and `instruments(isin)` — unique; the AMFI import upserts
  on these.
- `access_grants(grantee_user_id, scope)` — the permission check on every request.
- `transactions(asset_id, date)` — XIRR cashflow assembly.
