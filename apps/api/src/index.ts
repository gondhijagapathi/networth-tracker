import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createContext } from './context.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { scheduleCron } from './lib/cron.js';
import { createBackup, pruneBackups } from './services/backup.service.js';
import { evaluateDeadManSwitches } from './services/deadman.service.js';
import { ensureBootstrapInvite } from './services/invite.service.js';
import { deliverDueEmails, pruneSentEmails } from './services/mail.service.js';
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
 * The outbox drain.
 *
 * Most messages do not wait for this — `queueEmail` nudges a delivery pass as soon as it
 * writes a row, because somebody staring at their inbox for a reset link should not have to
 * wait for a timer. What this loop is actually for is everything that pass could not do:
 * a message queued while the mail server was down, one queued by the dead-man sweep with
 * nobody around to nudge anything, and the retries of both.
 *
 * A minute, because the backoff schedule's first step is a minute and a poll that runs more
 * often than the thing it is polling for is just heat. A failing pass is logged and dropped
 * exactly as the dead-man sweep's is: the queue is durable, so the next tick tries again.
 */
const MAIL_INTERVAL_MS = 60_000;

function drainMail(): void {
  deliverDueEmails(ctx)
    .then((result) => {
      if (result.abandoned > 0) {
        // Loud, and only for the terminal case. A message this instance has given up on is
        // somebody who was not told something — the operator has to know, and the admin
        // screen they would otherwise have to think to open is not enough on its own.
        console.warn(
          `mail: gave up on ${result.abandoned} message(s) after repeated failures — see the admin screen`,
        );
      }
    })
    .catch((error: unknown) => {
      console.warn('mail delivery failed', error);
    });
}

if (config.mail === null) {
  console.warn(
    'Mail is off: SMTP_HOST is not set. Invites, password resets and dead-man warnings will be ' +
      'recorded but not delivered. See .env.example.',
  );
} else {
  // eslint-disable-next-line no-console
  console.log(
    `mail: sending through ${config.mail.host}:${config.mail.port} as ${config.mail.from}`,
  );
}

drainMail();
const mailTimer = setInterval(drainMail, MAIL_INTERVAL_MS);
mailTimer.unref();

/**
 * Forget delivered mail after a month. Hourly is far more often than needed for a daily
 * cutoff, and it costs one indexed delete against a table with a handful of rows in it.
 */
const mailPruneTimer = setInterval(() => {
  try {
    pruneSentEmails(ctx);
  } catch (error) {
    console.warn('mail prune failed', error);
  }
}, SWEEP_INTERVAL_MS);
mailPruneTimer.unref();

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

/**
 * The nightly backup.
 *
 * Two things have to be configured for this to run — a schedule and a passphrase — and it
 * says which one is missing rather than failing silently. An automatic backup that never
 * happened is the worst possible outcome for this feature, so the absence is logged at boot
 * where somebody setting the machine up will see it, not buried in a settings screen.
 *
 * Retention is applied after a successful run and only to the nightly bundles, so a failed
 * night never prunes the last good backup to make room for nothing.
 */
const backupPassphrase = config.BACKUP_PASSPHRASE;
const backupJob =
  config.BACKUP_CRON.trim() === '' || backupPassphrase === undefined
    ? null
    : scheduleCron(config.BACKUP_CRON, () => {
        createBackup(ctx, { passphrase: backupPassphrase, scheduled: true })
          .then((backup) => {
            const pruned = pruneBackups(ctx);
            // eslint-disable-next-line no-console
            console.log(
              `backup written: ${backup.filename} (${backup.sizeBytes} bytes)` +
                (pruned.length > 0 ? `, pruned ${pruned.length} older bundle(s)` : ''),
            );
          })
          .catch((error: unknown) => {
            console.warn('scheduled backup failed', error);
          });
      });

if (backupJob === null) {
  console.warn(
    config.BACKUP_CRON.trim() === ''
      ? 'Scheduled backups are off: BACKUP_CRON is empty.'
      : 'Scheduled backups are off: BACKUP_PASSPHRASE is not set, and a bundle is never written unencrypted.',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Checkpoint the WAL and close cleanly so the next start does not have to recover.
    clearInterval(sweepTimer);
    clearInterval(mailTimer);
    clearInterval(mailPruneTimer);
    priceJob.stop();
    backupJob?.stop();
    // Releases the pooled SMTP connection, which would otherwise hold the socket open past
    // the point where the server has stopped answering.
    ctx.mailer.close();
    server.close(() => {
      close();
      process.exit(0);
    });
  });
}
