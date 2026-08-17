import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { executeCapability } from '@psd-eoc/contracts';

import {
  DESIGNATED_ACCESS_GROUP_EMAIL,
  type EvaluatedAccessMembershipSet,
} from './google-access-membership';
import {
  AccessMembershipSyncError,
  createScheduledAccessMembershipSyncAuthorizer,
  createSyncAccessMembershipHandler,
  syncAccessMembership,
  type AccessMembershipPublicationResult,
  type AccessMembershipSyncCapabilityContext,
  type AccessMembershipSyncStore,
} from './access-membership-sync';

const TEST_TIME = '2026-08-17T12:00:00.000Z';
const TEST_GOOGLE_GROUP_ID = '01synthetic_engineering';
const TEST_TRANSITION_EMAIL = 'initial.mobile@psd401.net';
const TEST_TRANSITION_EMAIL_DIGEST = createHash('sha256')
  .update(TEST_TRANSITION_EMAIL, 'utf8')
  .digest('hex');

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

const EVALUATION: EvaluatedAccessMembershipSet = Object.freeze({
  groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
  googleGroupId: TEST_GOOGLE_GROUP_ID,
  memberEmails: Object.freeze([TEST_TRANSITION_EMAIL]),
  membershipDigest: digest([
    DESIGNATED_ACCESS_GROUP_EMAIL,
    TEST_GOOGLE_GROUP_ID,
    TEST_TRANSITION_EMAIL,
  ]),
  providerGroupIdDigest: digest([TEST_GOOGLE_GROUP_ID]),
  syncStartedAt: TEST_TIME,
  capturedAt: TEST_TIME,
});
const RESULT: AccessMembershipPublicationResult = Object.freeze({
  phase: 'stage',
  snapshotId: '00000000-0000-4000-8000-000000000401',
  snapshotVersion: 4,
  capturedAt: TEST_TIME,
  designatedSourceId: '00000000-0000-4000-8000-000000000402',
  activeAccessGroupCount: 2,
  evaluatedMembershipCount: 1,
  membershipDigest: EVALUATION.membershipDigest,
  providerGroupIdDigest: EVALUATION.providerGroupIdDigest,
  proofKind: 'initial-selector-match',
  auditEntryHash: null,
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
  readonly finalizations: Parameters<
    AccessMembershipSyncStore['finalize']
  >[1][];
  readonly reservations: Parameters<AccessMembershipSyncStore['reserve']>[0][];
  readonly store: AccessMembershipSyncStore;
}

function storeHarness(
  replay: AccessMembershipPublicationResult | null = null,
): StoreHarness {
  const failed: StoreHarness['failed'] = [];
  const publications: EvaluatedAccessMembershipSet[] = [];
  const finalizations: Parameters<AccessMembershipSyncStore['finalize']>[1][] =
    [];
  const reservations: Parameters<AccessMembershipSyncStore['reserve']>[0][] =
    [];
  return {
    failed,
    finalizations,
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
      async stage(_reservationId, evaluation) {
        publications.push(evaluation);
        return RESULT;
      },
      async finalize(_reservationId, proof) {
        finalizations.push(proof);
        return {
          ...RESULT,
          phase: 'finalize',
          activeAccessGroupCount: 1,
          proofKind: 'durable-ios-session',
          auditEntryHash: 'a'.repeat(64),
        };
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
      {
        phase: 'stage',
        designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      },
      context(),
      {
        evaluator: { evaluate: async () => EVALUATION },
        initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
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
      {
        phase: 'stage',
        designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      },
      context(),
      {
        evaluator: {
          async evaluate() {
            evaluated = true;
            return EVALUATION;
          },
        },
        initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
        store: harness.store,
        now: () => new Date(TEST_TIME),
      },
    );
    expect(result).toEqual({ ...RESULT, publication: 'already-current' });
    expect(evaluated).toBe(false);
    expect(harness.publications).toEqual([]);
  });

  test('routes opaque durable-session proof to finalization without provider access', async () => {
    const harness = storeHarness();
    let evaluated = false;
    const result = await syncAccessMembership(
      {
        phase: 'finalize',
        designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
        mobileSessionId: '00000000-0000-4000-8000-000000000409',
        membershipSnapshotId: '00000000-0000-4000-8000-000000000410',
      },
      context(),
      {
        evaluator: {
          async evaluate() {
            evaluated = true;
            return EVALUATION;
          },
        },
        initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
        store: harness.store,
        now: () => new Date(TEST_TIME),
      },
    );

    expect(result).toMatchObject({
      phase: 'finalize',
      proofKind: 'durable-ios-session',
      activeAccessGroupCount: 1,
    });
    expect(evaluated).toBe(false);
    expect(harness.publications).toEqual([]);
    expect(harness.finalizations).toEqual([
      {
        mobileSessionId: '00000000-0000-4000-8000-000000000409',
        membershipSnapshotId: '00000000-0000-4000-8000-000000000410',
        requestId: '00000000-0000-4000-8000-000000000403',
        completedAt: TEST_TIME,
      },
    ]);
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
          {
            phase: 'stage',
            designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
          },
          invalid,
          {
            evaluator: { evaluate: async () => EVALUATION },
            initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
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
        {
          phase: 'stage',
          designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
        },
        context(),
        {
          evaluator: {
            evaluate: async () => {
              throw providerError;
            },
          },
          initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
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
        {
          phase: 'stage',
          designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
        },
        context(),
        {
          evaluator: { evaluate: async () => mismatched },
          initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
          store: harness.store,
          now: () => new Date(TEST_TIME),
        },
      ),
    ).rejects.toBeInstanceOf(AccessMembershipSyncError);
    expect(harness.publications).toEqual([]);
    expect(harness.failed[0]?.errorCode).toBe('DESIGNATED_GROUP_MISMATCH');
  });

  test('refuses publication unless the protected selector matches a direct member', async () => {
    const harness = storeHarness();
    const memberEmails = Object.freeze(['other@psd401.net']);
    const evaluation = Object.freeze({
      ...EVALUATION,
      memberEmails,
      membershipDigest: digest([
        DESIGNATED_ACCESS_GROUP_EMAIL,
        TEST_GOOGLE_GROUP_ID,
        ...memberEmails,
      ]),
    });
    await expect(
      syncAccessMembership(
        {
          phase: 'stage',
          designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
        },
        context(),
        {
          evaluator: { evaluate: async () => evaluation },
          initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
          store: harness.store,
          now: () => new Date(TEST_TIME),
        },
      ),
    ).rejects.toMatchObject({
      code: 'INITIAL_TRANSITION_SELECTOR_NOT_DIRECT_MEMBER',
    });
    expect(harness.publications).toEqual([]);
    expect(harness.failed[0]?.errorCode).toBe(
      'INITIAL_TRANSITION_SELECTOR_NOT_DIRECT_MEMBER',
    );
  });

  test('runs the scheduled-only authorizer before the canonical handler', async () => {
    const harness = storeHarness();
    let evaluated = false;
    const handler = createSyncAccessMembershipHandler({
      evaluator: {
        async evaluate() {
          evaluated = true;
          return EVALUATION;
        },
      },
      initialMobileTransitionEmailDigest: TEST_TRANSITION_EMAIL_DIGEST,
      store: harness.store,
      now: () => new Date(TEST_TIME),
    });
    await expect(
      executeCapability(
        handler,
        {
          phase: 'stage',
          designatedGroupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
        },
        {
          context: context({
            actor: { kind: 'system', serviceId: 'another-service' },
          }),
          humanActionResolutionContext: null,
          safetyResolver: null,
          authorizer: createScheduledAccessMembershipSyncAuthorizer(),
        },
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_SYNC_UNAUTHORIZED' });
    expect(evaluated).toBe(false);
    expect(harness.reservations).toEqual([]);
  });
});
