import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import {
  ADMIN_READINESS_FRESHNESS_WINDOW_SECONDS,
  AlarmTopicReadinessSchema,
} from '@psd-eoc/contracts';

import {
  ALARM_TOPIC_ENVIRONMENT_KEYS,
  countConfirmedAlarmSubscriptions,
  readAlarmTopicReadiness,
  type AlarmSubscriptionProvider,
} from './alarm-subscriptions';
import {
  ACCESS_MEMBERSHIP_FRESHNESS_SECONDS,
  createGetAdminReadinessRegistration,
  projectAdminReadiness,
  readAlarmTopicsForAdminReadiness,
} from './capabilities';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
} from '../facilities/admin-core';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';

const OBSERVED_AT = new Date('2026-08-22T18:00:00.000Z');
const GROUP_ID = '00000000-0000-4000-8000-000000002890';
const FACILITY_ID = '00000000-0000-4000-8000-000000002891';
const OPERATIONS_TOPIC =
  'arn:aws:sns:us-east-2:123456789012:synthetic-operations-alarms';
const CRITICAL_TOPIC =
  'arn:aws:sns:us-east-2:123456789012:synthetic-critical-alarms';

function readyEvidence(overrides: Record<string, unknown> = {}) {
  const fresh = new Date(OBSERVED_AT.getTime() - 60 * 60 * 1_000);
  return {
    accessGroups: [
      {
        id: GROUP_ID,
        displayName: 'District administrators',
        grantedRole: 'admin' as const,
        membersCapturedAt: fresh,
      },
    ],
    activeFacilityIds: [FACILITY_ID],
    neighborhoodFacilityIds: [FACILITY_ID],
    audienceFacilityIds: [FACILITY_ID],
    latestRosterAttempt: {
      completedAt: fresh,
      outcome: 'complete' as const,
    },
    latestCompleteRosterSnapshot: { capturedAt: fresh },
    alarmTopics: [
      AlarmTopicReadinessSchema.parse({
        kind: 'operations',
        status: 'ready',
        confirmedSubscriberCount: 2,
      }),
      AlarmTopicReadinessSchema.parse({
        kind: 'critical',
        status: 'ready',
        confirmedSubscriberCount: 2,
      }),
    ],
    ...overrides,
  };
}

function authenticatedAdministrator(): AuthenticatedSession {
  return {
    actor: {
      kind: 'human',
      userId: randomUUID(),
      sessionId: randomUUID(),
    },
    source: 'web',
    roles: ['admin'],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: randomUUID() } },
  } as unknown as AuthenticatedSession;
}

describe('administrative readiness projection', () => {
  test('shares the contract and sign-in freshness boundary', () => {
    expect(ACCESS_MEMBERSHIP_FRESHNESS_SECONDS).toBe(
      ADMIN_READINESS_FRESHNESS_WINDOW_SECONDS,
    );
  });

  test('requires administrator authorization before any readiness read', () => {
    const getAdminReadinessRegistration = createGetAdminReadinessRegistration(
      readyEvidence().alarmTopics,
    );
    let databaseRead = false;
    const transaction = {
      database: new Proxy(
        {},
        {
          get() {
            databaseRead = true;
            throw new Error(
              'Readiness reached the database before authorization.',
            );
          },
        },
      ),
      requireAdministrator() {
        throw new AdminCapabilityError(
          'FORBIDDEN',
          'District administrator access is required.',
          403,
        );
      },
    };

    expect(() =>
      getAdminReadinessRegistration.resolveFacilityId({}, {
        invocation: {
          actor: {
            kind: 'human',
            userId: '00000000-0000-4000-8000-000000002892',
            sessionId: '00000000-0000-4000-8000-000000002893',
          },
        },
        transaction,
      } as never),
    ).toThrow(AdminCapabilityError);
    expect(databaseRead).toBe(false);
  });

  test('does not reach SNS for malformed input or a mismatched store session', async () => {
    const authenticated = authenticatedAdministrator();
    const mismatched = authenticatedAdministrator();
    const matchingStore = createDrizzleAdminCapabilityStore(
      {} as never,
      authenticated,
    );
    const mismatchedStore = createDrizzleAdminCapabilityStore(
      {} as never,
      mismatched,
    );
    let providerReads = 0;
    const reader = () => {
      providerReads += 1;
      return Promise.resolve(readyEvidence().alarmTopics);
    };

    const malformed = await readAlarmTopicsForAdminReadiness({
      authenticated,
      query: { unexpected: true },
      store: matchingStore,
      reader,
    });
    const wrongStore = await readAlarmTopicsForAdminReadiness({
      authenticated,
      query: {},
      store: mismatchedStore,
      reader,
    });

    expect(providerReads).toBe(0);
    expect(malformed.every(({ status }) => status === 'unavailable')).toBe(
      true,
    );
    expect(wrongStore.every(({ status }) => status === 'unavailable')).toBe(
      true,
    );
  });

  test('observes freshness against transaction time rather than request receipt', async () => {
    const capturedAt = new Date('2026-08-22T18:00:00.500Z');
    const transactionTime = new Date('2026-08-22T18:00:01.000Z');
    const scriptedRows = [
      [
        {
          id: GROUP_ID,
          displayName: 'District administrators',
          grantedRole: 'admin',
          membersCapturedAt: capturedAt,
        },
      ],
      [],
      [],
      [],
    ];
    const query = (rows: unknown) => {
      const builder = {
        from: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve),
      };
      return builder;
    };
    const database = {
      select: () => query(scriptedRows.shift()),
      selectDistinct: () => {
        throw new Error('Inactive-only coverage must not be scanned.');
      },
      selectDistinctOn: () => {
        throw new Error('Inactive-only coverage must not be scanned.');
      },
    };
    const registration = createGetAdminReadinessRegistration(
      readyEvidence().alarmTopics,
    );

    const result = await registration.handler({}, {
      invocation: { serverTime: new Date('2026-08-22T18:00:00.000Z') },
      transaction: {
        database,
        readCurrentTime: () => Promise.resolve(transactionTime),
      },
    } as never);

    expect(result.observedAt).toBe(transactionTime.toISOString());
    expect(result.accessMembership.groups[0]?.membersCapturedAt).toBe(
      capturedAt.toISOString(),
    );
  });

  test('treats exactly 24 hours as fresh and the next millisecond as stale', () => {
    const boundary = new Date(
      OBSERVED_AT.getTime() - ACCESS_MEMBERSHIP_FRESHNESS_SECONDS * 1_000,
    );
    const fresh = projectAdminReadiness(
      readyEvidence({
        accessGroups: [
          {
            id: GROUP_ID,
            displayName: 'District administrators',
            grantedRole: 'admin',
            membersCapturedAt: boundary,
          },
        ],
      }),
      OBSERVED_AT,
    );
    const stale = projectAdminReadiness(
      readyEvidence({
        accessGroups: [
          {
            id: GROUP_ID,
            displayName: 'District administrators',
            grantedRole: 'admin',
            membersCapturedAt: new Date(boundary.getTime() - 1),
          },
        ],
      }),
      OBSERVED_AT,
    );

    expect(fresh.accessMembership.groups[0]?.status).toBe('fresh');
    expect(fresh.overallStatus).toBe('ready');
    expect(stale.accessMembership.groups[0]?.status).toBe('stale');
    expect(stale.overallStatus).toBe('action-required');
  });

  test('does not hide a newest failed roster attempt behind an older snapshot', () => {
    const projected = projectAdminReadiness(
      readyEvidence({
        latestRosterAttempt: {
          completedAt: new Date(OBSERVED_AT.getTime() - 10 * 60 * 1_000),
          outcome: 'failed',
        },
      }),
      OBSERVED_AT,
    );

    expect(projected.roster.latestCompleteSnapshotCapturedAt).not.toBeNull();
    expect(projected.roster.latestAttemptOutcome).toBe('failed');
    expect(projected.roster.status).toBe('action-required');
    expect(projected.overallStatus).toBe('action-required');
  });

  test('reports missing facility coverage as an actionable count', () => {
    const projected = projectAdminReadiness(
      readyEvidence({
        neighborhoodFacilityIds: [],
        audienceFacilityIds: [],
      }),
      OBSERVED_AT,
    );

    expect(projected.facilityConfiguration).toMatchObject({
      status: 'action-required',
      activeFacilityCount: 1,
      facilitiesWithoutNeighborhoodCount: 1,
      facilitiesWithoutAudienceCount: 1,
    });
  });
});

describe('alarm subscription readiness', () => {
  test('counts only confirmed subscriptions across bounded pages', async () => {
    const calls: string[] = [];
    const deadlineSignals = new Set<AbortSignal>();
    const provider: AlarmSubscriptionProvider = {
      listSubscriptions({ topicArn, nextToken, abortSignal }) {
        calls.push(`${topicArn}:${nextToken ?? 'first'}`);
        deadlineSignals.add(abortSignal);
        return Promise.resolve(
          nextToken === undefined
            ? {
                Subscriptions: [
                  { SubscriptionArn: 'PendingConfirmation' },
                  { SubscriptionArn: 'Deleted' },
                  {
                    SubscriptionArn: `${topicArn}:00000000-0000-4000-8000-000000000001`,
                  },
                ],
                NextToken: 'second-page',
              }
            : {
                Subscriptions: [
                  {
                    SubscriptionArn: `${topicArn}:00000000-0000-4000-8000-000000000001`,
                  },
                  {
                    SubscriptionArn: `${topicArn}:00000000-0000-4000-8000-000000000002`,
                  },
                ],
              },
        );
      },
    };

    await expect(
      countConfirmedAlarmSubscriptions(provider, OPERATIONS_TOPIC),
    ).resolves.toBe(2);
    expect(calls).toEqual([
      `${OPERATIONS_TOPIC}:first`,
      `${OPERATIONS_TOPIC}:second-page`,
    ]);
    expect(deadlineSignals.size).toBe(1);
  });

  test('keeps confirmed zero distinct from missing configuration or provider failure', async () => {
    const environment = {
      [ALARM_TOPIC_ENVIRONMENT_KEYS.operations]: OPERATIONS_TOPIC,
      [ALARM_TOPIC_ENVIRONMENT_KEYS.critical]: CRITICAL_TOPIC,
    };
    const zeroProvider: AlarmSubscriptionProvider = {
      listSubscriptions: () => Promise.resolve({ Subscriptions: [] }),
    };
    const zero = await readAlarmTopicReadiness(zeroProvider, environment);
    const unavailable = await readAlarmTopicReadiness(zeroProvider, {});

    expect(zero.map(({ status }) => status)).toEqual([
      'action-required',
      'action-required',
    ]);
    expect(
      zero.map(({ confirmedSubscriberCount }) => confirmedSubscriberCount),
    ).toEqual([0, 0]);
    expect(unavailable.map(({ status }) => status)).toEqual([
      'unavailable',
      'unavailable',
    ]);
    expect(
      unavailable.map(
        ({ confirmedSubscriberCount }) => confirmedSubscriberCount,
      ),
    ).toEqual([null, null]);
  });

  test('rejects malformed provider identities without exposing their contents', async () => {
    const provider: AlarmSubscriptionProvider = {
      listSubscriptions: () =>
        Promise.resolve({
          Subscriptions: [{ SubscriptionArn: 'not-a-subscription-arn' }],
        }),
    };

    await expect(
      countConfirmedAlarmSubscriptions(provider, OPERATIONS_TOPIC),
    ).rejects.toThrow('invalid alarm subscription identity');
  });
});
