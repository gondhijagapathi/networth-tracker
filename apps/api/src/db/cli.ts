/**
 * Database maintenance commands.
 *
 * `npm run db:migrate` applies pending migrations without starting the server — useful in
 * a deployment step, or to confirm a migration before letting traffic near it.
 * `npm run db:status` prints what has been applied.
 *
 * Migrations also run automatically on boot, so neither command is required in normal use.
 */

import { loadConfig } from '../config.js';
import { createDb } from './client.js';
import { appliedMigrations, runMigrations } from './migrate.js';

const command = process.argv[2] ?? 'migrate';
const config = loadConfig();
const { sqlite, close } = createDb(config.DATABASE_PATH);

try {
  if (command === 'migrate') {
    const applied = runMigrations(sqlite);
    // eslint-disable-next-line no-console
    console.log(
      applied.length === 0
        ? `${config.DATABASE_PATH} is up to date.`
        : `Applied ${applied.length} migration(s):\n  ${applied.join('\n  ')}`,
    );
  } else if (command === 'status') {
    const rows = appliedMigrations(sqlite);
    // eslint-disable-next-line no-console
    console.log(
      rows.length === 0
        ? 'No migrations applied yet.'
        : rows.map((row) => `${row.name}  ${row.appliedAt}`).join('\n'),
    );
  } else {
    console.error(`Unknown command "${command}". Use "migrate" or "status".`);
    process.exitCode = 1;
  }
} finally {
  close();
}
