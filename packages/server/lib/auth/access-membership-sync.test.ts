import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { invokeAuthorizedCapabilityHandler } from '@psd-eoc/contracts';

import { type EvaluatedAccessMembershipSet } from './google-access-membership';
import {
  createScheduledAccessMembershipSyncAuthorizer,
  createSyncAccessMembershipHandler,
  syncAccessMembership,
  type AccessMembershipPublicationResult,
  type AccessMembershipSyncCapabilityContext,
  type AccessMembershipSyncStore,
} from './access-membership-sync';

const DESIGNATED_ACCESS_GROUP_EMAIL = 'tsd-engineering@example.invalid';
const TEST_TIME = '2026-08-17T12:00:00.000Z';
const TEST_GOOGLE_GROUP_ID = '01synthetic_engineering';
const TEST_TRANSITION_EMAIL = 'initial.mobile@example.invalid';

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

const CONFIGURED_GROUPS = Object.freeze([
  Object.freeze({
    groupSourceId: '00000000-0000-4000-8000-000000000402',
    email: DESIGNATED_ACCESS_GROUP_EMAIL,
    grantedRole: 'admin' as const,
  }),
]);

const EVALUATION: EvaluatedAccessMembershipSet = Object.freeze({
  groups: Object.freeze([
    Object.freeze({
      groupSourceId: '00000000-0000-4000-8000-000000000402',
      groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
      googleGroupId: TEST_GOOGLE_GROUP_ID,
      grantedRole: 'admin' as const,
      memberEmails: Object.freeze([TEST_TRANSITION_EMAIL]),
    }),
  ]),
  membershipDigest: digest([
    '00000000-0000-4000-8000-000000000402',
    DESIGNATED_ACCESS_GROUP_EMAIL,
    TEST_GOOGLE_GROUP_ID,
    'admin',
    TEST_TRANSITION_EMAIL,
  ]),
  providerGroupIdDigest: digest([TEST_GOOGLE_GROUP_ID]),
  syncStartedAt: TEST_TIME,
  capturedAt: TEST_TIME,
});
const RESULT: AccessMembershipPublicationResult = Object.freeze({
  snapshotId: '00000000-0000-4000-8000-000000000401',
  snapshotVersion: 4,
  capturedAt: TEST_TIME,
  activeAccessGroupCount: 1,
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
  /** The scope each read and each publication was asked for. */
  readonly readScopes: Array<string | undefined>;
  readonly publishScopes: Array<string | undefined>;
  readonly reservations: Parameters<AccessMembershipSyncStore['reserve']>[0][];
  readonly store: AccessMembershipSyncStore;
}

function storeHarness(
  replay: AccessMembershipPublicationResult | null = null,
): StoreHarness {
  const failed: StoreHarness['failed'] = [];
  const publications: EvaluatedAccessMembershipSet[] = [];
  const readScopes: Array<string | undefined> = [];
  const publishScopes: Array<string | undefined> = [];
  const reservations: Parameters<AccessMembershipSyncStore['reserve']>[0][] =
    [];
  return {
    failed,
    publications,
    readScopes,
    publishScopes,
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
      async readConfiguredAccessGroups(scope) {
        readScopes.push(scope);
        return CONFIGURED_GROUPS;
      },
      async publish(_reservationId, evaluation, scope) {
        publications.push(evaluation);
        publishScopes.push(scope);
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
    const result = await syncAccessMembership({}, context(), {
      evaluator: { evaluate: async () => EVALUATION },
      store: harness.store,
      now: () => new Date(TEST_TIME),
    });

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
    const result = await syncAccessMembership({}, context(), {
      evaluator: {
        async evaluate() {
          evaluated = true;
          return EVALUATION;
        },
      },
      store: harness.store,
      now: () => new Date(TEST_TIME),
    });
    expect(result).toEqual({ ...RESULT, publication: 'already-current' });
    expect(evaluated).toBe(false);
    expect(harness.publications).toEqual([]);
  });

  test('evaluates exactly the configured groups and refuses when there are none', async () => {
    const harness = storeHarness();
    let asked: readonly unknown[] = [];
    await syncAccessMembership({}, context(), {
      evaluator: {
        async evaluate(groups) {
          asked = groups;
          return EVALUATION;
        },
      },
      store: harness.store,
    });
    // The groups come from the store, never from the command, so a caller
    // cannot ask for a group the deployment has not activated.
    expect(asked).toEqual(CONFIGURED_GROUPS);
    expect(harness.publications).toEqual([EVALUATION]);

    // A provider result covering a different set is refused rather than
    // published: it would produce a baseline that does not match the active
    // configuration, which denies everyone.
    const drifted = storeHarness();
    await expect(
      syncAccessMembership({}, context(), {
        evaluator: {
          async evaluate() {
            // Internally consistent, including its digests, so it fails on the
            // set comparison rather than on digest validation.
            const [only] = EVALUATION.groups;
            if (only === undefined) throw new Error('fixture is empty');
            const group = {
              ...only,
              groupSourceId: '00000000-0000-4000-8000-0000000004ff',
            };
            return {
              ...EVALUATION,
              groups: Object.freeze([group]),
              membershipDigest: digest([
                group.groupSourceId,
                group.groupEmail,
                group.googleGroupId,
                group.grantedRole,
                ...group.memberEmails,
              ]),
            } as typeof EVALUATION;
          },
        },
        store: drifted.store,
      }),
    ).rejects.toThrow();
    expect(drifted.publications).toEqual([]);
    expect(drifted.failed[0]?.errorCode).toBe('ACCESS_EVALUATION_SET_MISMATCH');

    // No configured group fails closed before any provider call.
    const unconfigured = storeHarness();
    let contacted = false;
    await expect(
      syncAccessMembership({}, context(), {
        evaluator: {
          async evaluate() {
            contacted = true;
            return EVALUATION;
          },
        },
        store: {
          ...unconfigured.store,
          async readConfiguredAccessGroups() {
            return Object.freeze([]);
          },
        },
      }),
    ).rejects.toThrow();
    expect(contacted).toBe(false);
    expect(unconfigured.failed[0]?.errorCode).toBe(
      'NO_CONFIGURED_ACCESS_GROUPS',
    );
  });

  test('runs the sign-in groups and the roster groups as separate scoped runs', async () => {
    // One atomic run over every Google group meant a district roster list
    // with one non-staff member could abort the run that refreshes sign-in
    // membership, and a day later refuse everyone. The two scopes reserve,
    // read, evaluate, and publish independently under distinct keys.
    const harness = storeHarness();
    const dependencies = {
      store: harness.store,
      evaluator: { evaluate: async () => EVALUATION },
    };

    await syncAccessMembership({}, context(), dependencies, 'access');
    await syncAccessMembership({}, context(), dependencies, 'roster');

    expect(
      harness.reservations.map(({ idempotencyKey }) => idempotencyKey),
    ).toEqual([
      'access-sync:synthetic-run-0001',
      'access-sync:synthetic-run-0001:roster',
    ]);
    expect(harness.reservations.map(({ scope }) => scope)).toEqual([
      'access',
      'roster',
    ]);
    expect(harness.readScopes).toEqual(['access', 'roster']);
    expect(harness.publishScopes).toEqual(['access', 'roster']);
  });

  test('a roster run that fails leaves the access run untouched', async () => {
    const harness = storeHarness();
    // The provider is fine for the sign-in groups and then refuses the
    // roster groups: a district list with one member outside the staff
    // domain is exactly the shape that used to take the whole run down.
    let evaluations = 0;
    const dependencies = {
      store: harness.store,
      evaluator: {
        evaluate: async () => {
          evaluations += 1;
          if (evaluations > 1) {
            throw new Error('NON_STAFF_MEMBERSHIP: a district list member');
          }
          return EVALUATION;
        },
      },
    };

    await expect(
      syncAccessMembership({}, context(), dependencies, 'access'),
    ).resolves.toMatchObject({ publication: 'created' });
    await expect(
      syncAccessMembership({}, context(), dependencies, 'roster'),
    ).rejects.toBeInstanceOf(Error);

    // The access publication stands; the roster failure was recorded against
    // its own reservation, not the access run's.
    expect(harness.publishScopes).toEqual(['access']);
    expect(harness.failed).toHaveLength(1);
    expect(harness.reservations[1]?.scope).toBe('roster');
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
        syncAccessMembership({}, invalid, {
          evaluator: { evaluate: async () => EVALUATION },
          store: harness.store,
          now: () => new Date(TEST_TIME),
        }),
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
      syncAccessMembership({}, context(), {
        evaluator: {
          evaluate: async () => {
            throw providerError;
          },
        },
        store: harness.store,
        now: () => new Date(TEST_TIME),
      }),
    ).rejects.toBe(providerError);
    expect(harness.failed).toEqual([
      {
        reservationId: '00000000-0000-4000-8000-000000000404',
        errorCode: 'GOOGLE_UNAVAILABLE',
        completedAt: TEST_TIME,
      },
    ]);
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
      store: harness.store,
      now: () => new Date(TEST_TIME),
    });
    await expect(
      invokeAuthorizedCapabilityHandler(
        handler,
        {},
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
