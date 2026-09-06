/**
 * SQLite connection.
 *
 * One file, opened once per process. The pragmas below are not optional niceties — they
 * are what make a single-file database safe to run an application against:
 *
 *   journal_mode = WAL   readers never block the writer, and a crash cannot tear a page
 *   foreign_keys = ON    SQLite defaults this OFF; without it our references are comments
 *   synchronous = NORMAL fsync on checkpoint rather than every commit. Safe under WAL for
 *                        everything short of a power cut, and an order of magnitude faster
 *   busy_timeout         wait for a lock instead of failing the request outright
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/**
 * Named from Drizzle's own type rather than inferred from `createDb`, which would make the
 * alias and the factory's return type reference each other.
 */
export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close: () => void;
}

/**
 * Open the database at `path`, creating the containing directory if needed.
 *
 * Pass `:memory:` for tests — the pragmas that make no sense for an in-memory database
 * are skipped rather than failing.
 */
export function createDb(path: string): DbHandle {
  const inMemory = path === ':memory:';

  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);

  if (!inMemory) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema, casing: 'snake_case' });

  return {
    db,
    sqlite,
    close: () => {
      // A clean checkpoint keeps the -wal file from outliving the process.
      if (!inMemory) sqlite.pragma('wal_checkpoint(TRUNCATE)');
      sqlite.close();
    },
  };
}
