import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import type { NotificationIntent } from '@psd-eoc/contracts';
import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  fanoutControlRecords,
  fanoutIntentAuthorizations,
} from '../../db/schema';
import { seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../app/(admin)/event-types/test-database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../app/(admin)/facilities/owned-database-lifecycle';
import {
  appendFanoutControlRecord,
  assertCurrentNotificationFanoutEnabled,
  insertAuthorizedNotificationIntentForFanout,
  readFanoutControlEffectiveState,
} from './fanout-control';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface DisposableDatabaseContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

interface TriggerSecurityRow extends Record<string, unknown> {
  readonly appExecute: boolean;
  readonly enabled: string;
  readonly publicExecute: boolean;
  readonly relationName: string;
  readonly securityDefiner: boolean;
  readonly settings: readonly string[] | null;
  readonly triggerDefinition: string;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_i34_fanout_[a-f0-9]{32}_test$/u;

let connection: PostgresDatabaseConnection | undefined;
let disposableContext: DisposableDatabaseContext | undefined;
let databaseCreated = false;

function buildDisposableContext(
  baseDatabaseUrl: string,
): DisposableDatabaseContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_i34_fanout_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable fan-out control database name is invalid.');
  }
  const databaseUrl = new URL(baseDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:issue-34:fanout-control-test:${runId}`,
  });
}

function openPostgresConnection(
  url: string,
  maxConnections: number,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Fan-out control database tests require PostgreSQL.');
  }
  return opened;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
    if (typeof constraintName === 'string') return constraintName;
    current = Reflect.get(current, 'cause');
  }

  return undefined;
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

async function readDatabaseMarker(
  admin: PostgresDatabaseConnection,
  databaseName: string,
): Promise<string | null | undefined> {
  const rows = databaseExecuteRows<MarkerRow>(
    await admin.db.execute<MarkerRow>(sql`
      select shobj_description(oid, 'pg_database') as marker
      from pg_database
      where datname = ${databaseName}
    `),
  );
  if (rows.length > 1) {
    throw new Error(
      'The disposable fan-out control database identity is ambiguous.',
    );
  }
  return rows[0]?.marker;
}

async function dropOwnedDatabase(
  context: DisposableDatabaseContext,
): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readDatabaseMarker(admin, context.databaseName);
      if (marker === undefined) return;
      if (marker !== context.marker) {
        throw new Error(
          'Refusing to drop a database without the exact issue #34 fan-out control ownership marker.',
        );
      }
      await admin.db.execute(
        sql.raw(`drop database "${context.databaseName}" with (force)`),
      );
      if (
        (await readDatabaseMarker(admin, context.databaseName)) !== undefined
      ) {
        throw new Error(
          'The owned fan-out control database remained after cleanup.',
        );
      }
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Disposable fan-out control database cleanup and connection close both failed.',
  });
}

async function createOwnedDatabase(
  context: DisposableDatabaseContext,
): Promise<void> {
  const admin = openPostgresConnection(context.baseDatabaseUrl, 1);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${context.databaseName}"`),
      );
      recordCreated();
      await admin.db.execute(
        sql.raw(
          `comment on database "${context.databaseName}" is ${quotedLiteral(context.marker)}`,
        ),
      );
      if (
        (await readDatabaseMarker(admin, context.databaseName)) !==
        context.marker
      ) {
        throw new Error(
          'The disposable fan-out control database ownership marker was not persisted.',
        );
      }
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(context),
    failureMessage:
      'Disposable fan-out control database creation, creator close, or marker-owned rollback failed.',
  });
}

async function cleanupResources(): Promise<void> {
  const errors: unknown[] = [];
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      errors.push(error);
    } finally {
      connection = undefined;
    }
  }
  if (databaseCreated && disposableContext !== undefined) {
    try {
      await dropOwnedDatabase(disposableContext);
      databaseCreated = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #34 fan-out control database test cleanup failed.',
    );
  }
}

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
const TOP_LEVEL_EVENT_ID = '00000000-0000-4000-8000-000000003484';
const TOP_LEVEL_INTENT_ID = '00000000-0000-4000-8000-000000003485';
const TOP_LEVEL_REQUEST_ID = '00000000-0000-4000-8000-000000003486';
const TOP_LEVEL_PREVIEW_ID = '00000000-0000-4000-8000-000000003487';
const TOP_LEVEL_TRANSITION_ID = '00000000-0000-4000-8000-000000003488';
const SAVEPOINT_EVENT_ID = '00000000-0000-4000-8000-000000003491';
const SAVEPOINT_INTENT_ID = '00000000-0000-4000-8000-000000003492';
const SAVEPOINT_REQUEST_ID = '00000000-0000-4000-8000-000000003493';
const SAVEPOINT_PREVIEW_ID = '00000000-0000-4000-8000-000000003494';
const SAVEPOINT_TRANSITION_ID = '00000000-0000-4000-8000-000000003495';
const BLOCKED_EVENT_ID = '00000000-0000-4000-8000-000000003501';
const BLOCKED_INTENT_ID = '00000000-0000-4000-8000-000000003502';
const BLOCKED_REQUEST_ID = '00000000-0000-4000-8000-000000003503';
const BLOCKED_PREVIEW_ID = '00000000-0000-4000-8000-000000003504';
const BLOCKED_TRANSITION_ID = '00000000-0000-4000-8000-000000003505';
const CONSEQUENCE_DIGEST = 'd'.repeat(64);
const CONTROL_BASE_AT = new Date(Date.now() - 5 * 60_000);
const PREVIEW_CREATED_AT = new Date(CONTROL_BASE_AT.getTime() + 4 * 60_000);
const INTENT_CREATED_AT = new Date(CONTROL_BASE_AT.getTime() + 4.5 * 60_000);

interface SyntheticIntentReferences extends Record<string, unknown> {
  readonly audienceConfigId: string;
  readonly audienceConfigVersion: number;
  readonly eventTypeVersionId: string;
  readonly rosterSnapshotId: string;
}

function syntheticActivationPreviewInsert(
  previewId: string,
  sendReadiness: 'ready' | 'blocked' = 'ready',
) {
  const blockingReasonCodes =
    sendReadiness === 'ready' ? [] : ['SYNTHETIC_PROVIDER_BLOCKED'];
  return sql`
    insert into activation_previews (
      id, facility_id, kind, template_mode, event_type_version_id,
      roster_snapshot_id, roster_population, audience_config_id,
      audience_config_version, recipient_count, channels, send_readiness,
      blocking_reason_codes, active_event_ids, consequence_digest, created_at,
      expires_at
    )
    select
      ${previewId}::uuid,
      facility.id,
      'test'::event_kind,
      'drill'::template_mode,
      version.id,
      snapshot.id,
      'synthetic'::roster_population,
      audience.id,
      audience.version,
      0,
      '[]'::jsonb,
      ${sendReadiness},
      ${JSON.stringify(blockingReasonCodes)}::jsonb,
      '[]'::jsonb,
      ${CONSEQUENCE_DIGEST},
      ${PREVIEW_CREATED_AT.toISOString()}::timestamptz,
      ${new Date(PREVIEW_CREATED_AT.getTime() + 15 * 60_000).toISOString()}::timestamptz
    from facilities as facility
    join audience_configurations as audience
      on audience.facility_id = facility.id
    cross join roster_snapshots as snapshot
    cross join event_type_versions as version
    join event_types as event_type on event_type.id = version.event_type_id
    where facility.code = 'SYN-NORTH'
      and snapshot.population = 'synthetic'
      and event_type.key = 'lockdown-drill'
    order by audience.version
    limit 1
  `;
}

function syntheticTestEventInsert(
  eventId: string,
  requestId: string,
  previewId: string,
  transitionId: string,
) {
  return sql`
    with fixture as (
      select
        facility.id as facility_id,
        version.id as event_type_version_id,
        snapshot.id as roster_snapshot_id,
        jsonb_build_object(
          'kind', 'synthetic-training',
          'activationPreviewId', ${previewId}::text,
          'consequenceDigest', ${CONSEQUENCE_DIGEST}::text,
          'requestId', ${requestId}::text
        ) as authorization
      from facilities as facility
      cross join roster_snapshots as snapshot
      cross join event_type_versions as version
      join event_types as event_type on event_type.id = version.event_type_id
      where facility.code = 'SYN-NORTH'
        and snapshot.population = 'synthetic'
        and event_type.key = 'lockdown-drill'
      limit 1
    ), inserted_event as (
      insert into events (
        id, facility_id, kind, template_mode, event_type_version_id, status,
        roster_snapshot_id, roster_population, created_by, created_at,
        activated_at, activation_authorization
      )
      select
        ${eventId}::uuid,
        fixture.facility_id,
        'test'::event_kind,
        'drill'::template_mode,
        fixture.event_type_version_id,
        'active'::event_status,
        fixture.roster_snapshot_id,
        'synthetic'::roster_population,
        '{"kind":"system","serviceId":"fanout-control-database-test"}'::jsonb,
        ${INTENT_CREATED_AT.toISOString()}::timestamptz,
        ${INTENT_CREATED_AT.toISOString()}::timestamptz,
        fixture.authorization
      from fixture
      returning id
    )
    insert into event_transitions (
      id, sequence, transition, event_id, journal_event_id, from_status,
      to_status, kind, template_mode, roster_population, actor, source,
      occurred_at, request_id, idempotency_key, activation_authorization
    )
    select
      ${transitionId}::uuid,
      1,
      'activate'::event_transition_kind,
      inserted_event.id,
      inserted_event.id,
      'draft'::event_status,
      'active'::event_status,
      'test'::event_kind,
      'drill'::template_mode,
      'synthetic'::roster_population,
      '{"kind":"system","serviceId":"fanout-control-database-test"}'::jsonb,
      'worker'::invocation_source,
      ${INTENT_CREATED_AT.toISOString()}::timestamptz,
      ${requestId}::uuid,
      ${`synthetic-fanout-control:${transitionId}`},
      jsonb_build_object(
        'kind', 'synthetic-training',
        'activationPreviewId', ${previewId}::text,
        'consequenceDigest', ${CONSEQUENCE_DIGEST}::text,
        'requestId', ${requestId}::text
      )
    from inserted_event
  `;
}

async function syntheticNotificationIntent(input: {
  readonly database: PostgresDatabaseConnection['db'];
  readonly eventId: string;
  readonly intentId: string;
  readonly previewId: string;
  readonly requestId: string;
}): Promise<NotificationIntent> {
  const [references] = databaseExecuteRows<SyntheticIntentReferences>(
    await input.database.execute<SyntheticIntentReferences>(sql`
      select
        event.event_type_version_id as "eventTypeVersionId",
        event.roster_snapshot_id as "rosterSnapshotId",
        audience.id as "audienceConfigId",
        audience.version as "audienceConfigVersion"
      from events as event
      join audience_configurations as audience
        on audience.facility_id = event.facility_id
      where event.id = ${input.eventId}::uuid
      order by audience.version
      limit 1
    `),
  );
  if (references === undefined) {
    throw new Error('The synthetic intent references are unavailable.');
  }
  return Object.freeze({
    id: input.intentId,
    eventId: input.eventId,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: references.eventTypeVersionId,
      templateMode: 'drill' as const,
    },
    rosterSnapshotId: references.rosterSnapshotId,
    rosterPopulation: 'synthetic',
    audienceConfig: {
      id: references.audienceConfigId,
      version: references.audienceConfigVersion,
    },
    createdBy: {
      kind: 'system' as const,
      serviceId: 'fanout-control-database-test',
    },
    source: 'worker',
    requestId: input.requestId,
    authorization: {
      kind: 'synthetic-training' as const,
      activationPreviewId: input.previewId,
      consequenceDigest: CONSEQUENCE_DIGEST,
      requestId: input.requestId,
    },
    channels: [],
    createdAt: INTENT_CREATED_AT.toISOString(),
  });
}

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
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      insert into access_membership_snapshots (
        id, version, complete, sync_started_at, captured_at
      ) values (
        ${SNAPSHOT_ID}::uuid,
        340034,
        true,
        '2026-08-12T17:59:00.000Z'::timestamptz,
        '2026-08-12T18:00:00.000Z'::timestamptz
      )
    `);
    await transaction.execute(sql`
      insert into access_membership_members (
        snapshot_id, user_id, google_subject, facility_scope_kind
      ) values (
        ${SNAPSHOT_ID}::uuid,
        ${USER_ID}::uuid,
        'synthetic-fanout-control-admin',
        'district'::facility_scope_kind
      )
    `);
  });
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
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    disposableContext = buildDisposableContext(baseTestDatabaseUrl);
    try {
      databaseCreated = true;
      await createOwnedDatabase(disposableContext);
      connection = openPostgresConnection(disposableContext.databaseUrl, 2);
      await migrateDatabase(connection);
      await seedDatabase(connection.db);
      await insertSyntheticHumanPrerequisites(connection.db);
    } catch (error) {
      try {
        await cleanupResources();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Fan-out control database setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterAll(async () => {
    await cleanupResources();
  });

  test('starts fail-closed and requires a fresh approval reference for each enable epoch', async () => {
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
        changedAt: new Date(CONTROL_BASE_AT.getTime() + 60_000),
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
        changedAt: new Date(CONTROL_BASE_AT.getTime() + 2 * 60_000),
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
        changedAt: new Date(CONTROL_BASE_AT.getTime() + 3 * 60_000),
      }),
    );

    const stateBeforeReusedApproval =
      await readFanoutControlEffectiveState(database);
    expect(stateBeforeReusedApproval).toMatchObject({
      kind: 'current',
      effectiveMode: 'emergency-disabled',
      currentRecord: {
        id: secondDisabled.id,
        revision: secondDisabled.revision,
      },
    });
    await expect(
      database.transaction((transaction) =>
        appendFanoutControlRecord({
          database: transaction,
          actor: { userId: USER_ID, sessionId: SESSION_ID },
          requestId: randomUUID(),
          expectedCurrentRecordId: secondDisabled.id,
          desiredMode: 'enabled',
          reason: 'Synthetic invalid reused approval.',
          productOwnerApprovalReference: 'SYNTHETIC-PO-APPROVAL-ONE',
          changedAt: new Date(CONTROL_BASE_AT.getTime() + 3.25 * 60_000),
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'APPROVAL_REFERENCE_REUSED' });
    expect(await readFanoutControlEffectiveState(database)).toEqual(
      stateBeforeReusedApproval,
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
        changedAt: new Date(CONTROL_BASE_AT.getTime() + 3.5 * 60_000),
      }),
    );
    expect(secondEnabled.enableEpochId).not.toBe(firstEnabled.enableEpochId);
  });

  test('database uniqueness rejects case-insensitive approval reuse through direct SQL', async () => {
    const database = databaseConnection().db;
    const stateBeforeDirectReuse =
      await readFanoutControlEffectiveState(database);
    if (stateBeforeDirectReuse.kind !== 'current') {
      throw new Error(
        'The direct uniqueness test requires a current enabled control record.',
      );
    }
    const current = stateBeforeDirectReuse.currentRecord;
    const approvalReference = current.productOwnerApprovalReference;
    if (approvalReference === null) {
      throw new Error(
        'The direct uniqueness test requires a current enabled control record.',
      );
    }

    await expectConstraintViolation(
      () =>
        Promise.resolve(
          database.execute(sql`
            insert into fanout_control_records (
              revision, previous_record_id, mode, enable_epoch_id, reason,
              product_owner_approval_reference, changed_by_user_id,
              changed_with_session_id, request_id, changed_at
            ) values (
              ${current.revision + 1},
              ${current.id}::uuid,
              'enabled'::fanout_control_mode,
              ${randomUUID()}::uuid,
              'Synthetic direct approval-reuse attempt.',
              ${approvalReference.toUpperCase()},
              ${USER_ID}::uuid,
              ${SESSION_ID}::uuid,
              ${randomUUID()}::uuid,
              '2026-08-12T18:06:00.000Z'::timestamptz
            )
          `),
        ),
      'fanout_control_records_approval_reference_uq',
    );
    expect(await readFanoutControlEffectiveState(database)).toEqual(
      stateBeforeDirectReuse,
    );
  });

  test('fan-out insert trigger is locked to pg_catalog and unavailable as an app side door', async () => {
    const database = databaseConnection().db;
    const rows = databaseExecuteRows<TriggerSecurityRow>(
      await database.execute(sql`
        select
          routine.prosecdef as "securityDefiner",
          routine.proconfig as settings,
          has_function_privilege(
            'psd_eoc_app',
            routine.oid,
            'EXECUTE'
          ) as "appExecute",
          exists (
            select 1
            from aclexplode(
              coalesce(
                routine.proacl,
                acldefault('f', routine.proowner)
              )
            ) as privilege
            where privilege.grantee = 0
              and privilege.privilege_type = 'EXECUTE'
          ) as "publicExecute",
          trigger.tgenabled as enabled,
          relation.relname as "relationName",
          pg_get_triggerdef(trigger.oid) as "triggerDefinition"
        from pg_proc as routine
        join pg_namespace as namespace
          on namespace.oid = routine.pronamespace
        join pg_trigger as trigger
          on trigger.tgfoid = routine.oid
          and not trigger.tgisinternal
        join pg_class as relation
          on relation.oid = trigger.tgrelid
        where namespace.nspname = 'public'
          and routine.proname = 'psd_eoc_guard_fanout_control_insert'
      `),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      securityDefiner: false,
      settings: ['search_path=pg_catalog'],
      appExecute: false,
      publicExecute: false,
      enabled: 'O',
      relationName: 'fanout_control_records',
    });
    expect(rows[0]?.triggerDefinition).toMatch(
      /BEFORE INSERT ON public\.fanout_control_records FOR EACH ROW EXECUTE FUNCTION psd_eoc_guard_fanout_control_insert\(\)/u,
    );
  });

  test('atomically inserts one top-level intent and authorization through the app-role function', async () => {
    const database = databaseConnection().db;
    await database.transaction(async (transaction) => {
      await transaction.execute(
        syntheticActivationPreviewInsert(TOP_LEVEL_PREVIEW_ID),
      );
      await transaction.execute(
        syntheticTestEventInsert(
          TOP_LEVEL_EVENT_ID,
          TOP_LEVEL_REQUEST_ID,
          TOP_LEVEL_PREVIEW_ID,
          TOP_LEVEL_TRANSITION_ID,
        ),
      );
    });
    const intent = await syntheticNotificationIntent({
      database,
      eventId: TOP_LEVEL_EVENT_ID,
      intentId: TOP_LEVEL_INTENT_ID,
      previewId: TOP_LEVEL_PREVIEW_ID,
      requestId: TOP_LEVEL_REQUEST_ID,
    });
    let authorization:
      | Readonly<{ controlRecordId: string; enableEpochId: string }>
      | undefined;
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role psd_eoc_app`);
      authorization = await insertAuthorizedNotificationIntentForFanout({
        database: transaction,
        intent,
        previewCreatedAt: PREVIEW_CREATED_AT,
      });
    });
    expect(authorization?.enableEpochId).toBeDefined();
    expect(
      await database
        .select({ intentId: fanoutIntentAuthorizations.intentId })
        .from(fanoutIntentAuthorizations)
        .where(
          sql`${fanoutIntentAuthorizations.intentId} = ${TOP_LEVEL_INTENT_ID}::uuid`,
        ),
    ).toEqual([{ intentId: TOP_LEVEL_INTENT_ID }]);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`set local role psd_eoc_app`);
        return insertAuthorizedNotificationIntentForFanout({
          database: transaction,
          intent,
          previewCreatedAt: PREVIEW_CREATED_AT,
        });
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/duplicate key/u) },
    });
    expect(
      await database
        .select({ intentId: fanoutIntentAuthorizations.intentId })
        .from(fanoutIntentAuthorizations)
        .where(
          sql`${fanoutIntentAuthorizations.intentId} = ${TOP_LEVEL_INTENT_ID}::uuid`,
        ),
    ).toHaveLength(1);
  });

  test('atomically inserts intent and authorization from a savepoint without xmin inference', async () => {
    const database = databaseConnection().db;
    await database.transaction(async (transaction) => {
      await transaction.execute(
        syntheticActivationPreviewInsert(SAVEPOINT_PREVIEW_ID),
      );
      await transaction.execute(
        syntheticTestEventInsert(
          SAVEPOINT_EVENT_ID,
          SAVEPOINT_REQUEST_ID,
          SAVEPOINT_PREVIEW_ID,
          SAVEPOINT_TRANSITION_ID,
        ),
      );
    });
    const intent = await syntheticNotificationIntent({
      database,
      eventId: SAVEPOINT_EVENT_ID,
      intentId: SAVEPOINT_INTENT_ID,
      previewId: SAVEPOINT_PREVIEW_ID,
      requestId: SAVEPOINT_REQUEST_ID,
    });
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role psd_eoc_app`);
      await transaction.transaction(async (savepoint) => {
        const authorization = await insertAuthorizedNotificationIntentForFanout(
          {
            database: savepoint,
            intent,
            previewCreatedAt: PREVIEW_CREATED_AT,
          },
        );
        expect(authorization.enableEpochId).toBeDefined();
      });
    });
    expect(
      await database
        .select({ intentId: fanoutIntentAuthorizations.intentId })
        .from(fanoutIntentAuthorizations)
        .where(
          sql`${fanoutIntentAuthorizations.intentId} = ${SAVEPOINT_INTENT_ID}::uuid`,
        ),
    ).toEqual([{ intentId: SAVEPOINT_INTENT_ID }]);
  });

  test('fails closed inside the definer function for a blocked canonical preview', async () => {
    const database = databaseConnection().db;
    await database.transaction(async (transaction) => {
      await transaction.execute(
        syntheticActivationPreviewInsert(BLOCKED_PREVIEW_ID, 'blocked'),
      );
      await transaction.execute(
        syntheticTestEventInsert(
          BLOCKED_EVENT_ID,
          BLOCKED_REQUEST_ID,
          BLOCKED_PREVIEW_ID,
          BLOCKED_TRANSITION_ID,
        ),
      );
    });
    const intent = await syntheticNotificationIntent({
      database,
      eventId: BLOCKED_EVENT_ID,
      intentId: BLOCKED_INTENT_ID,
      previewId: BLOCKED_PREVIEW_ID,
      requestId: BLOCKED_REQUEST_ID,
    });

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`set local role psd_eoc_app`);
        await transaction.execute(sql`
          select *
          from public."psd_eoc_insert_authorized_notification_intent"(
            ${intent.id}::uuid,
            ${intent.eventId}::uuid,
            ${intent.eventKind}::event_kind,
            ${intent.templateMode}::template_mode,
            ${intent.purpose}::notification_purpose,
            ${intent.eventTypeVersion.id}::uuid,
            ${intent.rosterSnapshotId}::uuid,
            ${intent.rosterPopulation}::roster_population,
            ${intent.audienceConfig.id}::uuid,
            ${intent.audienceConfig.version}::integer,
            ${JSON.stringify(intent.createdBy)}::jsonb,
            ${intent.source}::invocation_source,
            ${intent.requestId}::uuid,
            ${JSON.stringify(intent.authorization)}::jsonb,
            ${intent.deliveryTest?.targetSet.id ?? null}::uuid,
            ${intent.deliveryTest?.targetSet.version ?? null}::integer,
            ${intent.deliveryTest?.endpointReferenceDigest ?? null}::varchar(64),
            ${intent.createdAt}::timestamptz,
            ${PREVIEW_CREATED_AT.toISOString()}::timestamptz
          )
        `);
      }),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(/fresh canonical preview/u),
      },
    });

    expect(
      databaseExecuteRows<
        Record<string, unknown> & {
          authorizationExists: boolean;
          intentExists: boolean;
        }
      >(
        await database.execute(sql`
          select
            exists(
              select 1 from notification_intents
              where id = ${BLOCKED_INTENT_ID}::uuid
            ) as "intentExists",
            exists(
              select 1 from fanout_intent_authorizations
              where intent_id = ${BLOCKED_INTENT_ID}::uuid
            ) as "authorizationExists"
        `),
      ),
    ).toEqual([{ intentExists: false, authorizationExists: false }]);
  });

  test('revokes the app role direct intent and authorization insert side doors', async () => {
    const database = databaseConnection().db;
    const privileges = databaseExecuteRows<
      Record<string, unknown> & {
        directIntentInsert: boolean;
        directAuthorizationInsert: boolean;
        functionExecute: boolean;
      }
    >(
      await database.execute(sql`
        select
          has_table_privilege(
            'psd_eoc_app',
            'public.notification_intents',
            'INSERT'
          ) as "directIntentInsert",
          has_table_privilege(
            'psd_eoc_app',
            'public.fanout_intent_authorizations',
            'INSERT'
          ) as "directAuthorizationInsert",
          has_function_privilege(
            'psd_eoc_app',
            'public.psd_eoc_insert_authorized_notification_intent(uuid, uuid, event_kind, template_mode, notification_purpose, uuid, uuid, roster_population, uuid, integer, jsonb, invocation_source, uuid, jsonb, uuid, integer, character varying, timestamp with time zone, timestamp with time zone)',
            'EXECUTE'
          ) as "functionExecute"
      `),
    );
    expect(privileges).toEqual([
      {
        directIntentInsert: false,
        directAuthorizationInsert: false,
        functionExecute: true,
      },
    ]);
    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`set local role psd_eoc_app`);
        await transaction.execute(
          sql`insert into notification_intents default values`,
        );
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied/u) },
    });
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
      Promise.resolve(
        database.execute(
          sql`update fanout_control_records set reason = 'rewrite'`,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/immutable truth/u) },
    });
    await expect(
      Promise.resolve(
        database.execute(sql`delete from fanout_control_records`),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/immutable truth/u) },
    });
    await expect(
      Promise.resolve(
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
      ),
    ).rejects.toMatchObject({
      cause: {
        message: expect.stringMatching(/append to the current revision/u),
      },
    });
  });
});
