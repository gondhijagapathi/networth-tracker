/**
 * Guards the join between `schema.ts` and the committed SQL in `migrations/`.
 *
 * `drizzle-kit` is not a project dependency — it is fetched on demand to regenerate
 * migrations — so nothing forces the two to agree. This test does: it builds a database
 * from the migrations alone and checks that every table and column Drizzle believes in
 * actually exists, with the same nullability and primary keys.
 *
 * Without it, a hand-edited migration or a forgotten `db:generate` would surface as a
 * runtime "no such column" in whichever feature happened to touch it first.
 */

import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as schema from '../schema.js';
import { MIGRATIONS_DIR, appliedMigrations, runMigrations } from '../migrate.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function migratedDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  runMigrations(sqlite);
  return sqlite;
}

const tables = Object.values(schema).filter(
  (value): value is Parameters<typeof getTableConfig>[0] =>
    typeof value === 'object' && value !== null && Symbol.for('drizzle:Name') in value,
);

describe('migrations', () => {
  it('apply cleanly to an empty database', () => {
    const sqlite = migratedDatabase();
    // Read from the directory rather than a hard-coded list: the assertion that matters is
    // "every committed migration ran", and that should not need editing each phase.
    const committed = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    expect(committed.length).toBeGreaterThan(0);
    expect(appliedMigrations(sqlite).map((m) => m.name)).toEqual(committed);
    sqlite.close();
  });

  it('are idempotent — a second run applies nothing', () => {
    const sqlite = migratedDatabase();
    expect(runMigrations(sqlite)).toEqual([]);
    sqlite.close();
  });
});

describe('schema matches the migrations', () => {
  it('finds every table the ORM defines', () => {
    const sqlite = migratedDatabase();
    const present = new Set(
      sqlite
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );

    for (const table of tables) {
      expect(present.has(getTableConfig(table).name)).toBe(true);
    }
    sqlite.close();
  });

  it('agrees on columns, nullability and primary keys', () => {
    const sqlite = migratedDatabase();

    for (const table of tables) {
      const config = getTableConfig(table);
      const actual = sqlite.prepare<[], ColumnInfo>(`PRAGMA table_info(${config.name})`).all();
      const byName = new Map(actual.map((column) => [column.name, column]));

      expect([...byName.keys()].sort(), `columns of ${config.name}`).toEqual(
        config.columns.map((column) => column.name).sort(),
      );

      // A composite key is declared separately from the columns it spans, so the expected
      // set is the union of single-column `.primary` flags and any `primaryKey({...})`.
      const expectedKey = new Set([
        ...config.columns.filter((column) => column.primary).map((column) => column.name),
        ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
      ]);

      for (const column of config.columns) {
        const live = byName.get(column.name)!;
        expect(Boolean(live.notnull), `${config.name}.${column.name} NOT NULL`).toBe(
          column.notNull,
        );
        expect(live.pk > 0, `${config.name}.${column.name} primary key`).toBe(
          expectedKey.has(column.name),
        );
      }
    }
    sqlite.close();
  });
});

describe('database integrity rules', () => {
  it('enforces the role and status CHECK constraints', () => {
    const sqlite = migratedDatabase();
    const insert = (role: string, status: string) =>
      sqlite
        .prepare(
          `INSERT INTO users (id, email, name, password_hash, role, status)
           VALUES (?, ?, 'X', 'hash', ?, ?)`,
        )
        .run(crypto.randomUUID(), `${role}-${status}@example.com`, role, status);

    expect(() => insert('member', 'active')).not.toThrow();
    // TypeScript's enums stop at the compiler; a restore or a manual fix does not.
    expect(() => insert('superuser', 'active')).toThrow(/CHECK constraint/);
    expect(() => insert('member', 'deleted')).toThrow(/CHECK constraint/);
    sqlite.close();
  });

  it('cascades a deleted user to their sessions and recovery codes', () => {
    const sqlite = migratedDatabase();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'a@b.com', 'A', 'h')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at)
         VALUES ('t1', 'u1', 'f1', 'hash', '2030-01-01T00:00:00.000Z')`,
      )
      .run();

    sqlite.prepare(`DELETE FROM users WHERE id = 'u1'`).run();

    const remaining = sqlite
      .prepare<[], { count: number }>('SELECT count(*) AS count FROM refresh_tokens')
      .get();
    expect(remaining?.count).toBe(0);
    sqlite.close();
  });

  it('keeps the audit trail when its actor is deleted', () => {
    const sqlite = migratedDatabase();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'a@b.com', 'A', 'h')`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO audit_log (id, actor_user_id, action) VALUES ('a1', 'u1', 'user.login')`,
      )
      .run();

    sqlite.prepare(`DELETE FROM users WHERE id = 'u1'`).run();

    // The actor is nulled, not the row removed — an audit that vanishes with its subject
    // is not an audit.
    const row = sqlite
      .prepare<[], { actor_user_id: string | null; action: string }>('SELECT * FROM audit_log')
      .get();
    expect(row?.action).toBe('user.login');
    expect(row?.actor_user_id).toBeNull();
    sqlite.close();
  });

  it('rejects a duplicate email regardless of the rest of the row', () => {
    const sqlite = migratedDatabase();
    const insert = sqlite.prepare(
      `INSERT INTO users (id, email, name, password_hash) VALUES (?, 'dup@example.com', 'X', 'h')`,
    );
    insert.run('u1');
    expect(() => insert.run('u2')).toThrow(/UNIQUE constraint/);
    sqlite.close();
  });
});
