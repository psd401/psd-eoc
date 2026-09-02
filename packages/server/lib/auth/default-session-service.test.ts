import { describe, expect, test } from 'bun:test';

import { SessionEstablishmentResultSchema } from '@psd-eoc/contracts';
import { drizzle } from 'drizzle-orm/postgres-js';

import type {
  Database,
  DatabaseConnection,
  PostgresDatabase,
} from '../../db/client';
import * as relations from '../../db/relations';
import * as tables from '../../db/schema';
import {
  DEFAULT_SESSION_POLICY,
  DefaultSessionServiceRuntime,
  DrizzleSessionStore,
  SessionAccessError,
  SessionService,
  hashRefreshToken,
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
  rotation: '10000000-0000-4000-8000-000000000007',
  group: '10000000-0000-4000-8000-000000000008',
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
      email: 'synthetic.issue-193@example.invalid',
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

interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface RecordingDatabase {
  readonly database: Database;
  readonly statements: readonly RecordedStatement[];
}

type RawRow = readonly unknown[];

function recordingDatabase(
  rowsFor: (
    statement: RecordedStatement,
    statementIndex: number,
  ) => readonly RawRow[],
): RecordingDatabase {
  const statements: RecordedStatement[] = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(sqlText: string, params: readonly unknown[]) {
      const statement = Object.freeze({ sql: sqlText, params });
      const statementIndex = statements.length;
      statements.push(statement);
      const rows = rowsFor(statement, statementIndex);
      return Object.assign(Promise.resolve(rows), {
        values: () => Promise.resolve(rows),
      });
    },
    begin: async (
      transaction: (transactionClient: unknown) => Promise<unknown>,
    ) => transaction(client),
  };
  return Object.freeze({
    database: drizzle(client as never, {
      schema: { ...tables, ...relations },
    }) as unknown as Database,
    statements,
  });
}

describe('session credential read batching', () => {
  test('proves an unknown credential with one database statement', async () => {
    const tokenDigest = 'b'.repeat(64);
    const recording = recordingDatabase(() => []);

    await expect(
      new DrizzleSessionStore(recording.database).inspectCredential(
        tokenDigest,
      ),
    ).resolves.toEqual({ kind: 'unknown', tokenDigest });

    expect(recording.statements).toHaveLength(1);
    const [lookup] = recording.statements;
    expect(lookup?.sql).toContain('union all');
    expect(lookup?.sql).toContain('from "session_token_issuances"');
    expect(lookup?.sql).toContain('from "session_token_rotations"');
    expect(lookup?.sql).toContain('"previous_token_digest" =');
    expect(lookup?.sql).toContain('"next_token_digest" =');
    expect(lookup?.params).toEqual([tokenDigest, tokenDigest, tokenDigest]);
  });

  test('proves a retired credential with two database statements', async () => {
    const tokenDigest = 'c'.repeat(64);
    const successorDigest = 'd'.repeat(64);
    const recording = recordingDatabase((_statement, statementIndex) => {
      if (statementIndex === 0) return [[IDS.session]];
      if (statementIndex === 1) {
        return [
          [
            IDS.issuance,
            tokenDigest,
            IDS.user,
            IDS.device,
            IDS.rotation,
            tokenDigest,
            successorDigest,
          ],
        ];
      }
      throw new Error('Retired credential issued an extra database statement.');
    });

    await expect(
      new DrizzleSessionStore(recording.database).inspectCredential(
        tokenDigest,
      ),
    ).resolves.toEqual({
      kind: 'retired',
      userId: IDS.user,
      sessionId: IDS.session,
      deviceEnrollmentId: IDS.device,
      rotationId: IDS.rotation,
      tokenDigest,
    });

    expect(recording.statements).toHaveLength(2);
    expect(recording.statements[1]?.sql).toContain('inner join "sessions"');
    expect(recording.statements[1]?.sql).toContain(
      'left join "session_token_rotations"',
    );
  });

  test('authenticates a current credential with ten selected-row statements', async () => {
    const tokenDigest = hashRefreshToken(TOKEN);
    const createdAt = new Date('2026-08-16T18:00:00.000Z');
    const membershipValidUntil = new Date('2026-08-17T18:00:00.000Z');
    const membershipGraceUntil = new Date('2026-08-20T18:00:00.000Z');
    const expiresAt = new Date('2026-09-16T18:00:00.000Z');
    const googleSubject = 'synthetic-issue-193-subject';
    const recording = recordingDatabase((_statement, statementIndex) => {
      switch (statementIndex) {
        case 0:
          return [[IDS.session]];
        case 1:
          return [
            [IDS.issuance, tokenDigest, IDS.user, IDS.device, null, null, null],
          ];
        case 2:
          return [];
        case 3:
          return [
            [
              IDS.session,
              IDS.user,
              IDS.device,
              IDS.snapshot,
              membershipValidUntil,
              membershipGraceUntil,
              createdAt,
              expiresAt,
              null,
              IDS.user,
              googleSubject,
              'synthetic.issue-193@example.invalid',
              'Synthetic Issue 193 Administrator',
              'district',
              createdAt,
              null,
              IDS.device,
              IDS.user,
              'web',
              'secure-session-cookie',
              'synthetic-issue-193-installation',
              createdAt,
              createdAt,
              null,
            ],
          ];
        // The active trusted groups, then this address's membership in them.
        // These two replaced eight statements: the append-only role
        // projection, the snapshot header, its expected-versus-completed
        // group evidence, the member row, the member's group provenance, the
        // member's facilities, and the latest-generation catch-up read.
        case 4:
          return [[IDS.group, 'admin', createdAt]];
        case 5:
          return [[IDS.group, createdAt]];
        case 6:
          return [];
        case 7:
          return [];
        case 8:
          return [[IDS.epoch, IDS.session, createdAt]];
        case 9:
          return [];
        // No rotation has retired the issued digest, so it is still current.
        case 10:
          return [];
        default:
          throw new Error('Current credential issued an extra statement.');
      }
    });

    const service = new SessionService(
      new DrizzleSessionStore(recording.database),
    );
    await expect(
      service.authenticate(TOKEN, 'web', NOW),
    ).resolves.toMatchObject({
      result: {
        user: { id: IDS.user, roles: ['admin'] },
        session: { id: IDS.session },
        deviceEnrollment: { id: IDS.device },
      },
    });

    expect(recording.statements).toHaveLength(11);
    expect(
      recording.statements.filter(({ sql: statement }) =>
        /^\(?select /u.test(statement),
      ),
    ).toHaveLength(10);
    expect(recording.statements[2]?.sql).toBe(
      'set transaction isolation level repeatable read read only',
    );
    expect(recording.statements[3]?.sql).toContain('left join "users"');
    expect(recording.statements[3]?.sql).toContain(
      'left join "device_enrollments"',
    );
  });
});

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

  test('replaces a wrapped exact CONNECTION_DESTROYED failure without retrying it', async () => {
    let failedInspectionCalls = 0;
    let replacementInspectionCalls = 0;
    const failed = fakeGeneration(() => Promise.resolve());
    const replacement = fakeGeneration(() => Promise.resolve());
    const generations = [failed, replacement];
    const stores = [
      storeWithInspection(() => {
        failedInspectionCalls += 1;
        return Promise.reject(
          new Error('synthetic Drizzle query wrapper', {
            cause: connectionDestroyed(),
          }),
        );
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

  test('drains the timed-out inspection even when forced close reports failure', async () => {
    const hungInspection = deferred<StoredCredential>();
    const closeAttempted = deferred<void>();
    let inspectionCalls = 0;
    const failed = fakeGeneration(async () => {
      closeAttempted.resolve();
      throw new Error('synthetic forced-close failure');
    });
    const timeout = controllableTimeout();
    const runtime = new DefaultSessionServiceRuntime({
      createConnection: () => failed.connection,
      createStore: () =>
        storeWithInspection(() => {
          inspectionCalls += 1;
          return hungInspection.promise;
        }),
      readPolicy: () => DEFAULT_SESSION_POLICY,
      authenticationTimeoutMilliseconds: 15,
      scheduleAuthenticationTimeout: timeout.schedule,
    });

    let authenticationSettled = false;
    const authentication = runtime
      .get()
      .authenticate(TOKEN, 'web', NOW)
      .catch((error: unknown) => error)
      .finally(() => {
        authenticationSettled = true;
      });
    timeout.fire();
    await closeAttempted.promise;
    expect(authenticationSettled).toBe(false);
    expect(inspectionCalls).toBe(1);
    expect(failed.closeCalls).toBe(1);

    hungInspection.reject(connectionDestroyed());
    expectUnavailable(await authentication);
    expect(authenticationSettled).toBe(true);
    expect(inspectionCalls).toBe(1);
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
