## What & why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## Phase

<!-- Which phase in docs/TASKS.md does this advance? e.g. P4 — Zero-knowledge vault -->

## How to test

<!-- Steps a reviewer can actually follow. -->

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `docs/TASKS.md` updated in this PR
- [ ] Docs updated if behaviour or schema changed
- [ ] No secrets, `.env` files or anything from `data/` committed

## Sensitive areas

Tick any this PR touches — these get a closer review, and each needs tests.

- [ ] Money maths (integer paise, no floats)
- [ ] Access control / scoping (cross-user isolation tested)
- [ ] Vault cryptography (server still cannot decrypt)
- [ ] Nominee escrow or dead-man switch
- [ ] Backup / restore
- [ ] Database migration (forward-compatible; restore path considered)
