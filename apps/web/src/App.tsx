/**
 * Routing and the two states the whole application has: signed in, and not.
 *
 * Everything below `RequireSession` can assume a user, which is what keeps every screen
 * free of "if there is no session" branches. While the session is still being resolved
 * neither branch renders — showing a sign-in form for the half-second before `/auth/me`
 * answers would flash a login page at somebody who is already signed in, on every refresh.
 */

import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppShell } from './components/AppShell.js';
import { Skeleton } from './components/ui.js';
import { useSession } from './lib/session.js';
import { Admin } from './routes/Admin.js';
import { AssetDetail } from './routes/AssetDetail.js';
import { AssetForm } from './routes/AssetForm.js';
import { AssetList } from './routes/AssetList.js';
import { ClaimKit } from './routes/ClaimKit.js';
import { Dashboard } from './routes/Dashboard.js';
import { Household } from './routes/Household.js';
import { Inheritance } from './routes/Inheritance.js';
import { Nominees } from './routes/Nominees.js';
import { Performance } from './routes/Performance.js';
import { Planner } from './routes/Planner.js';
import { Settings } from './routes/Settings.js';
import { Vault } from './routes/Vault.js';
import { CheckIn } from './routes/CheckIn.js';
import { ForgotPassword } from './routes/ForgotPassword.js';
import { ResetPassword } from './routes/ResetPassword.js';
import { SignIn } from './routes/SignIn.js';

export function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      {/*
        Public, and outside `RequireSession` for the obvious reason: somebody who could
        satisfy it would not be here. They are also outside `AppShell` — a navigation bar
        full of links to screens you cannot open is not reassuring on the page where you are
        already having trouble getting in.
      */}
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      {/*
        Public for the reason the whole feature exists: the person following this link has
        not opened the app in months, and a sign-in wall is what would make them put it off
        again. The token can only reset their own dead-man clock.
      */}
      <Route path="/check-in" element={<CheckIn />} />
      <Route
        path="*"
        element={
          <RequireSession>
            <AppShell>
              <ScrollToTop />
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/assets" element={<AssetList />} />
                <Route path="/assets/new" element={<AssetForm mode="create" />} />
                <Route path="/assets/:id" element={<AssetDetail />} />
                <Route path="/assets/:id/edit" element={<AssetForm mode="edit" />} />
                <Route path="/performance" element={<Performance />} />
                <Route path="/planner" element={<Planner />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/household" element={<Household />} />
                <Route path="/vault" element={<Vault />} />
                <Route path="/nominees" element={<Nominees />} />
                <Route path="/inheritance" element={<Inheritance />} />
                <Route path="/claim-kit" element={<ClaimKit />} />
                <Route
                  path="/admin"
                  element={
                    <RequireAdmin>
                      <Admin />
                    </RequireAdmin>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </RequireSession>
        }
      />
    </Routes>
  );
}

function RequireSession({ children }: { children: ReactNode }) {
  const { status } = useSession();

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (status === 'anonymous') return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

/**
 * The admin screen, for admins.
 *
 * The server enforces this too — every `/api/admin` route is behind `requireRole('admin')` —
 * so this guard is not the protection. It exists so a member who types the URL gets their
 * dashboard rather than a screen that can only ever answer 403.
 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useSession();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** A route change on a phone should start at the top, not halfway down the last list. */
function ScrollToTop() {
  const { pathname } = useLocation();

  /*
   * The braces are load-bearing. Recent Chrome returns a Promise from `window.scrollTo()`
   * — it resolves when the scroll finishes — so a concise arrow body would hand that
   * Promise to React as the effect's clean-up function. Under StrictMode the clean-up runs
   * immediately, React calls the Promise, and the resulting TypeError takes the whole tree
   * down: a blank page on every signed-in route, because this component only mounts there.
   */
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
