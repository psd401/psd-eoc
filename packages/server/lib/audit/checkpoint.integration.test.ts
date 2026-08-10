import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  securityAuditChainAnchors,
  securityAuditEntries,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { buildSecurityAuditEntry } from './entry';
import { parseSecurityAuditFact } from './model';
import {
  createDrizzleSecurityAuditRepository,
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  toSecurityAuditInsertValues,
} from './drizzle-repository';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The PostgreSQL integration-test connection is not open.');
  }
  return connection;
}

function postgresErrorFacts(
  error: unknown,
  field: 'code' | 'message',
): readonly string[] {
  const facts: string[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const value = Reflect.get(current, field);
    if (typeof value === 'string') facts.push(value);
    current = Reflect.get(current, 'cause');
  }
  return facts;
}

function syntheticFact(requestId: string) {
  return parseSecurityAuditFact({
    category: 'agent-access',
    action: 'list-facilities',
    actionIds: [],
    confirmationId: null,
    outcome: 'success',
    principal: { kind: 'system', serviceId: 'synthetic-anchor-test' },
    source: 'scheduled-job',
    facilityId: null,
    target: { kind: 'capability', id: 'list-facilities' },
    requestId,
    reasonCode: null,
    occurredAt: '2026-08-09T12:00:00.000Z',
  });
}

function syntheticVerificationFact(requestId: string) {
  return parseSecurityAuditFact({
    category: 'audit-query',
    action: 'verify-security-audit-chain',
    actionIds: [],
    confirmationId: null,
    outcome: 'success',
    principal: { kind: 'system', serviceId: 'synthetic-anchor-test' },
    source: 'scheduled-job',
    facilityId: null,
    target: {
      kind: 'capability',
      id: 'verify-security-audit-chain',
    },
    requestId,
    reasonCode: null,
    occurredAt: '2026-08-09T12:00:01.000Z',
  });
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}> {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  });
}

async function waitForAdvisoryWaiter(
  database: PostgresDatabaseConnection['db'],
  writerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await database.execute<{ waiting: boolean }>(sql`
      select exists (
        select 1
        from pg_catalog.pg_locks
        where locktype = 'advisory'
          and not granted
          and pid <> ${writerPid}
      ) as "waiting"
    `);
    if ([...result][0]?.waiting === true) return;
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for the verification advisory lock.');
}

describeWithDatabase('security audit durable chain anchors', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }
    const createdConnection = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 3,
    });
    if (createdConnection.driver !== 'postgres') {
      throw new Error('Audit integration tests require PostgreSQL.');
    }
    connection = createdConnection;
    await migrateDatabase(createdConnection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('installs split triggers and denies direct anchor or function access', async () => {
    const database = databaseConnection().db;
    const triggers = await database.execute<{
      action_timing: string;
      event_manipulation: string;
      trigger_name: string;
    }>(sql`
      select trigger_name, action_timing, event_manipulation
      from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table = 'security_audit_entries'
        and trigger_name in (
          'security_audit_entries_anchor_guard',
          'security_audit_entries_anchor_commit'
        )
      order by trigger_name
    `);
    expect([...triggers]).toEqual([
      {
        trigger_name: 'security_audit_entries_anchor_commit',
        action_timing: 'AFTER',
        event_manipulation: 'INSERT',
      },
      {
        trigger_name: 'security_audit_entries_anchor_guard',
        action_timing: 'BEFORE',
        event_manipulation: 'INSERT',
      },
    ]);

    const privileges = await database.execute<{
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
      canTruncate: boolean;
      canExecuteGuard: boolean;
      canExecuteAnchor: boolean;
    }>(sql`
      select
        has_table_privilege(
          'psd_eoc_app',
          'public.security_audit_chain_anchors',
          'SELECT'
        ) as "canSelect",
        has_table_privilege(
          'psd_eoc_app',
          'public.security_audit_chain_anchors',
          'INSERT'
        ) as "canInsert",
        has_table_privilege(
          'psd_eoc_app',
          'public.security_audit_chain_anchors',
          'UPDATE'
        ) as "canUpdate",
        has_table_privilege(
          'psd_eoc_app',
          'public.security_audit_chain_anchors',
          'DELETE'
        ) as "canDelete",
        has_table_privilege(
          'psd_eoc_app',
          'public.security_audit_chain_anchors',
          'TRUNCATE'
        ) as "canTruncate",
        has_function_privilege(
          'psd_eoc_app',
          'public.psd_eoc_guard_security_audit_entry_insert()',
          'EXECUTE'
        ) as "canExecuteGuard",
        has_function_privilege(
          'psd_eoc_app',
          'public.psd_eoc_anchor_security_audit_entry()',
          'EXECUTE'
        ) as "canExecuteAnchor"
    `);
    expect([...privileges]).toEqual([
      {
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        canExecuteGuard: false,
        canExecuteAnchor: false,
      },
    ]);
  });

  test('creates and rolls back an anchor atomically with a raw audit insert', async () => {
    const database = databaseConnection().db;
    const requestId = randomUUID();
    let entryHash: string | undefined;
    const rollbackProbe = new Error('rollback synthetic anchor probe');

    try {
      await database.transaction(async (transaction) => {
        await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
        const anchorRows = await transaction
          .select({
            sequence: securityAuditChainAnchors.sequence,
            entryHash: securityAuditChainAnchors.entryHash,
          })
          .from(securityAuditChainAnchors)
          .orderBy(desc(securityAuditChainAnchors.sequence))
          .limit(1);
        const entry = buildSecurityAuditEntry(
          syntheticFact(requestId),
          anchorRows[0] ?? null,
        );
        entryHash = entry.entryHash;

        await transaction.execute(sql`set local role "psd_eoc_app"`);
        await transaction
          .insert(securityAuditEntries)
          .values(toSecurityAuditInsertValues(entry));
        expect(
          await transaction
            .select()
            .from(securityAuditChainAnchors)
            .where(
              and(
                eq(securityAuditChainAnchors.sequence, entry.sequence),
                eq(securityAuditChainAnchors.entryHash, entry.entryHash),
              ),
            ),
        ).toEqual([{ sequence: entry.sequence, entryHash: entry.entryHash }]);
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }

    if (entryHash === undefined) {
      throw new Error('Synthetic anchor hash was not produced.');
    }
    expect(
      await database
        .select({ id: securityAuditEntries.id })
        .from(securityAuditEntries)
        .where(eq(securityAuditEntries.requestId, requestId)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(securityAuditChainAnchors)
        .where(eq(securityAuditChainAnchors.entryHash, entryHash)),
    ).toHaveLength(0);
  });

  test('rejects trigger-function reuse outside the trusted audit table', async () => {
    const database = databaseConnection().db;

    try {
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`
          create temporary table synthetic_anchor_trigger_reuse (
            sequence integer,
            previous_hash varchar(64),
            entry_hash varchar(64)
          ) on commit drop
        `);
        await transaction.execute(sql`
          create trigger synthetic_anchor_trigger_reuse
          after insert on synthetic_anchor_trigger_reuse
          for each row execute function public.psd_eoc_anchor_security_audit_entry()
        `);
        await transaction.execute(sql`
          insert into synthetic_anchor_trigger_reuse (
            sequence,
            previous_hash,
            entry_hash
          ) values (1, null, ${'a'.repeat(64)})
        `);
      });
      throw new Error('Expected the reused anchor trigger to fail closed.');
    } catch (error) {
      expect(postgresErrorFacts(error, 'code')).toContain('55000');
      expect(postgresErrorFacts(error, 'message').join('\n')).toContain(
        'outside its trusted trigger context',
      );
    }
  });

  test('does not anchor a source row skipped by ON CONFLICT', async () => {
    const database = databaseConnection().db;
    const rollbackProbe = new Error('rollback ON CONFLICT anchor probe');

    try {
      await database.transaction(async (transaction) => {
        await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
        const anchorRows = await transaction
          .select({
            sequence: securityAuditChainAnchors.sequence,
            entryHash: securityAuditChainAnchors.entryHash,
          })
          .from(securityAuditChainAnchors)
          .orderBy(desc(securityAuditChainAnchors.sequence))
          .limit(1);
        const seedRequestId = randomUUID();
        const seedEntry = buildSecurityAuditEntry(
          syntheticFact(seedRequestId),
          anchorRows[0] ?? null,
        );
        const skippedEntry = buildSecurityAuditEntry(
          syntheticFact(seedRequestId),
          seedEntry,
        );
        const validEntry = buildSecurityAuditEntry(
          syntheticFact(randomUUID()),
          seedEntry,
        );

        await transaction.execute(sql`set local role "psd_eoc_app"`);
        await transaction
          .insert(securityAuditEntries)
          .values(toSecurityAuditInsertValues(seedEntry));
        expect(
          await transaction
            .insert(securityAuditEntries)
            .values(toSecurityAuditInsertValues(skippedEntry))
            .onConflictDoNothing({ target: securityAuditEntries.requestId })
            .returning({ id: securityAuditEntries.id }),
        ).toEqual([]);
        expect(
          await transaction
            .select()
            .from(securityAuditChainAnchors)
            .where(
              eq(securityAuditChainAnchors.entryHash, skippedEntry.entryHash),
            ),
        ).toHaveLength(0);
        expect(
          await transaction
            .select({ id: securityAuditEntries.id })
            .from(securityAuditEntries)
            .where(eq(securityAuditEntries.id, skippedEntry.id)),
        ).toHaveLength(0);

        await transaction
          .insert(securityAuditEntries)
          .values(toSecurityAuditInsertValues(validEntry));
        expect(
          await transaction
            .select()
            .from(securityAuditChainAnchors)
            .where(
              eq(securityAuditChainAnchors.entryHash, validEntry.entryHash),
            ),
        ).toEqual([
          { sequence: validEntry.sequence, entryHash: validEntry.entryHash },
        ]);
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }
  });

  test('sees a writer that commits while final verification waits for the lock', async () => {
    const database = databaseConnection().db;
    const writerInserted = createDeferred<{
      entry: ReturnType<typeof buildSecurityAuditEntry>;
      pid: number;
    }>();
    const releaseWriter = createDeferred<void>();
    const writerPromise = database.transaction(async (transaction) => {
      await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
      const pidRows = await transaction.execute<{ pid: number }>(
        sql`select pg_catalog.pg_backend_pid() as pid`,
      );
      const pid = [...pidRows][0]?.pid;
      if (pid === undefined) throw new Error('Writer backend PID is missing.');
      const anchorRows = await transaction
        .select({
          sequence: securityAuditChainAnchors.sequence,
          entryHash: securityAuditChainAnchors.entryHash,
        })
        .from(securityAuditChainAnchors)
        .orderBy(desc(securityAuditChainAnchors.sequence))
        .limit(1);
      const entry = buildSecurityAuditEntry(
        syntheticFact(randomUUID()),
        anchorRows[0] ?? null,
      );
      await transaction.execute(sql`set local role "psd_eoc_app"`);
      await transaction
        .insert(securityAuditEntries)
        .values(toSecurityAuditInsertValues(entry));
      writerInserted.resolve({ entry, pid });
      await releaseWriter.promise;
      return entry;
    });

    const { entry: writerEntry, pid } = await writerInserted.promise;
    const verificationPromise = createDrizzleSecurityAuditRepository(
      database,
    ).runVerificationSession((store) =>
      store.append(syntheticVerificationFact(randomUUID())),
    );

    try {
      await waitForAdvisoryWaiter(database, pid);
    } finally {
      releaseWriter.resolve();
    }
    const [committedWriter, verificationEntry] = await Promise.all([
      writerPromise,
      verificationPromise,
    ]);

    expect(committedWriter).toEqual(writerEntry);
    expect(verificationEntry).toMatchObject({
      sequence: writerEntry.sequence + 1,
      previousHash: writerEntry.entryHash,
      action: 'verify-security-audit-chain',
      outcome: 'success',
    });
    expect(
      await database
        .select()
        .from(securityAuditChainAnchors)
        .where(
          eq(securityAuditChainAnchors.entryHash, verificationEntry.entryHash),
        ),
    ).toEqual([
      {
        sequence: verificationEntry.sequence,
        entryHash: verificationEntry.entryHash,
      },
    ]);
  });

  test('rejects a raw append that disagrees with durable high water', async () => {
    const database = databaseConnection().db;
    const requestId = randomUUID();
    let rejectedHash: string | undefined;

    try {
      await database.transaction(async (transaction) => {
        await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
        const anchorRows = await transaction
          .select({
            sequence: securityAuditChainAnchors.sequence,
            entryHash: securityAuditChainAnchors.entryHash,
          })
          .from(securityAuditChainAnchors)
          .orderBy(desc(securityAuditChainAnchors.sequence))
          .limit(1);
        const anchor = anchorRows[0] ?? null;
        const wrongPreviousHash =
          anchor?.entryHash === 'f'.repeat(64)
            ? 'e'.repeat(64)
            : 'f'.repeat(64);
        const entry = buildSecurityAuditEntry(
          syntheticFact(requestId),
          anchor === null
            ? { sequence: 1, entryHash: wrongPreviousHash }
            : { sequence: anchor.sequence, entryHash: wrongPreviousHash },
        );
        rejectedHash = entry.entryHash;
        await transaction.execute(sql`set local role "psd_eoc_app"`);
        await transaction
          .insert(securityAuditEntries)
          .values(toSecurityAuditInsertValues(entry));
      });
      throw new Error('Expected the anchor trigger to reject the raw insert.');
    } catch (error) {
      expect(postgresErrorFacts(error, 'code')).toContain('55000');
      expect(postgresErrorFacts(error, 'message').join('\n')).toContain(
        'Security audit append does not',
      );
    }

    if (rejectedHash === undefined) {
      throw new Error('Rejected synthetic anchor hash was not produced.');
    }
    expect(
      await database
        .select()
        .from(securityAuditChainAnchors)
        .where(eq(securityAuditChainAnchors.entryHash, rejectedHash)),
    ).toHaveLength(0);
  });
});
