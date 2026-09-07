/**
 * Where the money is.
 *
 * A donut rather than a pie: the hole carries the total, which is the number the reader
 * wants first, and it stops the eye trying to compare slice areas — a comparison people are
 * demonstrably bad at. The legend beside it does the actual comparing, with figures.
 *
 * Slices arrive largest-first from the API, so the order here is the order on screen and
 * the colour assignment is stable between renders.
 */

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatCompactINR, type AllocationResponse, type AllocationSlice } from '@networth/shared';
import { colourFor, formatPercent } from '../../lib/format.js';

interface TooltipPayload {
  active?: boolean;
  payload?: Array<{ payload: AllocationSlice }>;
}

function SliceTooltip({ active, payload }: TooltipPayload) {
  const slice = payload?.[0]?.payload;
  if (active !== true || slice === undefined) return null;

  return (
    <div className="surface-card px-3 py-2 text-xs">
      <p className="font-medium">{slice.label}</p>
      <p className="sensitive tabular mt-1">
        {formatCompactINR(slice.valuePaise)} · {formatPercent(slice.share)}
      </p>
    </div>
  );
}

export function AllocationDonut({ allocation }: { allocation: AllocationResponse }) {
  if (allocation.slices.length === 0) {
    return (
      <p className="py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
        Nothing to allocate yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="relative h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={allocation.slices}
              dataKey="valuePaise"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={1.5}
              stroke="var(--surface-raised)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {allocation.slices.map((slice, index) => (
                <Cell key={slice.key} fill={colourFor(slice.key, index)} />
              ))}
            </Pie>
            <Tooltip content={<SliceTooltip />} />
          </PieChart>
        </ResponsiveContainer>

        {/* The total sits in the hole, where the eye lands first. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Total
          </span>
          <span className="sensitive tabular text-sm font-semibold">
            {formatCompactINR(allocation.totalPaise)}
          </span>
        </div>
      </div>

      <ul className="w-full min-w-0 space-y-1.5">
        {allocation.slices.map((slice, index) => (
          <li key={slice.key} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: colourFor(slice.key, index) }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="tabular shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
              {formatPercent(slice.share)}
            </span>
            <span className="sensitive tabular w-20 shrink-0 text-right text-xs">
              {formatCompactINR(slice.valuePaise)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
