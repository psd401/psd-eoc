import { describe, expect, test } from 'bun:test';

import {
  verifyWorkspaceContract,
  workspacePatternMatches,
} from './verify-workspaces';

describe('root Bun workspace coverage', () => {
  test('matches only one directory segment for a star', () => {
    expect(
      workspacePatternMatches('scripts/ops/*', 'scripts/ops/appstore'),
    ).toBe(true);
    expect(
      workspacePatternMatches('scripts/ops/*', 'scripts/ops/appstore/nested'),
    ).toBe(false);
  });

  test('includes every shipped package and has exactly one Bun lockfile', () => {
    expect(verifyWorkspaceContract()).toEqual([]);
  });
});
