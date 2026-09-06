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

## Taking a backup

**From the UI:** Settings → Backup → *Download backup*. You are asked for a passphrase.

**From the CLI:** `npm run backup`

Either way the process is:

1. **Online snapshot** via better-sqlite3's `db.backup()`. This uses SQLite's own backup API,
   so it produces a consistent snapshot **while the app is running**. Never `cp` a live
   SQLite file — with WAL enabled you can copy a torn database.
2. Collect `uploads/`.
3. Write `manifest.json` — schema version, app version, timestamp, per-table row counts and a
   SHA-256 of the snapshot.
4. Zip it all.
5. **Encrypt the zip with AES-256-GCM** using a key derived from your passphrase.

The result is a single `.ntb` file (encrypted zip). Because the vault contents were already
ciphertext in the database, this file is safe to store on any cloud drive — but use a strong
passphrase anyway, since asset names and amounts are *not* individually encrypted.

## Restoring

**Settings → Backup → *Restore from file*.**

1. Decrypt with your passphrase.
2. Verify the SHA-256 in the manifest against the snapshot.
3. Compare schema versions:
   - older → forward migrations are applied after restore;
   - equal → restored as-is;
   - **newer → refused.** The app will not guess at a schema from a future version.
4. Take a **pre-restore safety snapshot** of the current database, so a mistaken restore is
   itself undoable.
5. Atomically swap in the restored database and uploads.
6. Report row counts back and compare them to the manifest.

Restoring replaces everything. There is no partial or merge restore — merging two divergent
financial histories silently would be worse than refusing.

## Scheduled backups

Set in `.env`:

```
BACKUP_CRON=0 2 * * *   # nightly at 02:00; empty disables
BACKUP_RETENTION=14     # keep the newest 14 bundles
```

Scheduled bundles are written to `data/backups/` and pruned by retention count.

> Automated backups sitting on the same disk as the database protect you from mistakes, not
> from disk failure. Copy them off the machine — a cron `rsync` to another host, or a synced
> cloud folder — and test a restore at least once. **An untested backup is not a backup.**

## Portable exports

Backups are for restoring this app. Exports are for not being trapped in it:

- **Full JSON** — every asset, transaction and valuation. Vault items are exported as
  ciphertext.
- **CSV per asset class** — opens directly in Excel or Google Sheets.

Both are available in Settings → Export.

## Disaster checklist

If the machine is gone:

1. Install Node and clone the repo on the new host.
2. `cp .env.example .env` and regenerate the JWT secrets (users log in again; nothing is
   lost).
3. `npm install && npm run build`
4. Restore the latest `.ntb` bundle through Settings, or place it at `data/restore.ntb` and
   run `npm run restore`.
5. Unlock the vault with your **vault passphrase** — which is not stored anywhere, including
   in the backup. Without it the vault contents are unrecoverable by design.
