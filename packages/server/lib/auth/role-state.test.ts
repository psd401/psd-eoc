import { describe, expect, test } from 'bun:test';

import { projectEffectiveRoles } from './role-state';

describe('effective append-only role state', () => {
  test('retains base grants until a newer role fact supersedes them', () => {
    expect(
      projectEffectiveRoles(
        ['staff', 'admin'],
        [{ sequence: 2, role: 'admin', granted: false }],
      ),
    ).toEqual(['staff']);
  });

  test('supports change-only grants and latest-fact revocation/regrant', () => {
    expect(
      projectEffectiveRoles(
        ['staff'],
        [
          { sequence: 4, role: 'admin', granted: true },
          { sequence: 2, role: 'admin', granted: true },
          { sequence: 3, role: 'admin', granted: false },
        ],
      ),
    ).toEqual(['staff', 'admin']);
  });

  test('returns a sorted immutable projection without duplicate roles', () => {
    const roles = projectEffectiveRoles(
      ['admin', 'admin'],
      [{ sequence: 1, role: 'staff', granted: true }],
    );

    expect(roles).toEqual(['staff', 'admin']);
    expect(Object.isFrozen(roles)).toBe(true);
  });
});
