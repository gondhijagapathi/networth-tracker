/**
 * Choosing the scheme or share a holding is in.
 *
 * Search first, create second — and creation is find-or-create on the server, so two
 * households adding the same fund end up pointing at one row with one NAV history rather
 * than two that drift apart.
 *
 * The search is debounced for the same reason the asset list's is: otherwise "parag parikh"
 * is twelve round trips.
 */

import { useEffect, useState } from 'react';
import { INSTRUMENT_KINDS, type InstrumentRecord } from '@networth/shared';
import { endpoints } from '../../lib/endpoints.js';
import { Button, Field, Input, Select } from '../ui.js';

export function InstrumentPicker({
  value,
  onChange,
}: {
  value: InstrumentRecord | null;
  onChange: (instrument: InstrumentRecord | null) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<InstrumentRecord[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void endpoints
        .searchInstruments(term.trim(), controller.signal)
        .then((body) => setResults(body.instruments))
        .catch(() => {
          // A failed search is not worth an error banner; the field simply shows nothing.
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  if (value !== null) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
        style={{ background: 'var(--surface-sunken)' }}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{value.name}</p>
          <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
            {[value.kind.toUpperCase(), value.amfiSchemeCode, value.symbol, value.category]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <Button variant="ghost" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  async function create(form: HTMLFormElement) {
    const data = new FormData(form);
    setError(null);
    try {
      const field = (name: string): string | undefined => {
        const value = String(data.get(name) ?? '').trim();
        return value === '' ? undefined : value;
      };
      // Every key is spelled out, including the absent ones: these schemas trim and
      // uppercase, and a transformed optional is a required key holding `undefined`.
      const body = await endpoints.createInstrument({
        kind: (field('kind') ?? 'mf') as (typeof INSTRUMENT_KINDS)[number],
        name: String(data.get('name') ?? ''),
        exchange: 'none',
        amfiSchemeCode: field('amfiSchemeCode'),
        isin: undefined,
        symbol: field('symbol'),
        amc: undefined,
        category: field('category'),
      });
      onChange(body.instrument);
    } catch {
      setError('Give a name and at least one of an AMFI code or a ticker.');
    }
  }

  return (
    <div className="space-y-2">
      <Input
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search by name, AMFI code, ISIN or ticker"
        aria-label="Search instruments"
      />

      {results.length > 0 && (
        <ul className="max-h-56 overflow-y-auto rounded-xl border">
          {results.map((instrument) => (
            <li key={instrument.id}>
              <button
                type="button"
                onClick={() => onChange(instrument)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-overlay)]"
              >
                <span className="block truncate font-medium">{instrument.name}</span>
                <span className="block truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                  {[instrument.kind.toUpperCase(), instrument.amfiSchemeCode, instrument.symbol]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        /* Nested forms are invalid HTML, so this collects its own fields and submits them
           through a button rather than a `form` element. */
        <div className="space-y-3 rounded-xl p-3" style={{ background: 'var(--surface-sunken)' }}>
          <form
            id="new-instrument"
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void create(event.currentTarget);
            }}
          >
            <Field label="Name">
              <Input name="name" required defaultValue={term} />
            </Field>
            <Field label="Kind">
              <Select name="kind" defaultValue="mf">
                {INSTRUMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="AMFI scheme code" hint="The join key for NAV imports">
              <Input name="amfiSchemeCode" inputMode="numeric" />
            </Field>
            <Field label="Ticker">
              <Input name="symbol" />
            </Field>
            <Field label="Category" hint="Drives how it is classified — 'Equity Scheme - ELSS'">
              <Input name="category" />
            </Field>
          </form>
          {error !== null && (
            <p className="text-xs" style={{ color: 'var(--color-loss)' }}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" form="new-instrument" variant="primary">
              Add instrument
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" onClick={() => setCreating(true)}>
          Not listed? Add it
        </Button>
      )}
    </div>
  );
}
