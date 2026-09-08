import { createHash } from 'node:crypto';

import {
  DispatchBatchSchema,
  ExpoReceiptDurableDecisionSchema,
  ExpoSendLedgerCompletionSchema,
  NotificationOutboxMessageSchema,
  PersistedExpoReceiptTargetSchema,
  PushWorkerAttemptWorkItemSchema,
  type ChannelAttempt,
  type DispatchBatch,
  type ExpoPushRuntimeRequest,
  type PersistedExpoReceiptTargetContract,
  type PushWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { databaseExecuteRows, type Database } from '../../db/client';
import {
  channelAttempts,
  dispatchBatches,
  events,
  expoPushProviderIo,
  expoPushReceiptPolls,
  expoPushRetrySchedules,
  outbox,
} from '../../db/schema';
import {
  createDrizzlePushEndpointPolicyStore,
  resolvePushEndpointPage,
  resolvePushEndpoints,
  rosterSnapshotWithLivePushTokens,
} from '../capabilities/devices';
import { loadRosterSnapshot } from '../capabilities/start';

const PUSH_PAGE_SIZE = 50;
const EXPO_TTL_MILLISECONDS = 60 * 60 * 1_000;

export type ExpoPushRuntimeStoreErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'BATCH_CONFLICT'
  | 'PROVIDER_IO_CONFLICT'
  | 'PROVIDER_IO_COMPLETION_CONFLICT'
  | 'RECEIPT_CONFLICT'
  | 'RECEIPT_LEASE_CONFLICT'
  | 'RECEIPT_STATE_CORRUPT'
  | 'RETRY_CONFLICT'
  | 'RETRY_NOT_FOUND'
  | 'RETRY_SOURCE_CONFLICT';

export class ExpoPushRuntimeStoreError extends Error {
  public constructor(public readonly code: ExpoPushRuntimeStoreErrorCode) {
    super('Expo push runtime state could not be handled safely.');
    this.name = 'ExpoPushRuntimeStoreError';
  }
}

export type ExpoProviderIoLookupResult =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{
      kind: 'completed';
      completion: ReturnType<typeof ExpoSendLedgerCompletionSchema.parse>;
    }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'conflict' }>;

export type ExpoProviderIoClaimResult =
  | Readonly<{ kind: 'execute'; claimToken: string }>
  | Readonly<{
      kind: 'completed';
      completion: ReturnType<typeof ExpoSendLedgerCompletionSchema.parse>;
    }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'conflict' }>;

export interface ExpoReceiptClaimRecord {
  readonly target: PersistedExpoReceiptTargetContract;
  readonly dueAt: string;
  readonly horizonAt: string;
  readonly pollAttemptNumber: number;
  readonly lastReasonCode: string | null;
  readonly receiptReferenceState: 'unique' | 'conflict';
  readonly pendingAction: unknown | null;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export type ExpoRetryScheduleResult =
  | Readonly<{
      kind: 'scheduled';
      attemptId: string;
      retryAt: string;
    }>
  | Readonly<{ kind: 'expired' }>;

export type ExpoRetryResolution =
  | Readonly<{ kind: 'ready'; workItem: PushWorkerAttemptWorkItem }>
  | Readonly<{ kind: 'not-before'; retryAt: string }>
  | Readonly<{ kind: 'expired' | 'ineligible' }>;

export interface ExpoBatchResolutionPage {
  readonly items: readonly PushWorkerAttemptWorkItem[];
  readonly nextCursor: number | null;
}

export interface ExpoPushRuntimeStore {
  countStuckOutbox(): Promise<number>;
  lookupProviderIo(input: {
    attemptId: string;
    workFingerprint: string;
  }): Promise<ExpoProviderIoLookupResult>;
  claimProviderIo(input: {
    attemptId: string;
    workFingerprint: string;
  }): Promise<ExpoProviderIoClaimResult>;
  completeProviderIo(input: {
    attemptId: string;
    workFingerprint: string;
    claimToken: string;
    completion: unknown;
  }): Promise<void>;
  scheduleReceipt(input: {
    target: unknown;
    firstPollAt: string;
    horizonAt: string;
  }): Promise<void>;
  claimDueReceipts(input: {
    now: string;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly ExpoReceiptClaimRecord[]>;
  decideReceipt(input: {
    attemptId: string;
    fingerprint: string;
    leaseToken: string;
    decision: unknown;
  }): Promise<void>;
  scheduleRetry(
    input: Extract<ExpoPushRuntimeRequest, { operation: 'schedule-retry' }>,
  ): Promise<ExpoRetryScheduleResult>;
  resolveBatch(
    input: Extract<ExpoPushRuntimeRequest, { operation: 'resolve-batch' }>,
  ): Promise<ExpoBatchResolutionPage>;
  resolveRetry(attemptId: string): Promise<ExpoRetryResolution>;
}

function iso(value: Date): string {
  return value.toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      // Optional contract fields cross JSON boundaries by being omitted.
      // Treat an explicitly materialized `undefined` exactly the same way so
      // persisted reconstruction cannot conflict with its wire equivalent.
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function isReceiptReferenceConflictDecision(
  decision: ReturnType<typeof ExpoReceiptDurableDecisionSchema.parse>,
): boolean {
  if (decision.kind === 'known-outcome-pending') {
    return (
      decision.action.kind === 'terminal-unknown' &&
      decision.action.state === 'unknown' &&
      decision.action.reasonCode === 'EXPO_RECEIPT_REFERENCE_CONFLICT'
    );
  }
  return (
    decision.kind === 'terminal-dlq' &&
    decision.state === 'unknown' &&
    decision.reasonCode === 'EXPO_RECEIPT_REFERENCE_CONFLICT'
  );
}

function deterministicAttemptId(
  batchId: string,
  endpointId: string,
  attemptNumber: number,
): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`${batchId}:${endpointId}:${attemptNumber}`, 'utf8')
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function receiptTargetFingerprint(
  target: PersistedExpoReceiptTargetContract,
): string {
  return createHash('sha256')
    .update(
      stableJson({
        attempt: target.attempt,
        providerAcceptedEvidence: target.providerAcceptedEvidence,
        receiptId: target.receiptId,
        batchCreatedAt: target.batchCreatedAt,
        expiresAt: target.expiresAt,
      }),
      'utf8',
    )
    .digest('hex');
}

function parseReceiptTarget(
  value: unknown,
): PersistedExpoReceiptTargetContract {
  const target = PersistedExpoReceiptTargetSchema.parse(value);
  if (receiptTargetFingerprint(target) !== target.fingerprint) {
    throw new ExpoPushRuntimeStoreError('RECEIPT_STATE_CORRUPT');
  }
  return target;
}

async function persistedBatch(
  database: Database,
  batchId: string,
): Promise<DispatchBatch> {
  const [record] = await database
    .select({
      batch: dispatchBatches,
      message: outbox.message,
      facilityId: events.facilityId,
    })
    .from(dispatchBatches)
    .innerJoin(outbox, eq(outbox.id, dispatchBatches.outboxId))
    .innerJoin(events, eq(events.id, dispatchBatches.eventId))
    .where(eq(dispatchBatches.id, batchId))
    .limit(1);
  if (record === undefined) {
    throw new ExpoPushRuntimeStoreError('BATCH_NOT_FOUND');
  }
  const message = NotificationOutboxMessageSchema.parse(record.message);
  const planned = message.channels.find(
    (candidate) => candidate.channel === record.batch.channel,
  );
  if (planned === undefined) {
    throw new ExpoPushRuntimeStoreError('BATCH_CONFLICT');
  }
  return DispatchBatchSchema.parse({
    id: record.batch.id,
    intentId: record.batch.intentId,
    eventId: record.batch.eventId,
    facilityId: message.version === 2 ? message.facilityId : record.facilityId,
    eventKind: record.batch.eventKind,
    templateMode: record.batch.templateMode,
    purpose: record.batch.purpose,
    eventTypeVersion: {
      id: record.batch.eventTypeVersionId,
      templateMode: record.batch.templateMode,
    },
    rosterSnapshotId: record.batch.rosterSnapshotId,
    rosterPopulation: record.batch.rosterPopulation,
    requestId: record.batch.requestId,
    authorization: record.batch.authorization,
    channel: record.batch.channel,
    renderedMessage: record.batch.renderedMessage,
    integrationId: planned.integrationId,
    sequence: record.batch.sequence,
    endpointCount: record.batch.endpointCount,
    createdAt: iso(record.batch.createdAt),
  });
}

async function resolvedPushEndpoints(database: Database, batch: DispatchBatch) {
  const roster = await loadRosterSnapshot(
    database as unknown as Parameters<typeof loadRosterSnapshot>[0],
    batch.rosterPopulation,
    batch.facilityId,
    batch.rosterSnapshotId,
  );
  if (roster === null) {
    throw new ExpoPushRuntimeStoreError('BATCH_CONFLICT');
  }
  const audienceRoster = await rosterSnapshotWithLivePushTokens(
    database as unknown as Parameters<
      typeof rosterSnapshotWithLivePushTokens
    >[0],
    roster,
    batch.createdAt,
  );
  return resolvePushEndpoints(
    {
      batch,
      audience: {
        facilityId: batch.facilityId,
        rosterSnapshot: audienceRoster,
      },
    },
    createDrizzlePushEndpointPolicyStore(database),
  );
}

async function resolvedPushEndpointPage(
  database: Database,
  batch: DispatchBatch,
  cursor: number,
) {
  const roster = await loadRosterSnapshot(
    database as unknown as Parameters<typeof loadRosterSnapshot>[0],
    batch.rosterPopulation,
    batch.facilityId,
    batch.rosterSnapshotId,
  );
  if (roster === null) {
    throw new ExpoPushRuntimeStoreError('BATCH_CONFLICT');
  }
  const audienceRoster = await rosterSnapshotWithLivePushTokens(
    database as unknown as Parameters<
      typeof rosterSnapshotWithLivePushTokens
    >[0],
    roster,
    // Pinned to the batch's creation instant so every page of this batch,
    // each a separate request, computes the identical candidate list.
    batch.createdAt,
  );
  return resolvePushEndpointPage(
    {
      batch,
      audience: {
        facilityId: batch.facilityId,
        rosterSnapshot: audienceRoster,
      },
    },
    createDrizzlePushEndpointPolicyStore(database),
    cursor,
    PUSH_PAGE_SIZE,
  );
}

function attemptFor(
  batch: DispatchBatch,
  recipientId: string,
  endpointId: string,
  id: string,
  attemptNumber: number,
  attemptedAt: string,
): ChannelAttempt {
  return {
    id,
    batchId: batch.id,
    intentId: batch.intentId,
    eventId: batch.eventId,
    eventKind: batch.eventKind,
    templateMode: batch.templateMode,
    purpose: batch.purpose,
    eventTypeVersion: batch.eventTypeVersion,
    rosterSnapshotId: batch.rosterSnapshotId,
    rosterPopulation: batch.rosterPopulation,
    recipientId,
    endpointId,
    channel: 'push',
    attemptNumber,
    attemptedAt,
  };
}

function workItemFor(
  batch: DispatchBatch,
  resolved: Awaited<ReturnType<typeof resolvedPushEndpoints>>[number],
  attempt: ChannelAttempt,
): PushWorkerAttemptWorkItem {
  return PushWorkerAttemptWorkItemSchema.parse({
    batch,
    attempt,
    endpoint: resolved.endpoint,
  });
}

function providerIoResult(
  row: typeof expoPushProviderIo.$inferSelect | undefined,
  fingerprint: string,
): ExpoProviderIoLookupResult {
  if (row === undefined) return Object.freeze({ kind: 'missing' });
  if (row.workFingerprint !== fingerprint) {
    return Object.freeze({ kind: 'conflict' });
  }
  if (row.completion === null) return Object.freeze({ kind: 'uncertain' });
  return Object.freeze({
    kind: 'completed',
    completion: ExpoSendLedgerCompletionSchema.parse(row.completion),
  });
}

function receiptClaimFromRow(
  row: typeof expoPushReceiptPolls.$inferSelect,
): ExpoReceiptClaimRecord {
  if (
    row.leaseToken === null ||
    row.leaseExpiresAt === null ||
    (row.receiptReferenceState !== 'unique' &&
      row.receiptReferenceState !== 'conflict')
  ) {
    throw new ExpoPushRuntimeStoreError('RECEIPT_STATE_CORRUPT');
  }
  return Object.freeze({
    target: parseReceiptTarget(row.target),
    dueAt: iso(row.dueAt),
    horizonAt: iso(row.horizonAt),
    pollAttemptNumber: row.pollAttemptNumber,
    lastReasonCode: row.lastReasonCode,
    receiptReferenceState: row.receiptReferenceState,
    pendingAction: row.pendingAction,
    leaseToken: row.leaseToken,
    leaseExpiresAt: iso(row.leaseExpiresAt),
  });
}

function retryRequestMatches(
  row: typeof expoPushRetrySchedules.$inferSelect,
  input: Extract<ExpoPushRuntimeRequest, { operation: 'schedule-retry' }>,
): boolean {
  return (
    row.sourceAttemptId === input.sourceAttempt.id &&
    row.sourceFingerprint === input.sourceFingerprint &&
    row.receiptId === input.receiptId &&
    row.nextAttemptNumber === input.nextAttemptNumber &&
    row.delayMilliseconds === input.delayMilliseconds &&
    iso(row.retryAt) === input.retryAt &&
    iso(row.expiresAt) === input.expiresAt &&
    row.reasonCode === input.reasonCode
  );
}

export function createDrizzleExpoPushRuntimeStore(
  database: Database,
): ExpoPushRuntimeStore {
  const store: ExpoPushRuntimeStore = {
    async countStuckOutbox() {
      const [row] = await database
        .select({ count: sql<number>`count(*)::integer` })
        .from(outbox)
        .where(
          and(
            eq(outbox.rosterPopulation, 'staff'),
            or(eq(outbox.eventKind, 'incident'), eq(outbox.eventKind, 'drill')),
            lte(outbox.createdAt, sql`clock_timestamp() - interval '1 minute'`),
            isNull(outbox.publishedAt),
            isNull(outbox.failedAt),
          ),
        );
      if (
        row === undefined ||
        !Number.isSafeInteger(row.count) ||
        row.count < 0
      ) {
        throw new ExpoPushRuntimeStoreError('BATCH_CONFLICT');
      }
      return row.count;
    },

    async lookupProviderIo(input) {
      const [row] = await database
        .select()
        .from(expoPushProviderIo)
        .where(eq(expoPushProviderIo.attemptId, input.attemptId))
        .limit(1);
      return providerIoResult(row, input.workFingerprint);
    },

    async claimProviderIo(input) {
      return database.transaction(async (transaction) => {
        const [inserted] = databaseExecuteRows<{ claimToken: string }>(
          await transaction.execute(sql`
            insert into expo_push_provider_io (
              attempt_id, work_fingerprint
            ) values (
              ${input.attemptId}::uuid, ${input.workFingerprint}
            )
            on conflict (attempt_id) do nothing
            returning claim_token as "claimToken"
          `),
        );
        if (inserted !== undefined) {
          return Object.freeze({
            kind: 'execute' as const,
            claimToken: inserted.claimToken,
          });
        }
        const [row] = await transaction
          .select()
          .from(expoPushProviderIo)
          .where(eq(expoPushProviderIo.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        const recovered = providerIoResult(row, input.workFingerprint);
        return recovered.kind === 'missing'
          ? Object.freeze({ kind: 'uncertain' as const })
          : recovered;
      });
    },

    async completeProviderIo(input) {
      const completion = ExpoSendLedgerCompletionSchema.parse(input.completion);
      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(expoPushProviderIo)
          .where(eq(expoPushProviderIo.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        if (
          row === undefined ||
          row.workFingerprint !== input.workFingerprint ||
          row.claimToken !== input.claimToken
        ) {
          throw new ExpoPushRuntimeStoreError('PROVIDER_IO_CONFLICT');
        }
        if (row.completion !== null) {
          if (!sameJson(row.completion, completion)) {
            throw new ExpoPushRuntimeStoreError(
              'PROVIDER_IO_COMPLETION_CONFLICT',
            );
          }
          return;
        }
        const updated = await transaction
          .update(expoPushProviderIo)
          .set({ completion, completedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(expoPushProviderIo.attemptId, input.attemptId),
              eq(expoPushProviderIo.workFingerprint, input.workFingerprint),
              eq(expoPushProviderIo.claimToken, input.claimToken),
              isNull(expoPushProviderIo.completion),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new ExpoPushRuntimeStoreError('PROVIDER_IO_CONFLICT');
        }
      });
    },

    async scheduleReceipt(input) {
      const target = parseReceiptTarget(input.target);
      const firstPollAt = new Date(input.firstPollAt);
      const horizonAt = new Date(input.horizonAt);
      if (
        !Number.isFinite(firstPollAt.getTime()) ||
        !Number.isFinite(horizonAt.getTime()) ||
        firstPollAt >= horizonAt
      ) {
        throw new ExpoPushRuntimeStoreError('RECEIPT_CONFLICT');
      }
      await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${target.receiptId}, 278))`,
        );
        const [inserted] = databaseExecuteRows<{ attemptId: string }>(
          await transaction.execute(sql`
            insert into expo_push_receipt_polls (
              attempt_id,
              receipt_id,
              fingerprint,
              target,
              first_poll_at,
              horizon_at,
              due_at
            ) values (
              ${target.attempt.id}::uuid,
              ${target.receiptId},
              ${target.fingerprint},
              ${JSON.stringify(target)}::jsonb,
              ${firstPollAt.toISOString()}::timestamptz,
              ${horizonAt.toISOString()}::timestamptz,
              ${firstPollAt.toISOString()}::timestamptz
            )
            on conflict (attempt_id) do nothing
            returning attempt_id as "attemptId"
          `),
        );
        if (inserted === undefined) {
          const [existing] = await transaction
            .select()
            .from(expoPushReceiptPolls)
            .where(eq(expoPushReceiptPolls.attemptId, target.attempt.id))
            .limit(1)
            .for('update');
          if (
            existing === undefined ||
            existing.fingerprint !== target.fingerprint ||
            existing.receiptId !== target.receiptId ||
            iso(existing.firstPollAt) !== input.firstPollAt ||
            iso(existing.horizonAt) !== input.horizonAt ||
            !sameJson(existing.target, target)
          ) {
            throw new ExpoPushRuntimeStoreError('RECEIPT_CONFLICT');
          }
        }
        const bindings = await transaction
          .select({ attemptId: expoPushReceiptPolls.attemptId })
          .from(expoPushReceiptPolls)
          .where(eq(expoPushReceiptPolls.receiptId, target.receiptId));
        if (bindings.length > 1) {
          await transaction
            .update(expoPushReceiptPolls)
            .set({
              receiptReferenceState: 'conflict',
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(expoPushReceiptPolls.receiptId, target.receiptId),
                isNull(expoPushReceiptPolls.pendingAction),
                isNull(expoPushReceiptPolls.terminalDecision),
              ),
            );
        }
      });
    },

    async claimDueReceipts(input) {
      return database.transaction(async (transaction) => {
        const rows = await transaction
          .select()
          .from(expoPushReceiptPolls)
          .where(
            and(
              isNull(expoPushReceiptPolls.terminalDecision),
              lte(expoPushReceiptPolls.dueAt, sql`clock_timestamp()`),
              or(
                isNull(expoPushReceiptPolls.leaseExpiresAt),
                lte(
                  expoPushReceiptPolls.leaseExpiresAt,
                  sql`clock_timestamp()`,
                ),
              ),
            ),
          )
          .orderBy(
            asc(expoPushReceiptPolls.dueAt),
            asc(expoPushReceiptPolls.attemptId),
          )
          .limit(input.limit)
          .for('update', { skipLocked: true });
        const claims: ExpoReceiptClaimRecord[] = [];
        for (const row of rows) {
          const [claimed] = await transaction
            .update(expoPushReceiptPolls)
            .set({
              leaseToken: sql`gen_random_uuid()`,
              leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${input.leaseMilliseconds} / 1000.0)`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(expoPushReceiptPolls.attemptId, row.attemptId))
            .returning();
          if (claimed === undefined) {
            throw new ExpoPushRuntimeStoreError('RECEIPT_LEASE_CONFLICT');
          }
          claims.push(receiptClaimFromRow(claimed));
        }
        return Object.freeze(claims);
      });
    },

    async decideReceipt(input) {
      const decision = ExpoReceiptDurableDecisionSchema.parse(input.decision);
      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(expoPushReceiptPolls)
          .where(eq(expoPushReceiptPolls.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        if (row === undefined || row.fingerprint !== input.fingerprint) {
          throw new ExpoPushRuntimeStoreError('RECEIPT_CONFLICT');
        }
        // Once another attempt is bound to the same provider receipt ID, a
        // stale worker must not turn its formerly unique claim into endpoint
        // invalidation or any other provider truth. The only legal path is the
        // explicit staged/final ambiguous outcome for the collision itself.
        if (
          row.receiptReferenceState === 'conflict' &&
          !isReceiptReferenceConflictDecision(decision)
        ) {
          throw new ExpoPushRuntimeStoreError('RECEIPT_CONFLICT');
        }
        if (row.lastDecision !== null && sameJson(row.lastDecision, decision)) {
          return;
        }
        const [lease] = await transaction
          .select({
            current: sql<boolean>`${expoPushReceiptPolls.leaseToken} = ${input.leaseToken}
              and ${expoPushReceiptPolls.leaseExpiresAt} > clock_timestamp()`,
          })
          .from(expoPushReceiptPolls)
          .where(eq(expoPushReceiptPolls.attemptId, input.attemptId))
          .limit(1);
        if (lease?.current !== true || row.terminalDecision !== null) {
          throw new ExpoPushRuntimeStoreError('RECEIPT_LEASE_CONFLICT');
        }
        if (decision.kind === 'known-outcome-pending') {
          await transaction
            .update(expoPushReceiptPolls)
            .set({
              pendingAction: decision.action,
              lastDecision: decision,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(expoPushReceiptPolls.attemptId, input.attemptId));
          return;
        }
        if (decision.kind === 'reschedule') {
          const nextPollAt = new Date(decision.nextPollAt);
          if (
            decision.nextPollAttemptNumber !== row.pollAttemptNumber + 1 ||
            nextPollAt <= row.dueAt ||
            nextPollAt > row.horizonAt ||
            row.pendingAction !== null
          ) {
            throw new ExpoPushRuntimeStoreError('RECEIPT_CONFLICT');
          }
          await transaction
            .update(expoPushReceiptPolls)
            .set({
              dueAt: nextPollAt,
              pollAttemptNumber: decision.nextPollAttemptNumber,
              lastReasonCode: decision.reasonCode,
              leaseToken: null,
              leaseExpiresAt: null,
              lastDecision: decision,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(expoPushReceiptPolls.attemptId, input.attemptId));
          return;
        }
        if (row.pendingAction !== null) {
          const pending = row.pendingAction as Readonly<{
            state?: unknown;
            reasonCode?: unknown;
          }>;
          if (
            decision.kind === 'complete' ||
            pending.state !== decision.state ||
            ('reasonCode' in decision &&
              pending.reasonCode !== decision.reasonCode)
          ) {
            throw new ExpoPushRuntimeStoreError('RECEIPT_CONFLICT');
          }
        }
        await transaction
          .update(expoPushReceiptPolls)
          .set({
            leaseToken: null,
            leaseExpiresAt: null,
            pendingAction: null,
            lastDecision: decision,
            terminalDecision: decision,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(expoPushReceiptPolls.attemptId, input.attemptId));
      });
    },

    async scheduleRetry(input) {
      const sourceBatch = await persistedBatch(
        database,
        input.sourceAttempt.batchId,
      );
      const [source] = await database
        .select()
        .from(channelAttempts)
        .where(eq(channelAttempts.id, input.sourceAttempt.id))
        .limit(1);
      if (source === undefined) {
        throw new ExpoPushRuntimeStoreError('RETRY_NOT_FOUND');
      }
      const storedAttempt = attemptFor(
        sourceBatch,
        source.recipientId,
        source.endpointId,
        source.id,
        source.attemptNumber,
        iso(source.attemptedAt),
      );
      if (
        !sameJson(storedAttempt, input.sourceAttempt) ||
        input.nextAttemptNumber !== source.attemptNumber + 1 ||
        input.expiresAt !==
          new Date(
            Date.parse(sourceBatch.createdAt) + EXPO_TTL_MILLISECONDS,
          ).toISOString() ||
        Date.parse(input.retryAt) >= Date.parse(input.expiresAt)
      ) {
        throw new ExpoPushRuntimeStoreError('RETRY_SOURCE_CONFLICT');
      }
      return database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(expoPushRetrySchedules)
          .where(
            eq(expoPushRetrySchedules.sourceAttemptId, input.sourceAttempt.id),
          )
          .limit(1);
        if (existing !== undefined) {
          if (!retryRequestMatches(existing, input)) {
            throw new ExpoPushRuntimeStoreError('RETRY_CONFLICT');
          }
          return Object.freeze({
            kind: 'scheduled' as const,
            attemptId: existing.nextAttemptId,
            retryAt: iso(existing.retryAt),
          });
        }
        const [notExpired] = databaseExecuteRows<{ available: boolean }>(
          await transaction.execute(
            sql`select ${input.expiresAt}::timestamptz > clock_timestamp() as available`,
          ),
        );
        if (notExpired?.available !== true) {
          return Object.freeze({ kind: 'expired' as const });
        }
        const [inserted] = databaseExecuteRows<{ nextAttemptId: string }>(
          await transaction.execute(sql`
            insert into expo_push_retry_schedules (
              source_attempt_id,
              source_fingerprint,
              receipt_id,
              next_attempt_number,
              delay_milliseconds,
              retry_at,
              expires_at,
              reason_code
            ) values (
              ${input.sourceAttempt.id}::uuid,
              ${input.sourceFingerprint},
              ${input.receiptId},
              ${input.nextAttemptNumber},
              ${input.delayMilliseconds},
              ${input.retryAt}::timestamptz,
              ${input.expiresAt}::timestamptz,
              ${input.reasonCode}
            )
            on conflict (source_attempt_id) do nothing
            returning next_attempt_id as "nextAttemptId"
          `),
        );
        if (inserted !== undefined) {
          return Object.freeze({
            kind: 'scheduled' as const,
            attemptId: inserted.nextAttemptId,
            retryAt: input.retryAt,
          });
        }
        const [persisted] = await transaction
          .select()
          .from(expoPushRetrySchedules)
          .where(
            eq(expoPushRetrySchedules.sourceAttemptId, input.sourceAttempt.id),
          )
          .limit(1);
        if (persisted === undefined || !retryRequestMatches(persisted, input)) {
          throw new ExpoPushRuntimeStoreError('RETRY_CONFLICT');
        }
        return Object.freeze({
          kind: 'scheduled' as const,
          attemptId: persisted.nextAttemptId,
          retryAt: iso(persisted.retryAt),
        });
      });
    },

    async resolveBatch(input) {
      const batch = await persistedBatch(database, input.batch.id);
      if (
        !sameJson(batch, input.batch) ||
        Date.parse(input.enqueuedAt) < Date.parse(batch.createdAt)
      ) {
        throw new ExpoPushRuntimeStoreError('BATCH_CONFLICT');
      }
      const page = await resolvedPushEndpointPage(
        database,
        batch,
        input.cursor,
      );
      const items = page.endpoints.map((resolved) => {
        const attemptId = deterministicAttemptId(
          batch.id,
          resolved.endpoint.id,
          1,
        );
        return workItemFor(
          batch,
          resolved,
          attemptFor(
            batch,
            resolved.recipientId,
            resolved.endpoint.id,
            attemptId,
            1,
            batch.createdAt,
          ),
        );
      });
      return Object.freeze({
        items: Object.freeze(items),
        nextCursor: page.nextCursor,
      });
    },

    async resolveRetry(attemptId) {
      const [schedule] = await database
        .select()
        .from(expoPushRetrySchedules)
        .where(eq(expoPushRetrySchedules.nextAttemptId, attemptId))
        .limit(1);
      if (schedule === undefined) {
        throw new ExpoPushRuntimeStoreError('RETRY_NOT_FOUND');
      }
      const now = Date.now();
      if (now >= schedule.expiresAt.getTime()) {
        return Object.freeze({ kind: 'expired' as const });
      }
      if (now < schedule.retryAt.getTime()) {
        return Object.freeze({
          kind: 'not-before' as const,
          retryAt: iso(schedule.retryAt),
        });
      }
      const [source] = await database
        .select()
        .from(channelAttempts)
        .where(eq(channelAttempts.id, schedule.sourceAttemptId))
        .limit(1);
      if (source === undefined) {
        throw new ExpoPushRuntimeStoreError('RETRY_NOT_FOUND');
      }
      const batch = await persistedBatch(database, source.batchId);
      const endpoints = await resolvedPushEndpoints(database, batch);
      const endpoint = endpoints.find(
        (candidate) =>
          candidate.recipientId === source.recipientId &&
          candidate.endpoint.id === source.endpointId,
      );
      if (endpoint === undefined) {
        return Object.freeze({ kind: 'ineligible' as const });
      }
      return Object.freeze({
        kind: 'ready' as const,
        workItem: workItemFor(
          batch,
          endpoint,
          attemptFor(
            batch,
            source.recipientId,
            source.endpointId,
            schedule.nextAttemptId,
            schedule.nextAttemptNumber,
            iso(schedule.retryAt),
          ),
        ),
      });
    },
  };
  return Object.freeze(store);
}
