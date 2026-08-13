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
import { fanoutControlRecords } from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  appendFanoutControlRecord,
  assertCurrentNotificationFanoutEnabled,
  readFanoutControlEffectiveState,
} from './fanout-control';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

let connection: PostgresDatabaseConnection | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The fan-out control test database is not open.');
  }
  return connection;
}

const USER_ID = '00000000-0000-4000-8000-000000003480';
const DEVICE_ID = '00000000-0000-4000-8000-000000003481';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000003482';
const SESSION_ID = '00000000-0000-4000-8000-000000003483';

async function insertSyntheticHumanPrerequisites(
  database: PostgresDatabaseConnection['db'],
): Promise<void> {
  await database.execute(sql`
    insert into users (
      id, google_subject, email, display_name, facility_scope_kind, created_at
    ) values (
      ${USER_ID}::uuid,
      'synthetic-fanout-control-admin',
      'synthetic-fanout-control-admin@psd401.net',
      'Synthetic Fanout Control Admin',
      'district'::facility_scope_kind,
      '2026-08-12T18:00:00.000Z'::timestamptz
    ) on conflict (id) do nothing
  `);
  await database.execute(sql`
    insert into device_enrollments (
      id, user_id, platform, unlock_method, installation_id, enrolled_at,
      last_seen_at
    ) values (
      ${DEVICE_ID}::uuid,
      ${USER_ID}::uuid,
      'web'::device_platform,
      'secure-session-cookie'::device_unlock_method,
      'synthetic-fanout-control-installation',
      '2026-08-12T18:00:00.000Z'::timestamptz,
      '2026-08-12T18:00:00.000Z'::timestamptz
    ) on conflict (id) do nothing
  `);
  await database.execute(sql`
    insert into access_membership_snapshots (
      id, version, complete, sync_started_at, captured_at
    ) values (
      ${SNAPSHOT_ID}::uuid,
      340034,
      true,
      '2026-08-12T17:59:00.000Z'::timestamptz,
      '2026-08-12T18:00:00.000Z'::timestamptz
    ) on conflict (id) do nothing
  `);
  await database.execute(sql`
    insert into access_membership_members (
      snapshot_id, user_id, google_subject, facility_scope_kind
    ) values (
      ${SNAPSHOT_ID}::uuid,
      ${USER_ID}::uuid,
      'synthetic-fanout-control-admin',
      'district'::facility_scope_kind
    ) on conflict (snapshot_id, user_id) do nothing
  `);
  await database.execute(sql`
    insert into sessions (
      id, user_id, device_enrollment_id, membership_snapshot_id,
      membership_valid_until, membership_grace_until, created_at, expires_at
    ) values (
      ${SESSION_ID}::uuid,
      ${USER_ID}::uuid,
      ${DEVICE_ID}::uuid,
      ${SNAPSHOT_ID}::uuid,
      '2026-08-13T18:00:00.000Z'::timestamptz,
      '2026-08-14T18:00:00.000Z'::timestamptz,
      '2026-08-12T18:00:00.000Z'::timestamptz,
      '2026-09-12T18:00:00.000Z'::timestamptz
    ) on conflict (id) do nothing
  `);
}

describeWithDatabase('fan-out control database invariants', () => {
  beforeAll(async () => {
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl ?? '',
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('Fan-out control database tests require PostgreSQL.');
    }
    connection = opened;
    await migrateDatabase(opened);
    await insertSyntheticHumanPrerequisites(opened.db);
    await opened.db.execute(sql`delete from fanout_intent_authorizations`);
    await opened.db.execute(sql`delete from fanout_control_records`);
  });

  afterAll(async () => {
    await connection?.close();
    connection = undefined;
  });

  test('starts fail-closed and appends disable/enable with fresh epochs', async () => {
    const database = databaseConnection().db;
    expect(await readFanoutControlEffectiveState(database)).toMatchObject({
      kind: 'missing',
      effectiveMode: 'emergency-disabled',
    });

    const disabled = await database.transaction((transaction) =>
      appendFanoutControlRecord({
        database: transaction,
        actor: { userId: USER_ID, sessionId: SESSION_ID },
        requestId: randomUUID(),
        expectedCurrentRecordId: null,
        desiredMode: 'emergency-disabled',
        reason: 'Synthetic initial fail-closed state.',
        productOwnerApprovalReference: null,
        changedAt: new Date('2026-08-12T18:01:00.000Z'),
      }),
    );
    await expect(
      database.transaction((transaction) =>
        assertCurrentNotificationFanoutEnabled(transaction),
      ),
    ).rejects.toMatchObject({ reasonCode: 'EMERGENCY_DISABLED' });

    const firstEnabled = await database.transaction((transaction) =>
      appendFanoutControlRecord({
        database: transaction,
        actor: { userId: USER_ID, sessionId: SESSION_ID },
        requestId: randomUUID(),
        expectedCurrentRecordId: disabled.id,
        desiredMode: 'enabled',
        reason: 'Synthetic recovery checks completed.',
        productOwnerApprovalReference: 'synthetic-po-approval-one',
        changedAt: new Date('2026-08-12T18:02:00.000Z'),
      }),
    );
    expect(firstEnabled.enableEpochId).not.toBeNull();

    const secondDisabled = await database.transaction((transaction) =>
      appendFanoutControlRecord({
        database: transaction,
        actor: { userId: USER_ID, sessionId: SESSION_ID },
        requestId: randomUUID(),
        expectedCurrentRecordId: firstEnabled.id,
        desiredMode: 'emergency-disabled',
        reason: 'Synthetic second disable.',
        productOwnerApprovalReference: null,
        changedAt: new Date('2026-08-12T18:03:00.000Z'),
      }),
    );
    const secondEnabled = await database.transaction((transaction) =>
      appendFanoutControlRecord({
        database: transaction,
        actor: { userId: USER_ID, sessionId: SESSION_ID },
        requestId: randomUUID(),
        expectedCurrentRecordId: secondDisabled.id,
        desiredMode: 'enabled',
        reason: 'Synthetic second recovery.',
        productOwnerApprovalReference: 'synthetic-po-approval-two',
        changedAt: new Date('2026-08-12T18:04:00.000Z'),
      }),
    );
    expect(secondEnabled.enableEpochId).not.toBe(firstEnabled.enableEpochId);
  });

  test('database trigger rejects history rewrite, deletion, and fork inserts', async () => {
    const database = databaseConnection().db;
    const [current] = await database
      .select()
      .from(fanoutControlRecords)
      .orderBy(sql`${fanoutControlRecords.revision} desc`)
      .limit(1);
    expect(current).toBeDefined();
    await expect(
      database.execute(
        sql`update fanout_control_records set reason = 'rewrite'`,
      ),
    ).rejects.toThrow(/immutable truth/u);
    await expect(
      database.execute(sql`delete from fanout_control_records`),
    ).rejects.toThrow(/immutable truth/u);
    await expect(
      database.execute(sql`
        insert into fanout_control_records (
          revision, previous_record_id, mode, enable_epoch_id, reason,
          product_owner_approval_reference, changed_by_user_id,
          changed_with_session_id, request_id, changed_at
        ) values (
          999,
          ${current?.id ?? null}::uuid,
          'emergency-disabled'::fanout_control_mode,
          null,
          'Synthetic invalid fork.',
          null,
          ${USER_ID}::uuid,
          ${SESSION_ID}::uuid,
          ${randomUUID()}::uuid,
          '2026-08-12T18:05:00.000Z'::timestamptz
        )
      `),
    ).rejects.toThrow(/append to the current revision/u);
  });
});
