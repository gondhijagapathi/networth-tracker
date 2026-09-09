/**
 * "I cannot get in."
 *
 * The screen is almost entirely about what it does *not* say. The server answers every
 * request identically whether or not the address has an account, and this page has to keep
 * that promise on its side: one confirmation, the same words every time, shown even when
 * nothing was sent. A form that said "no account with that email" — or that simply took
 * visibly longer for a real one — would hand an attacker the household's membership list,
 * which is exactly the list worth having before targeting anyone.
 *
 * So the confirmation is deliberately worded as a conditional ("if there is an account")
 * rather than as a report of something that happened.
 */

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api.js';
import { endpoints } from '../lib/endpoints.js';
import { Button, Field, Input } from '../components/ui.js';

export function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '');
    setBusy(true);
    setError(null);

    try {
      await endpoints.forgotPassword({ email });
      setSent(true);
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      // The only failure that reaches here is the rate limiter or an unreachable API.
      // Neither says anything about whether the address exists.
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>

      {sent ? (
        <div className="surface-card mt-6 space-y-3 p-5">
          <p className="text-sm">
            If there is an account for that address, a reset link is on its way. It works once and
            expires in an hour.
          </p>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Nothing arrived? Check the spam folder. If this installation has no mail server
            configured, no email can be sent at all — ask whoever administers it.
          </p>
          <Link to="/sign-in" className="btn btn-secondary w-full">
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-1 mb-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
            We will email you a link. Your vault passphrase is a separate secret and is not affected
            — this server has never seen it and cannot reset it.
          </p>

          <form onSubmit={(event) => void submit(event)} className="surface-card space-y-4 p-5">
            <Field label="Email" error={error?.fieldError('email')}>
              <Input name="email" type="email" required autoComplete="username" autoFocus />
            </Field>

            {error !== null && (
              <p className="text-sm" role="alert" style={{ color: 'var(--color-loss)' }}>
                {error.message}
              </p>
            )}

            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? 'One moment…' : 'Email me a link'}
            </Button>
          </form>

          <Link
            to="/sign-in"
            className="mt-4 self-center text-sm underline underline-offset-4"
            style={{ color: 'var(--text-secondary)' }}
          >
            Back to sign in
          </Link>
        </>
      )}
    </div>
  );
}
