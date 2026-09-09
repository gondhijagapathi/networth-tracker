/**
 * Sign in.
 *
 * Two forms behind one route, because the difference between them is a single field and a
 * new instance needs the second one before it can ever use the first. Registration is
 * invite-only — there is no open signup — and on a brand-new install the bootstrap code
 * from `.env` is the invite.
 */

import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { Button, Field, Input } from '../components/ui.js';

type Mode = 'sign-in' | 'register';

export function SignIn() {
  const { status, bootstrapRequired, login, register } = useSession();
  /**
   * An invite code carried in from the emailed link (`/sign-in?invite=…`).
   *
   * The code in the mail is twenty characters in four groups, and it is retyped on a phone
   * by somebody who has never used this application. Filling it in for them costs nothing
   * and removes the only genuinely fiddly step in registering.
   */
  const [params] = useSearchParams();
  const invitedCode = params.get('invite');
  /**
   * Which form to show, and why it is derived rather than initialised.
   *
   * A fresh instance has nobody to sign in as, so it must open on registration — but
   * `bootstrapRequired` is the answer to an asynchronous request, and on the first render it
   * is still `false`. Seeding `useState` from it therefore froze the page on the sign-in
   * form for the one visitor who cannot possibly use it, under a paragraph telling them to
   * enter the bootstrap invite code, with no field to enter it into.
   *
   * So `chosen` holds only what the person explicitly picked, and the default follows the
   * server's answer whenever they have not picked anything.
   */
  const [chosen, setChosen] = useState<Mode | null>(null);
  // An arriving invite code is as strong a signal as the bootstrap flag: whoever followed
  // that link has no account yet, whatever else is true of the instance.
  const mode: Mode = chosen ?? (bootstrapRequired || invitedCode !== null ? 'register' : 'sign-in');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  /** The server answers `totp_required` rather than failing, so the field appears on demand. */
  const [totpRequired, setTotpRequired] = useState(false);

  if (status === 'authenticated') return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);

    try {
      if (mode === 'register') {
        await register({
          inviteCode: String(form.get('inviteCode') ?? ''),
          email: String(form.get('email') ?? ''),
          name: String(form.get('name') ?? ''),
          password: String(form.get('password') ?? ''),
        });
      } else {
        const totp = String(form.get('totp') ?? '').trim();
        await login({
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
          ...(totp === '' ? {} : { totp }),
        });
      }
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      // Not a failure: the password was right and the second factor is now wanted.
      if (caught.code === 'totp_required') setTotpRequired(true);
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const registering = mode === 'register';

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Net Worth</h1>
      <p className="mt-1 mb-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
        {bootstrapRequired
          ? 'Nobody has registered on this instance yet. Use the bootstrap invite code from your .env file.'
          : registering
            ? 'Registration is invite-only. You will need a code from an administrator.'
            : 'Sign in to your household.'}
      </p>

      <form onSubmit={(event) => void submit(event)} className="surface-card space-y-4 p-5">
        {registering && (
          <Field label="Invite code" error={error?.fieldError('inviteCode')}>
            <Input
              name="inviteCode"
              required
              autoComplete="off"
              spellCheck={false}
              defaultValue={invitedCode ?? ''}
            />
          </Field>
        )}

        {registering && (
          <Field label="Your name" error={error?.fieldError('name')}>
            <Input name="name" required autoComplete="name" />
          </Field>
        )}

        <Field label="Email" error={error?.fieldError('email')}>
          <Input name="email" type="email" required autoComplete="username" />
        </Field>

        <Field
          label="Password"
          hint={registering ? 'At least twelve characters. Long beats complicated.' : undefined}
          error={error?.fieldError('password')}
        >
          <Input
            name="password"
            type="password"
            required
            autoComplete={registering ? 'new-password' : 'current-password'}
          />
        </Field>

        {totpRequired && !registering && (
          <Field
            label="Authentication code"
            hint="Six digits from your authenticator app, or a recovery code."
          >
            <Input name="totp" inputMode="text" autoComplete="one-time-code" autoFocus />
          </Field>
        )}

        {error !== null && error.code !== 'totp_required' && (
          <p className="text-sm" role="alert" style={{ color: 'var(--color-loss)' }}>
            {error.message}
          </p>
        )}

        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'One moment…' : registering ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      <div className="mt-4 flex flex-col items-center gap-2">
        <button
          type="button"
          className="text-sm underline underline-offset-4"
          style={{ color: 'var(--text-secondary)' }}
          onClick={() => {
            setChosen(registering ? 'sign-in' : 'register');
            setError(null);
            setTotpRequired(false);
          }}
        >
          {registering ? 'I already have an account' : 'I have an invite code'}
        </button>

        {!registering && (
          <Link
            to="/forgot-password"
            className="text-sm underline underline-offset-4"
            style={{ color: 'var(--text-secondary)' }}
          >
            Forgotten your password?
          </Link>
        )}
      </div>
    </div>
  );
}
