/**
 * How the portfolio has actually done.
 *
 * XIRR rather than a percentage gain, because almost nothing here was bought once and held:
 * SIPs, top-ups and partial redemptions mean money goes in and out on arbitrary dates, and
 * "up 42%" over an unstated period is not an answer to anything.
 *
 * Everything on this page is gross — full cashflows against the full value, not the owner's
 * share of either. Mixing an ownership-adjusted value with unadjusted transactions would
 * produce a rate of return that is simply wrong; the split belongs on net worth.
 */

import { Link } from 'react-router-dom';
import {
  ASSET_CLASS_LABELS,
  formatRate,
  type ClassPerformance,
  type PerformanceEntry,
} from '@networth/shared';
import {
  Amount,
  Card,
  CardTitle,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Pill,
  Skeleton,
} from '../components/ui.js';
import { endpoints } from '../lib/endpoints.js';
import { ASSET_TYPE_LABELS, colourFor, toneOf } from '../lib/format.js';
import { useResource } from '../lib/resource.js';

export function Performance() {
  const { data, loading, error, reload } = useResource(
    (signal) => endpoints.performance(signal),
    [],
  );

  if (error !== null) return <ErrorNotice message={error.message} onRetry={reload} />;
  if (data === null || loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const { portfolio, classes, assets } = data;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Returns"
        subtitle="Annualised, from the money that actually went in and out."
      />

      {assets.length === 0 ? (
        <EmptyState
          title="Nothing to measure yet"
          description="Record what you paid — a purchase, an SIP instalment, a deposit — and the return appears here."
          action={
            <Link to="/assets" className="btn btn-primary">
              Go to assets
            </Link>
          }
        />
      ) : (
        <>
          <Card>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Invested
                </dt>
                <dd className="mt-0.5 text-lg font-semibold">
                  <Amount paise={portfolio.investedPaise} compact />
                </dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Now worth
                </dt>
                <dd className="mt-0.5 text-lg font-semibold">
                  <Amount paise={portfolio.valuePaise} compact />
                </dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Gain
                </dt>
                <dd className="mt-0.5 text-lg font-semibold">
                  <Amount paise={portfolio.gainPaise} compact tone />
                </dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  XIRR
                </dt>
                <dd
                  className="tabular mt-0.5 text-lg font-semibold"
                  style={{ color: portfolio.xirr === null ? undefined : toneOf(portfolio.xirr) }}
                >
                  {formatRate(portfolio.xirr)}
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CardTitle>By class</CardTitle>
            <ul className="divide-y">
              {classes.map((entry) => (
                <ClassRow key={entry.assetClass} entry={entry} />
              ))}
            </ul>
          </Card>

          <Card>
            <CardTitle>By asset</CardTitle>
            <ul className="divide-y">
              {assets.map((entry) => (
                <Row key={entry.assetId} entry={entry} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * A class row carries no CAGR because the API reports none: pooled flows across many
 * purchase dates have an XIRR and not a compound growth rate. See `ClassPerformance`.
 */
function ClassRow({ entry }: { entry: ClassPerformance }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        className="h-8 w-1 shrink-0 rounded-full"
        style={{ background: colourFor(entry.assetClass, 0) }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{ASSET_CLASS_LABELS[entry.assetClass]}</p>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          {entry.assetCount === 1 ? '1 asset' : `${entry.assetCount} assets`}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold">
          <Amount paise={entry.valuePaise} compact />
        </p>
        <p className="text-xs">
          <Amount paise={entry.gainPaise} compact tone />
        </p>
      </div>

      <div className="w-16 shrink-0 text-right">
        <p
          className="tabular text-sm font-semibold"
          style={{ color: entry.xirr === null ? 'var(--text-muted)' : toneOf(entry.xirr) }}
        >
          {formatRate(entry.xirr, 1)}
        </p>
        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          XIRR
        </p>
      </div>
    </li>
  );
}

function Row({ entry }: { entry: PerformanceEntry }) {
  return (
    <li>
      <Link to={`/assets/${entry.assetId}`} className="flex items-center gap-3 py-3">
        <span
          className="h-8 w-1 shrink-0 rounded-full"
          style={{ background: colourFor(entry.assetClass, 0) }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{entry.name}</p>
          <p
            className="mt-0.5 flex items-center gap-1.5 text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>{ASSET_TYPE_LABELS[entry.type]}</span>
            <Pill>{ASSET_CLASS_LABELS[entry.assetClass]}</Pill>
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold">
            <Amount paise={entry.valuePaise} compact />
          </p>
          <p className="text-xs">
            <Amount paise={entry.gainPaise} compact tone />
          </p>
        </div>

        <div className="w-16 shrink-0 text-right">
          <p
            className="tabular text-sm font-semibold"
            style={{ color: entry.xirr === null ? 'var(--text-muted)' : toneOf(entry.xirr) }}
          >
            {formatRate(entry.xirr, 1)}
          </p>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            XIRR
          </p>
        </div>
      </Link>
    </li>
  );
}
