/**
 * `npm run backup` and `npm run restore`.
 *
 * The command-line half of the backup feature, and the half that matters when things have
 * gone wrong: `docs/BACKUP.md`'s disaster checklist assumes a fresh machine with a bundle on
 * it and no browser session to sign into. Neither command talks to the HTTP API — they open
 * the database directly, which is why they work when the server does not.
 *
 * The passphrase comes from `BACKUP_PASSPHRASE`, or from a prompt when the terminal is
 * interactive. It is deliberately not an argument: a passphrase on a command line ends up in
 * the shell history and in the process list, where anybody on the machine can read it.
 */

import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { createDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { MIN_BACKUP_PASSPHRASE } from '@networth/shared';
import {
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
} from '../services/backup.service.js';

/* eslint-disable no-console -- this file *is* the user interface. */

const command = process.argv[2] ?? 'create';
const config = loadConfig();
const { db, sqlite, close } = createDb(config.DATABASE_PATH);

try {
  runMigrations(sqlite);
  const ctx = createContext(config, db, sqlite);

  if (command === 'create') {
    const passphrase = await passphraseFor('Backup passphrase: ');
    const backup = await createBackup(ctx, { passphrase });
    const pruned = pruneBackups(ctx);

    console.log(`Wrote ${backup.filename} (${formatBytes(backup.sizeBytes)}).`);
    console.log(`  in ${resolve(config.BACKUP_DIR)}`);
    if (pruned.length > 0) console.log(`  pruned ${pruned.length} bundle(s) past retention`);
    console.log('\nCopy it off this machine. A backup on the same disk is not a backup.');
  } else if (command === 'restore') {
    // `data/restore.ntb` is the path the disaster checklist tells people to use, so it is
    // what this falls back to when no file is named.
    const path = process.argv[3] ?? join(resolve(config.BACKUP_DIR), '..', 'restore.ntb');
    if (!existsSync(path)) {
      throw new Error(`No bundle at ${path}. Pass one: npm run restore -- path/to/backup.ntb`);
    }

    console.log(`About to restore ${path}.`);
    console.log('This REPLACES every account, asset and document currently stored.');
    await confirm('Type "restore" to continue: ', 'restore');

    const passphrase = await passphraseFor('Bundle passphrase: ');
    const result = await restoreBackup(ctx, readFileSync(path), passphrase, systemActor(ctx), null);

    console.log(`\nRestored a backup taken ${result.manifest.createdAt}.`);
    for (const table of result.tables.filter((row) => row.actual > 0 || row.expected > 0)) {
      console.log(`  ${table.table.padEnd(24)} ${String(table.actual).padStart(7)}`);
    }
    console.log(`  documents${''.padEnd(15)} ${String(result.documentsRestored).padStart(7)}`);
    for (const warning of result.warnings) console.warn(`  ! ${warning}`);
    console.log(`\nThe state before this restore is in ${result.safetyBackup}.`);
    console.log('Everyone will need to sign in again — the sessions were restored too.');
  } else if (command === 'list') {
    const { backups, directory, schedule } = listBackups(ctx);
    console.log(directory);
    console.log(
      schedule === null
        ? 'No nightly schedule (set BACKUP_CRON and BACKUP_PASSPHRASE).'
        : `Nightly at "${schedule.cron}", keeping ${schedule.retention}.`,
    );
    if (backups.length === 0) console.log('\nNo bundles yet.');
    for (const backup of backups) {
      console.log(`  ${backup.filename}  ${formatBytes(backup.sizeBytes)}`);
    }
  } else {
    console.error(`Unknown command "${command}". Use "create", "restore" or "list".`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  close();
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

async function passphraseFor(prompt: string): Promise<string> {
  const configured = config.BACKUP_PASSPHRASE;
  if (configured !== undefined) return configured;

  if (!process.stdin.isTTY) {
    throw new Error('Set BACKUP_PASSPHRASE, or run this from a terminal that can prompt.');
  }

  const answer = (await ask(prompt)).trim();
  if (answer.length < MIN_BACKUP_PASSPHRASE) {
    throw new Error(`A passphrase needs at least ${MIN_BACKUP_PASSPHRASE} characters.`);
  }
  return answer;
}

async function confirm(prompt: string, expected: string): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('Restoring from a non-interactive shell is refused; run it from a terminal.');
  }
  if ((await ask(prompt)).trim() !== expected) {
    throw new Error('Not confirmed. Nothing was changed.');
  }
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * The actor for an audit row written from the command line.
 *
 * There is no signed-in user here, and the audit table's `actor_user_id` references
 * `users` — so an invented id would fail the constraint. The first admin is the closest
 * true answer: on a self-hosted install, they are who is sitting at the terminal.
 */
function systemActor(ctx: ReturnType<typeof createContext>): string {
  const admin = ctx.sqlite
    .prepare<[], { id: string }>(
      "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1",
    )
    .get();
  if (!admin) throw new Error('This database has no admin account to attribute the restore to.');
  return admin.id;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
