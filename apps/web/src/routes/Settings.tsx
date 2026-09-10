/**
 * Settings: how numbers read, and how the data gets out.
 *
 * Backup and restore used to live here. They moved to Administration, because a bundle is
 * every account on the installation rather than one person's data — see
 * `components/BackupSection.tsx`.
 */

import { useEffect, useState } from 'react';
import { EXPORT_DATASETS, EXPORT_DATASET_LABELS, type ExportDataset } from '@networth/shared';
import { Card, CardTitle, Field, PageHeader, Select } from '../components/ui.js';
import { useDisplay } from '../lib/display.js';
import { endpoints } from '../lib/endpoints.js';
import { usePrivacy } from '../lib/privacy.js';
import { applyTheme, readTheme, type Theme } from '../lib/theme.js';

export function Settings() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        subtitle="How this looks, and how your data gets in and out of it."
      />

      <DisplayCard />
      <ExportCard />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

function DisplayCard() {
  const { compact, toggle } = useDisplay();
  const { hidden, toggle: togglePrivacy } = usePrivacy();
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <Card>
      <CardTitle>Display</CardTitle>
      <div className="space-y-3">
        <Toggle
          label="Lakh and crore"
          hint={
            compact
              ? 'Amounts read as ₹1.23 Cr. The exact figure is in the tooltip.'
              : 'Amounts read in full, as ₹1,23,45,678.00.'
          }
          pressed={compact}
          onChange={toggle}
        />
        <Toggle
          label="Hide amounts"
          hint="Blurs every figure on screen. Press H anywhere to toggle it."
          pressed={hidden}
          onChange={togglePrivacy}
        />
        <Toggle
          label="Dark theme"
          hint="Light is fully supported; dark is what this was designed in."
          pressed={theme === 'dark'}
          onChange={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      </div>
    </Card>
  );
}

/**
 * A switch.
 *
 * A real `<button>` with `aria-pressed` rather than a styled checkbox: it is reachable by
 * keyboard, announced as a toggle by a screen reader, and does not depend on a label's
 * `for` attribute to be operable.
 */
function Toggle({
  label,
  hint,
  pressed,
  onChange,
}: {
  label: string;
  hint: string;
  pressed: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {hint}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={pressed}
        aria-label={label}
        onClick={onChange}
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        style={{
          background: pressed ? 'var(--accent-solid)' : 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full transition-all"
          style={{
            left: pressed ? '1.5rem' : '0.15rem',
            background: pressed ? 'oklch(0.99 0 0)' : 'var(--text-muted)',
          }}
        />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

function ExportCard() {
  const [dataset, setDataset] = useState<ExportDataset>('assets');

  return (
    <Card>
      <CardTitle>Export</CardTitle>
      <p className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
        Your own assets, transactions and valuations — not your household&rsquo;s. Vault items come
        out as the ciphertext they are stored as; nothing here can read them, including this server.
      </p>

      <div className="space-y-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-48 flex-1">
            <Field label="Spreadsheet" hint="One sheet per asset class, in rupees.">
              <Select
                value={dataset}
                onChange={(event) => setDataset(event.target.value as ExportDataset)}
              >
                {EXPORT_DATASETS.map((option) => (
                  <option key={option} value={option}>
                    {EXPORT_DATASET_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {/*
           * `Field` puts its hint underneath the control, so aligning this row on its
           * bottom edge would line the button up with the hint rather than the select.
           * The spacer stands in for the label above the select — same size, no text —
           * and the row aligns on its top edge instead.
           */}
          <div>
            <span aria-hidden="true" className="mb-1 block text-xs">
              &nbsp;
            </span>
            <a className="btn btn-secondary" href={endpoints.exportCsvUrl(dataset)} download>
              Download CSV
            </a>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            The complete record, with exact paise and every typed detail. This is the one to migrate
            from.
          </p>
          <a className="btn btn-secondary" href={endpoints.exportJsonUrl()} download>
            Download JSON
          </a>
        </div>
      </div>
    </Card>
  );
}
