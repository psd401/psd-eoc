import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  AttemptExecutionStoreError,
  createDrizzleAttemptExecutionStore,
} from './attempt-execution-store';
import type { AttemptExecutionStore } from '../../../../workers/shared/processor';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const LEASE = 60_000;
const FINGERPRINT = 'email:synthetic-fingerprint';

/**
 * A completion shaped like the worker's, with an opaque provider outcome. The
 * store validates the envelope and treats the outcome as the worker's business.
 */
const FINAL_COMPLETION = Object.freeze({
  kind: 'final' as const,
  outcome: Object.freeze({
    state: 'provider-accepted',
    provider: 'ses',
    providerReference: 'synthetic-provider-reference',
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  }),
});

describeWithDatabase('durable channel attempt execution leases', () => {
  let connection: PostgresDatabaseConnection | undefined;
  let store: AttemptExecutionStore;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for this test.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 4,
    });
    if (created.driver !== 'postgres') {
      throw new Error('This test requires direct PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
    // Every case uses freshly generated attempt ids, so no fixture is shared
    // and nothing has to be torn down between them.
    store = createDrizzleAttemptExecutionStore(created.db);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('the first claim acquires and a second is told someone else holds it', async () => {
    const attemptId = randomUUID();
    const first = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    expect(first.kind).toBe('acquired');

    const second = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    expect(second.kind).toBe('in-progress');
  });

  test('lookup reports missing, then in-progress, then the stored completion', async () => {
    const attemptId = randomUUID();
    expect(
      (await store.lookup({ attemptId, fingerprint: FINGERPRINT })).kind,
    ).toBe('missing');

    const claim = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    if (claim.kind !== 'acquired') throw new Error('expected acquisition');
    expect(
      (await store.lookup({ attemptId, fingerprint: FINGERPRINT })).kind,
    ).toBe('in-progress');

    await store.complete({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseToken: claim.leaseToken,
      completion: FINAL_COMPLETION,
    });
    const completed = await store.lookup({
      attemptId,
      fingerprint: FINGERPRINT,
    });
    if (completed.kind !== 'completed') throw new Error('expected completion');
    expect(completed.completion).toEqual(FINAL_COMPLETION);
  });

  test('a completed attempt is replayed to a later claim rather than re-sent', async () => {
    const attemptId = randomUUID();
    const claim = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    if (claim.kind !== 'acquired') throw new Error('expected acquisition');
    await store.complete({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseToken: claim.leaseToken,
      completion: FINAL_COMPLETION,
    });

    const replay = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    if (replay.kind !== 'completed') throw new Error('expected completion');
    expect(replay.completion).toEqual(FINAL_COMPLETION);
  });

  test('a disagreeing fingerprint is refused rather than reconciled', async () => {
    const attemptId = randomUUID();
    await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });

    await expect(
      store.claim({
        attemptId,
        fingerprint: 'email:different-fingerprint',
        leaseMilliseconds: LEASE,
      }),
    ).rejects.toThrow(AttemptExecutionStoreError);
    await expect(
      store.lookup({ attemptId, fingerprint: 'email:different-fingerprint' }),
    ).rejects.toThrow(AttemptExecutionStoreError);
  });

  test('completing without the lease is refused', async () => {
    const attemptId = randomUUID();
    await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });

    await expect(
      store.complete({
        attemptId,
        fingerprint: FINGERPRINT,
        leaseToken: randomUUID(),
        completion: FINAL_COMPLETION,
      }),
    ).rejects.toThrow(AttemptExecutionStoreError);
    expect(
      (await store.lookup({ attemptId, fingerprint: FINGERPRINT })).kind,
    ).toBe('in-progress');
  });

  test('release returns the attempt to workable and refuses a stale token', async () => {
    const attemptId = randomUUID();
    const claim = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    if (claim.kind !== 'acquired') throw new Error('expected acquisition');

    await expect(
      store.release({
        attemptId,
        fingerprint: FINGERPRINT,
        leaseToken: randomUUID(),
      }),
    ).rejects.toThrow(AttemptExecutionStoreError);

    await store.release({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseToken: claim.leaseToken,
    });
    expect(
      (await store.lookup({ attemptId, fingerprint: FINGERPRINT })).kind,
    ).toBe('missing');
    expect(
      (
        await store.claim({
          attemptId,
          fingerprint: FINGERPRINT,
          leaseMilliseconds: LEASE,
        })
      ).kind,
    ).toBe('acquired');
  });

  test('a completed attempt cannot be released back into circulation', async () => {
    const attemptId = randomUUID();
    const claim = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    if (claim.kind !== 'acquired') throw new Error('expected acquisition');
    await store.complete({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseToken: claim.leaseToken,
      completion: FINAL_COMPLETION,
    });

    // Releasing here would let an already-sent notification be sent again.
    await expect(
      store.release({
        attemptId,
        fingerprint: FINGERPRINT,
        leaseToken: claim.leaseToken,
      }),
    ).rejects.toThrow(AttemptExecutionStoreError);
  });

  test('an expired lease is taken over, and the dead holder can no longer complete', async () => {
    const attemptId = randomUUID();
    const abandoned = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: 1,
    });
    if (abandoned.kind !== 'acquired') throw new Error('expected acquisition');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const takenOver = await store.claim({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseMilliseconds: LEASE,
    });
    if (takenOver.kind !== 'acquired') throw new Error('expected takeover');
    expect(takenOver.leaseToken).not.toBe(abandoned.leaseToken);

    // The worker whose lease expired may still be alive and mid-send. Its
    // completion must not land, or the outcome recorded would be the one from
    // the process nobody is waiting on.
    await expect(
      store.complete({
        attemptId,
        fingerprint: FINGERPRINT,
        leaseToken: abandoned.leaseToken,
        completion: FINAL_COMPLETION,
      }),
    ).rejects.toThrow(AttemptExecutionStoreError);

    await store.complete({
      attemptId,
      fingerprint: FINGERPRINT,
      leaseToken: takenOver.leaseToken,
      completion: FINAL_COMPLETION,
    });
    expect(
      (await store.lookup({ attemptId, fingerprint: FINGERPRINT })).kind,
    ).toBe('completed');
  });

  test('concurrent claims on one attempt produce exactly one holder', async () => {
    const attemptId = randomUUID();
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claim({
          attemptId,
          fingerprint: FINGERPRINT,
          leaseMilliseconds: LEASE,
        }),
      ),
    );
    expect(claims.filter((claim) => claim.kind === 'acquired')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'in-progress')).toHaveLength(
      7,
    );
  });
});
