/**
 * Backup and restore — the operator's half of the installation.
 *
 * This lives with administration rather than with settings because a bundle is not one
 * person's data: it is every account, asset and document on the server. The server agrees —
 * `routes/backup.ts` is behind the admin role — so a member never sees these cards at all,
 * rather than seeing a row of buttons that answer 403.
 *
 * It is also the one place in the application where a single click can destroy everything,
 * so it is built to slow that click down: a restore asks for the file, then the passphrase,
 * then the word "restore" typed out, and it says in advance exactly what it will replace.
 * The counterweight is that the server takes a safety snapshot before it touches anything,
 * and this screen tells you the name of it afterwards.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MIN_BACKUP_PASSPHRASE,
  type BackupListResponse,
  type RestoreResult,
} from '@networth/shared';
import { Button, Card, CardTitle, ErrorNotice, Field, Input, Pill, Skeleton } from './ui.js';
import { ApiError } from '../lib/api.js';
import { endpoints } from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';

export function BackupSection() {
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
