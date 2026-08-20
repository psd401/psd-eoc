import { describe, expect, test } from 'bun:test';

import { parseAccessFixtureSnapshotAllocation } from './access-fixture';

const DATABASE_CLOCK_MILLISECONDS = Date.parse('2026-08-16T22:40:54.177Z');

describe('native access snapshot allocation', () => {
  test('decodes the numeric scalars returned by the native PostgreSQL query', () => {
    const allocation = parseAccessFixtureSnapshotAllocation([
      {
        capturedAtMilliseconds: DATABASE_CLOCK_MILLISECONDS,
        latestVersion: 164,
      },
    ]);

    expect(allocation.capturedAt.toISOString()).toBe(
      '2026-08-16T22:40:54.177Z',
    );
    expect(allocation.latestVersion).toBe(164);
    expect(Object.isFrozen(allocation)).toBe(true);
  });

  test('accepts the last version that can safely allocate a PostgreSQL integer', () => {
    expect(
      parseAccessFixtureSnapshotAllocation([
        {
          capturedAtMilliseconds: DATABASE_CLOCK_MILLISECONDS,
          latestVersion: 2_147_483_646,
        },
      ]).latestVersion,
    ).toBe(2_147_483_646);
  });

  test('rejects malformed native allocation evidence', () => {
    const malformedRows: readonly (readonly Readonly<
      Record<string, unknown>
    >[])[] = [
      [],
      [
        {
          capturedAtMilliseconds: DATABASE_CLOCK_MILLISECONDS,
          latestVersion: 164,
        },
        {
          capturedAtMilliseconds: DATABASE_CLOCK_MILLISECONDS,
          latestVersion: 164,
        },
      ],
      [
        {
          capturedAtMilliseconds: '2026-08-16 22:40:54.177+00',
          latestVersion: 164,
        },
      ],
      [
        {
          capturedAtMilliseconds: Number.POSITIVE_INFINITY,
          latestVersion: 164,
        },
      ],
      [{ capturedAtMilliseconds: 1_786_920_054_177.5, latestVersion: 164 }],
      [{ capturedAtMilliseconds: -1, latestVersion: 164 }],
      [
        {
          capturedAtMilliseconds: 8_640_000_000_000_001,
          latestVersion: 164,
        },
      ],
      [
        {
          capturedAtMilliseconds: DATABASE_CLOCK_MILLISECONDS,
          latestVersion: '164',
        },
      ],
      [
        {
          capturedAtMilliseconds: DATABASE_CLOCK_MILLISECONDS,
          latestVersion: -1,
        },
      ],
      [
        {
          capturedAtMilliseconds: DATABASE_CLOCK_MILLISECONDS,
          latestVersion: 2_147_483_647,
        },
      ],
    ];

    for (const rows of malformedRows) {
      expect(() => parseAccessFixtureSnapshotAllocation(rows)).toThrow(
        'The access snapshot could not be allocated.',
      );
    }
  });
});
