import { sql } from 'drizzle-orm';

import type { Database } from '../../db/client';

type SeedTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The integration-status rows the seed wrote before
 * `0049_gut_delivery_tests_and_truth_labels` retired the table, keyed by
 * integration. Historical fixtures that insert channel plans against a schema
 * held before that migration still need these ids for its NOT NULL columns.
 */
export const HELD_BACK_INTEGRATION_STATUS_IDS = Object.freeze({
  'google-groups': '00000000-0000-4000-8000-000000000300',
  'expo-push': '00000000-0000-4000-8000-000000000301',
  'ses-email': '00000000-0000-4000-8000-000000000302',
  'aws-eum-sms': '00000000-0000-4000-8000-000000000303',
  's3-media': '00000000-0000-4000-8000-000000000304',
  'mobile-push': '00000000-0000-4000-8000-000000000305',
});

/**
 * Writes the integration statuses and channel configurations exactly as the
 * seed did before `0049_gut_delivery_tests_and_truth_labels`. That migration
 * dropped `integration_statuses` and the `status_id`/`status_label` columns,
 * and the seed no longer writes them, so a fixture held at an earlier
 * migration supplies these rows itself with the columns its schema has.
 */
export async function insertChannelConfigurationsBeforeTruthRetirement(
  transaction: SeedTransaction,
): Promise<void> {
  await transaction.execute(sql`
    insert into integration_statuses (
      id, integration_id, label, verified_at, verified_by_user_id,
      authorization_reference, reason_code, observed_at
    ) values
      (
        ${HELD_BACK_INTEGRATION_STATUS_IDS['google-groups']}::uuid,
        'google-groups', 'mocked', null, null, null, null,
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        ${HELD_BACK_INTEGRATION_STATUS_IDS['expo-push']}::uuid,
        'expo-push', 'mocked', null, null, null, null,
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        ${HELD_BACK_INTEGRATION_STATUS_IDS['mobile-push']}::uuid,
        'mobile-push', 'mocked', null, null, null, null,
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        ${HELD_BACK_INTEGRATION_STATUS_IDS['ses-email']}::uuid,
        'ses-email', 'mocked', null, null, null, null,
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        ${HELD_BACK_INTEGRATION_STATUS_IDS['aws-eum-sms']}::uuid,
        'aws-eum-sms', 'blocked', null, null, null,
        'CARRIER_REGISTRATION_PENDING',
        '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        ${HELD_BACK_INTEGRATION_STATUS_IDS['s3-media']}::uuid,
        's3-media', 'mocked', null, null, null, null,
        '2026-08-06T12:00:00.000Z'::timestamptz
      )
    on conflict do nothing
  `);
  await transaction.execute(sql`
    insert into channel_configurations (
      integration_id, enabled, status_id, status_label, changed_at
    ) values
      (
        'mobile-push', false,
        ${HELD_BACK_INTEGRATION_STATUS_IDS['mobile-push']}::uuid,
        'mocked', '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        'ses-email', false,
        ${HELD_BACK_INTEGRATION_STATUS_IDS['ses-email']}::uuid,
        'mocked', '2026-08-06T12:00:00.000Z'::timestamptz
      ),
      (
        'aws-eum-sms', false,
        ${HELD_BACK_INTEGRATION_STATUS_IDS['aws-eum-sms']}::uuid,
        'blocked', '2026-08-06T12:00:00.000Z'::timestamptz
      )
    on conflict do nothing
  `);
}
