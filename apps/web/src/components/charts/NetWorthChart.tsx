/**
 * Net worth over time.
 *
 * An area rather than a line: the question is "how much", and an area answers it at a
 * glance where a line asks you to read an axis. Assets and liabilities are drawn as a
 * single net figure, because a household thinks in one number and the two components are
 * one tap away on the summary card above.
 *
 * Amounts inside the chart carry `.sensitive`, so the privacy toggle blurs the axis and the
 * tooltip while the *shape* stays readable. Hiding the trend as well as the numbers would
 * defeat the reason somebody opens this on a train.
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCompactINR, type NetWorthPoint } from '@networth/shared';
import { formatDate, formatMonth } from '../../lib/format.js';

interface TooltipPayload {
  active?: boolean;
  payload?: Array<{ payload: NetWorthPoint }>;
}

function ChartTooltip({ active, payload }: TooltipPayload) {
  const point = payload?.[0]?.payload;
  if (active !== true || point === undefined) return null;

  return (
    <div className="surface-card px-3 py-2 text-xs">
      <p className="font-medium">{formatDate(point.date)}</p>
      <p className="sensitive tabular mt-1 text-sm font-semibold">
        {formatCompactINR(point.netPaise)}
      </p>
      <p className="sensitive tabular mt-0.5" style={{ color: 'var(--text-secondary)' }}>
        {formatCompactINR(point.assetsPaise)} assets
        {point.liabilitiesPaise > 0 && ` · ${formatCompactINR(point.liabilitiesPaise)} owed`}
      </p>
    </div>
  );
}

export function NetWorthChart({ series }: { series: NetWorthPoint[] }) {
  // A single point is not a trend, and Recharts renders it as an invisible dot.
  if (series.length < 2) {
    return (
      <div
        className="flex h-56 items-center justify-center rounded-xl text-sm"
        style={{ background: 'var(--surface-sunken)', color: 'var(--text-muted)' }}
      >
        Not enough history to draw a chart yet.
      </div>
    );
  }

  const lowest = Math.min(...series.map((point) => point.netPaise));

  return (
    <div className="h-56 sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />

          <XAxis
            dataKey="date"
            tickFormatter={formatMonth}
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            tickFormatter={(value: number) => formatCompactINR(value, 0)}
            tick={{ fill: 'var(--text-muted)', fontSize: 11, className: 'sensitive' }}
            axisLine={false}
            tickLine={false}
            width={56}
          />

          {/* Net worth can be negative — a new home loan against a small deposit — and the
              zero line is what makes that legible rather than just "low". */}
          {lowest < 0 && <ReferenceLine y={0} stroke="var(--border-strong)" />}

          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--border-strong)' }} />

          <Area
            type="monotone"
            dataKey="netPaise"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#netWorthFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
