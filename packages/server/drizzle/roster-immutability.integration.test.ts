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
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../db/client';
import { seedDatabase } from '../db/seed';
import { migrateDatabase } from './migrate';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const ids = {
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  groupNorth: '00000000-0000-4000-8000-000000000030',
  groupSouth: '00000000-0000-4000-8000-000000000031',
  groupOthers: '00000000-0000-4000-8000-000000000032',
  configuration: '00000000-0000-4000-8000-000000000040',
  snapshot: '00000000-0000-4000-8000-000000000041',
  recipientNorthTwo: '00000000-0000-4000-8000-000000000051',
  endpointNorthTwoEmail: '00000000-0000-4000-8000-000000000064',
  completeSync: '00000000-0000-4000-8000-000000008060',
  failedSync: '00000000-0000-4000-8000-000000008061',
  northFailure: '00000000-0000-4000-8000-000000008070',
  southFailure: '00000000-0000-4000-8000-000000008071',
  othersFailure: '00000000-0000-4000-8000-000000008072',
  missingFacility: '00000000-0000-4000-8000-000000008080',
  missingGroup: '00000000-0000-4000-8000-000000008081',
  lateRecipient: '00000000-0000-4000-8000-000000008082',
  lateEndpoint: '00000000-0000-4000-8000-000000008083',
  lateFailure: '00000000-0000-4000-8000-000000008084',
  nonSequentialSnapshot: '00000000-0000-4000-8000-000000008085',
  ambiguousConfiguration: '00000000-0000-4000-8000-000000008086',
  ambiguousSnapshot: '00000000-0000-4000-8000-000000008087',
  configurableAccessGroup: '00000000-0000-4000-8000-000000008088',
} as const;

const rosterGroups = [
  {
    id: ids.groupNorth,
    purpose: 'building',
  },
  {
    id: ids.groupSouth,
    purpose: 'building',
  },
  {
    id: ids.groupOthers,
    purpose: 'others',
  },
] as const;

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
  const visited = new Set<unknown>();
  const facts: string[] = [];
  let current = error;

  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const value = Reflect.get(current, field);
    if (typeof value === 'string') {
      facts.push(value);
    }
    current = Reflect.get(current, 'cause');
  }

  return facts;
}

async function expectImmutableRejection(
  operation: () => Promise<unknown>,
  expectedMessage: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(postgresErrorFacts(error, 'code')).toContain('55000');
    expect(postgresErrorFacts(error, 'message').join('\n')).toMatch(
      expectedMessage,
    );
    return;
  }

  throw new Error('Expected PostgreSQL to reject a roster truth mutation.');
}

async function insertAtomicSyncEvidence(
  database: PostgresDatabase,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into roster_sync_results (
        id,
        source_configuration_id,
        source_configuration_version,
        population,
        outcome,
        started_at,
        completed_at,
        expected_source_count,
        completed_source_count,
        group_failure_count,
        published_snapshot_id
      )
      values (
        ${ids.completeSync}::uuid,
        ${ids.configuration}::uuid,
        1,
        'synthetic'::roster_population,
        'complete'::roster_sync_outcome,
        now(),
        now(),
        3,
        3,
        0,
        ${ids.snapshot}::uuid
      )
      on conflict do nothing
    `);

    for (const group of rosterGroups) {
      await transaction.execute(sql`
        insert into roster_sync_result_sources (
          sync_result_id,
          population,
          group_source_id,
          group_source_kind,
          group_purpose,
          set_kind,
          expected_set_kind
        )
        values (
          ${ids.completeSync}::uuid,
          'synthetic'::roster_population,
          ${group.id}::uuid,
          'synthetic'::group_source_kind,
          ${group.purpose}::group_purpose,
          'expected'::group_completion_kind,
          'expected'::group_completion_kind
        )
        on conflict do nothing
      `);
    }
    for (const group of rosterGroups) {
      await transaction.execute(sql`
        insert into roster_sync_result_sources (
          sync_result_id,
          population,
          group_source_id,
          group_source_kind,
          group_purpose,
          set_kind,
          expected_set_kind
        )
        values (
          ${ids.completeSync}::uuid,
          'synthetic'::roster_population,
          ${group.id}::uuid,
          'synthetic'::group_source_kind,
          ${group.purpose}::group_purpose,
          'completed'::group_completion_kind,
          'expected'::group_completion_kind
        )
        on conflict do nothing
      `);
    }

    await transaction.execute(sql`
      insert into roster_sync_results (
        id,
        source_configuration_id,
        source_configuration_version,
        population,
        outcome,
        started_at,
        completed_at,
        expected_source_count,
        completed_source_count,
        group_failure_count,
        published_snapshot_id
      )
      values (
        ${ids.failedSync}::uuid,
        ${ids.configuration}::uuid,
        1,
        'synthetic'::roster_population,
        'failed'::roster_sync_outcome,
        now(),
        now(),
        3,
        0,
        3,
        null
      )
      on conflict do nothing
    `);

    for (const group of rosterGroups) {
      await transaction.execute(sql`
        insert into roster_sync_result_sources (
          sync_result_id,
          population,
          group_source_id,
          group_source_kind,
          group_purpose,
          set_kind,
          expected_set_kind
        )
        values (
          ${ids.failedSync}::uuid,
          'synthetic'::roster_population,
          ${group.id}::uuid,
          'synthetic'::group_source_kind,
          ${group.purpose}::group_purpose,
          'expected'::group_completion_kind,
          'expected'::group_completion_kind
        )
        on conflict do nothing
      `);
    }

    for (const [index, group] of rosterGroups.entries()) {
      const failureId = [ids.northFailure, ids.southFailure, ids.othersFailure][
        index
      ];
      if (failureId === undefined) {
        throw new Error('Every synthetic roster group requires a failure ID.');
      }
      await transaction.execute(sql`
        insert into roster_sync_group_failures (
          id,
          sync_result_id,
          population,
          group_source_id,
          group_source_kind,
          group_purpose,
          expected_set_kind,
          error_code,
          attempted_at
        )
        values (
          ${failureId}::uuid,
          ${ids.failedSync}::uuid,
          'synthetic'::roster_population,
          ${group.id}::uuid,
          'synthetic'::group_source_kind,
          ${group.purpose}::group_purpose,
          'expected'::group_completion_kind,
          'MOCK_GROUP_UNAVAILABLE',
          now()
        )
        on conflict do nothing
      `);
    }
  });
}

describeWithDatabase('published roster graph immutability', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }

    const createdConnection = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 2,
    });
    if (createdConnection.driver !== 'postgres') {
      throw new Error(
        'Roster integration tests require the direct PostgreSQL driver.',
      );
    }
    connection = createdConnection;

    await migrateDatabase(createdConnection);
    await seedDatabase(createdConnection.db);
    await insertAtomicSyncEvidence(createdConnection.db);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('allows atomic construction and idempotent no-op retries', async () => {
    const db = databaseConnection().db;

    await seedDatabase(db);
    await insertAtomicSyncEvidence(db);

    const rows = await db.execute<{
      endpoint_count: number;
      failure_count: number;
      recipient_count: number;
      snapshot_count: number;
      snapshot_source_count: number;
      sync_source_count: number;
    }>(sql`
      select
        (select count(*)::integer from roster_snapshots where id = ${ids.snapshot}::uuid) as snapshot_count,
        (select count(*)::integer from roster_snapshot_sources where roster_snapshot_id = ${ids.snapshot}::uuid) as snapshot_source_count,
        (select count(*)::integer from roster_recipients where roster_snapshot_id = ${ids.snapshot}::uuid) as recipient_count,
        (select count(*)::integer from roster_endpoints where roster_snapshot_id = ${ids.snapshot}::uuid) as endpoint_count,
        (select count(*)::integer from roster_sync_result_sources where sync_result_id in (${ids.completeSync}::uuid, ${ids.failedSync}::uuid)) as sync_source_count,
        (select count(*)::integer from roster_sync_group_failures where sync_result_id = ${ids.failedSync}::uuid) as failure_count
    `);

    expect(rows[0]).toEqual({
      endpoint_count: 12,
      failure_count: 3,
      recipient_count: 4,
      snapshot_count: 1,
      snapshot_source_count: 6,
      sync_source_count: 9,
    });
  });

  test('rejects updates throughout snapshot and sync-evidence truth', async () => {
    const db = databaseConnection().db;

    for (const operation of [
      () =>
        db.execute(sql`
          update roster_snapshots
          set captured_at = captured_at + interval '1 second'
          where id = ${ids.snapshot}::uuid
        `),
      () =>
        db.execute(sql`
          update roster_snapshot_facilities
          set facility_id = ${ids.missingFacility}::uuid
          where roster_snapshot_id = ${ids.snapshot}::uuid
            and facility_id = ${ids.facilityNorth}::uuid
        `),
      () =>
        db.execute(sql`
          update roster_snapshot_sources
          set group_purpose = 'others'::group_purpose
          where roster_snapshot_id = ${ids.snapshot}::uuid
            and group_source_id = ${ids.groupNorth}::uuid
            and completion_kind = 'expected'::group_completion_kind
        `),
      () =>
        db.execute(sql`
          update roster_recipients
          set display_name = 'Rewritten Recipient'
          where roster_snapshot_id = ${ids.snapshot}::uuid
            and id = ${ids.recipientNorthTwo}::uuid
        `),
      () =>
        db.execute(sql`
          update roster_recipient_group_sources
          set group_purpose = 'others'::group_purpose
          where roster_snapshot_id = ${ids.snapshot}::uuid
            and recipient_id = ${ids.recipientNorthTwo}::uuid
            and group_source_id = ${ids.groupNorth}::uuid
        `),
      () =>
        db.execute(sql`
          update roster_endpoints
          set status = 'disabled'::endpoint_status
          where roster_snapshot_id = ${ids.snapshot}::uuid
            and id = ${ids.endpointNorthTwoEmail}::uuid
        `),
      () =>
        db.execute(sql`
          update roster_sync_results
          set completed_at = completed_at + interval '1 second'
          where id = ${ids.completeSync}::uuid
        `),
      () =>
        db.execute(sql`
          update roster_sync_result_sources
          set group_purpose = 'others'::group_purpose
          where sync_result_id = ${ids.completeSync}::uuid
            and group_source_id = ${ids.groupNorth}::uuid
            and set_kind = 'expected'::group_completion_kind
        `),
      () =>
        db.execute(sql`
          update roster_sync_group_failures
          set error_code = 'REWRITTEN_FAILURE'
          where id = ${ids.northFailure}::uuid
        `),
    ]) {
      await expectImmutableRejection(
        async () => operation(),
        /immutable truth cannot be changed/u,
      );
    }
  });

  test('rejects new child rows after a snapshot or sync result commits', async () => {
    const db = databaseConnection().db;

    for (const operation of [
      () =>
        db.execute(sql`
          insert into roster_snapshot_facilities (roster_snapshot_id, facility_id)
          values (${ids.snapshot}::uuid, ${ids.missingFacility}::uuid)
        `),
      () =>
        db.execute(sql`
          insert into roster_snapshot_sources (
            roster_snapshot_id,
            population,
            group_source_id,
            group_source_kind,
            group_purpose,
            completion_kind
          )
          values (
            ${ids.snapshot}::uuid,
            'synthetic'::roster_population,
            ${ids.missingGroup}::uuid,
            'synthetic'::group_source_kind,
            'building'::group_purpose,
            'expected'::group_completion_kind
          )
        `),
      () =>
        db.execute(sql`
          insert into roster_recipients (
            id,
            roster_snapshot_id,
            population,
            google_subject,
            display_name
          )
          values (
            ${ids.lateRecipient}::uuid,
            ${ids.snapshot}::uuid,
            'synthetic'::roster_population,
            null,
            'Late Recipient'
          )
        `),
      () =>
        db.execute(sql`
          insert into roster_recipient_group_sources (
            roster_snapshot_id,
            recipient_id,
            population,
            group_source_id,
            group_source_kind,
            group_purpose
          )
          values (
            ${ids.snapshot}::uuid,
            ${ids.recipientNorthTwo}::uuid,
            'synthetic'::roster_population,
            ${ids.groupOthers}::uuid,
            'synthetic'::group_source_kind,
            'others'::group_purpose
          )
        `),
      () =>
        db.execute(sql`
          insert into roster_endpoints (
            id,
            roster_snapshot_id,
            recipient_id,
            population,
            channel,
            status,
            captured_at,
            email
          )
          values (
            ${ids.lateEndpoint}::uuid,
            ${ids.snapshot}::uuid,
            ${ids.recipientNorthTwo}::uuid,
            'synthetic'::roster_population,
            'email'::notification_channel,
            'active'::endpoint_status,
            now(),
            'late-recipient@example.invalid'
          )
        `),
      () =>
        db.execute(sql`
          insert into roster_sync_result_sources (
            sync_result_id,
            population,
            group_source_id,
            group_source_kind,
            group_purpose,
            set_kind,
            expected_set_kind
          )
          values (
            ${ids.completeSync}::uuid,
            'synthetic'::roster_population,
            ${ids.missingGroup}::uuid,
            'synthetic'::group_source_kind,
            'building'::group_purpose,
            'expected'::group_completion_kind,
            'expected'::group_completion_kind
          )
        `),
      () =>
        db.execute(sql`
          insert into roster_sync_group_failures (
            id,
            sync_result_id,
            population,
            group_source_id,
            group_source_kind,
            group_purpose,
            expected_set_kind,
            error_code,
            attempted_at
          )
          values (
            ${ids.lateFailure}::uuid,
            ${ids.failedSync}::uuid,
            'synthetic'::roster_population,
            ${ids.groupNorth}::uuid,
            'synthetic'::group_source_kind,
            'building'::group_purpose,
            'expected'::group_completion_kind,
            'LATE_FAILURE',
            now()
          )
        `),
    ]) {
      await expectImmutableRejection(
        async () => operation(),
        /cannot accept new/u,
      );
    }
  });

  test('freezes a roster source configuration after atomic construction', async () => {
    const db = databaseConnection().db;

    for (const operation of [
      () =>
        db.execute(sql`
          update roster_source_configurations
          set created_at = created_at + interval '1 second'
          where id = ${ids.configuration}::uuid
            and version = 1
        `),
      () =>
        db.execute(sql`
          update roster_source_configuration_facilities
          set facility_id = ${ids.missingFacility}::uuid
          where configuration_id = ${ids.configuration}::uuid
            and configuration_version = 1
            and facility_id = ${ids.facilityNorth}::uuid
        `),
      () =>
        db.execute(sql`
          update roster_source_configuration_groups
          set group_purpose = 'others'::group_purpose
          where configuration_id = ${ids.configuration}::uuid
            and configuration_version = 1
            and group_source_id = ${ids.groupNorth}::uuid
        `),
    ]) {
      await expectImmutableRejection(
        async () => operation(),
        /immutable truth cannot be changed/u,
      );
    }

    for (const operation of [
      () =>
        db.execute(sql`
          insert into roster_source_configuration_facilities (
            configuration_id,
            configuration_version,
            facility_id
          )
          values (
            ${ids.configuration}::uuid,
            1,
            ${ids.missingFacility}::uuid
          )
        `),
      () =>
        db.execute(sql`
          insert into roster_source_configuration_groups (
            configuration_id,
            configuration_version,
            population,
            group_source_id,
            group_source_kind,
            group_purpose
          )
          values (
            ${ids.configuration}::uuid,
            1,
            'synthetic'::roster_population,
            ${ids.missingGroup}::uuid,
            'synthetic'::group_source_kind,
            'building'::group_purpose
          )
        `),
    ]) {
      await expectImmutableRejection(
        async () => operation(),
        /cannot accept new/u,
      );
    }
  });

  test('rejects group-source identity and facility-binding mutation', async () => {
    const db = databaseConnection().db;

    for (const operation of [
      () =>
        db.execute(sql`
          update group_sources
          set facility_id = ${ids.missingFacility}::uuid
          where id = ${ids.groupNorth}::uuid
        `),
      () =>
        db.execute(sql`
          update group_sources
          set fixture_key = 'rewritten-provider-locator'
          where id = ${ids.groupNorth}::uuid
        `),
    ]) {
      await expectImmutableRejection(
        async () => operation(),
        /provider locator, status, and presentation are immutable/u,
      );
    }
  });

  test('keeps access-group status and provider configuration mutable', async () => {
    const db = databaseConnection().db;
    await db.execute(sql`
      insert into group_sources (
        id, kind, purpose, facility_id, display_name, active,
        google_group_id, email, fixture_key, created_at
      ) values (
        ${ids.configurableAccessGroup}::uuid,
        'google-group'::group_source_kind,
        'access'::group_purpose,
        null,
        'Synthetic configurable access group',
        true,
        'synthetic-configurable-access-primary',
        'synthetic-configurable-access-primary@example.invalid',
        null,
        now()
      )
      on conflict do nothing
    `);
    const originalRows = await db.execute<{
      active: boolean;
      email: string;
      google_group_id: string;
    }>(sql`
      select active, email, google_group_id
      from group_sources
      where id = ${ids.configurableAccessGroup}::uuid
    `);
    const original = originalRows[0];
    if (original === undefined) {
      throw new Error('The configurable access-group fixture is missing.');
    }

    const updatedRows = await db.execute<{
      active: boolean;
      email: string;
      google_group_id: string;
    }>(sql`
      update group_sources
      set
        active = ${!original.active},
        google_group_id = 'synthetic-configurable-access-alternate',
        email = 'synthetic-configurable-access-alternate@example.invalid'
      where id = ${ids.configurableAccessGroup}::uuid
      returning active, email, google_group_id
    `);
    expect(
      updatedRows.map((row) => ({
        active: row.active,
        email: row.email,
        google_group_id: row.google_group_id,
      })),
    ).toEqual([
      {
        active: !original.active,
        email: 'synthetic-configurable-access-alternate@example.invalid',
        google_group_id: 'synthetic-configurable-access-alternate',
      },
    ]);

    await db.execute(sql`
      update group_sources
      set
        active = ${original.active},
        google_group_id = ${original.google_group_id},
        email = ${original.email}
      where id = ${ids.configurableAccessGroup}::uuid
    `);
  });

  test('enforces monotonic snapshot versions at the database boundary', async () => {
    const db = databaseConnection().db;

    await expectImmutableRejection(
      async () =>
        db.transaction(async (transaction) => {
          await transaction.execute(sql`
            select pg_advisory_xact_lock(
              hashtextextended('psd-eoc-roster-synthetic', 0)
            )
          `);
          const latest = await transaction.execute<{
            source_configuration_id: string;
            source_configuration_version: number;
            version: number;
          }>(sql`
            select
              version,
              source_configuration_id::text as source_configuration_id,
              source_configuration_version
            from roster_snapshots
            where population = 'synthetic'::roster_population
            order by version desc
            limit 1
          `);
          const row = latest[0];
          if (row === undefined) {
            throw new Error('The synthetic snapshot baseline is missing.');
          }
          await transaction.execute(sql`
            insert into roster_snapshots (
              id, version, population, complete,
              source_configuration_id, source_configuration_version,
              sync_started_at, captured_at
            ) values (
              ${ids.nonSequentialSnapshot}::uuid,
              ${row.version},
              'synthetic'::roster_population,
              true,
              ${row.source_configuration_id}::uuid,
              ${row.source_configuration_version},
              now(),
              now()
            )
          `);
        }),
      /must advance beyond/u,
    );
  });

  test('rejects an ambiguous source-configuration lineage at the database boundary', async () => {
    const db = databaseConnection().db;

    await expectImmutableRejection(
      async () =>
        db.transaction(async (transaction) => {
          const latest = await transaction.execute<{ version: number }>(sql`
            select version
            from roster_snapshots
            where population = 'synthetic'::roster_population
            order by version desc
            limit 1
          `);
          const row = latest[0];
          if (row === undefined) {
            throw new Error('The synthetic snapshot baseline is missing.');
          }
          await transaction.execute(sql`
            insert into roster_source_configurations (
              id, version, population, created_at
            ) values (
              ${ids.ambiguousConfiguration}::uuid,
              1,
              'synthetic'::roster_population,
              now()
            )
          `);
          await transaction.execute(sql`
            insert into roster_snapshots (
              id, version, population, complete,
              source_configuration_id, source_configuration_version,
              sync_started_at, captured_at
            ) values (
              ${ids.ambiguousSnapshot}::uuid,
              ${row.version + 1},
              'synthetic'::roster_population,
              true,
              ${ids.ambiguousConfiguration}::uuid,
              1,
              now(),
              now()
            )
          `);
        }),
      /configuration lineage cannot change/u,
    );
  });

  test('removes update and delete privileges from immutable roster truth', async () => {
    const db = databaseConnection().db;
    const privilegeRows = await db.execute<{
      can_delete: boolean;
      can_update: boolean;
      table_name: string;
    }>(sql`
      select
        table_name,
        has_table_privilege('psd_eoc_app', table_name, 'UPDATE') as can_update,
        has_table_privilege('psd_eoc_app', table_name, 'DELETE') as can_delete
      from unnest(array[
        'roster_source_configurations',
        'roster_source_configuration_facilities',
        'roster_source_configuration_groups',
        'roster_snapshots',
        'roster_snapshot_facilities',
        'roster_snapshot_sources',
        'roster_recipients',
        'roster_recipient_group_sources',
        'roster_endpoints',
        'roster_sync_results',
        'roster_sync_result_sources',
        'roster_sync_group_failures'
      ]::text[]) as immutable_roster_tables(table_name)
      order by table_name
    `);

    expect(privilegeRows).toHaveLength(12);
    expect(
      privilegeRows.every(
        (row) => row.can_update === false && row.can_delete === false,
      ),
    ).toBe(true);
  });
});
