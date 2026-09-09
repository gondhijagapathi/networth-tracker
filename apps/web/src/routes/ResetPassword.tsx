/**
 * Where the emailed link lands.
 *
 * The page checks the token before it draws anything, which is worth the extra round trip:
 * somebody who followed a link from last week should be told so immediately, not after
 * choosing a password, typing it twice and pressing a button. The same check reports
 * whether the account has a second factor, so that field is present from the start rather
 * than appearing after a submission that looked like a failure.
 *
 * Finishing does *not* sign you in. The server declines to, on purpose — proving control of
 * a mailbox is not proving you know the password you just chose — so this ends at the sign-in
 * form with the new credential, which is also the last chance for the second factor to do
 * its job.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@networth/shared';
import { ApiError } from '../lib/api.js';
import { endpoints } from '../lib/endpoints.js';
import { Button, Field, Input, Skeleton } from '../components/ui.js';

type Check = { state: 'checking' } | { state: 'invalid' } | { state: 'ready'; totp: boolean };

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [check, setCheck] = useState<Check>({ state: 'checking' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      if (token === '') {
        setCheck({ state: 'invalid' });
        return;
      }
      try {
        const result = await endpoints.checkResetToken(token, controller.signal);
        setCheck(
          result.valid ? { state: 'ready', totp: result.totpRequired } : { state: 'invalid' },
        );
      } catch {
        // An unreachable API is not a dead link, but there is nothing useful to do with the
        // difference here: either way there is no form worth showing yet.
        if (!controller.signal.aborted) setCheck({ state: 'invalid' });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const totp = String(form.get('totp') ?? '').trim();

    setBusy(true);
    setError(null);

    try {
      await endpoints.resetPassword({
        token,
        password: String(form.get('password') ?? ''),
        ...(totp === '' ? {} : { totp }),
      });
      setDone(true);
      // A moment on the confirmation, then the sign-in form. Redirecting instantly would
      // look like the button had failed.
      setTimeout(() => void navigate('/sign-in', { replace: true }), 2500);
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      // The account has a second factor after all — the check said so, or the server is
      // saying so now. Either way the field belongs on screen.
      if (caught.code === 'totp_required') setCheck({ state: 'ready', totp: true });
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>

      {check.state === 'checking' && <Skeleton className="mt-6 h-48" />}

      {check.state === 'invalid' && (
        <div className="surface-card mt-6 space-y-3 p-5">
          <p className="text-sm">
            That link is not valid any more. Reset links expire an hour after they are sent and can
            only be used once.
          </p>
          <Link to="/forgot-password" className="btn btn-primary w-full">
            Send a new link
          </Link>
        </div>
      )}

      {check.state === 'ready' && done && (
        <div className="surface-card mt-6 space-y-3 p-5">
          <p className="text-sm">
            Your password has been changed, and every device that was signed in has been signed out.
            Sign in with the new one.
          </p>
          <Link to="/sign-in" className="btn btn-primary w-full">
            Sign in
          </Link>
        </div>
      )}

      {check.state === 'ready' && !done && (
        <>
          <p className="mt-1 mb-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
            This signs you out everywhere. Your vault passphrase is separate and is not changed by
            this.
          </p>

          <form onSubmit={(event) => void submit(event)} className="surface-card space-y-4 p-5">
            <Field
              label="New password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters. Long beats complicated.`}
              error={error?.fieldError('password')}
            >
              <Input
                name="password"
                type="password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                autoComplete="new-password"
                autoFocus
              />
            </Field>

            {check.totp && (
              <Field
                label="Authentication code"
                hint="Six digits from your authenticator app, or a recovery code."
                error={error?.fieldError('totp')}
              >
                <Input name="totp" inputMode="text" autoComplete="one-time-code" required />
              </Field>
            )}

            {error !== null && error.fieldError('password') === undefined && (
              <p className="text-sm" role="alert" style={{ color: 'var(--color-loss)' }}>
                {error.message}
              </p>
            )}

            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? 'One moment…' : 'Set new password'}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
