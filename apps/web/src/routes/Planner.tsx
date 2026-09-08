/**
 * The planner: nomination hygiene, what is due, and what the year will cost in tax.
 *
 * Three reports rather than three screens, because they are read together and they share a
 * frame of mind — the half-hour somebody spends in March getting their affairs in order.
 * The tab is in the URL, so a filtered view is a link and the back button behaves.
 *
 * Everything on the tax tab is labelled as an estimate, in the copy rather than in a
 * footnote. The rates it used are printed at the bottom of the page: a number somebody might
 * act on should be checkable without reading the source.
 */

import { useSearchParams } from 'react-router-dom';
import {
  CALENDAR_KIND_LABELS,
  DEDUCTION_SOURCE_LABELS,
  GAIN_TREATMENT_LABELS,
  formatINR,
  type CalendarEvent,
  type CalendarResponse,
  type DeductionBucket,
  type FinancialYearReport,
  type NominationReport,
} from '@networth/shared';
import {
  Amount,
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
import { ASSET_TYPE_LABELS, formatDate, formatPercent, toneOf } from '../lib/format.js';
import { useResource } from '../lib/resource.js';

const TABS = [
  { key: 'nomination', label: 'Nomination' },
  { key: 'calendar', label: 'Due soon' },
  { key: 'tax', label: 'Tax year' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export function Planner() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((entry) => entry.key === params.get('tab'))?.key ?? 'nomination') as Tab;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Planner"
        subtitle="What is unclaimed, what is due, and what the year owes."
      />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Planner sections">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`chip ${tab === entry.key ? 'chip-active' : ''}`}
            onClick={() => setParams(entry.key === 'nomination' ? {} : { tab: entry.key })}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'nomination' && <Nomination />}
      {tab === 'calendar' && <Calendar />}
      {tab === 'tax' && <TaxYear />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Nomination                                                                 */
/* -------------------------------------------------------------------------- */

function Nomination() {
  const report = useResource<NominationReport>((signal) => endpoints.nomination(signal), []);

  if (report.error) return <ErrorNotice message={report.error.message} onRetry={report.reload} />;
  if (!report.data) return <Skeleton className="h-64" />;

  const { atRisk, atRiskPaise, coveredPaise, nominatedCount, totalAssets } = report.data;

  if (totalAssets === 0) {
    return (
      <EmptyState
        title="Nothing to check yet"
        description="Add an asset and this page will tell you whether an heir could actually claim it."
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {nominatedCount} of {totalAssets} assets have a registered nominee
            </p>
            <p className="mt-1 text-2xl font-semibold">
              <Amount paise={atRiskPaise} tone={false} />
            </p>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              at risk of a slow claim
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Covered
            </p>
            <p className="text-sm font-medium">
              <Amount paise={coveredPaise} compact />
            </p>
          </div>
        </div>

        {/* A bar rather than a donut: this is one ratio, and the question is how far along it is. */}
        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full"
          style={{ background: 'var(--surface-sunken)' }}
          role="img"
          aria-label={`${nominatedCount} of ${totalAssets} assets nominated`}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${(nominatedCount / totalAssets) * 100}%`,
              background: 'var(--color-gain)',
            }}
          />
        </div>

        <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
          A nominee is a receiver, not an owner — succession law or a will still decides who
          inherits. Registering one is what makes the claim fast; a will is what makes it correct.
          This page tracks the first.
        </p>
      </Card>

      {report.data.byInstitution.length > 1 && (
        <Card>
          <CardTitle>Where it sits</CardTitle>
          <ul className="space-y-2">
            {report.data.byInstitution.map((row) => (
              <li key={row.institution} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">{row.institution}</span>
                <span className="flex items-center gap-2">
                  <Pill>{row.count}</Pill>
                  <Amount paise={row.valuePaise} compact />
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            Grouped because one visit or one net-banking session usually fixes several at once.
          </p>
        </Card>
      )}

      {atRisk.length === 0 ? (
        <EmptyState
          title="Every asset has a nominee"
          description="This is the position most Indian households never reach. Re-check it after opening anything new — a nomination on a savings account does not carry to a deposit funded from it."
        />
      ) : (
        atRisk.map((entry) => (
          <Card key={entry.assetId}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{entry.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {ASSET_TYPE_LABELS[entry.type]}
                  {entry.institution !== null && ` · ${entry.institution}`}
                </p>
              </div>
              <Amount paise={entry.valuePaise} className="font-medium" />
            </div>

            <p className="mt-3 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              {entry.procedure.authority}
            </p>
            <ol
              className="mt-1 list-decimal space-y-1 pl-4 text-xs"
              style={{ color: 'var(--text-secondary)' }}
            >
              {entry.procedure.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </Card>
        ))
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

const SEVERITY_COLOURS: Record<CalendarEvent['severity'], string> = {
  critical: 'var(--color-loss)',
  action: 'var(--color-warn)',
  info: 'var(--text-muted)',
};

function Calendar() {
  const [params, setParams] = useSearchParams();
  const days = Number(params.get('days') ?? 90);

  const calendar = useResource<CalendarResponse>(
    (signal) => endpoints.calendar({ days }, signal),
    [days],
  );

  if (calendar.error) {
    return <ErrorNotice message={calendar.error.message} onRetry={calendar.reload} />;
  }
  if (!calendar.data) return <Skeleton className="h-64" />;

  const byMonth = new Map<string, CalendarEvent[]>();
  for (const event of calendar.data.events) {
    const key = event.date.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), event]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[30, 90, 180, 365].map((option) => (
          <button
            key={option}
            type="button"
            className={`chip ${days === option ? 'chip-active' : ''}`}
            onClick={() => setParams({ tab: 'calendar', days: String(option) })}
          >
            {option} days
          </button>
        ))}
      </div>

      {calendar.data.events.length === 0 ? (
        <EmptyState
          title="Nothing due"
          description="No maturities, premiums or instalments in this window. Widen it, or add the dates to your assets so they show up here."
        />
      ) : (
        [...byMonth.entries()].map(([month, events]) => (
          <Card key={month}>
            <CardTitle>{monthLabel(month)}</CardTitle>
            <ul className="divide-y">
              {events.map((event, index) => (
                <li
                  key={`${event.date}-${event.kind}-${event.assetId ?? index}`}
                  className="flex flex-wrap items-start justify-between gap-3 py-2"
                >
                  <div className="flex min-w-0 gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ background: SEVERITY_COLOURS[event.severity] }}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{event.title}</p>
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {formatDate(event.date)}
                        {/* The kind is dropped where it only repeats the title — "Financial
                            year ends · Financial year ends" is noise, not a label. */}
                        {CALENDAR_KIND_LABELS[event.kind] !== event.title &&
                          ` · ${CALENDAR_KIND_LABELS[event.kind]}`}
                      </p>
                      {event.note !== undefined && (
                        <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                          {event.note}
                        </p>
                      )}
                    </div>
                  </div>
                  {event.amountPaise !== null && (
                    <Amount paise={event.amountPaise} className="text-sm" />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}

function monthLabel(yearMonth: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${yearMonth}-01T00:00:00Z`));
}

/* -------------------------------------------------------------------------- */
/* Tax year                                                                   */
/* -------------------------------------------------------------------------- */

function TaxYear() {
  const [params, setParams] = useSearchParams();
  const senior = params.get('senior') === 'true';

  const report = useResource<FinancialYearReport>(
    (signal) => endpoints.financialYear({ senior }, signal),
    [senior],
  );

  if (report.error) return <ErrorNotice message={report.error.message} onRetry={report.reload} />;
  if (!report.data) return <Skeleton className="h-96" />;

  const { financialYear, gains, interest, deductions, daysLeft, rates } = report.data;

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold">{financialYear.label}</p>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {financialYear.assessmentYear} · {daysLeft} days left
            </p>
          </div>
          <Button
            variant="secondary"
            aria-pressed={senior}
            onClick={() => setParams(senior ? { tab: 'tax' } : { tab: 'tax', senior: 'true' })}
          >
            {senior ? 'Senior citizen ✓' : 'Senior citizen'}
          </Button>
        </div>

        <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Every figure below is an <strong>estimate</strong> computed from what you have entered. It
          does not know your slab, your residency, or what you have already sold. Use it to decide
          what to look into, not to file anything.
        </p>

        {report.data.ratesCarriedForward && (
          <p className="mt-2 text-xs" style={{ color: 'var(--color-warn)' }}>
            No rates are recorded for this year, so FY {rates.fyStartYear}-
            {String((rates.fyStartYear + 1) % 100).padStart(2, '0')} rates were used.
          </p>
        )}
      </Card>

      <Card>
        <CardTitle
          action={
            gains.estimatedTaxPaise > 0 ? (
              <span className="text-sm font-semibold">
                <Amount paise={gains.estimatedTaxPaise} compact />
              </span>
            ) : undefined
          }
        >
          If you sold today
        </CardTitle>

        {gains.buckets.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Nothing here would produce a capital gain.
          </p>
        ) : (
          <ul className="space-y-3">
            {gains.buckets.map((bucket) => (
              <li key={bucket.treatment}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">
                    {GAIN_TREATMENT_LABELS[bucket.treatment]}
                  </span>
                  <span className="text-sm" style={{ color: toneOf(bucket.gainPaise) }}>
                    <Amount paise={bucket.gainPaise} compact />
                  </span>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {bucket.assetCount} {bucket.assetCount === 1 ? 'asset' : 'assets'}
                  {bucket.rateBps === null
                    ? ' · added to your income at your slab rate'
                    : ` · ${formatPercent(bucket.rateBps / 10_000, 2)} on ${formatINR(bucket.taxablePaise, { paise: false })}`}
                </p>
                {bucket.treatment === 'equity_ltcg' && (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    After the {formatINR(rates.ltcgEquityExemptPaise, { paise: false })} annual
                    exemption, which applies once across everything you hold.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {gains.entries.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>
              Per asset
            </summary>
            <ul className="mt-2 space-y-1">
              {gains.entries.map((entry) => (
                <li key={entry.assetId} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate">
                    {entry.name}
                    <span style={{ color: 'var(--text-muted)' }}> · {entry.monthsHeld} months</span>
                  </span>
                  <span style={{ color: toneOf(entry.gainPaise) }}>
                    <Amount paise={entry.gainPaise} compact />
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card>
        <CardTitle
          action={
            interest.form15Advisable ? <Pill tone="var(--color-warn)">TDS likely</Pill> : undefined
          }
        >
          Interest earned so far
        </CardTitle>

        {interest.entries.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No deposit interest has accrued this year.
          </p>
        ) : (
          <>
            <p className="text-2xl font-semibold">
              <Amount paise={interest.taxableAccruedPaise} />
            </p>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Taxable on accrual, whether or not the bank has paid it out yet — which is the part a
              statement hides until maturity.
            </p>
            {interest.exemptAccruedPaise > 0 && (
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                A further <Amount paise={interest.exemptAccruedPaise} compact /> accrued in PPF and
                Sukanya Samriddhi. That is exempt under section 10, so it is not counted above.
              </p>
            )}

            <ul className="mt-3 space-y-2">
              {interest.byPayer.map((payer) => (
                <li key={payer.institution} className="text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="truncate">{payer.institution}</span>
                    <Amount paise={payer.accruedPaise} compact />
                  </div>
                  <p
                    className="text-xs"
                    style={{
                      color: payer.crossesThreshold ? 'var(--color-warn)' : 'var(--text-muted)',
                    }}
                  >
                    {payer.crossesThreshold
                      ? `Over the ${formatINR(payer.thresholdPaise, { paise: false })} threshold — about ${formatINR(payer.estimatedTdsPaise, { paise: false })} will be deducted at source.`
                      : `Under the ${formatINR(payer.thresholdPaise, { paise: false })} threshold for this payer.`}
                  </p>
                </li>
              ))}
            </ul>

            {interest.form15Advisable && (
              <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                If your total income is below the taxable limit, Form 15G — or 15H if you are sixty
                or over — filed with each bank stops the deduction rather than reclaiming it a year
                later.
              </p>
            )}
          </>
        )}
      </Card>

      {deductions.map((bucket) => (
        <DeductionCard key={bucket.section} bucket={bucket} daysLeft={daysLeft} />
      ))}

      <Card>
        <CardTitle>Rates used</CardTitle>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <Rate
            label="Equity, long term"
            value={formatPercent(rates.ltcgEquityRateBps / 10_000, 2)}
          />
          <Rate
            label="Equity exemption"
            value={formatINR(rates.ltcgEquityExemptPaise, { paise: false })}
          />
          <Rate
            label="Equity, short term"
            value={formatPercent(rates.stcgEquityRateBps / 10_000, 2)}
          />
          <Rate
            label="Other, long term"
            value={formatPercent(rates.ltcgOtherRateBps / 10_000, 2)}
          />
          <Rate label="80C limit" value={formatINR(rates.section80CLimitPaise, { paise: false })} />
          <Rate
            label="TDS threshold"
            value={formatINR(senior ? rates.fdTdsThresholdSeniorPaise : rates.fdTdsThresholdPaise, {
              paise: false,
            })}
          />
        </dl>
      </Card>
    </div>
  );
}

function Rate({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: 'var(--text-secondary)' }}>{label}</dt>
      <dd className="tabular text-right">{value}</dd>
    </>
  );
}

function DeductionCard({ bucket, daysLeft }: { bucket: DeductionBucket; daysLeft: number }) {
  const filled = bucket.limitPaise === 0 ? 0 : Math.min(1, bucket.claimedPaise / bucket.limitPaise);

  return (
    <Card>
      <CardTitle
        action={
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            of {formatINR(bucket.limitPaise, { paise: false })}
          </span>
        }
      >
        Section {bucket.section}
      </CardTitle>

      <p className="text-2xl font-semibold">
        <Amount paise={bucket.claimedPaise} />
      </p>

      <div
        className="mt-2 h-2 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--surface-sunken)' }}
        role="img"
        aria-label={`${Math.round(filled * 100)} percent of the section ${bucket.section} limit used`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${filled * 100}%`, background: 'var(--accent-solid)' }}
        />
      </div>

      {bucket.headroomPaise > 0 && (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <Amount paise={bucket.headroomPaise} compact /> of headroom, {daysLeft} days to use it.
        </p>
      )}

      {bucket.entries.length > 0 && (
        <ul className="mt-3 space-y-1">
          {bucket.entries.map((entry) => (
            <li
              key={`${entry.assetId}-${entry.source}`}
              className="flex justify-between gap-3 text-xs"
            >
              <span className="min-w-0 truncate">
                {entry.name}
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}
                  · {DEDUCTION_SOURCE_LABELS[entry.source]}
                  {entry.estimated && ' (estimated)'}
                </span>
              </span>
              <Amount paise={entry.amountPaise} compact />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Only what this app can see. Tuition fees, stamp duty and tax-saver deposits are eligible too
        and are not counted here.
      </p>
    </Card>
  );
}
