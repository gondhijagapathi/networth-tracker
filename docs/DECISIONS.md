# Design Decisions

Why the shipped code is shaped the way it is, phase by phase, and what each phase
deliberately left out. Moved here from `docs/TASKS.md` when that file was trimmed to
open work only: the checklists were spent, this reasoning was not.

Read it before reopening a settled question — most "why is it not just…" answers are
already below. The phase headings are historical labels; the reasoning is current.

Related: [`PLAN.md`](PLAN.md) for the approved design, [`ARCHITECTURE.md`](ARCHITECTURE.md)
for how the pieces fit, [`SECURITY-MODEL.md`](SECURITY-MODEL.md) for the threat model,
[`TASKS.md`](TASKS.md) for what is still open.

---

## P1 — Authentication & users

Deferred to the phase that needs it:

- Vault-unlock rate limiting moves to **P4**, where the unlock endpoint exists. The
  limiter itself is built and covered by tests.
- The blanket nominee read-only guard moves to **P2**, where the data routes it must
  wrap are introduced. Mounting it in P1 would have been dead middleware that looked
  like protection without providing any.

## P2 — Data model & asset CRUD

Deliberately not in this phase:

- **Transactions do not move a holding's units or average cost.** Recording an SIP writes a
  cashflow; `holdings.units` stays whatever the owner set. Wiring the two together is the
  cost-basis engine, and it belongs with XIRR in **P3** rather than as a side effect of a
  CRUD endpoint.
- **No asset UI.** P2 is the data model and the API; the asset list, detail pages and forms
  are P3's work, alongside the dashboard they sit next to.

## P3 — Dashboard & analytics

Worth stating about the returns figures:

- **CAGR is reported only where it is true.** It describes one sum in and one value out, so
  an asset with instalments gets XIRR and no CAGR, and the class and portfolio rollups —
  many assets, many purchase dates — carry XIRR alone. Averaging members' CAGRs would
  produce a number that looks like a return and is not one.
- **Returns are gross; net worth is not.** Performance runs full cashflows against the full
  value, because pairing an ownership-adjusted value with unadjusted transactions yields a
  rate that is simply wrong. The `ownership_percent` split belongs on net worth, where it
  is applied.
- **Liabilities are left out of returns entirely.** A home loan's XIRR is its interest rate:
  a true number, and a confusing one on a page headed "how are my investments doing".

Deliberately not in this phase:

- **The cost-basis engine still does not move a holding's units or average cost.** P2
  deferred it here on the grounds that it belonged with XIRR; in the event, XIRR is
  computed from the recorded cashflows directly and needs no running average to do it.
  Rewriting `holdings.units` from transaction history is a data-migration question rather
  than an analytics one, and it is better answered next to the CAS import in the backlog
  that would produce the volume of transactions to justify it.

## P4 and P5 — Zero-knowledge vault, nominees, dead-man switch and claim kit

The two shipped together: the escrow in P5 is the reason the keypair in P4 exists, and
building them apart would have meant shipping a keypair with nothing to wrap to.

Worth stating plainly about both phases:

- **Warnings are emailed, and recorded.** The 50/75/90% stages, the grace period opening and
  the release each queue an email as well as writing an audit row and raising a banner; the
  heirs are told separately when an escrow opens. On an instance with no `SMTP_HOST` the
  messages are recorded as `suppressed` and the banner is all there is, which the admin
  Email panel states rather than leaving anyone to assume otherwise.
- **Release is one-way.** Revoking a nominee closes their grant and revokes the escrow, so
  the server will not serve the key again — but an heir who already fetched it holds a copy
  of the data key. Taking that back would mean re-encrypting every item under a new key. The
  UI says so at the point of release.
- **The claim kit prints from the browser rather than rendering a PDF on the server.** The
  kit is only complete once vault plaintext is merged into it, and the only place that
  plaintext exists is the browser. A server-rendered PDF would require the server to hold it,
  and the zero-knowledge claim would stop being true. `window.print()` against a print
  stylesheet produces the same PDF and keeps the guarantee.

Deliberately not in these phases:

- **Re-encrypting the vault under a new data key.** A passphrase change rewraps the key, which
  is the operation people actually want. Rotating the *data* key — the only real answer to a
  released escrow — touches every item and every document at once, and belongs next to the
  backup and restore machinery in **P8** that can take a snapshot before it starts.
- **A vault for household partners.** Sharing a vault between two living people is not the
  same problem as handing one to an heir, and the consent flow it needs is **P6**'s.

## P6 and P7 — Household, partner merge and price providers

The two shipped together: neither touches the other's tables, and both are additive
features sitting on infrastructure P2 and P3 already built — `resolveScope`,
`access_grants` and `ownershipBps` for the household; `instrument_prices` and holding
valuation for pricing.

Worth stating about what the household phase turned out to be:

- **The merged dashboard, the `Shared` pill and the read-only guard already existed.** P2 and
  P3 built every consumer of `access_grants` generically, anticipating a household grantee
  alongside a nominee one — `readableOwnerIds`, `assertCanSeeDetail` and `AssetSummary.shared`
  never mention "household" by name. What this phase actually added is `household.service.ts`:
  the consent flow that writes and revokes the grants those consumers already knew how to
  read. That is a smaller phase than P4/P5 in code, and it is why P6 and P7 fit in one push.
- **Two consents, not one.** Joining a household (`acceptedAt`) and sharing your own data with
  it (`shareMode` + `consentedAt`) are separate acts — a member can accept an invitation and
  still share nothing, which is the Settings toggle the plan called for. A grant only exists
  once the sharer has done both *and* the recipient has joined.
- **A grant is re-derived, never hand-edited.** Every mutation — accepting, changing a share
  mode, leaving — recomputes every directed grant a household's current membership implies,
  from scratch (`syncHouseholdGrants`). That is more database work than patching one row and
  removes an entire class of "the grant and the membership drifted apart" bugs.

Deliberately not in this phase:

- **A vault for household partners**, exactly as P4/P5 said: sharing a vault between two living
  people is a different consent problem than handing one to an heir, and it is not this
  phase's problem either. A household grant's `scope` is only ever `full` or `summary`.
- **A second invite system.** Inviting a partner requires an existing account on this
  instance — self-hosted, invite-only, small circle — so there is no new-account flow to
  build here the way there was for a nominee who might not exist yet.

### Price providers

Worth stating about pricing too:

- **A holding was already priced from `instrument_prices`.** `valuation.service.ts` has taken
  units times "the most recent price on or before `asOf`" since P3. This phase only had to
  make that table's rows fresher; the moment AMFI ingest writes one, every holding of that
  scheme revalues on its next read with no other code path touching it.
- **`NAV_REFRESH_CRON` is a real cron schedule, not a plain interval.** The dead-man sweep
  gets away with `setInterval` because it only needs to run *often enough*; AMFI publishes
  once a day, after the market closes, and a job firing at a random hour would mostly re-fetch
  an unchanged file. `lib/cron.ts` is a small 5-field cron matcher rather than a dependency —
  matched against the server's local time, so an operator wanting 20:30 IST sets
  `TZ=Asia/Kolkata`, same as they would for `cron(8)` itself.
- **The Yahoo quote endpoint is unauthenticated best-effort.** It is exactly what
  `STOCK_PRICE_PROVIDER=yahoo` opts into and what PLAN.md called "Yahoo-style" rather than a
  commitment to a stable third-party API; a provider that starts blocking these requests fails
  the way any unreachable provider does — an error entry in the refresh result, manual pricing
  untouched. It is off by default, and `manual` needs no configuration to work.

## P8 — Backup & restore

Worth stating about this phase:

- **It is a tar, not a zip, and that is the whole point.** Decrypted, a bundle is an ordinary
  `.tar.gz` that opens with tools that were on the machine before this application and will
  still be there after it. A backup format only its own program can read is a close relative
  of no backup at all, so `bundle.test.ts` asserts it against the system `tar` rather than
  leaving it as a comment.
- **A restore is a transaction, not a file swap.** The plan said "atomic swap"; swapping the
  file under a process that has it open leaves a running server holding a handle to a
  database nobody else can see. Instead the snapshot is attached and copied in inside a
  single transaction with `defer_foreign_keys`, so either every table is replaced or none is.
  Getting the ordering wrong here was caught by a test: deleting and inserting table by table
  meant emptying `users` — late in an alphabetical walk — cascaded away the assets restored a
  few tables earlier. Every delete now happens before any insert.
- **The schema check compares migration names, not a version number.** A name list says
  *which* schema rather than how far along it was, so a bundle whose migrations are a subset
  restores with newer columns taking their defaults, and one containing a migration this
  build has never seen is refused outright.
- **A scheduled backup needs a passphrase, and there is no fallback.** With `BACKUP_CRON` set
  and `BACKUP_PASSPHRASE` empty the job does not run, because writing an unencrypted copy of
  every account in the household to disk is not a default this application is willing to
  have. The boot log and the Settings screen both say the schedule is inactive — a household
  believing it has nightly backups it has never had is the worst available failure.

Deliberately not in this phase:

- **Rotating the vault's data key**, which P5 parked here on the grounds that it wanted a
  snapshot taken first. It still does, and the snapshot now exists — but re-encrypting every
  item and every document under a new key is a migration with its own failure modes, and
  bolting it onto the end of the backup work would have meant shipping it with the least
  testing of anything in this phase. It stays in the backlog, next to the CAS import.
- **Incremental or deduplicated backups.** A household's database is a few megabytes and
  compresses by roughly a factor of five; nightly full bundles at that size are cheaper than
  the bookkeeping required to avoid them.

## P9 — India-specific features

Worth stating about the tax figures:

- **The exemption belongs to the year, not to the asset.** ₹1.25 lakh of equity long-term
  gain is free across the whole portfolio, once. Applying it per holding — the obvious
  mistake — would under-report the tax of anybody holding more than one fund, and there is a
  test that says so.
- **TDS is deducted on the whole interest once the threshold is crossed, not on the excess.**
  One rupee over and ₹5,000 is withheld rather than ten paise. That cliff is the entire
  reason Form 15G and 15H exist, and getting it wrong would understate the deduction by a
  factor of fifty thousand.
- **The threshold is per payer.** Four deposits at one branch cross it together while each
  sits under it alone, which is exactly what surprises people, so the report groups by
  institution rather than by deposit.
- **A slab rate is reported as unknown rather than as zero.** This application has never been
  told anybody's income. Those buckets show the gain and no tax figure, because zero would
  read as "not taxed", which is the opposite of what slab treatment means.
- **Interest is not a capital gain.** Deposits, EPF and insurance are excluded from the gains
  report and appear in the interest section instead, so the same rupee is never taxed twice
  on one screen — and PPF and SSY interest, exempt under section 10, is listed there but kept
  out of the taxable total.

Deliberately not in this phase:

- **Realized gains.** Everything here is unrealized, because the question worth answering in
  March is "if I sold this today, where would it land". A record of what has already been
  sold is a different report, and it needs disposal records this application does not keep.
- **Loss carry-forward and set-off across years.** Losses net within a bucket, which is what
  set-off does inside a year. Carrying them forward depends on what was realised and when,
  and on returns filed elsewhere.
- **A complete 80C picture.** Tuition fees, stamp duty on a house purchase and five-year
  tax-saver deposits are all eligible and none is something this app can see. The bucket
  reports what it found and says on the screen that it is not the whole story.

## P10 — Polish & v1.0.0 release

Worth stating about this phase:

- **The accessibility pass found real failures rather than confirming a claim.** Contrast was
  measured by converting each oklch token to sRGB and computing the WCAG ratio, not by
  eyeballing it. In the light theme the semantic green came out at 2.3:1, amber at 2.0:1 and
  the brand accent at 2.8:1 against a white card; muted text passed only as large text in
  both themes; and white on the primary button was 3.8:1. Every token is now measured against
  the *darkest* surface it can appear on rather than the lightest — a colour that only passes
  on white is a colour that fails in the sidebar.
- **`Field` was putting hint text into every control's accessible name.** Nested inside the
  `<label>`, a hint becomes part of the name, so a screen reader announced "Value" as "Value
  Optional — deposits and funds are computed for you., edit text". Hints and errors are now
  attached with `aria-describedby`.
- **The service worker caches the shell and never an API response.** A cached net worth would
  survive a sign-out and outlive a revoked session. That means the app *launches* offline but
  does not *work* offline, which is stated in the file rather than implied by the word "PWA".
- **The end-to-end suite earned its runtime on its first run**, by finding that a brand-new
  installation showed the sign-in form to the one visitor who cannot use it. It is the only
  test that exercises the vault's Argon2id and WebCrypto as they actually ship.
- **The tab bar swapped Household for Planner.** Six tabs already share a phone's width;
  Household is configured once rather than checked, so it moved to the sidebar's secondary
  group with Settings and Admin.

Deliberately not in this phase:

- **A tagged release.** The version is 1.0.0 everywhere and the changelog entry is written,
  but `git tag` is left to the repository's owner rather than done on their behalf.
- **Cross-browser E2E.** One browser. Three would triple the runtime to re-test the same
  server, and the engine differences that remain are not what this suite is for.

---
