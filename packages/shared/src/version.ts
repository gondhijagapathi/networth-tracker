/**
 * The application's version, as one string both halves of the monorepo can read.
 *
 * It is written here rather than imported from a `package.json` because the API and the
 * browser bundle resolve that file differently — the server would need `resolveJsonModule`
 * and a path that survives `dist/`, the client would inline whichever copy Vite found — and
 * a backup manifest that disagrees with itself across the two is worse than a constant that
 * has to be bumped by hand. `npm version` bumps the packages; this is bumped in the same
 * commit, and `version.test.ts` fails if the two drift apart.
 */
export const APP_VERSION = '1.2.0';
