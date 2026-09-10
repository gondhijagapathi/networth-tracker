/**
 * The dashboard.
 *
 * Four questions in the order a person asks them: what am I worth, how has that moved,
 * where is it, and what would hurt if it went wrong. One request answers all four, so the
 * page has one loading state rather than four that finish at different moments and shift
 * the layout under a thumb.
 */

import { Suspense, lazy, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ALLOCATION_DIMENSIONS,
  formatCompactINR,
  type AllocationDimension,
} from '@networth/shared';
/*
 * The charting library is the largest thing in the bundle by some margin, and none of it is
 * needed to render the number people open this page for. Loading it separately means the
 * summary card paints on a phone connection while the chart is still arriving.
 */
const AllocationDonut = lazy(() =>
  import('../components/charts/AllocationDonut.js').then((module) => ({
    default: module.AllocationDonut,
  })),
);
const NetWorthChart = lazy(() =>
  import('../components/charts/NetWorthChart.js').then((module) => ({
    default: module.NetWorthChart,
  })),
);
import {
  Amount,
  Card,
  CardTitle,
  Change,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Skeleton,
} from '../components/ui.js';
import { endpoints } from '../lib/endpoints.js';
import { formatDate, formatPercent } from '../lib/format.js';
import { useResource } from '../lib/resource.js';

const DIMENSION_LABELS: Record<AllocationDimension, string> = {
  class: 'Asset class',
  institution: 'Institution',
  liquidity: 'How liquid',
  type: 'Type',
};

const WINDOWS = [
  { months: 6, label: '6M' },
  { months: 12, label: '1Y' },
  { months: 36, label: '3Y' },
  { months: 120, label: 'All' },
];

export function Dashboard() {
  const [months, setMonths] = useState(12);
  const [by, setBy] = useState<AllocationDimension>('class');

  const { data, loading, error, reload } = useResource(
    (signal) => endpoints.dashboard({ months, by }, signal),
    [months, by],
  );

  if (error !== null) return <ErrorNotice message={error.message} onRetry={reload} />;

  /*
   * Skeletons only on the *first* load.
   *
   * Changing the window or the allocation dimension refetches, and tearing the whole page
   * down to skeletons for that read as a full page reload — the header, the summary and the
   * risk panel all disappear to answer a question about one chart. `useResource` keeps the
   * previous data through a refetch, so the page stays on screen and only reports that it is
   * busy while the new numbers arrive.
   */
  if (data === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
        <Skeleton className="h-56" />
      </div>
    );
  }

  const { summary, allocation, risk, series } = data;
  const nothingYet = summary.assetCount === 0 && summary.liabilityCount === 0;

  return (
    <div
      className="space-y-4 transition-opacity"
      aria-busy={loading}
      style={{ opacity: loading ? 0.6 : 1 }}
    >
      <PageHeader title="Dashboard" subtitle={`As at ${formatDate(summary.asOf)}`} />

      {nothingYet ? (
        <EmptyState
          title="Nothing here yet"
          description="Add a bank account, a deposit or a fund and this page starts answering what you are worth, where it sits and how it is doing."
          action={
            <Link to="/assets/new" className="btn btn-primary">
              Add your first asset
            </Link>
          }
        />
      ) : (
        <>
          <Card>
            <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Net worth
            </p>
            <p className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
              <Amount paise={summary.netPaise} />
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              {summary.month !== null && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  This month{' '}
                  <Change paise={summary.month.changePaise} ratio={summary.month.changeRatio} />
                </span>
              )}
              {summary.year !== null && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  This year{' '}
                  <Change paise={summary.year.changePaise} ratio={summary.year.changeRatio} />
                </span>
              )}
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
              <Stat label={`Assets (${summary.assetCount})`} paise={summary.assetsPaise} />
              <Stat label={`Owed (${summary.liabilityCount})`} paise={summary.liabilitiesPaise} />
              <Stat label="Liquid today" paise={risk.liquidPaise} />
              <Stat label="Monthly outgo" paise={risk.monthlyCommitmentPaise} />
            </dl>

            {summary.unvaluedCount > 0 && (
              /* The number that keeps the total honest rather than quietly counting zero. */
              <p className="mt-3 text-xs" style={{ color: 'var(--color-warn)' }}>
                {summary.unvaluedCount} asset{summary.unvaluedCount === 1 ? ' has' : 's have'} no
                value recorded, so this total is lower than the truth.{' '}
                <Link to="/assets?sort=value&order=asc" className="underline underline-offset-2">
                  Review them
                </Link>
                .
              </p>
            )}
          </Card>

          <Card>
            <CardTitle
              action={
                <div className="flex gap-1">
                  {WINDOWS.map((window) => (
                    <button
                      key={window.months}
                      type="button"
                      onClick={() => setMonths(window.months)}
                      className={`chip ${months === window.months ? 'chip-active' : ''}`}
                      aria-pressed={months === window.months}
                    >
                      {window.label}
                    </button>
                  ))}
                </div>
              }
            >
              Net worth over time
            </CardTitle>
            <Suspense fallback={<Skeleton className="h-56 sm:h-64" />}>
              <NetWorthChart series={series} />
            </Suspense>
          </Card>

          <Card>
            <CardTitle
              action={
                <div className="flex flex-wrap gap-1">
                  {ALLOCATION_DIMENSIONS.map((dimension) => (
                    <button
                      key={dimension}
                      type="button"
                      onClick={() => setBy(dimension)}
                      className={`chip ${by === dimension ? 'chip-active' : ''}`}
                      aria-pressed={by === dimension}
                    >
                      {DIMENSION_LABELS[dimension]}
                    </button>
                  ))}
                </div>
              }
            >
              Allocation
            </CardTitle>
            <Suspense fallback={<Skeleton className="h-44" />}>
              <AllocationDonut allocation={allocation} />
            </Suspense>
          </Card>

          <Card>
            <CardTitle>What would hurt</CardTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              <Risk
                label="Largest single asset"
                value={formatPercent(risk.topAssetShare)}
                detail={risk.topAssetName ?? '—'}
                // A third of everything in one thing is the point at which one bad year
                // stops being a setback and starts being the whole story.
                warn={risk.topAssetShare > 0.33}
              />
              <Risk
                label="Largest institution"
                value={formatPercent(risk.topInstitutionShare)}
                detail={risk.topInstitutionName ?? 'Nothing held at an institution'}
                warn={risk.topInstitutionShare > 0.5}
              />
              <Risk
                label="Emergency cover"
                value={
                  risk.emergencyFundMonths === null
                    ? '—'
                    : `${risk.emergencyFundMonths.toFixed(1)} months`
                }
                detail={
                  risk.emergencyFundMonths === null
                    ? 'Nothing committed monthly'
                    : `${formatCompactINR(risk.liquidPaise)} liquid against ${formatCompactINR(risk.monthlyCommitmentPaise)} a month`
                }
                // Six months of committed outflow is the usual advice, and three is the
                // point at which one lost job becomes an emergency.
                warn={risk.emergencyFundMonths !== null && risk.emergencyFundMonths < 3}
              />
              <Risk
                label="No nominee registered"
                value={formatCompactINR(risk.unnominatedPaise)}
                detail={`${risk.unnominatedCount} asset${risk.unnominatedCount === 1 ? '' : 's'}`}
                warn={risk.unnominatedCount > 0}
                sensitive
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, paise }: { label: string; paise: number }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-semibold">
        <Amount paise={paise} compact />
      </dd>
    </div>
  );
}

function Risk({
  label,
  value,
  detail,
  warn,
  sensitive = false,
}: {
  label: string;
  value: string;
  detail: string;
  warn: boolean;
  sensitive?: boolean;
}) {
  return (
    <div
      className="rounded-xl px-3 py-2.5"
      style={{
        background: 'var(--surface-sunken)',
        border: `1px solid ${warn ? 'var(--color-warn)' : 'var(--border-subtle)'}`,
      }}
    >
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}
      </p>
      <p
        className={`tabular mt-0.5 text-lg font-semibold ${sensitive ? 'sensitive' : ''}`}
        style={{ color: warn ? 'var(--color-warn)' : undefined }}
      >
        {value}
      </p>
      <p className="truncate text-xs" style={{ color: 'var(--text-secondary)' }} title={detail}>
        {detail}
      </p>
    </div>
  );
}
