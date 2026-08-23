import { describe, expect, test } from 'bun:test';

import { GroupSourceSchema } from './group';
import { AdminReadinessSchema } from './readiness';

const OBSERVED_AT = '2026-08-22T18:00:00.000Z';
const FRESH_AT = '2026-08-22T17:00:00.000Z';
const GROUP_ID = '00000000-0000-4000-8000-000000002890';

describe('administrative readiness contracts', () => {
  test('adds the last membership read to every group-source projection', () => {
    const source = GroupSourceSchema.parse({
      id: GROUP_ID,
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'District administrators',
      active: true,
      grantedRole: 'admin',
      googleGroupId: 'synthetic-provider-id',
      email: 'administrators@example.invalid',
      membersCapturedAt: FRESH_AT,
      createdAt: '2026-08-01T12:00:00.000Z',
    });

    expect(source.membersCapturedAt).toBe(FRESH_AT);
    expect(
      GroupSourceSchema.parse({
        ...source,
        membersCapturedAt: null,
      }).membersCapturedAt,
    ).toBeNull();
    const { membersCapturedAt, ...missingReadEvidence } = source;
    void membersCapturedAt;
    expect(GroupSourceSchema.safeParse(missingReadEvidence).success).toBe(
      false,
    );
  });

  test('accepts a coherent ready projection and rejects a false ready claim', () => {
    const readiness = {
      observedAt: OBSERVED_AT,
      overallStatus: 'ready',
      accessMembership: {
        status: 'ready',
        freshnessWindowSeconds: 86_400,
        groups: [
          {
            id: GROUP_ID,
            displayName: 'District administrators',
            grantedRole: 'admin',
            membersCapturedAt: FRESH_AT,
            status: 'fresh',
          },
        ],
      },
      facilityConfiguration: {
        status: 'ready',
        activeFacilityCount: 2,
        facilitiesWithoutNeighborhoodCount: 0,
        facilitiesWithoutAudienceCount: 0,
      },
      roster: {
        status: 'ready',
        freshnessWindowSeconds: 86_400,
        latestAttemptCompletedAt: FRESH_AT,
        latestAttemptOutcome: 'complete',
        latestCompleteSnapshotCapturedAt: FRESH_AT,
      },
      alarmTopics: [
        {
          kind: 'operations',
          status: 'ready',
          confirmedSubscriberCount: 2,
        },
        {
          kind: 'critical',
          status: 'ready',
          confirmedSubscriberCount: 2,
        },
      ],
    } as const;

    expect(AdminReadinessSchema.safeParse(readiness).success).toBe(true);
    expect(
      AdminReadinessSchema.safeParse({
        ...readiness,
        alarmTopics: [
          readiness.alarmTopics[0],
          {
            kind: 'critical',
            status: 'action-required',
            confirmedSubscriberCount: 0,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('keeps an unavailable provider check distinct from missing subscribers', () => {
    const base = {
      observedAt: OBSERVED_AT,
      overallStatus: 'action-required',
      accessMembership: {
        status: 'ready',
        freshnessWindowSeconds: 86_400,
        groups: [
          {
            id: GROUP_ID,
            displayName: 'District administrators',
            grantedRole: 'admin',
            membersCapturedAt: FRESH_AT,
            status: 'fresh',
          },
        ],
      },
      facilityConfiguration: {
        status: 'ready',
        activeFacilityCount: 1,
        facilitiesWithoutNeighborhoodCount: 0,
        facilitiesWithoutAudienceCount: 0,
      },
      roster: {
        status: 'ready',
        freshnessWindowSeconds: 86_400,
        latestAttemptCompletedAt: FRESH_AT,
        latestAttemptOutcome: 'complete',
        latestCompleteSnapshotCapturedAt: FRESH_AT,
      },
      alarmTopics: [
        {
          kind: 'operations',
          status: 'unavailable',
          confirmedSubscriberCount: null,
        },
        {
          kind: 'critical',
          status: 'action-required',
          confirmedSubscriberCount: 0,
        },
      ],
    } as const;

    expect(AdminReadinessSchema.parse(base).alarmTopics).toEqual(
      base.alarmTopics,
    );
  });

  test('does not accept a caller-advertised freshness window beyond 24 hours', () => {
    const tooOld = '2026-08-21T17:00:00.000Z';
    const readiness = {
      observedAt: OBSERVED_AT,
      overallStatus: 'ready',
      accessMembership: {
        status: 'ready',
        freshnessWindowSeconds: 86_401,
        groups: [
          {
            id: GROUP_ID,
            displayName: 'District administrators',
            grantedRole: 'admin',
            membersCapturedAt: tooOld,
            status: 'fresh',
          },
        ],
      },
      facilityConfiguration: {
        status: 'ready',
        activeFacilityCount: 1,
        facilitiesWithoutNeighborhoodCount: 0,
        facilitiesWithoutAudienceCount: 0,
      },
      roster: {
        status: 'ready',
        freshnessWindowSeconds: 86_401,
        latestAttemptCompletedAt: tooOld,
        latestAttemptOutcome: 'complete',
        latestCompleteSnapshotCapturedAt: tooOld,
      },
      alarmTopics: [
        {
          kind: 'operations',
          status: 'ready',
          confirmedSubscriberCount: 1,
        },
        {
          kind: 'critical',
          status: 'ready',
          confirmedSubscriberCount: 1,
        },
      ],
    } as const;

    expect(AdminReadinessSchema.safeParse(readiness).success).toBe(false);
  });
});
