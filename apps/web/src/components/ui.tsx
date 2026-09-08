/**
 * The small pieces every screen is built from.
 *
 * Kept in one file rather than one file each: none of them is more than a few lines, and a
 * component library of thirty single-export modules is harder to read than this is.
 *
 * Amounts are wrapped in `.sensitive` throughout, which is what makes the privacy toggle a
 * single class on the root element rather than a prop threaded through the tree.
 */

import { cloneElement, useId } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { formatCompactINR, formatINR } from '@networth/shared';
import { useDisplay } from '../lib/display.js';
import { toneOf } from '../lib/format.js';

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return <Tag className={`surface-card p-4 sm:p-5 ${className}`}>{children}</Tag>;
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An amount.
 *
 * Compact gives the lakh/crore reading a person actually speaks; the full figure stays in
 * the `title` so it is one hover away and still selectable and searchable in the page.
 *
 * The `compact` prop is deliberately optional and *not* defaulted to false. Left unset, the
 * amount follows the reader's own lakh/crore preference, which is what makes that toggle a
 * setting rather than a suggestion. A call site passes it explicitly only where the choice
 * belongs to the screen rather than to the reader — a figure inside a chart tooltip has no
 * room for eight digits whatever the preference says.
 */
export function Amount({
  paise,
  compact,
  showPaise = false,
  tone = false,
  className = '',
}: {
  paise: number;
  compact?: boolean;
  showPaise?: boolean;
  /** Colour it as a gain or a loss. Off by default: a balance is not a result. */
  tone?: boolean;
  className?: string;
}) {
  const { compact: preferCompact } = useDisplay();
  const short = compact ?? preferCompact;
  const full = formatINR(paise, { paise: showPaise });

  return (
    <span
      className={`sensitive tabular ${className}`}
      title={full}
      style={tone ? { color: toneOf(paise) } : undefined}
    >
      {short ? formatCompactINR(paise) : full}
    </span>
  );
}

/** A change, with its sign and its colour. */
export function Change({ paise, ratio }: { paise: number; ratio: number | null }) {
  const sign = paise < 0 ? '−' : '+';
  return (
    <span className="sensitive tabular text-sm font-medium" style={{ color: toneOf(paise) }}>
      {sign}
      {formatCompactINR(Math.abs(paise)).replace('₹', '₹')}
      {ratio !== null && ` (${sign}${(Math.abs(ratio) * 100).toFixed(1)}%)`}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return <button {...props} className={`btn btn-${variant} ${className}`} />;
}

/**
 * A labelled control, with its hint and its error.
 *
 * The hint and the error are attached with `aria-describedby` rather than left inside the
 * `<label>`, and the difference is not cosmetic. Nested in the label, they become part of
 * the control's *accessible name*: a screen reader announces the "Value" field as "Value
 * Optional — deposits and funds are computed for you., edit text", and two fields whose
 * hints differ read as two unrelated controls. As a description, the hint is announced
 * after the name, on request, which is what a description is for.
 *
 * The id is injected into the child with `cloneElement`, so a caller writes `<Field
 * label="Value"><Input …/></Field>` and gets the wiring for free. That constrains `children`
 * to a single element, which is what every call site passes and what the type now says.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
}) {
  const id = useId();
  const describedBy =
    error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div className="block">
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium"
        style={{ color: 'var(--text-secondary)' }}
      >
        {label}
      </label>

      {cloneElement(children, {
        id,
        'aria-describedby': describedBy,
        ...(error !== undefined ? { 'aria-invalid': true } : {}),
      })}

      {error !== undefined ? (
        <span
          id={`${id}-error`}
          role="alert"
          className="mt-1 block text-xs"
          style={{ color: 'var(--color-loss)' }}
        >
          {error}
        </span>
      ) : (
        hint !== undefined && (
          <span
            id={`${id}-hint`}
            className="mt-1 block text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            {hint}
          </span>
        )
      )}
    </div>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${className}`} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`input ${className}`} />;
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A placeholder shaped like the thing that is loading.
 *
 * Not a spinner: a spinner in the middle of a dashboard tells you something is happening
 * and nothing about what, and the layout jumps when it is replaced.
 */
export function Skeleton({ className = 'h-24' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-xl ${className}`}
      style={{ background: 'var(--surface-sunken)' }}
      aria-hidden="true"
    />
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="surface-card flex flex-wrap items-center justify-between gap-3 p-4 text-sm"
      role="alert"
    >
      <span style={{ color: 'var(--color-loss)' }}>{message}</span>
      {onRetry !== undefined && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="surface-card px-6 py-10 text-center">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm" style={{ color: 'var(--text-secondary)' }}>
        {description}
      </p>
      {action !== undefined && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** A small label: an asset class, a status, where a number came from. */
export function Pill({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone?: string;
  title?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      title={title}
      style={{
        background: 'var(--surface-overlay)',
        color: tone ?? 'var(--text-secondary)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {children}
    </span>
  );
}
