/**
 * Settings: how numbers read, how the data gets out, and how it comes back.
 *
 * The backup half of this screen is the one place in the application where a single click
 * can destroy everything, so it is built to slow that click down: a restore asks for the
 * file, then the passphrase, then the word "restore" typed out, and it says in advance
 * exactly what it will replace. The counterweight is that the server takes a safety snapshot
 * before it touches anything, and this screen tells you the name of it afterwards.
 *
 * Backups are admin-only on the server — a bundle is every account on the installation, not
 * one person's — so the whole section is hidden from a member rather than shown as a row of
 * buttons that answer 403.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EXPORT_DATASETS,
  EXPORT_DATASET_LABELS,
  MIN_BACKUP_PASSPHRASE,
  type BackupListResponse,
  type ExportDataset,
  type RestoreResult,
} from '@networth/shared';
import {
  Button,
  Card,
  CardTitle,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../components/ui.js';
import { ApiError } from '../lib/api.js';
import { useDisplay } from '../lib/display.js';
import { endpoints } from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';
import { usePrivacy } from '../lib/privacy.js';
import { useSession } from '../lib/session.js';
import { applyTheme, readTheme, type Theme } from '../lib/theme.js';

export function Settings() {
  const { user } = useSession();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        subtitle="How this looks, and how your data gets in and out of it."
      />

      <DisplayCard />
      <ExportCard />
      {user?.role === 'admin' && <BackupCard />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

function DisplayCard() {
  const { compact, toggle } = useDisplay();
  const { hidden, toggle: togglePrivacy } = usePrivacy();
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <Card>
      <CardTitle>Display</CardTitle>
      <div className="space-y-3">
        <Toggle
          label="Lakh and crore"
          hint={
            compact
              ? 'Amounts read as ₹1.23 Cr. The exact figure is in the tooltip.'
              : 'Amounts read in full, as ₹1,23,45,678.00.'
          }
          pressed={compact}
          onChange={toggle}
        />
        <Toggle
          label="Hide amounts"
          hint="Blurs every figure on screen. Press H anywhere to toggle it."
          pressed={hidden}
          onChange={togglePrivacy}
        />
        <Toggle
          label="Dark theme"
          hint="Light is fully supported; dark is what this was designed in."
          pressed={theme === 'dark'}
          onChange={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      </div>
    </Card>
  );
}

/**
 * A switch.
 *
 * A real `<button>` with `aria-pressed` rather than a styled checkbox: it is reachable by
 * keyboard, announced as a toggle by a screen reader, and does not depend on a label's
 * `for` attribute to be operable.
 */
function Toggle({
  label,
  hint,
  pressed,
  onChange,
}: {
  label: string;
  hint: string;
  pressed: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {hint}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={pressed}
        aria-label={label}
        onClick={onChange}
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        style={{
          background: pressed ? 'var(--accent-solid)' : 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full transition-all"
          style={{
            left: pressed ? '1.5rem' : '0.15rem',
            background: pressed ? 'oklch(0.99 0 0)' : 'var(--text-muted)',
          }}
        />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

function ExportCard() {
  const [dataset, setDataset] = useState<ExportDataset>('assets');

  return (
    <Card>
      <CardTitle>Export</CardTitle>
      <p className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
        Your own assets, transactions and valuations — not your household&rsquo;s. Vault items come
        out as the ciphertext they are stored as; nothing here can read them, including this server.
      </p>

      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Field label="Spreadsheet" hint="One sheet per asset class, in rupees.">
              <Select
                value={dataset}
                onChange={(event) => setDataset(event.target.value as ExportDataset)}
              >
                {EXPORT_DATASETS.map((option) => (
                  <option key={option} value={option}>
                    {EXPORT_DATASET_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <a className="btn btn-secondary" href={endpoints.exportCsvUrl(dataset)} download>
            Download CSV
          </a>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            The complete record, with exact paise and every typed detail. This is the one to migrate
            from.
          </p>
          <a className="btn btn-secondary" href={endpoints.exportJsonUrl()} download>
            Download JSON
          </a>
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Backup                                                                     */
/* -------------------------------------------------------------------------- */

function BackupCard() {
  const [state, setState] = useState<BackupListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await endpoints.backups());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not list backups.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (state === null) return <Skeleton className="h-64" />;

  return (
    <>
      <Card>
        <CardTitle
          action={
            state.schedule === null ? (
              <Pill tone="var(--color-warn)">No nightly backup</Pill>
            ) : (
              <Pill>Nightly at {state.schedule.cron}</Pill>
            )
          }
        >
          Backup
        </CardTitle>

        <p className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          One encrypted file holding every account, asset and document on this server.
          {state.schedule === null
            ? ' Automatic backups are off — set BACKUP_CRON and BACKUP_PASSPHRASE to turn them on.'
            : ` The newest ${state.schedule.retention} nightly bundles are kept.`}
        </p>

        <CreateBackup onCreated={() => void load()} />

        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          Written to <code>{state.directory}</code>. A backup on the same disk as the database
          protects you from mistakes, not from that disk failing — copy it somewhere else, and test
          a restore at least once.
        </p>
      </Card>

      <Card>
        <CardTitle>Bundles on this server</CardTitle>
        {state.backups.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            None yet.
          </p>
        ) : (
          <ul className="divide-y">
            {state.backups.map((backup) => (
              <li
                key={backup.filename}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{backup.filename}</p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {formatDate(backup.createdAt)} · {formatBytes(backup.sizeBytes)}
                    {backup.scheduled && ' · automatic'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    className="btn btn-secondary"
                    href={endpoints.backupDownloadUrl(backup.filename)}
                    download
                  >
                    Download
                  </a>
                  <Button
                    variant="danger"
                    onClick={() => {
                      void endpoints.deleteBackup(backup.filename).then(load);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <RestoreCard onRestored={() => void load()} />
    </>
  );
}

function CreateBackup({ onCreated }: { onCreated: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { backup } = await endpoints.createBackup(passphrase);
      setMessage(`Wrote ${backup.filename} (${formatBytes(backup.sizeBytes)}).`);
      setPassphrase('');
      onCreated();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not write the backup.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="min-w-56 flex-1">
        <Field
          label="Passphrase"
          hint={`At least ${MIN_BACKUP_PASSPHRASE} characters. It is not stored anywhere — a lost passphrase is a lost backup.`}
          error={error ?? undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="A phrase you will remember"
          />
        </Field>
      </div>
      <Button
        variant="primary"
        type="submit"
        disabled={busy || passphrase.length < MIN_BACKUP_PASSPHRASE}
      >
        {busy ? 'Working…' : 'Back up now'}
      </Button>
      {message !== null && (
        <p className="w-full text-xs" style={{ color: 'var(--color-gain)' }} role="status">
          {message}
        </p>
      )}
    </form>
  );
}

/**
 * Restore.
 *
 * Three separate acts before anything happens: choose a file, type the passphrase, and type
 * the word. Not friction for its own sake — this is the only control in the application that
 * deletes other people's data, and the person using it is usually having a bad day already.
 */
function RestoreCard({ onRestored }: { onRestored: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);

  const ready =
    file !== null && passphrase.length >= MIN_BACKUP_PASSPHRASE && confirmation === 'restore';

  const submit = async (): Promise<void> => {
    if (file === null) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await endpoints.restoreBackup(await file.arrayBuffer(), passphrase));
      setPassphrase('');
      setConfirmation('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onRestored();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The restore failed.');
    } finally {
      setBusy(false);
    }
  };

  if (result !== null) {
    return (
      <Card>
        <CardTitle>Restored</CardTitle>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          From a backup taken {formatDate(result.manifest.createdAt)} by version{' '}
          {result.manifest.appVersion}. The state before it is in{' '}
          <code className="text-xs">{result.safetyBackup}</code>.
        </p>

        <ul className="mt-3 grid gap-1 sm:grid-cols-2">
          {result.tables
            .filter((table) => table.actual > 0)
            .map((table) => (
              <li key={table.table} className="flex justify-between text-xs">
                <span style={{ color: 'var(--text-secondary)' }}>{table.table}</span>
                <span className="tabular">{table.actual}</span>
              </li>
            ))}
          <li className="flex justify-between text-xs">
            <span style={{ color: 'var(--text-secondary)' }}>documents</span>
            <span className="tabular">{result.documentsRestored}</span>
          </li>
        </ul>

        {result.warnings.length > 0 && (
          <ul className="mt-3 space-y-1">
            {result.warnings.map((warning) => (
              <li key={warning} className="text-xs" style={{ color: 'var(--color-warn)' }}>
                {warning}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Everyone signed in has been replaced by whoever was in the backup — including you. Sign in
          again with the credentials from that point in time.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardTitle>Restore</CardTitle>
      <p className="mb-3 text-sm" style={{ color: 'var(--color-loss)' }} role="note">
        This replaces every account, asset, document and session on this server with the contents of
        the bundle. There is no partial restore, and no merge.
      </p>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Bundle" hint="The .ntb file you downloaded or copied off the machine.">
          <input
            ref={fileInput}
            className="input"
            type="file"
            accept=".ntb"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>

        <Field label="Passphrase" hint="The one this bundle was sealed with.">
          <Input
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </Field>

        <Field
          label="Type “restore” to confirm"
          hint="A safety snapshot of the current state is taken first, under this same passphrase."
          error={error ?? undefined}
        >
          <Input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="restore"
          />
        </Field>

        <Button variant="danger" type="submit" disabled={!ready || busy}>
          {busy ? 'Restoring…' : 'Replace everything with this bundle'}
        </Button>
      </form>
    </Card>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
