import { createHash } from 'node:crypto';

import {
  HUMAN_CONFIRMATION_MAX_AGE_SECONDS,
  HumanConfirmationSchema,
  HumanConfirmationRecordSchema,
  type ActivationPreview,
  type HumanConfirmation,
  type HumanOnlyActionId,
  type StartEventInput,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, exists, gte, lte, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../../../db/client';
import {
  activationPreviews,
  humanConfirmationActions,
  humanConfirmationRecords,
  securityAuditEntries,
} from '../../../../db/schema';
import {
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  toSecurityAuditInsertValues,
} from '../../../../lib/audit/drizzle-repository';
import { buildSecurityAuditEntry } from '../../../../lib/audit/entry';
import { parseSecurityAuditFact } from '../../../../lib/audit/model';
import { requireFacilityAccess } from '../../../../lib/auth/middleware';
import type { AuthenticatedSession } from '../../../../lib/auth/sessions';
import { CapabilityEngineError } from '../../../../lib/capabilities/engine';
import { loadActivationPreview } from './capabilities';

type ActivationPreviewStartInput = Extract<
  StartEventInput,
  Readonly<{ source: 'activation-preview' }>
>;

/** The only persistence operations allowed while issuing one confirmation. */
export interface StartConfirmationTransaction {
  readCurrentTime(): Promise<Date>;
  loadPreview(previewId: string): Promise<ActivationPreview | null>;
  loadConfirmation(confirmationId: string): Promise<unknown | null>;
  reserveActivationSubmission(
    input: ActivationRateLimitReservationInput,
  ): Promise<ActivationRateLimitDecision>;
  persistConfirmation(confirmation: HumanConfirmation): Promise<void>;
}

/** Atomic confirmation-issuance store, separated for fail-closed tests. */
export interface StartConfirmationStore {
  transaction<Result>(
    operation: (transaction: StartConfirmationTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface IssueStartConfirmationInput {
  readonly authenticated: AuthenticatedSession;
  readonly idempotencyKey: string;
  readonly startInput: ActivationPreviewStartInput;
}

/**
 * Server-only evidence handed directly from confirmation issuance to the
 * capability invocation. `executionTime` comes from the authoritative
 * database clock after a fresh confirmation is persisted.
 */
export interface StartConfirmationReceipt {
  readonly confirmationId: string;
  readonly confirmationIssuedAt: Date;
  readonly executionTime: Date;
}

export const ACTIVATION_RATE_LIMIT_MAX_SUBMISSIONS = 3;
export const ACTIVATION_RATE_LIMIT_WINDOW_MS = 60 * 1_000;

export interface ActivationRateLimitReservationInput {
  readonly actionIds: readonly HumanOnlyActionId[];
  readonly actor: Extract<
    AuthenticatedSession['actor'],
    Readonly<{ kind: 'human' }>
  >;
  readonly confirmationId: string;
  readonly consequenceDigest: string;
  readonly facilityId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly source: AuthenticatedSession['source'];
}

export type ActivationRateLimitDecision = 'denied' | 'fresh' | 'replay';

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function unavailable(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'LIVE_ACTION_UNAVAILABLE',
    'PERSISTENCE_CONFLICT',
    message,
    503,
    true,
  );
}

function rateLimited(): CapabilityEngineError {
  return new CapabilityEngineError(
    'RATE_LIMITED',
    'PERSISTENCE_CONFLICT',
    'Too many fresh activation submissions were made for this facility. Wait before making another explicit submission; nothing will retry automatically.',
    429,
    true,
  );
}

function invalidPriorConfirmation(): CapabilityEngineError {
  return new CapabilityEngineError(
    'FORBIDDEN',
    'CONFIRMATION_INVALID',
    'The prior human confirmation does not authorize this request.',
    403,
  );
}

function unsupportedSyntheticPreview(): CapabilityEngineError {
  return new CapabilityEngineError(
    'VALIDATION_ERROR',
    'MUTATION_METADATA_INVALID',
    'The interactive activation flow supports staff roster previews only.',
    400,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const first = [...left].sort();
  const second = [...right].sort();
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function protectedActions(
  preview: ActivationPreview,
): readonly HumanOnlyActionId[] {
  if (preview.rosterPopulation === 'synthetic') {
    return [];
  }
  return preview.kind === 'incident'
    ? ['start-real-incident', 'send-real-notification']
    : ['send-real-notification'];
}

/**
 * Issues confirmation solely from authenticated session facts and a canonical
 * persisted preview. No client-provided confirmation metadata reaches here.
 */
export async function issueStartEventConfirmation(
  input: IssueStartConfirmationInput,
  store: StartConfirmationStore,
): Promise<StartConfirmationReceipt> {
  const result = await store.transaction(async (transaction) => {
    const preview = await transaction.loadPreview(
      input.startInput.activationPreviewId,
    );
    if (preview === null) {
      throw new CapabilityEngineError(
        'NOT_FOUND',
        'PERSISTENCE_CONFLICT',
        'The activation preview was not found.',
        404,
      );
    }

    requireFacilityAccess(input.authenticated, preview.facilityId);
    if (preview.rosterPopulation !== 'staff') {
      throw unsupportedSyntheticPreview();
    }
    if (preview.sendReadiness !== 'ready') {
      throw unavailable('Notification delivery is not currently ready.');
    }
    if (
      !sameStrings(
        input.startInput.activeEventDecision.activeEventIdsSeen,
        preview.activeEventIds,
      )
    ) {
      throw conflict(
        'The active event list changed; review it before starting a new event.',
      );
    }

    const actionIds = protectedActions(preview);
    const connectivityEpochId = input.authenticated.result.connectivityEpoch.id;
    if (
      input.authenticated.actor.sessionId !==
        input.authenticated.result.session.id ||
      connectivityEpochId.length === 0
    ) {
      throw invalidPriorConfirmation();
    }
    const previewCheckedAt = await transaction.readCurrentTime();
    const evidenceIdentity = {
      actor: input.authenticated.actor,
      facilityId: preview.facilityId,
      idempotencyKey: input.idempotencyKey,
    };
    const confirmationId = evidenceRequestId('confirmation', evidenceIdentity);
    const reservationInput: ActivationRateLimitReservationInput = {
      actionIds,
      ...evidenceIdentity,
      confirmationId,
      consequenceDigest: preview.consequenceDigest,
      occurredAt: previewCheckedAt,
      source: input.authenticated.source,
    };
    const rateLimitDecision =
      await transaction.reserveActivationSubmission(reservationInput);
    // Re-read after the shared rate lock. A request that waited for contention
    // must not issue a stale confirmation or use an old rate-window clock.
    const now = await transaction.readCurrentTime();
    const issuedAt = now.toISOString();
    if (rateLimitDecision === 'replay') {
      const recordResult = HumanConfirmationRecordSchema.safeParse(
        await transaction.loadConfirmation(confirmationId),
      );
      if (!recordResult.success) {
        throw invalidPriorConfirmation();
      }
      const record = recordResult.data;
      const prior = record.confirmation;
      const priorIssuedAt = Date.parse(prior.issuedAt);
      const priorExpiresAt = Date.parse(prior.expiresAt);
      if (
        record.status === 'expired' ||
        prior.id !== confirmationId ||
        prior.capabilityId !== 'start-event' ||
        !sameStrings(prior.actionIds, actionIds) ||
        prior.confirmedByUserId !== input.authenticated.actor.userId ||
        prior.confirmedWithSessionId !== input.authenticated.actor.sessionId ||
        prior.connectivityEpochId !== connectivityEpochId ||
        prior.consequenceDigest !== preview.consequenceDigest ||
        priorIssuedAt > now.getTime() ||
        priorIssuedAt < Date.parse(preview.createdAt) ||
        priorIssuedAt > Date.parse(preview.expiresAt) ||
        priorExpiresAt > Date.parse(preview.expiresAt)
      ) {
        throw invalidPriorConfirmation();
      }
      if (record.status === 'consumed') {
        // A consumed confirmation proves the event transaction reached the
        // engine. Its completed idempotency result is resolved before safety.
        return {
          kind: 'accepted' as const,
          receipt: {
            confirmationId,
            confirmationIssuedAt: new Date(priorIssuedAt),
            executionTime: new Date(now),
          },
        };
      }
      if (
        now.getTime() < Date.parse(preview.createdAt) ||
        now.getTime() > Date.parse(preview.expiresAt) ||
        now.getTime() > priorExpiresAt
      ) {
        throw invalidPriorConfirmation();
      }
      return {
        kind: 'accepted' as const,
        receipt: {
          confirmationId,
          confirmationIssuedAt: new Date(priorIssuedAt),
          executionTime: new Date(now),
        },
      };
    }

    if (
      now.getTime() < Date.parse(preview.createdAt) ||
      now.getTime() > Date.parse(preview.expiresAt)
    ) {
      throw conflict('The consequence preview has expired.');
    }
    if (rateLimitDecision === 'denied') {
      return { kind: 'rate-limited' as const };
    }

    const previewExpiry = Date.parse(preview.expiresAt);
    const maximumExpiry =
      now.getTime() + HUMAN_CONFIRMATION_MAX_AGE_SECONDS * 1_000;
    const confirmation = HumanConfirmationSchema.parse({
      id: confirmationId,
      capabilityId: 'start-event',
      actionIds,
      connectivityEpochId,
      confirmedByUserId: input.authenticated.actor.userId,
      confirmedWithSessionId: input.authenticated.actor.sessionId,
      consequenceDigest: preview.consequenceDigest,
      issuedAt,
      expiresAt: new Date(Math.min(previewExpiry, maximumExpiry)).toISOString(),
    });
    await transaction.persistConfirmation(confirmation);
    const executionTime = await transaction.readCurrentTime();
    if (
      !Number.isFinite(executionTime.getTime()) ||
      executionTime.getTime() < now.getTime()
    ) {
      throw unavailable(
        'The authoritative execution time is unavailable after confirmation.',
      );
    }
    return {
      kind: 'accepted' as const,
      receipt: {
        confirmationId: confirmation.id,
        confirmationIssuedAt: new Date(now),
        executionTime: new Date(executionTime),
      },
    };
  });
  if (result.kind === 'rate-limited') {
    // The denial audit must commit before this public 429 escapes.
    throw rateLimited();
  }
  return result.receipt;
}

type ConfirmationQueryDatabase = DatabaseQuery;

function confirmationDatabase(database: unknown): ConfirmationQueryDatabase {
  return database as ConfirmationQueryDatabase;
}

async function readDatabaseTime(
  database: ConfirmationQueryDatabase,
): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw unavailable('The authoritative database clock is unavailable.');
  }
  return new Date(
    (row.value instanceof Date ? row.value : new Date(row.value)).toISOString(),
  );
}

const ACTIVATION_RATE_DENIAL_REASON = 'ACTIVATION_RATE_LIMITED';

function evidenceRequestId(
  purpose: 'confirmation' | 'denial',
  input: Pick<
    ActivationRateLimitReservationInput,
    'actor' | 'facilityId' | 'idempotencyKey'
  >,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'psd-eoc-activation-evidence-v1',
        purpose,
        input.actor.userId,
        input.actor.sessionId,
        input.facilityId,
        input.idempotencyKey,
      ]),
      'utf8',
    )
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(
    13,
    16,
  )}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function appendActivationRateDenialAudit(
  database: ConfirmationQueryDatabase,
  factValue: unknown,
): Promise<void> {
  await database.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
  const [previous] = await database
    .select({
      sequence: securityAuditEntries.sequence,
      entryHash: securityAuditEntries.entryHash,
    })
    .from(securityAuditEntries)
    .orderBy(desc(securityAuditEntries.sequence))
    .limit(1);
  const entry = buildSecurityAuditEntry(
    parseSecurityAuditFact(factValue),
    previous ?? null,
  );
  await database
    .insert(securityAuditEntries)
    .values(toSecurityAuditInsertValues(entry));
}

async function reserveActivationSubmission(
  database: ConfirmationQueryDatabase,
  requestedInput: ActivationRateLimitReservationInput,
): Promise<ActivationRateLimitDecision> {
  const rateScope = `${requestedInput.actor.userId}:${requestedInput.facilityId}`;
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${rateScope}, 4019))`,
  );
  const input = {
    ...requestedInput,
    occurredAt: await readDatabaseTime(database),
  };

  const [existingConfirmation] = await database
    .select({ id: humanConfirmationRecords.id })
    .from(humanConfirmationRecords)
    .where(eq(humanConfirmationRecords.id, input.confirmationId))
    .limit(1);
  if (existingConfirmation !== undefined) {
    return 'replay';
  }

  const windowStart = new Date(
    input.occurredAt.getTime() - ACTIVATION_RATE_LIMIT_WINDOW_MS,
  );
  const [recent] = await database
    .select({ value: sql<number>`count(*)::integer` })
    .from(humanConfirmationRecords)
    .where(
      and(
        eq(humanConfirmationRecords.capabilityId, 'start-event'),
        eq(humanConfirmationRecords.confirmedByUserId, input.actor.userId),
        gte(humanConfirmationRecords.issuedAt, windowStart),
        lte(humanConfirmationRecords.issuedAt, input.occurredAt),
        exists(
          database
            .select({ value: sql<number>`1` })
            .from(activationPreviews)
            .where(
              and(
                eq(
                  activationPreviews.consequenceDigest,
                  humanConfirmationRecords.consequenceDigest,
                ),
                eq(activationPreviews.facilityId, input.facilityId),
              ),
            ),
        ),
      ),
    );

  const commonFact = {
    action: 'start-event' as const,
    actionIds: input.actionIds,
    confirmationId: null,
    principal: input.actor,
    source: input.source,
    facilityId: input.facilityId,
    target: { kind: 'capability' as const, id: 'start-event' },
    occurredAt: input.occurredAt.toISOString(),
  };
  if (Number(recent?.value ?? 0) >= ACTIVATION_RATE_LIMIT_MAX_SUBMISSIONS) {
    const denialRequestId = evidenceRequestId('denial', input);
    const [existingDenial] = await database
      .select({ id: securityAuditEntries.id })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.requestId, denialRequestId))
      .limit(1);
    if (existingDenial === undefined) {
      await appendActivationRateDenialAudit(database, {
        ...commonFact,
        category: 'access-denial',
        outcome: 'denied',
        requestId: denialRequestId,
        reasonCode: ACTIVATION_RATE_DENIAL_REASON,
      });
    }
    return 'denied';
  }
  return 'fresh';
}

async function loadPersistedConfirmation(
  database: ConfirmationQueryDatabase,
  confirmationId: string,
): Promise<unknown | null> {
  const [row] = await database
    .select()
    .from(humanConfirmationRecords)
    .where(eq(humanConfirmationRecords.id, confirmationId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const actions = await database
    .select({ actionId: humanConfirmationActions.actionId })
    .from(humanConfirmationActions)
    .where(eq(humanConfirmationActions.confirmationId, confirmationId))
    .orderBy(asc(humanConfirmationActions.actionId));
  return {
    confirmation: {
      id: row.id,
      capabilityId: row.capabilityId,
      actionIds: actions.map((action) => action.actionId),
      connectivityEpochId: row.connectivityEpochId,
      confirmedByUserId: row.confirmedByUserId,
      confirmedWithSessionId: row.confirmedWithSessionId,
      consequenceDigest: row.consequenceDigest,
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    },
    status: row.status,
    consumedAt: row.consumedAt?.toISOString() ?? null,
    consumedForRequestId: row.consumedForRequestId,
    expiredAt: row.expiredAt?.toISOString() ?? null,
  };
}

async function persistConfirmation(
  database: ConfirmationQueryDatabase,
  confirmation: HumanConfirmation,
): Promise<void> {
  await database.insert(humanConfirmationRecords).values({
    id: confirmation.id,
    capabilityId: 'start-event',
    connectivityEpochId: confirmation.connectivityEpochId,
    confirmedByUserId: confirmation.confirmedByUserId,
    confirmedWithSessionId: confirmation.confirmedWithSessionId,
    consequenceDigest: confirmation.consequenceDigest,
    issuedAt: new Date(confirmation.issuedAt),
    expiresAt: new Date(confirmation.expiresAt),
    status: 'issued',
    consumedAt: null,
    consumedForRequestId: null,
    expiredAt: null,
  });
  await database.insert(humanConfirmationActions).values(
    confirmation.actionIds.map((actionId) => ({
      confirmationId: confirmation.id,
      actionId,
    })),
  );
}

/** Production Drizzle store; confirmation plus actions commit atomically. */
export function createDrizzleStartConfirmationStore(
  database: Database,
): StartConfirmationStore {
  return {
    transaction<Result>(
      operation: (transaction: StartConfirmationTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) => {
        const queryDatabase = confirmationDatabase(transaction);
        return operation({
          readCurrentTime: () => readDatabaseTime(queryDatabase),
          loadPreview: (previewId) =>
            loadActivationPreview(queryDatabase, previewId, { lock: 'share' }),
          loadConfirmation: (confirmationId) =>
            loadPersistedConfirmation(queryDatabase, confirmationId),
          reserveActivationSubmission: (input) =>
            reserveActivationSubmission(queryDatabase, input),
          persistConfirmation: (confirmation) =>
            persistConfirmation(queryDatabase, confirmation),
        });
      });
    },
  };
}

export interface StartConfirmationRuntime {
  issue(input: IssueStartConfirmationInput): Promise<StartConfirmationReceipt>;
  close(): Promise<void>;
}

/** Builds the confirmation boundary around an explicitly managed connection. */
export function createStartConfirmationRuntime(
  connection: DatabaseConnection,
): StartConfirmationRuntime {
  const store = createDrizzleStartConfirmationStore(connection.db);
  return {
    issue: (input) => issueStartEventConfirmation(input, store),
    close: () => connection.close(),
  };
}

let defaultStartConfirmationRuntime: StartConfirmationRuntime | undefined;

/** Lazily creates the server-only confirmation runtime used by start flow. */
export function getDefaultStartConfirmationRuntime(): StartConfirmationRuntime {
  defaultStartConfirmationRuntime ??= createStartConfirmationRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultStartConfirmationRuntime;
}

/** Lifecycle hook for tests; normal Next.js workers retain their pool. */
export async function closeDefaultStartConfirmationRuntime(): Promise<void> {
  const runtime = defaultStartConfirmationRuntime;
  defaultStartConfirmationRuntime = undefined;
  await runtime?.close();
}
