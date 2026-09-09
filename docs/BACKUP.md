# Backup & Restore

Your entire net worth history lives in one SQLite file plus an uploads directory. Backing it
up should be one click, and restoring it should be boring.

## What is backed up

```
data/
  networth.db      SQLite database (all accounts, assets, vault ciphertext)
  uploads/         encrypted document blobs
  backups/         generated bundles (not themselves re-backed-up)
```

A bundle is the **whole installation**, every account on it — not one person's data. That is
why taking and restoring one is an admin-only operation, and why the Settings screen hides
the section entirely from a member. For one person's data in a portable format, see
[Portable exports](#portable-exports) below.

## Taking a backup

**From the UI:** Settings → Backup → *Back up now*. You are asked for a passphrase.

**From the CLI:** `npm run backup` (and `npm run backup:list` to see what is on disk).

Either way the process is:

1. **Online snapshot** via better-sqlite3's `db.backup()`. This uses SQLite's own backup API,
   so it produces a consistent snapshot **while the app is running**. Never `cp` a live
   SQLite file — with WAL enabled you can copy a database torn between pages.
2. Collect `uploads/`.
3. Write `manifest.json` — the applied migration list, app version, timestamp, per-table row
   counts, and a SHA-256 of the snapshot and of every blob.
4. Pack it as a tar archive and gzip it.
5. **Encrypt with AES-256-GCM**, under a key derived from your passphrase with Argon2id at
   64 MiB, three passes, four lanes — the same parameters as a login password.

The result is a single `.ntb` file written to `data/backups/` with mode `0600`. Because the
vault contents were already ciphertext in the database, this file is safe to store on any
cloud drive — but use a strong passphrase anyway, since asset names and amounts are *not*
individually encrypted.

### The file format

```
NTB1                     4 bytes, magic
header length            4 bytes, big-endian
header                   JSON: format, Argon2id parameters, salt, IV
tag                      16 bytes, AES-GCM authentication tag
ciphertext               AES-256-GCM(gzip(tar(manifest, snapshot, uploads)))
```

The header is plaintext because a reader needs the KDF parameters before it can derive a
key — and it is passed to GCM as additional authenticated data, so an attacker who edits the
salt or weakens the work factor produces a bundle that fails to open rather than one that
opens cheaply.

**Tar rather than zip, on purpose.** Once decrypted, a bundle is an ordinary `.tar.gz` that
any machine can read with tools that were installed before this application and will still be
there after it:

```sh
tar tzf decrypted-bundle.tar.gz
```

A backup format only the program that wrote it can open is a close relative of no backup at
all. `apps/api/src/lib/__tests__/bundle.test.ts` asserts this property against the system
`tar` rather than merely claiming it.

## Restoring

**Settings → Restore.** You choose the file, type the passphrase, and type the word
`restore` — three separate acts, because this is the only control in the application that
deletes other people's data.

**From the CLI:** `npm run restore -- path/to/backup.ntb`, or drop the bundle at
`data/restore.ntb` and run `npm run restore`.

Nothing is modified until every one of these has passed:

1. Decrypt with your passphrase.
2. Verify the SHA-256 of the snapshot and of every document against the manifest.
3. Compare schema versions. The manifest carries the **list of migrations** the source had
   applied, which is a better answer than a number because it says *which* schema:
   - a subset of this installation's migrations → restored, with any newer columns taking
     their defaults;
   - **a migration this installation has never seen → refused.** The bundle came from a later
     version, and there is no honest way to fit those rows into tables that predate them.
4. Take a **pre-restore safety bundle** under the same passphrase, so a mistaken restore is
   itself undoable. Its name begins `pre-restore-` and the UI tells you what it is called.

Only then does the restore happen — and it is **a transaction, not a file swap**. The
snapshot is attached and copied into the live database inside a single transaction with
foreign keys deferred to commit: either every table is replaced or none is, and no request in
flight ever sees a half-restored state. Swapping the file under a running process would leave
the server holding a handle to a database nobody else can see.

Finally the row counts are reported back against what the manifest promised, with any
mismatch shown as a warning rather than buried.

> **Everyone is signed out.** Sessions live in the database, so a restore replaces them along
> with everything else — including yours. Sign in again with the credentials that were in
> force at the time the backup was taken.

Restoring replaces everything. There is no partial or merge restore — silently merging two
divergent financial histories would be worse than refusing.

## Scheduled backups

Set in `.env`:

```
BACKUP_CRON=0 2 * * *          # nightly at 02:00; empty disables
BACKUP_RETENTION=14            # keep the newest 14 nightly bundles
BACKUP_PASSPHRASE=...          # required — see below
```

**Both `BACKUP_CRON` and `BACKUP_PASSPHRASE` must be set.** With no passphrase the schedule
does not run at all, because this application will not write an unencrypted copy of every
account in the household to disk just because a variable was left blank. The server says so
at boot, and Settings → Backup reports the schedule as inactive rather than pretending
otherwise — a household believing it has nightly backups it has never had is the worst
possible failure of this feature.

Retention prunes **only the nightly bundles**. A bundle you took by hand, and the safety
snapshot a restore left behind, are not the automatic job's to tidy away.

> Automated backups sitting on the same disk as the database protect you from mistakes, not
> from disk failure. Copy them off the machine — a cron `rsync` to another host, or a synced
> cloud folder — and test a restore at least once. **An untested backup is not a backup.**

## Portable exports

Backups are for restoring this app. Exports are for not being trapped in it:

- **Full JSON** — every asset with its typed detail, every transaction and valuation, exact
  integer paise. This is the one to migrate from.
- **CSV per asset class** — opens directly in Excel or Google Sheets, with amounts converted
  to rupees and a UTF-8 byte-order mark so a rupee sign survives Excel on Windows.

Both are in Settings → Export, and both are **your own data only** — deliberately not your
household's. Being able to see a partner's total on a merged dashboard is not the same as
being handed a spreadsheet of their accounts, and they did not consent to the second.

Vault items are exported as the ciphertext they are stored as. Exporting them at all is the
point: an export that silently dropped the vault would let somebody migrate away and discover
afterwards that their passwords did not come with them. Exporting them any other way is
impossible, because this server has never been able to read them.

## Disaster checklist

If the machine is gone:

1. Install Node and clone the repo on the new host.
2. `cp .env.example .env` and regenerate the JWT secrets (users log in again; nothing is
   lost). Keep `SECRET_ENCRYPTION_KEY` from the old host if you can — losing it makes every
   enrolled TOTP second factor unreadable.
3. `npm install && npm run build`
4. Restore the latest `.ntb` bundle: `npm run restore -- path/to/backup.ntb`. The CLI opens
   the database directly rather than talking to the HTTP API, which is why it works when the
   server does not.
5. Unlock the vault with your **vault passphrase** — which is not stored anywhere, including
   in the backup. Without it the vault contents are unrecoverable by design.
