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
| `users` | email (lowercased, unique), argon2id `password_hash`, name, role (`admin`/`member`/`nominee`), status (`active`/`suspended`), `last_active_at`, encrypted TOTP secret, `session_epoch`. The RSA keypair lives in `vault_keys`, not here — it is wrapped by the vault passphrase and has no meaning without one. `session_epoch` is bumped on any wholesale revocation and stamped into every access token, which is what makes a password change sign every device out *immediately* rather than when the fifteen-minute JWT expires |
| `invites` | code hash, email, role, expiry, `consumed_by`. The only path to an account |
| `refresh_tokens` | HMAC'd token, family id, device label, expiry, revoked flag, successor id. One row per issued token; rotation writes a new row and revokes the old |
| `recovery_codes` | hashed single-use TOTP recovery codes, `used_at` |
| `password_resets` | HMAC'd token, requesting ip, expiry, `used_at`, `invalidated_at`. Modelled on `refresh_tokens`: opaque random value, only its hash stored, revocable. Rows survive use — "this account's password was reset from that address at that time" is exactly what somebody wants after a takeover |
| `settings` | per-user KV: theme, lakh/crore display, privacy blur, partner-merge toggle |
| `households` | id, name, created_by |
| `household_members` | household, user, role (`owner`/`partner`/`member`), `share_mode` (`full`/`summary`/`none`), consent + accepted timestamps |
| `nominees` | owner → nominee user (null until they accept), email, name, relation, `share_percent_bps`, `access_level` (`summary`/`full`/`vault`), status (`invited`/`accepted`/`revoked`) |
| `access_grants` | the one table every scoped query consults: owner, grantee, `scope` (`summary`/`full`/`vault`), `source` (`household`/`nominee`/`manual`) and the row that created it, granted_at, expires_at, revoked_at. Read-only in every case — no scope confers a write |
| `audit_log` | actor, action, entity type + id, at, ip, meta JSON |
| `deadman_checkins` | HMAC'd token, the stage whose email carried it, expiry, `used_at`. A single-use "I am still here" link that resets the dead-man clock and grants nothing else. Following the link does not spend it — a human pressing a button does, because mail scanners prefetch links and a scanner answering for a dead owner would keep the switch alive for ever |
| `email_outbox` | kind, recipient, subject, sealed body, status (`pending`/`sent`/`failed`/`suppressed`), attempts, `next_attempt_at`, last error. Nothing sends on the request thread; a background loop drains this with exponential backoff. The body is encrypted under `SECRET_ENCRYPTION_KEY` because a pending row holds a live reset link or an unredeemed invite code, and cleared once the message is accepted. Delivered rows are pruned after 30 days; failed ones never are |

## Vault

| Table | Purpose |
| ----- | ------- |
| `vault_keys` | user (PK), `kdf_salt`, `kdf_params` (JSON: algorithm, memory, iterations, parallelism), `wrapped_dek`, `public_key_jwk`, `wrapped_private_key` |
| `vault_items` | owner, optional `asset_id`, kind (`bank_login`/`card`/`demat`/`policy`/`locker`/`credential`/`document_location`/`instruction`/`note`), `payload` |
| `documents` | owner, optional `asset_id`, `meta`, `size_bytes`, `storage_path`, sha256 |
| `vault_escrow` | owner, nominee, grantee, DEK wrapped to the grantee's public key, `public_key_fingerprint`, state (`sealed`/`released`/`revoked`), `release_reason` (`owner`/`deadman`), released_at, revoked_at |
| `dead_man_switch` | user (PK), enabled, `inactivity_days`, `grace_days`, `last_checkin_at`, stage (`idle`/`warned_50`/`warned_75`/`warned_90`/`grace`/`fired`), `grace_started_at`, `fired_at` |

Encrypted values are stored as the JSON envelope `{v, iv, ct}` the browser produced, in one
column, verbatim — the format version travels with the ciphertext into a backup and out
again. A `CHECK` constraint on each such column requires `$.ct` to be present, so a row that
is not an envelope cannot be written by anything, this application included.

**What is in the clear, and why.** A vault item's `kind` and `asset_id` are plaintext so the
app can say "this deposit has two vault items" on a locked screen and an owner can navigate
without unlocking. Everything else — the label, the username, the secret, the full account
number, the note to an heir — is inside `payload`. Documents go further: even the filename
and MIME type are encrypted, in `meta`, and the ciphertext on disk carries its own IV as a
prefix so a blob recovered from a backup is decryptable without this database.

There is deliberately **no verifier column**. Checking a vault passphrase happens when the
AES-GCM tag on `wrapped_dek` authenticates, in the browser. Anything here that the server
could check a passphrase against would be a free offline oracle for whoever copied the file.

`public_key_jwk` is plaintext by design: an owner has to be able to wrap their data key to a
nominee who is not present, and asynchronous escrow cannot be done with a shared secret. The
private half is wrapped by that user's own KEK in `wrapped_private_key`.

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
| `documents` | asset, encrypted `meta` (filename and MIME), size, `storage_path`, sha256. Always encrypted — see the vault section |

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
- `vault_escrow(nominee_id)` — unique. Exactly one wrapped key per nomination, so "release"
  is never ambiguous about which key it means.
- `vault_escrow(grantee_user_id, state)` — the heir's portal, and the only index that
  answers "what has been released to me".
- `dead_man_switch(enabled, stage)` — the hourly sweep reads this and nothing else.
