/**
 * Who is signed in.
 *
 * The session lives in a cookie the browser will not let this code read, so "am I signed
 * in" is a question only the server can answer. This provider asks it once on boot and
 * keeps the answer; every route below it can read `user` synchronously.
 *
 * There is deliberately no persistence here. A cached user in `localStorage` would survive
 * a revoked session and show a signed-in shell to somebody an admin has just suspended.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoginBody, PublicUser, RegisterBody } from '@networth/shared';
import { ApiError, api } from './api.js';

/**
 * `loading` is a real state, not an implementation detail: rendering the sign-in page for
 * the half-second before `/auth/me` answers would flash a login form at somebody who is
 * already signed in, on every refresh.
 */
export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

interface SessionValue {
  status: SessionStatus;
  user: PublicUser | null;
  /** True on a brand-new instance with no accounts yet: registration, not sign-in. */
  bootstrapRequired: boolean;
  login: (body: LoginBody) => Promise<void>;
  register: (body: RegisterBody) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const body = await api.get<{ user: PublicUser }>('/auth/me');
        if (!cancelled) {
          setUser(body.user);
          setStatus('authenticated');
        }
      } catch {
        // Not signed in is the ordinary case, not an error worth surfacing.
        if (cancelled) return;
        setStatus('anonymous');
        try {
          const body = await api.get<{ bootstrapRequired: boolean }>('/auth/bootstrap');
          if (!cancelled) setBootstrapRequired(body.bootstrapRequired);
        } catch {
          // The API is unreachable. The sign-in page will say so when it is used.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (body: LoginBody) => {
    const result = await api.post<{ user: PublicUser }>('/auth/login', body);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (body: RegisterBody) => {
    const result = await api.post<{ user: PublicUser }>('/auth/register', body);
    setUser(result.user);
    setStatus('authenticated');
    setBootstrapRequired(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      // The cookies are cleared server-side even when the token no longer matches, and a
      // failed sign-out must still sign the user out of this tab.
      if (!(error instanceof ApiError)) throw error;
    }
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ status, user, bootstrapRequired, login, register, logout }),
    [status, user, bootstrapRequired, login, register, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
