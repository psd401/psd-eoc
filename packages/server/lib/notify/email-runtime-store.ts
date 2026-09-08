import { createHash } from 'node:crypto';

import {
  AttemptExecutionCompletionSchema,
  DispatchBatchSchema,
  EmailBatchResolutionPageSchema,
  EmailRetryResolutionSchema,
  EmailWorkerAttemptWorkItemSchema,
  NotificationOutboxMessageSchema,
  ProviderSendOutcomeSchema,
  SesSendLedgerClaimSchema,
  type ChannelAttempt,
  type DispatchBatch,
  type EmailRuntimeRequest,
  type EmailWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  channelAttemptExecutions,
  channelAttempts,
  channelConfigurations,
  dispatchBatches,
  events,
  outbox,
  sesEmailProviderIo,
} from '../../db/schema';
import { loadRosterSnapshot } from '../capabilities/start';
import { batchHasCurrentLifecycle } from './batch-lifecycle';
import {
  createDrizzleEmailEndpointPolicyStore,
  resolveEmailEndpoints,
} from './dispatcher';
import { lockEmailEndpointPolicy } from './email-endpoint-policy-lock';

export const EMAIL_WORKER_ENABLED_ENV = 'PSD_EOC_EMAIL_WORKER_ENABLED' as const;
export const EMAIL_SEND_HORIZON_MILLISECONDS = 15 * 60_000;

/**
 * One page of an ordinary activation. Matches the SMS page size and stays
 * inside the 100-item bound the resolution page contract allows.
 */
const EMAIL_PAGE_SIZE = 50;

export interface EmailRuntimeDeploymentAuthorization {
  readonly workerEnabled: boolean;
}

export interface DrizzleEmailRuntimeStoreOptions {
  readonly deploymentAuthorization?: EmailRuntimeDeploymentAuthorization;
  readonly sendHorizonMilliseconds?: number;
}

export type EmailRuntimeStoreErrorCode =
  | 'BATCH_CONFLICT'
  | 'BATCH_NOT_FOUND'
  | 'PROVIDER_IO_COMPLETION_CONFLICT'
  | 'PROVIDER_IO_CONFLICT'
  | 'RETRY_NOT_FOUND';

export class EmailRuntimeStoreError extends Error {
  public constructor(
    public readonly code: EmailRuntimeStoreErrorCode,
    /**
     * Which refusal this is, for the log only.
     *
     * `BATCH_CONFLICT` is raised at seven places that mean seven different
     * things, and the code is all the worker receives. This never leaves the
     * server: the HTTP response still carries the code alone.
     */
    public readonly detail: string | null = null,
  ) {
    super('Email runtime state could not be handled safely.');
    this.name = 'EmailRuntimeStoreError';
  }
}

type ClaimRequest = Extract<
  EmailRuntimeRequest,
  { operation: 'claim-provider-io' }
>;
type CompleteRequest = Extract<
  EmailRuntimeRequest,
  { operation: 'complete-provider-io' }
>;
type ResolveBatchRequest = Extract<
  EmailRuntimeRequest,
  { operation: 'resolve-batch' }
>;

export interface EmailRuntimeStore {
  claimProviderIo(input: ClaimRequest): Promise<unknown>;
  completeProviderIo(input: CompleteRequest): Promise<void>;
  resolveBatch(input: ResolveBatchRequest): Promise<unknown>;
  resolveRetry(sourceAttemptId: string): Promise<unknown>;
  authorizeProviderSend(workItem: EmailWorkerAttemptWorkItem): Promise<boolean>;
}

function iso(value: Date): string {
  return value.toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
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

/**
 * What must hold for this store to send any email at all.
 *
 * A human confirmed the consequence, the integration is the verified SES one,
 * and the batch is an email batch. Nothing here describes what kind of event
 * it is: a real incident sends email for the same reasons a drill does.
 *
 * Both human confirmations count. An activation carries `human-confirmed`; an
 * all-clear or a reactivation carries `human-confirmed-lifecycle`, which pins
 * its own lifecycle preview and confirmed action set and is no weaker. Reading
 * only the activation kind refused every all-clear ever queued: the batch was
 * rejected on arrival, retried until the queue's redrive policy gave up, and
 * dead-lettered, so staff were told an incident had started and never told it
 * had ended. Push has no equivalent gate and sent those all the while, which is
 * how the two channels came to disagree.
 */
export function assertEmailBatch(batch: DispatchBatch): void {
  if (
    batch.channel !== 'email' ||
    (batch.authorization.kind !== 'human-confirmed' &&
      batch.authorization.kind !== 'human-confirmed-lifecycle') ||
    batch.integrationId !== 'ses-email'
  ) {
    throw new EmailRuntimeStoreError(
      'BATCH_CONFLICT',
      'not-a-sendable-email-batch',
    );
  }
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
    throw new EmailRuntimeStoreError('BATCH_NOT_FOUND');
  }
  const message = NotificationOutboxMessageSchema.parse(record.message);
  const planned = message.channels.find(
    (candidate) => candidate.channel === record.batch.channel,
  );
  if (planned === undefined) {
    throw new EmailRuntimeStoreError(
      'BATCH_CONFLICT',
      'no-planned-channel-in-outbox-message',
    );
  }
  const batch = DispatchBatchSchema.parse({
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
  assertEmailBatch(batch);
  return batch;
}

async function pinnedRoster(database: Database, batch: DispatchBatch) {
  const roster = await loadRosterSnapshot(
    database as unknown as Parameters<typeof loadRosterSnapshot>[0],
    'staff',
    batch.facilityId,
    batch.rosterSnapshotId,
  );
  if (roster === null) {
    throw new EmailRuntimeStoreError(
      'BATCH_CONFLICT',
      'pinned-roster-snapshot-unavailable',
    );
  }
  return roster;
}

async function resolveCurrentEndpoints(
  database: Database,
  batch: DispatchBatch,
  roster?: Awaited<ReturnType<typeof pinnedRoster>>,
) {
  const snapshot = roster ?? (await pinnedRoster(database, batch));
  return resolveEmailEndpoints(
    {
      batch,
      audience: { facilityId: batch.facilityId, rosterSnapshot: snapshot },
    },
    createDrizzleEmailEndpointPolicyStore(database),
  );
}

/**
 * Every email recipient the pinned snapshot names, in one fixed order.
 *
 * The cursor indexes this list rather than the eligible endpoints, because
 * eligibility is read fresh on every page: an address suppressed between page
 * one and page two would otherwise shift every later index and silently skip
 * somebody. The snapshot is immutable, so this ordering cannot move.
 */
function stableEmailCandidateReferences(
  roster: Awaited<ReturnType<typeof pinnedRoster>>,
): readonly Readonly<{ recipientId: string; endpointId: string }>[] {
  return Object.freeze(
    roster.recipients.flatMap((recipient) =>
      recipient.endpoints.flatMap((endpoint) =>
        endpoint.channel === 'email' && endpoint.status === 'active'
          ? [
              Object.freeze({
                recipientId: recipient.id,
                endpointId: endpoint.id,
              }),
            ]
          : [],
      ),
    ),
  );
}

function attemptFor(
  batch: DispatchBatch,
  recipientId: string,
  endpointId: string,
  attemptNumber: number,
  attemptedAt: string,
): ChannelAttempt {
  return {
    id: deterministicAttemptId(batch.id, endpointId, attemptNumber),
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
    channel: 'email',
    attemptNumber,
    attemptedAt,
  };
}

function workItemFor(
  batch: DispatchBatch,
  resolved: Awaited<ReturnType<typeof resolveCurrentEndpoints>>[number],
  attemptNumber: number,
  attemptedAt: string,
): EmailWorkerAttemptWorkItem {
  return EmailWorkerAttemptWorkItemSchema.parse({
    batch,
    attempt: attemptFor(
      batch,
      resolved.recipientId,
      resolved.endpoint.id,
      attemptNumber,
      attemptedAt,
    ),
    endpoint: resolved.endpoint,
  });
}

export function readEmailRuntimeDeploymentAuthorization(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EmailRuntimeDeploymentAuthorization {
  return Object.freeze({
    workerEnabled: environment[EMAIL_WORKER_ENABLED_ENV] === 'true',
  });
}

async function channelIsLive(
  database: Database,
  deployment: EmailRuntimeDeploymentAuthorization,
  lock: boolean,
): Promise<boolean> {
  if (!deployment.workerEnabled) {
    return false;
  }
  // Enablement alone, matching SMS. The three truth-label conditions that used
  // to sit here are hand-maintained state that can only disagree with reality,
  // and disagreeing silently refuses to send.
  const [row] = await database
    .select({ enabled: channelConfigurations.enabled })
    .from(channelConfigurations)
    .where(eq(channelConfigurations.integrationId, 'ses-email'))
    .limit(1)
    .for(lock ? 'share' : 'no key update');
  return row?.enabled === true;
}

async function databaseNow(database: Database): Promise<Date> {
  const [row] = await database
    .select({ value: sql<Date | string>`runtime_clock.value` })
    .from(sql`(select clock_timestamp() as value) as runtime_clock`)
    .limit(1);
  if (row === undefined) {
    throw new EmailRuntimeStoreError(
      'BATCH_CONFLICT',
      'database-clock-unreadable',
    );
  }
  const value = row.value instanceof Date ? row.value : new Date(row.value);
  if (!Number.isFinite(value.getTime())) {
    throw new EmailRuntimeStoreError(
      'BATCH_CONFLICT',
      'database-clock-not-a-time',
    );
  }
  return value;
}

async function expectedWorkItem(
  database: Database,
  supplied: EmailWorkerAttemptWorkItem,
  now: Date,
): Promise<EmailWorkerAttemptWorkItem | null> {
  const endpoints = await resolveCurrentEndpoints(database, supplied.batch);
  // Find the endpoint this work item is for, rather than requiring the batch
  // to have exactly one. Requiring one meant an activation to more than a
  // single address failed authorization for every recipient in it.
  const resolved = endpoints.find(
    (candidate) =>
      candidate.recipientId === supplied.attempt.recipientId &&
      candidate.endpoint.id === supplied.endpoint.id,
  );
  if (
    resolved === undefined ||
    !sameJson(resolved.endpoint, supplied.endpoint)
  ) {
    return null;
  }

  let attemptedAt = supplied.batch.createdAt;
  for (
    let attemptNumber = 1;
    attemptNumber < supplied.attempt.attemptNumber;
    attemptNumber += 1
  ) {
    const attemptId = deterministicAttemptId(
      supplied.batch.id,
      supplied.endpoint.id,
      attemptNumber,
    );
    const [record] = await database
      .select({
        attempt: channelAttempts,
        completion: channelAttemptExecutions.completion,
      })
      .from(channelAttempts)
      .innerJoin(
        channelAttemptExecutions,
        eq(channelAttempts.id, channelAttemptExecutions.attemptId),
      )
      .where(eq(channelAttempts.id, attemptId))
      .limit(1);
    if (record === undefined) return null;
    const expectedAttempt = attemptFor(
      supplied.batch,
      resolved.recipientId,
      resolved.endpoint.id,
      attemptNumber,
      attemptedAt,
    );
    const completion = AttemptExecutionCompletionSchema.safeParse(
      record.completion,
    );
    if (
      !sameJson(expectedAttempt, {
        id: record.attempt.id,
        batchId: record.attempt.batchId,
        intentId: record.attempt.intentId,
        eventId: record.attempt.eventId,
        eventKind: record.attempt.eventKind,
        templateMode: record.attempt.templateMode,
        purpose: record.attempt.purpose,
        attemptedAt: iso(record.attempt.attemptedAt),
        eventTypeVersion: {
          id: record.attempt.eventTypeVersionId,
          templateMode: record.attempt.templateMode,
        },
        rosterSnapshotId: record.attempt.rosterSnapshotId,
        rosterPopulation: record.attempt.rosterPopulation,
        recipientId: record.attempt.recipientId,
        endpointId: record.attempt.endpointId,
        channel: record.attempt.channel,
        attemptNumber: record.attempt.attemptNumber,
      }) ||
      !completion.success ||
      completion.data.kind !== 'retry' ||
      completion.data.nextAttemptNumber !== attemptNumber + 1 ||
      completion.data.nextAttemptNumber > 5
    ) {
      return null;
    }
    attemptedAt = iso(
      new Date(Date.parse(attemptedAt) + completion.data.delayMilliseconds),
    );
  }
  if (now.getTime() < Date.parse(attemptedAt)) return null;
  return workItemFor(
    supplied.batch,
    resolved,
    supplied.attempt.attemptNumber,
    attemptedAt,
  );
}

async function workItemIsEligible(
  database: Database,
  suppliedValue: EmailWorkerAttemptWorkItem,
  deployment: EmailRuntimeDeploymentAuthorization,
  sendHorizonMilliseconds: number,
  lock: boolean,
): Promise<boolean> {
  const supplied = EmailWorkerAttemptWorkItemSchema.parse(suppliedValue);
  if (supplied.endpoint.channel !== 'email') return false;
  const batch = await persistedBatch(database, supplied.batch.id);
  const now = await databaseNow(database);
  if (
    !sameJson(batch, supplied.batch) ||
    now.getTime() > Date.parse(batch.createdAt) + sendHorizonMilliseconds ||
    !(await channelIsLive(database, deployment, lock)) ||
    !(await batchHasCurrentLifecycle(
      database,
      batch,
      lock ? 'share' : 'no key update',
    ))
  ) {
    return false;
  }
  if (lock) {
    await lockEmailEndpointPolicy(database, supplied.endpoint.email);
  }
  const expected = await expectedWorkItem(database, supplied, now);
  return expected !== null && sameJson(expected, supplied);
}

export function createDrizzleEmailRuntimeStore(
  database: Database,
  options: DrizzleEmailRuntimeStoreOptions = {},
): EmailRuntimeStore {
  const deployment =
    options.deploymentAuthorization ??
    readEmailRuntimeDeploymentAuthorization();
  const sendHorizonMilliseconds =
    options.sendHorizonMilliseconds ?? EMAIL_SEND_HORIZON_MILLISECONDS;
  if (
    !Number.isInteger(sendHorizonMilliseconds) ||
    sendHorizonMilliseconds < 60_000 ||
    sendHorizonMilliseconds > 60 * 60_000
  ) {
    throw new TypeError('The email send horizon is invalid.');
  }
  const store: EmailRuntimeStore = {
    async claimProviderIo(input) {
      return database.transaction(async (transaction) => {
        if (input.attemptId !== input.workItem.attempt.id) {
          return SesSendLedgerClaimSchema.parse({ kind: 'denied' });
        }
        const [retained] = await transaction
          .select()
          .from(sesEmailProviderIo)
          .where(eq(sesEmailProviderIo.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        if (retained !== undefined) {
          if (retained.requestFingerprint !== input.requestFingerprint) {
            return SesSendLedgerClaimSchema.parse({ kind: 'conflict' });
          }
          return retained.outcome === null
            ? SesSendLedgerClaimSchema.parse({ kind: 'in-progress' })
            : SesSendLedgerClaimSchema.parse({
                kind: 'completed',
                outcome: ProviderSendOutcomeSchema.parse(retained.outcome),
              });
        }
        if (
          !(await workItemIsEligible(
            transaction as Database,
            input.workItem,
            deployment,
            sendHorizonMilliseconds,
            true,
          ))
        ) {
          return SesSendLedgerClaimSchema.parse({ kind: 'denied' });
        }
        const [inserted] = await transaction
          .insert(sesEmailProviderIo)
          .values({
            attemptId: input.attemptId,
            requestFingerprint: input.requestFingerprint,
          })
          .onConflictDoNothing({ target: sesEmailProviderIo.attemptId })
          .returning();
        if (inserted !== undefined) {
          return SesSendLedgerClaimSchema.parse({
            kind: 'acquired',
            leaseToken: inserted.claimToken,
          });
        }
        const [existing] = await transaction
          .select()
          .from(sesEmailProviderIo)
          .where(eq(sesEmailProviderIo.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        if (existing === undefined) {
          throw new EmailRuntimeStoreError('PROVIDER_IO_CONFLICT');
        }
        if (existing.requestFingerprint !== input.requestFingerprint) {
          return SesSendLedgerClaimSchema.parse({ kind: 'conflict' });
        }
        return existing.outcome === null
          ? SesSendLedgerClaimSchema.parse({ kind: 'in-progress' })
          : SesSendLedgerClaimSchema.parse({
              kind: 'completed',
              outcome: ProviderSendOutcomeSchema.parse(existing.outcome),
            });
      });
    },

    async completeProviderIo(input) {
      const outcome = ProviderSendOutcomeSchema.parse(input.outcome);
      await database.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(sesEmailProviderIo)
          .where(eq(sesEmailProviderIo.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        if (existing === undefined) {
          throw new EmailRuntimeStoreError('PROVIDER_IO_COMPLETION_CONFLICT');
        }
        if (
          existing.requestFingerprint !== input.requestFingerprint ||
          existing.claimToken !== input.leaseToken
        ) {
          throw new EmailRuntimeStoreError('PROVIDER_IO_COMPLETION_CONFLICT');
        }
        if (existing.outcome !== null) {
          if (
            !sameJson(
              ProviderSendOutcomeSchema.parse(existing.outcome),
              outcome,
            )
          ) {
            throw new EmailRuntimeStoreError('PROVIDER_IO_COMPLETION_CONFLICT');
          }
          return;
        }
        const updated = await transaction
          .update(sesEmailProviderIo)
          .set({ outcome, completedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(sesEmailProviderIo.attemptId, input.attemptId),
              eq(
                sesEmailProviderIo.requestFingerprint,
                input.requestFingerprint,
              ),
              eq(sesEmailProviderIo.claimToken, input.leaseToken),
              isNull(sesEmailProviderIo.outcome),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new EmailRuntimeStoreError('PROVIDER_IO_COMPLETION_CONFLICT');
        }
      });
    },

    async resolveBatch(input) {
      const batch = await persistedBatch(database, input.batch.id);
      // Four separate reasons to refuse, each meaning something different to
      // whoever has to act on it: a resumed cursor, a queued batch that no
      // longer matches what is stored, a deployment authorization that has
      // moved on, and a message older than the batch it names.
      if (!sameJson(batch, input.batch)) {
        throw new EmailRuntimeStoreError(
          'BATCH_CONFLICT',
          'queued-batch-differs-from-stored',
        );
      }
      if (!deployment.workerEnabled) {
        throw new EmailRuntimeStoreError('BATCH_CONFLICT', 'worker-disabled');
      }
      if (Date.parse(input.enqueuedAt) < Date.parse(batch.createdAt)) {
        throw new EmailRuntimeStoreError(
          'BATCH_CONFLICT',
          'message-older-than-its-batch',
        );
      }
      const roster = await pinnedRoster(database, batch);
      const endpoints = await resolveCurrentEndpoints(database, batch, roster);
      const now = await databaseNow(database);
      if (
        now.getTime() > Date.parse(batch.createdAt) + sendHorizonMilliseconds ||
        !(await batchHasCurrentLifecycle(database, batch, 'no key update')) ||
        !(await channelIsLive(database, deployment, false))
      ) {
        return EmailBatchResolutionPageSchema.parse({
          items: [],
          nextCursor: null,
          suppressedCount: 1,
        });
      }
      // An ordinary activation reaches everyone the snapshot names. Before
      // this it reached nobody unless the audience happened to be exactly one
      // address: a second recipient made the whole send resolve to zero items
      // and report itself as suppressed, with no failed attempt to notice.
      const candidates = stableEmailCandidateReferences(roster);
      if (input.cursor > candidates.length) {
        throw new EmailRuntimeStoreError('BATCH_CONFLICT', 'cursor-past-end');
      }
      const page = candidates.slice(
        input.cursor,
        input.cursor + EMAIL_PAGE_SIZE,
      );
      const eligible = new Map(
        endpoints.map((resolved) => [
          `${resolved.recipientId}:${resolved.endpoint.id}`,
          resolved,
        ]),
      );
      const items = page.flatMap((candidate) => {
        const resolved = eligible.get(
          `${candidate.recipientId}:${candidate.endpointId}`,
        );
        return resolved === undefined
          ? []
          : [workItemFor(batch, resolved, 1, batch.createdAt)];
      });
      const nextCursor =
        input.cursor + page.length < candidates.length
          ? input.cursor + page.length
          : null;
      return EmailBatchResolutionPageSchema.parse({
        items,
        nextCursor,
        suppressedCount: page.length - items.length,
      });
    },

    async resolveRetry(sourceAttemptId) {
      const [record] = await database
        .select({
          attempt: channelAttempts,
          completion: channelAttemptExecutions.completion,
        })
        .from(channelAttempts)
        .innerJoin(
          channelAttemptExecutions,
          eq(channelAttempts.id, channelAttemptExecutions.attemptId),
        )
        .where(eq(channelAttempts.id, sourceAttemptId))
        .limit(1);
      if (record === undefined || record.attempt.channel !== 'email') {
        throw new EmailRuntimeStoreError('RETRY_NOT_FOUND');
      }
      const completion = AttemptExecutionCompletionSchema.parse(
        record.completion,
      );
      if (completion.kind !== 'retry') {
        return EmailRetryResolutionSchema.parse({ kind: 'expired' });
      }
      if (
        completion.nextAttemptNumber !== record.attempt.attemptNumber + 1 ||
        completion.nextAttemptNumber > 5
      ) {
        return EmailRetryResolutionSchema.parse({ kind: 'expired' });
      }
      const batch = await persistedBatch(database, record.attempt.batchId);
      if (!deployment.workerEnabled) {
        return EmailRetryResolutionSchema.parse({ kind: 'ineligible' });
      }
      const retryAt = new Date(
        record.attempt.attemptedAt.getTime() + completion.delayMilliseconds,
      );
      if ((await databaseNow(database)).getTime() < retryAt.getTime()) {
        return EmailRetryResolutionSchema.parse({
          kind: 'not-before',
          retryAt: iso(retryAt),
        });
      }
      const endpoints = await resolveCurrentEndpoints(database, batch);
      const endpoint = endpoints.find(
        (candidate) =>
          candidate.recipientId === record.attempt.recipientId &&
          candidate.endpoint.id === record.attempt.endpointId,
      );
      if (endpoint === undefined) {
        return EmailRetryResolutionSchema.parse({ kind: 'ineligible' });
      }
      const workItem = workItemFor(
        batch,
        endpoint,
        completion.nextAttemptNumber,
        iso(retryAt),
      );
      if (
        !(await workItemIsEligible(
          database,
          workItem,
          deployment,
          sendHorizonMilliseconds,
          false,
        ))
      ) {
        return EmailRetryResolutionSchema.parse({ kind: 'ineligible' });
      }
      return EmailRetryResolutionSchema.parse({ kind: 'ready', workItem });
    },

    async authorizeProviderSend(workItem) {
      try {
        const parsed = EmailWorkerAttemptWorkItemSchema.parse(workItem);
        return await workItemIsEligible(
          database,
          parsed,
          deployment,
          sendHorizonMilliseconds,
          false,
        );
      } catch {
        return false;
      }
    },
  };
  return Object.freeze(store);
}
