import { describe, expect, test } from 'bun:test';

import { facilityScopeFromGroups } from './trusted-group-access';

const NORTH = '00000000-0000-4000-8000-0000000000a1';
const SOUTH = '00000000-0000-4000-8000-0000000000a2';
const district = { purpose: 'access' as const, facilityId: null };
const north = { purpose: 'building' as const, facilityId: NORTH };
const south = { purpose: 'building' as const, facilityId: SOUTH };

describe('facilityScopeFromGroups', () => {
  test('a district group wins over any school group', () => {
    expect(facilityScopeFromGroups([north, district], null)).toEqual({
      kind: 'district',
    });
  });

  test('school groups grant every one of their schools', () => {
    expect(facilityScopeFromGroups([south, north, north], null)).toEqual({
      kind: 'facilities',
      facilityIds: [NORTH, SOUTH],
    });
  });

  test('a direct admission leaves the stored limit in charge, even beside a school group', () => {
    // The admission carries no school; the app-review account is held to its
    // facility by an administrator's limit that a school group must not
    // override.
    expect(facilityScopeFromGroups([], 'admission')).toBeNull();
    expect(facilityScopeFromGroups([north], 'admission')).toBeNull();
    expect(facilityScopeFromGroups([north, district], 'admission')).toEqual({
      kind: 'district',
    });
  });

  test('no group places nobody', () => {
    expect(facilityScopeFromGroups([], null)).toBeNull();
  });
});
