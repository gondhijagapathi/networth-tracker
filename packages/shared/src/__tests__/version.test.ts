/**
 * The version constant, and the promise made about it.
 *
 * `version.ts` says the constant is bumped in the same commit as the `package.json` files
 * and that this test fails if they drift apart. That is only worth writing down if something
 * actually checks it — and something should, because `APP_VERSION` is stamped into every
 * backup manifest. A bundle that claims to have been written by 1.0.0 when it was written by
 * 1.2.0 is a lie told to whoever is reading it during a disaster recovery.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function versionOf(...segments: string[]): string {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, ...segments), 'utf8'));
  return (manifest as { version: string }).version;
}

describe('APP_VERSION', () => {
  it('matches the version in the root package.json', () => {
    expect(APP_VERSION).toBe(versionOf('package.json'));
  });

  it('matches every workspace, so a bump cannot leave one behind', () => {
    // `npm version --workspaces` touches all of them; a hand-edited bump usually does not.
    for (const workspace of [
      ['packages', 'shared', 'package.json'],
      ['apps', 'api', 'package.json'],
      ['apps', 'web', 'package.json'],
      ['apps', 'e2e', 'package.json'],
    ]) {
      expect({ workspace: workspace.join('/'), version: versionOf(...workspace) }).toEqual({
        workspace: workspace.join('/'),
        version: APP_VERSION,
      });
    }
  });

  it('is a plain semantic version, because a backup manifest records it verbatim', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
