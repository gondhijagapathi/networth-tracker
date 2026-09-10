/**
 * Settings: how numbers read, and how the data gets out.
 *
 * Backup and restore used to live here. They moved to Administration, because a bundle is
 * every account on the installation rather than one person's data — see
 * `components/BackupSection.tsx`.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { EXPORT_DATASETS, EXPORT_DATASET_LABELS, type ExportDataset } from '@networth/shared';
import {
  Button,
  Card,
  CardTitle,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Pill,
  Select,
} from '../components/ui.js';
import { ApiError } from '../lib/api.js';
import { useDisplay } from '../lib/display.js';
import { endpoints } from '../lib/endpoints.js';
import { usePrivacy } from '../lib/privacy.js';
import { useSession } from '../lib/session.js';
import { applyTheme, readTheme, type Theme } from '../lib/theme.js';

export function Settings() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Settings"
        subtitle="How this looks, and how your data gets in and out of it."
      />

      <DisplayCard />
      <TwoFactorCard />
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
/* Two-factor authentication                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turning TOTP on, and turning it off again.
 *
 * Enrolment is a three-step conversation the server insists on: ask for a secret, prove a
 * live code from it, keep the recovery codes it answers with. The middle step is what makes
 * it safe to switch on — a secret nobody has actually scanned would lock the account out at
 * the next sign-in — and the last is the only chance there is to see those codes, so they
 * are shown on their own with nothing to click past them by accident.
 */
function TwoFactorCard() {
  const { user, refresh } = useSession();
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const enabled = user?.totpEnabled === true;

  useEffect(() => {
    if (!enabled) {
      setRemaining(null);
      return;
    }
    const controller = new AbortController();
    void endpoints
      .me(controller.signal)
      .then((body) => setRemaining(body.recoveryCodesRemaining))
      .catch(() => {
        // A missing count is not worth an error banner; the line simply does not appear.
      });
    return () => controller.abort();
  }, [enabled, codes]);

  // The QR is drawn in the browser rather than fetched: an otpauth URI carries the secret,
  // and a self-hosted app has no business sending it to a chart service to be rendered.
  useEffect(() => {
    if (enrolment === null) {
      setQr(null);
      return;
    }
    let cancelled = false;
    // Loaded on demand: the encoder is dead weight in the main bundle for everybody who
    // never enrols, which is most sessions.
    void import('qrcode')
      .then(({ toDataURL }) => toDataURL(enrolment.uri, { margin: 1, width: 200 }))
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        // The setup key underneath is a complete fallback, so a failed render is silent.
      });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError(0, { code: 'bad_request', message: 'That did not work. Try again.' }),
      );
    } finally {
      setBusy(false);
    }
  }

  const begin = () =>
    run(async () => {
      setEnrolment(await endpoints.beginTotpEnrolment());
    });

  const confirm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get('code') ?? '').trim();
    return run(async () => {
      const body = await endpoints.confirmTotpEnrolment({ code });
      setCodes(body.recoveryCodes);
      setEnrolment(null);
      await refresh();
    });
  };

  const disable = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    return run(async () => {
      await endpoints.disableTotp({
        password: String(data.get('password') ?? ''),
        code: String(data.get('code') ?? '').trim(),
      });
      setCodes(null);
      await refresh();
    });
  };

  return (
    <Card>
      <CardTitle action={enabled ? <Pill tone="var(--color-gain)">On</Pill> : <Pill>Off</Pill>}>
        Two-factor authentication
      </CardTitle>
      <p className="mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
        A six-digit code from an authenticator app, asked for at every sign-in. It is also what a
        password reset link demands before it will do anything — so somebody who reaches your
        mailbox still cannot reach this.
      </p>

      {error !== null && <ErrorNotice message={error.message} />}

      {codes !== null && (
        <div
          className="mb-3 rounded-xl p-3"
          style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
        >
          <p className="text-sm font-medium">Save these recovery codes now</p>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            Each one signs you in once, if the authenticator app is lost. They are shown here once
            and cannot be shown again — print them, or put them somewhere an heir can find.
          </p>
          <ul className="tabular mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {codes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void navigator.clipboard.writeText(codes.join('\n'))}>
              Copy
            </Button>
            <Button variant="ghost" onClick={() => setCodes(null)}>
              I have saved them
            </Button>
          </div>
        </div>
      )}

      {!enabled && enrolment === null && (
        <Button variant="primary" disabled={busy} onClick={() => void begin()}>
          {busy ? 'Starting…' : 'Turn on'}
        </Button>
      )}

      {!enabled && enrolment !== null && (
        <div className="space-y-3">
          <p className="text-sm">
            Scan this with Google Authenticator, Aegis, 1Password — anything that does TOTP.
          </p>
          {qr !== null && (
            <img
              src={qr}
              alt="QR code for your authenticator app"
              className="rounded-lg"
              style={{ background: 'oklch(0.99 0 0)', padding: '0.5rem' }}
              width={200}
              height={200}
            />
          )}
          <div>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Or type this setup key in by hand:
            </p>
            <p className="tabular mt-1 text-sm font-medium break-all">{enrolment.secret}</p>
          </div>
          <form
            onSubmit={(event) => void confirm(event)}
            className="flex flex-wrap items-end gap-3"
          >
            <Field label="Code from the app" hint="Six digits">
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" required />
            </Field>
            <div className="pb-0.5">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? 'Checking…' : 'Confirm'}
              </Button>
            </div>
            <div className="pb-0.5">
              <Button variant="ghost" onClick={() => setEnrolment(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      {enabled && (
        <div className="space-y-3">
          {remaining !== null && (
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {remaining} recovery {remaining === 1 ? 'code' : 'codes'} left.
            </p>
          )}
          <form
            onSubmit={(event) => void disable(event)}
            className="flex flex-wrap items-end gap-3"
          >
            <Field label="Password">
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            <Field label="Code" hint="From the app, or a recovery code">
              <Input name="code" autoComplete="one-time-code" required />
            </Field>
            <div className="pb-0.5">
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? 'Turning off…' : 'Turn off'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </Card>
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
