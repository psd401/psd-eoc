import { randomUUID } from 'node:crypto';

import {
  FanoutAuthorizationDecisionSchema,
  FanoutControlEffectiveStateSchema,
  FanoutControlRecordSchema,
  FanoutStatusSchema,
  type FanoutAuthorizationDecision,
  type FanoutControlEffectiveState,
  type FanoutControlRecord,
  type FanoutStatus,
  type NotificationIntent,
} from '@psd-eoc/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import { databaseExecuteRows, type PostgresDatabase } from '../../db/client';
import {
  fanoutControlRecords,
  fanoutIntentAuthorizations,
} from '../../db/schema';

/**
 * Every control append, intent admission, dispatch, and provider-bound check
 * takes this same transaction-scoped lock. The final outbox/provider check is
 * the handoff's linearization point: if it commits first, that external
 * operation is already admitted and in flight; if disable commits first, the
 * check denies. Network transport cannot be part of the database transaction,
 * so disable never claims to recall a handoff admitted under the earlier order.
 */
export const FANOUT_CONTROL_ADVISORY_LOCK_SQL = sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('psd-eoc:fanout-control:v1', 0))`;

export class FanoutControlUnavailableError extends Error {
  public constructor() {
    super('The notification fan-out control state is unreadable.');
    this.name = 'FanoutControlUnavailableError';
  }
}

export class FanoutControlDeniedError extends Error {
  public constructor(
    public readonly reasonCode:
      | 'CONTROL_STATE_MISSING'
      | 'CONTROL_STATE_UNREADABLE'
      | 'EMERGENCY_DISABLED'
      | 'ENABLE_EPOCH_MISMATCH'
      | 'APPROVAL_REFERENCE_REUSED'
      | 'STALE_CONSEQUENCE_PREVIEW',
  ) {
    super(
      'Notification fan-out is not authorized by the current control state.',
    );
    this.name = 'FanoutControlDeniedError';
  }
}

/**
 * Shared schema-aware query surface for postgres-js and RDS Data API.
 * The advisory-lock query ignores raw transport rows, so its result remains
 * opaque and avoids coupling callers to either adapter's execute envelope.
 */
export type FanoutControlDatabase = object;

function asFanoutDatabase(database: FanoutControlDatabase): PostgresDatabase {
  // The configured Drizzle transports expose the same schema-aware operations
  // used below, but encode query-result HKTs differently. Keep that adapter
  // difference at this one boundary, as the shared admin store does.
  return database as PostgresDatabase;
}

function recordFromRow(
  row: typeof fanoutControlRecords.$inferSelect,
): FanoutControlRecord {
  return FanoutControlRecordSchema.parse({
    ...row,
    changedAt: row.changedAt.toISOString(),
  });
}

async function readCurrentRecordAfterLock(
  database: FanoutControlDatabase,
): Promise<FanoutControlRecord | null> {
  const rows = await asFanoutDatabase(database)
    .select()
    .from(fanoutControlRecords)
    .orderBy(desc(fanoutControlRecords.revision))
    .limit(2);
  const currentRow = rows[0];
  if (currentRow === undefined) return null;
  const current = recordFromRow(currentRow);
  const previousRow = rows[1];
  if (
    (current.revision === 1 && previousRow !== undefined) ||
    (current.revision > 1 &&
      (previousRow === undefined ||
        current.previousRecordId !== previousRow.id ||
        current.revision !== previousRow.revision + 1))
  ) {
    throw new FanoutControlUnavailableError();
  }
  return current;
}

/** Acquires the shared lock and returns the exact current append-only record. */
export async function lockAndReadCurrentFanoutControl(
  database: FanoutControlDatabase,
): Promise<FanoutControlRecord | null> {
  await asFanoutDatabase(database).execute(FANOUT_CONTROL_ADVISORY_LOCK_SQL);
  try {
    return await readCurrentRecordAfterLock(database);
  } catch (error) {
    if (error instanceof FanoutControlUnavailableError) throw error;
    throw new FanoutControlUnavailableError();
  }
}

/**
 * Requires the current global state to be enabled under the shared lock.
 * Preview creators call this before presenting any consequences to a human;
 * no missing, corrupt, or emergency-disabled state can yield a preview.
 */
export async function assertCurrentNotificationFanoutEnabled(
  database: FanoutControlDatabase,
): Promise<
  FanoutControlRecord & Readonly<{ mode: 'enabled'; enableEpochId: string }>
> {
  let current: FanoutControlRecord | null;
  try {
    current = await lockAndReadCurrentFanoutControl(database);
  } catch {
    throw new FanoutControlDeniedError('CONTROL_STATE_UNREADABLE');
  }
  if (current === null) {
    throw new FanoutControlDeniedError('CONTROL_STATE_MISSING');
  }
  if (current.mode !== 'enabled' || current.enableEpochId === null) {
    throw new FanoutControlDeniedError('EMERGENCY_DISABLED');
  }
  return current as FanoutControlRecord &
    Readonly<{ mode: 'enabled'; enableEpochId: string }>;
}

/** Appends one compare-and-set control transition under the shared lock. */
export async function appendFanoutControlRecord(input: {
  readonly database: FanoutControlDatabase;
  readonly actor: Readonly<{
    userId: string;
    sessionId: string;
  }>;
  readonly requestId: string;
  readonly expectedCurrentRecordId: string | null;
  readonly desiredMode: 'enabled' | 'emergency-disabled';
  readonly reason: string;
  readonly productOwnerApprovalReference: string | null;
  readonly changedAt: Date;
}): Promise<FanoutControlRecord> {
  const database = asFanoutDatabase(input.database);
  const current = await lockAndReadCurrentFanoutControl(input.database);
  if ((current?.id ?? null) !== input.expectedCurrentRecordId) {
    throw new FanoutControlDeniedError('ENABLE_EPOCH_MISMATCH');
  }
  if (
    input.desiredMode === 'enabled' &&
    input.productOwnerApprovalReference !== null
  ) {
    const [existingReference] = await database
      .select({ id: fanoutControlRecords.id })
      .from(fanoutControlRecords)
      .where(
        and(
          sql`${fanoutControlRecords.productOwnerApprovalReference} is not null`,
          sql`lower(${fanoutControlRecords.productOwnerApprovalReference}) = lower(${input.productOwnerApprovalReference})`,
        ),
      )
      .limit(1);
    if (existingReference !== undefined) {
      throw new FanoutControlDeniedError('APPROVAL_REFERENCE_REUSED');
    }
  }
  const enableEpochId =
    input.desiredMode === 'enabled' ? createFanoutEnableEpochId() : null;
  const [row] = await database
    .insert(fanoutControlRecords)
    .values({
      revision: (current?.revision ?? 0) + 1,
      previousRecordId: current?.id ?? null,
      mode: input.desiredMode,
      enableEpochId,
      reason: input.reason,
      productOwnerApprovalReference:
        input.desiredMode === 'enabled'
          ? input.productOwnerApprovalReference
          : null,
      changedByUserId: input.actor.userId,
      changedWithSessionId: input.actor.sessionId,
      requestId: input.requestId,
      changedAt: input.changedAt,
    })
    .returning();
  if (row === undefined) throw new FanoutControlUnavailableError();
  return recordFromRow(row);
}

/**
 * Best-effort administrative projection. Operational callers use the throwing
 * locked reader or decision helpers so an unreadable database never becomes
 * permissive.
 */
export async function readFanoutControlEffectiveState(
  database: FanoutControlDatabase,
): Promise<FanoutControlEffectiveState> {
  try {
    const current = await lockAndReadCurrentFanoutControl(database);
    return current === null
      ? FanoutControlEffectiveStateSchema.parse({
          kind: 'missing',
          effectiveMode: 'emergency-disabled',
          currentEpochId: null,
          currentRecord: null,
          reasonCode: 'CONTROL_STATE_MISSING',
        })
      : FanoutControlEffectiveStateSchema.parse({
          kind: 'current',
          effectiveMode: current.mode,
          currentEpochId: current.enableEpochId,
          currentRecord: current,
        });
  } catch {
    return FanoutControlEffectiveStateSchema.parse({
      kind: 'unavailable',
      effectiveMode: 'emergency-disabled',
      currentEpochId: null,
      currentRecord: null,
      reasonCode: 'CONTROL_STATE_UNREADABLE',
    });
  }
}

/**
 * Projects full control truth to the only fields staff surfaces require.
 * Missing and unreadable state remain unavailable rather than being presented
 * as an explicit administrator disable transition.
 */
export function projectFanoutStatus(
  state: FanoutControlEffectiveState,
): FanoutStatus {
  return FanoutStatusSchema.parse({
    status:
      state.kind !== 'current'
        ? 'unavailable'
        : state.effectiveMode === 'enabled'
          ? 'enabled'
          : 'emergency-disabled',
  });
}

/** Reads full truth internally and returns only its minimized staff status. */
export async function readFanoutStatus(
  database: FanoutControlDatabase,
): Promise<FanoutStatus> {
  return projectFanoutStatus(await readFanoutControlEffectiveState(database));
}

/** Loads one immutable historical record for exact idempotent replay. */
export async function loadFanoutControlRecordById(
  database: FanoutControlDatabase,
  recordId: string,
): Promise<FanoutControlRecord | null> {
  const [row] = await asFanoutDatabase(database)
    .select()
    .from(fanoutControlRecords)
    .where(eq(fanoutControlRecords.id, recordId))
    .limit(1);
  return row === undefined ? null : recordFromRow(row);
}

interface InsertAuthorizedIntentRow extends Record<string, unknown> {
  readonly controlRecordId: string;
  readonly enableEpochId: string;
}

/**
 * Atomically inserts one intent and its immutable enabled-epoch association.
 * The security-definer database function is the app role's only INSERT path
 * for notification intents, so no tuple-xmin inference or retroactive
 * authorization path exists, even across savepoints or XID wraparound.
 */
export async function insertAuthorizedNotificationIntentForFanout(input: {
  readonly database: FanoutControlDatabase;
  readonly intent: NotificationIntent;
  readonly previewCreatedAt: Date;
}): Promise<Readonly<{ controlRecordId: string; enableEpochId: string }>> {
  const database = asFanoutDatabase(input.database);
  let current: FanoutControlRecord | null;
  try {
    current = await lockAndReadCurrentFanoutControl(input.database);
  } catch {
    throw new FanoutControlDeniedError('CONTROL_STATE_UNREADABLE');
  }
  if (current === null) {
    throw new FanoutControlDeniedError('CONTROL_STATE_MISSING');
  }
  if (current.mode !== 'enabled' || current.enableEpochId === null) {
    throw new FanoutControlDeniedError('EMERGENCY_DISABLED');
  }
  if (input.previewCreatedAt.getTime() <= Date.parse(current.changedAt)) {
    throw new FanoutControlDeniedError('STALE_CONSEQUENCE_PREVIEW');
  }
  const intent = input.intent;
  const rows = databaseExecuteRows<InsertAuthorizedIntentRow>(
    await database.execute<InsertAuthorizedIntentRow>(sql`
      select
        "control_record_id" as "controlRecordId",
        "enable_epoch_id" as "enableEpochId"
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
        ${new Date(intent.createdAt).toISOString()}::timestamptz,
        ${input.previewCreatedAt.toISOString()}::timestamptz
      )
    `),
  );
  const inserted = rows[0];
  if (
    rows.length !== 1 ||
    inserted === undefined ||
    inserted.controlRecordId !== current.id ||
    inserted.enableEpochId !== current.enableEpochId
  ) {
    throw new FanoutControlDeniedError('ENABLE_EPOCH_MISMATCH');
  }
  return Object.freeze({
    controlRecordId: inserted.controlRecordId,
    enableEpochId: inserted.enableEpochId,
  });
}

function denied(
  reasonCode:
    | 'CONTROL_STATE_MISSING'
    | 'CONTROL_STATE_UNREADABLE'
    | 'EMERGENCY_DISABLED',
): FanoutAuthorizationDecision {
  return FanoutAuthorizationDecisionSchema.parse({
    authorized: false,
    currentEpochId: null,
    reasonCode,
  });
}

/** Checks one pinned epoch directly for internal transition/worker adapters. */
export async function authorizeFanoutEpoch(
  database: FanoutControlDatabase,
  expectedEnableEpochId: string,
): Promise<FanoutAuthorizationDecision> {
  try {
    const current = await lockAndReadCurrentFanoutControl(database);
    if (current === null) return denied('CONTROL_STATE_MISSING');
    if (current.mode !== 'enabled' || current.enableEpochId === null) {
      return denied('EMERGENCY_DISABLED');
    }
    if (current.enableEpochId !== expectedEnableEpochId) {
      return FanoutAuthorizationDecisionSchema.parse({
        authorized: false,
        currentEpochId: current.enableEpochId,
        reasonCode: 'ENABLE_EPOCH_MISMATCH',
      });
    }
    return FanoutAuthorizationDecisionSchema.parse({
      authorized: true,
      currentEpochId: current.enableEpochId,
    });
  } catch {
    return denied('CONTROL_STATE_UNREADABLE');
  }
}

/**
 * Verifies that an intent was admitted by the still-current enabled epoch.
 * Dispatch and provider-bound workers call this as their final awaited gate
 * immediately before the external handoff. A positive transaction linearizes
 * the handoff as in flight; missing association and every read error deny.
 */
export async function isNotificationIntentAuthorizedForCurrentFanout(
  database: FanoutControlDatabase,
  intentId: string,
): Promise<FanoutAuthorizationDecision> {
  try {
    const [authorization] = await asFanoutDatabase(database)
      .select({ enableEpochId: fanoutIntentAuthorizations.enableEpochId })
      .from(fanoutIntentAuthorizations)
      .where(eq(fanoutIntentAuthorizations.intentId, intentId))
      .limit(1);
    if (authorization === undefined) {
      // Still read current state before returning so missing/unavailable/
      // disabled truth wins over the association-missing mismatch.
      const current = await lockAndReadCurrentFanoutControl(database);
      if (current === null) return denied('CONTROL_STATE_MISSING');
      if (current.mode !== 'enabled' || current.enableEpochId === null) {
        return denied('EMERGENCY_DISABLED');
      }
      return FanoutAuthorizationDecisionSchema.parse({
        authorized: false,
        currentEpochId: current.enableEpochId,
        reasonCode: 'ENABLE_EPOCH_MISMATCH',
      });
    }
    return authorizeFanoutEpoch(database, authorization.enableEpochId);
  } catch {
    return denied('CONTROL_STATE_UNREADABLE');
  }
}

/** Internal exact-replay proof for a persisted authorization association. */
export async function loadFanoutIntentAuthorization(
  database: FanoutControlDatabase,
  intentId: string,
): Promise<Readonly<{
  controlRecordId: string;
  enableEpochId: string;
}> | null> {
  const [row] = await asFanoutDatabase(database)
    .select({
      controlRecordId: fanoutIntentAuthorizations.controlRecordId,
      enableEpochId: fanoutIntentAuthorizations.enableEpochId,
    })
    .from(fanoutIntentAuthorizations)
    .where(eq(fanoutIntentAuthorizations.intentId, intentId))
    .limit(1);
  return row === undefined ? null : Object.freeze(row);
}

/** Server-owned epoch generation; callers can never inject an epoch. */
export function createFanoutEnableEpochId(): string {
  return randomUUID();
}
