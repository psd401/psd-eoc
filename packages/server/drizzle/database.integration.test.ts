import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { NotificationOutboxMessageSchema } from '@psd-eoc/contracts';
import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../db/client';
import { seedDatabase, type SeedSummary } from '../db/seed';
import { notificationIntentChannels } from '../db/schema';
import { migrateDatabase } from './migrate';
import {
  createDisposableDatabase,
  type DisposableDatabase,
} from '../lib/testing/database';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;
let firstSeedSummary: SeedSummary | undefined;
let ownedDatabase: DisposableDatabase | undefined;

const metricsCollectorSource = await Bun.file(
  new URL('../../../infra/lambda/metrics-collector/index.mjs', import.meta.url),
).text();
const deliveryTestHealthQueryMatches = [
  ...metricsCollectorSource.matchAll(
    /\n\s*deliveryTestHealth:\s*`([\s\S]*?)`,\n\s*outboxToProvider:/gu,
  ),
];
if (
  deliveryTestHealthQueryMatches.length !== 1 ||
  deliveryTestHealthQueryMatches[0]?.[1] === undefined
) {
  throw new Error(
    'The deployed delivery-test health monitoring query could not be extracted exactly once.',
  );
}
const deliveryTestHealthMonitoringQuery = deliveryTestHealthQueryMatches[0][1];

const ISSUE_14_PRE_LIFECYCLE_MIGRATIONS = [
  '0000_youthful_captain_stacy.sql',
  '0001_brainy_terror.sql',
  '0002_roster_graph_immutability.sql',
  '0003_many_ezekiel_stane.sql',
  '0004_volatile_purple_man.sql',
  '0005_steep_jane_foster.sql',
  '0006_media_record_immutability.sql',
] as const;
const ISSUE_14_LIFECYCLE_MIGRATION = '0007_pretty_puppet_master.sql';
const ISSUE_23_PRE_OUTBOX_V2_MIGRATIONS = [
  ...ISSUE_14_PRE_LIFECYCLE_MIGRATIONS,
  ISSUE_14_LIFECYCLE_MIGRATION,
] as const;
const ISSUE_23_OUTBOX_V2_MIGRATION = '0008_yummy_living_tribunal.sql';

/**
 * Inserts the audience configuration the pre-retirement schema requires.
 *
 * `notification_intents` carried a NOT NULL `audience_config_id` until 0030
 * dropped it (#292), and the seed no longer writes any configuration because
 * `db/schema.ts` no longer models the table. A fixture held at an earlier
 * migration still has the column, so it stages its own row here in raw SQL,
 * for the same reason it stages group sources that way.
 */
const RETIRED_AUDIENCE_ID = '00000000-0000-4000-8000-000000000020';

async function stageRetiredAudienceConfiguration(
  database: PostgresDatabase,
  facilityId: string,
): Promise<void> {
  await database.execute(sql`
    insert into audience_configurations (id, facility_id, version, created_at)
    values (
      ${RETIRED_AUDIENCE_ID}::uuid,
      ${facilityId}::uuid,
      1,
      '2026-08-06T12:00:00.000Z'::timestamptz
    )
    on conflict do nothing
  `);
}

const ISSUE_23_OUTBOX_IDS = Object.freeze({
  event: '00000000-0000-4000-8000-000000009980',
  activationPreview: '00000000-0000-4000-8000-000000009979',
  intent: '00000000-0000-4000-8000-000000023001',
  outbox: '00000000-0000-4000-8000-000000023002',
  request: '00000000-0000-4000-8000-000000009982',
  facility: '00000000-0000-4000-8000-000000000001',
  eventTypeVersion: '00000000-0000-4000-8000-000000000201',
  roster: '00000000-0000-4000-8000-000000000041',
  pushIntegrationStatus: '00000000-0000-4000-8000-000000000301',
  emailIntegrationStatus: '00000000-0000-4000-8000-000000000302',
});

const ISSUE_23_PUSH_UPGRADE_IDS = Object.freeze({
  user: '00000000-0000-4000-8000-000000023101',
  membershipSnapshot: '00000000-0000-4000-8000-000000023102',
  revokedDevice: '00000000-0000-4000-8000-000000023103',
  unrelatedDevice: '00000000-0000-4000-8000-000000023104',
  appRoleDevice: '00000000-0000-4000-8000-000000023105',
  revokedSession: '00000000-0000-4000-8000-000000023106',
  unrelatedSession: '00000000-0000-4000-8000-000000023107',
  appRoleSession: '00000000-0000-4000-8000-000000023108',
  retainedRevocation: '00000000-0000-4000-8000-000000023109',
  alreadyUnregisteredRegistration: '00000000-0000-4000-8000-000000023110',
  preRevocationRegistration: '00000000-0000-4000-8000-000000023111',
  postRevocationRegistration: '00000000-0000-4000-8000-000000023112',
  unrelatedRegistration: '00000000-0000-4000-8000-000000023113',
  retainedUnregistration: '00000000-0000-4000-8000-000000023114',
  appRoleRegistration: '00000000-0000-4000-8000-000000023115',
  appRoleRevocation: '00000000-0000-4000-8000-000000023116',
  appRoleUnregistration: '00000000-0000-4000-8000-000000023117',
});

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The PostgreSQL integration-test connection is not open.');
  }
  return connection;
}

async function applySqlMigrationFile(
  database: PostgresDatabaseConnection['db'],
  fileName: string,
): Promise<void> {
  const migration = await Bun.file(
    new URL(`./migrations/${fileName}`, import.meta.url),
  ).text();
  await database.transaction(async (transaction) => {
    for (const statement of migration.split('--> statement-breakpoint')) {
      const normalized = statement.trim();
      if (normalized.length > 0) {
        await transaction.execute(sql.raw(normalized));
      }
    }
  });
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

function findPostgresErrorMessage(error: unknown): string | undefined {
  return postgresErrorMessages(error).at(-1);
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
      'synthetic-database-admin-evidence@example.invalid',
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

type PostgresTransaction = Parameters<
  Parameters<PostgresDatabaseConnection['db']['transaction']>[0]
>[0];

/**
 * Builds a fully synthetic staff/canary graph for database-only delivery-test
 * safety proofs. `.invalid` addresses and unroutable tokens ensure this
 * fixture cannot reach a recipient or provider.
 */
async function insertDeliveryTestStructuralFixture(
  transaction: PostgresTransaction,
): Promise<void> {
  for (const statement of syntheticAdminEvidencePrerequisites) {
    await transaction.execute(statement);
  }

  const fixtureStatements = [
    sql`
      insert into group_sources (
        id, kind, purpose, facility_id, display_name, active,
        google_group_id, email, fixture_key, created_at
      ) values (
        '00000000-0000-4000-8000-000000030001'::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose,
        '00000000-0000-4000-8000-000000000001'::uuid,
        'Synthetic Delivery Test Staff',
        true,
        'synthetic-delivery-test-staff-group',
        'synthetic-delivery-test-group@example.invalid',
        null,
        '2026-08-10T16:00:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into roster_source_configurations (
        id, version, population, created_at
      ) values (
        '00000000-0000-4000-8000-000000030002'::uuid,
        1,
        'staff'::roster_population,
        '2026-08-10T16:00:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into roster_source_configuration_facilities (
        configuration_id, configuration_version, facility_id
      ) values (
        '00000000-0000-4000-8000-000000030002'::uuid,
        1,
        '00000000-0000-4000-8000-000000000001'::uuid
      )
    `,
    sql`
      insert into roster_source_configuration_groups (
        configuration_id, configuration_version, population,
        group_source_id, group_source_kind, group_purpose
      ) values (
        '00000000-0000-4000-8000-000000030002'::uuid,
        1,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030001'::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose
      )
    `,
    sql`
      insert into roster_snapshots (
        id, version, population, complete, source_configuration_id,
        source_configuration_version, sync_started_at, captured_at
      ) values (
        '00000000-0000-4000-8000-000000030003'::uuid,
        1,
        'staff'::roster_population,
        true,
        '00000000-0000-4000-8000-000000030002'::uuid,
        1,
        '2026-08-10T16:00:00.000Z'::timestamptz,
        '2026-08-10T16:01:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into roster_snapshot_facilities (
        roster_snapshot_id, facility_id
      ) values (
        '00000000-0000-4000-8000-000000030003'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid
      )
    `,
    sql`
      insert into roster_snapshot_sources (
        roster_snapshot_id, population, group_source_id,
        group_source_kind, group_purpose, completion_kind
      ) values
      (
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030001'::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose,
        'expected'::group_completion_kind
      ),
      (
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030001'::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose,
        'completed'::group_completion_kind
      )
    `,
    sql`
      insert into roster_recipients (
        id, roster_snapshot_id, population, google_subject, display_name
      ) values
      (
        '00000000-0000-4000-8000-000000030004'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        'synthetic-delivery-test-staff-one',
        'Synthetic Delivery Test Staff One'
      ),
      (
        '00000000-0000-4000-8000-000000030005'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        'synthetic-delivery-test-staff-two',
        'Synthetic Delivery Test Staff Two'
      )
    `,
    sql`
      insert into roster_recipient_group_sources (
        roster_snapshot_id, recipient_id, population, group_source_id,
        group_source_kind, group_purpose
      ) values
      (
        '00000000-0000-4000-8000-000000030003'::uuid,
        '00000000-0000-4000-8000-000000030004'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030001'::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose
      ),
      (
        '00000000-0000-4000-8000-000000030003'::uuid,
        '00000000-0000-4000-8000-000000030005'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030001'::uuid,
        'google-group'::group_source_kind,
        'building'::group_purpose
      )
    `,
    sql`
      insert into roster_endpoints (
        id, roster_snapshot_id, recipient_id, population, channel, status,
        captured_at, platform, token, email, phone_number
      ) values
      (
        '00000000-0000-4000-8000-000000030006'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        '00000000-0000-4000-8000-000000030004'::uuid,
        'staff'::roster_population,
        'push'::notification_channel,
        'active'::endpoint_status,
        '2026-08-10T16:01:00.000Z'::timestamptz,
        'ios'::push_platform,
        'synthetic-unroutable:delivery-test-listed-push',
        null,
        null
      ),
      (
        '00000000-0000-4000-8000-000000030007'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        '00000000-0000-4000-8000-000000030005'::uuid,
        'staff'::roster_population,
        'email'::notification_channel,
        'active'::endpoint_status,
        '2026-08-10T16:01:00.000Z'::timestamptz,
        null,
        null,
        'synthetic-delivery-test-listed@example.invalid',
        null
      ),
      (
        '00000000-0000-4000-8000-000000030008'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        '00000000-0000-4000-8000-000000030005'::uuid,
        'staff'::roster_population,
        'push'::notification_channel,
        'active'::endpoint_status,
        '2026-08-10T16:01:00.000Z'::timestamptz,
        'android'::push_platform,
        'synthetic-unroutable:delivery-test-unlisted-push',
        null,
        null
      )
    `,
    sql`
      insert into delivery_test_canary_eligibility_facts (
        id, supersedes_fact_id, facility_id, roster_snapshot_id,
        roster_population, recipient_id, endpoint_id, channel, decision,
        opted_in_at, decided_at, decided_by_user_id,
        decided_with_session_id, authorization_reference
      ) values
      (
        '00000000-0000-4000-8000-000000030012'::uuid,
        null,
        '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030004'::uuid,
        '00000000-0000-4000-8000-000000030006'::uuid,
        'push'::notification_channel,
        'approved-synthetic-canary',
        '2026-08-10T15:00:00.000Z'::timestamptz,
        '2026-08-10T16:03:00.000Z'::timestamptz,
        '00000000-0000-4000-8000-000000026001'::uuid,
        '00000000-0000-4000-8000-000000026004'::uuid,
        'synthetic-product-owner-delivery-test-approval'
      ),
      (
        '00000000-0000-4000-8000-000000030013'::uuid,
        null,
        '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030005'::uuid,
        '00000000-0000-4000-8000-000000030007'::uuid,
        'email'::notification_channel,
        'approved-synthetic-canary',
        '2026-08-10T15:00:00.000Z'::timestamptz,
        '2026-08-10T16:03:00.000Z'::timestamptz,
        '00000000-0000-4000-8000-000000026001'::uuid,
        '00000000-0000-4000-8000-000000026004'::uuid,
        'synthetic-product-owner-delivery-test-approval'
      )
    `,
    sql`
      insert into delivery_test_target_set_versions (
        id, version, facility_id, roster_snapshot_id, roster_population,
        supersedes_version_id, endpoint_reference_digest,
        idempotency_request_id, approved_by_user_id,
        approved_with_session_id, approved_at, created_at
      ) values (
        '00000000-0000-4000-8000-000000030010'::uuid,
        1,
        '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        null,
        repeat('e', 64),
        '00000000-0000-4000-8000-000000030011'::uuid,
        '00000000-0000-4000-8000-000000026001'::uuid,
        '00000000-0000-4000-8000-000000026004'::uuid,
        '2026-08-10T16:04:00.000Z'::timestamptz,
        '2026-08-10T16:03:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into delivery_test_target_endpoints (
        target_set_version_id, target_set_version, eligibility_fact_id,
        roster_snapshot_id,
        roster_population, recipient_id, endpoint_id, channel, attestation,
        opted_in_at, attested_at, attested_by_user_id,
        authorization_reference
      ) values
      (
        '00000000-0000-4000-8000-000000030010'::uuid,
        1,
        '00000000-0000-4000-8000-000000030012'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030004'::uuid,
        '00000000-0000-4000-8000-000000030006'::uuid,
        'push'::notification_channel,
        'approved-synthetic-canary',
        '2026-08-10T15:00:00.000Z'::timestamptz,
        '2026-08-10T16:03:00.000Z'::timestamptz,
        '00000000-0000-4000-8000-000000026001'::uuid,
        'synthetic-product-owner-delivery-test-approval'
      ),
      (
        '00000000-0000-4000-8000-000000030010'::uuid,
        1,
        '00000000-0000-4000-8000-000000030013'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        '00000000-0000-4000-8000-000000030005'::uuid,
        '00000000-0000-4000-8000-000000030007'::uuid,
        'email'::notification_channel,
        'approved-synthetic-canary',
        '2026-08-10T15:00:00.000Z'::timestamptz,
        '2026-08-10T16:03:00.000Z'::timestamptz,
        '00000000-0000-4000-8000-000000026001'::uuid,
        'synthetic-product-owner-delivery-test-approval'
      )
    `,
    sql`set constraints "delivery_test_target_sets_complete_guard" immediate`,
    sql`set constraints "delivery_test_target_sets_complete_guard" deferred`,
    sql`
      insert into integration_statuses (
        id, integration_id, label, verified_at, verified_by_user_id,
        authorization_reference, reason_code, observed_at
      ) values
      (
        '00000000-0000-4000-8000-000000030050'::uuid,
        'expo-push',
        'live-verified'::integration_truth_label,
        '2026-08-10T16:02:00.000Z'::timestamptz,
        '00000000-0000-4000-8000-000000026001'::uuid,
        'synthetic-product-owner-push-live-verification',
        null,
        '2026-08-10T16:02:00.000Z'::timestamptz
      ),
      (
        '00000000-0000-4000-8000-000000030051'::uuid,
        'ses-email',
        'live-verified'::integration_truth_label,
        '2026-08-10T16:02:00.000Z'::timestamptz,
        '00000000-0000-4000-8000-000000026001'::uuid,
        'synthetic-product-owner-email-live-verification',
        null,
        '2026-08-10T16:02:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into connectivity_epochs (id, session_id, established_at)
      values (
        '00000000-0000-4000-8000-000000030040'::uuid,
        '00000000-0000-4000-8000-000000026004'::uuid,
        '2026-08-10T16:03:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into human_confirmation_records (
        id, capability_id, connectivity_epoch_id, confirmed_by_user_id,
        confirmed_with_session_id, consequence_digest, issued_at, expires_at,
        status, consumed_at, consumed_for_request_id, expired_at
      ) values (
        '00000000-0000-4000-8000-000000030041'::uuid,
        'start-event'::mutation_capability,
        '00000000-0000-4000-8000-000000030040'::uuid,
        '00000000-0000-4000-8000-000000026001'::uuid,
        '00000000-0000-4000-8000-000000026004'::uuid,
        repeat('d', 64),
        '2026-08-10T16:04:00.000Z'::timestamptz,
        '2026-08-10T16:09:00.000Z'::timestamptz,
        'consumed'::human_confirmation_status,
        '2026-08-10T16:06:00.000Z'::timestamptz,
        '00000000-0000-4000-8000-000000030031'::uuid,
        null
      )
    `,
    sql`
      insert into human_confirmation_actions (confirmation_id, action_id)
      values (
        '00000000-0000-4000-8000-000000030041'::uuid,
        'send-real-notification'::human_only_action
      )
    `,
    sql`
      insert into activation_previews (
        id, facility_id, kind, template_mode, event_type_version_id,
        roster_snapshot_id, roster_population, recipient_count, channels, send_readiness,
        blocking_reason_codes, active_event_ids, consequence_digest,
        delivery_test_target_set_id, delivery_test_target_set_version,
        delivery_test_endpoint_reference_digest, created_at, expires_at
      ) values (
        '00000000-0000-4000-8000-000000030020'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid,
        'drill'::event_kind,
        'drill'::template_mode,
        '00000000-0000-4000-8000-000000000201'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        2,
        '[]'::jsonb,
        'ready',
        '[]'::jsonb,
        '[]'::jsonb,
        repeat('d', 64),
        '00000000-0000-4000-8000-000000030010'::uuid,
        1,
        repeat('e', 64),
        '2026-08-10T16:05:00.000Z'::timestamptz,
        '2026-08-10T16:10:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into events (
        id, facility_id, kind, template_mode, event_type_version_id, status,
        roster_snapshot_id, roster_population, created_by, created_at,
        activated_at, all_clear_at, reactivated_at, closed_at,
        correction_of_event_id, correction_reason, activation_authorization
      ) values (
        '00000000-0000-4000-8000-000000030030'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid,
        'drill'::event_kind,
        'drill'::template_mode,
        '00000000-0000-4000-8000-000000000201'::uuid,
        'active'::event_status,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        jsonb_build_object(
          'kind', 'human',
          'userId', '00000000-0000-4000-8000-000000026001',
          'sessionId', '00000000-0000-4000-8000-000000026004'
        ),
        '2026-08-10T16:05:00.000Z'::timestamptz,
        '2026-08-10T16:06:00.000Z'::timestamptz,
        null,
        null,
        null,
        null,
        null,
        jsonb_build_object(
          'kind', 'human-confirmed',
          'activationPreviewId', '00000000-0000-4000-8000-000000030020',
          'preparedActivationId', null,
          'confirmationId', '00000000-0000-4000-8000-000000030041',
          'consequenceDigest', repeat('d', 64),
          'requestId', '00000000-0000-4000-8000-000000030031'
        )
      )
    `,
    sql`
      insert into notification_intents (
        id, event_id, event_kind, template_mode, purpose,
        event_type_version_id, roster_snapshot_id, roster_population,
        created_by, source, request_id, "authorization", delivery_test_target_set_id,
        delivery_test_target_set_version,
        delivery_test_endpoint_reference_digest, created_at
      ) values (
        '00000000-0000-4000-8000-000000030032'::uuid,
        '00000000-0000-4000-8000-000000030030'::uuid,
        'drill'::event_kind,
        'drill'::template_mode,
        'activation'::notification_purpose,
        '00000000-0000-4000-8000-000000000201'::uuid,
        '00000000-0000-4000-8000-000000030003'::uuid,
        'staff'::roster_population,
        jsonb_build_object(
          'kind', 'human',
          'userId', '00000000-0000-4000-8000-000000026001',
          'sessionId', '00000000-0000-4000-8000-000000026004'
        ),
        'web'::invocation_source,
        '00000000-0000-4000-8000-000000030031'::uuid,
        jsonb_build_object(
          'kind', 'human-confirmed',
          'activationPreviewId', '00000000-0000-4000-8000-000000030020',
          'preparedActivationId', null,
          'confirmationId', '00000000-0000-4000-8000-000000030041',
          'consequenceDigest', repeat('d', 64),
          'requestId', '00000000-0000-4000-8000-000000030031'
        ),
        '00000000-0000-4000-8000-000000030010'::uuid,
        1,
        repeat('e', 64),
        '2026-08-10T16:06:00.000Z'::timestamptz
      )
    `,
    sql`
      insert into notification_intent_channels (
        intent_id, sequence, channel, event_kind, template_mode, purpose,
        roster_population, classification_marker, endpoint_count,
        rendered_message, integration_status_id, integration_id,
        integration_label
      ) values
      (
        '00000000-0000-4000-8000-000000030032'::uuid,
        1,
        'push'::notification_channel,
        'drill'::event_kind,
        'drill'::template_mode,
        'activation'::notification_purpose,
        'staff'::roster_population,
        'DRILL'::classification_marker,
        1,
        '{"channel":"push","eventKind":"drill","templateMode":"drill","purpose":"activation","classificationMarker":"DRILL","title":"[DRILL] Monthly delivery test","body":"[DRILL] Synthetic canary only."}'::jsonb,
        '00000000-0000-4000-8000-000000030050'::uuid,
        'expo-push',
        'live-verified'::integration_truth_label
      ),
      (
        '00000000-0000-4000-8000-000000030032'::uuid,
        2,
        'email'::notification_channel,
        'drill'::event_kind,
        'drill'::template_mode,
        'activation'::notification_purpose,
        'staff'::roster_population,
        'DRILL'::classification_marker,
        1,
        '{"channel":"email","eventKind":"drill","templateMode":"drill","purpose":"activation","classificationMarker":"DRILL","subject":"[DRILL] Monthly delivery test","textBody":"[DRILL] Synthetic canary only."}'::jsonb,
        '00000000-0000-4000-8000-000000030051'::uuid,
        'ses-email',
        'live-verified'::integration_truth_label
      )
    `,
    sql`
      insert into outbox (
        id, message_version, intent_id, event_id, event_kind, template_mode,
        purpose, event_type_version_id, roster_snapshot_id,
        roster_population, request_id, "authorization", channels, message, status, attempts,
        available_at, locked_until, published_at, failed_at,
        last_error_code, created_at
      )
      select
        '00000000-0000-4000-8000-000000030033'::uuid,
        1,
        intent.id,
        intent.event_id,
        intent.event_kind,
        intent.template_mode,
        intent.purpose,
        intent.event_type_version_id,
        intent.roster_snapshot_id,
        intent.roster_population,
        intent.request_id,
        intent."authorization",
        planned.channels,
        jsonb_build_object(
          'version', 1,
          'outboxId', '00000000-0000-4000-8000-000000030033',
          'intentId', intent.id::text,
          'eventId', intent.event_id::text,
          'eventKind', intent.event_kind::text,
          'templateMode', intent.template_mode::text,
          'purpose', intent.purpose::text,
          'eventTypeVersion', jsonb_build_object(
            'id', intent.event_type_version_id::text,
            'templateMode', intent.template_mode::text
          ),
          'rosterSnapshotId', intent.roster_snapshot_id::text,
          'rosterPopulation', intent.roster_population::text,
          'requestId', intent.request_id::text,
          'authorization', intent."authorization",
          'deliveryTest', jsonb_build_object(
            'purpose', 'monthly-live-delivery-test',
            'targetSet', jsonb_build_object(
              'id', intent.delivery_test_target_set_id::text,
              'version', intent.delivery_test_target_set_version
            ),
            'endpointReferenceDigest',
              intent.delivery_test_endpoint_reference_digest
          ),
          'channels', planned.channels,
          'createdAt', intent.created_at
        ),
        'pending'::outbox_status,
        0,
        intent.created_at,
        null,
        null,
        null,
        null,
        intent.created_at
      from notification_intents as intent
      cross join lateral (
        select jsonb_agg(
          jsonb_build_object(
            'channel', channel.channel::text,
            'endpointCount', channel.endpoint_count,
            'renderedMessage', channel.rendered_message,
            'integrationStatus', jsonb_build_object(
              'integrationId', channel.integration_id,
              'label', channel.integration_label::text
            )
          ) order by channel.sequence
        ) as channels
        from notification_intent_channels as channel
        where channel.intent_id = intent.id
      ) as planned
      where intent.id = '00000000-0000-4000-8000-000000030032'::uuid
    `,
    sql`
      insert into dispatch_batches (
        id, outbox_id, intent_id, event_id, event_kind, template_mode,
        purpose, event_type_version_id, roster_snapshot_id,
        roster_population, request_id, "authorization", channel, rendered_message,
        integration_status_id, integration_id, integration_label,
        sequence, endpoint_count, created_at
      )
      select
        case channel.channel
          when 'push' then '00000000-0000-4000-8000-000000030034'::uuid
          when 'email' then '00000000-0000-4000-8000-000000030035'::uuid
        end,
        outbox.id,
        outbox.intent_id,
        outbox.event_id,
        outbox.event_kind,
        outbox.template_mode,
        outbox.purpose,
        outbox.event_type_version_id,
        outbox.roster_snapshot_id,
        outbox.roster_population,
        outbox.request_id,
        outbox."authorization",
        channel.channel,
        channel.rendered_message,
        channel.integration_status_id,
        channel.integration_id,
        channel.integration_label,
        channel.sequence,
        channel.endpoint_count,
        '2026-08-10T16:06:30.000Z'::timestamptz
      from outbox
      join notification_intent_channels as channel
        on channel.intent_id = outbox.intent_id
      where outbox.id = '00000000-0000-4000-8000-000000030033'::uuid
    `,
    sql`
      insert into delivery_test_runs (
        id, activation_preview_id, event_id, notification_intent_id,
        target_set_version_id, target_set_version,
        endpoint_reference_digest, consequence_digest, confirmation_id,
        confirmation_status, request_id, started_by_user_id,
        started_with_session_id, started_at
      ) values (
        '00000000-0000-4000-8000-000000030042'::uuid,
        '00000000-0000-4000-8000-000000030020'::uuid,
        '00000000-0000-4000-8000-000000030030'::uuid,
        '00000000-0000-4000-8000-000000030032'::uuid,
        '00000000-0000-4000-8000-000000030010'::uuid,
        1,
        repeat('e', 64),
        repeat('d', 64),
        '00000000-0000-4000-8000-000000030041'::uuid,
        'consumed'::human_confirmation_status,
        '00000000-0000-4000-8000-000000030031'::uuid,
        '00000000-0000-4000-8000-000000026001'::uuid,
        '00000000-0000-4000-8000-000000026004'::uuid,
        '2026-08-10T16:06:00.000Z'::timestamptz
      )
    `,
  ] as const;

  for (const statement of fixtureStatements) {
    await transaction.execute(statement);
  }
}

async function insertInitialDeliveryTestEvidence(
  transaction: PostgresTransaction,
  pushTerminalState: 'failed' | 'unknown',
): Promise<void> {
  const pushReasonCode =
    pushTerminalState === 'failed'
      ? 'PROVIDER_REJECTED'
      : 'PROVIDER_OUTCOME_UNKNOWN';
  await transaction.execute(sql`
    insert into channel_attempts (
      id, batch_id, intent_id, event_id, event_kind, template_mode,
      purpose, event_type_version_id, roster_snapshot_id,
      roster_population, recipient_id, endpoint_id, channel,
      attempt_number, attempted_at
    ) values
    (
      '00000000-0000-4000-8000-000000030090'::uuid,
      '00000000-0000-4000-8000-000000030034'::uuid,
      '00000000-0000-4000-8000-000000030032'::uuid,
      '00000000-0000-4000-8000-000000030030'::uuid,
      'drill'::event_kind,
      'drill'::template_mode,
      'activation'::notification_purpose,
      '00000000-0000-4000-8000-000000000201'::uuid,
      '00000000-0000-4000-8000-000000030003'::uuid,
      'staff'::roster_population,
      '00000000-0000-4000-8000-000000030004'::uuid,
      '00000000-0000-4000-8000-000000030006'::uuid,
      'push'::notification_channel,
      1,
      '2026-08-10T16:06:31.000Z'::timestamptz
    ),
    (
      '00000000-0000-4000-8000-000000030091'::uuid,
      '00000000-0000-4000-8000-000000030035'::uuid,
      '00000000-0000-4000-8000-000000030032'::uuid,
      '00000000-0000-4000-8000-000000030030'::uuid,
      'drill'::event_kind,
      'drill'::template_mode,
      'activation'::notification_purpose,
      '00000000-0000-4000-8000-000000000201'::uuid,
      '00000000-0000-4000-8000-000000030003'::uuid,
      'staff'::roster_population,
      '00000000-0000-4000-8000-000000030005'::uuid,
      '00000000-0000-4000-8000-000000030007'::uuid,
      'email'::notification_channel,
      1,
      '2026-08-10T16:06:31.000Z'::timestamptz
    )
  `);
  await transaction.execute(sql`
    insert into delivery_evidence (
      id, subject_kind, subject_id, intent_id, attempt_id, sequence,
      previous_evidence_id, state, recorded_at, provider,
      provider_reference, proof, reason_code, diagnostic_digest
    ) values
    (
      '00000000-0000-4000-8000-000000030093'::uuid,
      'attempt'::delivery_evidence_subject_kind,
      '00000000-0000-4000-8000-000000030090'::uuid,
      null,
      '00000000-0000-4000-8000-000000030090'::uuid,
      1,
      null,
      'attempted'::delivery_truth_state,
      '2026-08-10T16:06:31.100Z'::timestamptz,
      null,
      null,
      null,
      null,
      null
    ),
    (
      '00000000-0000-4000-8000-000000030094'::uuid,
      'attempt'::delivery_evidence_subject_kind,
      '00000000-0000-4000-8000-000000030090'::uuid,
      null,
      '00000000-0000-4000-8000-000000030090'::uuid,
      2,
      '00000000-0000-4000-8000-000000030093'::uuid,
      ${pushTerminalState}::delivery_truth_state,
      '2026-08-10T16:06:31.500Z'::timestamptz,
      null,
      null,
      null,
      ${pushReasonCode},
      null
    ),
    (
      '00000000-0000-4000-8000-000000030095'::uuid,
      'attempt'::delivery_evidence_subject_kind,
      '00000000-0000-4000-8000-000000030091'::uuid,
      null,
      '00000000-0000-4000-8000-000000030091'::uuid,
      1,
      null,
      'attempted'::delivery_truth_state,
      '2026-08-10T16:06:31.100Z'::timestamptz,
      null,
      null,
      null,
      null,
      null
    ),
    (
      '00000000-0000-4000-8000-000000030096'::uuid,
      'attempt'::delivery_evidence_subject_kind,
      '00000000-0000-4000-8000-000000030091'::uuid,
      null,
      '00000000-0000-4000-8000-000000030091'::uuid,
      2,
      '00000000-0000-4000-8000-000000030095'::uuid,
      'provider-accepted'::delivery_truth_state,
      '2026-08-10T16:06:31.700Z'::timestamptz,
      'ses-email',
      'synthetic-provider-reference:email:1',
      null,
      null,
      null
    )
  `);
}

async function insertSucceededDeliveryTestEvidence(
  transaction: PostgresTransaction,
): Promise<void> {
  await transaction.execute(sql`
    insert into channel_attempts (
      id, batch_id, intent_id, event_id, event_kind, template_mode,
      purpose, event_type_version_id, roster_snapshot_id,
      roster_population, recipient_id, endpoint_id, channel,
      attempt_number, attempted_at
    ) values (
      '00000000-0000-4000-8000-000000030092'::uuid,
      '00000000-0000-4000-8000-000000030034'::uuid,
      '00000000-0000-4000-8000-000000030032'::uuid,
      '00000000-0000-4000-8000-000000030030'::uuid,
      'drill'::event_kind,
      'drill'::template_mode,
      'activation'::notification_purpose,
      '00000000-0000-4000-8000-000000000201'::uuid,
      '00000000-0000-4000-8000-000000030003'::uuid,
      'staff'::roster_population,
      '00000000-0000-4000-8000-000000030004'::uuid,
      '00000000-0000-4000-8000-000000030006'::uuid,
      'push'::notification_channel,
      2,
      '2026-08-10T16:07:10.000Z'::timestamptz
    )
  `);
  await transaction.execute(sql`
    insert into delivery_evidence (
      id, subject_kind, subject_id, intent_id, attempt_id, sequence,
      previous_evidence_id, state, recorded_at, provider,
      provider_reference, proof, reason_code, diagnostic_digest
    ) values
    (
      '00000000-0000-4000-8000-000000030097'::uuid,
      'attempt'::delivery_evidence_subject_kind,
      '00000000-0000-4000-8000-000000030092'::uuid,
      null,
      '00000000-0000-4000-8000-000000030092'::uuid,
      1,
      null,
      'attempted'::delivery_truth_state,
      '2026-08-10T16:07:10.100Z'::timestamptz,
      null,
      null,
      null,
      null,
      null
    ),
    (
      '00000000-0000-4000-8000-000000030098'::uuid,
      'attempt'::delivery_evidence_subject_kind,
      '00000000-0000-4000-8000-000000030092'::uuid,
      null,
      '00000000-0000-4000-8000-000000030092'::uuid,
      2,
      '00000000-0000-4000-8000-000000030097'::uuid,
      'provider-accepted'::delivery_truth_state,
      '2026-08-10T16:07:10.500Z'::timestamptz,
      'expo-push',
      'synthetic-provider-reference:push:2',
      null,
      null,
      null
    )
  `);
}

async function insertCrossFacilityDeliveryTestEligibility(
  transaction: PostgresTransaction,
): Promise<void> {
  await transaction.execute(sql`
    insert into roster_snapshot_facilities (roster_snapshot_id, facility_id)
    values (
      '00000000-0000-4000-8000-000000030003'::uuid,
      '00000000-0000-4000-8000-000000000002'::uuid
    )
  `);
  await transaction.execute(sql`
    insert into delivery_test_canary_eligibility_facts (
      id, supersedes_fact_id, facility_id, roster_snapshot_id,
      roster_population, recipient_id, endpoint_id, channel, decision,
      opted_in_at, decided_at, decided_by_user_id,
      decided_with_session_id, authorization_reference
    ) values (
      '00000000-0000-4000-8000-000000030085'::uuid,
      null,
      '00000000-0000-4000-8000-000000000002'::uuid,
      '00000000-0000-4000-8000-000000030003'::uuid,
      'staff'::roster_population,
      '00000000-0000-4000-8000-000000030004'::uuid,
      '00000000-0000-4000-8000-000000030006'::uuid,
      'push'::notification_channel,
      'approved-synthetic-canary',
      '2026-08-10T15:00:00.000Z'::timestamptz,
      '2026-08-10T16:08:00.000Z'::timestamptz,
      '00000000-0000-4000-8000-000000026001'::uuid,
      '00000000-0000-4000-8000-000000026004'::uuid,
      'synthetic-cross-facility-canary-proof'
    )
  `);
}

const insertIncompleteDeliveryTestReport = sql`
  insert into delivery_test_reports (
    id, run_id, run_started_at, sequence, supersedes_report_id, status,
    channels, generated_at, finalized_by, source, reason_code
  ) values (
    '00000000-0000-4000-8000-000000030043'::uuid,
    '00000000-0000-4000-8000-000000030042'::uuid,
    '2026-08-10T16:06:00.000Z'::timestamptz,
    1,
    null,
    'incomplete'::delivery_test_report_status,
    jsonb_build_array(
      jsonb_build_object(
        'channel', 'push',
        'endpointCount', 1,
        'activationToProviderAcceptMs', null,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'unknown', 'count', 1)
        ),
        'completedAt', null
      ),
      jsonb_build_object(
        'channel', 'email',
        'endpointCount', 1,
        'activationToProviderAcceptMs', 31700,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'provider-accepted', 'count', 1)
        ),
        'completedAt', '2026-08-10T16:06:31.700Z'
      )
    ),
    '2026-08-10T16:07:00.000Z'::timestamptz,
    jsonb_build_object(
      'kind', 'system',
      'serviceId', 'delivery-test-reporter'
    ),
    'worker'::invocation_source,
    'PROVIDER_TRUTH_PENDING'
  )
`;

const insertFailedDeliveryTestReport = sql`
  insert into delivery_test_reports (
    id, run_id, run_started_at, sequence, supersedes_report_id, status,
    channels, generated_at, finalized_by, source, reason_code
  ) values (
    '00000000-0000-4000-8000-000000030043'::uuid,
    '00000000-0000-4000-8000-000000030042'::uuid,
    '2026-08-10T16:06:00.000Z'::timestamptz,
    1,
    null,
    'failed'::delivery_test_report_status,
    jsonb_build_array(
      jsonb_build_object(
        'channel', 'push',
        'endpointCount', 1,
        'activationToProviderAcceptMs', null,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'failed', 'count', 1)
        ),
        'completedAt', null
      ),
      jsonb_build_object(
        'channel', 'email',
        'endpointCount', 1,
        'activationToProviderAcceptMs', 31700,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'provider-accepted', 'count', 1)
        ),
        'completedAt', '2026-08-10T16:06:31.700Z'
      )
    ),
    '2026-08-10T16:07:00.000Z'::timestamptz,
    jsonb_build_object(
      'kind', 'system',
      'serviceId', 'delivery-test-reporter'
    ),
    'worker'::invocation_source,
    'DELIVERY_TEST_PROVIDER_FAILURE'
  )
`;

const insertSucceededDeliveryTestReport = sql`
  insert into delivery_test_reports (
    id, run_id, run_started_at, sequence, supersedes_report_id, status,
    channels, generated_at, finalized_by, source, reason_code
  ) values (
    '00000000-0000-4000-8000-000000030044'::uuid,
    '00000000-0000-4000-8000-000000030042'::uuid,
    '2026-08-10T16:06:00.000Z'::timestamptz,
    2,
    '00000000-0000-4000-8000-000000030043'::uuid,
    'succeeded'::delivery_test_report_status,
    jsonb_build_array(
      jsonb_build_object(
        'channel', 'push',
        'endpointCount', 1,
        'activationToProviderAcceptMs', 70500,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'provider-accepted', 'count', 1)
        ),
        'completedAt', '2026-08-10T16:07:10.500Z'
      ),
      jsonb_build_object(
        'channel', 'email',
        'endpointCount', 1,
        'activationToProviderAcceptMs', 31700,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'provider-accepted', 'count', 1)
        ),
        'completedAt', '2026-08-10T16:06:31.700Z'
      )
    ),
    '2026-08-10T16:08:00.000Z'::timestamptz,
    jsonb_build_object(
      'kind', 'system',
      'serviceId', 'delivery-test-reporter'
    ),
    'worker'::invocation_source,
    null
  )
`;

const insertFabricatedSucceededDeliveryTestReport = sql`
  insert into delivery_test_reports (
    id, run_id, run_started_at, sequence, supersedes_report_id, status,
    channels, generated_at, finalized_by, source, reason_code
  ) values (
    '00000000-0000-4000-8000-000000030075'::uuid,
    '00000000-0000-4000-8000-000000030042'::uuid,
    '2026-08-10T16:06:00.000Z'::timestamptz,
    1,
    null,
    'succeeded'::delivery_test_report_status,
    jsonb_build_array(
      jsonb_build_object(
        'channel', 'push',
        'endpointCount', 1,
        'activationToProviderAcceptMs', 500,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'provider-accepted', 'count', 1)
        ),
        'completedAt', '2026-08-10T16:06:00.500Z'
      ),
      jsonb_build_object(
        'channel', 'email',
        'endpointCount', 1,
        'activationToProviderAcceptMs', 700,
        'latestStateCounts', jsonb_build_array(
          jsonb_build_object('state', 'provider-accepted', 'count', 1)
        ),
        'completedAt', '2026-08-10T16:06:00.700Z'
      )
    ),
    '2026-08-10T16:08:00.000Z'::timestamptz,
    jsonb_build_object(
      'kind', 'system',
      'serviceId', 'delivery-test-reporter'
    ),
    'worker'::invocation_source,
    null
  )
`;

function monitoringQueryWithBucket(
  query: string,
  bucketStart: string,
  bucketEnd: string,
  displayTimeZone = 'America/Los_Angeles',
): string {
  if (!/^[A-Za-z0-9_+\-/]+$/u.test(displayTimeZone)) {
    throw new Error('Synthetic monitoring time zone is invalid.');
  }
  return query
    .replaceAll(':bucket_start', `'${bucketStart}'`)
    .replaceAll(':bucket_end', `'${bucketEnd}'`)
    .replaceAll(':display_time_zone', `'${displayTimeZone}'`);
}

describeWithDatabase('fresh PostgreSQL migration and synthetic seed', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }

    const owned = await createDisposableDatabase(
      'psd_eoc_migration',
      testDatabaseUrl,
    );
    ownedDatabase = owned;
    const createdConnection = createDatabaseClient({
      driver: 'postgres',
      url: owned.url,
      maxConnections: 2,
    });
    if (createdConnection.driver !== 'postgres') {
      throw new Error(
        'Integration tests require the direct PostgreSQL driver.',
      );
    }
    connection = createdConnection;

    await migrateDatabase(createdConnection);
    firstSeedSummary = await seedDatabase(createdConnection.db, {
      // Written here with the columns this schema actually has: Drizzle emits
      // every column of a table it inserts into, so seeding group sources
      // through the current schema fails against a database held at an earlier
      // migration. Runs after facilities and before the roster source
      // configuration that references them.
      async insertGroupSources(transaction) {
        await transaction.execute(sql`
      insert into group_sources (
        id, kind, purpose, facility_id, display_name, active,
        google_group_id, email, fixture_key, created_at
      ) values
        (
          '00000000-0000-4000-8000-000000000030'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000001'::uuid,
          'Synthetic North Staff',
          true, null, null, 'synthetic-north-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000031'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000002'::uuid,
          'Synthetic South Staff',
          true, null, null, 'synthetic-south-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000032'::uuid,
          'synthetic'::group_source_kind,
          'others'::group_purpose,
          null,
          'Synthetic District Support Staff',
          true, null, null, 'synthetic-district-support-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        )
      on conflict do nothing
      `);
      },
    });
    expect(
      await seedDatabase(createdConnection.db, {
        // Written here with the columns this schema actually has: Drizzle emits
        // every column of a table it inserts into, so seeding group sources
        // through the current schema fails against a database held at an earlier
        // migration. Runs after facilities and before the roster source
        // configuration that references them.
        async insertGroupSources(transaction) {
          await transaction.execute(sql`
      insert into group_sources (
        id, kind, purpose, facility_id, display_name, active,
        google_group_id, email, fixture_key, created_at
      ) values
        (
          '00000000-0000-4000-8000-000000000030'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000001'::uuid,
          'Synthetic North Staff',
          true, null, null, 'synthetic-north-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000031'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000002'::uuid,
          'Synthetic South Staff',
          true, null, null, 'synthetic-south-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000032'::uuid,
          'synthetic'::group_source_kind,
          'others'::group_purpose,
          null,
          'Synthetic District Support Staff',
          true, null, null, 'synthetic-district-support-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        )
      on conflict do nothing
      `);
        },
      }),
    ).toEqual(firstSeedSummary);
  });

  afterAll(async () => {
    await connection?.close();
    connection = undefined;
    const owned = ownedDatabase;
    ownedDatabase = undefined;
    await owned?.drop();
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

  test('defers retained channel-history scans while enforcing replacement checks', async () => {
    const db = databaseConnection().db;
    const constraints = await db.execute<{
      constraint_name: string;
      table_name: string;
      validated: boolean;
    }>(sql`
      select
        relation.relname as table_name,
        constraint_record.conname as constraint_name,
        constraint_record.convalidated as validated
      from pg_catalog.pg_constraint as constraint_record
      join pg_catalog.pg_class as relation
        on relation.oid = constraint_record.conrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and constraint_record.conname in (
          'outbox_channel_plan_shape',
          'delivery_test_reports_channels_shape'
        )
      order by relation.relname
    `);
    expect([...constraints]).toEqual([
      {
        table_name: 'delivery_test_reports',
        constraint_name: 'delivery_test_reports_channels_shape',
        validated: false,
      },
      {
        table_name: 'outbox',
        constraint_name: 'outbox_channel_plan_shape',
        validated: false,
      },
    ]);
  });

  test('installs strict SMS lifecycle provenance and database-issued ordering', async () => {
    const db = databaseConnection().db;
    const columns = await db.execute<{
      column_name: string;
      data_type: string;
      identity_generation: string | null;
      is_identity: string;
      is_nullable: string;
      table_name: string;
    }>(sql`
      select
        table_name,
        column_name,
        data_type,
        is_nullable,
        is_identity,
        identity_generation
      from information_schema.columns
      where table_schema = 'public'
        and (
          (
            table_name = 'endpoint_status_records'
            and column_name in (
              'sequence',
              'provider',
              'provider_reference',
              'provider_occurred_at'
            )
          )
          or (
            table_name = 'sms_opt_out_records'
            and column_name = 'provider_occurred_at'
          )
        )
      order by table_name, column_name
    `);
    expect([...columns]).toEqual([
      {
        table_name: 'endpoint_status_records',
        column_name: 'provider',
        data_type: 'character varying',
        is_nullable: 'YES',
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'endpoint_status_records',
        column_name: 'provider_occurred_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'endpoint_status_records',
        column_name: 'provider_reference',
        data_type: 'character varying',
        is_nullable: 'YES',
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        table_name: 'endpoint_status_records',
        column_name: 'sequence',
        data_type: 'integer',
        is_nullable: 'NO',
        is_identity: 'YES',
        identity_generation: 'ALWAYS',
      },
      {
        table_name: 'sms_opt_out_records',
        column_name: 'provider_occurred_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        is_identity: 'NO',
        identity_generation: null,
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
          'public.endpoint_status_records_sequence_seq',
          'USAGE'
        ) as can_usage,
        has_sequence_privilege(
          'psd_eoc_app',
          'public.endpoint_status_records_sequence_seq',
          'SELECT'
        ) as can_select,
        has_sequence_privilege(
          'psd_eoc_app',
          'public.endpoint_status_records_sequence_seq',
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
        and sequence_relation.relname =
          'endpoint_status_records_sequence_seq'
        and sequence_relation.relkind = 'S'
    `);
    expect(sequencePrivileges).toEqual({
      can_usage: true,
      can_select: true,
      can_update: false,
      public_has_any_privilege: false,
    });

    const constraints = await db.execute<{
      constraint_name: string;
      table_name: string;
      validated: boolean;
    }>(sql`
      select
        relation.relname as table_name,
        constraint_record.conname as constraint_name,
        constraint_record.convalidated as validated
      from pg_catalog.pg_constraint as constraint_record
      join pg_catalog.pg_class as relation
        on relation.oid = constraint_record.conrelid
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and (
          (
            relation.relname = 'endpoint_status_records'
            and constraint_record.conname in (
              'endpoint_status_records_provider_identity',
              'endpoint_status_records_provider_format',
              'endpoint_status_records_provider_time',
              'endpoint_status_records_verified_active',
              'endpoint_status_records_managed_sms_opt_out'
            )
          )
          or (
            relation.relname = 'sms_opt_out_records'
            and constraint_record.conname in (
              'sms_opt_out_records_provider_time_required',
              'sms_opt_out_records_provider_time'
            )
          )
        )
      order by relation.relname, constraint_record.conname
    `);
    expect([...constraints]).toEqual([
      {
        table_name: 'endpoint_status_records',
        constraint_name: 'endpoint_status_records_managed_sms_opt_out',
        validated: true,
      },
      {
        table_name: 'endpoint_status_records',
        constraint_name: 'endpoint_status_records_provider_format',
        validated: true,
      },
      {
        table_name: 'endpoint_status_records',
        constraint_name: 'endpoint_status_records_provider_identity',
        validated: true,
      },
      {
        table_name: 'endpoint_status_records',
        constraint_name: 'endpoint_status_records_provider_time',
        validated: true,
      },
      {
        table_name: 'endpoint_status_records',
        constraint_name: 'endpoint_status_records_verified_active',
        validated: true,
      },
      {
        table_name: 'sms_opt_out_records',
        constraint_name: 'sms_opt_out_records_provider_time',
        validated: true,
      },
      {
        table_name: 'sms_opt_out_records',
        constraint_name: 'sms_opt_out_records_provider_time_required',
        validated: true,
      },
    ]);

    const lifecycleIndexes = await db.execute<{
      indexdef: string;
      indexname: string;
    }>(sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'endpoint_status_records_latest_idx',
          'endpoint_status_records_sms_lifecycle_idx',
          'roster_endpoints_sms_phone_idx',
          'sms_opt_out_records_provider_reference_uq'
        )
      order by indexname
    `);
    expect(lifecycleIndexes.map(({ indexname }) => indexname)).toEqual([
      'endpoint_status_records_latest_idx',
      'endpoint_status_records_sms_lifecycle_idx',
      'roster_endpoints_sms_phone_idx',
      'sms_opt_out_records_provider_reference_uq',
    ]);
    expect(lifecycleIndexes[0]?.indexdef).toContain(
      '(roster_snapshot_id, recipient_id, endpoint_id, sequence DESC NULLS LAST)',
    );
    expect(lifecycleIndexes[1]?.indexdef).toContain(
      'provider_occurred_at DESC NULLS LAST, sequence DESC NULLS LAST',
    );
    expect(lifecycleIndexes[1]?.indexdef).toContain(
      "WHERE ((channel = 'sms'::notification_channel) AND ((reason_code)::text = ANY",
    );
    expect(lifecycleIndexes[3]?.indexdef).toContain(
      'UNIQUE INDEX sms_opt_out_records_provider_reference_uq',
    );
    expect(lifecycleIndexes[3]?.indexdef).toContain(
      '(roster_snapshot_id, recipient_id, endpoint_id, provider, provider_reference)',
    );
    expect(lifecycleIndexes[3]?.indexdef).toContain(
      'WHERE (provider_occurred_at IS NOT NULL)',
    );
    expect(lifecycleIndexes[2]?.indexdef).toContain('(phone_number)');
    expect(lifecycleIndexes[2]?.indexdef).toContain(
      "WHERE ((channel = 'sms'::notification_channel) AND (phone_number IS NOT NULL))",
    );

    const rollbackProbe = new Error('rollback synthetic SMS lifecycle probe');
    try {
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`set local role "psd_eoc_app"`);
        await transaction.execute(sql`
          insert into endpoint_status_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            status,
            reason_code,
            provider,
            provider_reference,
            provider_occurred_at,
            recorded_at
          ) values
          (
            '00000000-0000-4000-8000-000000027001'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000050'::uuid,
            '00000000-0000-4000-8000-000000000062'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'disabled'::endpoint_status,
            'SMS_OPTED_OUT',
            'aws-eum-sms',
            'opt-out:synthetic-fresh-proof:1',
            '2026-08-11T15:59:00.000Z'::timestamptz,
            '2026-08-11T16:00:00.000Z'::timestamptz
          ),
          (
            '00000000-0000-4000-8000-000000027002'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000050'::uuid,
            '00000000-0000-4000-8000-000000000062'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'active'::endpoint_status,
            'SMS_OPT_IN_PROVIDER_VERIFIED',
            'aws-eum-sms',
            'opt-in:synthetic-fresh-proof:2',
            '2026-08-11T16:00:00.000Z'::timestamptz,
            '2026-08-11T16:01:00.000Z'::timestamptz
          )
        `);
        const ordered = await transaction.execute<{
          id: string;
          sequence: number;
        }>(sql`
          select id::text as id, sequence
          from endpoint_status_records
          where id in (
            '00000000-0000-4000-8000-000000027001'::uuid,
            '00000000-0000-4000-8000-000000027002'::uuid
          )
          order by sequence
        `);
        expect(ordered.map((row) => row.id)).toEqual([
          '00000000-0000-4000-8000-000000027001',
          '00000000-0000-4000-8000-000000027002',
        ]);
        expect(ordered[0]?.sequence).toBeGreaterThan(0);
        expect(ordered[1]?.sequence).toBeGreaterThan(ordered[0]?.sequence ?? 0);
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }

    await expectConstraintViolation(
      () =>
        db.execute(sql`
          insert into endpoint_status_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            status,
            reason_code,
            provider,
            provider_reference,
            recorded_at
          ) values (
            '00000000-0000-4000-8000-000000027003'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'invalid'::endpoint_status,
            'SYNTHETIC_INVALID',
            'aws-eum-sms',
            'synthetic-missing-occurrence',
            '2026-08-11T16:02:00.000Z'::timestamptz
          )
        `),
      'endpoint_status_records_provider_identity',
    );
    await expectConstraintViolation(
      () =>
        db.execute(sql`
          insert into endpoint_status_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            status,
            reason_code,
            provider,
            provider_reference,
            provider_occurred_at,
            recorded_at
          ) values (
            '00000000-0000-4000-8000-000000027009'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'invalid'::endpoint_status,
            'SYNTHETIC_INVALID',
            'aws-eum-sms',
            'synthetic-non-lifecycle-provider',
            '2026-08-11T16:01:00.000Z'::timestamptz,
            '2026-08-11T16:02:00.000Z'::timestamptz
          )
        `),
      'endpoint_status_records_provider_identity',
    );
    await expectConstraintViolation(
      () =>
        db.execute(sql`
          insert into endpoint_status_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            status,
            reason_code,
            recorded_at
          ) values (
            '00000000-0000-4000-8000-000000027004'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'disabled'::endpoint_status,
            'SMS_OPTED_OUT',
            '2026-08-11T16:03:00.000Z'::timestamptz
          )
        `),
      'endpoint_status_records_managed_sms_opt_out',
    );
    await expectConstraintViolation(
      () =>
        db.execute(sql`
          insert into endpoint_status_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            status,
            reason_code,
            provider,
            provider_reference,
            provider_occurred_at,
            recorded_at
          ) values (
            '00000000-0000-4000-8000-000000027006'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'disabled'::endpoint_status,
            'SMS_OPTED_OUT',
            'aws-eum-sms',
            'opt-out:synthetic-future-proof:3',
            '2026-08-11T16:09:01.000Z'::timestamptz,
            '2026-08-11T16:04:00.000Z'::timestamptz
          )
        `),
      'endpoint_status_records_provider_time',
    );
    await expectConstraintViolation(
      () =>
        db.execute(sql`
          insert into sms_opt_out_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            provider,
            provider_reference,
            recorded_at
          ) values (
            '00000000-0000-4000-8000-000000027007'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'aws-eum-sms',
            'opt-out:synthetic-missing-occurrence:4',
            '2026-08-11T16:05:00.000Z'::timestamptz
          )
        `),
      'sms_opt_out_records_provider_time_required',
    );
    await expectConstraintViolation(
      () =>
        db.execute(sql`
          insert into sms_opt_out_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            provider,
            provider_reference,
            provider_occurred_at,
            recorded_at
          ) values (
            '00000000-0000-4000-8000-000000027008'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'aws-eum-sms',
            'opt-out:synthetic-future-occurrence:5',
            '2026-08-11T16:11:01.000Z'::timestamptz,
            '2026-08-11T16:06:00.000Z'::timestamptz
          )
        `),
      'sms_opt_out_records_provider_time',
    );
    await expectConstraintViolation(
      () =>
        db.execute(sql`
          insert into sms_opt_out_records (
            id,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            provider,
            provider_reference,
            provider_occurred_at,
            recorded_at
          ) values
          (
            '00000000-0000-4000-8000-000000027010'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'aws-eum-sms',
            'opt-out:synthetic-provider-reference:6',
            '2026-08-11T16:06:00.000Z'::timestamptz,
            '2026-08-11T16:07:00.000Z'::timestamptz
          ),
          (
            '00000000-0000-4000-8000-000000027011'::uuid,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000051'::uuid,
            '00000000-0000-4000-8000-000000000065'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'aws-eum-sms',
            'opt-out:synthetic-provider-reference:6',
            '2026-08-11T16:06:30.000Z'::timestamptz,
            '2026-08-11T16:07:30.000Z'::timestamptz
          )
        `),
      'sms_opt_out_records_provider_reference_uq',
    );
    await expectPostgresRejection(
      () =>
        db.execute(sql`
          insert into endpoint_status_records (
            id,
            sequence,
            roster_snapshot_id,
            recipient_id,
            endpoint_id,
            population,
            channel,
            status,
            reason_code,
            recorded_at
          ) values (
            '00000000-0000-4000-8000-000000027005'::uuid,
            2147483647,
            '00000000-0000-4000-8000-000000000041'::uuid,
            '00000000-0000-4000-8000-000000000052'::uuid,
            '00000000-0000-4000-8000-000000000068'::uuid,
            'synthetic'::roster_population,
            'sms'::notification_channel,
            'invalid'::endpoint_status,
            'SYNTHETIC_INVALID',
            '2026-08-11T16:04:00.000Z'::timestamptz
          )
        `),
      /cannot insert a non-DEFAULT value into column "sequence"/iu,
    );
  });

  test('upgrades legacy SMS opt-outs by appending provenance without rewriting truth', async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }
    const adminDatabase = databaseConnection().db;
    const migrationProofDatabaseName = `psd_eoc_issue14_upgrade_${process.pid}_${Date.now()}`;
    if (!/^[a-z0-9_]{1,63}$/u.test(migrationProofDatabaseName)) {
      throw new Error('The synthetic migration-proof database name is unsafe.');
    }
    const quotedMigrationProofDatabaseName = `"${migrationProofDatabaseName}"`;
    let migrationProofConnection: PostgresDatabaseConnection | undefined;
    let createdMigrationProofDatabase = false;

    try {
      await adminDatabase.execute(
        sql.raw(`create database ${quotedMigrationProofDatabaseName}`),
      );
      createdMigrationProofDatabase = true;
      const migrationProofUrl = new URL(testDatabaseUrl);
      migrationProofUrl.pathname = `/${migrationProofDatabaseName}`;
      const createdConnection = createDatabaseClient({
        driver: 'postgres',
        url: migrationProofUrl.toString(),
        maxConnections: 1,
      });
      if (createdConnection.driver !== 'postgres') {
        throw new Error(
          'Migration proof requires the direct PostgreSQL driver.',
        );
      }
      migrationProofConnection = createdConnection;

      for (const migration of ISSUE_14_PRE_LIFECYCLE_MIGRATIONS) {
        await applySqlMigrationFile(createdConnection.db, migration);
      }
      await seedDatabase(createdConnection.db, {
        // Written here with the columns this schema actually has: Drizzle emits
        // every column of a table it inserts into, so seeding group sources
        // through the current schema fails against a database held at an earlier
        // migration. Runs after facilities and before the roster source
        // configuration that references them.
        async insertGroupSources(transaction) {
          await transaction.execute(sql`
      insert into group_sources (
        id, kind, purpose, facility_id, display_name, active,
        google_group_id, email, fixture_key, created_at
      ) values
        (
          '00000000-0000-4000-8000-000000000030'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000001'::uuid,
          'Synthetic North Staff',
          true, null, null, 'synthetic-north-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000031'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000002'::uuid,
          'Synthetic South Staff',
          true, null, null, 'synthetic-south-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000032'::uuid,
          'synthetic'::group_source_kind,
          'others'::group_purpose,
          null,
          'Synthetic District Support Staff',
          true, null, null, 'synthetic-district-support-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        )
      on conflict do nothing
      `);
        },
      });
      await createdConnection.db.execute(sql`
        insert into sms_opt_out_records (
          id,
          roster_snapshot_id,
          recipient_id,
          endpoint_id,
          population,
          channel,
          provider,
          provider_reference,
          recorded_at
        ) values
        (
          '00000000-0000-4000-8000-000000027010'::uuid,
          '00000000-0000-4000-8000-000000000041'::uuid,
          '00000000-0000-4000-8000-000000000050'::uuid,
          '00000000-0000-4000-8000-000000000062'::uuid,
          'synthetic'::roster_population,
          'sms'::notification_channel,
          'aws-eum-sms',
          'opt-out:synthetic-legacy-proof:1',
          '2026-08-11T17:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000027015'::uuid,
          '00000000-0000-4000-8000-000000000041'::uuid,
          '00000000-0000-4000-8000-000000000050'::uuid,
          '00000000-0000-4000-8000-000000000062'::uuid,
          'synthetic'::roster_population,
          'sms'::notification_channel,
          'aws-eum-sms',
          'opt-out:synthetic-legacy-proof:1',
          '2026-08-11T17:00:00.000Z'::timestamptz
        )
      `);
      await createdConnection.db.execute(sql`
        insert into endpoint_status_records (
          id,
          roster_snapshot_id,
          recipient_id,
          endpoint_id,
          population,
          channel,
          status,
          reason_code,
          recorded_at
        ) values (
          '00000000-0000-4000-8000-000000027011'::uuid,
          '00000000-0000-4000-8000-000000000041'::uuid,
          '00000000-0000-4000-8000-000000000050'::uuid,
          '00000000-0000-4000-8000-000000000062'::uuid,
          'synthetic'::roster_population,
          'sms'::notification_channel,
          'disabled'::endpoint_status,
          'SMS_OPTED_OUT',
          '2026-08-11T17:00:00.000Z'::timestamptz
        )
      `);

      await applySqlMigrationFile(
        createdConnection.db,
        ISSUE_14_LIFECYCLE_MIGRATION,
      );

      const lifecycleRows = await createdConnection.db.execute<{
        id: string;
        provider_occurrence_is_null: boolean;
        provider_occurrence_matches_legacy: boolean | null;
        provider: string | null;
        provider_reference: string | null;
        recorded_at_matches_legacy: boolean;
        sequence: number;
      }>(sql`
        select
          id::text as id,
          sequence,
          provider,
          provider_reference,
          provider_occurred_at is null as provider_occurrence_is_null,
          provider_occurred_at = '2026-08-11T17:00:00.000Z'::timestamptz
            as provider_occurrence_matches_legacy,
          recorded_at = '2026-08-11T17:00:00.000Z'::timestamptz
            as recorded_at_matches_legacy
        from endpoint_status_records
        where roster_snapshot_id =
            '00000000-0000-4000-8000-000000000041'::uuid
          and recipient_id = '00000000-0000-4000-8000-000000000050'::uuid
          and endpoint_id = '00000000-0000-4000-8000-000000000062'::uuid
        order by sequence
      `);
      expect(lifecycleRows).toHaveLength(2);
      expect(lifecycleRows[0]).toMatchObject({
        id: '00000000-0000-4000-8000-000000027011',
        provider: null,
        provider_reference: null,
        provider_occurrence_is_null: true,
        provider_occurrence_matches_legacy: null,
        recorded_at_matches_legacy: true,
      });
      expect(lifecycleRows[0]?.sequence).toBeGreaterThan(0);
      expect(lifecycleRows[1]?.sequence).toBeGreaterThan(
        lifecycleRows[0]?.sequence ?? 0,
      );
      expect(lifecycleRows[1]).toMatchObject({
        provider: 'aws-eum-sms',
        provider_reference: 'opt-out:synthetic-legacy-proof:1',
        provider_occurrence_is_null: false,
        provider_occurrence_matches_legacy: true,
      });

      const retainedLegacyOptOuts = await createdConnection.db.execute<{
        id: string;
        provider_occurrence_is_null: boolean;
        recorded_at_matches_legacy: boolean;
      }>(sql`
        select
          id::text as id,
          provider_occurred_at is null as provider_occurrence_is_null,
          recorded_at = '2026-08-11T17:00:00.000Z'::timestamptz
            as recorded_at_matches_legacy
        from sms_opt_out_records
        where id in (
          '00000000-0000-4000-8000-000000027010'::uuid,
          '00000000-0000-4000-8000-000000027015'::uuid
        )
        order by id
      `);
      expect([...retainedLegacyOptOuts]).toEqual([
        {
          id: '00000000-0000-4000-8000-000000027010',
          provider_occurrence_is_null: true,
          recorded_at_matches_legacy: true,
        },
        {
          id: '00000000-0000-4000-8000-000000027015',
          provider_occurrence_is_null: true,
          recorded_at_matches_legacy: true,
        },
      ]);

      const [latestAfterUpgrade] = await createdConnection.db.execute<{
        provider: string | null;
        provider_occurrence_matches_legacy: boolean;
        provider_reference: string | null;
        reason_code: string;
        status: string;
      }>(sql`
        select
          status,
          reason_code,
          provider,
          provider_reference,
          provider_occurred_at = '2026-08-11T17:00:00.000Z'::timestamptz
            as provider_occurrence_matches_legacy
        from endpoint_status_records
        where roster_snapshot_id =
            '00000000-0000-4000-8000-000000000041'::uuid
          and recipient_id = '00000000-0000-4000-8000-000000000050'::uuid
          and endpoint_id = '00000000-0000-4000-8000-000000000062'::uuid
        order by sequence desc
        limit 1
      `);
      expect(latestAfterUpgrade).toEqual({
        status: 'disabled',
        reason_code: 'SMS_OPTED_OUT',
        provider: 'aws-eum-sms',
        provider_reference: 'opt-out:synthetic-legacy-proof:1',
        provider_occurrence_matches_legacy: true,
      });

      const lifecycleConstraints = await createdConnection.db.execute<{
        constraint_name: string;
        table_name: string;
        validated: boolean;
      }>(sql`
        select
          relation.relname as table_name,
          constraint_record.conname as constraint_name,
          constraint_record.convalidated as validated
        from pg_catalog.pg_constraint as constraint_record
        join pg_catalog.pg_class as relation
          on relation.oid = constraint_record.conrelid
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and (
            (
              relation.relname = 'endpoint_status_records'
              and constraint_record.conname in (
                'endpoint_status_records_provider_identity',
                'endpoint_status_records_provider_format',
                'endpoint_status_records_provider_time',
                'endpoint_status_records_verified_active',
                'endpoint_status_records_managed_sms_opt_out'
              )
            )
            or (
              relation.relname = 'sms_opt_out_records'
              and constraint_record.conname in (
                'sms_opt_out_records_provider_time_required',
                'sms_opt_out_records_provider_time'
              )
            )
          )
        order by relation.relname, constraint_record.conname
      `);
      expect([...lifecycleConstraints]).toEqual([
        {
          table_name: 'endpoint_status_records',
          constraint_name: 'endpoint_status_records_managed_sms_opt_out',
          validated: false,
        },
        {
          table_name: 'endpoint_status_records',
          constraint_name: 'endpoint_status_records_provider_format',
          validated: true,
        },
        {
          table_name: 'endpoint_status_records',
          constraint_name: 'endpoint_status_records_provider_identity',
          validated: true,
        },
        {
          table_name: 'endpoint_status_records',
          constraint_name: 'endpoint_status_records_provider_time',
          validated: true,
        },
        {
          table_name: 'endpoint_status_records',
          constraint_name: 'endpoint_status_records_verified_active',
          validated: true,
        },
        {
          table_name: 'sms_opt_out_records',
          constraint_name: 'sms_opt_out_records_provider_time',
          validated: true,
        },
        {
          table_name: 'sms_opt_out_records',
          constraint_name: 'sms_opt_out_records_provider_time_required',
          validated: false,
        },
      ]);

      await expectConstraintViolation(
        () =>
          createdConnection.db.execute(sql`
            insert into endpoint_status_records (
              id,
              roster_snapshot_id,
              recipient_id,
              endpoint_id,
              population,
              channel,
              status,
              reason_code,
              recorded_at
            ) values (
              '00000000-0000-4000-8000-000000027012'::uuid,
              '00000000-0000-4000-8000-000000000041'::uuid,
              '00000000-0000-4000-8000-000000000051'::uuid,
              '00000000-0000-4000-8000-000000000065'::uuid,
              'synthetic'::roster_population,
              'sms'::notification_channel,
              'disabled'::endpoint_status,
              'SMS_OPTED_OUT',
              '2026-08-11T17:01:00.000Z'::timestamptz
            )
          `),
        'endpoint_status_records_managed_sms_opt_out',
      );
      await expectPostgresRejection(
        () =>
          createdConnection.db.execute(sql`
            update endpoint_status_records
            set recorded_at = '2026-08-11T17:02:00.000Z'::timestamptz
            where id = '00000000-0000-4000-8000-000000027011'::uuid
        `),
        /immutable truth cannot be changed/u,
      );
      // Migration 0029 removed the blanket retain guard, so a delete here is
      // no longer refused by trigger. What still stops the application is the
      // grant — and unlike the other tables whose delete assertions were
      // dropped, endpoint_status_records had no has_table_privilege check
      // anywhere in this file, so the protection was left entirely unasserted.
      // It is asserted here rather than claimed in a comment.
      const endpointStatusDeleteGrant = await createdConnection.db.execute<{
        can_delete: boolean;
      }>(sql`
        select has_table_privilege(
          'psd_eoc_app',
          'public.endpoint_status_records',
          'DELETE'
        ) as can_delete
      `);
      expect(endpointStatusDeleteGrant.map((row) => row.can_delete)).toEqual([
        false,
      ]);

      await expectConstraintViolation(
        () =>
          createdConnection.db.execute(sql`
            insert into endpoint_status_records (
              id,
              roster_snapshot_id,
              recipient_id,
              endpoint_id,
              population,
              channel,
              status,
              reason_code,
              provider,
              provider_reference,
              recorded_at
            ) values (
              '00000000-0000-4000-8000-000000027014'::uuid,
              '00000000-0000-4000-8000-000000000041'::uuid,
              '00000000-0000-4000-8000-000000000050'::uuid,
              '00000000-0000-4000-8000-000000000062'::uuid,
              'synthetic'::roster_population,
              'sms'::notification_channel,
              'active'::endpoint_status,
              'SMS_OPT_IN_PROVIDER_VERIFIED',
              'aws-eum-sms',
              'opt-in:synthetic-missing-occurrence:2',
              '2026-08-11T17:03:00.000Z'::timestamptz
            )
          `),
        'endpoint_status_records_provider_identity',
      );

      await createdConnection.db.execute(sql`
        insert into endpoint_status_records (
          id,
          roster_snapshot_id,
          recipient_id,
          endpoint_id,
          population,
          channel,
          status,
          reason_code,
          provider,
          provider_reference,
          provider_occurred_at,
          recorded_at
        ) values (
          '00000000-0000-4000-8000-000000027013'::uuid,
          '00000000-0000-4000-8000-000000000041'::uuid,
          '00000000-0000-4000-8000-000000000050'::uuid,
          '00000000-0000-4000-8000-000000000062'::uuid,
          'synthetic'::roster_population,
          'sms'::notification_channel,
          'active'::endpoint_status,
          'SMS_OPT_IN_PROVIDER_VERIFIED',
          'aws-eum-sms',
          'opt-in:synthetic-upgrade-proof:2',
          '2026-08-11T17:02:00.000Z'::timestamptz,
          '2026-08-11T17:03:00.000Z'::timestamptz
        )
      `);
      const [latestAfterOptIn] = await createdConnection.db.execute<{
        provider_occurrence_matches_expected: boolean;
        provider_reference: string | null;
        reason_code: string;
        sequence: number;
        status: string;
      }>(sql`
        select
          sequence,
          status,
          reason_code,
          provider_reference,
          provider_occurred_at = '2026-08-11T17:02:00.000Z'::timestamptz
            as provider_occurrence_matches_expected
        from endpoint_status_records
        where roster_snapshot_id =
            '00000000-0000-4000-8000-000000000041'::uuid
          and recipient_id = '00000000-0000-4000-8000-000000000050'::uuid
          and endpoint_id = '00000000-0000-4000-8000-000000000062'::uuid
        order by sequence desc
        limit 1
      `);
      expect(latestAfterOptIn).toMatchObject({
        status: 'active',
        reason_code: 'SMS_OPT_IN_PROVIDER_VERIFIED',
        provider_reference: 'opt-in:synthetic-upgrade-proof:2',
        provider_occurrence_matches_expected: true,
      });
      expect(latestAfterOptIn?.sequence).toBeGreaterThan(
        lifecycleRows[1]?.sequence ?? 0,
      );
    } finally {
      await migrationProofConnection?.close();
      if (createdMigrationProofDatabase) {
        await adminDatabase.execute(
          sql.raw(
            `drop database ${quotedMigrationProofDatabaseName} with (force)`,
          ),
        );
      }
    }
  });

  test('preserves issue 23 retained history and enforces canonical outbox and push truth', async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }
    const adminDatabase = databaseConnection().db;
    const migrationProofDatabaseName = `psd_eoc_issue23_upgrade_${process.pid}_${Date.now()}`;
    if (!/^[a-z0-9_]{1,63}$/u.test(migrationProofDatabaseName)) {
      throw new Error('The outbox migration-proof database name is unsafe.');
    }
    const quotedMigrationProofDatabaseName = `"${migrationProofDatabaseName}"`;
    let migrationProofConnection: PostgresDatabaseConnection | undefined;
    let createdMigrationProofDatabase = false;

    try {
      await adminDatabase.execute(
        sql.raw(`create database ${quotedMigrationProofDatabaseName}`),
      );
      createdMigrationProofDatabase = true;
      const migrationProofUrl = new URL(testDatabaseUrl);
      migrationProofUrl.pathname = `/${migrationProofDatabaseName}`;
      const createdConnection = createDatabaseClient({
        driver: 'postgres',
        url: migrationProofUrl.toString(),
        maxConnections: 1,
      });
      if (createdConnection.driver !== 'postgres') {
        throw new Error(
          'Outbox migration proof requires the direct PostgreSQL driver.',
        );
      }
      migrationProofConnection = createdConnection;

      for (const migration of ISSUE_23_PRE_OUTBOX_V2_MIGRATIONS) {
        await applySqlMigrationFile(createdConnection.db, migration);
      }
      await seedDatabase(createdConnection.db, {
        // Written here with the columns this schema actually has: Drizzle emits
        // every column of a table it inserts into, so seeding group sources
        // through the current schema fails against a database held at an earlier
        // migration. Runs after facilities and before the roster source
        // configuration that references them.
        async insertGroupSources(transaction) {
          await transaction.execute(sql`
      insert into group_sources (
        id, kind, purpose, facility_id, display_name, active,
        google_group_id, email, fixture_key, created_at
      ) values
        (
          '00000000-0000-4000-8000-000000000030'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000001'::uuid,
          'Synthetic North Staff',
          true, null, null, 'synthetic-north-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000031'::uuid,
          'synthetic'::group_source_kind,
          'building'::group_purpose,
          '00000000-0000-4000-8000-000000000002'::uuid,
          'Synthetic South Staff',
          true, null, null, 'synthetic-south-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        ),
        (
          '00000000-0000-4000-8000-000000000032'::uuid,
          'synthetic'::group_source_kind,
          'others'::group_purpose,
          null,
          'Synthetic District Support Staff',
          true, null, null, 'synthetic-district-support-staff',
          '2026-08-06T12:00:00.000Z'::timestamptz
        )
      on conflict do nothing
      `);
        },
      });

      await createdConnection.db.transaction(async (transaction) => {
        await transaction.execute(sql`
          insert into users (
            id,
            google_subject,
            email,
            display_name,
            facility_scope_kind,
            created_at
          ) values (
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            'synthetic-issue-23-upgrade-proof',
            -- The users_psd_email constraint, as it stood at this point in
            -- the migration history, required this exact domain. It is dropped
            -- at 0022; a fixture seeded before then must satisfy the old rule.
            'synthetic-issue-23-upgrade-proof@psd401.net',
            'Synthetic Issue 23 Upgrade Proof',
            'district'::facility_scope_kind,
            '2026-08-12T16:00:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into access_membership_snapshots (
            id,
            version,
            complete,
            sync_started_at,
            captured_at
          ) values (
            ${ISSUE_23_PUSH_UPGRADE_IDS.membershipSnapshot}::uuid,
            230023,
            true,
            '2026-08-12T15:58:00.000Z'::timestamptz,
            '2026-08-12T15:59:00.000Z'::timestamptz
          )
        `);
        // The historical fixture runs against migration 0008, where the
        // access-membership member table still exists and the session's
        // composite foreign key still points at it. It is dropped at 0021,
        // long after this fixture's world.
        await transaction.execute(sql`
          insert into access_membership_members (
            snapshot_id,
            user_id,
            google_subject,
            facility_scope_kind
          ) values (
            ${ISSUE_23_PUSH_UPGRADE_IDS.membershipSnapshot}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            'synthetic-issue-23-upgrade-proof',
            'district'::facility_scope_kind
          )
        `);
        await transaction.execute(sql`
          insert into device_enrollments (
            id,
            user_id,
            platform,
            unlock_method,
            installation_id,
            enrolled_at,
            last_seen_at
          ) values
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedDevice}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            'ios'::device_platform,
            'biometric'::device_unlock_method,
            'synthetic-issue-23-revoked-device',
            '2026-08-12T16:00:00.000Z'::timestamptz,
            '2026-08-12T16:15:00.000Z'::timestamptz
          ),
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedDevice}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            'android'::device_platform,
            'biometric'::device_unlock_method,
            'synthetic-issue-23-unrelated-device',
            '2026-08-12T16:00:00.000Z'::timestamptz,
            '2026-08-12T16:15:00.000Z'::timestamptz
          ),
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleDevice}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            'ios'::device_platform,
            'biometric'::device_unlock_method,
            'synthetic-issue-23-app-role-device',
            '2026-08-12T16:00:00.000Z'::timestamptz,
            '2026-08-12T16:15:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into sessions (
            id,
            user_id,
            device_enrollment_id,
            membership_snapshot_id,
            membership_valid_until,
            membership_grace_until,
            created_at,
            expires_at,
            revoked_at
          ) values
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedSession}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedDevice}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.membershipSnapshot}::uuid,
            '2026-08-12T18:00:00.000Z'::timestamptz,
            '2026-08-12T19:00:00.000Z'::timestamptz,
            '2026-08-12T16:00:00.000Z'::timestamptz,
            '2026-08-12T20:00:00.000Z'::timestamptz,
            '2026-08-12T16:10:00.000Z'::timestamptz
          ),
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedSession}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedDevice}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.membershipSnapshot}::uuid,
            '2026-08-12T18:00:00.000Z'::timestamptz,
            '2026-08-12T19:00:00.000Z'::timestamptz,
            '2026-08-12T16:00:00.000Z'::timestamptz,
            '2026-08-12T20:00:00.000Z'::timestamptz,
            null
          ),
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleSession}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.user}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleDevice}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.membershipSnapshot}::uuid,
            '2026-08-12T18:00:00.000Z'::timestamptz,
            '2026-08-12T19:00:00.000Z'::timestamptz,
            '2026-08-12T16:00:00.000Z'::timestamptz,
            '2026-08-12T20:00:00.000Z'::timestamptz,
            null
          )
        `);
        await transaction.execute(sql`
          insert into device_push_token_registrations (
            id,
            device_enrollment_id,
            platform,
            token,
            registered_at
          ) values
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.alreadyUnregisteredRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedDevice}::uuid,
            'ios'::device_platform,
            'synthetic-unroutable-issue-23-already-unregistered',
            '2026-08-12T16:01:00.000Z'::timestamptz
          ),
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedDevice}::uuid,
            'ios'::device_platform,
            'synthetic-unroutable-issue-23-before-revocation',
            '2026-08-12T16:05:00.000Z'::timestamptz
          ),
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.postRevocationRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedDevice}::uuid,
            'ios'::device_platform,
            'synthetic-unroutable-issue-23-after-revocation',
            '2026-08-12T16:15:00.000Z'::timestamptz
          ),
          (
            ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedDevice}::uuid,
            'android'::device_platform,
            'synthetic-unroutable-issue-23-unrelated-device',
            '2026-08-12T16:05:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into device_push_token_unregistrations (
            id,
            registration_id,
            device_enrollment_id,
            unregistered_at
          ) values (
            ${ISSUE_23_PUSH_UPGRADE_IDS.retainedUnregistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.alreadyUnregisteredRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedDevice}::uuid,
            '2026-08-12T16:06:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into session_revocations (
            id,
            session_id,
            revoked_by,
            reason_code,
            revoked_at
          ) values (
            ${ISSUE_23_PUSH_UPGRADE_IDS.retainedRevocation}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.revokedSession}::uuid,
            '{"kind":"system","serviceId":"issue-23-upgrade-proof"}'::jsonb,
            'SYNTHETIC_ISSUE_23_UPGRADE'::text,
            '2026-08-12T16:10:00.000Z'::timestamptz
          )
        `);
      });

      const retainedRegistrationsBefore = await createdConnection.db.execute<{
        device_enrollment_id: string;
        id: string;
        platform: string;
        registered_at: string;
        row_version: string;
      }>(sql`
          select
            id::text as id,
            device_enrollment_id::text as device_enrollment_id,
            platform::text as platform,
            registered_at::text as registered_at,
            xmin::text as row_version
          from device_push_token_registrations
          where id in (
            ${ISSUE_23_PUSH_UPGRADE_IDS.alreadyUnregisteredRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.postRevocationRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedRegistration}::uuid
          )
          order by id
        `);
      const [retainedUnregistrationBefore] = await createdConnection.db
        .execute<{
        device_enrollment_id: string;
        id: string;
        registration_id: string;
        row_version: string;
        unregistered_at: string;
      }>(sql`
          select
            id::text as id,
            registration_id::text as registration_id,
            device_enrollment_id::text as device_enrollment_id,
            unregistered_at::text as unregistered_at,
            xmin::text as row_version
          from device_push_token_unregistrations
          where id = ${ISSUE_23_PUSH_UPGRADE_IDS.retainedUnregistration}::uuid
        `);
      const [retainedRevocationBefore] = await createdConnection.db.execute<{
        id: string;
        reason_code: string;
        revoked_at: string;
        revoked_by: unknown;
        row_version: string;
        session_id: string;
      }>(sql`
          select
            id::text as id,
            session_id::text as session_id,
            revoked_by,
            reason_code,
            revoked_at::text as revoked_at,
            xmin::text as row_version
          from session_revocations
          where id = ${ISSUE_23_PUSH_UPGRADE_IDS.retainedRevocation}::uuid
        `);
      const legacyUpdatePrivileges = await createdConnection.db.execute<{
        can_update: boolean;
        table_name: string;
      }>(sql`
        select
          target.table_name,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'UPDATE'
          ) as can_update
        from unnest(array[
          'device_push_token_registrations',
          'device_push_token_unregistrations',
          'session_revocations'
        ]::text[]) as target(table_name)
        order by target.table_name
      `);
      expect([...legacyUpdatePrivileges]).toEqual([
        {
          table_name: 'device_push_token_registrations',
          can_update: true,
        },
        {
          table_name: 'device_push_token_unregistrations',
          can_update: true,
        },
        { table_name: 'session_revocations', can_update: true },
      ]);

      const createdAt = new Date('2026-08-12T16:00:00.000Z');
      const authorization = Object.freeze({
        kind: 'synthetic-training' as const,
        activationPreviewId: ISSUE_23_OUTBOX_IDS.activationPreview,
        consequenceDigest: 'd'.repeat(64),
        requestId: ISSUE_23_OUTBOX_IDS.request,
      });
      const channels = Object.freeze([
        Object.freeze({
          channel: 'push' as const,
          endpointCount: 1,
          renderedMessage: Object.freeze({
            eventKind: 'test' as const,
            templateMode: 'drill' as const,
            purpose: 'activation' as const,
            classificationMarker: 'DRILL' as const,
            channel: 'push' as const,
            title: '[DRILL] Retained outbox v1 proof',
            body: '[DRILL] Synthetic and unroutable test only.',
          }),
          integrationStatus: Object.freeze({
            integrationId: 'expo-push',
            label: 'mocked' as const,
            verifiedAt: null,
            verifiedByUserId: null,
            authorizationReference: null,
            reasonCode: null,
            observedAt: '2026-08-06T12:00:00.000Z',
          }),
        }),
        Object.freeze({
          channel: 'email' as const,
          endpointCount: 1,
          renderedMessage: Object.freeze({
            eventKind: 'test' as const,
            templateMode: 'drill' as const,
            purpose: 'activation' as const,
            classificationMarker: 'DRILL' as const,
            channel: 'email' as const,
            subject: '[DRILL] Retained outbox v1 proof',
            textBody: '[DRILL] Synthetic and unroutable test only.',
          }),
          integrationStatus: Object.freeze({
            integrationId: 'ses-email',
            label: 'mocked' as const,
            verifiedAt: null,
            verifiedByUserId: null,
            authorizationReference: null,
            reasonCode: null,
            observedAt: '2026-08-06T12:00:00.000Z',
          }),
        }),
      ]);
      const legacyMessage = NotificationOutboxMessageSchema.parse({
        version: 1,
        outboxId: ISSUE_23_OUTBOX_IDS.outbox,
        intentId: ISSUE_23_OUTBOX_IDS.intent,
        eventId: ISSUE_23_OUTBOX_IDS.event,
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'activation',
        eventTypeVersion: {
          id: ISSUE_23_OUTBOX_IDS.eventTypeVersion,
          templateMode: 'drill',
        },
        rosterSnapshotId: ISSUE_23_OUTBOX_IDS.roster,
        rosterPopulation: 'synthetic',
        requestId: ISSUE_23_OUTBOX_IDS.request,
        authorization,
        channels,
        createdAt: createdAt.toISOString(),
      });

      // What the row actually held before #292 retired the audience layer.
      // `legacyMessage` is the same message read through today's contract, which
      // no longer declares the key; the stored copy has to keep it, because the
      // check constraint on this schema asserts it matches the columns.
      const historicalMessage = {
        ...legacyMessage,
        audienceConfig: { id: RETIRED_AUDIENCE_ID, version: 1 },
      };
      await stageRetiredAudienceConfiguration(
        createdConnection.db,
        ISSUE_23_OUTBOX_IDS.facility,
      );
      await createdConnection.db.transaction(async (transaction) => {
        await transaction.execute(insertSyntheticTestEvent);
        // This fixture deliberately runs against the pre-0008 schema. Use its
        // exact historical column set so the current Drizzle model cannot add
        // later issue-30 columns before the migration under test exists.
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
          ) values (
            ${ISSUE_23_OUTBOX_IDS.intent}::uuid,
            ${ISSUE_23_OUTBOX_IDS.event}::uuid,
            'test'::event_kind,
            'drill'::template_mode,
            'activation'::notification_purpose,
            ${ISSUE_23_OUTBOX_IDS.eventTypeVersion}::uuid,
            ${ISSUE_23_OUTBOX_IDS.roster}::uuid,
            'synthetic'::roster_population,
            ${RETIRED_AUDIENCE_ID}::uuid,
            1,
            ${JSON.stringify({ kind: 'system', serviceId: 'outbox-v1-migration-proof' })}::jsonb,
            'scheduled-job'::invocation_source,
            ${ISSUE_23_OUTBOX_IDS.request}::uuid,
            ${JSON.stringify(authorization)}::jsonb,
            ${createdAt.toISOString()}::timestamptz
          )
        `);
        await transaction.insert(notificationIntentChannels).values(
          legacyMessage.channels.map((channel, index) => ({
            intentId: ISSUE_23_OUTBOX_IDS.intent,
            sequence: index + 1,
            channel: channel.channel,
            eventKind: 'test' as const,
            templateMode: 'drill' as const,
            purpose: 'activation' as const,
            rosterPopulation: 'synthetic' as const,
            classificationMarker: 'DRILL' as const,
            endpointCount: channel.endpointCount,
            renderedMessage: channel.renderedMessage,
            integrationStatusId:
              channel.channel === 'push'
                ? ISSUE_23_OUTBOX_IDS.pushIntegrationStatus
                : ISSUE_23_OUTBOX_IDS.emailIntegrationStatus,
            integrationId: channel.integrationStatus.integrationId,
            integrationLabel: channel.integrationStatus.label,
          })),
        );
        // Raw SQL, not the Drizzle model: this schema still has the audience
        // columns and `outbox_message_truth` still requires the message to
        // repeat them, and the current model has neither.
        await transaction.execute(sql`
          insert into outbox (
            id, message_version, intent_id, event_id, event_kind,
            template_mode, purpose, event_type_version_id, roster_snapshot_id,
            roster_population, audience_config_id, audience_config_version,
            request_id, "authorization", channels, message, status, attempts,
            available_at, locked_until, published_at, failed_at,
            last_error_code, created_at
          ) values (
            ${ISSUE_23_OUTBOX_IDS.outbox}::uuid,
            1,
            ${ISSUE_23_OUTBOX_IDS.intent}::uuid,
            ${ISSUE_23_OUTBOX_IDS.event}::uuid,
            'test'::event_kind,
            'drill'::template_mode,
            'activation'::notification_purpose,
            ${ISSUE_23_OUTBOX_IDS.eventTypeVersion}::uuid,
            ${ISSUE_23_OUTBOX_IDS.roster}::uuid,
            'synthetic'::roster_population,
            ${RETIRED_AUDIENCE_ID}::uuid,
            1,
            ${ISSUE_23_OUTBOX_IDS.request}::uuid,
            ${JSON.stringify(authorization)}::jsonb,
            ${JSON.stringify(legacyMessage.channels)}::jsonb,
            ${JSON.stringify(historicalMessage)}::jsonb,
            'pending'::outbox_status,
            0,
            ${createdAt.toISOString()}::timestamptz,
            null, null, null, null,
            ${createdAt.toISOString()}::timestamptz
          )
        `);
      });
      const [beforeMigration] = await createdConnection.db.execute<{
        message: unknown;
        row_version: string;
      }>(sql`
        select message, xmin::text as row_version
        from outbox
        where id = ${ISSUE_23_OUTBOX_IDS.outbox}::uuid
      `);

      await applySqlMigrationFile(
        createdConnection.db,
        ISSUE_23_OUTBOX_V2_MIGRATION,
      );

      const retainedRegistrationsAfter = await createdConnection.db.execute<{
        device_enrollment_id: string;
        id: string;
        platform: string;
        registered_at: string;
        row_version: string;
      }>(sql`
          select
            id::text as id,
            device_enrollment_id::text as device_enrollment_id,
            platform::text as platform,
            registered_at::text as registered_at,
            xmin::text as row_version
          from device_push_token_registrations
          where id in (
            ${ISSUE_23_PUSH_UPGRADE_IDS.alreadyUnregisteredRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.postRevocationRegistration}::uuid,
            ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedRegistration}::uuid
          )
          order by id
        `);
      expect([...retainedRegistrationsAfter]).toEqual([
        ...retainedRegistrationsBefore,
      ]);

      const [retainedUnregistrationAfter] = await createdConnection.db.execute<{
        device_enrollment_id: string;
        id: string;
        registration_id: string;
        row_version: string;
        unregistered_at: string;
      }>(sql`
          select
            id::text as id,
            registration_id::text as registration_id,
            device_enrollment_id::text as device_enrollment_id,
            unregistered_at::text as unregistered_at,
            xmin::text as row_version
          from device_push_token_unregistrations
          where id = ${ISSUE_23_PUSH_UPGRADE_IDS.retainedUnregistration}::uuid
        `);
      expect(retainedUnregistrationAfter).toEqual(retainedUnregistrationBefore);

      const [retainedRevocationAfter] = await createdConnection.db.execute<{
        id: string;
        reason_code: string;
        revoked_at: string;
        revoked_by: unknown;
        row_version: string;
        session_id: string;
      }>(sql`
          select
            id::text as id,
            session_id::text as session_id,
            revoked_by,
            reason_code,
            revoked_at::text as revoked_at,
            xmin::text as row_version
          from session_revocations
          where id = ${ISSUE_23_PUSH_UPGRADE_IDS.retainedRevocation}::uuid
        `);
      expect(retainedRevocationAfter).toEqual(retainedRevocationBefore);

      const backfilledPushState = await createdConnection.db.execute<{
        device_matches: boolean;
        registration_id: string;
        unregistered: boolean;
        unregistered_at_matches_expected: boolean;
      }>(sql`
        select
          registration.id::text as registration_id,
          unregistration.id is not null as unregistered,
          unregistration.device_enrollment_id is not distinct from
            case
              when unregistration.id is null then null
              else registration.device_enrollment_id
            end as device_matches,
          unregistration.unregistered_at is not distinct from
            case registration.id
              when ${ISSUE_23_PUSH_UPGRADE_IDS.alreadyUnregisteredRegistration}::uuid
                then '2026-08-12T16:06:00.000Z'::timestamptz
              when ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid
                then '2026-08-12T16:10:00.000Z'::timestamptz
              else null
            end as unregistered_at_matches_expected
        from device_push_token_registrations as registration
        left join device_push_token_unregistrations as unregistration
          on unregistration.registration_id = registration.id
        where registration.id in (
          ${ISSUE_23_PUSH_UPGRADE_IDS.alreadyUnregisteredRegistration}::uuid,
          ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid,
          ${ISSUE_23_PUSH_UPGRADE_IDS.postRevocationRegistration}::uuid,
          ${ISSUE_23_PUSH_UPGRADE_IDS.unrelatedRegistration}::uuid
        )
        order by registration.id
      `);
      expect([...backfilledPushState]).toEqual([
        {
          registration_id:
            ISSUE_23_PUSH_UPGRADE_IDS.alreadyUnregisteredRegistration,
          unregistered: true,
          device_matches: true,
          unregistered_at_matches_expected: true,
        },
        {
          registration_id: ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration,
          unregistered: true,
          device_matches: true,
          unregistered_at_matches_expected: true,
        },
        {
          registration_id: ISSUE_23_PUSH_UPGRADE_IDS.postRevocationRegistration,
          unregistered: false,
          device_matches: true,
          unregistered_at_matches_expected: true,
        },
        {
          registration_id: ISSUE_23_PUSH_UPGRADE_IDS.unrelatedRegistration,
          unregistered: false,
          device_matches: true,
          unregistered_at_matches_expected: true,
        },
      ]);

      const pushTruthPrivileges = await createdConnection.db.execute<{
        can_delete: boolean;
        can_insert: boolean;
        can_lock_identity: boolean;
        can_references: boolean;
        can_select: boolean;
        can_trigger: boolean;
        can_truncate: boolean;
        can_update: boolean;
        public_has_any_privilege: boolean;
        table_name: string;
      }>(sql`
        select
          target.table_name,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'SELECT'
          ) as can_select,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'INSERT'
          ) as can_insert,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'UPDATE'
          ) as can_update,
          has_column_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'id',
            'UPDATE'
          ) as can_lock_identity,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'DELETE'
          ) as can_delete,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'TRUNCATE'
          ) as can_truncate,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'REFERENCES'
          ) as can_references,
          has_table_privilege(
            'psd_eoc_app',
            'public.' || target.table_name,
            'TRIGGER'
          ) as can_trigger,
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
              and public_table.relname = target.table_name
              and public_privilege.grantee = 0
          ) as public_has_any_privilege
        from unnest(array[
          'device_push_token_registrations',
          'device_push_token_unregistrations',
          'session_revocations'
        ]::text[]) as target(table_name)
        order by target.table_name
      `);
      expect([...pushTruthPrivileges]).toEqual(
        [
          'device_push_token_registrations',
          'device_push_token_unregistrations',
          'session_revocations',
        ].map((tableName) => ({
          table_name: tableName,
          can_select: true,
          can_insert: true,
          can_update: false,
          can_lock_identity: tableName === 'device_push_token_registrations',
          can_delete: false,
          can_truncate: false,
          can_references: false,
          can_trigger: false,
          public_has_any_privilege: false,
        })),
      );

      const pushTruthTriggers = await createdConnection.db.execute<{
        action_orientation: string;
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
          action_orientation,
          event_manipulation,
          action_statement
        from information_schema.triggers
        where trigger_schema = 'public'
          and trigger_name in (
            'device_push_token_registrations_immutable_guard',
            'device_push_token_unregistrations_immutable_guard',
            'session_revocations_immutable_guard'
          )
        order by event_object_table
      `);
      expect([...pushTruthTriggers]).toEqual(
        [
          'device_push_token_registrations',
          'device_push_token_unregistrations',
          'session_revocations',
        ].map((tableName) => ({
          event_object_table: tableName,
          trigger_name: `${tableName}_immutable_guard`,
          action_timing: 'BEFORE',
          action_orientation: 'ROW',
          event_manipulation: 'UPDATE',
          action_statement:
            'EXECUTE FUNCTION psd_eoc_reject_immutable_mutation()',
        })),
      );

      const appRoleWriteProof = await createdConnection.db.transaction(
        async (transaction) => {
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(sql`
            update sessions
            set revoked_at = '2026-08-12T16:21:00.000Z'::timestamptz
            where id = ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleSession}::uuid
          `);
          await transaction.execute(sql`
            insert into device_push_token_registrations (
              id,
              device_enrollment_id,
              platform,
              token,
              registered_at
            ) values (
              ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleRegistration}::uuid,
              ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleDevice}::uuid,
              'ios'::device_platform,
              'synthetic-unroutable-issue-23-app-role-proof',
              '2026-08-12T16:20:00.000Z'::timestamptz
            )
          `);
          await transaction.execute(sql`
            insert into session_revocations (
              id,
              session_id,
              revoked_by,
              reason_code,
              revoked_at
            ) values (
              ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleRevocation}::uuid,
              ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleSession}::uuid,
              '{"kind":"system","serviceId":"issue-23-app-role-proof"}'::jsonb,
              'SYNTHETIC_ISSUE_23_APP_ROLE'::text,
              '2026-08-12T16:21:00.000Z'::timestamptz
            )
          `);
          await transaction.execute(sql`
            insert into device_push_token_unregistrations (
              id,
              registration_id,
              device_enrollment_id,
              unregistered_at
            ) values (
              ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleUnregistration}::uuid,
              ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleRegistration}::uuid,
              ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleDevice}::uuid,
              '2026-08-12T16:21:00.000Z'::timestamptz
            )
          `);

          const [proof] = await transaction.execute<{
            registration_visible: boolean;
            registration_lock_visible: boolean;
            revocation_visible: boolean;
            unregistration_visible: boolean;
          }>(sql`
            select
              exists (
                select 1
                from device_push_token_registrations
                where id = ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleRegistration}::uuid
              ) as registration_visible,
              exists (
                select id
                from device_push_token_registrations
                where id = ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleRegistration}::uuid
                for update
              ) as registration_lock_visible,
              exists (
                select 1
                from session_revocations
                where id = ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleRevocation}::uuid
              ) as revocation_visible,
              exists (
                select 1
                from device_push_token_unregistrations
                where id = ${ISSUE_23_PUSH_UPGRADE_IDS.appRoleUnregistration}::uuid
              ) as unregistration_visible
          `);
          return proof;
        },
      );
      expect(appRoleWriteProof).toEqual({
        registration_visible: true,
        registration_lock_visible: true,
        revocation_visible: true,
        unregistration_visible: true,
      });

      await expectPostgresRejection(
        () =>
          createdConnection.db.transaction(async (transaction) => {
            await transaction.execute(sql`set local role "psd_eoc_app"`);
            await transaction.execute(sql`
              update session_revocations
              set reason_code = reason_code
              where id = ${ISSUE_23_PUSH_UPGRADE_IDS.retainedRevocation}::uuid
            `);
          }),
        /permission denied for table session_revocations/iu,
      );
      await expectPostgresRejection(
        () =>
          createdConnection.db.transaction(async (transaction) => {
            await transaction.execute(sql`set local role "psd_eoc_app"`);
            await transaction.execute(sql`
              update device_push_token_registrations
              set registered_at = registered_at
              where id = ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid
            `);
          }),
        /permission denied for table device_push_token_registrations/iu,
      );
      await expectPostgresRejection(
        () =>
          createdConnection.db.transaction(async (transaction) => {
            await transaction.execute(sql`set local role "psd_eoc_app"`);
            await transaction.execute(sql`
              update device_push_token_registrations
              set id = id
              where id = ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid
            `);
          }),
        /PSD EOC immutable truth cannot be changed on device_push_token_registrations/iu,
      );
      await expectPostgresRejection(
        () =>
          createdConnection.db.transaction(async (transaction) => {
            await transaction.execute(sql`set local role "psd_eoc_app"`);
            await transaction.execute(sql`
              update device_push_token_unregistrations
              set unregistered_at = unregistered_at
              where registration_id = ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid
            `);
          }),
        /permission denied for table device_push_token_unregistrations/iu,
      );

      await expectPostgresRejection(
        () =>
          createdConnection.db.execute(sql`
            update session_revocations
            set reason_code = reason_code
            where id = ${ISSUE_23_PUSH_UPGRADE_IDS.retainedRevocation}::uuid
          `),
        /PSD EOC immutable truth cannot be changed on session_revocations/iu,
      );
      await expectPostgresRejection(
        () =>
          createdConnection.db.execute(sql`
            update device_push_token_registrations
            set registered_at = registered_at
            where id = ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid
          `),
        /PSD EOC immutable truth cannot be changed on device_push_token_registrations/iu,
      );
      await expectPostgresRejection(
        () =>
          createdConnection.db.execute(sql`
            update device_push_token_unregistrations
            set unregistered_at = unregistered_at
            where registration_id = ${ISSUE_23_PUSH_UPGRADE_IDS.preRevocationRegistration}::uuid
          `),
        /PSD EOC immutable truth cannot be changed on device_push_token_unregistrations/iu,
      );

      const [afterMigration] = await createdConnection.db.execute<{
        message: unknown;
        row_version: string;
      }>(sql`
        select message, xmin::text as row_version
        from outbox
        where id = ${ISSUE_23_OUTBOX_IDS.outbox}::uuid
      `);
      expect(afterMigration).toEqual(beforeMigration);
      // Byte for byte above; here, that what survived is still the message the
      // contract describes once the retired `audienceConfig` key is set aside.
      const survivingMessage = { ...(afterMigration?.message as object) };
      expect(survivingMessage).toHaveProperty('audienceConfig');
      delete (survivingMessage as { audienceConfig?: unknown }).audienceConfig;
      expect(NotificationOutboxMessageSchema.parse(survivingMessage)).toEqual(
        legacyMessage,
      );

      const constraints = await createdConnection.db.execute<{
        constraint_name: string;
        validated: boolean;
      }>(sql`
        select conname as constraint_name, convalidated as validated
        from pg_catalog.pg_constraint
        where conrelid = 'public.outbox'::regclass
          and conname in ('outbox_message_truth', 'outbox_message_version')
        order by conname
      `);
      expect([...constraints]).toEqual([
        { constraint_name: 'outbox_message_truth', validated: true },
        { constraint_name: 'outbox_message_version', validated: true },
      ]);

      await createdConnection.db.execute(sql`
        create temporary table outbox_version_probe
        (like outbox including defaults including constraints)
      `);
      await createdConnection.db.execute(sql`
        insert into outbox_version_probe
        select * from outbox where id = ${ISSUE_23_OUTBOX_IDS.outbox}::uuid
      `);
      await createdConnection.db.execute(sql`
        update outbox_version_probe
        set
          message_version = 2,
          message = jsonb_set(
            jsonb_set(message, '{version}', '2'::jsonb),
            '{facilityId}',
            to_jsonb(${ISSUE_23_OUTBOX_IDS.facility}::text)
          )
      `);
      const [version2Probe] = await createdConnection.db.execute<{
        message: unknown;
        message_version: number;
      }>(sql`
        select message_version, message from outbox_version_probe
      `);
      expect(version2Probe?.message_version).toBe(2);
      const version2Message = { ...(version2Probe?.message as object) };
      delete (version2Message as { audienceConfig?: unknown }).audienceConfig;
      expect(NotificationOutboxMessageSchema.parse(version2Message)).toEqual(
        expect.objectContaining({
          version: 2,
          facilityId: ISSUE_23_OUTBOX_IDS.facility,
        }),
      );

      await expectConstraintViolation(
        () =>
          createdConnection.db.execute(sql`
            update outbox_version_probe set message = message - 'facilityId'
          `),
        'outbox_message_truth',
      );
      await expectConstraintViolation(
        () =>
          createdConnection.db.execute(sql`
            update outbox_version_probe
            set
              message_version = 1,
              message = jsonb_set(message, '{version}', '1'::jsonb)
          `),
        'outbox_message_truth',
      );
      await expectPostgresRejection(
        () =>
          createdConnection.db.execute(sql`
            update outbox_version_probe
            set
              message_version = 3,
              message = jsonb_set(message, '{version}', '3'::jsonb)
          `),
        /outbox_message_(?:truth|version)/iu,
      );
    } finally {
      await migrationProofConnection?.close();
      if (createdMigrationProofDatabase) {
        await adminDatabase.execute(
          sql.raw(
            `drop database ${quotedMigrationProofDatabaseName} with (force)`,
          ),
        );
      }
    }
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
      // Only media_records still refuses DELETE by trigger. Its guard is
      // psd_eoc_reject_immutable_mutation, which is targeted at that table and
      // fires on both events. The other three were covered only by the blanket
      // retain guard migration 0029 removed; what stops the application
      // deleting them is the grant, asserted above — psd_eoc_app has never
      // held DELETE on any of them.
      if (tableName === 'media_records') {
        expect(events).toContain('DELETE');
      } else {
        expect(events).not.toContain('DELETE');
      }
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
      // The two *_retain_guard rows that used to sit here are gone: they were
      // instances of the blanket DELETE ban migration 0029 removed. The
      // *_immutable_guard triggers below are targeted and stay, so these rows
      // still cannot be rewritten — only the DELETE backstop is gone, and the
      // application was never granted DELETE on either table.
      {
        table: 'user_role_changes',
        name: 'user_role_changes_immutable_guard',
        timing: 'BEFORE',
        event: 'UPDATE',
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
        function_name: 'psd_eoc_reject_immutable_mutation',
        app_can_execute: false,
        public_can_execute: false,
      },
    ]);
  });

  test('hardens the complete access-snapshot privilege and trigger ledger', async () => {
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
        access_tables.table_name,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || access_tables.table_name,
          'SELECT'
        ) as can_select,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || access_tables.table_name,
          'INSERT'
        ) as can_insert,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || access_tables.table_name,
          'UPDATE'
        ) as can_update,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || access_tables.table_name,
          'DELETE'
        ) as can_delete,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || access_tables.table_name,
          'TRUNCATE'
        ) as can_truncate,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || access_tables.table_name,
          'REFERENCES'
        ) as can_references,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || access_tables.table_name,
          'TRIGGER'
        ) as can_trigger,
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
            and public_table.relname = access_tables.table_name
            and public_privilege.grantee = 0
        ) as public_has_any_privilege
      from unnest(array[
        'access_membership_snapshots'
      ]::text[]) as access_tables(table_name)
      order by access_tables.table_name
    `);
    expect([...tablePrivileges]).toEqual(
      ['access_membership_snapshots'].map((tableName) => ({
        table_name: tableName,
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        can_truncate: false,
        can_references: false,
        can_trigger: false,
        public_has_any_privilege: false,
      })),
    );

    const triggerLedger = await db.execute<{
      action_orientation: string;
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
        action_orientation,
        event_manipulation,
        action_statement
      from information_schema.triggers
      where trigger_schema = 'public'
        and trigger_name in (
          'access_membership_snapshots_admin_availability_lock',
          'users_admin_availability_lock',
          'user_facility_scopes_admin_availability_lock',
          'group_sources_admin_availability_lock',
          'group_sources_identity_guard',
          'access_membership_snapshots_immutable_guard'
        )
      order by event_object_table, trigger_name, event_manipulation
    `);
    expect(
      triggerLedger.map((trigger) => ({
        table: trigger.event_object_table,
        name: trigger.trigger_name,
        timing: trigger.action_timing,
        orientation: trigger.action_orientation,
        event: trigger.event_manipulation,
        function: trigger.action_statement,
      })),
    ).toEqual([
      {
        table: 'access_membership_snapshots',
        name: 'access_membership_snapshots_admin_availability_lock',
        timing: 'BEFORE',
        orientation: 'ROW',
        event: 'INSERT',
        function:
          'EXECUTE FUNCTION psd_eoc_lock_admin_availability_on_access_snapshot_insert()',
      },
      {
        table: 'access_membership_snapshots',
        name: 'access_membership_snapshots_immutable_guard',
        timing: 'BEFORE',
        orientation: 'ROW',
        event: 'UPDATE',
        function: 'EXECUTE FUNCTION psd_eoc_reject_access_snapshot_update()',
      },
      {
        table: 'group_sources',
        name: 'group_sources_admin_availability_lock',
        timing: 'BEFORE',
        orientation: 'STATEMENT',
        event: 'INSERT',
        function:
          'EXECUTE FUNCTION psd_eoc_lock_admin_availability_on_access_group_write()',
      },
      {
        table: 'group_sources',
        name: 'group_sources_admin_availability_lock',
        timing: 'BEFORE',
        orientation: 'STATEMENT',
        event: 'UPDATE',
        function:
          'EXECUTE FUNCTION psd_eoc_lock_admin_availability_on_access_group_write()',
      },
      {
        table: 'group_sources',
        name: 'group_sources_identity_guard',
        timing: 'BEFORE',
        orientation: 'ROW',
        event: 'UPDATE',
        function:
          'EXECUTE FUNCTION psd_eoc_guard_group_source_identity_mutation()',
      },
      {
        table: 'user_facility_scopes',
        name: 'user_facility_scopes_admin_availability_lock',
        timing: 'BEFORE',
        orientation: 'STATEMENT',
        event: 'DELETE',
        function:
          'EXECUTE FUNCTION psd_eoc_lock_admin_availability_on_user_facility_scope_write()',
      },
      {
        table: 'user_facility_scopes',
        name: 'user_facility_scopes_admin_availability_lock',
        timing: 'BEFORE',
        orientation: 'STATEMENT',
        event: 'INSERT',
        function:
          'EXECUTE FUNCTION psd_eoc_lock_admin_availability_on_user_facility_scope_write()',
      },
      {
        table: 'user_facility_scopes',
        name: 'user_facility_scopes_admin_availability_lock',
        timing: 'BEFORE',
        orientation: 'STATEMENT',
        event: 'UPDATE',
        function:
          'EXECUTE FUNCTION psd_eoc_lock_admin_availability_on_user_facility_scope_write()',
      },
      {
        table: 'users',
        name: 'users_admin_availability_lock',
        timing: 'BEFORE',
        orientation: 'STATEMENT',
        event: 'UPDATE',
        function:
          'EXECUTE FUNCTION psd_eoc_lock_admin_availability_on_user_write()',
      },
    ]);

    const triggerFunctions = await db.execute<{
      app_can_execute: boolean;
      function_name: string;
      public_can_execute: boolean;
      settings: string[];
    }>(sql`
      select
        procedure.proname as function_name,
        coalesce(procedure.proconfig, array[]::text[]) as settings,
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
          'psd_eoc_lock_admin_availability_on_access_snapshot_insert',
          'psd_eoc_lock_admin_availability_on_user_facility_scope_write',
          'psd_eoc_lock_admin_availability_on_user_write',
          'psd_eoc_reject_access_snapshot_update'
        )
      order by procedure.proname
    `);
    expect([...triggerFunctions]).toEqual([
      {
        function_name:
          'psd_eoc_lock_admin_availability_on_access_snapshot_insert',
        settings: ['search_path=pg_catalog'],
        app_can_execute: false,
        public_can_execute: false,
      },
      {
        function_name:
          'psd_eoc_lock_admin_availability_on_user_facility_scope_write',
        settings: ['search_path=pg_catalog'],
        app_can_execute: false,
        public_can_execute: false,
      },
      {
        function_name: 'psd_eoc_lock_admin_availability_on_user_write',
        settings: ['search_path=pg_catalog'],
        app_can_execute: false,
        public_can_execute: false,
      },
      {
        function_name: 'psd_eoc_reject_access_snapshot_update',
        settings: ['search_path=pg_catalog'],
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
    // The companion DELETE assertion is gone. Migration 0029 removed the
    // blanket retain guard, so a delete here is no longer refused — and
    // leaving the assertion in place was actively harmful: the delete sits in
    // a transaction that also inserts the synthetic prerequisites, so once it
    // stopped raising, the transaction committed and every later fixture
    // insert in this file collided on users_pkey.
    //
    // What still stops the application deleting a role change is the grant,
    // asserted in 'limits app-role privileges': psd_eoc_app has never held
    // DELETE on user_role_changes. The UPDATE guard above is unchanged.
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
    // The delete assertion that stood here is gone with the blanket retain
    // guard migration 0029 removed. Leaving it would have been worse than
    // useless: the delete shares a transaction with the synthetic
    // prerequisites, so once it stopped raising, the transaction committed and
    // every later fixture insert in this file collided on users_pkey.
    //
    // DELETE on this table remains impossible for the application because the
    // grant was never made; the immutability assertion above is unchanged.
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
              4,
              '[]'::jsonb,
              'ready',
              '[]'::jsonb,
              repeat('e', 64),
              now(),
              now() + interval '5 minutes'
            from events as event
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

  test('makes every delivery-test approval, run, and report table append-only', async () => {
    const db = databaseConnection().db;
    const immutableTableNames = [
      'delivery_test_canary_eligibility_facts',
      'delivery_test_target_set_versions',
      'delivery_test_target_endpoints',
      'delivery_test_runs',
      'delivery_test_reports',
    ] as const;
    const privileges = await db.execute<{
      table_name: string;
      can_update: boolean;
      can_delete: boolean;
    }>(sql`
      select
        immutable_table.table_name,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || immutable_table.table_name,
          'UPDATE'
        ) as can_update,
        has_table_privilege(
          'psd_eoc_app',
          'public.' || immutable_table.table_name,
          'DELETE'
        ) as can_delete
      from (
        values
          ('delivery_test_canary_eligibility_facts'),
          ('delivery_test_target_set_versions'),
          ('delivery_test_target_endpoints'),
          ('delivery_test_runs'),
          ('delivery_test_reports')
      ) as immutable_table(table_name)
      order by immutable_table.table_name
    `);
    expect(privileges.map((row) => row.table_name)).toEqual(
      [...immutableTableNames].sort(),
    );
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
          'delivery_test_canary_eligibility_facts',
          'delivery_test_target_set_versions',
          'delivery_test_target_endpoints',
          'delivery_test_runs',
          'delivery_test_reports'
        )
        and event_manipulation in ('UPDATE', 'DELETE')
    `);
    for (const tableName of immutableTableNames) {
      const events = triggerEvents
        .filter((row) => row.event_object_table === tableName)
        .map((row) => row.event_manipulation);
      expect(events).toContain('UPDATE');
      // The delivery-test tables had no targeted DELETE guard of their own —
      // only the blanket retain guard migration 0029 removed. DELETE stays
      // impossible for the application because the grant was never made.
      expect(events).not.toContain('DELETE');
    }

    const mutationProbes = [
      {
        tableName: 'delivery_test_canary_eligibility_facts',
        updateStatement:
          'update delivery_test_canary_eligibility_facts set decided_at = decided_at',
      },
      {
        tableName: 'delivery_test_target_set_versions',
        updateStatement:
          'update delivery_test_target_set_versions set version = version',
      },
      {
        tableName: 'delivery_test_target_endpoints',
        updateStatement:
          'update delivery_test_target_endpoints set opted_in_at = opted_in_at',
      },
      {
        tableName: 'delivery_test_runs',
        updateStatement:
          'update delivery_test_runs set started_at = started_at',
      },
      {
        tableName: 'delivery_test_reports',
        updateStatement:
          'update delivery_test_reports set generated_at = generated_at',
      },
    ] as const;
    for (const probe of mutationProbes) {
      await expectPostgresRejection(
        () =>
          db.transaction(async (transaction) => {
            await insertDeliveryTestStructuralFixture(transaction);
            if (probe.tableName === 'delivery_test_reports') {
              await insertInitialDeliveryTestEvidence(transaction, 'unknown');
              await transaction.execute(insertIncompleteDeliveryTestReport);
            }
            await transaction.execute(sql.raw(probe.updateStatement));
          }),
        /immutable truth cannot be changed/u,
      );
      // Same as the sites above: the blanket retain guard is gone with
      // migration 0029, and this delete shared a transaction with the
      // structural fixture, so keeping the assertion would have committed it.
      // The delivery-test tables stay append-only for the application through
      // the grant, and their UPDATE guards are asserted directly above.
    }
  });

  test('reserves +999 SMS destinations for synthetic mock fixtures', async () => {
    const db = databaseConnection().db;
    await expectConstraintViolation(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`
            insert into roster_endpoints (
              id, roster_snapshot_id, recipient_id, population, channel,
              status, captured_at, platform, token, email, phone_number
            ) values (
              '00000000-0000-4000-8000-000000030080'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              '00000000-0000-4000-8000-000000030004'::uuid,
              'staff'::roster_population,
              'sms'::notification_channel,
              'active'::endpoint_status,
              '2026-08-13T18:00:00.000Z'::timestamptz,
              null,
              null,
              null,
              '+999000000000000'
            )
          `);
        }),
      'roster_endpoints_synthetic_unroutable',
    );

    const rollbackProbe = new Error('rollback +999 synthetic endpoint proof');
    try {
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`
          insert into roster_snapshots (
            id, version, population, complete, source_configuration_id,
            source_configuration_version, sync_started_at, captured_at
          ) values (
            '00000000-0000-4000-8000-000000030086'::uuid,
            2,
            'synthetic'::roster_population,
            true,
            '00000000-0000-4000-8000-000000000040'::uuid,
            1,
            '2026-08-13T17:59:00.000Z'::timestamptz,
            '2026-08-13T18:00:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into roster_recipients (
            id, roster_snapshot_id, population, google_subject, display_name
          ) values (
            '00000000-0000-4000-8000-000000030087'::uuid,
            '00000000-0000-4000-8000-000000030086'::uuid,
            'synthetic'::roster_population,
            null,
            'Synthetic +999 Constraint Probe'
          )
        `);
        const inserted = await transaction.execute<{ phone_number: string }>(
          sql`
            insert into roster_endpoints (
              id, roster_snapshot_id, recipient_id, population, channel,
              status, captured_at, platform, token, email, phone_number
            ) values (
              '00000000-0000-4000-8000-000000030081'::uuid,
              '00000000-0000-4000-8000-000000030086'::uuid,
              '00000000-0000-4000-8000-000000030087'::uuid,
              'synthetic'::roster_population,
              'sms'::notification_channel,
              'active'::endpoint_status,
              '2026-08-13T18:00:00.000Z'::timestamptz,
              null,
              null,
              null,
              '+999000000000000'
            )
            returning phone_number
          `,
        );
        expect(inserted[0]?.phone_number).toBe('+999000000000000');
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }
  });

  test('persists one controlled SMS canary from approved target through outbox and report truth', async () => {
    const db = databaseConnection().db;
    const rollbackProbe = new Error('rollback controlled SMS canary proof');
    try {
      await db.transaction(async (transaction) => {
        await insertDeliveryTestStructuralFixture(transaction);
        await transaction.execute(sql`
          insert into roster_endpoints (
            id, roster_snapshot_id, recipient_id, population, channel,
            status, captured_at, platform, token, email, phone_number
          ) values (
            '00000000-0000-4000-8000-000000279001'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            '00000000-0000-4000-8000-000000030004'::uuid,
            'staff'::roster_population,
            'sms'::notification_channel,
            'active'::endpoint_status,
            '2026-08-10T16:01:00.000Z'::timestamptz,
            null,
            null,
            null,
            '+12025550199'
          )
        `);
        await transaction.execute(sql`
          insert into delivery_test_canary_eligibility_facts (
            id, supersedes_fact_id, facility_id, roster_snapshot_id,
            roster_population, recipient_id, endpoint_id, channel, decision,
            opted_in_at, decided_at, decided_by_user_id,
            decided_with_session_id, authorization_reference
          ) values (
            '00000000-0000-4000-8000-000000279002'::uuid,
            null,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            '00000000-0000-4000-8000-000000030004'::uuid,
            '00000000-0000-4000-8000-000000279001'::uuid,
            'sms'::notification_channel,
            'approved-synthetic-canary',
            '2026-08-10T15:00:00.000Z'::timestamptz,
            '2026-08-10T16:03:00.000Z'::timestamptz,
            '00000000-0000-4000-8000-000000026001'::uuid,
            '00000000-0000-4000-8000-000000026004'::uuid,
            'synthetic-product-owner-sms-canary-approval'
          )
        `);
        await transaction.execute(sql`
          insert into delivery_test_target_set_versions (
            id, version, facility_id, roster_snapshot_id, roster_population,
            supersedes_version_id, endpoint_reference_digest,
            idempotency_request_id, approved_by_user_id,
            approved_with_session_id, approved_at, created_at
          ) values (
            '00000000-0000-4000-8000-000000279003'::uuid,
            2,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            '00000000-0000-4000-8000-000000030010'::uuid,
            repeat('f', 64),
            '00000000-0000-4000-8000-000000279004'::uuid,
            '00000000-0000-4000-8000-000000026001'::uuid,
            '00000000-0000-4000-8000-000000026004'::uuid,
            '2026-08-10T16:04:00.000Z'::timestamptz,
            '2026-08-10T16:03:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into delivery_test_target_endpoints (
            target_set_version_id, target_set_version, eligibility_fact_id,
            roster_snapshot_id, roster_population, recipient_id, endpoint_id,
            channel, attestation, opted_in_at, attested_at,
            attested_by_user_id, authorization_reference
          ) values (
            '00000000-0000-4000-8000-000000279003'::uuid,
            2,
            '00000000-0000-4000-8000-000000279002'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            '00000000-0000-4000-8000-000000030004'::uuid,
            '00000000-0000-4000-8000-000000279001'::uuid,
            'sms'::notification_channel,
            'approved-synthetic-canary',
            '2026-08-10T15:00:00.000Z'::timestamptz,
            '2026-08-10T16:03:00.000Z'::timestamptz,
            '00000000-0000-4000-8000-000000026001'::uuid,
            'synthetic-product-owner-sms-canary-approval'
          )
        `);
        await transaction.execute(
          sql`set constraints "delivery_test_target_sets_complete_guard" immediate`,
        );
        await transaction.execute(
          sql`set constraints "delivery_test_target_sets_complete_guard" deferred`,
        );
        await transaction.execute(sql`
          insert into integration_statuses (
            id, integration_id, label, verified_at, verified_by_user_id,
            authorization_reference, reason_code, observed_at
          ) values (
            '00000000-0000-4000-8000-000000279005'::uuid,
            'aws-eum-sms',
            'live-verified'::integration_truth_label,
            '2026-08-10T16:02:00.000Z'::timestamptz,
            '00000000-0000-4000-8000-000000026001'::uuid,
            'synthetic-product-owner-sms-live-verification',
            null,
            '2026-08-10T16:02:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into human_confirmation_records (
            id, capability_id, connectivity_epoch_id, confirmed_by_user_id,
            confirmed_with_session_id, consequence_digest, issued_at,
            expires_at, status, consumed_at, consumed_for_request_id,
            expired_at
          ) values (
            '00000000-0000-4000-8000-000000279006'::uuid,
            'start-event'::mutation_capability,
            '00000000-0000-4000-8000-000000030040'::uuid,
            '00000000-0000-4000-8000-000000026001'::uuid,
            '00000000-0000-4000-8000-000000026004'::uuid,
            repeat('a', 64),
            '2026-08-10T16:04:00.000Z'::timestamptz,
            '2026-08-10T16:09:00.000Z'::timestamptz,
            'consumed'::human_confirmation_status,
            '2026-08-10T16:06:00.000Z'::timestamptz,
            '00000000-0000-4000-8000-000000279007'::uuid,
            null
          )
        `);
        await transaction.execute(sql`
          insert into human_confirmation_actions (confirmation_id, action_id)
          values (
            '00000000-0000-4000-8000-000000279006'::uuid,
            'send-real-notification'::human_only_action
          )
        `);
        await transaction.execute(sql`
          insert into activation_previews (
            id, facility_id, kind, template_mode, event_type_version_id,
            roster_snapshot_id, roster_population, recipient_count, channels,
            send_readiness, blocking_reason_codes, active_event_ids,
            consequence_digest, delivery_test_target_set_id,
            delivery_test_target_set_version,
            delivery_test_endpoint_reference_digest, created_at, expires_at
          ) values (
            '00000000-0000-4000-8000-000000279008'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            'drill'::event_kind,
            'drill'::template_mode,
            '00000000-0000-4000-8000-000000000201'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            1,
            '[]'::jsonb,
            'ready',
            '[]'::jsonb,
            '[]'::jsonb,
            repeat('a', 64),
            '00000000-0000-4000-8000-000000279003'::uuid,
            2,
            repeat('f', 64),
            '2026-08-10T16:05:00.000Z'::timestamptz,
            '2026-08-10T16:10:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into events (
            id, facility_id, kind, template_mode, event_type_version_id,
            status, roster_snapshot_id, roster_population, created_by,
            created_at, activated_at, all_clear_at, reactivated_at, closed_at,
            correction_of_event_id, correction_reason,
            activation_authorization
          ) values (
            '00000000-0000-4000-8000-000000279009'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            'drill'::event_kind,
            'drill'::template_mode,
            '00000000-0000-4000-8000-000000000201'::uuid,
            'active'::event_status,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            jsonb_build_object(
              'kind', 'human',
              'userId', '00000000-0000-4000-8000-000000026001',
              'sessionId', '00000000-0000-4000-8000-000000026004'
            ),
            '2026-08-10T16:05:00.000Z'::timestamptz,
            '2026-08-10T16:06:00.000Z'::timestamptz,
            null,
            null,
            null,
            null,
            null,
            jsonb_build_object(
              'kind', 'human-confirmed',
              'activationPreviewId',
                '00000000-0000-4000-8000-000000279008',
              'preparedActivationId', null,
              'confirmationId', '00000000-0000-4000-8000-000000279006',
              'consequenceDigest', repeat('a', 64),
              'requestId', '00000000-0000-4000-8000-000000279007'
            )
          )
        `);
        await transaction.execute(sql`
          insert into notification_intents (
            id, event_id, event_kind, template_mode, purpose,
            event_type_version_id, roster_snapshot_id, roster_population,
            created_by, source, request_id, "authorization",
            delivery_test_target_set_id, delivery_test_target_set_version,
            delivery_test_endpoint_reference_digest, created_at
          ) values (
            '00000000-0000-4000-8000-000000279010'::uuid,
            '00000000-0000-4000-8000-000000279009'::uuid,
            'drill'::event_kind,
            'drill'::template_mode,
            'activation'::notification_purpose,
            '00000000-0000-4000-8000-000000000201'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            jsonb_build_object(
              'kind', 'human',
              'userId', '00000000-0000-4000-8000-000000026001',
              'sessionId', '00000000-0000-4000-8000-000000026004'
            ),
            'web'::invocation_source,
            '00000000-0000-4000-8000-000000279007'::uuid,
            jsonb_build_object(
              'kind', 'human-confirmed',
              'activationPreviewId',
                '00000000-0000-4000-8000-000000279008',
              'preparedActivationId', null,
              'confirmationId', '00000000-0000-4000-8000-000000279006',
              'consequenceDigest', repeat('a', 64),
              'requestId', '00000000-0000-4000-8000-000000279007'
            ),
            '00000000-0000-4000-8000-000000279003'::uuid,
            2,
            repeat('f', 64),
            '2026-08-10T16:06:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into notification_intent_channels (
            intent_id, sequence, channel, event_kind, template_mode, purpose,
            roster_population, classification_marker, endpoint_count,
            rendered_message, integration_status_id, integration_id,
            integration_label
          ) values (
            '00000000-0000-4000-8000-000000279010'::uuid,
            1,
            'sms'::notification_channel,
            'drill'::event_kind,
            'drill'::template_mode,
            'activation'::notification_purpose,
            'staff'::roster_population,
            'DRILL'::classification_marker,
            1,
            '{"channel":"sms","eventKind":"drill","templateMode":"drill","purpose":"activation","classificationMarker":"DRILL","body":"[DRILL] One approved SMS canary endpoint."}'::jsonb,
            '00000000-0000-4000-8000-000000279005'::uuid,
            'aws-eum-sms',
            'live-verified'::integration_truth_label
          )
        `);
        await transaction.execute(sql`
          insert into outbox (
            id, message_version, intent_id, event_id, event_kind,
            template_mode, purpose, event_type_version_id,
            roster_snapshot_id, roster_population, request_id,
            "authorization", channels, message, status, attempts,
            available_at, locked_until, published_at, failed_at,
            last_error_code, created_at
          )
          select
            '00000000-0000-4000-8000-000000279011'::uuid,
            1,
            intent.id,
            intent.event_id,
            intent.event_kind,
            intent.template_mode,
            intent.purpose,
            intent.event_type_version_id,
            intent.roster_snapshot_id,
            intent.roster_population,
            intent.request_id,
            intent."authorization",
            planned.channels,
            jsonb_build_object(
              'version', 1,
              'outboxId', '00000000-0000-4000-8000-000000279011',
              'intentId', intent.id::text,
              'eventId', intent.event_id::text,
              'eventKind', intent.event_kind::text,
              'templateMode', intent.template_mode::text,
              'purpose', intent.purpose::text,
              'eventTypeVersion', jsonb_build_object(
                'id', intent.event_type_version_id::text,
                'templateMode', intent.template_mode::text
              ),
              'rosterSnapshotId', intent.roster_snapshot_id::text,
              'rosterPopulation', intent.roster_population::text,
              'requestId', intent.request_id::text,
              'authorization', intent."authorization",
              'deliveryTest', jsonb_build_object(
                'purpose', 'monthly-live-delivery-test',
                'targetSet', jsonb_build_object(
                  'id', intent.delivery_test_target_set_id::text,
                  'version', intent.delivery_test_target_set_version
                ),
                'endpointReferenceDigest',
                  intent.delivery_test_endpoint_reference_digest
              ),
              'channels', planned.channels,
              'createdAt', intent.created_at
            ),
            'pending'::outbox_status,
            0,
            intent.created_at,
            null,
            null,
            null,
            null,
            intent.created_at
          from notification_intents as intent
          cross join lateral (
            select jsonb_agg(
              jsonb_build_object(
                'channel', channel.channel::text,
                'endpointCount', channel.endpoint_count,
                'renderedMessage', channel.rendered_message,
                'integrationStatus', jsonb_build_object(
                  'integrationId', channel.integration_id,
                  'label', channel.integration_label::text
                )
              ) order by channel.sequence
            ) as channels
            from notification_intent_channels as channel
            where channel.intent_id = intent.id
          ) as planned
          where intent.id = '00000000-0000-4000-8000-000000279010'::uuid
        `);
        await expectConstraintViolation(
          () =>
            transaction.transaction(async (probe) => {
              await probe.execute(sql`
                insert into outbox (
                  id, message_version, intent_id, event_id, event_kind,
                  template_mode, purpose, event_type_version_id,
                  roster_snapshot_id, roster_population, request_id,
                  "authorization", channels, message, status, attempts,
                  available_at, locked_until, published_at, failed_at,
                  last_error_code, created_at
                )
                select
                  id,
                  message_version,
                  intent_id,
                  event_id,
                  event_kind,
                  template_mode,
                  purpose,
                  event_type_version_id,
                  roster_snapshot_id,
                  roster_population,
                  request_id,
                  "authorization",
                  '[]'::jsonb,
                  jsonb_set(message, '{channels}', '[]'::jsonb),
                  status,
                  attempts,
                  available_at,
                  locked_until,
                  published_at,
                  failed_at,
                  last_error_code,
                  created_at
                from outbox
                where id = '00000000-0000-4000-8000-000000279011'::uuid
              `);
            }),
          'outbox_channel_plan_shape',
        );
        await transaction.execute(sql`
          insert into dispatch_batches (
            id, outbox_id, intent_id, event_id, event_kind, template_mode,
            purpose, event_type_version_id, roster_snapshot_id,
            roster_population, request_id, "authorization", channel,
            rendered_message, integration_status_id, integration_id,
            integration_label, sequence, endpoint_count, created_at
          )
          select
            '00000000-0000-4000-8000-000000279012'::uuid,
            outbox.id,
            outbox.intent_id,
            outbox.event_id,
            outbox.event_kind,
            outbox.template_mode,
            outbox.purpose,
            outbox.event_type_version_id,
            outbox.roster_snapshot_id,
            outbox.roster_population,
            outbox.request_id,
            outbox."authorization",
            channel.channel,
            channel.rendered_message,
            channel.integration_status_id,
            channel.integration_id,
            channel.integration_label,
            channel.sequence,
            channel.endpoint_count,
            '2026-08-10T16:06:30.000Z'::timestamptz
          from outbox
          join notification_intent_channels as channel
            on channel.intent_id = outbox.intent_id
          where outbox.id = '00000000-0000-4000-8000-000000279011'::uuid
        `);
        await transaction.execute(sql`
          insert into delivery_test_runs (
            id, activation_preview_id, event_id, notification_intent_id,
            target_set_version_id, target_set_version,
            endpoint_reference_digest, consequence_digest, confirmation_id,
            confirmation_status, request_id, started_by_user_id,
            started_with_session_id, started_at
          ) values (
            '00000000-0000-4000-8000-000000279013'::uuid,
            '00000000-0000-4000-8000-000000279008'::uuid,
            '00000000-0000-4000-8000-000000279009'::uuid,
            '00000000-0000-4000-8000-000000279010'::uuid,
            '00000000-0000-4000-8000-000000279003'::uuid,
            2,
            repeat('f', 64),
            repeat('a', 64),
            '00000000-0000-4000-8000-000000279006'::uuid,
            'consumed'::human_confirmation_status,
            '00000000-0000-4000-8000-000000279007'::uuid,
            '00000000-0000-4000-8000-000000026001'::uuid,
            '00000000-0000-4000-8000-000000026004'::uuid,
            '2026-08-10T16:06:00.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into channel_attempts (
            id, batch_id, intent_id, event_id, event_kind, template_mode,
            purpose, event_type_version_id, roster_snapshot_id,
            roster_population, recipient_id, endpoint_id, channel,
            attempt_number, attempted_at
          ) values (
            '00000000-0000-4000-8000-000000279014'::uuid,
            '00000000-0000-4000-8000-000000279012'::uuid,
            '00000000-0000-4000-8000-000000279010'::uuid,
            '00000000-0000-4000-8000-000000279009'::uuid,
            'drill'::event_kind,
            'drill'::template_mode,
            'activation'::notification_purpose,
            '00000000-0000-4000-8000-000000000201'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            '00000000-0000-4000-8000-000000030004'::uuid,
            '00000000-0000-4000-8000-000000279001'::uuid,
            'sms'::notification_channel,
            1,
            '2026-08-10T16:06:31.000Z'::timestamptz
          )
        `);
        await transaction.execute(sql`
          insert into delivery_evidence (
            id, subject_kind, subject_id, intent_id, attempt_id, sequence,
            previous_evidence_id, state, recorded_at, provider,
            provider_reference, proof, reason_code, diagnostic_digest
          ) values
          (
            '00000000-0000-4000-8000-000000279015'::uuid,
            'attempt'::delivery_evidence_subject_kind,
            '00000000-0000-4000-8000-000000279014'::uuid,
            null,
            '00000000-0000-4000-8000-000000279014'::uuid,
            1,
            null,
            'attempted'::delivery_truth_state,
            '2026-08-10T16:06:31.100Z'::timestamptz,
            null,
            null,
            null,
            null,
            null
          ),
          (
            '00000000-0000-4000-8000-000000279016'::uuid,
            'attempt'::delivery_evidence_subject_kind,
            '00000000-0000-4000-8000-000000279014'::uuid,
            null,
            '00000000-0000-4000-8000-000000279014'::uuid,
            2,
            '00000000-0000-4000-8000-000000279015'::uuid,
            'provider-accepted'::delivery_truth_state,
            '2026-08-10T16:06:31.700Z'::timestamptz,
            'aws-eum-sms',
            'synthetic-provider-reference:sms:1',
            null,
            null,
            null
          )
        `);
        await transaction.execute(sql`
          insert into delivery_test_reports (
            id, run_id, run_started_at, sequence, supersedes_report_id,
            status, channels, generated_at, finalized_by, source, reason_code
          ) values (
            '00000000-0000-4000-8000-000000279017'::uuid,
            '00000000-0000-4000-8000-000000279013'::uuid,
            '2026-08-10T16:06:00.000Z'::timestamptz,
            1,
            null,
            'succeeded'::delivery_test_report_status,
            jsonb_build_array(
              jsonb_build_object(
                'channel', 'sms',
                'endpointCount', 1,
                'activationToProviderAcceptMs', 31700,
                'latestStateCounts', jsonb_build_array(
                  jsonb_build_object(
                    'state', 'provider-accepted',
                    'count', 1
                  )
                ),
                'completedAt', '2026-08-10T16:06:31.700Z'
              )
            ),
            '2026-08-10T16:08:00.000Z'::timestamptz,
            jsonb_build_object(
              'kind', 'system',
              'serviceId', 'delivery-test-reporter'
            ),
            'worker'::invocation_source,
            null
          )
        `);
        await transaction.execute(sql`
          alter table delivery_test_reports
            disable trigger delivery_test_reports_monotonic_insert_guard
        `);
        await expectConstraintViolation(
          () =>
            transaction.transaction(async (probe) => {
              await probe.execute(sql`
                insert into delivery_test_reports (
                  id, run_id, run_started_at, sequence,
                  supersedes_report_id, status, channels, generated_at,
                  finalized_by, source, reason_code
                )
                select
                  id,
                  run_id,
                  run_started_at,
                  sequence,
                  supersedes_report_id,
                  status,
                  '[]'::jsonb,
                  generated_at,
                  finalized_by,
                  source,
                  reason_code
                from delivery_test_reports
                where id = '00000000-0000-4000-8000-000000279017'::uuid
              `);
            }),
          'delivery_test_reports_channels_shape',
        );
        await transaction.execute(sql`
          alter table delivery_test_reports
            enable trigger delivery_test_reports_monotonic_insert_guard
        `);
        const retained = await transaction.execute<{
          channel_count: number;
          endpoint_count: number;
        }>(sql`
          select
            jsonb_array_length(report.channels)::integer as channel_count,
            jsonb_array_length(outbox.channels)::integer as endpoint_count
          from delivery_test_reports as report
          join delivery_test_runs as run on run.id = report.run_id
          join outbox on outbox.intent_id = run.notification_intent_id
          where report.id = '00000000-0000-4000-8000-000000279017'::uuid
        `);
        expect([...retained]).toEqual([
          { channel_count: 1, endpoint_count: 1 },
        ]);
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }
  });

  test('accepts a rotation-safe revoke and fresh re-approval eligibility chain', async () => {
    const db = databaseConnection().db;
    const rollbackProbe = new Error('rollback eligibility chain proof');
    try {
      await db.transaction(async (transaction) => {
        await insertDeliveryTestStructuralFixture(transaction);
        await transaction.execute(sql`
          insert into delivery_test_canary_eligibility_facts (
            id, supersedes_fact_id, facility_id, roster_snapshot_id,
            roster_population, recipient_id, endpoint_id, channel, decision,
            opted_in_at, decided_at, decided_by_user_id,
            decided_with_session_id, authorization_reference
          ) values (
            '00000000-0000-4000-8000-000000030082'::uuid,
            '00000000-0000-4000-8000-000000030012'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            '00000000-0000-4000-8000-000000030004'::uuid,
            '00000000-0000-4000-8000-000000030006'::uuid,
            'push'::notification_channel,
            'revoked',
            '2026-08-10T15:00:00.000Z'::timestamptz,
            '2026-08-10T16:07:00.000Z'::timestamptz,
            '00000000-0000-4000-8000-000000026001'::uuid,
            '00000000-0000-4000-8000-000000026004'::uuid,
            'synthetic-product-owner-delivery-test-revocation'
          )
        `);
        await transaction.execute(sql`
          insert into delivery_test_canary_eligibility_facts (
            id, supersedes_fact_id, facility_id, roster_snapshot_id,
            roster_population, recipient_id, endpoint_id, channel, decision,
            opted_in_at, decided_at, decided_by_user_id,
            decided_with_session_id, authorization_reference
          ) values (
            '00000000-0000-4000-8000-000000030083'::uuid,
            '00000000-0000-4000-8000-000000030082'::uuid,
            '00000000-0000-4000-8000-000000000001'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            '00000000-0000-4000-8000-000000030004'::uuid,
            '00000000-0000-4000-8000-000000030006'::uuid,
            'push'::notification_channel,
            'approved-synthetic-canary',
            '2026-08-10T16:08:00.000Z'::timestamptz,
            '2026-08-10T16:09:00.000Z'::timestamptz,
            '00000000-0000-4000-8000-000000026001'::uuid,
            '00000000-0000-4000-8000-000000026004'::uuid,
            'synthetic-product-owner-delivery-test-reapproval'
          )
        `);
        const chain = await transaction.execute<{
          decision: string;
          id: string;
        }>(sql`
          select id::text as id, decision
          from delivery_test_canary_eligibility_facts
          where endpoint_id = '00000000-0000-4000-8000-000000030006'::uuid
          order by decided_at
        `);
        expect([...chain]).toEqual([
          {
            id: '00000000-0000-4000-8000-000000030012',
            decision: 'approved-synthetic-canary',
          },
          {
            id: '00000000-0000-4000-8000-000000030082',
            decision: 'revoked',
          },
          {
            id: '00000000-0000-4000-8000-000000030083',
            decision: 'approved-synthetic-canary',
          },
        ]);
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }
  });

  test('rejects every prepared activation that references a delivery-test preview', async () => {
    const db = databaseConnection().db;
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`
            insert into prepared_activations (
              id, activation_preview_id, facility_id, kind, template_mode,
              event_type_version_id, roster_snapshot_id, roster_population,
              consequence_digest, prepared_by, prepared_at
            ) values (
              '00000000-0000-4000-8000-000000030060'::uuid,
              '00000000-0000-4000-8000-000000030020'::uuid,
              '00000000-0000-4000-8000-000000000001'::uuid,
              'drill'::event_kind,
              'drill'::template_mode,
              '00000000-0000-4000-8000-000000000201'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              repeat('d', 64),
              jsonb_build_object(
                'kind', 'agent',
                'agentId', '00000000-0000-4000-8000-000000030061',
                'apiKeyId', '00000000-0000-4000-8000-000000030062'
              ),
              '2026-08-10T16:05:30.000Z'::timestamptz
            )
          `);
        }),
      /Delivery-test previews cannot be prepared/u,
    );
  });

  test('rejects a delivery-test attempt for an endpoint outside its pinned target set before evidence exists', async () => {
    const db = databaseConnection().db;
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`
            insert into channel_attempts (
              id, batch_id, intent_id, event_id, event_kind, template_mode,
              purpose, event_type_version_id, roster_snapshot_id,
              roster_population, recipient_id, endpoint_id, channel,
              attempt_number, attempted_at
            ) values (
              '00000000-0000-4000-8000-000000030063'::uuid,
              '00000000-0000-4000-8000-000000030034'::uuid,
              '00000000-0000-4000-8000-000000030032'::uuid,
              '00000000-0000-4000-8000-000000030030'::uuid,
              'drill'::event_kind,
              'drill'::template_mode,
              'activation'::notification_purpose,
              '00000000-0000-4000-8000-000000000201'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              '00000000-0000-4000-8000-000000030005'::uuid,
              '00000000-0000-4000-8000-000000030008'::uuid,
              'push'::notification_channel,
              1,
              '2026-08-10T16:06:31.000Z'::timestamptz
            )
          `);
        }),
      /not in the pinned approved target set/u,
    );

    const persistedEvidence = await db.execute<{ count: number }>(sql`
      select count(*)::integer as count
      from delivery_evidence
      where attempt_id = '00000000-0000-4000-8000-000000030063'::uuid
    `);
    expect(persistedEvidence[0]?.count).toBe(0);
  });

  test('rejects an attempt after the run-pinned target set is superseded', async () => {
    const db = databaseConnection().db;
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`
            insert into delivery_test_target_set_versions (
              id, version, facility_id, roster_snapshot_id,
              roster_population, supersedes_version_id,
              endpoint_reference_digest, idempotency_request_id,
              approved_by_user_id, approved_with_session_id,
              approved_at, created_at
            ) values (
              '00000000-0000-4000-8000-000000030100'::uuid,
              2,
              '00000000-0000-4000-8000-000000000001'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              '00000000-0000-4000-8000-000000030010'::uuid,
              repeat('e', 64),
              '00000000-0000-4000-8000-000000030101'::uuid,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '2026-08-10T16:09:00.000Z'::timestamptz,
              '2026-08-10T16:08:30.000Z'::timestamptz
            )
          `);
          await transaction.execute(sql`
            insert into delivery_test_target_endpoints (
              target_set_version_id, target_set_version,
              eligibility_fact_id, roster_snapshot_id, roster_population,
              recipient_id, endpoint_id, channel, attestation, opted_in_at,
              attested_at, attested_by_user_id, authorization_reference
            )
            select
              '00000000-0000-4000-8000-000000030100'::uuid,
              2,
              endpoint.eligibility_fact_id,
              endpoint.roster_snapshot_id,
              endpoint.roster_population,
              endpoint.recipient_id,
              endpoint.endpoint_id,
              endpoint.channel,
              endpoint.attestation,
              endpoint.opted_in_at,
              endpoint.attested_at,
              endpoint.attested_by_user_id,
              endpoint.authorization_reference
            from delivery_test_target_endpoints as endpoint
            where endpoint.target_set_version_id =
              '00000000-0000-4000-8000-000000030010'::uuid
          `);
          await transaction.execute(
            sql`set constraints "delivery_test_target_sets_complete_guard" immediate`,
          );
          await transaction.execute(
            sql`set constraints "delivery_test_target_sets_complete_guard" deferred`,
          );
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(sql`
            insert into channel_attempts (
              id, batch_id, intent_id, event_id, event_kind, template_mode,
              purpose, event_type_version_id, roster_snapshot_id,
              roster_population, recipient_id, endpoint_id, channel,
              attempt_number, attempted_at
            ) values (
              '00000000-0000-4000-8000-000000030102'::uuid,
              '00000000-0000-4000-8000-000000030034'::uuid,
              '00000000-0000-4000-8000-000000030032'::uuid,
              '00000000-0000-4000-8000-000000030030'::uuid,
              'drill'::event_kind,
              'drill'::template_mode,
              'activation'::notification_purpose,
              '00000000-0000-4000-8000-000000000201'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              '00000000-0000-4000-8000-000000030004'::uuid,
              '00000000-0000-4000-8000-000000030006'::uuid,
              'push'::notification_channel,
              1,
              '2026-08-10T16:09:30.000Z'::timestamptz
            )
          `);
        }),
      /target set has been superseded/u,
    );
  });

  test('binds eligibility facts to the target-set facility during construction and attempt admission', async () => {
    const db = databaseConnection().db;
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await insertCrossFacilityDeliveryTestEligibility(transaction);
          await transaction.execute(sql`
            insert into delivery_test_target_set_versions (
              id, version, facility_id, roster_snapshot_id,
              roster_population, supersedes_version_id,
              endpoint_reference_digest, idempotency_request_id,
              approved_by_user_id, approved_with_session_id,
              approved_at, created_at
            ) values (
              '00000000-0000-4000-8000-000000030084'::uuid,
              2,
              '00000000-0000-4000-8000-000000000001'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              '00000000-0000-4000-8000-000000030010'::uuid,
              repeat('f', 64),
              '00000000-0000-4000-8000-000000030088'::uuid,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '2026-08-10T16:09:00.000Z'::timestamptz,
              '2026-08-10T16:08:30.000Z'::timestamptz
            )
          `);
          await transaction.execute(sql`
            insert into delivery_test_target_endpoints (
              target_set_version_id, target_set_version,
              eligibility_fact_id, roster_snapshot_id, roster_population,
              recipient_id, endpoint_id, channel, attestation, opted_in_at,
              attested_at, attested_by_user_id, authorization_reference
            ) values (
              '00000000-0000-4000-8000-000000030084'::uuid,
              2,
              '00000000-0000-4000-8000-000000030085'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              '00000000-0000-4000-8000-000000030004'::uuid,
              '00000000-0000-4000-8000-000000030006'::uuid,
              'push'::notification_channel,
              'approved-synthetic-canary',
              '2026-08-10T15:00:00.000Z'::timestamptz,
              '2026-08-10T16:08:00.000Z'::timestamptz,
              '00000000-0000-4000-8000-000000026001'::uuid,
              'synthetic-cross-facility-canary-proof'
            )
          `);
        }),
      /exact current approved eligibility fact/u,
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await insertCrossFacilityDeliveryTestEligibility(transaction);
          // Simulate legacy/corrupt stored membership under the database owner;
          // the worker-facing admission guard must still fail closed.
          await transaction.execute(
            sql.raw(`
            alter table delivery_test_target_endpoints
            disable trigger delivery_test_target_endpoints_immutable_guard
          `),
          );
          await transaction.execute(sql`
            update delivery_test_target_endpoints
            set eligibility_fact_id =
              '00000000-0000-4000-8000-000000030085'::uuid
            where target_set_version_id =
              '00000000-0000-4000-8000-000000030010'::uuid
              and endpoint_id =
                '00000000-0000-4000-8000-000000030006'::uuid
          `);
          await transaction.execute(
            sql.raw(`
            alter table delivery_test_target_endpoints
            enable trigger delivery_test_target_endpoints_immutable_guard
          `),
          );
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(sql`
            insert into channel_attempts (
              id, batch_id, intent_id, event_id, event_kind, template_mode,
              purpose, event_type_version_id, roster_snapshot_id,
              roster_population, recipient_id, endpoint_id, channel,
              attempt_number, attempted_at
            ) values (
              '00000000-0000-4000-8000-000000030089'::uuid,
              '00000000-0000-4000-8000-000000030034'::uuid,
              '00000000-0000-4000-8000-000000030032'::uuid,
              '00000000-0000-4000-8000-000000030030'::uuid,
              'drill'::event_kind,
              'drill'::template_mode,
              'activation'::notification_purpose,
              '00000000-0000-4000-8000-000000000201'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              '00000000-0000-4000-8000-000000030004'::uuid,
              '00000000-0000-4000-8000-000000030006'::uuid,
              'push'::notification_channel,
              1,
              '2026-08-10T16:06:31.000Z'::timestamptz
            )
          `);
        }),
      /not in the pinned approved target set/u,
    );
  });

  test('derives report truth at insert so the app role cannot fabricate provider outcomes', async () => {
    const db = databaseConnection().db;
    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(
            insertFabricatedSucceededDeliveryTestReport,
          );
        }),
      /must exactly match persisted attempt and evidence truth/u,
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await insertInitialDeliveryTestEvidence(transaction, 'unknown');
          await transaction.execute(sql`set local role "psd_eoc_app"`);
          await transaction.execute(insertIncompleteDeliveryTestReport);
          await transaction.execute(sql`
            insert into delivery_test_reports (
              id, run_id, run_started_at, sequence, supersedes_report_id,
              status, channels, generated_at, finalized_by, source,
              reason_code
            )
            select
              '00000000-0000-4000-8000-000000030076'::uuid,
              run_id,
              run_started_at,
              sequence + 1,
              id,
              status,
              channels,
              generated_at + interval '1 second',
              finalized_by,
              'scheduled-job'::invocation_source,
              reason_code
            from delivery_test_reports
            where id = '00000000-0000-4000-8000-000000030043'::uuid
          `);
        }),
      /explicit worker service|delivery_test_reports_system_finalizer/u,
    );
  });

  test('requires contiguous target-set and destination-free report truth chains', async () => {
    const db = databaseConnection().db;
    const rollbackProbe = new Error(
      'rollback synthetic delivery-test report chain probe',
    );
    try {
      await db.transaction(async (transaction) => {
        await insertDeliveryTestStructuralFixture(transaction);
        await insertInitialDeliveryTestEvidence(transaction, 'unknown');
        await transaction.execute(insertIncompleteDeliveryTestReport);
        await insertSucceededDeliveryTestEvidence(transaction);
        await transaction.execute(insertSucceededDeliveryTestReport);
        const reports = await transaction.execute<{
          sequence: number;
          status: string;
          supersedes_report_id: string | null;
        }>(sql`
          select sequence, status, supersedes_report_id::text
          from delivery_test_reports
          where run_id = '00000000-0000-4000-8000-000000030042'::uuid
          order by sequence
        `);
        expect([...reports]).toEqual([
          {
            sequence: 1,
            status: 'incomplete',
            supersedes_report_id: null,
          },
          {
            sequence: 2,
            status: 'succeeded',
            supersedes_report_id: '00000000-0000-4000-8000-000000030043',
          },
        ]);
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`
            insert into delivery_test_target_set_versions (
              id, version, facility_id, roster_snapshot_id,
              roster_population, supersedes_version_id,
              endpoint_reference_digest, idempotency_request_id,
              approved_by_user_id, approved_with_session_id,
              approved_at, created_at
            ) values (
              '00000000-0000-4000-8000-000000030070'::uuid,
              3,
              '00000000-0000-4000-8000-000000000001'::uuid,
              '00000000-0000-4000-8000-000000030003'::uuid,
              'staff'::roster_population,
              '00000000-0000-4000-8000-000000030010'::uuid,
              repeat('f', 64),
              '00000000-0000-4000-8000-000000030071'::uuid,
              '00000000-0000-4000-8000-000000026001'::uuid,
              '00000000-0000-4000-8000-000000026004'::uuid,
              '2026-08-10T16:06:00.000Z'::timestamptz,
              '2026-08-10T16:05:00.000Z'::timestamptz
            )
          `);
        }),
      /must advance exactly once from the latest facility version/u,
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await insertInitialDeliveryTestEvidence(transaction, 'unknown');
          await transaction.execute(insertIncompleteDeliveryTestReport);
          await transaction.execute(sql`
            insert into delivery_test_reports (
              id, run_id, run_started_at, sequence, supersedes_report_id,
              status, channels, generated_at, finalized_by, source,
              reason_code
            )
            select
              '00000000-0000-4000-8000-000000030072'::uuid,
              run_id,
              run_started_at,
              3,
              id,
              'succeeded'::delivery_test_report_status,
              jsonb_build_array(
                jsonb_build_object(
                  'channel', 'push',
                  'endpointCount', 1,
                  'activationToProviderAcceptMs', 500,
                  'latestStateCounts', jsonb_build_array(
                    jsonb_build_object('state', 'delivered', 'count', 1)
                  ),
                  'completedAt', '2026-08-10T16:06:01.000Z'
                ),
                jsonb_build_object(
                  'channel', 'email',
                  'endpointCount', 1,
                  'activationToProviderAcceptMs', 700,
                  'latestStateCounts', jsonb_build_array(
                    jsonb_build_object(
                      'state', 'provider-accepted', 'count', 1
                    )
                  ),
                  'completedAt', '2026-08-10T16:06:01.000Z'
                )
              ),
              '2026-08-10T16:08:00.000Z'::timestamptz,
              jsonb_build_object(
                'kind', 'system',
                'serviceId', 'delivery-test-reporter'
              ),
              'worker'::invocation_source,
              null
            from delivery_test_reports
            where id = '00000000-0000-4000-8000-000000030043'::uuid
          `);
        }),
      /must supersede the latest report with the next sequence/u,
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`
            insert into delivery_test_reports (
              id, run_id, run_started_at, sequence, supersedes_report_id,
              status, channels, generated_at, finalized_by, source,
              reason_code
            ) values (
              '00000000-0000-4000-8000-000000030073'::uuid,
              '00000000-0000-4000-8000-000000030042'::uuid,
              '2026-08-10T16:06:00.000Z'::timestamptz,
              1,
              null,
              'succeeded'::delivery_test_report_status,
              jsonb_build_array(
                jsonb_build_object(
                  'channel', 'push',
                  'endpointCount', 1,
                  'activationToProviderAcceptMs', 500,
                  'latestStateCounts', jsonb_build_array(
                    jsonb_build_object('state', 'unknown', 'count', 1)
                  ),
                  'completedAt', '2026-08-10T16:06:01.000Z'
                ),
                jsonb_build_object(
                  'channel', 'email',
                  'endpointCount', 1,
                  'activationToProviderAcceptMs', 700,
                  'latestStateCounts', jsonb_build_array(
                    jsonb_build_object(
                      'state', 'provider-accepted', 'count', 1
                    )
                  ),
                  'completedAt', '2026-08-10T16:06:01.000Z'
                )
              ),
              '2026-08-10T16:08:00.000Z'::timestamptz,
              jsonb_build_object(
                'kind', 'system',
                'serviceId', 'delivery-test-reporter'
              ),
              'worker'::invocation_source,
              null
            )
          `);
        }),
      /require complete accepted or delivered truth/u,
    );

    await expectPostgresRejection(
      () =>
        db.transaction(async (transaction) => {
          await insertDeliveryTestStructuralFixture(transaction);
          await transaction.execute(sql`
            insert into delivery_test_reports (
              id, run_id, run_started_at, sequence, supersedes_report_id,
              status, channels, generated_at, finalized_by, source,
              reason_code
            ) values (
              '00000000-0000-4000-8000-000000030074'::uuid,
              '00000000-0000-4000-8000-000000030042'::uuid,
              '2026-08-10T16:06:00.000Z'::timestamptz,
              1,
              null,
              'failed'::delivery_test_report_status,
              jsonb_build_array(
                jsonb_build_object(
                  'channel', 'push',
                  'endpointCount', 1,
                  'activationToProviderAcceptMs', 500,
                  'latestStateCounts', jsonb_build_array(
                    jsonb_build_object(
                      'state', 'provider-accepted', 'count', 1
                    )
                  ),
                  'completedAt', '2026-08-10T16:06:01.000Z'
                ),
                jsonb_build_object(
                  'channel', 'email',
                  'endpointCount', 1,
                  'activationToProviderAcceptMs', 700,
                  'latestStateCounts', jsonb_build_array(
                    jsonb_build_object('state', 'delivered', 'count', 1)
                  ),
                  'completedAt', '2026-08-10T16:06:01.000Z'
                )
              ),
              '2026-08-10T16:08:00.000Z'::timestamptz,
              jsonb_build_object(
                'kind', 'system',
                'serviceId', 'delivery-test-reporter'
              ),
              'worker'::invocation_source,
              'PROVIDER_REJECTED'
            )
          `);
        }),
      /must retain failed or expired truth/u,
    );
  });

  test('monthly health persists the preceding configured-month outcome at every observation', async () => {
    const db = databaseConnection().db;
    const rollbackProbe = new Error(
      'rollback synthetic delivery-test report-head probe',
    );
    try {
      await db.transaction(async (transaction) => {
        await insertDeliveryTestStructuralFixture(transaction);
        await insertInitialDeliveryTestEvidence(transaction, 'failed');
        await transaction.execute(insertFailedDeliveryTestReport);
        await insertSucceededDeliveryTestEvidence(transaction);
        await transaction.execute(insertSucceededDeliveryTestReport);
        const failedMinuteRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-08-10T16:07:00.000Z',
              '2026-08-10T16:08:00.000Z',
            ),
          ),
        );
        expect([...failedMinuteRows]).toEqual([
          { failed_run_count: 1, missed_count: 1 },
        ]);

        const monthCloseRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-09-01T06:58:00.000Z',
              '2026-09-01T06:59:00.000Z',
            ),
          ),
        );
        expect([...monthCloseRows]).toEqual([
          { failed_run_count: 0, missed_count: 0 },
        ]);

        const easternMonthCloseRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-09-01T04:03:00.000Z',
              '2026-09-01T04:04:00.000Z',
              'America/New_York',
            ),
          ),
        );
        expect([...easternMonthCloseRows]).toEqual([
          { failed_run_count: 0, missed_count: 0 },
        ]);

        const afterSuccessfulPdtMonthRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-09-01T07:03:00.000Z',
              '2026-09-01T07:04:00.000Z',
            ),
          ),
        );
        expect([...afterSuccessfulPdtMonthRows]).toEqual([
          { failed_run_count: 0, missed_count: 0 },
        ]);

        const missedPdtBoundaryRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-10-01T06:58:00.000Z',
              '2026-10-01T06:59:00.000Z',
            ),
          ),
        );
        expect([...missedPdtBoundaryRows]).toEqual([
          { failed_run_count: 0, missed_count: 1 },
        ]);

        const afterPdtBoundaryRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-10-01T07:03:00.000Z',
              '2026-10-01T07:04:00.000Z',
            ),
          ),
        );
        expect([...afterPdtBoundaryRows]).toEqual([
          { failed_run_count: 0, missed_count: 1 },
        ]);

        const missedPstBoundaryRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-12-01T07:58:00.000Z',
              '2026-12-01T07:59:00.000Z',
            ),
          ),
        );
        expect([...missedPstBoundaryRows]).toEqual([
          { failed_run_count: 0, missed_count: 1 },
        ]);

        const afterPstBoundaryRows = await transaction.execute<{
          failed_run_count: number;
          missed_count: number;
        }>(
          sql.raw(
            monitoringQueryWithBucket(
              deliveryTestHealthMonitoringQuery,
              '2026-12-01T08:03:00.000Z',
              '2026-12-01T08:04:00.000Z',
            ),
          ),
        );
        expect([...afterPstBoundaryRows]).toEqual([
          { failed_run_count: 0, missed_count: 1 },
        ]);
        throw rollbackProbe;
      });
    } catch (error) {
      if (error !== rollbackProbe) throw error;
    }
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
      },
    });
    expect(northFacility?.neighborhoodMemberships).toHaveLength(1);
    expect(
      northFacility?.neighborhoodMemberships[0]?.neighborhoodVersion.name,
    ).toBe('Synthetic Twin Campuses');
  });
});
