/**
 * Choosing the scheme or share a holding is in.
 *
 * Search first, create second — and creation is find-or-create on the server, so two
 * households adding the same fund end up pointing at one row with one NAV history rather
 * than two that drift apart.
 *
 * The search is debounced for the same reason the asset list's is: otherwise "parag parikh"
 * is twelve round trips.
 *
 * The "add it" panel is deliberately *not* a `<form>`. This component renders inside the
 * asset form, and React drops a nested form element — which left the panel's own fields
 * owned by the asset form, so "Add instrument" performed a native GET submit, reloaded the
 * page and lost everything typed into it. The panel keeps its fields in state and submits
 * them from a button instead, and swallows Enter for the same reason: an implicit
 * submission here belongs to no form but the outer one.
 */

import { useEffect, useState } from 'react';
import { INSTRUMENT_KINDS, type InstrumentRecord } from '@networth/shared';
import { endpoints } from '../../lib/endpoints.js';
import { Button, Field, Input, Select } from '../ui.js';

type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

interface Draft {
  name: string;
  kind: InstrumentKind;
  amfiSchemeCode: string;
  symbol: string;
  category: string;
}

const EMPTY_DRAFT: Draft = { name: '', kind: 'mf', amfiSchemeCode: '', symbol: '', category: '' };

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
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
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
        <Button type="button" variant="ghost" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  async function create() {
    setError(null);
    try {
      const optional = (raw: string): string | undefined => {
        const trimmed = raw.trim();
        return trimmed === '' ? undefined : trimmed;
      };
      // Every key is spelled out, including the absent ones: these schemas trim and
      // uppercase, and a transformed optional is a required key holding `undefined`.
      const body = await endpoints.createInstrument({
        kind: draft.kind,
        name: draft.name.trim(),
        exchange: 'none',
        amfiSchemeCode: optional(draft.amfiSchemeCode),
        isin: undefined,
        symbol: optional(draft.symbol),
        amc: undefined,
        category: optional(draft.category),
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
        // Enter in a search box means "search", and this one is the asset form's only
        // single-line input at the top level — without this, it submits the whole asset.
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault();
        }}
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
        <div
          className="space-y-3 rounded-xl p-3"
          style={{ background: 'var(--surface-sunken)' }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void create();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
              />
            </Field>
            <Field label="Kind">
              <Select
                value={draft.kind}
                onChange={(event) =>
                  setDraft({ ...draft, kind: event.target.value as InstrumentKind })
                }
              >
                {INSTRUMENT_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="AMFI scheme code" hint="The join key for NAV imports">
              <Input
                value={draft.amfiSchemeCode}
                onChange={(event) => setDraft({ ...draft, amfiSchemeCode: event.target.value })}
                inputMode="numeric"
              />
            </Field>
            <Field label="Ticker">
              <Input
                value={draft.symbol}
                onChange={(event) => setDraft({ ...draft, symbol: event.target.value })}
              />
            </Field>
            <Field label="Category" hint="Drives how it is classified — 'Equity Scheme - ELSS'">
              <Input
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value })}
              />
            </Field>
          </div>
          {error !== null && (
            <p className="text-xs" style={{ color: 'var(--color-loss)' }}>
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="primary" onClick={() => void create()}>
              Add instrument
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT, name: term.trim() });
            setError(null);
            setCreating(true);
          }}
        >
          Not listed? Add it
        </Button>
      )}
    </div>
  );
}
