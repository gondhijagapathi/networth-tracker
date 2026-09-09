/**
 * Where the "still there?" link lands.
 *
 * The only screen in this application that does something meaningful for somebody with no
 * session. It exists so that answering a dead-man warning does not require remembering a
 * password — the person being asked is, by construction, somebody who has not opened this
 * app in months, and a login form is exactly the wall that makes them put it off again.
 *
 * **The button is not decoration.** Arriving here changes nothing; pressing it is what
 * resets the clock. Mail providers and security appliances fetch links before a human sees
 * them, and a page that checked you in on load would let a scanner keep a dead owner's
 * switch alive indefinitely. So the landing is a read and the confirmation is a write, and
 * the copy says so plainly rather than making the extra click feel like a mistake.
 */

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CheckInPrompt } from '@networth/shared';
import { ApiError, api } from '../lib/api.js';
import { Button, Skeleton } from '../components/ui.js';

export function CheckIn() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [prompt, setPrompt] = useState<CheckInPrompt | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      if (token === '') {
        setPrompt({
          valid: false,
          name: null,
          stage: null,
          daysUntilRelease: null,
          alreadyFired: false,
        });
        return;
      }
      try {
        setPrompt(
          await api.get<CheckInPrompt>(
            `/check-in?token=${encodeURIComponent(token)}`,
            controller.signal,
          ),
        );
      } catch {
        if (!controller.signal.aborted) {
          setPrompt({
            valid: false,
            name: null,
            stage: null,
            daysUntilRelease: null,
            alreadyFired: false,
          });
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [token]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.post<unknown>('/check-in', { token });
      setDone(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not reach the server. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Still there?</h1>

      {prompt === null && <Skeleton className="mt-6 h-48" />}

      {prompt !== null && !prompt.valid && (
        <div className="surface-card mt-6 space-y-3 p-5">
          <p className="text-sm">
            That check-in link is no longer valid. Links work once and expire after 30 days.
          </p>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Signing in resets the clock just the same — that is all a check-in ever does.
          </p>
          <Link to="/sign-in" className="btn btn-primary w-full">
            Sign in instead
          </Link>
        </div>
      )}

      {prompt?.valid && done && (
        <div className="surface-card mt-6 space-y-3 p-5">
          <p className="text-sm">
            Noted — your dead-man switch has been reset. Nothing will be released, and the countdown
            starts again from today.
          </p>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            You can close this page. There is nothing else to do.
          </p>
          <Link to="/sign-in" className="btn btn-secondary w-full">
            Sign in, if you want to look around
          </Link>
        </div>
      )}

      {prompt?.valid && !done && (
        <>
          <p className="mt-1 mb-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {prompt.name === null ? 'This account' : prompt.name}
            {prompt.alreadyFired
              ? ' — this switch has already released its keys. Confirming still resets the clock, but it cannot take that back.'
              : prompt.daysUntilRelease !== null
                ? ` — your vault keys are released to your nominees in ${prompt.daysUntilRelease} days unless you confirm.`
                : ' has been quiet long enough that your dead-man switch started warning you.'}
          </p>

          <div className="surface-card space-y-4 p-5">
            <p className="text-sm">
              Press the button and the countdown starts again. No password needed, and this page can
              do nothing else — it cannot see your assets or sign you in.
            </p>

            {error !== null && (
              <p className="text-sm" role="alert" style={{ color: 'var(--color-loss)' }}>
                {error}
              </p>
            )}

            <Button
              type="button"
              variant="primary"
              className="w-full"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? 'One moment…' : 'Yes — I am still here'}
            </Button>
          </div>

          {/*
            Said out loud because the extra click looks like a nuisance and is not one. A
            person who understands why it is here is a person who will not go looking for a
            "one-click" version.
          */}
          <p className="mt-4 text-xs" style={{ color: 'var(--text-muted)' }}>
            Why a button rather than just the link? Mail providers open links automatically to scan
            them. If arriving here were enough, a scanner would answer for you — including after you
            were no longer able to.
          </p>
        </>
      )}
    </div>
  );
}
