/**
 * Migration runner.
 *
 * Reads the committed `.sql` files in `apps/api/migrations/`, applies any that this
 * database has not seen, and records each one in `_migrations`. Deliberately boring: the
 * files are plain SQL, they run in filename order, and each file is applied inside a
 * single transaction so a failure leaves nothing half-created.
 *
 * The generator's bookkeeping (`migrations/meta/`) is not consulted at runtime — a
 * production install needs only the SQL.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

/** Drizzle writes this marker between statements; it is not a SQL comment we can execute. */
const STATEMENT_SEPARATOR = '--> statement-breakpoint';

/** Resolved relative to this module, so it works from `src/` under tsx and from `dist/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface AppliedMigration {
  name: string;
  appliedAt: string;
}

/**
 * Bring `sqlite` up to date.
 *
 * @returns the migrations applied by this call, in order. Empty when already current.
 */
export function runMigrations(sqlite: Database.Database, dir = MIGRATIONS_DIR): string[] {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const already = new Set(
    sqlite
      .prepare<[], { name: string }>('SELECT name FROM _migrations')
      .all()
      .map((row) => row.name),
  );

  const pending = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => !already.has(file));

  const record = sqlite.prepare<[string]>('INSERT INTO _migrations (name) VALUES (?)');

  for (const file of pending) {
    const statements = readFileSync(join(dir, file), 'utf8')
      .split(STATEMENT_SEPARATOR)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    // `foreign_keys` cannot be toggled inside a transaction, and a migration that rebuilds
    // a table needs it off; SQLite defers the check to COMMIT when we ask it to.
    const apply = sqlite.transaction(() => {
      for (const statement of statements) {
        sqlite.exec(statement);
      }
      record.run(file);
    });

    apply();
  }

  return pending;
}

/** Every migration this database has applied, oldest first. */
export function appliedMigrations(sqlite: Database.Database): AppliedMigration[] {
  const exists = sqlite
    .prepare<[], { count: number }>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = '_migrations'",
    )
    .get();

  if (!exists || exists.count === 0) return [];

  return sqlite
    .prepare<[], AppliedMigration>(
      'SELECT name, applied_at AS appliedAt FROM _migrations ORDER BY name',
    )
    .all();
}
