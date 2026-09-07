/**
 * Every asset, filtered, sorted and searched.
 *
 * The filters live in the URL rather than in component state, so a filtered list is a link:
 * the dashboard can point at "assets with no value recorded", the back button works, and a
 * refresh does not throw away what the user set up.
 *
 * Search is debounced because it is a round trip per keystroke otherwise, and typing
 * "reliance" would be eight queries and eight re-renders.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ASSET_TYPES,
  STALE_PRICE_DAYS,
  type AssetQuery,
  type AssetSummary,
  type AssetType,
} from '@networth/shared';
import {
  Amount,
  Button,
  EmptyState,
  ErrorNotice,
  Input,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../components/ui.js';
import { endpoints } from '../lib/endpoints.js';
import { ASSET_TYPE_PLURALS, ASSET_TYPE_LABELS, formatDate, isStalePrice } from '../lib/format.js';
import { useResource } from '../lib/resource.js';

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'created:desc', label: 'Newest first' },
  { value: 'value:desc', label: 'Largest first' },
  { value: 'value:asc', label: 'Smallest first' },
  { value: 'name:asc', label: 'Name, A–Z' },
];

export function AssetList() {
  const [params, setParams] = useSearchParams();

  const type = params.get('type') ?? '';
  const status = params.get('status') ?? 'active';
  const sort = params.get('sort') ?? 'created';
  const order = params.get('order') ?? 'desc';
  const search = params.get('q') ?? '';

  // The input is local so typing feels instant; the URL — and the request — follow.
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);

  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (draft === '') next.delete('q');
          else next.set('q', draft);
          return next;
        },
        { replace: true },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, search, setParams]);

  const query = useMemo<Partial<AssetQuery>>(
    () => ({
      ...(type === '' ? {} : { type: type as AssetType }),
      ...(status === 'all' ? {} : { status: status as AssetQuery['status'] }),
      ...(search === '' ? {} : { q: search }),
      sort: sort as AssetQuery['sort'],
      order: order as AssetQuery['order'],
      limit: 200,
    }),
    [type, status, search, sort, order],
  );

  const list = useResource((signal) => endpoints.assets(query, signal), [query]);
  const counts = useResource((signal) => endpoints.assetCounts(signal), []);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  async function refreshPrices() {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const result = await endpoints.refreshPrices();
      const updated = result.runs.reduce((total, run) => total + run.updated, 0);
      const failed = result.runs.filter((run) => run.errors.length > 0);
      setRefreshNote(
        failed.length > 0
          ? `Updated ${updated} price${updated === 1 ? '' : 's'}, but ${failed[0]!.provider} could not be reached.`
          : `Updated ${updated} price${updated === 1 ? '' : 's'}.`,
      );
      list.reload();
    } catch (caught) {
      setRefreshNote(caught instanceof Error ? caught.message : 'Could not refresh prices.');
    } finally {
      setRefreshing(false);
    }
  }

  function setParam(key: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value === '') next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  const countsByType = useMemo(() => {
    const map = new Map<AssetType, number>();
    for (const row of counts.data?.counts ?? []) {
      if (status !== 'all' && row.status !== status) continue;
      map.set(row.type, (map.get(row.type) ?? 0) + row.count);
    }
    return map;
  }, [counts.data, status]);

  return (
    <div>
      <PageHeader
        title="Assets"
        subtitle={list.data === null ? undefined : `${list.data.total} of yours`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button disabled={refreshing} onClick={() => void refreshPrices()}>
              {refreshing ? 'Refreshing…' : 'Refresh prices'}
            </Button>
            <Link to="/assets/new" className="btn btn-primary">
              Add asset
            </Link>
          </div>
        }
      />

      {refreshNote !== null && (
        <p className="mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {refreshNote}
        </p>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search name or institution"
          type="search"
          className="min-w-0 flex-1 sm:max-w-xs"
          aria-label="Search assets"
        />
        <Select
          value={`${sort}:${order}`}
          onChange={(event) => {
            const [nextSort, nextOrder] = event.target.value.split(':');
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.set('sort', nextSort!);
              next.set('order', nextOrder!);
              return next;
            });
          }}
          aria-label="Sort"
          className="w-auto"
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Select
          value={status}
          onChange={(event) => setParam('status', event.target.value)}
          aria-label="Status"
          className="w-auto"
        >
          <option value="active">Active</option>
          <option value="closed">Closed</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </Select>
      </div>

      {/* Type chips carry their counts, so an empty category is visible before it is
          clicked rather than after. */}
      <div className="mb-4 -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <button
          type="button"
          onClick={() => setParam('type', '')}
          className={`chip shrink-0 ${type === '' ? 'chip-active' : ''}`}
          aria-pressed={type === ''}
        >
          Everything
        </button>
        {ASSET_TYPES.filter((candidate) => (countsByType.get(candidate) ?? 0) > 0).map(
          (candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setParam('type', candidate)}
              className={`chip shrink-0 ${type === candidate ? 'chip-active' : ''}`}
              aria-pressed={type === candidate}
            >
              {ASSET_TYPE_PLURALS[candidate]} {countsByType.get(candidate)}
            </button>
          ),
        )}
      </div>

      {list.error !== null ? (
        <ErrorNotice message={list.error.message} onRetry={list.reload} />
      ) : list.data === null ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : list.data.assets.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description={
            search === '' && type === ''
              ? 'Add your first asset and it will show up here.'
              : 'Try a different search, type or status.'
          }
          action={
            <Link to="/assets/new" className="btn btn-primary">
              Add asset
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {list.data.assets.map((asset) => (
            <AssetRow key={asset.id} asset={asset} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AssetRow({ asset }: { asset: AssetSummary }) {
  const owed = asset.type === 'liability';

  return (
    <li>
      <Link
        to={`/assets/${asset.id}`}
        className="surface-card flex items-center gap-3 px-4 py-3 transition-colors hover:border-[var(--border-strong)]"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{asset.name}</p>
          <p
            className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>{ASSET_TYPE_LABELS[asset.type]}</span>
            {asset.institution !== null && <span>· {asset.institution}</span>}
            {asset.shared && <Pill title="Shared with you by its owner">Shared</Pill>}
            {!asset.nomineeRegistered && !owed && (
              <Pill tone="var(--color-warn)" title="No nominee registered on this asset">
                No nominee
              </Pill>
            )}
            {asset.status !== 'active' && <Pill>{asset.status}</Pill>}
          </p>
        </div>

        <div className="shrink-0 text-right">
          {asset.latestValue === null ? (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Not valued
            </span>
          ) : (
            <>
              <p className="text-sm font-semibold">
                <Amount
                  paise={owed ? -asset.latestValue.valuePaise : asset.latestValue.valuePaise}
                  compact
                />
              </p>
              <p
                className="text-[11px]"
                style={{
                  color: isStalePrice(asset.latestValue.asOf, asset.latestValue.source)
                    ? 'var(--color-warn)'
                    : 'var(--text-muted)',
                }}
                title={
                  isStalePrice(asset.latestValue.asOf, asset.latestValue.source)
                    ? `No price update in over ${STALE_PRICE_DAYS} days`
                    : undefined
                }
              >
                {formatDate(asset.latestValue.asOf)}
              </p>
            </>
          )}
        </div>
      </Link>
    </li>
  );
}
