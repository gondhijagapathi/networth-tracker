/**
 * The vault.
 *
 * Three screens behind one route, because they are three states of one thing: no vault yet,
 * locked, and open. Splitting them across URLs would put "locked" in the browser history,
 * which is exactly where it does not belong.
 *
 * The tone of the copy is deliberate. This is the only screen in the application where a
 * mistake is unrecoverable — a forgotten vault passphrase cannot be reset by an admin,
 * because no admin holds anything that could reset it — so the setup form says so before
 * the field, not in a tooltip afterwards.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  VAULT_ITEM_KIND_LABELS,
  VAULT_ITEM_KINDS,
  type CipherEnvelope,
  type DocumentMetaPayload,
  type VaultDocumentRecord,
  type VaultItemKind,
  type VaultItemPayload,
  type VaultItemRecord,
} from '@networth/shared';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../components/ui.js';
import { ApiError } from '../lib/api.js';
import { endpoints } from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';
import { IDLE_LOCK_MS, useVault } from '../lib/vault.js';

/** A vault item with its payload already decrypted. Never leaves this module. */
interface OpenItem extends Omit<VaultItemRecord, 'payload'> {
  payload: VaultItemPayload;
}

interface OpenDocument extends Omit<VaultDocumentRecord, 'meta'> {
  meta: DocumentMetaPayload;
}

export function Vault() {
  const vault = useVault();

  if (vault.state === 'loading') return <Skeleton className="h-64" />;
  if (vault.state === 'absent') return <SetUpVault />;
  if (vault.state === 'locked') return <UnlockVault />;
  return <OpenVault />;
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

function SetUpVault() {
  const { create } = useVault();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = passphrase.length > 0 && passphrase.length < 12;
  const mismatched = confirmation.length > 0 && confirmation !== passphrase;
  const ready = passphrase.length >= 12 && confirmation === passphrase && acknowledged;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await create(passphrase);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the vault.');
    } finally {
      setBusy(false);
      // Out of React's hands as soon as it is used. The derived key is what is kept, in
      // memory, and the passphrase itself has no reason to survive this function.
      setPassphrase('');
      setConfirmation('');
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Set up your vault"
        subtitle="Bank logins, policy numbers, where the papers are — encrypted in this browser."
      />

      <Card>
        <div className="space-y-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          <p>
            Your vault passphrase is <strong>not</strong> your sign-in password, and it never leaves
            this device. The server stores only ciphertext.
          </p>
          <p style={{ color: 'var(--color-warn)' }}>
            That also means nobody can reset it. Not an administrator, not the person running this
            server, not us. If you forget it, everything in the vault is gone — the rest of your net
            worth data is untouched, but the vault itself cannot be recovered.
          </p>
          <p>Write it down and put it somewhere your nominee will eventually look.</p>
        </div>
      </Card>

      <Card>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <Field
            label="Vault passphrase"
            hint="At least 12 characters. A sentence you will remember beats a short scramble."
            error={tooShort ? 'Use at least 12 characters' : undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>

          <Field label="Type it again" error={mismatched ? 'These do not match' : undefined}>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span style={{ color: 'var(--text-secondary)' }}>
              I understand that a forgotten vault passphrase cannot be recovered.
            </span>
          </label>

          {error !== null && <ErrorNotice message={error} />}

          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? 'Deriving your key…' : 'Create vault'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Unlock                                                                     */
/* -------------------------------------------------------------------------- */

function UnlockVault() {
  const { unlock, status } = useVault();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(passphrase);
    } catch (caught) {
      // A wrong passphrase surfaces as a decryption failure, which is a `DOMException` with
      // an unhelpful message. Rate limiting from the server is a real message, so it wins.
      setError(
        caught instanceof ApiError ? caught.message : 'That passphrase did not open the vault.',
      );
      setPassphrase('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader
        title="Unlock your vault"
        subtitle={
          status === null
            ? undefined
            : `${status.itemCount} item${status.itemCount === 1 ? '' : 's'}, ${status.documentCount} document${status.documentCount === 1 ? '' : 's'}`
        }
      />

      <Card>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <Field label="Vault passphrase">
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>

          {error !== null && <ErrorNotice message={error} />}

          <Button type="submit" variant="primary" disabled={busy || passphrase.length === 0}>
            {busy ? 'Deriving your key…' : 'Unlock'}
          </Button>

          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Deriving the key takes a second or two — deliberately, so that guessing is expensive.
            The vault locks itself again after {Math.round(IDLE_LOCK_MS / 60000)} minutes of
            inactivity.
          </p>
        </form>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Open                                                                       */
/* -------------------------------------------------------------------------- */

function OpenVault() {
  const vault = useVault();
  const [items, setItems] = useState<OpenItem[] | null>(null);
  const [documents, setDocuments] = useState<OpenDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OpenItem | 'new' | null>(null);

  /*
   * Read through a ref rather than closing over the context value.
   *
   * `refresh` inside this function updates the provider, which produces a new context
   * object; a `load` that depended on that object would be a new function every time it
   * ran, and the effect below would call it again for ever.
   */
  const latest = useRef(vault);
  latest.current = vault;

  const load = useCallback(async () => {
    const current = latest.current;
    try {
      const [itemsResponse, documentsResponse] = await Promise.all([
        endpoints.vaultItems(),
        endpoints.vaultDocuments(),
      ]);

      // Decryption happens here, once, and the plaintext never goes back over the wire.
      setItems(
        await Promise.all(
          itemsResponse.items.map(async (item) => ({
            ...item,
            payload: await current.decrypt<VaultItemPayload>(item.payload),
          })),
        ),
      );
      setDocuments(
        await Promise.all(
          documentsResponse.documents.map(async (document) => ({
            ...document,
            meta: await current.decrypt<DocumentMetaPayload>(document.meta),
          })),
        ),
      );
      await current.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read the vault.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (items === null || documents === null) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Vault"
        subtitle="Unlocked. Nothing here has ever reached the server in the clear."
        action={
          <div className="flex gap-2">
            <Button onClick={() => vault.lock()}>Lock</Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              Add item
            </Button>
          </div>
        }
      />

      {editing !== null && (
        <ItemForm
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {items.length === 0 ? (
        <EmptyState
          title="The vault is empty"
          description="Add the login for a bank account, the number on a policy, or a note telling your nominee where the papers are."
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              Add the first item
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              onEdit={() => setEditing(item)}
              onChanged={() => void load()}
            />
          ))}
        </div>
      )}

      <Documents documents={documents} onChanged={() => void load()} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

function ItemRow({
  item,
  onEdit,
  onChanged,
}: {
  item: OpenItem;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <Card as="article">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{item.payload.label}</h3>
            <Pill>{VAULT_ITEM_KIND_LABELS[item.kind]}</Pill>
            {item.assetId !== null && (
              <Link to={`/assets/${item.assetId}`} className="text-xs underline">
                Linked asset
              </Link>
            )}
          </div>

          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Detail label="Username" value={item.payload.username} />
            <Detail label="Reference" value={item.payload.reference} />
            <Detail label="Where" value={item.payload.location} />
            <Detail label="URL" value={item.payload.url} />
          </dl>

          {item.payload.secret !== undefined && item.payload.secret !== '' && (
            <p className="mt-2 font-mono text-sm">
              {/* Hidden by default: a vault open on a shared screen should not read out. */}
              {revealed ? item.payload.secret : '••••••••••••'}{' '}
              <Button variant="ghost" onClick={() => setRevealed(!revealed)}>
                {revealed ? 'Hide' : 'Reveal'}
              </Button>
            </p>
          )}

          {item.payload.notes !== undefined && item.payload.notes !== '' && (
            <p
              className="mt-2 text-sm whitespace-pre-wrap"
              style={{ color: 'var(--text-secondary)' }}
            >
              {item.payload.notes}
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          <Button onClick={onEdit}>Edit</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!window.confirm(`Delete “${item.payload.label}”? This cannot be undone.`)) return;
              void endpoints.deleteVaultItem(item.id).then(onChanged);
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined || value === '') return null;
  return (
    <div className="flex gap-2">
      <dt className="shrink-0" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

function ItemForm({
  item,
  onClose,
  onSaved,
}: {
  item: OpenItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const vault = useVault();
  const [kind, setKind] = useState<VaultItemKind>(item?.kind ?? 'bank_login');
  const [payload, setPayload] = useState<VaultItemPayload>(item?.payload ?? { label: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (field: keyof VaultItemPayload) => (value: string) =>
    setPayload((previous) => ({ ...previous, [field]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Encrypt first, then send. There is no code path in which the object above is
      // serialised into a request body.
      const encrypted: CipherEnvelope = await vault.encrypt(payload);
      if (item === null) await endpoints.createVaultItem({ kind, payload: encrypted });
      else await endpoints.updateVaultItem(item.id, { kind, payload: encrypted });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the item.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle
        action={
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        }
      >
        {item === null ? 'New vault item' : 'Edit vault item'}
      </CardTitle>

      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
        <Field label="What is it">
          <Select value={kind} onChange={(event) => setKind(event.target.value as VaultItemKind)}>
            {VAULT_ITEM_KINDS.map((option) => (
              <option key={option} value={option}>
                {VAULT_ITEM_KIND_LABELS[option]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Name" hint="How you will recognise it. Encrypted like everything else.">
          <Input
            value={payload.label}
            onChange={(event) => set('label')(event.target.value)}
            required
          />
        </Field>

        <Field label="Username">
          <Input
            value={payload.username ?? ''}
            onChange={(event) => set('username')(event.target.value)}
          />
        </Field>

        <Field label="Password or PIN">
          <Input
            type="password"
            autoComplete="off"
            value={payload.secret ?? ''}
            onChange={(event) => set('secret')(event.target.value)}
          />
        </Field>

        <Field
          label="Full account or policy number"
          hint="The unmasked one. This is the place for it."
        >
          <Input
            value={payload.reference ?? ''}
            onChange={(event) => set('reference')(event.target.value)}
          />
        </Field>

        <Field label="Where the papers are">
          <Input
            value={payload.location ?? ''}
            placeholder="Locker 44, Canara Bank Jayanagar"
            onChange={(event) => set('location')(event.target.value)}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label="Notes for whoever claims this">
            <textarea
              className="input"
              rows={3}
              value={payload.notes ?? ''}
              onChange={(event) => set('notes')(event.target.value)}
            />
          </Field>
        </div>

        {error !== null && (
          <div className="sm:col-span-2">
            <ErrorNotice message={error} />
          </div>
        )}

        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy || payload.label.trim() === ''}>
            {busy ? 'Encrypting…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

function Documents({ documents, onChanged }: { documents: OpenDocument[]; onChanged: () => void }) {
  const vault = useVault();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const ciphertext = await vault.encryptFile(await file.arrayBuffer());
      const meta = await vault.encrypt({
        filename: file.name,
        mime: file.type || 'application/octet-stream',
      });
      await endpoints.uploadDocument(ciphertext, meta);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload that file.');
    } finally {
      setBusy(false);
    }
  }

  /** Decrypt in the browser and hand the plaintext straight to a download. */
  async function download(document_: OpenDocument) {
    const blob = await endpoints.downloadDocument(document_.id);
    const plaintext = await vault.decryptFile(blob);
    saveBlob(
      new Blob([plaintext as BlobPart], { type: document_.meta.mime }),
      document_.meta.filename,
    );
  }

  return (
    <Card>
      <CardTitle
        action={
          <label className="btn btn-secondary cursor-pointer">
            {busy ? 'Encrypting…' : 'Upload'}
            <input
              type="file"
              className="hidden"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void upload(file);
              }}
            />
          </label>
        }
      >
        Documents
      </CardTitle>

      {error !== null && <ErrorNotice message={error} />}

      {documents.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          A will, a policy schedule, a scan of a property deed. Encrypted here before it is uploaded
          — the server never learns even the filename.
        </p>
      ) : (
        <ul className="divide-y">
          {documents.map((document_) => (
            <li
              key={document_.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{document_.meta.filename}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatBytes(document_.sizeBytes)} · {formatDate(document_.createdAt)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => void download(document_)}>Download</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (!window.confirm(`Delete “${document_.meta.filename}”?`)) return;
                    void endpoints.deleteDocument(document_.id).then(onChanged);
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
  );
}

/** Sizes are of the ciphertext, which is 28 bytes longer than the file. Close enough to read. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
