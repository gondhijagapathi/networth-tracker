/**
 * Adding and editing an asset.
 *
 * One component for both, because they differ in three things and not in the other thirty:
 * an edit cannot change the `type` (changing it would orphan one detail row and require
 * inventing another), it cannot set an opening value (values are appended on the asset's own
 * page), and it starts with the fields filled in.
 *
 * Validation is the server's. The same Zod schemas run in this bundle, but re-implementing
 * the rules here would create a second place for them to be wrong — so the form submits,
 * and field errors come back keyed by path and land next to the input that caused them.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ASSET_TYPES,
  parseAmount,
  type AssetRecord,
  type AssetType,
  type CreateAssetBody,
  type InstrumentRecord,
} from '@networth/shared';
import { InstrumentPicker } from '../components/assets/InstrumentPicker.js';
import {
  Button,
  Card,
  CardTitle,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '../components/ui.js';
import { ApiError } from '../lib/api.js';
import {
  DETAIL_FIELDS,
  OTHER_ASSET_FIELDS,
  decodeField,
  encodeField,
  microRupeesFromRupees,
  type FieldSpec,
} from '../lib/assetFields.js';
import { endpoints } from '../lib/endpoints.js';
import { ASSET_TYPE_LABELS } from '../lib/format.js';
import { useResource } from '../lib/resource.js';

export function AssetForm({ mode }: { mode: 'create' | 'edit' }) {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const existing = useResource(
    (signal) => (mode === 'edit' ? endpoints.asset(id, signal) : Promise.resolve(null)),
    [mode, id],
  );

  if (mode === 'edit' && existing.error !== null) {
    return <ErrorNotice message={existing.error.message} onRetry={existing.reload} />;
  }
  if (mode === 'edit' && existing.data === null) return <Skeleton className="h-96" />;

  const record = existing.data?.asset ?? null;

  return (
    <Editor
      key={record?.id ?? 'new'}
      mode={mode}
      record={record}
      onDone={(assetId) => void navigate(`/assets/${assetId}`)}
    />
  );
}

type Values = Record<string, string | boolean>;

function Editor({
  mode,
  record,
  onDone,
}: {
  mode: 'create' | 'edit';
  record: Awaited<ReturnType<typeof endpoints.asset>>['asset'] | null;
  onDone: (assetId: string) => void;
}) {
  const [type, setType] = useState<AssetType>(record?.type ?? 'bank_account');
  const [instrument, setInstrument] = useState<InstrumentRecord | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const [values, setValues] = useState<Values>(() => initialValues(record, type));

  const detailSpecs = useMemo(() => specsFor(type, values), [type, values]);

  function set(name: string, value: string | boolean) {
    setValues((previous) => ({ ...previous, [name]: value }));
  }

  function changeType(next: AssetType) {
    setType(next);
    // The detail fields are entirely different per type, so keeping the old ones would
    // submit a bank account's IFSC as part of a property.
    setValues((previous) => ({
      name: previous.name ?? '',
      institution: previous.institution ?? '',
      notes: previous.notes ?? '',
      ownershipBps: previous.ownershipBps ?? '100',
      nomineeRegistered: previous.nomineeRegistered ?? false,
      openedOn: previous.openedOn ?? '',
      valuePaise: previous.valuePaise ?? '',
      valueAsOf: previous.valueAsOf ?? new Date().toISOString().slice(0, 10),
      ...defaultsFor(next),
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const detail = buildDetail(type, detailSpecs, values, instrument, record);
      const base = {
        name: String(values.name ?? '').trim(),
        institution: String(values.institution ?? '').trim() || undefined,
        // Spelled out rather than omitted: the schema transforms it, which makes the key
        // required in the parsed type even though the value is allowed to be absent.
        jointWith: undefined,
        nomineeRegistered: values.nomineeRegistered === true,
        // Ownership is entered as a percentage and stored in basis points, so a 33.33%
        // split survives as an integer rather than a float that cannot add back to 100.
        ownershipBps: Math.round(Number(values.ownershipBps || 100) * 100),
        openedOn: String(values.openedOn ?? '') || undefined,
        notes: String(values.notes ?? '').trim() || undefined,
      };

      if (mode === 'create') {
        const opening = String(values.valuePaise ?? '').trim();
        const body = {
          ...base,
          type,
          detail,
          tags: [],
          status: 'active',
          ...(opening === ''
            ? {}
            : {
                valuePaise: parseAmount(opening),
                valueAsOf: String(values.valueAsOf ?? '') || undefined,
              }),
        } as unknown as CreateAssetBody;

        const created = await endpoints.createAsset(body);
        onDone(created.asset.id);
      } else {
        const updated = await endpoints.updateAsset(record!.id, { ...base, detail });
        onDone(updated.asset.id);
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, {
              code: 'bad_request',
              message: 'Check the amounts — one of them could not be read.',
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  const needsInstrument = type === 'holding' && mode === 'create';

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <PageHeader
        title={mode === 'create' ? 'Add an asset' : `Edit ${record?.name ?? ''}`}
        subtitle={
          mode === 'edit'
            ? 'The type cannot be changed — a fixed deposit that turns out to be a flat is a new asset.'
            : undefined
        }
      />

      {error !== null && error.details._ !== undefined && <ErrorNotice message={error.message} />}

      <Card>
        <CardTitle>The basics</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          {mode === 'create' && (
            <Field label="What is it">
              <Select
                value={type}
                onChange={(event) => changeType(event.target.value as AssetType)}
              >
                {ASSET_TYPES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {ASSET_TYPE_LABELS[candidate]}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Name" error={error?.fieldError('name')}>
            <Input
              value={String(values.name ?? '')}
              onChange={(event) => set('name', event.target.value)}
              required
              placeholder="HDFC salary account"
            />
          </Field>

          <Field label="Institution" error={error?.fieldError('institution')}>
            <Input
              value={String(values.institution ?? '')}
              onChange={(event) => set('institution', event.target.value)}
              placeholder="HDFC Bank"
            />
          </Field>

          <Field
            label="Your share"
            hint="Per cent. Leave at 100 unless it is jointly held."
            error={error?.fieldError('ownershipBps')}
          >
            <Input
              value={String(values.ownershipBps ?? '100')}
              onChange={(event) => set('ownershipBps', event.target.value)}
              inputMode="decimal"
            />
          </Field>

          <Field label="Opened on" error={error?.fieldError('openedOn')}>
            <Input
              type="date"
              value={String(values.openedOn ?? '')}
              onChange={(event) => set('openedOn', event.target.value)}
            />
          </Field>

          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={values.nomineeRegistered === true}
              onChange={(event) => set('nomineeRegistered', event.target.checked)}
            />
            {/* Defaults to unticked deliberately: an unset nomination is the common and
                dangerous case, and the dashboard should say so. */}
            <span>A nominee is registered on this</span>
          </label>
        </div>
      </Card>

      {needsInstrument && (
        <Card>
          <CardTitle>Which fund or share</CardTitle>
          <InstrumentPicker value={instrument} onChange={setInstrument} />
          {error?.fieldError('detail.instrumentId') !== undefined && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-loss)' }}>
              {error.fieldError('detail.instrumentId')}
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardTitle>{ASSET_TYPE_LABELS[type]} details</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          {detailSpecs.map((spec) => (
            <SpecField
              key={spec.name}
              spec={spec}
              value={values[spec.name] ?? ''}
              error={error?.fieldError(`detail.${spec.name}`)}
              onChange={(value) => set(spec.name, value)}
            />
          ))}
        </div>
      </Card>

      {mode === 'create' && (
        <Card>
          <CardTitle>What is it worth today?</CardTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Value" hint="Optional — deposits and funds are computed for you.">
              <Input
                value={String(values.valuePaise ?? '')}
                onChange={(event) => set('valuePaise', event.target.value)}
                inputMode="decimal"
                placeholder="12.5L"
              />
            </Field>
            <Field label="As at">
              <Input
                type="date"
                value={String(values.valueAsOf ?? '')}
                onChange={(event) => set('valueAsOf', event.target.value)}
              />
            </Field>
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Notes</CardTitle>
        <textarea
          className="input min-h-24"
          value={String(values.notes ?? '')}
          onChange={(event) => set('notes', event.target.value)}
          placeholder="Where the papers are, who to call, anything an heir would need."
        />
      </Card>

      <div className="flex gap-2 pb-4">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Saving…' : mode === 'create' ? 'Add asset' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={() => window.history.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SpecField({
  spec,
  value,
  error,
  onChange,
}: {
  spec: FieldSpec;
  value: string | boolean;
  error?: string;
  onChange: (value: string | boolean) => void;
}) {
  if (spec.kind === 'boolean') {
    return (
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{spec.label}</span>
      </label>
    );
  }

  return (
    <Field label={spec.label} hint={spec.hint} error={error}>
      {spec.kind === 'select' ? (
        <Select value={String(value)} onChange={(event) => onChange(event.target.value)}>
          {spec.required !== true && <option value="">—</option>}
          {spec.options?.map((option) => (
            <option key={option} value={option}>
              {option.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          required={spec.required}
          type={spec.kind === 'date' ? 'date' : 'text'}
          inputMode={
            spec.kind === 'money' || spec.kind === 'rate' || spec.kind === 'micro'
              ? 'decimal'
              : spec.kind === 'integer' || spec.kind === 'grams'
                ? 'decimal'
                : undefined
          }
        />
      )}
    </Field>
  );
}

/* -------------------------------------------------------------------------- */
/* Values in and out                                                          */
/* -------------------------------------------------------------------------- */

/** The fields on show, which for the long tail depend on the kind chosen. */
function specsFor(type: AssetType, values: Values): FieldSpec[] {
  const base = DETAIL_FIELDS[type].filter((spec) => {
    if (spec.onlyWhen === undefined) return true;
    return spec.onlyWhen.equals.includes(String(values[spec.onlyWhen.field] ?? ''));
  });

  if (type !== 'other_asset') return base;
  const kind = String(values.kind ?? 'crypto');
  return [...base, ...(OTHER_ASSET_FIELDS[kind] ?? [])];
}

/** A select with no stored value must still submit something the schema accepts. */
function defaultsFor(type: AssetType): Values {
  const out: Values = {};
  for (const spec of DETAIL_FIELDS[type]) {
    if (spec.kind === 'select' && spec.required === true) out[spec.name] = spec.options?.[0] ?? '';
    if (spec.kind === 'boolean') out[spec.name] = false;
  }
  if (type === 'other_asset') out.kind = 'crypto';
  return out;
}

function initialValues(record: AssetRecord | null, type: AssetType): Values {
  const base: Values = {
    name: '',
    institution: '',
    notes: '',
    ownershipBps: '100',
    nomineeRegistered: false,
    openedOn: '',
    valuePaise: '',
    valueAsOf: new Date().toISOString().slice(0, 10),
    ...defaultsFor(type),
  };
  if (record === null) return base;

  const detail = record.detail as unknown as Record<string, unknown>;
  const values: Values = {
    ...base,
    name: record.name,
    institution: record.institution ?? '',
    notes: record.notes ?? '',
    ownershipBps: (record.ownershipBps / 100).toString(),
    nomineeRegistered: record.nomineeRegistered,
    openedOn: record.openedOn ?? '',
  };

  const kind = String(detail.kind ?? '');
  for (const spec of [...DETAIL_FIELDS[type], ...(OTHER_ASSET_FIELDS[kind] ?? [])]) {
    values[spec.name] = decodeField(spec, detail[spec.name]);
  }
  return values;
}

/**
 * Turn the form back into the detail object the schema expects.
 *
 * An edit sends a partial that the server merges into what is stored and re-validates as a
 * whole, so an untouched field left blank stays whatever it was rather than being cleared.
 */
function buildDetail(
  type: AssetType,
  specs: FieldSpec[],
  values: Values,
  instrument: InstrumentRecord | null,
  record: AssetRecord | null,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};

  for (const spec of specs) {
    const encoded = encodeField(spec, values[spec.name] ?? '');
    if (encoded !== undefined) detail[spec.name] = encoded;
  }

  if (type === 'holding') {
    // The picker holds the instrument on create; on edit it is already on the record and
    // must not be changed by a form that never asked about it.
    const stored = (record?.detail as { instrumentId?: string } | undefined)?.instrumentId;
    if (instrument !== null) detail.instrumentId = instrument.id;
    else if (stored !== undefined) detail.instrumentId = stored;

    // The form asks for a per-unit price in rupees; the column is micro-rupees.
    const cost = String(values.avgCostMicro ?? '').trim();
    if (cost !== '') detail.avgCostMicro = microRupeesFromRupees(Number(cost));
  }

  return detail;
}
