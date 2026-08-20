import { describe, expect, test } from 'bun:test';

import { AdminCapabilityError } from '../facilities/admin-core';
import {
  decodeUserPageCursor,
  encodeUserPageCursor,
  type UserPageCursorFilters,
} from './capabilities';

const IDS = Object.freeze({
  facility: '10000000-0000-4000-8000-000000000010',
  userA: '10000000-0000-4000-8000-000000000011',
  userB: '10000000-0000-4000-8000-000000000012',
  userC: '10000000-0000-4000-8000-000000000013',
});

const FILTERS = Object.freeze({
  facilityId: null,
  includeDisabled: true,
}) satisfies UserPageCursorFilters;

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function expectInvalidCursor(
  cursor: string,
  filters: UserPageCursorFilters = FILTERS,
): void {
  try {
    decodeUserPageCursor(cursor, filters);
  } catch (error) {
    expect(error).toBeInstanceOf(AdminCapabilityError);
    expect((error as AdminCapabilityError).status).toBe(400);
    expect((error as AdminCapabilityError).message).toBe(
      'The user pagination cursor is invalid.',
    );
    return;
  }
  throw new Error('Expected the user cursor to be rejected.');
}

describe('access user keyset pagination', () => {
  test('round-trips one canonical v1 continuation bound to every filter', () => {
    const cursor = encodeUserPageCursor(IDS.userB, FILTERS);

    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toBe(
      JSON.stringify({
        v: 1,
        collection: 'users',
        facilityId: null,
        includeDisabled: true,
        after: IDS.userB,
      }),
    );
    expect(decodeUserPageCursor(cursor, FILTERS)).toBe(IDS.userB);
  });

  test('rejects noncanonical, extra, wrong-version, wrong-collection, and reused-filter cursors', () => {
    expectInvalidCursor(
      rawCursor({
        v: 2,
        collection: 'users',
        facilityId: null,
        includeDisabled: true,
        after: IDS.userB,
      }),
    );
    expectInvalidCursor(
      rawCursor({
        v: 1,
        collection: 'access-groups',
        facilityId: null,
        includeDisabled: true,
        after: IDS.userB,
      }),
    );
    expectInvalidCursor(
      rawCursor({
        v: 1,
        collection: 'users',
        facilityId: null,
        includeDisabled: true,
        after: IDS.userB,
        extra: true,
      }),
    );
    expectInvalidCursor(
      Buffer.from(
        `{"collection":"users","v":1,"facilityId":null,"includeDisabled":true,"after":"${IDS.userB}"}`,
        'utf8',
      ).toString('base64url'),
    );

    const districtCursor = encodeUserPageCursor(IDS.userB, FILTERS);
    expectInvalidCursor(districtCursor, {
      facilityId: IDS.facility,
      includeDisabled: true,
    });
    expectInvalidCursor(districtCursor, {
      facilityId: null,
      includeDisabled: false,
    });
    expectInvalidCursor(`${districtCursor}=`, FILTERS);
  });

  test('continues by immutable ID even when labels move across display order', () => {
    const firstPage = [
      { id: IDS.userA, displayName: 'Avery' },
      { id: IDS.userB, displayName: 'Blake' },
    ];
    const cursor = encodeUserPageCursor(firstPage[1]!.id, FILTERS);
    const after = decodeUserPageCursor(cursor, FILTERS);
    const renamedUsers = [
      { id: IDS.userA, displayName: 'Zulu' },
      { id: IDS.userB, displayName: 'Alpha' },
      { id: IDS.userC, displayName: 'Casey' },
    ];

    expect(
      renamedUsers
        .filter(({ id }) => after !== null && id > after)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id }) => id),
    ).toEqual([IDS.userC]);
  });
});
