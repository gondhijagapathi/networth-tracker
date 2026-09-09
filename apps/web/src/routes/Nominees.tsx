/**
 * Nominees and the dead-man switch — the owner's side of inheritance.
 *
 * The page is arranged around one question a person can answer in ten seconds: *if I died
 * tomorrow, could they get to it?* Everything else is subordinate to that. A nominee who has
 * accepted but has no escrow is the dangerous middle state — it looks arranged and is not —
 * so it is called out rather than shown as a neutral row.
 *
 * Sealing an escrow needs the vault open, because the data key only exists in memory while
 * it is. That is not a limitation to apologise for; it is the reason the server cannot do
 * this on the owner's behalf.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DEAD_MAN_STAGE_LABELS,
  NOMINEE_ACCESS_LEVELS,
  publicKeyFingerprint,
  type CreateNomineeBody,
  type DeadManStatus,
  type NomineeAccessLevel,
  type NomineeRecord,
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
import { useVault } from '../lib/vault.js';

const ACCESS_LABELS: Record<NomineeAccessLevel, string> = {
  summary: 'Totals only',
  full: 'Every asset, in detail',
  vault: 'Everything, including the vault',
};

const ACCESS_HINTS: Record<NomineeAccessLevel, string> = {
  summary: 'They see what the estate is worth and how it is spread, and no account numbers.',
  full: 'They see every asset and its details, and can print a claim kit.',
  vault: 'As above, plus the vault — but only after you release it, or the switch fires.',
};

export function Nominees() {
  const [nominees, setNominees] = useState<NomineeRecord[] | null>(null);
  const [deadman, setDeadman] = useState<DeadManStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nomineeResponse, deadmanResponse] = await Promise.all([
        endpoints.nominees(),
        endpoints.deadman(),
      ]);
      setNominees(nomineeResponse.nominees);
      setDeadman(deadmanResponse.deadman);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your nominees.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) return <ErrorNotice message={error} onRetry={() => void load()} />;
  if (nominees === null || deadman === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const live = nominees.filter((nominee) => nominee.status !== 'revoked');

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nominees"
        subtitle="Who inherits this, what they can see, and when they get the keys."
        action={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add nominee
          </Button>
        }
      />

      <DeadManCard status={deadman} onChanged={() => void load()} />

      {adding && (
        <NomineeForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {live.length === 0 ? (
        <EmptyState
          title="Nobody is named yet"
          description="A nominee is the person who will have to claim all of this. Naming them here is what makes the claim kit and the vault handover possible."
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add the first nominee
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {live.map((nominee) => (
            <NomineeCard key={nominee.id} nominee={nominee} onChanged={() => void load()} />
          ))}
        </div>
      )}

      <Card>
        <CardTitle>What your nominee has to do</CardTitle>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          The claim kit lists, per institution, the forms and documents an heir actually needs —
          bank Form DA-1, LIC 3783, EPF Form 20, demat transmission annexures.{' '}
          <Link to="/claim-kit" className="underline">
            Preview and print it
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One nominee                                                                */
/* -------------------------------------------------------------------------- */

function NomineeCard({ nominee, onChanged }: { nominee: NomineeRecord; onChanged: () => void }) {
  const vault = useVault();
  /** The one-time code, and whether the nominee was also emailed it. */
  const [issued, setIssued] = useState<{ code: string; emailQueued: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const escrow = nominee.escrow;
  const wantsVault = nominee.accessLevel === 'vault';

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

  /**
   * Wrap the data key to this nominee's public key.
   *
   * The fingerprint is computed here from the key the server returned and checked again on
   * the server against the key it holds. Both sides agreeing is what stops a compromised
   * client substituting a public key of its own for the owner to wrap to.
   */
  async function seal() {
    const { publicKeyJwk } = await endpoints.nomineePublicKey(nominee.id);
    await endpoints.sealEscrow(nominee.id, {
      wrappedDek: await vault.wrapForNominee(publicKeyJwk),
      publicKeyFingerprint: await publicKeyFingerprint(publicKeyJwk),
    });
  }

  return (
    <Card as="article">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{nominee.name}</h3>
            {nominee.relation !== null && <Pill>{nominee.relation}</Pill>}
            <Pill>{ACCESS_LABELS[nominee.accessLevel]}</Pill>
          </div>
          <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {nominee.email ?? 'No email — they cannot be given an account'}
          </p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {statusLine(nominee)}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {nominee.status === 'invited' && nominee.email !== null && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await endpoints.inviteNominee(nominee.id);
                  setIssued({ code: result.code, emailQueued: result.emailQueued });
                })
              }
            >
              {nominee.invitedAt === null ? 'Invite' : 'Re-invite'}
            </Button>
          )}

          {wantsVault && nominee.hasPublicKey && escrow?.state !== 'released' && (
            <Button
              disabled={busy || vault.state !== 'unlocked'}
              title={vault.state === 'unlocked' ? undefined : 'Unlock your vault first'}
              onClick={() => void run(seal)}
            >
              {escrow === null ? 'Seal vault key' : 'Re-seal'}
            </Button>
          )}

          {escrow?.state === 'sealed' && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Release your vault to ${nominee.name} now? They will be able to read every secret in it, immediately and permanently.`,
                  )
                ) {
                  return;
                }
                void run(() => endpoints.releaseEscrow(nominee.id));
              }}
            >
              Release now
            </Button>
          )}

          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Revoke ${nominee.name}'s access?`)) return;
              void run(() => endpoints.revokeNominee(nominee.id));
            }}
          >
            Revoke
          </Button>
        </div>
      </div>

      {issued !== null && (
        <div
          className="mt-3 rounded-xl p-3 text-sm"
          style={{ background: 'var(--surface-sunken)' }}
        >
          <p className="font-medium">Invite code — shown once</p>
          <p className="mt-1 font-mono text-base tracking-wide">{issued.code}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {issued.emailQueued
              ? `Emailed to ${nominee.name} with an explanation of why they are receiving it.`
              : `Give this to ${nominee.name} yourself — this instance has no mail server configured.`}{' '}
            It is not stored anywhere and cannot be shown again; if it is lost, issue a new one.
          </p>
        </div>
      )}

      {wantsVault && nominee.status === 'accepted' && !nominee.hasPublicKey && (
        <Warning>
          {nominee.name} has an account but has not set up their own vault yet. Until they do, there
          is no key to wrap yours to.
        </Warning>
      )}

      {wantsVault && nominee.hasPublicKey && escrow === null && (
        <Warning>
          No vault key is sealed for {nominee.name}. They would inherit the list of what you own and
          none of the credentials needed to claim it.
        </Warning>
      )}

      {escrow?.state === 'released' && (
        <Warning>
          Released {formatDate(escrow.releasedAt)}
          {escrow.releaseReason === 'deadman' ? ' by the dead-man switch' : ''}. Revoking now stops
          further access through this app, but a key that has been handed over cannot be taken back
          — change the credentials themselves if that is what you need.
        </Warning>
      )}

      {error !== null && <ErrorNotice message={error} />}
    </Card>
  );
}

function statusLine(nominee: NomineeRecord): string {
  if (nominee.status === 'accepted') {
    return `Accepted ${formatDate(nominee.acceptedAt)} · ${nominee.escrow?.state === 'sealed' ? 'vault key sealed' : nominee.escrow?.state === 'released' ? 'vault released' : 'no vault key'}`;
  }
  if (nominee.invitedAt !== null)
    return `Invited ${formatDate(nominee.invitedAt)} — not accepted yet`;
  return 'Recorded, not yet invited';
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 text-sm" style={{ color: 'var(--color-warn)' }}>
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Add a nominee                                                              */
/* -------------------------------------------------------------------------- */

function NomineeForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<CreateNomineeBody>({
    name: '',
    relation: '',
    accessLevel: 'full',
  });
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await endpoints.createNominee({
        ...form,
        relation: form.relation === '' ? undefined : form.relation,
        ...(email === '' ? {} : { email }),
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that nominee.');
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
        New nominee
      </CardTitle>

      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            required
          />
        </Field>

        <Field label="Relation" hint="Spouse, son, daughter, brother…">
          <Input
            value={form.relation ?? ''}
            onChange={(event) => setForm({ ...form, relation: event.target.value })}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field
            label="Email"
            hint="Optional. Needed only if you want to give them an account they can sign in to."
          >
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field label="What they may see" hint={ACCESS_HINTS[form.accessLevel]}>
            <Select
              value={form.accessLevel}
              onChange={(event) =>
                setForm({ ...form, accessLevel: event.target.value as NomineeAccessLevel })
              }
            >
              {NOMINEE_ACCESS_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {ACCESS_LABELS[level]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {error !== null && (
          <div className="sm:col-span-2">
            <ErrorNotice message={error} />
          </div>
        )}

        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={busy || form.name.trim() === ''}>
            Add nominee
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Dead-man switch                                                            */
/* -------------------------------------------------------------------------- */

function DeadManCard({ status, onChanged }: { status: DeadManStatus; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [inactivityDays, setInactivityDays] = useState(status.inactivityDays);
  const [graceDays, setGraceDays] = useState(status.graceDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await endpoints.configureDeadman({ enabled, inactivityDays, graceDays });
      setEditing(false);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  const inGrace = status.stage === 'grace';

  return (
    <Card>
      <CardTitle
        action={
          status.enabled ? (
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() => void endpoints.deadmanCheckIn().then(onChanged)}
              >
                I’m still here
              </Button>
              <Button variant="ghost" onClick={() => setEditing(!editing)}>
                {editing ? 'Close' : 'Settings'}
              </Button>
            </div>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
              Turn on
            </Button>
          )
        }
      >
        Dead-man switch
      </CardTitle>

      {!status.enabled ? (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Off. If you stop signing in, nothing is released and your nominees keep whatever access
          you have already given them — but no sealed vault key will ever open.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={inGrace ? 'var(--color-warn)' : undefined}>
              {DEAD_MAN_STAGE_LABELS[status.stage]}
            </Pill>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {inGrace
                ? `Releasing in ${status.daysUntilRelease ?? 0} day${status.daysUntilRelease === 1 ? '' : 's'} unless you sign in.`
                : `${status.daysUntilGrace} day${status.daysUntilGrace === 1 ? '' : 's'} of silence before the grace period opens.`}
            </span>
          </div>

          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            After {status.inactivityDays} days without a sign-in you get a {status.graceDays}-day
            grace period, and then{' '}
            {status.sealedEscrowCount === 0
              ? 'nothing would be released — no vault key is sealed to anybody yet.'
              : `${status.sealedEscrowCount} sealed vault key${status.sealedEscrowCount === 1 ? '' : 's'} would open.`}
          </p>

          {status.firedAt !== null && (
            <Warning>
              This switch fired on {formatDate(status.firedAt)} and released the keys sealed at that
              time. Signing in again stopped the clock; it did not un-release them.
            </Warning>
          )}

          {inGrace && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void endpoints.deadmanCancel().then(onChanged)}
            >
              Cancel the release
            </Button>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Days of silence" hint="Minimum 30. A long holiday must not trip this.">
            <Input
              type="number"
              min={30}
              max={730}
              value={inactivityDays}
              onChange={(event) => setInactivityDays(Number(event.target.value))}
            />
          </Field>
          <Field label="Grace period, in days" hint="One sign-in during this cancels everything.">
            <Input
              type="number"
              min={1}
              max={90}
              value={graceDays}
              onChange={(event) => setGraceDays(Number(event.target.value))}
            />
          </Field>
          <div className="flex gap-2 sm:col-span-2">
            <Button variant="primary" disabled={busy} onClick={() => void save(true)}>
              Save
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void save(false)}>
              Turn off
            </Button>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Warnings at 50%, 75% and 90% of the window are recorded and shown here. This build has no
        mail transport, so they are not emailed — see the note in docs/TASKS.md.
      </p>

      {error !== null && <ErrorNotice message={error} />}
    </Card>
  );
}
