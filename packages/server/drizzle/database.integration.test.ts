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
} from '../db/client';
import { seedDatabase, type SeedSummary } from '../db/seed';
import { migrateDatabase } from './migrate';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;
let firstSeedSummary: SeedSummary | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The PostgreSQL integration-test connection is not open.');
  }
  return connection;
}

function findPostgresConstraintName(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  let current = error;

  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const constraintName = Reflect.get(current, 'constraint_name');
    if (typeof constraintName === 'string') {
      return constraintName;
    }
    current = Reflect.get(current, 'cause');
  }

  return undefined;
}

function postgresErrorMessages(error: unknown): readonly string[] {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const message = Reflect.get(current, 'message');
    if (typeof message === 'string') {
      messages.push(message);
    }
    current = Reflect.get(current, 'cause');
  }
  return messages;
}

async function expectConstraintViolation(
  operation: () => Promise<unknown>,
  expectedConstraintName: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(findPostgresConstraintName(error)).toBe(expectedConstraintName);
    return;
  }

  throw new Error(
    `Expected PostgreSQL constraint ${expectedConstraintName} to reject the operation.`,
  );
}

const insertSyntheticTestEvent = sql`
  insert into events (
    id,
    facility_id,
    kind,
    template_mode,
    event_type_version_id,
    status,
    roster_snapshot_id,
    roster_population,
    created_by,
    created_at,
    activated_at,
    activation_authorization
  )
  select
    '00000000-0000-4000-8000-000000009980'::uuid,
    facility.id,
    'test'::event_kind,
    'drill'::template_mode,
    version.id,
    'active'::event_status,
    snapshot.id,
    'synthetic'::roster_population,
    '{"kind":"system","serviceId":"database-test"}'::jsonb,
    now(),
    now(),
    jsonb_build_object(
      'kind', 'synthetic-training',
      'activationPreviewId', '00000000-0000-4000-8000-000000009979',
      'consequenceDigest', repeat('d', 64),
      'requestId', '00000000-0000-4000-8000-000000009982'
    )
  from facilities as facility
  cross join roster_snapshots as snapshot
  cross join event_type_versions as version
  join event_types as event_type on event_type.id = version.event_type_id
  where facility.code = 'SYN-NORTH'
    and snapshot.population = 'synthetic'
    and event_type.key = 'lockdown-drill'
`;

describeWithDatabase('fresh PostgreSQL migration and synthetic seed', () => {
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
        'Integration tests require the direct PostgreSQL driver.',
      );
    }
    connection = createdConnection;

    await migrateDatabase(createdConnection);
    firstSeedSummary = await seedDatabase(createdConnection.db);
    expect(await seedDatabase(createdConnection.db)).toEqual(firstSeedSummary);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('creates required outbox columns and non-null classification columns', async () => {
    const db = databaseConnection().db;
    const outboxColumns = await db.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'outbox'
        and column_name in ('status', 'locked_until', 'attempts')
      order by column_name
    `);
    expect(outboxColumns.map((row) => row.column_name)).toEqual([
      'attempts',
      'locked_until',
      'status',
    ]);

    const nullableClassifications = await db.execute<{
      table_name: string;
      column_name: string;
    }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and is_nullable = 'YES'
        and (
          column_name in (
            'event_kind',
            'template_mode',
            'classification_marker'
          )
          or (
            column_name = 'kind'
            and table_name in (
              'activation_previews',
              'events',
              'event_transitions',
              'lifecycle_consequence_previews'
            )
          )
        )
    `);
    expect(nullableClassifications).toHaveLength(0);

    const discriminatorCount = await db.execute<{ count: number }>(sql`
      select count(*)::integer as count
      from information_schema.columns
      where table_schema = 'public'
        and column_name in (
          'event_kind',
          'template_mode',
          'classification_marker'
        )
    `);
    expect(discriminatorCount[0]?.count).toBeGreaterThanOrEqual(12);
  });

  test('anchors media allocation identity and installs every bounded-read index', async () => {
    const db = databaseConnection().db;
    const mediaColumns = await db.execute<{
      column_name: string;
      column_default: string | null;
      is_nullable: string;
    }>(sql`
      select column_name, column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'media_upload_intents'
        and column_name in (
          'facility_id',
          'budget_principal_digest',
          'budget_principal_attributed'
        )
      order by column_name
    `);
    expect([...mediaColumns]).toEqual([
      {
        column_name: 'budget_principal_attributed',
        column_default: 'true',
        is_nullable: 'NO',
      },
      {
        column_name: 'budget_principal_digest',
        column_default: null,
        is_nullable: 'NO',
      },
      {
        column_name: 'facility_id',
        column_default: null,
        is_nullable: 'NO',
      },
    ]);

    const constraints = await db.execute<{
      constraint_name: string;
      constraint_type: string;
    }>(sql`
      select constraint_name, constraint_type
      from information_schema.table_constraints
      where constraint_schema = 'public'
        and constraint_name in (
          'events_identity_facility_uq',
          'media_upload_intents_event_facility_fk',
          'media_upload_intents_budget_principal_digest_format',
          'media_upload_intents_budget_principal_attribution'
        )
      order by constraint_name
    `);
    expect([...constraints]).toEqual([
      {
        constraint_name: 'events_identity_facility_uq',
        constraint_type: 'UNIQUE',
      },
      {
        constraint_name: 'media_upload_intents_budget_principal_attribution',
        constraint_type: 'CHECK',
      },
      {
        constraint_name: 'media_upload_intents_budget_principal_digest_format',
        constraint_type: 'CHECK',
      },
      {
        constraint_name: 'media_upload_intents_event_facility_fk',
        constraint_type: 'FOREIGN KEY',
      },
    ]);

    const indexes = await db.execute<{
      indexdef: string;
      indexname: string;
    }>(sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'media_upload_intents_budget_principal_created_idx',
          'media_upload_intents_unattributed_created_idx',
          'media_upload_intents_event_active_idx',
          'media_upload_intents_event_created_idx',
          'media_upload_intents_facility_active_idx',
          'media_upload_intents_facility_created_idx',
          'journal_entries_event_media_idx',
          'journal_entries_event_redaction_target_idx'
        )
      order by indexname
    `);
    expect(indexes.map(({ indexname }) => indexname)).toEqual(
      [
        'journal_entries_event_media_idx',
        'journal_entries_event_redaction_target_idx',
        'media_upload_intents_budget_principal_created_idx',
        'media_upload_intents_event_active_idx',
        'media_upload_intents_event_created_idx',
        'media_upload_intents_facility_active_idx',
        'media_upload_intents_facility_created_idx',
        'media_upload_intents_unattributed_created_idx',
      ].sort(),
    );
    const photoBindingIndex = indexes.find(
      ({ indexname }) => indexname === 'journal_entries_event_media_idx',
    )?.indexdef;
    expect(photoBindingIndex).toContain('(event_id, media_id, id, sequence)');
    expect(photoBindingIndex).toContain(
      "WHERE (kind = 'photo'::journal_entry_kind)",
    );
    expect(
      indexes.find(
        ({ indexname }) =>
          indexname === 'journal_entries_event_redaction_target_idx',
      )?.indexdef,
    ).toContain(
      "WHERE (supersession_kind = 'redaction'::journal_supersession_kind)",
    );

    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          await transaction.execute(insertSyntheticTestEvent);
          await transaction.execute(sql`
            insert into media_upload_intents (
              id,
              event_id,
              facility_id,
              budget_principal_digest,
              budget_principal_attributed,
              byte_length,
              content_sha256,
              declared_content_type,
              storage_key,
              status,
              created_at,
              expires_at
            )
            select
              '00000000-0000-4000-8000-000000009969'::uuid,
              '00000000-0000-4000-8000-000000009980'::uuid,
              facility.id,
              repeat('f', 64),
              true,
              20,
              repeat('a', 64),
              'image/jpeg'::media_content_type,
              'quarantine/database-test/9969',
              'pending-upload',
              now(),
              now() + interval '10 minutes'
            from facilities as facility
            where facility.code = 'SYN-SOUTH'
          `);
        }),
      'media_upload_intents_event_facility_fk',
    );

    try {
      await db.transaction(async (transaction) => {
        await transaction.execute(insertSyntheticTestEvent);
        await transaction.execute(sql`
          insert into media_upload_intents (
            id,
            event_id,
            facility_id,
            budget_principal_digest,
            budget_principal_attributed,
            byte_length,
            content_sha256,
            declared_content_type,
            storage_key,
            status,
            created_at,
            expires_at
          )
          select
            '00000000-0000-4000-8000-000000009968'::uuid,
            event.id,
            event.facility_id,
            repeat('0', 64),
            false,
            20,
            repeat('a', 64),
            'image/jpeg'::media_content_type,
            'quarantine/database-test/9968',
            'pending-upload',
            now(),
            now() + interval '10 minutes'
          from events as event
          where event.id = '00000000-0000-4000-8000-000000009980'::uuid
        `);
      });
      throw new Error('Expected an unattributed media insert to be rejected.');
    } catch (error) {
      expect(postgresErrorMessages(error).join('\n')).toContain(
        'new media upload intents require an attributed budget principal',
      );
    }
  });

  test('revokes and rejects mutation of append-only truth tables', async () => {
    const db = databaseConnection().db;
    const privileges = await db.execute<{
      table_name: string;
      can_update: boolean;
      can_delete: boolean;
    }>(sql`
      select
        table_name,
        has_table_privilege(
          'psd_eoc_app',
          format('%I.%I', 'public', table_name),
          'UPDATE'
        ) as can_update,
        has_table_privilege(
          'psd_eoc_app',
          format('%I.%I', 'public', table_name),
          'DELETE'
        ) as can_delete
      from (
        values
          ('journal_entries'),
          ('media_records'),
          ('channel_attempts'),
          ('delivery_evidence')
      ) as immutable_tables(table_name)
      order by table_name
    `);
    expect(privileges).toHaveLength(4);
    expect(privileges.every((row) => !row.can_update && !row.can_delete)).toBe(
      true,
    );

    const triggerEvents = await db.execute<{
      event_object_table: string;
      event_manipulation: string;
    }>(sql`
      select event_object_table, event_manipulation
      from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table in (
          'journal_entries',
          'media_records',
          'channel_attempts',
          'delivery_evidence'
        )
    `);
    for (const tableName of [
      'journal_entries',
      'media_records',
      'channel_attempts',
      'delivery_evidence',
    ]) {
      const events = triggerEvents
        .filter((row) => row.event_object_table === tableName)
        .map((row) => row.event_manipulation);
      expect(events).toContain('UPDATE');
      expect(events).toContain('DELETE');
    }

    async function expectMediaMutationRejected(
      mutation: 'update' | 'delete',
    ): Promise<void> {
      try {
        await db.transaction(async (transaction) => {
          await transaction.execute(insertSyntheticTestEvent);
          await transaction.execute(sql`
            insert into media_upload_intents (
              id,
              event_id,
              facility_id,
              budget_principal_digest,
              budget_principal_attributed,
              byte_length,
              content_sha256,
              declared_content_type,
              storage_key,
              status,
              created_at,
              expires_at
            ) values (
              '00000000-0000-4000-8000-000000009970'::uuid,
              '00000000-0000-4000-8000-000000009980'::uuid,
              (
                select facility_id
                from events
                where id = '00000000-0000-4000-8000-000000009980'::uuid
              ),
              repeat('e', 64),
              true,
              20,
              repeat('a', 64),
              'image/jpeg'::media_content_type,
              'quarantine/database-test/9970',
              'pending-upload',
              now(),
              now() + interval '10 minutes'
            )
          `);
          await transaction.execute(sql`
            insert into media_records (
              id,
              upload_intent_id,
              event_id,
              status,
              detected_content_type,
              sanitized_byte_length,
              sanitized_content_sha256,
              storage_key,
              malware_scan,
              exif_stripped,
              created_at
            ) values (
              '00000000-0000-4000-8000-000000009971'::uuid,
              '00000000-0000-4000-8000-000000009970'::uuid,
              '00000000-0000-4000-8000-000000009980'::uuid,
              'ready',
              'image/jpeg'::media_content_type,
              20,
              repeat('b', 64),
              'ready/database-test/9971',
              'clean',
              true,
              now()
            )
          `);
          await transaction.execute(
            mutation === 'update'
              ? sql`
                  update media_records
                  set sanitized_content_sha256 = repeat('c', 64)
                  where id = '00000000-0000-4000-8000-000000009971'::uuid
                `
              : sql`
                  delete from media_records
                  where id = '00000000-0000-4000-8000-000000009971'::uuid
                `,
          );
        });
      } catch (error) {
        expect(postgresErrorMessages(error).join('\n')).toContain(
          'immutable truth cannot be changed on media_records',
        );
        return;
      }
      throw new Error(`Expected the media record ${mutation} to be rejected.`);
    }

    await expectMediaMutationRejected('update');
    await expectMediaMutationRejected('delete');
  });

  test('database constraints reject real and drill substitution', async () => {
    const db = databaseConnection().db;

    await expect(
      Promise.resolve(
        db.execute(sql`
        insert into event_type_versions (
          id,
          event_type_id,
          version,
          template_mode,
          name,
          enabled,
          created_by,
          publication_authorization,
          created_at
        )
        select
          '00000000-0000-4000-8000-000000009999'::uuid,
          id,
          999,
          'drill'::template_mode,
          'Invalid mixed-mode version',
          true,
          '{"kind":"system","serviceId":"database-test"}'::jsonb,
          '{"kind":"repository-seed","approvalReference":"invalid-test"}'::jsonb,
          now()
        from event_types
        where key = 'lockdown'
      `),
      ),
    ).rejects.toThrow();

    await expect(
      Promise.resolve(
        db.execute(sql`
        update event_types
        set template_mode = 'drill'
        where key = 'lockdown'
      `),
      ),
    ).rejects.toThrow();
  });

  test('rejects worker JSON that omits required classification fields', async () => {
    const db = databaseConnection().db;

    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          await transaction.execute(insertSyntheticTestEvent);

          await transaction.execute(sql`
          insert into notification_intents (
            id,
            event_id,
            event_kind,
            template_mode,
            purpose,
            event_type_version_id,
            roster_snapshot_id,
            roster_population,
            audience_config_id,
            audience_config_version,
            created_by,
            source,
            request_id,
            "authorization",
            created_at
          )
          select
            '00000000-0000-4000-8000-000000009981'::uuid,
            event.id,
            event.kind,
            event.template_mode,
            'activation'::notification_purpose,
            event.event_type_version_id,
            event.roster_snapshot_id,
            event.roster_population,
            audience.id,
            audience.version,
            '{"kind":"system","serviceId":"database-test"}'::jsonb,
            'worker'::invocation_source,
            '00000000-0000-4000-8000-000000009982'::uuid,
            jsonb_build_object(
              'kind', 'synthetic-training',
              'activationPreviewId',
                '00000000-0000-4000-8000-000000009979',
              'consequenceDigest', repeat('d', 64),
              'requestId', '00000000-0000-4000-8000-000000009982'
            ),
            now()
          from events as event
          join audience_configurations as audience
            on audience.facility_id = event.facility_id
          where event.id = '00000000-0000-4000-8000-000000009980'::uuid
        `);

          await transaction.execute(sql`
          insert into notification_intent_channels (
            intent_id,
            sequence,
            channel,
            event_kind,
            template_mode,
            purpose,
            roster_population,
            classification_marker,
            endpoint_count,
            rendered_message,
            integration_status_id,
            integration_id,
            integration_label
          )
          select
            intent.id,
            1,
            'push'::notification_channel,
            intent.event_kind,
            intent.template_mode,
            intent.purpose,
            intent.roster_population,
            'DRILL'::classification_marker,
            4,
            '{"channel":"push","eventKind":"test","purpose":"activation"}'::jsonb,
            integration.id,
            integration.integration_id,
            integration.label
          from notification_intents as intent
          join integration_statuses as integration
            on integration.integration_id = 'expo-push'
          where intent.id = '00000000-0000-4000-8000-000000009981'::uuid
        `);
        }),
      'notification_intent_channels_rendered_truth',
    );
  });

  test('pins notification and lifecycle rows to the event type and roster', async () => {
    const db = databaseConnection().db;

    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          await transaction.execute(insertSyntheticTestEvent);
          await transaction.execute(sql`
            insert into notification_intents (
              id,
              event_id,
              event_kind,
              template_mode,
              purpose,
              event_type_version_id,
              roster_snapshot_id,
              roster_population,
              audience_config_id,
              audience_config_version,
              created_by,
              source,
              request_id,
              "authorization",
              created_at
            )
            select
              '00000000-0000-4000-8000-000000009984'::uuid,
              event.id,
              event.kind,
              event.template_mode,
              'activation'::notification_purpose,
              mismatched_version.id,
              event.roster_snapshot_id,
              event.roster_population,
              audience.id,
              audience.version,
              '{"kind":"system","serviceId":"database-test"}'::jsonb,
              'worker'::invocation_source,
              '00000000-0000-4000-8000-000000009985'::uuid,
              jsonb_build_object(
                'kind', 'synthetic-training',
                'activationPreviewId',
                  '00000000-0000-4000-8000-000000009979',
                'consequenceDigest', repeat('d', 64),
                'requestId', '00000000-0000-4000-8000-000000009985'
              ),
              now()
            from events as event
            join audience_configurations as audience
              on audience.facility_id = event.facility_id
            cross join event_type_versions as mismatched_version
            join event_types as mismatched_type
              on mismatched_type.id = mismatched_version.event_type_id
            where event.id = '00000000-0000-4000-8000-000000009980'::uuid
              and mismatched_type.key = 'medical-drill'
          `);
        }),
      'notification_intents_event_truth_fk',
    );

    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          await transaction.execute(insertSyntheticTestEvent);
          await transaction.execute(sql`
            insert into lifecycle_consequence_previews (
              id,
              event_id,
              purpose,
              kind,
              template_mode,
              event_type_version_id,
              roster_snapshot_id,
              roster_population,
              audience_config_id,
              audience_config_version,
              recipient_count,
              channels,
              send_readiness,
              blocking_reason_codes,
              consequence_digest,
              created_at,
              expires_at
            )
            select
              '00000000-0000-4000-8000-000000009986'::uuid,
              event.id,
              'all-clear'::notification_purpose,
              event.kind,
              event.template_mode,
              mismatched_version.id,
              event.roster_snapshot_id,
              event.roster_population,
              audience.id,
              audience.version,
              4,
              '[]'::jsonb,
              'ready',
              '[]'::jsonb,
              repeat('e', 64),
              now(),
              now() + interval '5 minutes'
            from events as event
            join audience_configurations as audience
              on audience.facility_id = event.facility_id
            cross join event_type_versions as mismatched_version
            join event_types as mismatched_type
              on mismatched_type.id = mismatched_version.event_type_id
            where event.id = '00000000-0000-4000-8000-000000009980'::uuid
              and mismatched_type.key = 'medical-drill'
          `);
        }),
      'lifecycle_consequence_previews_event_truth_fk',
    );
  });

  test('rejects terminal-state rollback for idempotency, outbox, and human confirmation records', async () => {
    const db = databaseConnection().db;

    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`
          insert into idempotency_records (
            id,
            key,
            capability_id,
            principal,
            principal_digest,
            request_digest,
            status,
            created_at
          ) values (
            '00000000-0000-4000-8000-000000009990'::uuid,
            'database-test-key-0001',
            'sync-roster'::mutation_capability,
            '{"kind":"system","serviceId":"database-test"}'::jsonb,
            repeat('a', 64),
            repeat('b', 64),
            'in-progress'::idempotency_status,
            now()
          )
        `);
        await transaction.execute(sql`
          update idempotency_records
          set
            status = 'completed',
            completed_at = now(),
            result_reference = 'synthetic-result'
          where id = '00000000-0000-4000-8000-000000009990'::uuid
        `);
        await transaction.execute(sql`
          update idempotency_records
          set
            status = 'in-progress',
            completed_at = null,
            result_reference = null
          where id = '00000000-0000-4000-8000-000000009990'::uuid
        `);
      }),
    ).rejects.toThrow();
    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`
          create temporary table outbox_guard_probe (
            id uuid primary key,
            payload jsonb not null,
            status outbox_status not null,
            attempts integer not null,
            available_at timestamptz not null,
            locked_until timestamptz,
            published_at timestamptz,
            failed_at timestamptz,
            last_error_code text
          ) on commit drop
        `);
        await transaction.execute(sql`
          create trigger outbox_guard_probe_trigger
          before update on outbox_guard_probe
          for each row execute function psd_eoc_guard_outbox_mutation()
        `);
        await transaction.execute(sql`
          insert into outbox_guard_probe values (
            '00000000-0000-4000-8000-000000009991'::uuid,
            '{"classification":"immutable"}'::jsonb,
            'published',
            1,
            now(),
            null,
            now(),
            null,
            null
          )
        `);
        await transaction.execute(sql`
          update outbox_guard_probe
          set status = 'pending', published_at = null
          where id = '00000000-0000-4000-8000-000000009991'::uuid
        `);
      }),
    ).rejects.toThrow();

    await expect(
      db.transaction(async (transaction) => {
        await transaction.execute(sql`
          create temporary table confirmation_guard_probe (
            id uuid primary key,
            consequence_digest text not null,
            status human_confirmation_status not null,
            consumed_at timestamptz,
            consumed_for_request_id uuid,
            expired_at timestamptz
          ) on commit drop
        `);
        await transaction.execute(sql`
          create trigger confirmation_guard_probe_trigger
          before update on confirmation_guard_probe
          for each row execute function psd_eoc_guard_confirmation_mutation()
        `);
        await transaction.execute(sql`
          insert into confirmation_guard_probe values (
            '00000000-0000-4000-8000-000000009992'::uuid,
            repeat('c', 64),
            'consumed',
            now(),
            '00000000-0000-4000-8000-000000009993'::uuid,
            null
          )
        `);
        await transaction.execute(sql`
          update confirmation_guard_probe
          set
            status = 'issued',
            consumed_at = null,
            consumed_for_request_id = null
          where id = '00000000-0000-4000-8000-000000009992'::uuid
        `);
      }),
    ).rejects.toThrow();
  });

  test('loads a complete, inert, and fully synthetic district', async () => {
    expect(firstSeedSummary).toEqual({
      facilities: 2,
      neighborhoods: 1,
      neighborhoodFacilities: 2,
      audienceConfigurations: 2,
      audienceTargets: 6,
      groupSources: 3,
      rosterSourceConfigurations: 1,
      rosterSnapshots: 1,
      rosterRecipients: 4,
      rosterEndpoints: 12,
      eventTypes: 8,
      eventTypeVersions: 8,
      eventTypeTemplates: 72,
      integrationStatuses: 5,
      channelConfigurations: 3,
      events: 0,
      outboxMessages: 0,
    });

    const db = databaseConnection().db;
    const counts = await db.execute<{
      facilities: number;
      neighborhoods: number;
      neighborhood_facilities: number;
      roster_recipients: number;
      roster_endpoints: number;
      event_types: number;
      event_type_templates: number;
      events: number;
      notification_intents: number;
      outbox_messages: number;
    }>(sql`
      select
        (select count(*)::integer from facilities) as facilities,
        (select count(*)::integer from neighborhood_versions) as neighborhoods,
        (select count(*)::integer from neighborhood_facilities) as neighborhood_facilities,
        (select count(*)::integer from roster_recipients) as roster_recipients,
        (select count(*)::integer from roster_endpoints) as roster_endpoints,
        (select count(*)::integer from event_types) as event_types,
        (select count(*)::integer from event_type_templates) as event_type_templates,
        (select count(*)::integer from events) as events,
        (select count(*)::integer from notification_intents) as notification_intents,
        (select count(*)::integer from outbox) as outbox_messages
    `);
    expect(counts[0]).toEqual({
      facilities: 2,
      neighborhoods: 1,
      neighborhood_facilities: 2,
      roster_recipients: 4,
      roster_endpoints: 12,
      event_types: 8,
      event_type_templates: 72,
      events: 0,
      notification_intents: 0,
      outbox_messages: 0,
    });

    const invalidSyntheticEndpoints = await db.execute<{ count: number }>(sql`
      select count(*)::integer as count
      from roster_endpoints
      where population = 'synthetic'
        and not (
          (channel = 'push' and token like 'synthetic-unroutable:%')
          or (channel = 'email' and lower(email) like '%.invalid')
          or (channel = 'sms' and phone_number ~ '^\\+120255501[0-9]{2}$')
        )
    `);
    expect(invalidSyntheticEndpoints[0]?.count).toBe(0);

    const unsafeIntegrationState = await db.execute<{ count: number }>(sql`
      select (
        (select count(*) from integration_statuses where label = 'live-verified')
        +
        (select count(*) from channel_configurations where enabled = true)
      )::integer as count
    `);
    expect(unsafeIntegrationState[0]?.count).toBe(0);

    const templateCoverage = await db.execute<{
      template_mode: string;
      purpose: string;
      channel: string;
      count: number;
    }>(sql`
      select template_mode, purpose, channel, count(*)::integer as count
      from event_type_templates
      group by template_mode, purpose, channel
      order by template_mode, purpose, channel
    `);
    expect(templateCoverage).toHaveLength(18);
    expect(templateCoverage.every((row) => row.count === 4)).toBe(true);

    const northFacility = await db.query.facilities.findFirst({
      where: (facility, { eq }) => eq(facility.code, 'SYN-NORTH'),
      with: {
        neighborhoodMemberships: {
          with: { neighborhoodVersion: true },
        },
        audienceConfigurations: {
          with: { targets: true },
        },
      },
    });
    expect(northFacility?.neighborhoodMemberships).toHaveLength(1);
    expect(
      northFacility?.neighborhoodMemberships[0]?.neighborhoodVersion.name,
    ).toBe('Synthetic Twin Campuses');
    expect(northFacility?.audienceConfigurations[0]?.targets).toHaveLength(3);
  });
});
