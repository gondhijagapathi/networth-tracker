import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createContext } from './context.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { ensureBootstrapInvite } from './services/invite.service.js';

const config = loadConfig();
const { db, sqlite, close } = createDb(config.DATABASE_PATH);

// Migrations run before the first request is served, not lazily: a half-migrated database
// answering requests is worse than a process that refuses to start.
const applied = runMigrations(sqlite);
if (applied.length > 0) {
  // eslint-disable-next-line no-console
  console.log(`applied ${applied.length} migration(s): ${applied.join(', ')}`);
}

const ctx = createContext(config, db, sqlite);

if (ensureBootstrapInvite(ctx)) {
  // eslint-disable-next-line no-console
  console.log(
    'No accounts yet. Register the first admin at /register using BOOTSTRAP_INVITE_CODE.',
  );
}

const app = createApp(ctx);

const server = app.listen(config.API_PORT, config.API_HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`networth-tracker api listening on http://${config.API_HOST}:${config.API_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Checkpoint the WAL and close cleanly so the next start does not have to recover.
    server.close(() => {
      close();
      process.exit(0);
    });
  });
}
