# Contributing

## Setup

```bash
nvm use              # reads .nvmrc
npm install
cp .env.example .env # then fill in the secrets
npm run dev
```

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs exactly these four. If they pass locally they pass there.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint on
`commit-msg`.

```
<type>(<scope>): <subject>
```

**Types:** `feat` · `fix` · `docs` · `refactor` · `test` · `chore` · `perf` · `ci` · `build`

**Scopes:** `web` · `api` · `shared` · `db` · `auth` · `vault` · `nominee` · `household` ·
`prices` · `backup` · `docs` · `ci` · `deps` · `repo`

```
feat(vault): wrap DEK to nominee public key on escrow creation
fix(prices): fall back to last known NAV when AMFI fetch times out
docs(repo): document the restore schema-version check
```

## Branches

```
feat/<short-description>
fix/<short-description>
docs/<short-description>
chore/<short-description>
```

Branch from `main`, keep pull requests focused, and rebase rather than merge `main` into
your branch.

## Keeping the tracker current

**Update [`docs/TASKS.md`](docs/TASKS.md) in the same commit as the work it describes.** A
task is only done when its checkbox is ticked and its tests pass. This file is how the
project's state stays legible.

## Code conventions

- **TypeScript strict.** No `any` without a comment explaining why.
- **Money is integer paise**, always. Formatting happens only at the view layer, via the
  helpers in `packages/shared/src/money.ts`. A float in a money path is a bug.
- **Validation lives in `packages/shared`** as zod schemas, imported by both client and
  server. The server always revalidates; the client copy is for UX.
- **Never write ad-hoc ownership filters** in a route handler. All scoping goes through the
  repository layer so a forgotten `WHERE` cannot leak another household's data.
- **The server never sees vault plaintext.** If a change would require the API to decrypt a
  vault item, the design is wrong — say so in the pull request rather than working around it.
- Prefer clarity over cleverness. This code handles other people's life savings.

## Tests

- **Vitest** for units — money maths, XIRR, accrual, financial-year boundaries, crypto
  round-trips.
- **Supertest** for API routes — including cross-user isolation tests asserting a `404`.
- **Playwright** for end-to-end journeys.

Anything touching money, tax, access control or cryptography needs a test. Those are the
four places a bug does real damage.

## Security

Do not open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).

Never commit `.env`, a `.db` file, or anything from `data/`. The pre-commit hook checks, but
it is a safety net, not a substitute for care.
