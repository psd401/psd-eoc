import { createHash } from 'node:crypto';

import {
  ChannelAttemptSchema,
  DispatchBatchSchema,
  NotificationOutboxMessageSchema,
  SMS_PROVIDER_MINIMUM_TTL_SECONDS,
  SMS_TOTAL_LIFETIME_SECONDS,
  SmsProviderIoCompletionSchema,
  SmsWorkerAttemptWorkItemSchema,
  type ChannelAttempt,
  type CurrentRosterSnapshot,
  type DispatchBatch,
  type SmsRuntimeRequest,
  type SmsProviderSendAuthorization,
  type SmsWorkerAttemptWorkItem,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';

import { databaseExecuteRows, type Database } from '../../db/client';
import {
  channelAttempts,
  channelConfigurations,
  deliveryEvidence,
  dispatchBatches,
  events,
  outbox,
  rosterSnapshots,
  smsProviderIo,
  smsRetrySchedules,
} from '../../db/schema';
import { loadRosterSnapshot } from '../capabilities/start';
import { resolveAudience } from '../roster/resolve';
import { batchHasCurrentLifecycle } from './batch-lifecycle';
import {
  createDrizzleSmsPolicyStore,
  executeRecordSmsOptOutCapability,
  resolveSmsEndpoints,
} from './sms-policy';

const SMS_PAGE_SIZE = 50;
const SMS_INTEGRATION_ID = 'aws-eum-sms' as const;

export type SmsRuntimeStoreErrorCode =
  | 'ATTEMPT_CONFLICT'
  | 'ATTEMPT_NOT_FOUND'
  | 'BATCH_CONFLICT'
  | 'BATCH_NOT_FOUND'
  | 'PROVIDER_IO_COMPLETION_CONFLICT'
  | 'PROVIDER_IO_CONFLICT'
  | 'RETRY_CONFLICT'
  | 'RETRY_NOT_FOUND'
  | 'RETRY_SOURCE_CONFLICT';

export class SmsRuntimeStoreError extends Error {
  public constructor(public readonly code: SmsRuntimeStoreErrorCode) {
    super('SMS runtime state could not be handled safely.');
    this.name = 'SmsRuntimeStoreError';
  }
}

export type SmsProviderIoLookupResult =
  | Readonly<{ kind: 'missing' | 'indeterminate' }>
  | Readonly<{
      kind: 'completed';
      completion: ReturnType<typeof SmsProviderIoCompletionSchema.parse>;
    }>;

export type SmsProviderIoClaimResult =
  | Readonly<{ kind: 'acquired'; claimToken: string }>
  | Exclude<SmsProviderIoLookupResult, Readonly<{ kind: 'missing' }>>;

export type SmsRetryScheduleResult =
  | Readonly<{
      kind: 'scheduled';
      attemptId: string;
      retryAt: string;
    }>
  | Readonly<{ kind: 'expired' }>;

export type SmsRetryResolution =
  | Readonly<{ kind: 'ready'; workItem: SmsWorkerAttemptWorkItem }>
  | Readonly<{ kind: 'not-before'; retryAt: string }>
  | Readonly<{ kind: 'expired' | 'ineligible' }>;

export type SmsBatchResolutionPage =
  | Readonly<{
      kind: 'ready';
      readonly items: readonly SmsWorkerAttemptWorkItem[];
      readonly nextCursor: number | null;
    }>
  | Readonly<{ kind: 'expired' }>;

export interface SmsRuntimeStore {
  lookupProviderIo(input: {
    attemptId: string;
    workFingerprint: string;
  }): Promise<SmsProviderIoLookupResult>;
  claimProviderIo(input: {
    attemptId: string;
    workFingerprint: string;
  }): Promise<SmsProviderIoClaimResult>;
  completeProviderIo(input: {
    attemptId: string;
    workFingerprint: string;
    claimToken: string;
    completion: unknown;
  }): Promise<void>;
  scheduleRetry(
    input: Extract<SmsRuntimeRequest, { operation: 'schedule-retry' }>,
  ): Promise<SmsRetryScheduleResult>;
  resolveBatch(
    input: Extract<SmsRuntimeRequest, { operation: 'resolve-batch' }>,
  ): Promise<SmsBatchResolutionPage>;
  resolveRetry(attemptId: string): Promise<SmsRetryResolution>;
  authorizeProviderSend(
    workItem: SmsWorkerAttemptWorkItem,
  ): Promise<SmsProviderSendAuthorization>;
  executeLifecycle(
    input: Extract<SmsRuntimeRequest, { operation: 'record-sms-opt-out' }>,
  ): Promise<unknown>;
  resolveSmsDestination(input: {
    rosterSnapshotId: string;
    phoneNumber: string;
  }): Promise<Readonly<{
    rosterSnapshotId: string;
    recipientId: string;
    endpointId: string;
  }> | null>;
  loadAttemptByProviderReference(
    providerReference: string,
  ): Promise<ChannelAttempt | null>;
  loadUnknownAttempt(
    attemptId: string,
    correlationToken: string,
  ): Promise<ChannelAttempt | null>;
  listCurrentRosterSnapshots(): Promise<readonly CurrentRosterSnapshot[]>;
}

export interface SmsRuntimeStoreConfiguration {
  readonly destinationCountryCode: CountryCode;
  readonly now?: () => number;
}

export function readSmsRuntimeStoreConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SmsRuntimeStoreConfiguration {
  const destinationCountryCode =
    environment.PSD_EOC_SMS_DESTINATION_COUNTRY_CODE;
  if (
    destinationCountryCode === undefined ||
    !/^[A-Z]{2}$/u.test(destinationCountryCode)
  ) {
    throw new Error('The SMS runtime store configuration is unsafe.');
  }
  try {
    getCountryCallingCode(destinationCountryCode as CountryCode);
  } catch {
    throw new Error('The SMS destination country is unsupported.');
  }
  return Object.freeze({
    destinationCountryCode: destinationCountryCode as CountryCode,
  });
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
  if (record === undefined) throw new SmsRuntimeStoreError('BATCH_NOT_FOUND');
  const message = NotificationOutboxMessageSchema.parse(record.message);
  const planned = message.channels.find(
    (candidate) => candidate.channel === record.batch.channel,
  );
  if (planned === undefined) throw new SmsRuntimeStoreError('BATCH_CONFLICT');
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

async function resolvedSmsEndpoints(database: Database, batch: DispatchBatch) {
  const roster = await loadRosterSnapshot(
    database as unknown as Parameters<typeof loadRosterSnapshot>[0],
    batch.rosterPopulation,
    batch.facilityId,
    batch.rosterSnapshotId,
  );
  if (roster === null) throw new SmsRuntimeStoreError('BATCH_CONFLICT');
  const endpoints = await resolveSmsEndpoints(
    {
      batch,
      audience: { facilityId: batch.facilityId, rosterSnapshot: roster },
    },
    createDrizzleSmsPolicyStore(database),
  );
  return Object.freeze({ roster, endpoints });
}

type SmsCandidateReference = Readonly<{
  recipientId: string;
  endpointId: string;
}>;

async function stableSmsCandidateReferences(
  database: Database,
  batch: DispatchBatch,
  roster: Awaited<ReturnType<typeof loadRosterSnapshot>>,
): Promise<readonly SmsCandidateReference[]> {
  if (roster === null) throw new SmsRuntimeStoreError('BATCH_CONFLICT');
  // The batch's endpoint count is its facility's audience, not the whole
  // district snapshot, so the candidates must come from the same audience.
  // Counting every number in the snapshot refused any batch whose audience
  // left an opted-in number out: an isolated facility's events, or any school
  // once a number outside its audience opts in.
  const audience = resolveAudience({
    facilityId: batch.facilityId,
    rosterSnapshot: roster,
  });
  const references = audience.recipients.flatMap((recipient) =>
    recipient.endpoints.flatMap((endpoint) =>
      endpoint.channel === 'sms' && endpoint.status === 'active'
        ? [
            Object.freeze({
              recipientId: recipient.recipientId,
              endpointId: endpoint.id,
            }),
          ]
        : [],
    ),
  );
  if (references.length !== batch.endpointCount) {
    throw new SmsRuntimeStoreError('BATCH_CONFLICT');
  }
  return Object.freeze(references);
}

function attemptFor(
  batch: DispatchBatch,
  recipientId: string,
  endpointId: string,
  id: string,
  attemptNumber: number,
  attemptedAt: string,
): ChannelAttempt {
  return ChannelAttemptSchema.parse({
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
    channel: 'sms',
    attemptNumber,
    attemptedAt,
  });
}

function workItemFor(
  batch: DispatchBatch,
  resolved: Awaited<
    ReturnType<typeof resolvedSmsEndpoints>
  >['endpoints'][number],
  attempt: ChannelAttempt,
): SmsWorkerAttemptWorkItem {
  return SmsWorkerAttemptWorkItemSchema.parse({
    batch,
    attempt,
    endpoint: resolved.endpoint,
  });
}

async function attemptFromId(
  database: Database,
  attemptId: string,
): Promise<ChannelAttempt | null> {
  const [row] = await database
    .select()
    .from(channelAttempts)
    .where(eq(channelAttempts.id, attemptId))
    .limit(1);
  if (row === undefined) return null;
  const batch = await persistedBatch(database, row.batchId);
  return attemptFor(
    batch,
    row.recipientId,
    row.endpointId,
    row.id,
    row.attemptNumber,
    iso(row.attemptedAt),
  );
}

function providerIoResult(
  row: typeof smsProviderIo.$inferSelect | undefined,
  fingerprint: string,
): SmsProviderIoLookupResult {
  if (row === undefined) return Object.freeze({ kind: 'missing' });
  if (row.workFingerprint !== fingerprint) {
    throw new SmsRuntimeStoreError('PROVIDER_IO_CONFLICT');
  }
  if (row.completion === null) {
    return Object.freeze({ kind: 'indeterminate' });
  }
  return Object.freeze({
    kind: 'completed',
    completion: SmsProviderIoCompletionSchema.parse(row.completion),
  });
}

async function assertSmsAttempt(
  database: Database,
  attemptId: string,
  allowMissing = false,
): Promise<void> {
  const [attempt] = await database
    .select({ channel: channelAttempts.channel })
    .from(channelAttempts)
    .where(eq(channelAttempts.id, attemptId))
    .limit(1);
  if (attempt === undefined) {
    if (allowMissing) return;
    throw new SmsRuntimeStoreError('ATTEMPT_NOT_FOUND');
  }
  if (attempt.channel !== 'sms') {
    throw new SmsRuntimeStoreError('ATTEMPT_CONFLICT');
  }
}

function retryRequestMatches(
  row: typeof smsRetrySchedules.$inferSelect,
  input: Extract<SmsRuntimeRequest, { operation: 'schedule-retry' }>,
): boolean {
  return (
    row.sourceAttemptId === input.sourceAttempt.id &&
    row.sourceFingerprint === input.sourceFingerprint &&
    row.nextAttemptNumber === input.nextAttemptNumber &&
    row.delayMilliseconds === input.delayMilliseconds &&
    row.reasonCode === input.reasonCode
  );
}

export function createDrizzleSmsRuntimeStore(
  database: Database,
  runtimeConfiguration: SmsRuntimeStoreConfiguration,
): SmsRuntimeStore {
  const policy = createDrizzleSmsPolicyStore(database);
  const now = runtimeConfiguration.now ?? Date.now;
  const batchExpiresAt = (batch: DispatchBatch): number =>
    Date.parse(batch.createdAt) + SMS_TOTAL_LIFETIME_SECONDS * 1_000;
  const batchIsExpired = (batch: DispatchBatch): boolean =>
    now() >= batchExpiresAt(batch);
  const deniedProviderSend = Object.freeze({ authorized: false as const });
  const authorizeRemainingLifetime = (
    batch: DispatchBatch,
  ): SmsProviderSendAuthorization => {
    const timeToLiveSeconds = Math.floor(
      (batchExpiresAt(batch) - now()) / 1_000,
    );
    return timeToLiveSeconds < SMS_PROVIDER_MINIMUM_TTL_SECONDS
      ? deniedProviderSend
      : Object.freeze({ authorized: true as const, timeToLiveSeconds });
  };
  const store: SmsRuntimeStore = {
    async lookupProviderIo(input) {
      await assertSmsAttempt(database, input.attemptId, true);
      const [row] = await database
        .select()
        .from(smsProviderIo)
        .where(eq(smsProviderIo.attemptId, input.attemptId))
        .limit(1);
      return providerIoResult(row, input.workFingerprint);
    },

    async claimProviderIo(input) {
      await assertSmsAttempt(database, input.attemptId);
      return database.transaction(async (transaction) => {
        const [inserted] = databaseExecuteRows<{ claimToken: string }>(
          await transaction.execute(sql`
            insert into sms_provider_io (
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
            kind: 'acquired' as const,
            claimToken: inserted.claimToken,
          });
        }
        const [row] = await transaction
          .select()
          .from(smsProviderIo)
          .where(eq(smsProviderIo.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        const recovered = providerIoResult(row, input.workFingerprint);
        return recovered.kind === 'missing'
          ? Object.freeze({ kind: 'indeterminate' as const })
          : recovered;
      });
    },

    async completeProviderIo(input) {
      await assertSmsAttempt(database, input.attemptId);
      const completion = SmsProviderIoCompletionSchema.parse(input.completion);
      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(smsProviderIo)
          .where(eq(smsProviderIo.attemptId, input.attemptId))
          .limit(1)
          .for('update');
        if (
          row === undefined ||
          row.workFingerprint !== input.workFingerprint ||
          row.claimToken !== input.claimToken
        ) {
          throw new SmsRuntimeStoreError('PROVIDER_IO_CONFLICT');
        }
        if (row.completion !== null) {
          if (!sameJson(row.completion, completion)) {
            throw new SmsRuntimeStoreError('PROVIDER_IO_COMPLETION_CONFLICT');
          }
          return;
        }
        const updated = await transaction
          .update(smsProviderIo)
          .set({ completion, completedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(smsProviderIo.attemptId, input.attemptId),
              eq(smsProviderIo.workFingerprint, input.workFingerprint),
              eq(smsProviderIo.claimToken, input.claimToken),
              isNull(smsProviderIo.completion),
            ),
          )
          .returning();
        if (updated.length !== 1) {
          throw new SmsRuntimeStoreError('PROVIDER_IO_CONFLICT');
        }
      });
    },

    async scheduleRetry(input) {
      if (input.sourceAttempt.channel !== 'sms') {
        throw new SmsRuntimeStoreError('RETRY_SOURCE_CONFLICT');
      }
      const stored = await attemptFromId(database, input.sourceAttempt.id);
      const batch =
        stored === null ? null : await persistedBatch(database, stored.batchId);
      const retryAtMilliseconds =
        Date.parse(input.sourceAttempt.attemptedAt) + input.delayMilliseconds;
      const expiresAtMilliseconds =
        batch === null ? Number.NaN : batchExpiresAt(batch);
      if (
        stored === null ||
        batch === null ||
        !sameJson(stored, input.sourceAttempt) ||
        input.nextAttemptNumber !== stored.attemptNumber + 1 ||
        !Number.isFinite(retryAtMilliseconds) ||
        retryAtMilliseconds >= expiresAtMilliseconds
      ) {
        throw new SmsRuntimeStoreError('RETRY_SOURCE_CONFLICT');
      }
      return database.transaction(async (transaction) => {
        const [inserted] = databaseExecuteRows<{ nextAttemptId: string }>(
          await transaction.execute(sql`
            insert into sms_retry_schedules (
              source_attempt_id,
              source_fingerprint,
              next_attempt_number,
              delay_milliseconds,
              retry_at,
              expires_at,
              reason_code
            ) values (
              ${input.sourceAttempt.id}::uuid,
              ${input.sourceFingerprint},
              ${input.nextAttemptNumber},
              ${input.delayMilliseconds},
              ${new Date(retryAtMilliseconds).toISOString()}::timestamptz,
              ${new Date(expiresAtMilliseconds).toISOString()}::timestamptz,
              ${input.reasonCode}
            )
            on conflict (source_attempt_id) do nothing
            returning next_attempt_id as "nextAttemptId"
          `),
        );
        if (inserted !== undefined) {
          if (now() >= expiresAtMilliseconds) {
            return Object.freeze({ kind: 'expired' as const });
          }
          return Object.freeze({
            kind: 'scheduled' as const,
            attemptId: inserted.nextAttemptId,
            retryAt: new Date(retryAtMilliseconds).toISOString(),
          });
        }
        const [persisted] = await transaction
          .select()
          .from(smsRetrySchedules)
          .where(eq(smsRetrySchedules.sourceAttemptId, input.sourceAttempt.id))
          .limit(1);
        if (persisted === undefined || !retryRequestMatches(persisted, input)) {
          throw new SmsRuntimeStoreError('RETRY_CONFLICT');
        }
        if (now() >= persisted.expiresAt.getTime()) {
          return Object.freeze({ kind: 'expired' as const });
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
        batch.channel !== 'sms' ||
        !sameJson(batch, input.batch) ||
        Date.parse(input.enqueuedAt) < Date.parse(batch.createdAt)
      ) {
        throw new SmsRuntimeStoreError('BATCH_CONFLICT');
      }
      if (batchIsExpired(batch)) {
        return Object.freeze({ kind: 'expired' as const });
      }
      const resolution = await resolvedSmsEndpoints(database, batch);
      const candidates = await stableSmsCandidateReferences(
        database,
        batch,
        resolution.roster,
      );
      if (input.cursor > candidates.length) {
        throw new SmsRuntimeStoreError('BATCH_CONFLICT');
      }
      const page = candidates.slice(input.cursor, input.cursor + SMS_PAGE_SIZE);
      const eligible = new Map(
        resolution.endpoints.map((resolved) => [
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
          : [
              workItemFor(
                batch,
                resolved,
                attemptFor(
                  batch,
                  resolved.recipientId,
                  resolved.endpoint.id,
                  deterministicAttemptId(batch.id, resolved.endpoint.id, 1),
                  1,
                  batch.createdAt,
                ),
              ),
            ];
      });
      const nextCursor =
        input.cursor + page.length < candidates.length
          ? input.cursor + page.length
          : null;
      return Object.freeze({
        kind: 'ready' as const,
        items: Object.freeze(items),
        nextCursor,
      });
    },

    async resolveRetry(attemptId) {
      const [schedule] = await database
        .select()
        .from(smsRetrySchedules)
        .where(eq(smsRetrySchedules.nextAttemptId, attemptId))
        .limit(1);
      if (schedule === undefined) {
        throw new SmsRuntimeStoreError('RETRY_NOT_FOUND');
      }
      const currentTime = now();
      if (currentTime >= schedule.expiresAt.getTime()) {
        return Object.freeze({ kind: 'expired' as const });
      }
      if (currentTime < schedule.retryAt.getTime()) {
        return Object.freeze({
          kind: 'not-before' as const,
          retryAt: iso(schedule.retryAt),
        });
      }
      const source = await attemptFromId(database, schedule.sourceAttemptId);
      if (source === null) throw new SmsRuntimeStoreError('RETRY_NOT_FOUND');
      const batch = await persistedBatch(database, source.batchId);
      if (batchIsExpired(batch)) {
        return Object.freeze({ kind: 'expired' as const });
      }
      const resolution = await resolvedSmsEndpoints(database, batch);
      const endpoint = resolution.endpoints.find(
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

    async authorizeProviderSend(workItemValue) {
      const workItem = SmsWorkerAttemptWorkItemSchema.parse(workItemValue);
      const batch = await persistedBatch(database, workItem.batch.id);
      const phoneNumber = parsePhoneNumberFromString(
        workItem.endpoint.phoneNumber,
      );
      if (
        !sameJson(batch, workItem.batch) ||
        batchIsExpired(batch) ||
        phoneNumber === undefined ||
        !phoneNumber.isValid() ||
        phoneNumber.country !== runtimeConfiguration.destinationCountryCode
      ) {
        return deniedProviderSend;
      }
      // Enablement decides whether this channel sends. There is no other
      // switch: whether the provider delivers is discovered by sending.
      const [configuration] = await database
        .select({ enabled: channelConfigurations.enabled })
        .from(channelConfigurations)
        .where(eq(channelConfigurations.integrationId, SMS_INTEGRATION_ID))
        .limit(1);
      if (configuration?.enabled !== true) {
        return deniedProviderSend;
      }
      const resolution = await resolvedSmsEndpoints(database, batch);
      if (
        !resolution.endpoints.some(
          (candidate) =>
            candidate.recipientId === workItem.attempt.recipientId &&
            candidate.endpoint.channel === 'sms' &&
            candidate.endpoint.id === workItem.endpoint.id &&
            candidate.endpoint.phoneNumber === workItem.endpoint.phoneNumber,
        ) ||
        !(await batchHasCurrentLifecycle(database, batch))
      ) {
        return deniedProviderSend;
      }
      return authorizeRemainingLifetime(batch);
    },

    async executeLifecycle(input) {
      return executeRecordSmsOptOutCapability(
        input.input,
        input.context,
        policy,
      );
    },

    resolveSmsDestination(input) {
      return policy.resolveSmsDestination(input);
    },

    async loadAttemptByProviderReference(providerReference) {
      const rows = await database
        .select({ attemptId: deliveryEvidence.attemptId })
        .from(deliveryEvidence)
        .where(
          and(
            eq(deliveryEvidence.subjectKind, 'attempt'),
            eq(deliveryEvidence.provider, SMS_INTEGRATION_ID),
            eq(deliveryEvidence.providerReference, providerReference),
          ),
        )
        .groupBy(deliveryEvidence.attemptId)
        .orderBy(asc(deliveryEvidence.attemptId))
        .limit(2);
      if (rows.length > 1) throw new SmsRuntimeStoreError('ATTEMPT_CONFLICT');
      const attemptId = rows[0]?.attemptId;
      return attemptId === null || attemptId === undefined
        ? null
        : attemptFromId(database, attemptId);
    },

    async loadUnknownAttempt(attemptId, correlationToken) {
      const [providerIo] = await database
        .select({ claimToken: smsProviderIo.claimToken })
        .from(smsProviderIo)
        .where(
          and(
            eq(smsProviderIo.attemptId, attemptId),
            eq(smsProviderIo.claimToken, correlationToken),
          ),
        )
        .limit(1);
      if (providerIo === undefined) return null;
      const [latest] = await database
        .select({
          state: deliveryEvidence.state,
          provider: deliveryEvidence.provider,
          providerReference: deliveryEvidence.providerReference,
        })
        .from(deliveryEvidence)
        .where(
          and(
            eq(deliveryEvidence.subjectKind, 'attempt'),
            eq(deliveryEvidence.attemptId, attemptId),
          ),
        )
        .orderBy(desc(deliveryEvidence.sequence))
        .limit(1);
      if (
        latest?.state !== 'unknown' ||
        latest.provider !== SMS_INTEGRATION_ID ||
        latest.providerReference !== null
      ) {
        return null;
      }
      return attemptFromId(database, attemptId);
    },

    async listCurrentRosterSnapshots() {
      const rows = await database
        .select({
          id: rosterSnapshots.id,
          population: rosterSnapshots.population,
          capturedAt: rosterSnapshots.capturedAt,
        })
        .from(rosterSnapshots)
        .orderBy(
          asc(rosterSnapshots.population),
          desc(rosterSnapshots.capturedAt),
          desc(rosterSnapshots.id),
        );
      const seen = new Set<string>();
      return Object.freeze(
        rows.flatMap(({ id, population }) => {
          if (seen.has(population)) return [];
          seen.add(population);
          return [Object.freeze({ id, population })];
        }),
      );
    },
  };
  return Object.freeze(store);
}
