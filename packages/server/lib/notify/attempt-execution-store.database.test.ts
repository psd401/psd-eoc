import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  AttemptExecutionStoreError,
  createDrizzleAttemptExecutionStore,
  type AttemptExecutionStore,
} from './attempt-execution-store';

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
  /**
   * These tests connect as the database owner, so every case above would pass
   * with the application role holding no privileges at all. That is not
   * hypothetical: migration 0026 created this table after the blanket
   * application grant, PostgreSQL did not extend that grant to it, and the
   * table sat with a null ACL. Workers claim an execution lease here before
   * calling any provider, so the refusal landed on the first step of every
   * send and no notification was ever delivered.
   */
  test('the application role can claim, complete, and release a lease', async () => {
    const database = connection?.db;
    if (database === undefined) throw new Error('database is required');
    const [privileges] = await database.execute<{
      can_select: boolean;
      can_insert_lease: boolean;
      can_update_lease: boolean;
      can_update_completion: boolean;
      can_delete: boolean;
    }>(sql`
      select
        has_table_privilege(
          'psd_eoc_app', 'public.channel_attempt_executions', 'SELECT'
        ) as can_select,
        has_column_privilege(
          'psd_eoc_app', 'public.channel_attempt_executions', 'lease_token', 'INSERT'
        ) as can_insert_lease,
        has_column_privilege(
          'psd_eoc_app', 'public.channel_attempt_executions', 'lease_expires_at', 'UPDATE'
        ) as can_update_lease,
        has_column_privilege(
          'psd_eoc_app', 'public.channel_attempt_executions', 'completion', 'UPDATE'
        ) as can_update_completion,
        has_table_privilege(
          'psd_eoc_app', 'public.channel_attempt_executions', 'DELETE'
        ) as can_delete
    `);
    expect(privileges).toEqual({
      can_select: true,
      can_insert_lease: true,
      can_update_lease: true,
      can_update_completion: true,
      can_delete: true,
    });
  });

  /**
   * The same defect has now reached production twice: "notification_intents"
   * in migration 0040 and this table in 0041. Both were a table the
   * application role could not touch, found only after a confirmed activation
   * reached nobody. This asserts the general property instead of waiting for
   * the third one.
   */
  test('every table grants the application role some privilege', async () => {
    const database = connection?.db;
    if (database === undefined) throw new Error('database is required');
    const unreachable = await database.execute<{ relname: string }>(sql`
      select relation.relname
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind = 'r'
        and not has_table_privilege('psd_eoc_app', relation.oid, 'SELECT')
        and not has_table_privilege('psd_eoc_app', relation.oid, 'INSERT')
        and not has_table_privilege('psd_eoc_app', relation.oid, 'UPDATE')
        and not has_table_privilege('psd_eoc_app', relation.oid, 'DELETE')
      order by relation.relname
    `);
    expect([...unreachable].map((row) => row.relname)).toEqual([]);
  });
  /**
   * INSERT must cover every column, not only the ones the caller sets.
   *
   * PostgreSQL checks INSERT privilege against every column NAMED in a
   * statement, and the query builder names all of them, writing DEFAULT for
   * the ones left out. A grant listing only the columns the application
   * supplies therefore refuses the insert outright. Migrations 0036 and 0041
   * both granted those narrow lists, and the result was that no worker on any
   * channel could claim an execution lease -- the first write of every send.
   *
   * The privilege check above passes on a narrow grant, because it asks about
   * one column at a time. This asks the question that actually matters.
   */
  test('the application role can insert every column it writes', async () => {
    const database = connection?.db;
    if (database === undefined) throw new Error('database is required');
    const written = [
      'channel_attempt_executions',
      'expo_push_provider_io',
      'expo_push_receipt_polls',
      'expo_push_retry_schedules',
      'ses_email_provider_io',
      'sms_provider_io',
      'sms_retry_schedules',
      'channel_attempts',
      'delivery_evidence',
    ];
    const gaps = await database.execute<{
      table_name: string;
      column_name: string;
    }>(sql`
      select columns.table_name, columns.column_name
      from information_schema.columns as columns
      where columns.table_schema = 'public'
        and columns.table_name in ${sql.raw(
          `(${written.map((name) => `'${name}'`).join(', ')})`,
        )}
        and not has_column_privilege(
          'psd_eoc_app',
          'public.' || columns.table_name,
          columns.column_name,
          'INSERT'
        )
      order by columns.table_name, columns.column_name
    `);
    expect(
      [...gaps].map((row) => `${row.table_name}.${row.column_name}`),
    ).toEqual([]);
  });
});
