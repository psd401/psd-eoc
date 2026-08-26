import { createHash } from 'node:crypto';

import {
  AttemptExecutionCompletionSchema,
  DispatchBatchSchema,
  EmailBatchResolutionPageSchema,
  EmailRetryResolutionSchema,
  EmailWorkerAttemptWorkItemSchema,
  NotificationOutboxMessageSchema,
  ProviderSendOutcomeSchema,
  SesVerificationReferenceSchema,
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
  integrationStatuses,
  outbox,
  sesEmailProviderIo,
} from '../../db/schema';
import { loadRosterSnapshot } from '../capabilities/start';
import {
  createDrizzleEmailEndpointPolicyStore,
  resolveEmailEndpoints,
} from './dispatcher';
import { lockEmailEndpointPolicy } from './email-endpoint-policy-lock';

export const EMAIL_WORKER_ENABLED_ENV = 'PSD_EOC_EMAIL_WORKER_ENABLED' as const;
export const SES_VERIFICATION_REFERENCE_ENV =
  'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE' as const;
export const EMAIL_SEND_HORIZON_MILLISECONDS = 15 * 60_000;

export interface EmailRuntimeDeploymentAuthorization {
  readonly workerEnabled: boolean;
  readonly verificationReference: string | null;
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
  public constructor(public readonly code: EmailRuntimeStoreErrorCode) {
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

function assertControlledEmailBatch(batch: DispatchBatch): void {
  if (
    batch.channel !== 'email' ||
    batch.eventKind !== 'drill' ||
    batch.templateMode !== 'drill' ||
    batch.purpose !== 'activation' ||
    batch.rosterPopulation !== 'staff' ||
    batch.endpointCount !== 1 ||
    batch.deliveryTest == null ||
    batch.authorization.kind !== 'human-confirmed' ||
    batch.integrationStatus.integrationId !== 'ses-email' ||
    batch.integrationStatus.label !== 'live-verified'
  ) {
    throw new EmailRuntimeStoreError('BATCH_CONFLICT');
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
    throw new EmailRuntimeStoreError('BATCH_CONFLICT');
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
    deliveryTest: message.deliveryTest,
    requestId: record.batch.requestId,
    authorization: record.batch.authorization,
    channel: record.batch.channel,
    renderedMessage: record.batch.renderedMessage,
    integrationStatus: planned.integrationStatus,
    sequence: record.batch.sequence,
    endpointCount: record.batch.endpointCount,
    createdAt: iso(record.batch.createdAt),
  });
  assertControlledEmailBatch(batch);
  return batch;
}

async function resolveCurrentEndpoints(
  database: Database,
  batch: DispatchBatch,
) {
  const roster = await loadRosterSnapshot(
    database as unknown as Parameters<typeof loadRosterSnapshot>[0],
    'staff',
    batch.facilityId,
    batch.rosterSnapshotId,
  );
  if (roster === null) {
    throw new EmailRuntimeStoreError('BATCH_CONFLICT');
  }
  return resolveEmailEndpoints(
    {
      batch,
      audience: { facilityId: batch.facilityId, rosterSnapshot: roster },
    },
    createDrizzleEmailEndpointPolicyStore(database),
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
    deliveryTest: batch.deliveryTest!,
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

function validVerificationReference(value: string | undefined): string | null {
  const parsed = SesVerificationReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Exact immutable batch-to-deployment binding used by resolution and claims. */
export function emailBatchMatchesDeploymentAuthorization(
  batch: DispatchBatch,
  deployment: EmailRuntimeDeploymentAuthorization,
): boolean {
  return (
    deployment.workerEnabled &&
    deployment.verificationReference !== null &&
    batch.integrationStatus.authorizationReference ===
      deployment.verificationReference
  );
}

export function readEmailRuntimeDeploymentAuthorization(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EmailRuntimeDeploymentAuthorization {
  return Object.freeze({
    workerEnabled: environment[EMAIL_WORKER_ENABLED_ENV] === 'true',
    verificationReference: validVerificationReference(
      environment[SES_VERIFICATION_REFERENCE_ENV],
    ),
  });
}

async function channelIsLive(
  database: Database,
  deployment: EmailRuntimeDeploymentAuthorization,
  lock: boolean,
): Promise<boolean> {
  if (!deployment.workerEnabled || deployment.verificationReference === null) {
    return false;
  }
  const [row] = await database
    .select({
      enabled: channelConfigurations.enabled,
      statusLabel: channelConfigurations.statusLabel,
      integrationLabel: integrationStatuses.label,
      authorizationReference: integrationStatuses.authorizationReference,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      eq(channelConfigurations.statusId, integrationStatuses.id),
    )
    .where(eq(channelConfigurations.integrationId, 'ses-email'))
    .limit(1)
    .for(lock ? 'share' : 'no key update');
  return (
    row?.enabled === true &&
    row.statusLabel === 'live-verified' &&
    row.integrationLabel === 'live-verified' &&
    row.authorizationReference === deployment.verificationReference
  );
}

async function databaseNow(database: Database): Promise<Date> {
  const [row] = await database
    .select({ value: sql<Date | string>`runtime_clock.value` })
    .from(sql`(select clock_timestamp() as value) as runtime_clock`)
    .limit(1);
  if (row === undefined) throw new EmailRuntimeStoreError('BATCH_CONFLICT');
  const value = row.value instanceof Date ? row.value : new Date(row.value);
  if (!Number.isFinite(value.getTime())) {
    throw new EmailRuntimeStoreError('BATCH_CONFLICT');
  }
  return value;
}

async function activeEvent(
  database: Database,
  eventId: string,
  lock: boolean,
): Promise<boolean> {
  const [event] = await database
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1)
    .for(lock ? 'share' : 'no key update');
  return event?.status === 'active';
}

async function expectedWorkItem(
  database: Database,
  supplied: EmailWorkerAttemptWorkItem,
  now: Date,
): Promise<EmailWorkerAttemptWorkItem | null> {
  const endpoints = await resolveCurrentEndpoints(database, supplied.batch);
  const resolved = endpoints[0];
  if (
    endpoints.length !== 1 ||
    resolved === undefined ||
    resolved.recipientId !== supplied.attempt.recipientId ||
    resolved.endpoint.id !== supplied.endpoint.id ||
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
        deliveryTest: supplied.batch.deliveryTest,
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
  if (!emailBatchMatchesDeploymentAuthorization(supplied.batch, deployment)) {
    return false;
  }
  const batch = await persistedBatch(database, supplied.batch.id);
  const now = await databaseNow(database);
  if (
    !sameJson(batch, supplied.batch) ||
    !emailBatchMatchesDeploymentAuthorization(batch, deployment) ||
    now.getTime() > Date.parse(batch.createdAt) + sendHorizonMilliseconds ||
    !(await channelIsLive(database, deployment, lock)) ||
    !(await activeEvent(database, batch.eventId, lock))
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
      if (
        input.cursor !== 0 ||
        !sameJson(batch, input.batch) ||
        !emailBatchMatchesDeploymentAuthorization(batch, deployment) ||
        Date.parse(input.enqueuedAt) < Date.parse(batch.createdAt)
      ) {
        throw new EmailRuntimeStoreError('BATCH_CONFLICT');
      }
      const endpoints = await resolveCurrentEndpoints(database, batch);
      const now = await databaseNow(database);
      if (
        now.getTime() > Date.parse(batch.createdAt) + sendHorizonMilliseconds ||
        !(await activeEvent(database, batch.eventId, false)) ||
        !(await channelIsLive(database, deployment, false))
      ) {
        return EmailBatchResolutionPageSchema.parse({
          items: [],
          nextCursor: null,
          suppressedCount: 1,
        });
      }
      if (endpoints.length !== 1) {
        return EmailBatchResolutionPageSchema.parse({
          items: [],
          nextCursor: null,
          suppressedCount: 1,
        });
      }
      return EmailBatchResolutionPageSchema.parse({
        items: [workItemFor(batch, endpoints[0]!, 1, batch.createdAt)],
        nextCursor: null,
        suppressedCount: 0,
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
      if (!emailBatchMatchesDeploymentAuthorization(batch, deployment)) {
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
