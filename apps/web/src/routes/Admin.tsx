/**
 * Administration — who may sign in.
 *
 * Note what this screen deliberately is not: a view of anybody's money. Admin here is an
 * operational role, and `routes/admin.ts` on the server has no endpoint that reads another
 * household's assets — so there is nothing to render even if somebody wanted it. An admin
 * who wants to see a partner's net worth asks them for a household invite like anyone else.
 *
 * Two panels for the two questions an operator actually has: who is waiting for an account,
 * and who has one.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ROLES,
  type CreateInviteBody,
  type InviteSummary,
  type PublicUser,
  type Role,
} from '@networth/shared';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Pill,
  Select,
  Skeleton,
} from '../components/ui.js';
import { endpoints } from '../lib/endpoints.js';
import { formatDate } from '../lib/format.js';
import { useSession } from '../lib/session.js';

const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  member: 'Member',
  nominee: 'Nominee',
};

const ROLE_HINTS: Record<Role, string> = {
  admin: 'Can invite, suspend and change roles — and cannot see anyone else’s assets.',
  member: 'An ordinary account: their own assets, their own vault.',
  nominee: 'Read-only. Sees only the estates they have been named in.',
};

export function Admin() {
  const { user } = useSession();
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [userResponse, inviteResponse] = await Promise.all([
        endpoints.adminUsers(),
        endpoints.adminInvites(),
      ]);
      setUsers(userResponse.users);
      setInvites(inviteResponse.invites);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load administration.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (users === null || invites === null || user === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Administration"
        subtitle="Who may sign in. Nothing on this page reads anyone’s assets."
      />

      <InvitesCard invites={invites} onChanged={() => void load()} />
      <PeopleCard users={users} currentUserId={user.id} onChanged={() => void load()} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Invites                                                                    */
/* -------------------------------------------------------------------------- */

function InvitesCard({ invites, onChanged }: { invites: InviteSummary[]; onChanged: () => void }) {
  const [issuing, setIssuing] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = invites.filter((invite) => statusOf(invite) === 'Waiting');

  async function revoke(invite: InviteSummary) {
    if (!window.confirm('Withdraw this invite? The code stops working immediately.')) return;
    setBusy(true);
    setError(null);
    try {
      await endpoints.revokeInvite(invite.id);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not withdraw that invite.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle
        action={
          <Button variant="primary" onClick={() => setIssuing(!issuing)}>
            {issuing ? 'Close' : 'Issue invite'}
          </Button>
        }
      >
        Invites ({open.length} waiting)
      </CardTitle>

      {issuing && (
        <InviteForm
          onIssued={(issued) => {
            setCode(issued);
            setIssuing(false);
            onChanged();
          }}
        />
      )}

      {code !== null && (
        <div
          className="mt-3 rounded-xl p-3 text-sm"
          style={{ background: 'var(--surface-sunken)' }}
        >
          <p className="font-medium">Invite code — shown once</p>
          <p className="mt-1 font-mono text-base tracking-wide">{code}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Only its hash is stored, so this cannot be shown again. If it is lost, withdraw the
            invite and issue another.
          </p>
          <Button className="mt-2" onClick={() => setCode(null)}>
            Done
          </Button>
        </div>
      )}

      {invites.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          No invites yet. An invite code is the only way an account comes into existence here —
          there is no open signup.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {invites.map((invite) => (
            <li
              key={invite.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-3"
              style={{ background: 'var(--surface-sunken)' }}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {invite.email ?? 'Any address'}
                  </span>
                  <Pill title={ROLE_HINTS[invite.role]}>{ROLE_LABELS[invite.role]}</Pill>
                  <Pill tone={toneForInvite(invite)}>{statusOf(invite)}</Pill>
                </div>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  Issued {formatDate(invite.createdAt)} · expires {formatDate(invite.expiresAt)}
                  {invite.note !== null && ` · ${invite.note}`}
                </p>
              </div>

              {statusOf(invite) === 'Waiting' && (
                <Button variant="danger" disabled={busy} onClick={() => void revoke(invite)}>
                  Withdraw
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error !== null && <ErrorNotice message={error} />}
    </Card>
  );
}

function InviteForm({ onIssued }: { onIssued: (code: string) => void }) {
  const [form, setForm] = useState<CreateInviteBody>({ role: 'member', expiresInDays: 7 });
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.createInvite({
        ...form,
        ...(email.trim() === '' ? {} : { email: email.trim() }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      onIssued(result.code);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not issue that invite.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-3 grid gap-3 rounded-xl p-3 sm:grid-cols-2"
      style={{ background: 'var(--surface-sunken)' }}
      onSubmit={(event) => void submit(event)}
    >
      <Field
        label="Email"
        hint="Optional. A code bound to an address can only create that account."
      >
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </Field>

      <Field label="Role" hint={ROLE_HINTS[form.role]}>
        <Select
          value={form.role}
          onChange={(event) => setForm({ ...form, role: event.target.value as Role })}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Valid for, in days" hint="One to ninety.">
        <Input
          type="number"
          min={1}
          max={90}
          value={form.expiresInDays}
          onChange={(event) => setForm({ ...form, expiresInDays: Number(event.target.value) })}
        />
      </Field>

      <Field label="Note" hint="For your own records — who this was for.">
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
      </Field>

      {error !== null && (
        <div className="sm:col-span-2">
          <ErrorNotice message={error} />
        </div>
      )}

      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" disabled={busy}>
          Issue invite
        </Button>
      </div>
    </form>
  );
}

type InviteStatus = 'Waiting' | 'Used' | 'Expired';

function statusOf(invite: InviteSummary): InviteStatus {
  if (invite.consumedAt !== null) return 'Used';
  if (Date.parse(invite.expiresAt) <= Date.now()) return 'Expired';
  return 'Waiting';
}

function toneForInvite(invite: InviteSummary): string | undefined {
  return statusOf(invite) === 'Expired' ? 'var(--color-warn)' : undefined;
}

/* -------------------------------------------------------------------------- */
/* People                                                                     */
/* -------------------------------------------------------------------------- */

function PeopleCard({
  users,
  currentUserId,
  onChanged,
}: {
  users: PublicUser[];
  currentUserId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The server refuses to leave an instance with no way back in — the last active admin can
   * be neither demoted nor suspended. Counting them here lets the control be disabled with a
   * reason rather than offered and then rejected.
   */
  const activeAdmins = users.filter(
    (account) => account.role === 'admin' && account.status === 'active',
  ).length;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>People ({users.length})</CardTitle>

      {users.length === 0 ? (
        <EmptyState title="Nobody yet" description="Issue an invite to create the first account." />
      ) : (
        <ul className="space-y-2">
          {users.map((account) => {
            const isSelf = account.id === currentUserId;
            const lastAdmin =
              account.role === 'admin' && account.status === 'active' && activeAdmins === 1;
            const suspended = account.status === 'suspended';

            const roleLocked = isSelf && account.role === 'admin';
            const suspendLocked = isSelf || lastAdmin;

            return (
              <li
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-3"
                style={{ background: 'var(--surface-sunken)' }}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">
                      {account.name}
                      {isSelf ? ' (you)' : ''}
                    </span>
                    {suspended && <Pill tone="var(--color-warn)">Suspended</Pill>}
                    {account.totpEnabled && (
                      <Pill title="Two-factor authentication enabled">2FA</Pill>
                    )}
                    {lastAdmin && <Pill title="The only active admin">Only admin</Pill>}
                  </div>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                    {account.email} · joined {formatDate(account.createdAt)}
                    {account.lastActiveAt !== null &&
                      ` · last seen ${formatDate(account.lastActiveAt)}`}
                  </p>
                </div>

                {/* No `shrink-0`: three controls do not fit beside a name at 375px, and
                    the page body must never scroll sideways. They wrap instead. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={`Role for ${account.name}`}
                    className="w-auto"
                    disabled={busy || roleLocked || lastAdmin}
                    title={
                      roleLocked
                        ? 'You cannot remove your own admin role'
                        : lastAdmin
                          ? 'Promote someone else before changing this'
                          : ROLE_HINTS[account.role]
                    }
                    value={account.role}
                    onChange={(event) =>
                      void run(() =>
                        endpoints.updateUser(account.id, { role: event.target.value as Role }),
                      )
                    }
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </Select>

                  <Button
                    disabled={busy || (suspendLocked && !suspended)}
                    title={
                      isSelf
                        ? 'You cannot suspend your own account'
                        : lastAdmin
                          ? 'The last active admin cannot be suspended'
                          : undefined
                    }
                    onClick={() =>
                      void run(() =>
                        endpoints.updateUser(account.id, {
                          status: suspended ? 'active' : 'suspended',
                        }),
                      )
                    }
                  >
                    {suspended ? 'Reactivate' : 'Suspend'}
                  </Button>

                  <Button
                    variant="danger"
                    disabled={busy}
                    title="Sign this account out of every device"
                    onClick={() => {
                      const who = isSelf ? 'yourself' : account.name;
                      if (!window.confirm(`Sign ${who} out of every device?`)) return;
                      void run(() => endpoints.revokeUserSessions(account.id));
                    }}
                  >
                    Revoke sessions
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Suspension takes effect on the account’s very next request: the role and status are re-read
        per request rather than trusted from the token they signed in with.
      </p>

      {error !== null && <ErrorNotice message={error} />}
    </Card>
  );
}
