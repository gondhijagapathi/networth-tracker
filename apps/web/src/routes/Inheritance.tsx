/**
 * The nominee's portal.
 *
 * What an heir sees. Most of the time it says "sealed", which is the whole point: they can
 * confirm that arrangements exist, and see what they will one day have to claim, without
 * being able to read a single password until the owner or the switch says so.
 *
 * When an escrow has been released, this is where the two halves finally meet — the heir's
 * own vault passphrase unwraps their private key, that unwraps the owner's data key, and
 * that opens the owner's items. All four steps happen in this browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  VAULT_ITEM_KIND_LABELS,
  type EstateSummary,
  type VaultItemKind,
  type VaultItemPayload,
} from '@networth/shared';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Pill,
  Skeleton,
} from '../components/ui.js';
import { endpoints } from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';
import { useVault } from '../lib/vault.js';

interface OpenedSecret {
  id: string;
  kind: VaultItemKind;
  payload: VaultItemPayload;
}

export function Inheritance() {
  const [estates, setEstates] = useState<EstateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEstates((await endpoints.estates()).estates);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your estates.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (estates === null) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="You are a nominee"
        subtitle="Estates you have been named in, and what you can see of each."
      />

      {estates.length === 0 ? (
        <EmptyState
          title="Nobody has named you"
          description="If someone names you as their nominee in this app, their estate will appear here."
        />
      ) : (
        estates.map((estate) => <EstateCard key={estate.ownerUserId} estate={estate} />)
      )}
    </div>
  );
}

function EstateCard({ estate }: { estate: EstateSummary }) {
  const vault = useVault();
  const [secrets, setSecrets] = useState<OpenedSecret[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const released = estate.escrowState === 'released';

  /**
   * Open the estate.
   *
   * Four unwrappings, in order: this user's passphrase already produced their private key at
   * unlock; the server hands over the wrapped data key; the private key opens it; the data
   * key opens the items. The server watched all of it and learned nothing.
   */
  async function openVault() {
    setBusy(true);
    setError(null);
    try {
      const { wrappedDek } = await endpoints.estateKey(estate.ownerUserId);
      const key = await vault.openEstate(wrappedDek);
      const { items } = await endpoints.estateItems(estate.ownerUserId);

      setSecrets(
        await Promise.all(
          items.map(async (item) => ({
            id: item.id,
            kind: item.kind,
            payload: await key.decrypt<VaultItemPayload>(item.payload),
          })),
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open that vault.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="article">
      <CardTitle
        action={
          <Link to={`/claim-kit?ownerId=${estate.ownerUserId}`} className="btn btn-secondary">
            Claim kit
          </Link>
        }
      >
        {estate.ownerName}
      </CardTitle>

      <div className="flex flex-wrap items-center gap-2">
        <Pill>{estate.relation ?? 'Nominee'}</Pill>
        <Pill>{(estate.sharePercentBps / 100).toFixed(0)}% share</Pill>
        <Pill tone={released ? 'var(--color-warn)' : undefined}>
          {estate.escrowState === null
            ? 'No vault key held for you'
            : released
              ? `Vault released ${formatDate(estate.releasedAt)}`
              : 'Vault key sealed'}
        </Pill>
      </div>

      <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        {estate.accessLevel === 'summary'
          ? 'You can see what this estate is worth and how it is spread. Account details are not shared with you.'
          : 'You can see every asset in this estate and print a claim kit for it.'}
      </p>

      {estate.escrowState === 'sealed' && (
        <p className="mt-2 text-sm">
          A key to {estate.ownerName}’s vault is held for you, sealed. It opens when they release
          it, or when their dead-man switch fires. Until then nobody — including the server holding
          it — can open it.
        </p>
      )}

      {released && secrets === null && (
        <div className="mt-3">
          <Button
            variant="primary"
            disabled={busy || vault.state !== 'unlocked'}
            title={vault.state === 'unlocked' ? undefined : 'Unlock your own vault first'}
            onClick={() => void openVault()}
          >
            {busy ? 'Opening…' : 'Open the vault'}
          </Button>
          {vault.state !== 'unlocked' && (
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              Unlock your own vault first — your passphrase is what decrypts the private key this
              estate was sealed to.
            </p>
          )}
        </div>
      )}

      {secrets !== null && (
        <div className="mt-3 space-y-2">
          {secrets.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              The vault is open and empty.
            </p>
          ) : (
            secrets.map((secret) => (
              <div
                key={secret.id}
                className="rounded-xl p-3"
                style={{ background: 'var(--surface-sunken)' }}
              >
                <p className="text-sm font-medium">
                  {secret.payload.label}{' '}
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {VAULT_ITEM_KIND_LABELS[secret.kind]}
                  </span>
                </p>
                <dl className="mt-1 space-y-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {secret.payload.username !== undefined && (
                    <dd>User: {secret.payload.username}</dd>
                  )}
                  {secret.payload.secret !== undefined && (
                    <dd className="font-mono">Secret: {secret.payload.secret}</dd>
                  )}
                  {secret.payload.reference !== undefined && (
                    <dd>Number: {secret.payload.reference}</dd>
                  )}
                  {secret.payload.location !== undefined && (
                    <dd>Papers: {secret.payload.location}</dd>
                  )}
                  {secret.payload.notes !== undefined && (
                    <dd className="whitespace-pre-wrap">{secret.payload.notes}</dd>
                  )}
                </dl>
              </div>
            ))
          )}
        </div>
      )}

      {error !== null && <ErrorNotice message={error} />}
    </Card>
  );
}
