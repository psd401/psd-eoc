import { describe, expect, test } from 'bun:test';

import {
  ListThreatsInputSchema,
  ThreatKeySchema,
  ThreatPageSchema,
  ThreatSchema,
} from './threat';

const threat = Object.freeze({
  id: '00000000-0000-4000-8000-0000000000a1',
  key: 'gun-firearm',
  name: 'Gun/Firearm',
  sortOrder: 9,
  requiresDetail: false,
  active: true,
  createdAt: '2026-09-03T17:00:00.000Z',
});

describe('threat contract', () => {
  test('accepts a district-declared threat', () => {
    expect(ThreatSchema.parse(threat)).toEqual(threat);
    expect(
      ThreatSchema.parse({
        ...threat,
        key: 'other',
        name: 'Other',
        requiresDetail: true,
      }).requiresDetail,
    ).toBe(true);
  });

  test('keys are lower-case kebab identifiers', () => {
    expect(
      ThreatKeySchema.safeParse('neighborhood-police-activity').success,
    ).toBe(true);
    for (const key of ['Fire', 'fire_alarm', '-fire', 'fire-', 'fi re', '']) {
      expect(ThreatKeySchema.safeParse(key).success).toBe(false);
    }
  });

  test('refuses a threat the table would refuse', () => {
    expect(ThreatSchema.safeParse({ ...threat, name: '   ' }).success).toBe(
      false,
    );
    expect(ThreatSchema.safeParse({ ...threat, sortOrder: -1 }).success).toBe(
      false,
    );
    expect(ThreatSchema.safeParse({ ...threat, sortOrder: 1.5 }).success).toBe(
      false,
    );
    expect(
      ThreatSchema.safeParse({ ...threat, description: 'unexpected' }).success,
    ).toBe(false);
    expect(
      ThreatSchema.safeParse({ ...threat, requiresDetail: 'yes' }).success,
    ).toBe(false);
  });

  test('bounds the list query and refuses unknown fields', () => {
    expect(
      ListThreatsInputSchema.parse({
        includeInactive: false,
        cursor: null,
        limit: 200,
      }),
    ).toEqual({ includeInactive: false, cursor: null, limit: 200 });
    expect(
      ListThreatsInputSchema.safeParse({
        includeInactive: false,
        cursor: null,
        limit: 201,
      }).success,
    ).toBe(false);
    expect(
      ListThreatsInputSchema.safeParse({
        includeInactive: false,
        cursor: null,
        limit: 0,
      }).success,
    ).toBe(false);
    expect(
      ListThreatsInputSchema.safeParse({ cursor: null, limit: 10 }).success,
    ).toBe(false);
    expect(
      ListThreatsInputSchema.safeParse({
        includeInactive: false,
        cursor: null,
        limit: 10,
        facilityId: threat.id,
      }).success,
    ).toBe(false);
  });

  test('pages threats with the shared pagination envelope', () => {
    const page = ThreatPageSchema.parse({
      items: [threat],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(page.items).toHaveLength(1);
    expect(
      ThreatPageSchema.safeParse({
        items: [threat],
        pageInfo: { hasMore: true, nextCursor: null },
      }).success,
    ).toBe(false);
  });
});
