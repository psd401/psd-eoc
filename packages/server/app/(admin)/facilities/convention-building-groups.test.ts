import { describe, expect, test } from 'bun:test';

import { conventionBuildingGroupAddress } from './capabilities';

describe('building-group naming convention', () => {
  test('names a school group by its lower-cased short code at the staff domain', () => {
    expect(conventionBuildingGroupAddress('HHE', 'example.invalid')).toBe(
      'hhe-eoc@example.invalid',
    );
    expect(conventionBuildingGroupAddress(' phs ', 'example.invalid')).toBe(
      'phs-eoc@example.invalid',
    );
  });
});
