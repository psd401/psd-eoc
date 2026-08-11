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

function findPostgresErrorMessage(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  let current = error;
  let deepestMessage: string | undefined;

  while (
    typeof current === 'object' &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const message = Reflect.get(current, 'message');
    if (typeof message === 'string') {
      deepestMessage = message;
    }
    current = Reflect.get(current, 'cause');
  }

  return deepestMessage;
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

async function expectPostgresRejection(
  operation: () => Promise<unknown>,
  expectedMessage: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(findPostgresErrorMessage(error)).toMatch(expectedMessage);
    return;
  }

  throw new Error(
    `Expected PostgreSQL to reject the operation with ${String(expectedMessage)}.`,
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

const syntheticAdminEvidencePrerequisites = [
  sql`
    insert into users (
      id,
      google_subject,
      email,
      display_name,
      facility_scope_kind,
      created_at
    ) values (
      '00000000-0000-4000-8000-000000026001'::uuid,
      'synthetic-database-admin-evidence',
      'synthetic-database-admin-evidence@psd401.net',
      'Synthetic Database Admin Evidence',
      'district'::facility_scope_kind,
      '2026-08-10T16:00:00.000Z'::timestamptz
    )
  `,
  sql`
    insert into device_enrollments (
      id,
      user_id,
      platform,
      unlock_method,
      installation_id,
      enrolled_at,
      last_seen_at
    ) values (
      '00000000-0000-4000-8000-000000026002'::uuid,
      '00000000-0000-4000-8000-000000026001'::uuid,
      'web'::device_platform,
      'secure-session-cookie'::device_unlock_method,
      'synthetic-database-admin-evidence-installation',
      '2026-08-10T16:00:00.000Z'::timestamptz,
      '2026-08-10T16:00:00.000Z'::timestamptz
    )
  `,
  sql`
    insert into access_membership_snapshots (
      id,
      version,
      complete,
      sync_started_at,
      captured_at
    ) values (
      '00000000-0000-4000-8000-000000026003'::uuid,
      260026,
      true,
      '2026-08-10T15:59:00.000Z'::timestamptz,
      '2026-08-10T16:00:00.000Z'::timestamptz
    )
  `,
  sql`
    insert into access_membership_members (
      snapshot_id,
      user_id,
      google_subject,
      facility_scope_kind
    ) values (
      '00000000-0000-4000-8000-000000026003'::uuid,
      '00000000-0000-4000-8000-000000026001'::uuid,
      'synthetic-database-admin-evidence',
      'district'::facility_scope_kind
    )
  `,
  sql`
    insert into sessions (
      id,
      user_id,
      device_enrollment_id,
      membership_snapshot_id,
      membership_valid_until,
      membership_grace_until,
      created_at,
      expires_at
    ) values (
      '00000000-0000-4000-8000-000000026004'::uuid,
      '00000000-0000-4000-8000-000000026001'::uuid,
      '00000000-0000-4000-8000-000000026002'::uuid,
      '00000000-0000-4000-8000-000000026003'::uuid,
      '2026-08-10T17:00:00.000Z'::timestamptz,
      '2026-08-10T18:00:00.000Z'::timestamptz,
      '2026-08-10T16:00:00.000Z'::timestamptz,
      '2026-08-10T19:00:00.000Z'::timestamptz
    )
  `,
  sql`
    insert into integration_statuses (
      id,
      integration_id,
      label,
      verified_at,
      verified_by_user_id,
      authorization_reference,
      reason_code,
      observed_at
    ) values (
      '00000000-0000-4000-8000-000000026005'::uuid,
      'synthetic-database-evidence',
      'live-verified'::integration_truth_label,
      '2026-08-10T16:01:00.000Z'::timestamptz,
      '00000000-0000-4000-8000-000000026001'::uuid,
      repeat('a', 64),
      null,
      '2026-08-10T16:01:00.000Z'::timestamptz
    )
  `,
] as const;

const insertSyntheticRoleChange = sql`
  insert into user_role_changes (
    user_id,
    role,
    granted,
    changed_by_user_id,
    changed_with_session_id,
    request_id,
    occurred_at
  ) values (
    '00000000-0000-4000-8000-000000026001'::uuid,
    'admin'::role,
    true,
    '00000000-0000-4000-8000-000000026001'::uuid,
    '00000000-0000-4000-8000-000000026004'::uuid,
    '00000000-0000-4000-8000-000000026007'::uuid,
    '2026-08-10T16:02:00.000Z'::timestamptz
  )
`;

const insertSyntheticChannelChangeAuthorization = sql`
  insert into integration_channel_change_authorizations (
    id,
    reference,
    authorization_commitment,
    integration_status_id,
    integration_id,
    status_label,
    desired_enabled,
    request_digest,
    consequence_digest,
    authorized_by_user_id,
    authorized_with_session_id,
    issued_at,
    expires_at,
    consumed_by_user_id,
    consumed_with_session_id,
    consumed_request_id,
    consumed_at
  ) values (
    '00000000-0000-4000-8000-000000026006'::uuid,
    'synthetic-product-owner-evidence-26',
    repeat('a', 64),
    '00000000-0000-4000-8000-000000026005'::uuid,
    'synthetic-database-evidence',
    'live-verified'::integration_truth_label,
    false,
    repeat('b', 64),
    repeat('c', 64),
    '00000000-0000-4000-8000-000000026001'::uuid,
    '00000000-0000-4000-8000-000000026004'::uuid,
    '2026-08-10T16:01:00.000Z'::timestamptz,
    '2026-08-10T16:16:00.000Z'::timestamptz,
    '00000000-0000-4000-8000-000000026001'::uuid,
    '00000000-0000-4000-8000-000000026004'::uuid,
    '00000000-0000-4000-8000-000000026009'::uuid,
    '2026-08-10T16:02:00.000Z'::timestamptz
  )
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
          ('channel_attempts'),
          ('delivery_evidence')
      ) as immutable_tables(table_name)
      order by table_name
    `);
    expect(privileges).toHaveLength(3);
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
          'channel_attempts',
          'delivery_evidence'
        )
    `);
    for (const tableName of [
      'journal_entries',
      'channel_attempts',
      'delivery_evidence',
    ]) {
      const events = triggerEvents
        .filter((row) => row.event_object_table === tableName)
        .map((row) => row.event_manipulation);
      expect(events).toContain('UPDATE');
      expect(events).toContain('DELETE');
    }
  });

  test('creates the append-only role-change and live-channel authorization schema', async () => {
    const db = databaseConnection().db;
    const [consumedAtColumn] = await db.execute<{
      column_default: string | null;
      is_nullable: 'NO' | 'YES';
    }>(sql`
      select column_default, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'integration_channel_change_authorizations'
        and column_name = 'consumed_at'
    `);
    expect(consumedAtColumn).toEqual({
      column_default: null,
      is_nullable: 'NO',
    });

    const constraints = await db.execute<{
      constraint_name: string;
      constraint_type: string;
      table_name: string;
      validated: boolean;
    }>(sql`
      select
        relation.relname as table_name,
        constraint_record.conname as constraint_name,
        constraint_record.contype::text as constraint_type,
        constraint_record.convalidated as validated
      from pg_catalog.pg_constraint as constraint_record
      join pg_catalog.pg_class as relation
        on relation.oid = constraint_record.conrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname in (
          'user_role_changes',
          'integration_channel_change_authorizations'
        )
    `);
    expect(constraints.every((constraint) => constraint.validated)).toBe(true);
    expect(
      constraints
        .map(
          (constraint) =>
            `${constraint.table_name}:${constraint.constraint_name}:${constraint.constraint_type}`,
        )
        .sort(),
    ).toEqual(
      [
        'integration_channel_change_authorizations:channel_change_authorizations_authorizer_session_fk:f',
        'integration_channel_change_authorizations:channel_change_authorizations_commitment_uq:u',
        'integration_channel_change_authorizations:channel_change_authorizations_consumer_session_fk:f',
        'integration_channel_change_authorizations:channel_change_authorizations_consumption_time:c',
        'integration_channel_change_authorizations:channel_change_authorizations_digest_format:c',
        'integration_channel_change_authorizations:channel_change_authorizations_expiry_bound:c',
        'integration_channel_change_authorizations:channel_change_authorizations_integration_id_format:c',
        'integration_channel_change_authorizations:channel_change_authorizations_live_status:c',
        'integration_channel_change_authorizations:channel_change_authorizations_reference_format:c',
        'integration_channel_change_authorizations:channel_change_authorizations_reference_uq:u',
        'integration_channel_change_authorizations:channel_change_authorizations_request_uq:u',
        'integration_channel_change_authorizations:channel_change_authorizations_same_human_session:c',
        'integration_channel_change_authorizations:channel_change_authorizations_status_truth_fk:f',
        'integration_channel_change_authorizations:channel_change_authorizations_status_uq:u',
        'integration_channel_change_authorizations:channel_change_authorizations_timestamp_precision:c',
        'integration_channel_change_authorizations:integration_channel_change_authorizations_pkey:p',
        'user_role_changes:user_role_changes_changer_session_fk:f',
        'user_role_changes:user_role_changes_pkey:p',
        'user_role_changes:user_role_changes_request_user_role_uq:u',
        'user_role_changes:user_role_changes_sequence_positive:c',
        'user_role_changes:user_role_changes_user_id_users_id_fk:f',
      ].sort(),
    );

    const keyedConstraints = await db.execute<{
      columns: string[];
      constraint_name: string;
      constraint_type: string;
      delete_action: string | null;
      referenced_columns: string[] | null;
      referenced_table: string | null;
      table_name: string;
    }>(sql`
      select
        relation.relname as table_name,
        constraint_record.conname as constraint_name,
        constraint_record.contype::text as constraint_type,
        array(
          select attribute.attname
          from unnest(constraint_record.conkey::smallint[]) with ordinality
            as key_column(attribute_number, position)
          join pg_catalog.pg_attribute as attribute
            on attribute.attrelid = constraint_record.conrelid
            and attribute.attnum = key_column.attribute_number
          order by key_column.position
        )::text[] as columns,
        case
          when constraint_record.contype = 'f'
            then referenced_relation.relname
          else null
        end as referenced_table,
        case
          when constraint_record.contype = 'f' then array(
            select attribute.attname
            from unnest(constraint_record.confkey::smallint[]) with ordinality
              as key_column(attribute_number, position)
            join pg_catalog.pg_attribute as attribute
              on attribute.attrelid = constraint_record.confrelid
              and attribute.attnum = key_column.attribute_number
            order by key_column.position
          )::text[]
          else null
        end as referenced_columns,
        case
          when constraint_record.contype = 'f'
            then constraint_record.confdeltype::text
          else null
        end as delete_action
      from pg_catalog.pg_constraint as constraint_record
      join pg_catalog.pg_class as relation
        on relation.oid = constraint_record.conrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      left join pg_catalog.pg_class as referenced_relation
        on referenced_relation.oid = constraint_record.confrelid
      where namespace.nspname = 'public'
        and relation.relname in (
          'user_role_changes',
          'integration_channel_change_authorizations'
        )
        and constraint_record.contype in ('p', 'u', 'f')
    `);
    expect(
      keyedConstraints
        .map((constraint) =>
          [
            constraint.table_name,
            constraint.constraint_name,
            constraint.constraint_type,
            constraint.columns.join(','),
            constraint.referenced_table ?? '',
            constraint.referenced_columns?.join(',') ?? '',
            constraint.delete_action ?? '',
          ].join(':'),
        )
        .sort(),
    ).toEqual(
      [
        'integration_channel_change_authorizations:channel_change_authorizations_authorizer_session_fk:f:authorized_with_session_id,authorized_by_user_id:sessions:id,user_id:r',
        'integration_channel_change_authorizations:channel_change_authorizations_commitment_uq:u:authorization_commitment:::',
        'integration_channel_change_authorizations:channel_change_authorizations_consumer_session_fk:f:consumed_with_session_id,consumed_by_user_id:sessions:id,user_id:r',
        'integration_channel_change_authorizations:channel_change_authorizations_reference_uq:u:reference:::',
        'integration_channel_change_authorizations:channel_change_authorizations_request_uq:u:consumed_request_id:::',
        'integration_channel_change_authorizations:channel_change_authorizations_status_truth_fk:f:integration_status_id,integration_id,status_label,authorized_by_user_id,authorization_commitment,issued_at:integration_statuses:id,integration_id,label,verified_by_user_id,authorization_reference,verified_at:r',
        'integration_channel_change_authorizations:channel_change_authorizations_status_uq:u:integration_status_id:::',
        'integration_channel_change_authorizations:integration_channel_change_authorizations_pkey:p:id:::',
        'user_role_changes:user_role_changes_changer_session_fk:f:changed_with_session_id,changed_by_user_id:sessions:id,user_id:r',
        'user_role_changes:user_role_changes_pkey:p:sequence:::',
        'user_role_changes:user_role_changes_request_user_role_uq:u:request_id,user_id,role:::',
        'user_role_changes:user_role_changes_user_id_users_id_fk:f:user_id:users:id:r',
      ].sort(),
    );

    const indexes = await db.execute<{
      columns: string[];
      index_name: string;
      is_ready: boolean;
      is_unique: boolean;
      is_valid: boolean;
      table_name: string;
    }>(sql`
      select
        table_relation.relname as table_name,
        index_relation.relname as index_name,
        index_record.indisunique as is_unique,
        index_record.indisvalid as is_valid,
        index_record.indisready as is_ready,
        array_agg(attribute.attname order by key_column.position)::text[]
          as columns
      from pg_catalog.pg_index as index_record
      join pg_catalog.pg_class as table_relation
        on table_relation.oid = index_record.indrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = table_relation.relnamespace
      join pg_catalog.pg_class as index_relation
        on index_relation.oid = index_record.indexrelid
      cross join lateral unnest(index_record.indkey::smallint[])
        with ordinality as key_column(attribute_number, position)
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = table_relation.oid
        and attribute.attnum = key_column.attribute_number
      where namespace.nspname = 'public'
        and table_relation.relname in (
          'user_role_changes',
          'integration_channel_change_authorizations'
        )
      group by
        table_relation.relname,
        index_relation.relname,
        index_record.indisunique,
        index_record.indisvalid,
        index_record.indisready
    `);
    expect(indexes.every((index) => index.is_valid && index.is_ready)).toBe(
      true,
    );
    expect(
      indexes
        .map(
          (index) =>
            `${index.table_name}:${index.index_name}:${index.is_unique}:${index.columns.join(',')}`,
        )
        .sort(),
    ).toEqual(
      [
        'integration_channel_change_authorizations:channel_change_authorizations_commitment_uq:true:authorization_commitment',
        'integration_channel_change_authorizations:channel_change_authorizations_integration_idx:false:integration_id,consumed_at',
        'integration_channel_change_authorizations:channel_change_authorizations_reference_uq:true:reference',
        'integration_channel_change_authorizations:channel_change_authorizations_request_uq:true:consumed_request_id',
        'integration_channel_change_authorizations:channel_change_authorizations_status_uq:true:integration_status_id',
        'integration_channel_change_authorizations:integration_channel_change_authorizations_pkey:true:id',
        'user_role_changes:user_role_changes_changer_idx:false:changed_by_user_id,sequence',
        'user_role_changes:user_role_changes_effective_idx:false:user_id,role,sequence',
        'user_role_changes:user_role_changes_pkey:true:sequence',
        'user_role_changes:user_role_changes_request_user_role_uq:true:request_id,user_id,role',
      ].sort(),
    );
  });

  test('limits app-role privileges while retaining append-only trigger enforcement', async () => {
    const db = databaseConnection().db;
    const tablePrivileges = await db.execute<{
      can_delete: boolean;
      can_insert: boolean;
      can_references: boolean;
      can_select: boolean;
      can_trigger: boolean;
      can_truncate: boolean;
      can_update: boolean;
      public_has_any_privilege: boolean;
      table_name: string;
    }>(sql`
      select
        new_tables.table_name,
        has_table_privilege(
          'psd_eoc_app',
          new_tables.table_name,
          'SELECT'
        ) as can_select,
        has_table_privilege(
          'psd_eoc_app',
          new_tables.table_name,
          'INSERT'
        ) as can_insert,
        has_table_privilege(
          'psd_eoc_app',
          new_tables.table_name,
          'UPDATE'
        ) as can_update,
        has_table_privilege(
          'psd_eoc_app',
          new_tables.table_name,
          'DELETE'
        ) as can_delete,
        has_table_privilege('psd_eoc_app', new_tables.table_name, 'TRUNCATE')
          as can_truncate,
        has_table_privilege('psd_eoc_app', new_tables.table_name, 'REFERENCES')
          as can_references,
        has_table_privilege('psd_eoc_app', new_tables.table_name, 'TRIGGER')
          as can_trigger,
        exists (
          select 1
          from pg_catalog.pg_class as public_table
          join pg_catalog.pg_namespace as public_namespace
            on public_namespace.oid = public_table.relnamespace
          cross join lateral aclexplode(
            coalesce(
              public_table.relacl,
              acldefault('r', public_table.relowner)
            )
          ) as public_privilege
          where public_namespace.nspname = 'public'
            and public_table.relname = new_tables.table_name
            and public_privilege.grantee = 0
        ) as public_has_any_privilege
      from unnest(array[
        'integration_channel_change_authorizations',
        'user_role_changes'
      ]::text[]) as new_tables(table_name)
      order by table_name
    `);
    expect([...tablePrivileges]).toEqual([
      {
        table_name: 'integration_channel_change_authorizations',
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_references: false,
        can_trigger: false,
        public_has_any_privilege: false,
      },
      {
        table_name: 'user_role_changes',
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_references: false,
        can_trigger: false,
        public_has_any_privilege: false,
      },
    ]);

    const [sequencePrivileges] = await db.execute<{
      can_select: boolean;
      can_update: boolean;
      can_usage: boolean;
      public_has_any_privilege: boolean;
    }>(sql`
      select
        has_sequence_privilege(
          'psd_eoc_app',
          'public.user_role_changes_sequence_seq',
          'USAGE'
        ) as can_usage,
        has_sequence_privilege(
          'psd_eoc_app',
          'public.user_role_changes_sequence_seq',
          'SELECT'
        ) as can_select,
        has_sequence_privilege(
          'psd_eoc_app',
          'public.user_role_changes_sequence_seq',
          'UPDATE'
        ) as can_update,
        exists (
          select 1
          from aclexplode(
            coalesce(
              sequence_relation.relacl,
              acldefault('S', sequence_relation.relowner)
            )
          ) as public_privilege
          where public_privilege.grantee = 0
        ) as public_has_any_privilege
      from pg_catalog.pg_class as sequence_relation
      join pg_catalog.pg_namespace as sequence_namespace
        on sequence_namespace.oid = sequence_relation.relnamespace
      where sequence_namespace.nspname = 'public'
        and sequence_relation.relname = 'user_role_changes_sequence_seq'
        and sequence_relation.relkind = 'S'
    `);
    expect(sequencePrivileges).toEqual({
      can_usage: true,
      can_select: true,
      can_update: false,
      public_has_any_privilege: false,
    });

    const triggers = await db.execute<{
      action_statement: string;
      action_timing: string;
      event_manipulation: string;
      event_object_table: string;
      trigger_name: string;
    }>(sql`
      select
        event_object_table,
        trigger_name,
        action_timing,
        event_manipulation,
        action_statement
      from information_schema.triggers
      where trigger_schema = 'public'
        and event_object_table in (
          'user_role_changes',
          'integration_channel_change_authorizations'
        )
      order by event_object_table, trigger_name, event_manipulation
    `);
    expect(
      triggers.map((trigger) => ({
        table: trigger.event_object_table,
        name: trigger.trigger_name,
        timing: trigger.action_timing,
        event: trigger.event_manipulation,
      })),
    ).toEqual([
      {
        table: 'integration_channel_change_authorizations',
        name: 'integration_channel_change_authorizations_immutable_guard',
        timing: 'BEFORE',
        event: 'UPDATE',
      },
      {
        table: 'integration_channel_change_authorizations',
        name: 'integration_channel_change_authorizations_retain_guard',
        timing: 'BEFORE',
        event: 'DELETE',
      },
      {
        table: 'user_role_changes',
        name: 'user_role_changes_immutable_guard',
        timing: 'BEFORE',
        event: 'UPDATE',
      },
      {
        table: 'user_role_changes',
        name: 'user_role_changes_retain_guard',
        timing: 'BEFORE',
        event: 'DELETE',
      },
      {
        table: 'user_role_changes',
        name: 'user_role_changes_sequence_guard',
        timing: 'BEFORE',
        event: 'INSERT',
      },
    ]);
    for (const trigger of triggers) {
      expect(trigger.action_statement).toContain(
        trigger.event_manipulation === 'INSERT'
          ? 'psd_eoc_guard_user_role_change_insert'
          : trigger.event_manipulation === 'UPDATE'
            ? 'psd_eoc_reject_immutable_mutation'
            : 'psd_eoc_reject_delete',
      );
    }

    const triggerFunctionPrivileges = await db.execute<{
      app_can_execute: boolean;
      function_name: string;
      public_can_execute: boolean;
    }>(sql`
      select
        procedure.proname as function_name,
        has_function_privilege(
          'psd_eoc_app',
          procedure.oid,
          'EXECUTE'
        ) as app_can_execute,
        exists (
          select 1
          from aclexplode(
            coalesce(
              procedure.proacl,
              acldefault('f', procedure.proowner)
            )
          ) as function_privilege
          where function_privilege.grantee = 0
            and function_privilege.privilege_type = 'EXECUTE'
        ) as public_can_execute
      from pg_catalog.pg_proc as procedure
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname in (
          'psd_eoc_guard_user_role_change_insert',
          'psd_eoc_reject_delete',
          'psd_eoc_reject_immutable_mutation'
        )
      order by procedure.proname
    `);
    expect([...triggerFunctionPrivileges]).toEqual([
      {
        function_name: 'psd_eoc_guard_user_role_change_insert',
        app_can_execute: false,
        public_can_execute: false,
      },
      {
        function_name: 'psd_eoc_reject_delete',
        app_can_execute: false,
        public_can_execute: false,
      },
      {
        function_name: 'psd_eoc_reject_immutable_mutation',
        app_can_execute: false,
        public_can_execute: false,
      },
    ]);
  });

  test('allows app-role inserts without granting sequence mutation authority', async () => {
    const db = databaseConnection().db;
    const rollbackProbe = new Error('rollback synthetic admin evidence probe');

    try {
      await db.transaction(async (transaction) => {
        for (const statement of syntheticAdminEvidencePrerequisites) {
          await transaction.execute(statement);
        }
        await transaction.execute(sql`set local role "psd_eoc_app"`);

        const roleChanges = await transaction.execute<{
          granted: boolean;
          sequence: number;
        }>(sql`
          insert into user_role_changes (
            user_id,
            role,
            granted,
            changed_by_user_id,
            changed_with_session_id,
            request_id,
            occurred_at
          ) values
          (
              '00000000-0000-4000-8000-000000026001'::uuid,
              'admin'::role,
              true,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '00000000-0000-4000-8000-000000026007'::uuid,
              '2026-08-10T16:02:00.000Z'::timestamptz
          ),
          (
              '00000000-0000-4000-8000-000000026001'::uuid,
              'admin'::role,
              false,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '00000000-0000-4000-8000-000000026008'::uuid,
              '2026-08-10T16:03:00.000Z'::timestamptz
          )
          returning sequence, granted
        `);
        expect(roleChanges).toHaveLength(2);
        const orderedRoleChanges = [...roleChanges].sort(
          (left, right) => left.sequence - right.sequence,
        );
        expect(orderedRoleChanges[0]?.sequence).toBeGreaterThan(0);
        expect(orderedRoleChanges[1]?.sequence).toBeGreaterThan(
          orderedRoleChanges[0]?.sequence ?? 0,
        );
        expect(orderedRoleChanges.map((change) => change.granted)).toEqual([
          true,
          false,
        ]);

        const [sequenceState] = await transaction.execute<{
          last_value: number;
        }>(sql`
          select last_value::integer as last_value
          from user_role_changes_sequence_seq
        `);
        expect(sequenceState?.last_value).toBeGreaterThan(0);

        await transaction.execute(insertSyntheticChannelChangeAuthorization);
        const [authorization] = await transaction.execute<{
          consumed_at_matches: boolean;
          integration_id: string;
          status_label: string;
        }>(sql`
          select
            integration_id,
            status_label,
            consumed_at = '2026-08-10T16:02:00.000Z'::timestamptz
              as consumed_at_matches
          from integration_channel_change_authorizations
          where id = '00000000-0000-4000-8000-000000026006'::uuid
        `);
        expect(authorization).toEqual({
          integration_id: 'synthetic-database-evidence',
          status_label: 'live-verified',
          consumed_at_matches: true,
        });

        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) {
        throw error;
      }
    }
  });

  test('rejects live-channel evidence without an authoritative consumed-at time', async () => {
    const db = databaseConnection().db;
    const unexpectedAcceptance = new Error(
      'rollback unexpected missing consumed-at acceptance',
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(sql`
            insert into integration_channel_change_authorizations (
              id,
              reference,
              authorization_commitment,
              integration_status_id,
              integration_id,
              status_label,
              desired_enabled,
              request_digest,
              consequence_digest,
              authorized_by_user_id,
              authorized_with_session_id,
              issued_at,
              expires_at,
              consumed_by_user_id,
              consumed_with_session_id,
              consumed_request_id
            ) values (
              '00000000-0000-4000-8000-000000026006'::uuid,
              'synthetic-product-owner-evidence-26',
              repeat('a', 64),
              '00000000-0000-4000-8000-000000026005'::uuid,
              'synthetic-database-evidence',
              'live-verified'::integration_truth_label,
              false,
              repeat('b', 64),
              repeat('c', 64),
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '2026-08-10T16:01:00.000Z'::timestamptz,
              '2026-08-10T16:16:00.000Z'::timestamptz,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '00000000-0000-4000-8000-000000026009'::uuid
            )
          `);
          throw unexpectedAcceptance;
        }),
      /null value in column "consumed_at".*not-null constraint/iu,
    );
  });

  test('rejects an app-role role change with a non-issued sequence', async () => {
    const db = databaseConnection().db;
    const unexpectedAcceptance = new Error(
      'rollback unexpected explicit role sequence acceptance',
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(sql`
            insert into user_role_changes (
              sequence,
              user_id,
              role,
              granted,
              changed_by_user_id,
              changed_with_session_id,
              request_id,
              occurred_at
            ) values (
              2147483647,
              '00000000-0000-4000-8000-000000026001'::uuid,
              'admin'::role,
              true,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '00000000-0000-4000-8000-000000026007'::uuid,
              '2026-08-10T16:02:00.000Z'::timestamptz
            )
          `);
          throw unexpectedAcceptance;
        }),
      /role-change sequence must be (?:the )?database-issued/iu,
    );
  });

  test('enforces new-table keys, checks, and append-only triggers', async () => {
    const db = databaseConnection().db;

    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(insertSyntheticRoleChange);
          await transaction.execute(insertSyntheticRoleChange);
        }),
      'user_role_changes_request_user_role_uq',
    );
    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(sql`
            insert into integration_channel_change_authorizations (
              id,
              reference,
              authorization_commitment,
              integration_status_id,
              integration_id,
              status_label,
              desired_enabled,
              request_digest,
              consequence_digest,
              authorized_by_user_id,
              authorized_with_session_id,
              issued_at,
              expires_at,
              consumed_by_user_id,
              consumed_with_session_id,
              consumed_request_id,
              consumed_at
            ) values (
              '00000000-0000-4000-8000-000000026006'::uuid,
              'synthetic-product-owner-evidence-26',
              repeat('d', 64),
              '00000000-0000-4000-8000-000000026005'::uuid,
              'synthetic-database-evidence',
              'live-verified'::integration_truth_label,
              false,
              repeat('b', 64),
              repeat('c', 64),
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '2026-08-10T16:01:00.000Z'::timestamptz,
              '2026-08-10T16:16:00.000Z'::timestamptz,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '00000000-0000-4000-8000-000000026009'::uuid,
              '2026-08-10T16:02:00.000Z'::timestamptz
            )
          `);
        }),
      'channel_change_authorizations_status_truth_fk',
    );
    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(sql`
            insert into integration_channel_change_authorizations (
              id,
              reference,
              authorization_commitment,
              integration_status_id,
              integration_id,
              status_label,
              desired_enabled,
              request_digest,
              consequence_digest,
              authorized_by_user_id,
              authorized_with_session_id,
              issued_at,
              expires_at,
              consumed_by_user_id,
              consumed_with_session_id,
              consumed_request_id,
              consumed_at
            ) values (
              '00000000-0000-4000-8000-000000026006'::uuid,
              'synthetic-product-owner-evidence-26',
              repeat('a', 64),
              '00000000-0000-4000-8000-000000026005'::uuid,
              'synthetic-database-evidence',
              'live-verified'::integration_truth_label,
              false,
              repeat('b', 64),
              repeat('c', 64),
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '2026-08-10T16:01:00.000Z'::timestamptz,
              '2026-08-10T16:01:00.000Z'::timestamptz,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '00000000-0000-4000-8000-000000026009'::uuid,
              '2026-08-10T16:01:00.000Z'::timestamptz
            )
          `);
        }),
      'channel_change_authorizations_expiry_bound',
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(insertSyntheticRoleChange);
          await transaction.execute(sql`
            update user_role_changes
            set granted = false
            where request_id = '00000000-0000-4000-8000-000000026007'::uuid
          `);
        }),
      /immutable truth cannot be changed/u,
    );
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(insertSyntheticRoleChange);
          await transaction.execute(sql`
            delete from user_role_changes
            where request_id = '00000000-0000-4000-8000-000000026007'::uuid
          `);
        }),
      /records are retained/u,
    );
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(insertSyntheticChannelChangeAuthorization);
          await transaction.execute(sql`
            update integration_channel_change_authorizations
            set desired_enabled = true
            where id = '00000000-0000-4000-8000-000000026006'::uuid
          `);
        }),
      /immutable truth cannot be changed/u,
    );
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          for (const statement of syntheticAdminEvidencePrerequisites) {
            await transaction.execute(statement);
          }
          await transaction.execute(insertSyntheticChannelChangeAuthorization);
          await transaction.execute(sql`
            delete from integration_channel_change_authorizations
            where id = '00000000-0000-4000-8000-000000026006'::uuid
          `);
        }),
      /records are retained/u,
    );
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
