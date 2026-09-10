/**
 * One asset, in full.
 *
 * The page answers three questions in order: what is it worth and where did that number
 * come from, how has it done, and what is the paperwork. The third is not an afterthought —
 * a policy number and a sub-registrar office are the whole reason half of these rows exist.
 *
 * Recording a value appends rather than edits, because `valuations` is the history the net
 * worth chart is drawn from and a correction is a new row, not an edit to the past.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  formatRate,
  parseAmount,
  type HoldingDetail,
  type TransactionType,
} from '@networth/shared';
import { DetailPanel } from '../components/assets/DetailPanel.js';
import {
  Amount,
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
import { endpoints } from '../lib/endpoints.js';
import { ASSET_TYPE_LABELS, BASIS_LABELS, formatDate, toneOf } from '../lib/format.js';
import { useResource } from '../lib/resource.js';

const TRANSACTION_TYPES: TransactionType[] = [
  'deposit',
  'withdrawal',
  'interest',
  'dividend',
  'premium',
  'emi',
];

export function AssetDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const asset = useResource((signal) => endpoints.asset(id, signal), [id]);
  const performance = useResource((signal) => endpoints.assetPerformance(id, signal), [id]);
  const valuations = useResource((signal) => endpoints.valuations(id, signal), [id]);
  const transactions = useResource((signal) => endpoints.transactions(id, signal), [id]);

  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [filled, setFilled] = useState<{ added: number; skipped: number } | null>(null);

  if (asset.error !== null) {
    return <ErrorNotice message={asset.error.message} onRetry={asset.reload} />;
  }
  if (asset.data === null) return <Skeleton className="h-64" />;

  const record = asset.data.asset;
  const owed = record.type === 'liability';

  function reloadAll() {
    asset.reload();
    performance.reload();
    valuations.reload();
    transactions.reload();
  }

  async function recordValue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);

    try {
      await endpoints.recordValuation(id, {
        asOf: String(data.get('asOf') ?? ''),
        // Accepts what an Indian user actually types: "12.5L", "₹5,00,000", "1.2 Cr".
        valuePaise: parseAmount(String(data.get('value') ?? '')),
        source: 'manual',
      });
      form.reset();
      reloadAll();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, { code: 'bad_request', message: 'That amount could not be read.' }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function addTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);

    try {
      await endpoints.addTransaction(id, {
        date: String(data.get('date') ?? ''),
        type: String(data.get('type') ?? 'deposit') as TransactionType,
        amountPaise: parseAmount(String(data.get('amount') ?? '')),
        chargesPaise: 0,
      });
      form.reset();
      reloadAll();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, { code: 'bad_request', message: 'That amount could not be read.' }),
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Write a running SIP's months in one go.
   *
   * Typing forty-eight identical instalments by hand is what stops people recording them at
   * all, and a single lump-sum row prices every one of them as if it were paid on the first
   * day — so the figure this replaces is not a rougher return, it is a wrong one.
   */
  async function fillSipMonths(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    setFilled(null);

    try {
      const to = String(data.get('sipTo') ?? '').trim();
      const result = await endpoints.backfillSip(id, {
        amountPaise: parseAmount(String(data.get('sipAmount') ?? '')),
        day: Number(data.get('sipDay') ?? 1),
        from: String(data.get('sipFrom') ?? ''),
        // An empty end date means "still running", which the server reads as today.
        to: to === '' ? undefined : to,
        chargesPaise: 0,
      });
      setFilled({ added: result.created.length, skipped: result.skipped });
      reloadAll();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, { code: 'bad_request', message: 'That amount could not be read.' }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    // Archive, not delete: the valuations and transactions outlive the asset, because last
    // year's net worth was true and a closed deposit is part of it.
    if (!window.confirm(`Archive “${record.name}”? Its history is kept.`)) return;
    await endpoints.archiveAsset(id);
    void navigate('/assets');
  }

  const entry = performance.data?.performance ?? null;
  const latest = record.latestValue;
  // Only a fund or share has monthly instalments to fill in, and only its owner may write.
  const sip = record.type === 'holding' && !record.shared ? (record.detail as HoldingDetail) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={record.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{ASSET_TYPE_LABELS[record.type]}</span>
            {record.institution !== null && <span>· {record.institution}</span>}
            {record.shared && <Pill title="Shared with you by its owner">Shared</Pill>}
            {record.ownershipBps !== 10_000 && (
              <Pill title="Your share of a jointly held asset">
                {(record.ownershipBps / 100).toFixed(0)}% yours
              </Pill>
            )}
            {!record.nomineeRegistered && !owed && (
              <Pill tone="var(--color-warn)">No nominee registered</Pill>
            )}
          </span>
        }
        action={
          !record.shared && (
            <div className="flex gap-2">
              <Link to={`/assets/${id}/edit`} className="btn btn-secondary">
                Edit
              </Link>
              <Button variant="danger" onClick={() => void archive()}>
                Archive
              </Button>
            </div>
          )
        }
      />

      {error !== null && <ErrorNotice message={error.message} />}

      <Card>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {owed ? 'Outstanding' : 'Current value'}
        </p>
        <p className="mt-1 text-3xl font-semibold tracking-tight">
          <Amount paise={entry?.valuePaise ?? latest?.valuePaise ?? 0} />
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {/* Where the number came from, said out loud. "₹6,17,432" and "₹6,17,432, accrued
              from the terms" are different claims. */}
          {latest === null
            ? BASIS_LABELS.none
            : `${BASIS_LABELS[latest.source === 'manual' ? 'manual' : 'market']} · ${formatDate(latest.asOf)}`}
        </p>

        {entry !== null && entry.investedPaise !== 0 && (
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Invested
              </dt>
              <dd className="mt-0.5 text-sm font-semibold">
                <Amount paise={entry.investedPaise} compact />
              </dd>
            </div>
            <div>
              <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Gain
              </dt>
              <dd className="mt-0.5 text-sm font-semibold">
                <Amount paise={entry.gainPaise} compact tone />
              </dd>
            </div>
            <div>
              <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                XIRR
              </dt>
              <dd
                className="tabular mt-0.5 text-sm font-semibold"
                style={{ color: entry.xirr === null ? undefined : toneOf(entry.xirr) }}
              >
                {formatRate(entry.xirr)}
              </dd>
            </div>
            <div>
              <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                CAGR
              </dt>
              <dd className="tabular mt-0.5 text-sm font-semibold">{formatRate(entry.cagr)}</dd>
            </div>
          </dl>
        )}
      </Card>

      <Card>
        <CardTitle>Details</CardTitle>
        <DetailPanel asset={record} />
        {record.notes !== null && (
          <p className="mt-4 border-t pt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {record.notes}
          </p>
        )}
        {record.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {record.tags.map((tag) => (
              <Pill key={tag}>{tag}</Pill>
            ))}
          </div>
        )}
      </Card>

      {!record.shared && (
        <Card>
          <CardTitle>Record a value</CardTitle>
          <form onSubmit={(event) => void recordValue(event)} className="flex flex-wrap gap-3">
            <Field label="As at">
              <Input
                name="asOf"
                type="date"
                required
                defaultValue={new Date().toISOString().slice(0, 10)}
              />
            </Field>
            <Field label="Amount" hint="₹5,00,000 · 12.5L · 1.2 Cr">
              <Input name="value" required inputMode="decimal" placeholder="12.5L" />
            </Field>
            <div className="self-end pb-0.5">
              <Button type="submit" variant="primary" disabled={busy}>
                Save
              </Button>
            </div>
          </form>
          <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            Values are appended, never overwritten — a correction is a new entry, so the chart stays
            real history.
          </p>
        </Card>
      )}

      <Card>
        <CardTitle>Value history</CardTitle>
        {valuations.data === null ? (
          <Skeleton className="h-16" />
        ) : valuations.data.valuations.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {valuations.data.valuations.slice(0, 12).map((row) => (
              <li key={row.id} className="flex items-center justify-between py-2">
                <span style={{ color: 'var(--text-secondary)' }}>{formatDate(row.asOf)}</span>
                <span className="flex items-center gap-2">
                  <Pill>{row.source}</Pill>
                  <Amount paise={row.valuePaise} className="font-medium" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {sip !== null && (
        <Card>
          <CardTitle>Fill in SIP months</CardTitle>
          <p className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
            Adds one instalment per month between these dates, so a SIP does not have to be typed in
            a month at a time. Months already recorded are left alone.
          </p>
          <form onSubmit={(event) => void fillSipMonths(event)} className="flex flex-wrap gap-3">
            <Field label="Monthly amount">
              <Input
                name="sipAmount"
                required
                inputMode="decimal"
                placeholder="5,000"
                defaultValue={sip.sipAmountPaise === undefined ? '' : sip.sipAmountPaise / 100}
              />
            </Field>
            <Field label="Day of month" hint="1–28">
              <Input
                name="sipDay"
                type="number"
                min={1}
                max={28}
                required
                defaultValue={sip.sipDay ?? 5}
              />
            </Field>
            <Field label="First instalment">
              <Input name="sipFrom" type="date" required defaultValue={record.openedOn ?? ''} />
            </Field>
            <Field label="Last instalment" hint="Leave blank if it is still running">
              <Input name="sipTo" type="date" />
            </Field>
            <div className="self-end pb-0.5">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Adding…' : 'Add months'}
              </Button>
            </div>
          </form>
          {filled !== null && (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              {`Added ${filled.added} instalment${filled.added === 1 ? '' : 's'}`}
              {filled.skipped > 0 && `, left ${filled.skipped} already recorded alone`}.
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardTitle>Transactions</CardTitle>
        {!record.shared && (
          <form
            onSubmit={(event) => void addTransaction(event)}
            className="mb-4 flex flex-wrap gap-3 border-b pb-4"
          >
            <Field label="Date">
              <Input
                name="date"
                type="date"
                required
                defaultValue={new Date().toISOString().slice(0, 10)}
              />
            </Field>
            <Field label="What happened">
              <Select name="type" defaultValue="deposit">
                {TRANSACTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type[0]!.toUpperCase() + type.slice(1)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount">
              <Input name="amount" required inputMode="decimal" placeholder="25,000" />
            </Field>
            <div className="self-end pb-0.5">
              <Button type="submit" disabled={busy}>
                Add
              </Button>
            </div>
          </form>
        )}

        {transactions.data === null ? (
          <Skeleton className="h-16" />
        ) : transactions.data.transactions.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No movements recorded. XIRR needs these to mean anything.
          </p>
        ) : (
          <ul className="divide-y text-sm">
            {[...transactions.data.transactions].reverse().map((row) => (
              <li key={row.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="font-medium">
                    {row.type[0]!.toUpperCase() + row.type.slice(1)}
                  </span>
                  <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {formatDate(row.date)}
                  </span>
                </span>
                <Amount paise={row.amountPaise} className="font-medium" />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
