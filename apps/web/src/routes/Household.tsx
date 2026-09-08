/**
 * Household — partner merge by mutual, revocable consent.
 *
 * The one control on this page that matters is the share-mode toggle: it is entirely
 * separate from joining. A partner can be part of a household and still share nothing, and
 * flipping the toggle to `none` takes effect on the next request anywhere else in the app —
 * there is nothing else to do and nothing to wait for.
 */

import { useCallback, useEffect, useState } from 'react';
import type { HouseholdMemberRecord, HouseholdRecord, ShareMode } from '@networth/shared';
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

const SHARE_LABELS: Record<ShareMode, string> = {
  full: 'Everything, in detail',
  summary: 'Totals and allocation only',
  none: 'Nothing',
};

const SHARE_HINTS: Record<ShareMode, string> = {
  full: 'The rest of the household sees every one of your assets, with its detail.',
  summary: 'The rest of the household sees your totals and allocation, not individual assets.',
  none: 'The rest of the household sees nothing of yours. You still see what they share with you.',
};

export function Household() {
  const { user } = useSession();
  const [households, setHouseholds] = useState<HouseholdRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await endpoints.households();
      setHouseholds(response.households);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your household.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (households === null || user === null) {
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
        title="Household"
        subtitle="Merge net worth with a partner — opt-in on both sides, revocable on either."
        action={
          households.length === 0 && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Start a household
            </Button>
          )
        }
      />

      {creating && (
        <CreateHouseholdForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {households.length === 0 ? (
        <EmptyState
          title="No household yet"
          description="Starting one does not share anything by itself. You invite a partner, they accept, and each of you separately decides how much of your own data the other sees."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Start a household
            </Button>
          }
        />
      ) : (
        households.map((household) => (
          <HouseholdCard
            key={household.id}
            household={household}
            currentUserId={user.id}
            onChanged={() => void load()}
          />
        ))
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One household                                                             */
/* -------------------------------------------------------------------------- */

function HouseholdCard({
  household,
  currentUserId,
  onChanged,
}: {
  household: HouseholdRecord;
  currentUserId: string;
  onChanged: () => void;
}) {
  const me = household.members.find((member) => member.userId === currentUserId);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <Card as="article">
      <CardTitle
        action={
          me?.role === 'owner' && (
            <Button disabled={busy} onClick={() => setInviting(!inviting)}>
              {inviting ? 'Close' : 'Invite a partner'}
            </Button>
          )
        }
      >
        {household.name}
      </CardTitle>

      {inviting && (
        <InviteForm
          householdId={household.id}
          onClose={() => setInviting(false)}
          onInvited={() => {
            setInviting(false);
            onChanged();
          }}
        />
      )}

      <div className="mt-3 space-y-3">
        {household.members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            household={household}
            isSelf={member.userId === currentUserId}
            canRemove={me?.role === 'owner' && member.userId !== currentUserId}
            busy={busy}
            onAccept={() => run(() => endpoints.acceptHousehold(household.id))}
            onShareModeChange={(shareMode) =>
              run(() => endpoints.updateShareMode(household.id, { shareMode }))
            }
            onLeaveOrRemove={() => {
              const verb = member.userId === currentUserId ? 'leave' : `remove ${member.name} from`;
              if (!window.confirm(`Do you want to ${verb} this household?`)) return;
              void run(() => endpoints.leaveHousehold(household.id, member.userId));
            }}
          />
        ))}
      </div>

      {error !== null && <ErrorNotice message={error} />}
    </Card>
  );
}

function MemberRow({
  member,
  isSelf,
  canRemove,
  busy,
  onAccept,
  onShareModeChange,
  onLeaveOrRemove,
}: {
  member: HouseholdMemberRecord;
  household: HouseholdRecord;
  isSelf: boolean;
  canRemove: boolean;
  busy: boolean;
  onAccept: () => void;
  onShareModeChange: (shareMode: ShareMode) => void;
  onLeaveOrRemove: () => void;
}) {
  const pending = member.acceptedAt === null;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-3"
      style={{ background: 'var(--surface-sunken)' }}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">
            {member.name}
            {isSelf ? ' (you)' : ''}
          </span>
          <Pill>{member.role}</Pill>
          {pending ? (
            <Pill tone="var(--color-warn)">Invited — not yet accepted</Pill>
          ) : (
            <Pill title={SHARE_HINTS[member.shareMode]}>
              Shares: {SHARE_LABELS[member.shareMode]}
            </Pill>
          )}
        </div>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {member.email}
          {member.acceptedAt !== null && ` · Joined ${formatDate(member.acceptedAt)}`}
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {isSelf && pending && (
          <Button variant="primary" disabled={busy} onClick={onAccept}>
            Accept invitation
          </Button>
        )}

        {isSelf && !pending && (
          <Select
            aria-label="How much of your data this household sees"
            disabled={busy}
            value={member.shareMode}
            onChange={(event) => onShareModeChange(event.target.value as ShareMode)}
          >
            {(Object.keys(SHARE_LABELS) as ShareMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {SHARE_LABELS[mode]}
              </option>
            ))}
          </Select>
        )}

        {(isSelf || canRemove) && (
          <Button variant="danger" disabled={busy} onClick={onLeaveOrRemove}>
            {isSelf ? 'Leave' : 'Remove'}
          </Button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Forms                                                                      */
/* -------------------------------------------------------------------------- */

function CreateHouseholdForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endpoints.createHousehold({ name });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that household.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle
        action={
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        }
      >
        New household
      </CardTitle>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void submit(event)}>
        <div className="min-w-48 flex-1">
          <Field label="Name" hint="Whatever you'll recognise it by — a surname is usual.">
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>
          Create
        </Button>
      </form>
      {error !== null && <ErrorNotice message={error} />}
    </Card>
  );
}

function InviteForm({
  householdId,
  onClose,
  onInvited,
}: {
  householdId: string;
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endpoints.invitePartner(householdId, { email });
      onInvited();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not invite that address.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl p-3" style={{ background: 'var(--surface-sunken)' }}>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void submit(event)}>
        <div className="min-w-48 flex-1">
          <Field
            label="Partner's email"
            hint="They need an account on this instance already — this is not a new-account invite."
          >
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={busy || email.trim() === ''}>
          Invite
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </form>
      {error !== null && <ErrorNotice message={error} />}
    </div>
  );
}
