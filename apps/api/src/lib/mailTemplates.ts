/**
 * Every message this application sends, written out in full.
 *
 * One file rather than a directory of partials, because there are a dozen messages and the
 * thing worth being able to do is read all of them at once and ask "would I want to receive
 * this?". They are ordinary functions returning `{subject, text, html}` — no template
 * engine, no runtime file reads, and nothing that could fail at send time on a machine
 * where the templates were not copied into `dist/`.
 *
 * The rules these follow:
 *
 *   - **A plain-text part always.** Some of these arrive at a phone in a hospital corridor
 *     and some arrive at a mail client from 2009. The text part is not a fallback that
 *     nobody reads; it is the message, and the HTML is a nicer rendering of it.
 *   - **No images, no tracking, no external CSS.** Styles are inline because that is the
 *     only thing mail clients honour reliably, and a remote image would tell a third party
 *     when a nominee opened an inheritance notice.
 *   - **The subject never carries the secret.** Subject lines are logged in the clear in
 *     `email_outbox` and shown on the admin screen; invite codes and reset links are not.
 *   - **Say what to do if this was not you.** Every security message ends with the same
 *     kind of sentence, because the one thing a person needs from an unexpected email is a
 *     next step.
 */

import type { EmailKind } from '@networth/shared';

/** A composed message, ready to be queued. */
export interface RenderedEmail {
  kind: EmailKind;
  subject: string;
  text: string;
  html: string;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

const INK = '#1a1a1a';
const MUTED = '#5b5b5b';
const RULE = '#e4e4e4';
const ACCENT = '#1f6f4a';
const ALARM = '#8c2f21';

/**
 * The shell every message is poured into.
 *
 * A single centred column at 560px, system fonts, and a footer that says which
 * installation this came from. Self-hosted mail lands in inboxes with no brand behind it,
 * so the footer's job is to stop a legitimate message reading like a phishing attempt.
 */
function layout(options: {
  heading: string;
  body: string;
  accent?: string;
  baseUrl: string;
}): string {
  const accent = options.accent ?? ACCENT;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(options.heading)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f6f6f4;color:${INK};font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${RULE};border-radius:10px;">
<tr><td style="padding:28px 28px 8px;">
<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${accent};font-weight:600;">Net Worth</div>
<h1 style="margin:10px 0 0;font-size:21px;line-height:1.3;font-weight:600;color:${INK};">${escapeHtml(options.heading)}</h1>
</td></tr>
<tr><td style="padding:12px 28px 26px;">${options.body}</td></tr>
</table>
<div style="max-width:560px;margin:14px auto 0;font-size:12px;line-height:1.5;color:${MUTED};text-align:left;">
This message came from the Net Worth tracker at
<a href="${escapeAttr(options.baseUrl)}" style="color:${MUTED};">${escapeHtml(options.baseUrl)}</a>.
It is a self-hosted installation — nobody else operates it, and it never emails anyone outside your household.
</div>
</td></tr></table></body></html>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;color:${INK};">${text}</p>`;
}

function muted(text: string): string {
  return `<p style="margin:16px 0 0;padding-top:14px;border-top:1px solid ${RULE};font-size:13px;line-height:1.5;color:${MUTED};">${text}</p>`;
}

/** A call to action. Styled as a button, but it is a link — mail clients cannot run script. */
function button(label: string, href: string, colour = ACCENT): string {
  return `<p style="margin:0 0 16px;"><a href="${escapeAttr(href)}" style="display:inline-block;padding:11px 20px;background:${colour};color:#ffffff;text-decoration:none;border-radius:7px;font-weight:600;font-size:15px;">${escapeHtml(label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${MUTED};word-break:break-all;">If the button does not work, paste this into your browser:<br>${escapeHtml(href)}</p>`;
}

/** An invite code, set large and monospaced because it gets read aloud and retyped. */
function codeBlock(code: string): string {
  return `<p style="margin:0 0 16px;padding:14px;background:#f4f6f5;border:1px solid ${RULE};border-radius:8px;font:600 20px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;text-align:center;color:${INK};">${escapeHtml(code)}</p>`;
}

/* -------------------------------------------------------------------------- */
/* Shared context                                                             */
/* -------------------------------------------------------------------------- */

/** What every template needs regardless of what it is about. */
export interface MailContext {
  /** `config.appBaseUrl` — no trailing slash. */
  baseUrl: string;
}

function url(ctx: MailContext, path: string): string {
  return `${ctx.baseUrl}${path}`;
}

/**
 * The "I am still here" link.
 *
 * Following it only opens a page. Pressing the button on that page is what actually resets
 * the clock, because mail scanners fetch every URL in a message before a human sees it and
 * a link that checked somebody in on arrival would keep a dead owner's switch alive for
 * ever. See `consumeCheckInToken`.
 */
function checkInUrl(ctx: MailContext, token: string): string {
  return url(ctx, `/check-in?token=${encodeURIComponent(token)}`);
}

/**
 * The last line of anything security-relevant.
 *
 * Deliberately not "ignore this email if it was not you". For a password reset that is
 * true; for a 2FA change or a released escrow it is the opposite of what someone should do.
 */
const CONTACT_ADMIN =
  'If you were not expecting this, speak to whoever administers this installation.';

/* -------------------------------------------------------------------------- */
/* Invitations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An admin-issued invite.
 *
 * The code is in the body because that is what the recipient has to type, and the whole
 * point of mailing it is that they do not have to be read it over the phone. It is worth
 * being clear-eyed about what that means: anyone with access to this mailbox can create an
 * account on this instance until the code is redeemed or expires. That is why the outbox
 * seals its bodies at rest and why invites expire by default in a week.
 */
export function inviteEmail(
  ctx: MailContext,
  args: {
    code: string;
    role: string;
    expiresAt: string;
    invitedBy: string | null;
    note: string | null;
  },
): RenderedEmail {
  const link = url(ctx, `/sign-in?invite=${encodeURIComponent(args.code)}`);
  const from = args.invitedBy ? `${args.invitedBy} has invited you` : 'You have been invited';
  const expires = longDate(args.expiresAt);
  const roleLine =
    args.role === 'nominee'
      ? 'Your account will be read-only: you will be able to see what you have been given access to, and nothing else.'
      : args.role === 'admin'
        ? 'Your account will be an administrator, able to manage users and invites.'
        : 'Your account will be an ordinary member account.';

  return {
    kind: 'invite',
    subject: 'Your invite to the Net Worth tracker',
    text: [
      `${from} to a Net Worth tracker — a private, self-hosted record of a household's assets.`,
      '',
      `Your invite code is: ${args.code}`,
      '',
      `Create your account here: ${link}`,
      '',
      roleLine,
      `This code can be used once, and expires on ${expires}.`,
      ...(args.note ? ['', `A note from whoever invited you: ${args.note}`] : []),
      '',
      'If you were not expecting this, you can ignore it — the code does nothing until somebody uses it, and it will expire on its own.',
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: 'You have been invited',
      body: [
        paragraph(
          `${escapeHtml(from)} to a Net Worth tracker — a private, self-hosted record of a household's assets.`,
        ),
        paragraph('Your invite code:'),
        codeBlock(args.code),
        button('Create your account', link),
        paragraph(escapeHtml(roleLine)),
        ...(args.note ? [paragraph(`<em>${escapeHtml(args.note)}</em>`)] : []),
        muted(
          `This code can be used once, and expires on ${escapeHtml(expires)}. If you were not expecting this you can ignore it — the code does nothing until somebody uses it.`,
        ),
      ].join('\n'),
    }),
  };
}

/**
 * A nominee invite.
 *
 * Different from the ordinary invite in the only way that matters: it explains *why* a
 * stranger is being asked to make an account on somebody else's financial tracker. Without
 * that sentence this is indistinguishable from a phishing mail, and the person it is aimed
 * at is exactly the person least likely to be expecting it.
 */
export function nomineeInviteEmail(
  ctx: MailContext,
  args: {
    code: string;
    ownerName: string;
    nomineeName: string;
    expiresAt: string;
    accessLevel: string;
  },
): RenderedEmail {
  const link = url(ctx, `/sign-in?invite=${encodeURIComponent(args.code)}`);
  const expires = longDate(args.expiresAt);
  const access =
    args.accessLevel === 'vault'
      ? 'a summary of their assets, and — only if it is ever released to you — the contents of their encrypted vault'
      : args.accessLevel === 'full'
        ? 'the full detail of the assets they have nominated you for'
        : 'a summary of the assets they have nominated you for';

  return {
    kind: 'nominee_invite',
    subject: `${args.ownerName} has named you as a nominee`,
    text: [
      `${args.nomineeName},`,
      '',
      `${args.ownerName} keeps a record of their assets in a private, self-hosted Net Worth tracker, and has named you as a nominee on it.`,
      '',
      'This is a piece of estate housekeeping, not a transfer of anything. It means that if that record is ever needed — and only then — you will not be starting from a shoebox of paperwork.',
      '',
      `Your invite code is: ${args.code}`,
      `Create your account here: ${link}`,
      '',
      `Your account will be read-only. You will be able to see ${access}.`,
      `The code can be used once, and expires on ${expires}.`,
      '',
      `If this is unexpected, ask ${args.ownerName} about it before using the code.`,
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: `${escapeHtml(args.ownerName)} has named you as a nominee`,
      body: [
        paragraph(
          `${escapeHtml(args.ownerName)} keeps a record of their assets in a private, self-hosted Net Worth tracker, and has named you as a nominee on it.`,
        ),
        paragraph(
          'This is a piece of estate housekeeping, not a transfer of anything. It means that if that record is ever needed — and only then — you will not be starting from a shoebox of paperwork.',
        ),
        codeBlock(args.code),
        button('Create your account', link),
        paragraph(`Your account will be read-only. You will be able to see ${escapeHtml(access)}.`),
        muted(
          `The code can be used once, and expires on ${escapeHtml(expires)}. If this is unexpected, ask ${escapeHtml(args.ownerName)} about it before using it.`,
        ),
      ].join('\n'),
    }),
  };
}

/** A partner asking to merge household views. Both sides already have accounts. */
export function householdInviteEmail(
  ctx: MailContext,
  args: { inviterName: string; householdName: string; recipientName: string },
): RenderedEmail {
  const link = url(ctx, '/household');
  return {
    kind: 'household_invite',
    subject: `${args.inviterName} invited you to the "${args.householdName}" household`,
    text: [
      `${args.recipientName},`,
      '',
      `${args.inviterName} has invited you to join the household "${args.householdName}" on your Net Worth tracker.`,
      '',
      'Nothing is shared until you accept, and accepting on its own shares nothing either — you choose separately how much of your own data the household sees, and you can set that back to nothing at any time.',
      '',
      `Review the invitation: ${link}`,
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: 'A household invitation',
      body: [
        paragraph(
          `${escapeHtml(args.inviterName)} has invited you to join the household “${escapeHtml(args.householdName)}”.`,
        ),
        paragraph(
          'Nothing is shared until you accept, and accepting on its own shares nothing either — you choose separately how much of your own data the household sees, and you can set that back to nothing at any time.',
        ),
        button('Review the invitation', link),
      ].join('\n'),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Account lifecycle                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Welcome.
 *
 * Kept short and made useful: the one thing a new account genuinely needs to be told is
 * that the vault passphrase is not recoverable, because that is the decision they are
 * about to make and the only one this application cannot undo for them.
 */
export function welcomeEmail(
  ctx: MailContext,
  args: { name: string; email: string; role: string },
): RenderedEmail {
  const link = url(ctx, '/');
  const nominee = args.role === 'nominee';

  return {
    kind: 'welcome',
    subject: 'Your Net Worth account is ready',
    text: [
      `${args.name},`,
      '',
      `Your account on this Net Worth tracker is set up, signed in as ${args.email}.`,
      '',
      ...(nominee
        ? [
            'Your account is read-only. You will see whatever you have been nominated for, and nothing more.',
          ]
        : [
            'Two things worth doing early:',
            '',
            '  1. Turn on two-factor authentication in Settings. This account is a map of everything you own.',
            '  2. If you set up the encrypted vault, choose a passphrase you will not lose. It never leaves your browser, so nobody — not an administrator, not this email — can reset it for you. Write it down somewhere physical.',
          ]),
      '',
      `Open the tracker: ${link}`,
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: 'Your account is ready',
      body: [
        paragraph(
          `Your account is set up, signed in as <strong>${escapeHtml(args.email)}</strong>.`,
        ),
        ...(nominee
          ? [
              paragraph(
                'Your account is read-only. You will see whatever you have been nominated for, and nothing more.',
              ),
            ]
          : [
              paragraph('Two things worth doing early:'),
              paragraph(
                '<strong>Turn on two-factor authentication</strong> in Settings. This account is a map of everything you own.',
              ),
              paragraph(
                '<strong>If you set up the encrypted vault, choose a passphrase you will not lose.</strong> It never leaves your browser, so nobody — not an administrator, not this email — can reset it for you. Write it down somewhere physical.',
              ),
            ]),
        button('Open the tracker', link),
      ].join('\n'),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The reset link.
 *
 * Two sentences here are load-bearing. "This link expires in an hour" sets the expectation
 * that a link found in an old mailbox is dead. And the note about the vault stops the
 * reasonable-but-wrong assumption that resetting a password resets everything: the vault
 * passphrase is a separate secret this server has never seen, and a person who resets their
 * login and then cannot open their vault should not have to discover why by guessing.
 */
export function passwordResetEmail(
  ctx: MailContext,
  args: {
    name: string;
    token: string;
    expiresAt: string;
    requestedIp: string | null;
    totpEnabled: boolean;
  },
): RenderedEmail {
  const link = url(ctx, `/reset-password?token=${encodeURIComponent(args.token)}`);
  const from = args.requestedIp ? ` The request came from ${args.requestedIp}.` : '';

  return {
    kind: 'password_reset',
    subject: 'Reset your Net Worth password',
    text: [
      `${args.name},`,
      '',
      'Somebody asked to reset the password on your Net Worth account.' + from,
      '',
      `Reset it here: ${link}`,
      '',
      `This link works once and expires ${relativeExpiry(args.expiresAt)}.`,
      ...(args.totpEnabled
        ? ['You will also need a code from your authenticator app, or one of your recovery codes.']
        : []),
      '',
      'Resetting your password signs you out on every device.',
      'It does not change your vault passphrase — that is a separate secret, and this server has never seen it, so it cannot reset it.',
      '',
      'If this was not you, ignore this email. Your password stays as it is, and the link expires by itself. Nobody can use it without this mailbox.',
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: 'Reset your password',
      body: [
        paragraph(
          `Somebody asked to reset the password on your Net Worth account.${escapeHtml(from)}`,
        ),
        button('Choose a new password', link),
        paragraph(
          `This link works once and expires ${escapeHtml(relativeExpiry(args.expiresAt))}.` +
            (args.totpEnabled
              ? ' You will also need a code from your authenticator app, or one of your recovery codes.'
              : ''),
        ),
        paragraph(
          'Resetting your password signs you out on every device. It does <strong>not</strong> change your vault passphrase — that is a separate secret this server has never seen, so it cannot reset it.',
        ),
        muted(
          'If this was not you, ignore this email. Your password stays as it is and the link expires by itself.',
        ),
      ].join('\n'),
    }),
  };
}

/** Sent after the fact, to whichever address the account has. The alarm, not the action. */
export function passwordChangedEmail(
  ctx: MailContext,
  args: { name: string; at: string; ip: string | null; viaReset: boolean },
): RenderedEmail {
  const how = args.viaReset ? 'reset using an emailed link' : 'changed from a signed-in session';
  const where = args.ip ? ` from ${args.ip}` : '';

  return {
    kind: 'password_changed',
    subject: 'Your Net Worth password was changed',
    text: [
      `${args.name},`,
      '',
      `The password on your Net Worth account was ${how}${where} on ${longDateTime(args.at)}.`,
      '',
      'Every signed-in device was signed out, so you will need to sign in again.',
      '',
      `If this was not you, sign in and change your password immediately, then turn on two-factor authentication. ${CONTACT_ADMIN}`,
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      accent: ALARM,
      heading: 'Your password was changed',
      body: [
        paragraph(
          `The password on your account was ${escapeHtml(how)}${escapeHtml(where)} on ${escapeHtml(longDateTime(args.at))}.`,
        ),
        paragraph('Every signed-in device was signed out, so you will need to sign in again.'),
        button('Sign in', url(ctx, '/sign-in'), ALARM),
        muted(
          `If this was not you, sign in and change your password immediately, then turn on two-factor authentication. ${CONTACT_ADMIN}`,
        ),
      ].join('\n'),
    }),
  };
}

/** 2FA turned on or off. The "off" case is the one this exists for. */
export function twoFactorChangedEmail(
  ctx: MailContext,
  args: { name: string; enabled: boolean; at: string; ip: string | null },
): RenderedEmail {
  const verb = args.enabled ? 'turned on' : 'turned off';
  const where = args.ip ? ` from ${args.ip}` : '';

  return {
    kind: 'two_factor_changed',
    subject: `Two-factor authentication was ${verb}`,
    text: [
      `${args.name},`,
      '',
      `Two-factor authentication on your Net Worth account was ${verb}${where} on ${longDateTime(args.at)}.`,
      '',
      ...(args.enabled
        ? [
            'Keep your recovery codes somewhere you can reach without your phone. They are the only way back in if you lose it, and they were shown to you exactly once.',
          ]
        : ['Your account is now protected by its password alone.']),
      '',
      `If this was not you, change your password now. ${CONTACT_ADMIN}`,
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      accent: args.enabled ? ACCENT : ALARM,
      heading: `Two-factor authentication ${escapeHtml(verb)}`,
      body: [
        paragraph(
          `Two-factor authentication was ${escapeHtml(verb)}${escapeHtml(where)} on ${escapeHtml(longDateTime(args.at))}.`,
        ),
        paragraph(
          args.enabled
            ? 'Keep your recovery codes somewhere you can reach without your phone. They are the only way back in if you lose it, and they were shown to you exactly once.'
            : 'Your account is now protected by its password alone.',
        ),
        muted(`If this was not you, change your password now. ${CONTACT_ADMIN}`),
      ].join('\n'),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Dead-man switch                                                            */
/* -------------------------------------------------------------------------- */

/**
 * "We have not seen you in a while."
 *
 * The tone matters more here than anywhere else in this file. This mail goes to somebody
 * who is almost certainly fine and simply busy, and it must not read like an emergency —
 * but it must also be impossible to mistake for a newsletter, because the one person who
 * needs to act on it is the one who is about to have their vault handed to somebody else.
 *
 * So: what happened (nothing), what will happen (a date), and one click to stop it.
 */
export function deadManWarningEmail(
  ctx: MailContext,
  args: {
    name: string;
    percent: number;
    daysSilent: number;
    daysUntilGrace: number;
    sealedEscrowCount: number;
    checkInToken: string;
  },
): RenderedEmail {
  const link = url(ctx, '/inheritance');
  const checkIn = checkInUrl(ctx, args.checkInToken);
  const heirs = args.sealedEscrowCount === 1 ? 'one nominee' : `${args.sealedEscrowCount} nominees`;

  return {
    kind: 'deadman_warning',
    subject: `Your Net Worth check-in — ${args.daysUntilGrace} days left`,
    text: [
      `${args.name},`,
      '',
      `Nobody has signed in to your Net Worth account for ${args.daysSilent} days — that is ${args.percent}% of the inactivity window you set on your dead-man switch.`,
      '',
      `If the account stays quiet for another ${args.daysUntilGrace} days, a final grace period begins, and after that your sealed vault key is released to ${heirs}.`,
      '',
      'Confirm you are still here — no sign-in needed, just open this and press the button:',
      `  ${checkIn}`,
      '',
      'Signing in normally does the same thing, if you would rather. Either resets the clock.',
      '',
      `Sign in: ${url(ctx, '/sign-in')}`,
      `Review the switch: ${link}`,
      '',
      'You are receiving this because you turned the dead-man switch on yourself. You can change the window or switch it off on the Inheritance screen.',
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: 'Still there?',
      body: [
        paragraph(
          `Nobody has signed in to your account for <strong>${args.daysSilent} days</strong> — ${args.percent}% of the inactivity window you set on your dead-man switch.`,
        ),
        paragraph(
          `If it stays quiet for another <strong>${args.daysUntilGrace} days</strong>, a final grace period begins, and after that your sealed vault key is released to ${escapeHtml(heirs)}.`,
        ),
        button('I am still here', checkIn),
        muted(
          `That link needs no password and does nothing else — it only tells this installation you are around. Signing in normally resets the clock just the same. You can change the window or switch it off on the <a href="${escapeAttr(link)}" style="color:${MUTED};">Inheritance screen</a>.`,
        ),
      ].join('\n'),
    }),
  };
}

/**
 * The grace period has opened. The last quiet message before something irreversible.
 *
 * Irreversible is the right word and it is used deliberately: a released escrow is not
 * re-sealed by signing in, because the heir may already hold the key. Signing in during
 * the grace period is the only thing that prevents it, and this mail says so plainly.
 */
export function deadManGraceEmail(
  ctx: MailContext,
  args: { name: string; graceDays: number; sealedEscrowCount: number; checkInToken: string },
): RenderedEmail {
  const checkIn = checkInUrl(ctx, args.checkInToken);
  return {
    kind: 'deadman_grace',
    subject: `Action needed: your vault keys are released in ${args.graceDays} days`,
    text: [
      `${args.name},`,
      '',
      `Your Net Worth account has now been silent for the full inactivity window you set, so the dead-man switch has entered its final grace period.`,
      '',
      `In ${args.graceDays} days, the sealed vault keys held for your nominees (${args.sealedEscrowCount}) will be released to them. Once a key is released it cannot be taken back — your nominee may already hold it — so stopping it before then is the only thing that works.`,
      '',
      'Stop it here — no sign-in needed, just open this and press the button:',
      `  ${checkIn}`,
      '',
      `Or sign in as usual: ${url(ctx, '/sign-in')}`,
      '',
      'Either one cancels the grace period. Nothing else is required.',
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      accent: ALARM,
      heading: `Your vault keys are released in ${args.graceDays} days`,
      body: [
        paragraph(
          'Your account has been silent for the full inactivity window you set, so the dead-man switch has entered its final grace period.',
        ),
        paragraph(
          `In <strong>${args.graceDays} days</strong> the sealed vault keys held for your nominees (${args.sealedEscrowCount}) will be released to them. Once a key is released it cannot be taken back — your nominee may already hold it.`,
        ),
        button('I am still here — cancel this', checkIn, ALARM),
        muted(
          `That link needs no password and does nothing but stop this. Signing in as usual works too. Nothing else is required.`,
        ),
      ].join('\n'),
    }),
  };
}

/** After the fact, to the owner. They may yet be reading their mail. */
export function deadManFiredEmail(
  ctx: MailContext,
  args: { name: string; released: number; inactivityDays: number },
): RenderedEmail {
  return {
    kind: 'deadman_fired',
    subject: 'Your dead-man switch has released your vault keys',
    text: [
      `${args.name},`,
      '',
      `Your Net Worth account was silent for ${args.inactivityDays} days and through the grace period that followed, so the dead-man switch fired. ${args.released} sealed vault key(s) have been released to your nominees.`,
      '',
      'They can now open the parts of your vault you sealed for them. This cannot be undone — a released key may already have been used — but you should know that it happened.',
      '',
      `Sign in to see exactly what was released and when: ${url(ctx, '/inheritance')}`,
      '',
      `If this was not meant to happen, sign in now: doing so stops any further release, and ${CONTACT_ADMIN.toLowerCase()}`,
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      accent: ALARM,
      heading: 'Your dead-man switch has fired',
      body: [
        paragraph(
          `Your account was silent for ${args.inactivityDays} days and through the grace period that followed. <strong>${args.released} sealed vault key(s)</strong> have been released to your nominees.`,
        ),
        paragraph(
          'They can now open the parts of your vault you sealed for them. This cannot be undone — a released key may already have been used — but you should know that it happened.',
        ),
        button('See what was released', url(ctx, '/inheritance'), ALARM),
      ].join('\n'),
    }),
  };
}

/**
 * To the heir.
 *
 * The hardest message in the application to word, because of the two people who could be
 * reading it — somebody whose relative has died, and somebody whose relative simply went
 * travelling without their phone — it has to be right for both. It says what is now
 * available and does not say why, and it does not offer condolences for something it
 * cannot know has happened.
 */
export function estateReleasedEmail(
  ctx: MailContext,
  args: { nomineeName: string; ownerName: string; reason: 'owner' | 'deadman' },
): RenderedEmail {
  const link = url(ctx, '/claim-kit');
  const because =
    args.reason === 'owner'
      ? `${args.ownerName} has released it to you directly.`
      : `${args.ownerName}'s account has been inactive long enough for the dead-man switch they configured to release it automatically.`;

  return {
    kind: 'estate_released',
    subject: `${args.ownerName}'s records have been made available to you`,
    text: [
      `${args.nomineeName},`,
      '',
      `${args.ownerName} named you as a nominee on their Net Worth tracker and sealed a copy of their vault key for you. That key has now been released. ${because}`,
      '',
      'You can now sign in and see the records they left for you — accounts, policies, nominations, and the claim kit that explains what to do with each of them.',
      '',
      `Sign in: ${url(ctx, '/sign-in')}`,
      `The claim kit: ${link}`,
      '',
      'You will need the vault passphrase you chose when you set up your own account to unlock it.',
      '',
      `If you believe this has happened by mistake, ${args.ownerName} can stop it by signing in to their own account. ${CONTACT_ADMIN}`,
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: `${escapeHtml(args.ownerName)}'s records are available to you`,
      body: [
        paragraph(
          `${escapeHtml(args.ownerName)} named you as a nominee on their Net Worth tracker and sealed a copy of their vault key for you. That key has now been released. ${escapeHtml(because)}`,
        ),
        paragraph(
          'You can now sign in and see the records they left for you — accounts, policies, nominations, and the claim kit that explains what to do with each of them.',
        ),
        button('Open the claim kit', link),
        muted(
          `You will need the vault passphrase you chose when you set up your own account to unlock it. If you believe this has happened by mistake, ${escapeHtml(args.ownerName)} can stop it by signing in to their own account.`,
        ),
      ].join('\n'),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The admin's "does this work" button.
 *
 * It says which host and sender it went through, because the question behind pressing it is
 * never "did an email arrive" but "did it arrive using the settings I think I typed".
 */
export function testEmail(
  ctx: MailContext,
  args: { name: string; host: string; from: string },
): RenderedEmail {
  return {
    kind: 'test',
    subject: 'Net Worth test message',
    text: [
      `${args.name},`,
      '',
      'Mail is working. This message was sent by your Net Worth tracker because somebody pressed the test button in the admin screen.',
      '',
      `  SMTP host: ${args.host}`,
      `  From:      ${args.from}`,
      `  Links use: ${ctx.baseUrl}`,
      '',
      'If the links in other messages do not work, APP_BASE_URL is the setting to change.',
    ].join('\n'),
    html: layout({
      baseUrl: ctx.baseUrl,
      heading: 'Mail is working',
      body: [
        paragraph(
          'This message was sent because somebody pressed the test button in the admin screen.',
        ),
        paragraph(
          `<strong>SMTP host</strong> ${escapeHtml(args.host)}<br><strong>From</strong> ${escapeHtml(args.from)}<br><strong>Links use</strong> ${escapeHtml(ctx.baseUrl)}`,
        ),
        muted('If the links in other messages do not work, APP_BASE_URL is the setting to change.'),
      ].join('\n'),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Dates are rendered in IST.
 *
 * This is an application for Indian households and the recipient is in India; "expires on
 * 14 September 2025" is what they need, and a UTC timestamp four hours short of that is a
 * needless way to be wrong about a deadline.
 */
const IST = 'Asia/Kolkata';

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function longDateTime(iso: string): string {
  return `${new Date(iso).toLocaleString('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })} IST`;
}

/**
 * "in 60 minutes" rather than a timestamp.
 *
 * A reset link's lifetime is the only thing about it worth knowing, and it is short enough
 * that a clock time — in a timezone that may not be the reader's — is harder to act on than
 * a duration.
 */
function relativeExpiry(iso: string, from: Date = new Date()): string {
  const minutes = Math.round((Date.parse(iso) - from.getTime()) / 60_000);
  if (minutes <= 1) return 'shortly';
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'in an hour' : `in ${hours} hours`;
}

/**
 * Escape for HTML text.
 *
 * Every template above interpolates values that came from a person — a display name, a
 * nominee's note — into markup. Names contain apostrophes and ampersands routinely and
 * `<script>` occasionally, and a mail client is a HTML renderer like any other.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** As {@link escapeHtml}, for a value going inside an attribute such as `href`. */
function escapeAttr(value: string): string {
  return escapeHtml(value);
}
