/**
 * The claim kit.
 *
 * A document to print and put with the will. It is deliberately dense and deliberately dull:
 * an heir reads this on the worst week of their life, and the useful thing is a list of
 * institutions, forms and account numbers, not a dashboard.
 *
 * **It is printed from the browser, not rendered to a PDF on the server, and that is a
 * security decision rather than a shortcut.** The kit is only complete once the vault
 * plaintext is merged into it, and the only place that plaintext exists is here. A
 * server-rendered PDF would require the server to hold it, and the moment it does, the
 * zero-knowledge claim in docs/SECURITY-MODEL.md stops being true.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  formatINR,
  type ClaimKitResponse,
  type VaultItemPayload,
  type VaultItemRecord,
} from '@networth/shared';
import { Button, Card, ErrorNotice, PageHeader, Skeleton } from '../components/ui.js';
import { endpoints } from '../lib/endpoints.js';
import { ASSET_TYPE_LABELS, formatDate } from '../lib/format.js';
import { useVault } from '../lib/vault.js';

export function ClaimKit() {
  const [params] = useSearchParams();
  const ownerId = params.get('ownerId') ?? undefined;

  const vault = useVault();
  const [kit, setKit] = useState<ClaimKitResponse | null>(null);
  const [secrets, setSecrets] = useState<Map<string, VaultItemPayload>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKit(await endpoints.claimKit({ ownerId }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not build the claim kit.');
    }
  }, [ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Merge in the vault.
   *
   * Separate from loading the kit, and only on request: the skeleton is useful without the
   * vault, and decrypting every item to print a page nobody asked to print would be an
   * odd thing for a locked-by-default vault to do on its own.
   */
  const mergeVault = useCallback(async () => {
    const { items } = await endpoints.vaultItems();
    const opened = new Map<string, VaultItemPayload>();
    await Promise.all(
      items.map(async (item: VaultItemRecord) => {
        opened.set(item.id, await vault.decrypt<VaultItemPayload>(item.payload));
      }),
    );
    setSecrets(opened);
  }, [vault]);

  if (error !== null) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (kit === null) return <Skeleton className="h-96" />;

  const unnominated = kit.entries.filter((entry) => !entry.nomineeRegistered);

  return (
    <div className="space-y-4">
      <div className="no-print">
        <PageHeader
          title="Claim kit"
          subtitle={`For ${kit.owner.name} · generated ${formatDate(kit.generatedAt)}`}
          action={
            <div className="flex gap-2">
              {vault.state === 'unlocked' && secrets.size === 0 && (
                <Button onClick={() => void mergeVault()}>Include vault details</Button>
              )}
              <Button variant="primary" onClick={() => window.print()}>
                Print
              </Button>
            </div>
          }
        />

        {vault.state !== 'unlocked' && (
          <Card>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Your vault is locked, so this kit lists the accounts and the forms but not the
              credentials. Unlock it and choose “Include vault details” to print the complete
              version — the decryption happens in this browser, and the printed page is the only
              place the two halves are ever joined.
            </p>
          </Card>
        )}
      </div>

      <article className="print-sheet space-y-5">
        <header>
          <h1 className="text-xl font-semibold">Claim kit — {kit.owner.name}</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {kit.owner.email} · prepared {formatDate(kit.generatedAt)}
          </p>
          <p className="mt-2 text-sm">
            Net worth <strong className="tabular">{formatINR(kit.totals.netPaise)}</strong> —{' '}
            {formatINR(kit.totals.assetPaise)} in assets less {formatINR(kit.totals.liabilityPaise)}{' '}
            owed.
          </p>
          {kit.totals.unnominatedPaise > 0 && (
            <p className="mt-1 text-sm" style={{ color: 'var(--color-warn)' }}>
              {formatINR(kit.totals.unnominatedPaise)} sits in {unnominated.length} asset
              {unnominated.length === 1 ? '' : 's'} with no registered nomination. Those are the
              ones that will need a succession certificate.
            </p>
          )}
        </header>

        <section>
          <h2 className="mb-2 text-sm font-semibold tracking-tight">Who inherits</h2>
          {kit.nominees.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Nobody is named in this app. The estate will pass by will or by succession law.
            </p>
          ) : (
            <ul className="text-sm">
              {kit.nominees.map((nominee) => (
                <li key={`${nominee.name}-${nominee.email ?? ''}`}>
                  {nominee.name}
                  {nominee.relation !== null && ` (${nominee.relation})`}
                  {nominee.email !== null && ` · ${nominee.email}`}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold tracking-tight">
            What there is, and how to claim it
          </h2>

          {kit.entries.map((entry) => (
            <div key={entry.assetId} className="claim-entry surface-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {entry.name}
                  {entry.reference !== null && (
                    <span className="font-normal" style={{ color: 'var(--text-secondary)' }}>
                      {' '}
                      · {entry.reference}
                    </span>
                  )}
                </h3>
                <span className="tabular text-sm font-medium">{formatINR(entry.valuePaise)}</span>
              </div>

              <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                {ASSET_TYPE_LABELS[entry.type as keyof typeof ASSET_TYPE_LABELS] ?? entry.type}
                {entry.institution !== null && ` · ${entry.institution}`}
              </p>

              {!entry.nomineeRegistered && (
                <p className="mt-1 text-xs" style={{ color: 'var(--color-warn)' }}>
                  No nomination registered with the institution.
                </p>
              )}

              <dl className="mt-3 space-y-1 text-sm">
                <Line label="Approach">{entry.procedure.authority}</Line>
                {entry.procedure.forms.length > 0 && (
                  <Line label="Forms">{entry.procedure.forms.join(' · ')}</Line>
                )}
                <Line label="Documents">{entry.procedure.documents.join(' · ')}</Line>
              </dl>

              {entry.procedure.notes.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {entry.procedure.notes.map((note) => (
                    <li key={note}>— {note}</li>
                  ))}
                </ul>
              )}

              {entry.vaultItemIds.length > 0 && (
                <div className="mt-3 border-t pt-2">
                  {entry.vaultItemIds.map((id) => {
                    const secret = secrets.get(id);
                    if (!secret) {
                      return (
                        <p key={id} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          One vault item is attached to this asset — unlock the vault to print it.
                        </p>
                      );
                    }
                    return (
                      <dl key={id} className="space-y-0.5 text-sm">
                        <Line label={secret.label}>
                          {[secret.reference, secret.username, secret.secret]
                            .filter((value) => value !== undefined && value !== '')
                            .join(' · ') || '—'}
                        </Line>
                        {secret.location !== undefined && secret.location !== '' && (
                          <Line label="Papers">{secret.location}</Line>
                        )}
                        {secret.notes !== undefined && secret.notes !== '' && (
                          <Line label="Note">{secret.notes}</Line>
                        )}
                      </dl>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </section>

        <footer className="text-xs" style={{ color: 'var(--text-muted)' }}>
          <p>
            Forms and thresholds are as recorded in this app and change from time to time. Confirm
            the current requirement with the institution before travelling to a branch.
          </p>
          {secrets.size > 0 && (
            <p className="mt-1" style={{ color: 'var(--color-warn)' }}>
              This copy contains credentials in plain text. Treat the printout the way you would
              treat the passwords themselves.
            </p>
          )}
        </footer>
      </article>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="shrink-0 font-medium">{label}</dt>
      <dd style={{ color: 'var(--text-secondary)' }}>{children}</dd>
    </div>
  );
}
