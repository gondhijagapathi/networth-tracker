import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createContext } from './context.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { scheduleCron } from './lib/cron.js';
import { evaluateDeadManSwitches } from './services/deadman.service.js';
import { ensureBootstrapInvite } from './services/invite.service.js';
import { refreshPrices } from './services/priceProvider.service.js';

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

/**
 * The dead-man sweep.
 *
 * A plain interval rather than a cron dependency: the switch measures elapsed days, so the
 * only thing that matters is that it runs *often enough*, not that it runs at 02:00. Once
 * an hour means a stage change is visible within the hour and a machine that was asleep
 * catches up on its next tick, because every stage is derived from timestamps rather than
 * from how many times this has fired.
 *
 * It runs once at boot for the same reason: a server that was off for a fortnight should
 * not wait another hour to notice.
 */
const SWEEP_INTERVAL_MS = 3_600_000;

function sweep(): void {
  try {
    const result = evaluateDeadManSwitches(ctx);
    if (result.fired.length > 0 || result.graced.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `dead-man sweep: ${result.graced.length} entered grace, ${result.fired.length} released`,
      );
    }
  } catch (error) {
    // A failed sweep must not take the process down: the app is still perfectly usable, and
    // the next tick will try again.
    console.warn('dead-man sweep failed', error);
  }
}

sweep();
const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
// Without this a `node dist/index.js` would refuse to exit on its own.
sweepTimer.unref();

/**
 * The nightly price refresh.
 *
 * Unlike the dead-man sweep this genuinely wants a fixed time, not "often enough" — AMFI
 * publishes once a day, and `NAV_REFRESH_CRON` (default `30 20 * * 1-5`, weekday evenings) is
 * what says when. A failed run is logged and dropped the same way a failed sweep is: manual
 * pricing keeps working regardless, and tomorrow's run gets another try.
 */
const priceJob = scheduleCron(config.NAV_REFRESH_CRON, () => {
  refreshPrices(ctx, { source: 'all' }, null, null).catch((error: unknown) => {
    console.warn('price refresh failed', error);
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Checkpoint the WAL and close cleanly so the next start does not have to recover.
    clearInterval(sweepTimer);
    priceJob.stop();
    server.close(() => {
      close();
      process.exit(0);
    });
  });
}
