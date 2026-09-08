import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../db/client';
import { seedDatabase } from '../db/seed';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
} from '../lib/testing/database';
import { insertChannelConfigurationsBeforeTruthRetirement } from '../lib/testing/held-back-channel-configurations';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(120_000);

const RETIRING_MIGRATION = '0049_gut_delivery_tests_and_truth_labels';

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

async function migrationTagsBefore(tag: string): Promise<readonly string[]> {
  const journal = (await Bun.file(
    new URL('./migrations/meta/_journal.json', import.meta.url),
  ).json()) as { entries?: Array<{ tag?: unknown }> };
  const tags = (journal.entries ?? []).map((entry) => {
    if (typeof entry.tag !== 'string') {
      throw new Error('The migration journal contains an invalid tag.');
    }
    return entry.tag;
  });
  const index = tags.indexOf(tag);
  if (index <= 0) throw new Error(`Migration ${tag} is not in the journal.`);
  return tags.slice(0, index);
}

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

type PostgresTransaction = Parameters<
  Parameters<PostgresDatabaseConnection['db']['transaction']>[0]
>[0];

/**
 * The dispatch graph exactly as the pre-0049 schema stored it: integration
 * statuses, delivery-test target sets, an intent whose channels carry
 * `integrationStatus`, and an outbox row whose `message` and `channels`
 * both carry that shape. Copied from the fixture the delivery-test proofs
 * used before 0049 retired them, so it satisfies every constraint that
 * schema enforced. `.invalid` addresses and unroutable tokens ensure it
 * cannot reach a recipient or provider.
 */
async function insertPre0049DispatchFixture(
  transaction: PostgresTransaction,
  dispatchCreatedAt: Date | string = '2026-08-10T16:06:30.000Z',
  endpointReferenceDigest: string = 'e'.repeat(64),
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
        captured_at, platform, provider, service_environment, token, email,
        phone_number
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
        'expo',
        'production',
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
        'expo',
        'production',
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
        ${endpointReferenceDigest},
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
        ${endpointReferenceDigest},
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
        ${endpointReferenceDigest},
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
              'label', channel.integration_label::text,
              'verifiedAt', '2026-08-10T16:02:00.000Z',
              'verifiedByUserId',
                '00000000-0000-4000-8000-000000026001',
              'authorizationReference', case channel.channel
                when 'push' then
                  'synthetic-product-owner-push-live-verification'
                when 'email' then
                  'synthetic-product-owner-email-live-verification'
              end,
              'reasonCode', null,
              'observedAt', '2026-08-10T16:02:00.000Z'
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
        ${dispatchCreatedAt}::timestamptz
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
        ${endpointReferenceDigest},
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

interface OutboxPlanRow extends Record<string, unknown> {
  readonly channels: unknown;
  readonly message: Record<string, unknown>;
}

describeWithDatabase('migration 0049 on retained dispatch rows', () => {
  test('rewrites every retained channel plan behind its guards and keeps outbox_message_truth', async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for migration tests.');
    }
    const owned = await createDisposableDatabase(
      'psd_eoc_migration_0049',
      testDatabaseUrl,
    );
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: owned.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('Migration tests require the direct PostgreSQL driver.');
    }
    try {
      for (const tag of await migrationTagsBefore(RETIRING_MIGRATION)) {
        await applySqlMigrationFile(opened.db, `${tag}.sql`);
      }
      await seedDatabase(opened.db, {
        insertChannelConfigurations:
          insertChannelConfigurationsBeforeTruthRetirement,
      });
      await opened.db.transaction(async (transaction) => {
        await insertPre0049DispatchFixture(transaction);
        // Retained previews carried the same plan shape. Both tables are
        // append-only behind their immutable guards, so the fixture writes
        // them the way a pre-0049 database holds them: bypassing the guard
        // for this transaction only.
        await transaction.execute(
          sql`set local session_replication_role = replica`,
        );
        await transaction.execute(sql`
          update activation_previews
          set channels = (
            select message -> 'channels' from outbox
            where id = '00000000-0000-4000-8000-000000030033'::uuid
          )
          where id = '00000000-0000-4000-8000-000000030020'::uuid
        `);
        await transaction.execute(sql`
          insert into lifecycle_consequence_previews (
            id, event_id, purpose, kind, template_mode, event_type_version_id,
            roster_snapshot_id, roster_population, recipient_count, channels,
            send_readiness, blocking_reason_codes, consequence_digest,
            created_at, expires_at
          )
          select
            '00000000-0000-4000-8000-000000030021'::uuid,
            '00000000-0000-4000-8000-000000030030'::uuid,
            'all-clear'::notification_purpose,
            'drill'::event_kind,
            'drill'::template_mode,
            '00000000-0000-4000-8000-000000000201'::uuid,
            '00000000-0000-4000-8000-000000030003'::uuid,
            'staff'::roster_population,
            2,
            message -> 'channels',
            'ready',
            '[]'::jsonb,
            repeat('d', 64),
            '2026-08-10T16:07:00.000Z'::timestamptz,
            '2026-08-10T16:12:00.000Z'::timestamptz
          from outbox
          where id = '00000000-0000-4000-8000-000000030033'::uuid
        `);
      });

      const [before] = await opened.db.execute<OutboxPlanRow>(sql`
        select channels, message from outbox
        where id = '00000000-0000-4000-8000-000000030033'::uuid
      `);
      expect(before).toBeDefined();
      expect(before?.message).toHaveProperty('deliveryTest');
      expect(
        JSON.stringify((before?.message as { channels: unknown }).channels),
      ).toContain('integrationStatus');
      expect(JSON.stringify(before?.channels)).toContain('integrationStatus');
      expect(before?.channels).toEqual(
        (before?.message as { channels: unknown }).channels,
      );

      await applySqlMigrationFile(opened.db, `${RETIRING_MIGRATION}.sql`);

      const [after] = await opened.db.execute<OutboxPlanRow>(sql`
        select channels, message from outbox
        where id = '00000000-0000-4000-8000-000000030033'::uuid
      `);
      expect(after).toBeDefined();
      const message = after?.message as {
        channels: ReadonlyArray<Record<string, unknown>>;
      };
      expect(after?.message).not.toHaveProperty('deliveryTest');
      expect(message.channels).toHaveLength(2);
      expect(message.channels.map((plan) => plan.integrationId)).toEqual([
        'expo-push',
        'ses-email',
      ]);
      expect(JSON.stringify(message.channels)).not.toContain(
        'integrationStatus',
      );
      // `outbox_message_truth` requires the column to equal the message copy.
      expect(after?.channels).toEqual(message.channels);
      // The rewrite touched nothing else on the row.
      const withoutPlan = (row: OutboxPlanRow | undefined) =>
        Object.fromEntries(
          Object.entries(row ?? {}).filter(
            ([key]) => key !== 'channels' && key !== 'message',
          ),
        );
      expect(withoutPlan(after)).toEqual(withoutPlan(before));

      const previews = await opened.db.execute<{
        source: string;
        plan: unknown;
      }>(sql`
        select 'activation' as source, channels as plan from activation_previews
        where id = '00000000-0000-4000-8000-000000030020'::uuid
        union all
        select 'lifecycle', channels from lifecycle_consequence_previews
        where id = '00000000-0000-4000-8000-000000030021'::uuid
        order by 1
      `);
      expect(previews.map((row) => row.source)).toEqual([
        'activation',
        'lifecycle',
      ]);
      for (const row of previews) {
        expect(row.plan).toEqual(message.channels);
      }
      const guards = await opened.db.execute<{
        trigger_name: string;
        enabled: string;
      }>(sql`
        select tgname as trigger_name, tgenabled as enabled
        from pg_catalog.pg_trigger
        where tgname in (
          'activation_previews_immutable_guard',
          'lifecycle_consequence_previews_immutable_guard',
          'outbox_payload_guard'
        )
        order by tgname
      `);
      expect([...guards]).toEqual([
        { trigger_name: 'activation_previews_immutable_guard', enabled: 'O' },
        {
          trigger_name: 'lifecycle_consequence_previews_immutable_guard',
          enabled: 'O',
        },
        { trigger_name: 'outbox_payload_guard', enabled: 'O' },
      ]);

      const constraints = await opened.db.execute<{
        constraint_name: string;
        validated: boolean;
      }>(sql`
        select conname as constraint_name, convalidated as validated
        from pg_catalog.pg_constraint
        where conrelid = 'public.outbox'::regclass
          and conname in ('outbox_message_truth', 'outbox_channel_plan_shape')
        order by conname
      `);
      expect([...constraints]).toEqual([
        { constraint_name: 'outbox_channel_plan_shape', validated: true },
        { constraint_name: 'outbox_message_truth', validated: true },
      ]);
      const [retired] = await opened.db.execute<{ count: number }>(sql`
        select count(*)::integer as count
        from information_schema.tables
        where table_schema = 'public'
          and (table_name like 'delivery_test_%'
            or table_name in ('integration_statuses', 'integration_channel_change_authorizations'))
      `);
      expect(retired?.count).toBe(0);
    } finally {
      await closeAndDropDisposableDatabase(() => opened.close(), owned);
    }
  });
});
