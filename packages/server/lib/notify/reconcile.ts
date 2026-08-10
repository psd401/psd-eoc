import { randomUUID } from 'node:crypto';

import {
  DeliveryEvidenceSchema,
  DeliveryTruthTransitionSchema,
  IdempotencyKeySchema,
  NotificationChannelSchema,
  ReconcileDeliveryAttemptsInputSchema,
  ReconcileDeliveryAttemptsResultSchema,
  TimestampSchema,
  UuidSchema,
  executeCapability,
  registerCapabilityHandler,
  type Actor,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type DeliveryEvidence,
  type ReconcileDeliveryAttemptsInput,
  type ReconcileDeliveryAttemptsResult,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, PostgresDatabase } from '../../db/client';
import { channelAttempts, deliveryEvidence } from '../../db/schema';

export const DEFAULT_RECONCILIATION_STALE_AFTER_MILLISECONDS = 15 * 60_000;
export const RECONCILIATION_REASON_CODE =
  'RECONCILIATION_DEADLINE_EXCEEDED' as const;
export const RECONCILIATION_SERVICE_ID = 'delivery-reconciliation-job' as const;

const ATTEMPT_LOCK_NAMESPACE = 4_011;
const RECONCILIATION_LOCK_NAMESPACE = 4_012;
const MAX_STALE_AFTER_MILLISECONDS = 7 * 24 * 60 * 60_000;

export type ReconciliationErrorCode =
  | 'RECONCILIATION_CONFIGURATION_INVALID'
  | 'RECONCILIATION_PERSISTENCE_INVALID'
  | 'RECONCILIATION_UNAUTHORIZED';

/** Safe reconciliation failure without provider or recipient data. */
export class ReconciliationError extends Error {
  public constructor(
    public readonly code: ReconciliationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

/** Small append-only persistence boundary suitable for in-memory tests. */
export interface ReconciliationStore {
  reconcile(
    input: ReconcileDeliveryAttemptsInput,
  ): Promise<ReconcileDeliveryAttemptsResult>;
}

/** Trusted scheduled-job context; it is never accepted from request JSON. */
export interface ReconciliationCapabilityContext {
  readonly actor: Actor;
  readonly source: 'scheduled-job';
  readonly transport: 'scheduled-execution';
  readonly schedulerAuthenticated: true;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface ReconciliationExecutionDependencies {
  readonly store: ReconciliationStore;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface DrizzleReconciliationStoreOptions {
  readonly staleAfterMilliseconds?: number;
  readonly uuid?: () => string;
}

type ReconciliationQueryDatabase = PostgresDatabase;
type DeliveryEvidenceRow = typeof deliveryEvidence.$inferSelect;

function reconciliationQueryDatabase(
  database: unknown,
): ReconciliationQueryDatabase {
  // Both supported PostgreSQL transports expose this schema-aware surface.
  // The direct-driver type avoids a union of overloaded method signatures.
  return database as ReconciliationQueryDatabase;
}

function parseStaleAfter(value: number | undefined): number {
  const staleAfter = value ?? DEFAULT_RECONCILIATION_STALE_AFTER_MILLISECONDS;
  if (
    !Number.isSafeInteger(staleAfter) ||
    staleAfter < 1_000 ||
    staleAfter > MAX_STALE_AFTER_MILLISECONDS
  ) {
    throw new ReconciliationError(
      'RECONCILIATION_CONFIGURATION_INVALID',
      'The reconciliation deadline is outside its safe operating range.',
    );
  }
  return staleAfter;
}

function dateValue(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ReconciliationError(
      'RECONCILIATION_PERSISTENCE_INVALID',
      'Persisted reconciliation time was invalid.',
    );
  }
  return new Date(date.getTime());
}

function dateIso(value: Date | string): string {
  return dateValue(value).toISOString();
}

function evidenceFromRow(row: DeliveryEvidenceRow): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: row.id,
    subject:
      row.subjectKind === 'attempt'
        ? { kind: 'attempt', attemptId: row.subjectId }
        : { kind: 'intent', intentId: row.subjectId },
    sequence: row.sequence,
    previousEvidenceId: row.previousEvidenceId,
    state: row.state,
    recordedAt: dateIso(row.recordedAt),
    provider: row.provider,
    providerReference: row.providerReference,
    proof: row.proof,
    reasonCode: row.reasonCode,
    diagnosticDigest: row.diagnosticDigest,
  });
}

async function readDatabaseTime(
  database: ReconciliationQueryDatabase,
): Promise<Date> {
  const [row] = await database.execute<{ value: Date | string }>(
    sql`select clock_timestamp() as value`,
  );
  if (row === undefined) {
    throw new ReconciliationError(
      'RECONCILIATION_PERSISTENCE_INVALID',
      'The authoritative reconciliation clock was unavailable.',
    );
  }
  return dateValue(row.value);
}

async function lockReconciliation(
  database: ReconciliationQueryDatabase,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('delivery-reconciliation', ${RECONCILIATION_LOCK_NAMESPACE}))`,
  );
}

async function lockAttempt(
  database: ReconciliationQueryDatabase,
  attemptId: string,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`delivery-attempt-id:${attemptId}`}, ${ATTEMPT_LOCK_NAMESPACE}))`,
  );
}

async function latestAttemptEvidence(
  database: ReconciliationQueryDatabase,
  attemptId: string,
): Promise<DeliveryEvidence | null> {
  const [row] = await database
    .select()
    .from(deliveryEvidence)
    .where(
      and(
        eq(deliveryEvidence.subjectKind, 'attempt'),
        eq(deliveryEvidence.attemptId, attemptId),
      ),
    )
    .orderBy(desc(deliveryEvidence.sequence))
    .limit(1);
  return row === undefined ? null : evidenceFromRow(row);
}

async function listStaleAttemptIds(
  database: ReconciliationQueryDatabase,
  input: ReconcileDeliveryAttemptsInput,
  cutoff: Date,
): Promise<readonly string[]> {
  const latest = database
    .selectDistinctOn([deliveryEvidence.attemptId], {
      attemptId: deliveryEvidence.attemptId,
      state: deliveryEvidence.state,
      recordedAt: deliveryEvidence.recordedAt,
      sequence: deliveryEvidence.sequence,
    })
    .from(deliveryEvidence)
    .where(
      and(
        eq(deliveryEvidence.subjectKind, 'attempt'),
        isNotNull(deliveryEvidence.attemptId),
      ),
    )
    .orderBy(deliveryEvidence.attemptId, desc(deliveryEvidence.sequence))
    .as('latest_attempt_delivery_evidence');

  const rows = await database
    .select({ attemptId: channelAttempts.id })
    .from(channelAttempts)
    .innerJoin(latest, eq(latest.attemptId, channelAttempts.id))
    .where(
      and(
        input.intentId === null
          ? undefined
          : eq(channelAttempts.intentId, input.intentId),
        inArray(latest.state, ['attempted', 'provider-accepted']),
        lte(latest.recordedAt, cutoff),
      ),
    )
    .orderBy(asc(latest.recordedAt), asc(channelAttempts.id))
    .limit(input.limit);
  return Object.freeze(rows.map((row) => row.attemptId));
}

function isReconciliationCandidate(
  evidence: DeliveryEvidence,
  cutoff: Date,
): boolean {
  return (
    (evidence.state === 'attempted' ||
      evidence.state === 'provider-accepted') &&
    Date.parse(evidence.recordedAt) <= cutoff.getTime()
  );
}

async function appendUnknownEvidence(
  database: ReconciliationQueryDatabase,
  previous: DeliveryEvidence,
  uuid: () => string,
): Promise<DeliveryEvidence> {
  const recordedAt = await readDatabaseTime(database);
  const evidence = buildReconciliationUnknownEvidence(
    previous,
    recordedAt,
    uuid(),
  );
  if (evidence === null || evidence.subject.kind !== 'attempt') {
    throw new ReconciliationError(
      'RECONCILIATION_PERSISTENCE_INVALID',
      'Reconciliation selected an invalid truth transition.',
    );
  }
  await database.insert(deliveryEvidence).values({
    id: evidence.id,
    subjectKind: 'attempt',
    subjectId: evidence.subject.attemptId,
    intentId: null,
    attemptId: evidence.subject.attemptId,
    sequence: evidence.sequence,
    previousEvidenceId: evidence.previousEvidenceId,
    state: evidence.state,
    recordedAt,
    provider: evidence.provider,
    providerReference: evidence.providerReference,
    proof: null,
    reasonCode: evidence.reasonCode,
    diagnosticDigest: null,
  });
  return evidence;
}

/**
 * Pure append planner shared by the database adapter and deterministic tests.
 * Terminal and already-unknown facts are left untouched.
 */
export function buildReconciliationUnknownEvidence(
  previousValue: DeliveryEvidence,
  recordedAtValue: Date | string,
  evidenceIdValue: string,
): DeliveryEvidence | null {
  const previous = DeliveryEvidenceSchema.parse(previousValue);
  if (
    previous.subject.kind !== 'attempt' ||
    (previous.state !== 'attempted' && previous.state !== 'provider-accepted')
  ) {
    return null;
  }
  const transition = DeliveryTruthTransitionSchema.safeParse({
    subjectKind: 'attempt',
    from: previous.state,
    to: 'unknown',
  });
  const recordedAt = dateValue(recordedAtValue);
  if (
    !transition.success ||
    recordedAt.getTime() < Date.parse(previous.recordedAt)
  ) {
    throw new ReconciliationError(
      'RECONCILIATION_PERSISTENCE_INVALID',
      'Reconciliation could not append monotonic unknown evidence.',
    );
  }
  return DeliveryEvidenceSchema.parse({
    id: UuidSchema.parse(evidenceIdValue),
    subject: previous.subject,
    sequence: previous.sequence + 1,
    previousEvidenceId: previous.id,
    state: 'unknown',
    recordedAt: recordedAt.toISOString(),
    provider: previous.provider,
    providerReference: previous.providerReference,
    proof: null,
    reasonCode: RECONCILIATION_REASON_CODE,
    diagnosticDigest: null,
  });
}

/**
 * Creates a serialized append-only reconciler. It never updates an attempt,
 * deletes evidence, mutates an event, consumes a DLQ item, or redrives work.
 */
export function createDrizzleReconciliationStore(
  database: Database,
  options: DrizzleReconciliationStoreOptions = {},
): ReconciliationStore {
  const staleAfterMilliseconds = parseStaleAfter(
    options.staleAfterMilliseconds,
  );
  const uuid = options.uuid ?? randomUUID;
  return Object.freeze({
    reconcile(
      inputValue: ReconcileDeliveryAttemptsInput,
    ): Promise<ReconcileDeliveryAttemptsResult> {
      const input = ReconcileDeliveryAttemptsInputSchema.parse(inputValue);
      return database.transaction(async (transaction) => {
        const query = reconciliationQueryDatabase(transaction);
        await lockReconciliation(query);
        const now = await readDatabaseTime(query);
        const cutoff = new Date(now.getTime() - staleAfterMilliseconds);
        const attemptIds = await listStaleAttemptIds(query, input, cutoff);
        const appendedEvidence: DeliveryEvidence[] = [];
        for (const attemptId of attemptIds) {
          await lockAttempt(query, attemptId);
          const latest = await latestAttemptEvidence(query, attemptId);
          if (latest !== null && isReconciliationCandidate(latest, cutoff)) {
            appendedEvidence.push(
              await appendUnknownEvidence(query, latest, uuid),
            );
          }
        }
        return ReconcileDeliveryAttemptsResultSchema.parse({
          examinedAttemptCount: attemptIds.length,
          appendedEvidence,
        });
      });
    },
  });
}

/** Registers the reconciler under its exact canonical capability ID. */
export function createReconcileDeliveryAttemptsHandler(
  store: ReconciliationStore,
): Readonly<
  RegisteredCapabilityHandler<
    'reconcile-delivery-attempts',
    ReconciliationCapabilityContext
  >
> {
  return registerCapabilityHandler(
    'reconcile-delivery-attempts',
    async (input) =>
      ReconcileDeliveryAttemptsResultSchema.parse(await store.reconcile(input)),
  );
}

/** Deny-by-default authorization for the fixed scheduled reconciliation job. */
export function createReconciliationAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<ReconciliationCapabilityContext>
> {
  return Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        ReconciliationCapabilityContext
      >,
    ): void {
      const context = request.context;
      if (
        request.definition.id !== 'reconcile-delivery-attempts' ||
        request.definition.operation !== 'mutation' ||
        request.definition.safetyEffect !== 'none' ||
        request.invocationPolicy.agentGrantable ||
        !request.invocationPolicy.principalKinds.includes('system') ||
        !request.invocationPolicy.sources.includes('scheduled-job') ||
        context.actor.kind !== 'system' ||
        context.actor.serviceId !== RECONCILIATION_SERVICE_ID ||
        context.source !== 'scheduled-job' ||
        context.transport !== 'scheduled-execution' ||
        context.schedulerAuthenticated !== true ||
        request.humanActionRequirement.actionIds.length !== 0 ||
        request.humanActionRequirement.consequenceDigest !== null
      ) {
        throw new ReconciliationError(
          'RECONCILIATION_UNAUTHORIZED',
          'The reconciliation invocation was not authorized.',
        );
      }
      UuidSchema.parse(context.requestId);
      IdempotencyKeySchema.parse(context.idempotencyKey);
    },
  });
}

/**
 * Executes reconciliation only through the canonical safety and authorization
 * boundary; callers provide provenance, never an actor or alternate source.
 */
export async function executeReconcileDeliveryAttempts(
  input: unknown,
  dependencies: ReconciliationExecutionDependencies,
): Promise<ReconcileDeliveryAttemptsResult> {
  const context: ReconciliationCapabilityContext = Object.freeze({
    actor: Object.freeze({
      kind: 'system' as const,
      serviceId: RECONCILIATION_SERVICE_ID,
    }),
    source: 'scheduled-job',
    transport: 'scheduled-execution',
    schedulerAuthenticated: true,
    requestId: UuidSchema.parse(dependencies.requestId),
    idempotencyKey: IdempotencyKeySchema.parse(dependencies.idempotencyKey),
  });
  return executeCapability(
    createReconcileDeliveryAttemptsHandler(dependencies.store),
    input,
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createReconciliationAuthorizer(),
    },
  );
}

const DlqQueueObservationShape = {
  channel: NotificationChannelSchema,
  visibleMessageCount: z.number().int().nonnegative().max(1_000_000_000),
  inFlightMessageCount: z.number().int().nonnegative().max(1_000_000_000),
  oldestMessageAgeSeconds: z
    .number()
    .int()
    .nonnegative()
    .max(365 * 24 * 60 * 60)
    .nullable(),
} as const;

const DlqQueueObservationSchema = z
  .object(DlqQueueObservationShape)
  .strict()
  .readonly();

const DlqChannelReportSchema = z
  .object({
    ...DlqQueueObservationShape,
    messageCount: z.number().int().nonnegative().max(2_000_000_000),
  })
  .strict()
  .readonly();

const DlqDrainReportSchema = z
  .object({
    observedAt: TimestampSchema,
    messageCount: z.number().int().nonnegative().max(2_000_000_000),
    visibleMessageCount: z.number().int().nonnegative().max(1_000_000_000),
    inFlightMessageCount: z.number().int().nonnegative().max(1_000_000_000),
    requiresOperatorReview: z.boolean(),
    automaticRedrivePerformed: z.literal(false),
    messagesDeleted: z.literal(0),
    channels: z.array(DlqChannelReportSchema).max(3).readonly(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.messageCount !==
        report.visibleMessageCount + report.inFlightMessageCount ||
      report.requiresOperatorReview !== report.messageCount > 0 ||
      report.messageCount !==
        report.channels.reduce(
          (total, channel) => total + channel.messageCount,
          0,
        )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'DLQ aggregate counts are inconsistent.',
        path: ['messageCount'],
      });
    }
  })
  .readonly();

/** Destination-free queue metrics supplied by a read-only DLQ observer. */
export type DlqQueueObservation = z.infer<typeof DlqQueueObservationSchema>;

/** Aggregate-only report: no body, recipient, endpoint, delete, or redrive. */
export type DlqDrainReport = z.infer<typeof DlqDrainReportSchema>;

const CHANNEL_ORDER = Object.freeze(['push', 'email', 'sms'] as const);

/**
 * Builds a bounded, destination-free DLQ report from read-only queue metrics.
 * Duplicate observations are aggregated by channel and cannot carry payloads.
 */
export function buildDlqDrainReport(
  observationsValue: readonly DlqQueueObservation[],
  observedAtValue: Date,
): DlqDrainReport {
  const observations = z
    .array(DlqQueueObservationSchema)
    .max(30)
    .parse(observationsValue);
  const observedAt = TimestampSchema.parse(dateIso(observedAtValue));
  const channels = CHANNEL_ORDER.flatMap((channel) => {
    const matching = observations.filter(
      (observation) => observation.channel === channel,
    );
    if (matching.length === 0) return [];
    const visibleMessageCount = matching.reduce(
      (total, observation) => total + observation.visibleMessageCount,
      0,
    );
    const inFlightMessageCount = matching.reduce(
      (total, observation) => total + observation.inFlightMessageCount,
      0,
    );
    const ages = matching.flatMap((observation) =>
      observation.oldestMessageAgeSeconds === null
        ? []
        : [observation.oldestMessageAgeSeconds],
    );
    return [
      {
        channel,
        visibleMessageCount,
        inFlightMessageCount,
        oldestMessageAgeSeconds: ages.length === 0 ? null : Math.max(...ages),
        messageCount: visibleMessageCount + inFlightMessageCount,
      },
    ];
  });
  const visibleMessageCount = channels.reduce(
    (total, channel) => total + channel.visibleMessageCount,
    0,
  );
  const inFlightMessageCount = channels.reduce(
    (total, channel) => total + channel.inFlightMessageCount,
    0,
  );
  const messageCount = visibleMessageCount + inFlightMessageCount;
  return DlqDrainReportSchema.parse({
    observedAt,
    messageCount,
    visibleMessageCount,
    inFlightMessageCount,
    requiresOperatorReview: messageCount > 0,
    automaticRedrivePerformed: false,
    messagesDeleted: 0,
    channels,
  });
}
