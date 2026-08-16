import { describe, expect, test } from 'bun:test';

import { SessionEstablishmentResultSchema } from '@psd-eoc/contracts';

import type { DatabaseConnection, PostgresDatabase } from '../../db/client';
import {
  DEFAULT_SESSION_POLICY,
  DefaultSessionServiceRuntime,
  SessionAccessError,
  type SessionStore,
  type StoredCredential,
  type StoredSessionContext,
} from './sessions';

const TOKEN = 'a'.repeat(43);
const NOW = new Date('2026-08-16T19:30:00.000Z');
const IDS = Object.freeze({
  user: '10000000-0000-4000-8000-000000000001',
  device: '10000000-0000-4000-8000-000000000002',
  session: '10000000-0000-4000-8000-000000000003',
  snapshot: '10000000-0000-4000-8000-000000000004',
  epoch: '10000000-0000-4000-8000-000000000005',
  issuance: '10000000-0000-4000-8000-000000000006',
});

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function connectionDestroyed(): Error & Readonly<{ code: string }> {
  return Object.assign(new Error('synthetic destroyed connection'), {
    code: 'CONNECTION_DESTROYED',
  });
}

function currentCredential(tokenDigest: string): StoredCredential {
  const result = SessionEstablishmentResultSchema.parse({
    user: {
      id: IDS.user,
      googleSubject: 'synthetic-issue-193-subject',
      email: 'synthetic.issue-193@psd401.net',
      displayName: 'Synthetic Issue 193 Administrator',
      roles: ['admin'],
      facilityScope: { kind: 'district' },
      createdAt: '2026-08-16T18:00:00.000Z',
      disabledAt: null,
    },
    session: {
      id: IDS.session,
      userId: IDS.user,
      deviceEnrollmentId: IDS.device,
      createdAt: '2026-08-16T18:00:00.000Z',
      expiresAt: '2026-09-16T18:00:00.000Z',
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: IDS.snapshot,
        membershipValidUntil: '2026-08-16T20:00:00.000Z',
        membershipGraceUntil: '2026-08-16T23:00:00.000Z',
      },
      revokedAt: null,
    },
    deviceEnrollment: {
      id: IDS.device,
      userId: IDS.user,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: 'synthetic-issue-193-installation',
      enrolledAt: '2026-08-16T18:00:00.000Z',
      lastSeenAt: '2026-08-16T18:00:00.000Z',
      revokedAt: null,
    },
    connectivityEpoch: {
      id: IDS.epoch,
      sessionId: IDS.session,
      establishedAt: '2026-08-16T18:00:00.000Z',
    },
  });
  const context: StoredSessionContext = Object.freeze({
    result,
    membershipSnapshotId: IDS.snapshot,
    membershipCapturedAt: new Date('2026-08-16T18:00:00.000Z'),
    membershipScope: Object.freeze({ kind: 'district' as const }),
    membershipAccessActive: true,
    revocation: null,
    connectivityEpochActive: true,
  });
  return Object.freeze({
    kind: 'current' as const,
    context,
    recordRef: Object.freeze({
      kind: 'initial-issuance' as const,
      issuanceId: IDS.issuance,
    }),
    generation: 1,
    tokenDigest,
  });
}

function storeWithInspection(
  inspectCredential: (tokenDigest: string) => Promise<StoredCredential>,
): SessionStore {
  const unexpected = (): never => {
    throw new Error('Unexpected session-store operation in issue #193 test.');
  };
  return {
    getMembershipSnapshotCapturedAt: async () => unexpected(),
    establish: async () => unexpected(),
    inspectCredential,
    rotateCredential: async () => unexpected(),
    completedRefreshRetry: async () => unexpected(),
    recordReplayAndRevoke: async () => unexpected(),
    revoke: async () => unexpected(),
    completedSelfRevocationRetry: async () => unexpected(),
    getSession: async () => unexpected(),
    listDeviceSessions: async () => unexpected(),
  };
}

interface FakeGeneration {
  readonly connection: DatabaseConnection;
  readonly closeCalls: number;
}

function fakeGeneration(close: () => Promise<void>): FakeGeneration {
  let closeCalls = 0;
  const connection: DatabaseConnection = {
    driver: 'postgres',
    db: Object.freeze({}) as PostgresDatabase,
    close: async () => {
      closeCalls += 1;
      await close();
    },
  };
  return {
    connection,
    get closeCalls() {
      return closeCalls;
    },
  };
}

function expectUnavailable(error: unknown): void {
  expect(error).toBeInstanceOf(SessionAccessError);
  expect(error).toMatchObject({
    code: 'CONFIGURATION_ERROR',
    status: 500,
  });
}

function controllableTimeout() {
  let active: (() => void) | undefined;
  const scheduledMilliseconds: number[] = [];
  return Object.freeze({
    scheduledMilliseconds,
    schedule(timeoutMilliseconds: number, onTimeout: () => void) {
      if (active !== undefined) {
        throw new Error('A prior synthetic timeout is still active.');
      }
      scheduledMilliseconds.push(timeoutMilliseconds);
      active = onTimeout;
      return () => {
        if (active === onTimeout) active = undefined;
      };
    },
    fire() {
      const onTimeout = active;
      if (onTimeout === undefined) {
        throw new Error('No synthetic authentication timeout is active.');
      }
      onTimeout();
    },
  });
}

describe('default session-service native connection recovery', () => {
  test('bounds a hung invalid-cookie lookup and lets the replacement authenticate', async () => {
    const hungInspection = deferred<StoredCredential>();
    let firstInspectionCalls = 0;
    let replacementInspectionCalls = 0;
    const first = fakeGeneration(async () => {
      hungInspection.reject(connectionDestroyed());
      await hungInspection.promise.catch(() => undefined);
    });
    const replacement = fakeGeneration(() => Promise.resolve());
    const generations = [first, replacement];
    const byConnection = new Map<DatabaseConnection, SessionStore>([
      [
        first.connection,
        storeWithInspection(() => {
          firstInspectionCalls += 1;
          return hungInspection.promise;
        }),
      ],
      [
        replacement.connection,
        storeWithInspection((tokenDigest) => {
          replacementInspectionCalls += 1;
          return Promise.resolve(currentCredential(tokenDigest));
        }),
      ],
    ]);
    let generationIndex = 0;
    const timeout = controllableTimeout();
    const runtime = new DefaultSessionServiceRuntime({
      createConnection: () => {
        const generation = generations[generationIndex];
        generationIndex += 1;
        if (generation === undefined) {
          throw new Error('Unexpected third session connection.');
        }
        return generation.connection;
      },
      createStore: (connection) => {
        const store = byConnection.get(connection);
        if (store === undefined) throw new Error('Unknown fake connection.');
        return store;
      },
      readPolicy: () => DEFAULT_SESSION_POLICY,
      authenticationTimeoutMilliseconds: 15,
      scheduleAuthenticationTimeout: timeout.schedule,
    });

    const staleService = runtime.get();
    const staleAuthentication = staleService
      .authenticate(TOKEN, 'web', NOW)
      .catch((error: unknown) => error);
    expect(timeout.scheduledMilliseconds).toEqual([15]);
    timeout.fire();
    expectUnavailable(await staleAuthentication);
    expect(firstInspectionCalls).toBe(1);
    expect(first.closeCalls).toBe(1);

    const replacementService = runtime.get();
    expect(replacementService).not.toBe(staleService);
    const authenticated = await replacementService.authenticate(
      TOKEN,
      'web',
      NOW,
    );
    expect(authenticated.result.user.id).toBe(IDS.user);
    expect(replacementInspectionCalls).toBe(1);
    expect(replacement.closeCalls).toBe(0);
    await runtime.close();
    expect(replacement.closeCalls).toBe(1);
  });

  test('replaces an exact CONNECTION_DESTROYED failure without retrying it', async () => {
    let failedInspectionCalls = 0;
    let replacementInspectionCalls = 0;
    const failed = fakeGeneration(() => Promise.resolve());
    const replacement = fakeGeneration(() => Promise.resolve());
    const generations = [failed, replacement];
    const stores = [
      storeWithInspection(() => {
        failedInspectionCalls += 1;
        return Promise.reject(connectionDestroyed());
      }),
      storeWithInspection((tokenDigest) => {
        replacementInspectionCalls += 1;
        return Promise.resolve(currentCredential(tokenDigest));
      }),
    ];
    let generationIndex = 0;
    const timeout = controllableTimeout();
    const runtime = new DefaultSessionServiceRuntime({
      createConnection: () => {
        const generation = generations[generationIndex];
        generationIndex += 1;
        if (generation === undefined) throw new Error('Unexpected generation.');
        return generation.connection;
      },
      createStore: () => {
        const store = stores[generationIndex - 1];
        if (store === undefined) throw new Error('Unexpected store.');
        return store;
      },
      readPolicy: () => DEFAULT_SESSION_POLICY,
      authenticationTimeoutMilliseconds: 100,
      scheduleAuthenticationTimeout: timeout.schedule,
    });

    try {
      await runtime.get().authenticate(TOKEN, 'web', NOW);
      throw new Error('Destroyed connection unexpectedly authenticated.');
    } catch (error) {
      expectUnavailable(error);
    }
    expect(failedInspectionCalls).toBe(1);
    expect(failed.closeCalls).toBe(1);

    await expect(
      runtime.get().authenticate(TOKEN, 'web', NOW),
    ).resolves.toMatchObject({ result: { user: { id: IDS.user } } });
    expect(replacementInspectionCalls).toBe(1);
    await runtime.close();
  });

  test('late recovery from an old generation cannot clear its replacement', async () => {
    const hungInspection = deferred<StoredCredential>();
    const closeStarted = deferred<void>();
    const releaseClose = deferred<void>();
    const old = fakeGeneration(async () => {
      closeStarted.resolve();
      await releaseClose.promise;
      hungInspection.reject(connectionDestroyed());
      await hungInspection.promise.catch(() => undefined);
    });
    const replacement = fakeGeneration(() => Promise.resolve());
    const generations = [old, replacement];
    const stores = [
      storeWithInspection(() => hungInspection.promise),
      storeWithInspection((tokenDigest) =>
        Promise.resolve(currentCredential(tokenDigest)),
      ),
    ];
    let generationIndex = 0;
    const timeout = controllableTimeout();
    const runtime = new DefaultSessionServiceRuntime({
      createConnection: () => {
        const generation = generations[generationIndex];
        generationIndex += 1;
        if (generation === undefined) throw new Error('Unexpected generation.');
        return generation.connection;
      },
      createStore: () => {
        const store = stores[generationIndex - 1];
        if (store === undefined) throw new Error('Unexpected store.');
        return store;
      },
      readPolicy: () => DEFAULT_SESSION_POLICY,
      authenticationTimeoutMilliseconds: 15,
      scheduleAuthenticationTimeout: timeout.schedule,
    });

    const oldService = runtime.get();
    const oldAuthentication = oldService
      .authenticate(TOKEN, 'web', NOW)
      .catch((error: unknown) => error);
    timeout.fire();
    await closeStarted.promise;
    const replacementService = runtime.get();
    expect(replacementService).not.toBe(oldService);
    releaseClose.resolve();
    expectUnavailable(await oldAuthentication);

    expect(runtime.get()).toBe(replacementService);
    await expect(
      replacementService.authenticate(TOKEN, 'web', NOW),
    ).resolves.toMatchObject({ result: { user: { id: IDS.user } } });
    expect(old.closeCalls).toBe(1);
    expect(replacement.closeCalls).toBe(0);
    await runtime.close();
    expect(replacement.closeCalls).toBe(1);
  });
});
