import { describe, expect, test } from 'bun:test';

import {
  DESIGNATED_ACCESS_GROUP_EMAIL,
  type EvaluatedAccessMembershipSet,
} from './google-access-membership';
import {
  AccessMembershipSyncError,
  syncAccessMembership,
  type AccessMembershipPublicationResult,
  type AccessMembershipSyncCapabilityContext,
  type AccessMembershipSyncStore,
} from './access-membership-sync';

const TEST_TIME = '2026-08-17T12:00:00.000Z';
const EVALUATION: EvaluatedAccessMembershipSet = Object.freeze({
  groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
  googleGroupId: '01synthetic_engineering',
  memberEmails: Object.freeze(['hagelk@psd401.net']),
  membershipDigest: 'a'.repeat(64),
  providerGroupIdDigest: 'b'.repeat(64),
  syncStartedAt: TEST_TIME,
  capturedAt: TEST_TIME,
});
const RESULT: AccessMembershipPublicationResult = Object.freeze({
  snapshotId: '00000000-0000-4000-8000-000000000401',
  snapshotVersion: 4,
  capturedAt: TEST_TIME,
  designatedSourceId: '00000000-0000-4000-8000-000000000402',
  activeAccessGroupCount: 2,
  evaluatedMembershipCount: 1,
  membershipDigest: EVALUATION.membershipDigest,
  providerGroupIdDigest: EVALUATION.providerGroupIdDigest,
  publication: 'created',
});

function context(
  overrides: Partial<AccessMembershipSyncCapabilityContext> = {},
): AccessMembershipSyncCapabilityContext {
  return {
    actor: { kind: 'system', serviceId: 'access-membership-sync' },
    source: 'scheduled-job',
    transport: 'scheduled-execution',
    schedulerAuthenticated: true,
    requestId: '00000000-0000-4000-8000-000000000403',
    idempotencyKey: 'access-sync:synthetic-run-0001',
    ...overrides,
  };
}

interface StoreHarness {
  readonly failed: Array<{
    reservationId: string;
    errorCode: string;
    completedAt: string;
  }>;
  readonly publications: EvaluatedAccessMembershipSet[];
  readonly reservations: Array<Readonly<Record<string, unknown>>>;
  readonly store: AccessMembershipSyncStore;
}

function storeHarness(
  replay: AccessMembershipPublicationResult | null = null,
): StoreHarness {
  const failed: StoreHarness['failed'] = [];
  const publications: EvaluatedAccessMembershipSet[] = [];
  const reservations: Array<Readonly<Record<string, unknown>>> = [];
  return {
    failed,
    publications,
    reservations,
    store: {
      async reserve(request) {
        reservations.push(request);
        return replay === null
          ? {
              kind: 'reserved' as const,
              id: '00000000-0000-4000-8000-000000000404',
            }
          : { kind: 'replay' as const, result: replay };
      },
      async publish(_reservationId, evaluation) {
        publications.push(evaluation);
        return RESULT;
      },
      async failReservation(reservationId, errorCode, completedAt) {
        failed.push({ reservationId, errorCode, completedAt });
      },
    },
  };
}

describe('access-membership sync capability core', () => {
  test('evaluates and publishes only for the exact authenticated system context', async () => {
    const harness = storeHarness();
    const result = await syncAccessMembership(
      { designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL },
      context(),
      {
        evaluator: { evaluate: async () => EVALUATION },
        store: harness.store,
        now: () => new Date(TEST_TIME),
      },
    );

    expect(result).toEqual(RESULT);
    expect(harness.reservations).toHaveLength(1);
    expect(harness.reservations[0]).toMatchObject({
      actor: { kind: 'system', serviceId: 'access-membership-sync' },
      idempotencyKey: 'access-sync:synthetic-run-0001',
      startedAt: TEST_TIME,
    });
    expect(harness.reservations[0]?.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.publications).toEqual([EVALUATION]);
    expect(harness.failed).toEqual([]);
  });

  test('returns an idempotent replay without provider access or publication', async () => {
    const harness = storeHarness(RESULT);
    let evaluated = false;
    const result = await syncAccessMembership(
      { designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL },
      context(),
      {
        evaluator: {
          async evaluate() {
            evaluated = true;
            return EVALUATION;
          },
        },
        store: harness.store,
        now: () => new Date(TEST_TIME),
      },
    );
    expect(result).toEqual({ ...RESULT, publication: 'already-current' });
    expect(evaluated).toBe(false);
    expect(harness.publications).toEqual([]);
  });

  test('rejects human, agent, wrong-service, and untrusted transports before reservation', async () => {
    for (const invalid of [
      context({
        actor: {
          kind: 'human',
          userId: '00000000-0000-4000-8000-000000000405',
          sessionId: '00000000-0000-4000-8000-000000000406',
        },
      }),
      context({
        actor: {
          kind: 'agent',
          agentId: '00000000-0000-4000-8000-000000000407',
          apiKeyId: '00000000-0000-4000-8000-000000000408',
        },
      }),
      context({
        actor: { kind: 'system', serviceId: 'another-service' },
      }),
      context({ schedulerAuthenticated: false as true }),
    ]) {
      const harness = storeHarness();
      await expect(
        syncAccessMembership(
          { designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL },
          invalid,
          {
            evaluator: { evaluate: async () => EVALUATION },
            store: harness.store,
            now: () => new Date(TEST_TIME),
          },
        ),
      ).rejects.toMatchObject({
        code: 'ACCESS_SYNC_UNAUTHORIZED',
      });
      expect(harness.reservations).toEqual([]);
    }
  });

  test('records only a sanitized terminal code when evaluation fails', async () => {
    const harness = storeHarness();
    const providerError = Object.assign(
      new Error('provider payload must stay private'),
      { code: 'GOOGLE_UNAVAILABLE' },
    );
    await expect(
      syncAccessMembership(
        { designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL },
        context(),
        {
          evaluator: {
            evaluate: async () => {
              throw providerError;
            },
          },
          store: harness.store,
          now: () => new Date(TEST_TIME),
        },
      ),
    ).rejects.toBe(providerError);
    expect(harness.failed).toEqual([
      {
        reservationId: '00000000-0000-4000-8000-000000000404',
        errorCode: 'GOOGLE_UNAVAILABLE',
        completedAt: TEST_TIME,
      },
    ]);
  });

  test('fails a provider result that drifts from the literal product group', async () => {
    const harness = storeHarness();
    const mismatched = {
      ...EVALUATION,
      groupEmail: 'other@example.net',
    } as unknown as EvaluatedAccessMembershipSet;
    await expect(
      syncAccessMembership(
        { designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL },
        context(),
        {
          evaluator: { evaluate: async () => mismatched },
          store: harness.store,
          now: () => new Date(TEST_TIME),
        },
      ),
    ).rejects.toBeInstanceOf(AccessMembershipSyncError);
    expect(harness.publications).toEqual([]);
    expect(harness.failed[0]?.errorCode).toBe('DESIGNATED_GROUP_MISMATCH');
  });
});
