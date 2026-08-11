import { randomUUID } from 'node:crypto';

import {
  DispatchBatchSchema,
  EndpointIdSchema,
  EndpointStatusSchema,
  RecipientIdSchema,
  RecordSmsOptOutInputSchema,
  RenderedMessageSchema,
  RosterPopulationSchema,
  RosterSnapshotIdSchema,
  SmsEndpointSchema,
  SmsOptOutRecordSchema,
  UuidSchema,
  registerCapabilityHandler,
  type DispatchBatch,
  type Endpoint,
  type EventKind,
  type RecordSmsOptOutInput,
  type RegisteredCapabilityHandler,
  type RenderedMessage,
  type SmsMessageTemplate,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import {
  databaseExecuteRows,
  type Database,
  type DatabaseQuery,
} from '../../db/client';
import {
  endpointStatusRecords,
  rosterEndpoints,
  smsOptOutRecords,
} from '../../db/schema';
import { resolveAudience, type ResolveAudienceInput } from '../roster/resolve';
import {
  measureSmsLength,
  renderMessageTemplate,
  type TemplateRenderVariables,
} from './render';

export const SMS_INTEGRATION_ID = 'aws-eum-sms' as const;
export const SMS_OPT_OUT_REASON_CODE = 'SMS_OPTED_OUT' as const;

const SMS_POLICY_LOCK_NAMESPACE = 4_014;
const MAX_SMS_ENDPOINTS = 12_000;
const SmsPhoneNumberSchema = SmsEndpointSchema.unwrap().shape.phoneNumber;

export type RenderedSmsMessage = Extract<RenderedMessage, { channel: 'sms' }>;
export type SmsEndpoint = Extract<Endpoint, { channel: 'sms' }>;

export type SmsPolicyErrorCode =
  | 'INVALID_RENDERED_SMS'
  | 'INVALID_SMS_AUDIENCE'
  | 'INVALID_SMS_BATCH'
  | 'INVALID_SMS_ENDPOINT_POLICY'
  | 'SMS_AUDIENCE_MISMATCH'
  | 'SMS_ENDPOINT_COUNT_MISMATCH'
  | 'SMS_LENGTH_UNSAFE'
  | 'SMS_OPT_OUT_CONFLICT'
  | 'SMS_OPT_OUT_INPUT_INVALID'
  | 'SMS_OPT_OUT_PERSISTENCE_INVALID'
  | 'SMS_ROSTER_MISMATCH';

/** Bounded failure which never reflects a message body or phone number. */
export class SmsPolicyError extends Error {
  public constructor(
    public readonly code: SmsPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SmsPolicyError';
  }
}

export interface RenderSmsMessageInput {
  readonly eventKind: EventKind;
  readonly template: SmsMessageTemplate;
  readonly variables: TemplateRenderVariables;
}

/**
 * Revalidates an already rendered SMS at its final channel boundary.
 * Classification comes from the canonical rendered-message contract, while
 * the P2.2 renderer's GSM/UCS-2 measurement keeps the complete frame in one
 * part. The value is never truncated or re-rendered after this check.
 */
export function validateRenderedSmsMessage(value: unknown): RenderedSmsMessage {
  const result = RenderedMessageSchema.safeParse(value);
  if (!result.success || result.data.channel !== 'sms') {
    throw new SmsPolicyError(
      'INVALID_RENDERED_SMS',
      'The rendered notification is not a valid classified SMS message.',
    );
  }
  const measurement = measureSmsLength(result.data.body);
  if (measurement.exceedsProviderLimit || measurement.parts !== 1) {
    throw new SmsPolicyError(
      'SMS_LENGTH_UNSAFE',
      'The rendered SMS exceeds the one-part channel policy.',
    );
  }
  return result.data;
}

/** Uses the P2.2 renderer and then enforces the final SMS send policy. */
export function renderSmsMessage(
  input: RenderSmsMessageInput,
): RenderedSmsMessage {
  return validateRenderedSmsMessage(
    renderMessageTemplate({
      eventKind: input.eventKind,
      template: input.template,
      variables: input.variables,
    }),
  );
}

export type SmsDispatchBatch = Omit<
  DispatchBatch,
  'channel' | 'renderedMessage'
> &
  Readonly<{
    channel: 'sms';
    renderedMessage: RenderedSmsMessage;
  }>;

/** Parses the exact SMS batch and rejects any channel or integration drift. */
export function validateSmsDispatchBatch(value: unknown): SmsDispatchBatch {
  const result = DispatchBatchSchema.safeParse(value);
  if (
    !result.success ||
    result.data.channel !== 'sms' ||
    result.data.renderedMessage.channel !== 'sms' ||
    result.data.integrationStatus.integrationId !== SMS_INTEGRATION_ID
  ) {
    throw new SmsPolicyError(
      'INVALID_SMS_BATCH',
      'The dispatch batch does not satisfy the SMS channel policy.',
    );
  }
  const renderedMessage = validateRenderedSmsMessage(
    result.data.renderedMessage,
  );
  return Object.freeze({ ...result.data, renderedMessage }) as SmsDispatchBatch;
}

const SmsEndpointPolicyCandidateSchema = z
  .object({
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
  })
  .strict()
  .readonly();

const SmsEndpointPolicyQuerySchema = z
  .object({
    rosterSnapshotId: RosterSnapshotIdSchema,
    rosterPopulation: RosterPopulationSchema,
    candidates: z
      .array(SmsEndpointPolicyCandidateSchema)
      .max(MAX_SMS_ENDPOINTS)
      .readonly(),
  })
  .strict()
  .superRefine((query, context) => {
    const keys = query.candidates.map(candidateKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        message: 'SMS endpoint policy candidates must be unique.',
        path: ['candidates'],
      });
    }
  })
  .readonly();

const SmsEndpointPolicyEvidenceSchema = z
  .object({
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    status: EndpointStatusSchema,
    optedOut: z.boolean(),
  })
  .strict()
  .readonly();

const SmsEndpointPolicyEvidenceListSchema = z
  .array(SmsEndpointPolicyEvidenceSchema)
  .max(MAX_SMS_ENDPOINTS)
  .readonly();

export type SmsEndpointPolicyQuery = z.infer<
  typeof SmsEndpointPolicyQuerySchema
>;
export type SmsEndpointPolicyEvidence = z.infer<
  typeof SmsEndpointPolicyEvidenceSchema
>;

/** Read boundary returns no phone numbers and may be replaced by a test fake. */
export interface SmsEndpointPolicyStore {
  loadEndpointPolicy(query: SmsEndpointPolicyQuery): Promise<unknown>;
}

/** Append-only opt-out boundary; production also appends endpoint status. */
export interface SmsOptOutStore {
  recordSmsOptOut(input: RecordSmsOptOutInput): Promise<SmsOptOutRecord>;
}

export interface ResolveSmsDestinationInput {
  readonly rosterSnapshotId: string;
  readonly phoneNumber: string;
}

export interface ResolvedSmsDestination {
  readonly rosterSnapshotId: string;
  readonly recipientId: string;
  readonly endpointId: string;
}

/**
 * Provider destinations may enter only this trusted lookup boundary. The
 * implementation returns retained opaque IDs and never echoes the number.
 */
export interface SmsOptOutDestinationResolver {
  resolveSmsDestination(
    input: ResolveSmsDestinationInput,
  ): Promise<ResolvedSmsDestination | null>;
}

export interface SmsPolicyStore
  extends SmsEndpointPolicyStore,
    SmsOptOutStore,
    SmsOptOutDestinationResolver {}

export interface ResolveSmsEndpointsInput {
  readonly batch: unknown;
  readonly audience: ResolveAudienceInput;
}

export interface ResolvedSmsEndpoint {
  readonly rosterSnapshotId: string;
  readonly rosterPopulation: 'staff' | 'synthetic';
  readonly recipientId: string;
  readonly endpoint: SmsEndpoint;
}

const ResolveSmsDestinationInputSchema = z
  .object({
    rosterSnapshotId: RosterSnapshotIdSchema,
    phoneNumber: SmsPhoneNumberSchema,
  })
  .strict()
  .readonly();

function candidateKey(value: {
  readonly recipientId: string;
  readonly endpointId: string;
}): string {
  return `${value.recipientId}:${value.endpointId}`;
}

function parseEndpointPolicyEvidence(
  value: unknown,
  query: SmsEndpointPolicyQuery,
): ReadonlyMap<string, SmsEndpointPolicyEvidence> {
  const result = SmsEndpointPolicyEvidenceListSchema.safeParse(value);
  if (!result.success) {
    throw new SmsPolicyError(
      'INVALID_SMS_ENDPOINT_POLICY',
      'SMS endpoint policy evidence was invalid.',
    );
  }
  const expected = new Set(query.candidates.map(candidateKey));
  const evidence = new Map<string, SmsEndpointPolicyEvidence>();
  for (const item of result.data) {
    const key = candidateKey(item);
    if (!expected.has(key) || evidence.has(key)) {
      throw new SmsPolicyError(
        'INVALID_SMS_ENDPOINT_POLICY',
        'SMS endpoint policy evidence did not match the pinned candidates.',
      );
    }
    evidence.set(key, item);
  }
  if (evidence.size !== expected.size) {
    throw new SmsPolicyError(
      'INVALID_SMS_ENDPOINT_POLICY',
      'SMS endpoint policy evidence was incomplete.',
    );
  }
  return evidence;
}

/**
 * Resolves the configured audience from its immutable inputs, proves that it
 * is the batch's exact pinned snapshot/configuration, then applies append-only
 * endpoint status and opt-out evidence before exposing any SMS destination.
 */
export async function resolveSmsEndpoints(
  input: ResolveSmsEndpointsInput,
  store: SmsEndpointPolicyStore,
): Promise<readonly ResolvedSmsEndpoint[]> {
  const batch = validateSmsDispatchBatch(input.batch);
  let audience: ReturnType<typeof resolveAudience>;
  try {
    audience = resolveAudience(input.audience);
  } catch {
    throw new SmsPolicyError(
      'INVALID_SMS_AUDIENCE',
      'The SMS audience could not be resolved from immutable evidence.',
    );
  }
  if (
    audience.rosterSnapshot.id !== batch.rosterSnapshotId ||
    audience.rosterSnapshot.population !== batch.rosterPopulation
  ) {
    throw new SmsPolicyError(
      'SMS_ROSTER_MISMATCH',
      'The SMS audience does not match the pinned roster snapshot.',
    );
  }
  if (
    audience.audienceConfig.id !== batch.audienceConfig.id ||
    audience.audienceConfig.version !== batch.audienceConfig.version
  ) {
    throw new SmsPolicyError(
      'SMS_AUDIENCE_MISMATCH',
      'The SMS audience configuration does not match the dispatch batch.',
    );
  }

  const candidates = audience.recipients.flatMap((recipient) =>
    recipient.endpoints.flatMap((endpoint) =>
      endpoint.channel === 'sms' && endpoint.status === 'active'
        ? [
            Object.freeze({
              recipientId: recipient.recipientId,
              endpoint,
            }),
          ]
        : [],
    ),
  );
  if (candidates.length !== batch.endpointCount) {
    throw new SmsPolicyError(
      'SMS_ENDPOINT_COUNT_MISMATCH',
      'The pinned SMS endpoint count no longer matches the dispatch batch.',
    );
  }

  const query = SmsEndpointPolicyQuerySchema.parse({
    rosterSnapshotId: batch.rosterSnapshotId,
    rosterPopulation: batch.rosterPopulation,
    candidates: candidates.map(({ recipientId, endpoint }) => ({
      recipientId,
      endpointId: endpoint.id,
    })),
  });
  const policy = parseEndpointPolicyEvidence(
    await store.loadEndpointPolicy(query),
    query,
  );
  return Object.freeze(
    candidates.flatMap(({ recipientId, endpoint }) => {
      const evidence = policy.get(
        candidateKey({ recipientId, endpointId: endpoint.id }),
      );
      if (
        evidence === undefined ||
        evidence.status !== 'active' ||
        evidence.optedOut
      ) {
        return [];
      }
      return [
        Object.freeze({
          rosterSnapshotId: batch.rosterSnapshotId,
          rosterPopulation: batch.rosterPopulation,
          recipientId,
          endpoint,
        }),
      ];
    }),
  );
}

/** Parses an opt-out request and requires an exact contract-shaped result. */
export async function recordSmsOptOut(
  inputValue: unknown,
  store: SmsOptOutStore,
): Promise<SmsOptOutRecord> {
  const inputResult = RecordSmsOptOutInputSchema.safeParse(inputValue);
  if (!inputResult.success) {
    throw new SmsPolicyError(
      'SMS_OPT_OUT_INPUT_INVALID',
      'The SMS opt-out request was invalid.',
    );
  }
  const input = inputResult.data;
  const recordResult = SmsOptOutRecordSchema.safeParse(
    await store.recordSmsOptOut(input),
  );
  if (
    !recordResult.success ||
    recordResult.data.rosterSnapshotId !== input.rosterSnapshotId ||
    recordResult.data.recipientId !== input.recipientId ||
    recordResult.data.endpointId !== input.endpointId ||
    recordResult.data.provider !== input.provider ||
    recordResult.data.providerReference !== input.providerReference
  ) {
    throw new SmsPolicyError(
      'SMS_OPT_OUT_PERSISTENCE_INVALID',
      'The SMS opt-out store returned inconsistent evidence.',
    );
  }
  return recordResult.data;
}

/** Registers the canonical webhook-only opt-out mutation. */
export function createRecordSmsOptOutHandler<Context>(
  store: SmsOptOutStore,
): Readonly<RegisteredCapabilityHandler<'record-sms-opt-out', Context>> {
  return registerCapabilityHandler('record-sms-opt-out', (input) =>
    recordSmsOptOut(input, store),
  );
}

export interface DrizzleSmsPolicyStoreOptions {
  readonly uuid?: () => string;
}

type SmsPolicyQueryDatabase = DatabaseQuery;
type SmsOptOutRow = typeof smsOptOutRecords.$inferSelect;

function smsPolicyQueryDatabase(database: unknown): SmsPolicyQueryDatabase {
  return database as SmsPolicyQueryDatabase;
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new SmsPolicyError(
      'SMS_OPT_OUT_PERSISTENCE_INVALID',
      'Persisted SMS policy time was invalid.',
    );
  }
  return date.toISOString();
}

function smsOptOutFromRow(row: SmsOptOutRow): SmsOptOutRecord {
  return SmsOptOutRecordSchema.parse({
    id: row.id,
    rosterSnapshotId: row.rosterSnapshotId,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    provider: row.provider,
    providerReference: row.providerReference,
    recordedAt: dateIso(row.recordedAt),
  });
}

async function readDatabaseTime(
  database: SmsPolicyQueryDatabase,
): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row?.value === undefined) {
    throw new SmsPolicyError(
      'SMS_OPT_OUT_PERSISTENCE_INVALID',
      'The authoritative SMS policy clock was unavailable.',
    );
  }
  return new Date(dateIso(row.value));
}

async function lockSmsOptOut(
  database: SmsPolicyQueryDatabase,
  input: RecordSmsOptOutInput,
): Promise<void> {
  const endpointIdentity = `${input.rosterSnapshotId}:${input.recipientId}:${input.endpointId}`;
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sms-opt-out-endpoint:${endpointIdentity}`}, ${SMS_POLICY_LOCK_NAMESPACE}))`,
  );
}

async function ensureSmsOptOutEndpointStatus(
  database: SmsPolicyQueryDatabase,
  input: RecordSmsOptOutInput,
  endpoint: Readonly<{
    population: 'staff' | 'synthetic';
    channel: 'sms';
  }>,
  recordedAt: Date,
  uuid: () => string,
): Promise<void> {
  const [existing] = await database
    .select({ id: endpointStatusRecords.id })
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.rosterSnapshotId, input.rosterSnapshotId),
        eq(endpointStatusRecords.recipientId, input.recipientId),
        eq(endpointStatusRecords.endpointId, input.endpointId),
        eq(endpointStatusRecords.channel, 'sms'),
        eq(endpointStatusRecords.status, 'disabled'),
        eq(endpointStatusRecords.reasonCode, SMS_OPT_OUT_REASON_CODE),
      ),
    )
    .orderBy(
      asc(endpointStatusRecords.recordedAt),
      asc(endpointStatusRecords.id),
    )
    .limit(1);
  if (existing !== undefined) return;
  await database.insert(endpointStatusRecords).values({
    id: UuidSchema.parse(uuid()),
    rosterSnapshotId: input.rosterSnapshotId,
    recipientId: input.recipientId,
    endpointId: input.endpointId,
    population: endpoint.population,
    channel: endpoint.channel,
    status: 'disabled',
    reasonCode: SMS_OPT_OUT_REASON_CODE,
    recordedAt,
  });
}

async function loadDrizzleEndpointPolicy(
  database: SmsPolicyQueryDatabase,
  query: SmsEndpointPolicyQuery,
): Promise<readonly SmsEndpointPolicyEvidence[]> {
  if (query.candidates.length === 0) return Object.freeze([]);
  const endpointIds = query.candidates.map(({ endpointId }) => endpointId);
  const endpointRows = await database
    .select({
      endpointId: rosterEndpoints.id,
      recipientId: rosterEndpoints.recipientId,
      status: rosterEndpoints.status,
      phoneNumber: rosterEndpoints.phoneNumber,
    })
    .from(rosterEndpoints)
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, query.rosterSnapshotId),
        eq(rosterEndpoints.population, query.rosterPopulation),
        eq(rosterEndpoints.channel, 'sms'),
        inArray(rosterEndpoints.id, endpointIds),
      ),
    );

  const statusRows = await database
    .select({
      endpointId: endpointStatusRecords.endpointId,
      recipientId: endpointStatusRecords.recipientId,
      status: endpointStatusRecords.status,
      recordedAt: endpointStatusRecords.recordedAt,
      id: endpointStatusRecords.id,
    })
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.rosterSnapshotId, query.rosterSnapshotId),
        eq(endpointStatusRecords.population, query.rosterPopulation),
        eq(endpointStatusRecords.channel, 'sms'),
        inArray(endpointStatusRecords.endpointId, endpointIds),
      ),
    )
    .orderBy(
      asc(endpointStatusRecords.recordedAt),
      asc(endpointStatusRecords.id),
    );

  const effectiveStatuses = new Map<
    string,
    'active' | 'invalid' | 'disabled'
  >();
  endpointRows.forEach((endpoint) =>
    effectiveStatuses.set(
      candidateKey(endpoint),
      EndpointStatusSchema.parse(endpoint.status),
    ),
  );
  statusRows.forEach((status) =>
    effectiveStatuses.set(
      candidateKey(status),
      EndpointStatusSchema.parse(status.status),
    ),
  );

  const phoneNumbers = endpointRows.flatMap(({ phoneNumber }) =>
    phoneNumber === null ? [] : [phoneNumber],
  );
  const retainedOptOutEndpoint = alias(
    rosterEndpoints,
    'retained_sms_opt_out_endpoint',
  );
  const optedOutPhoneRows =
    phoneNumbers.length === 0
      ? []
      : await database
          .selectDistinct({ phoneNumber: retainedOptOutEndpoint.phoneNumber })
          .from(smsOptOutRecords)
          .innerJoin(
            retainedOptOutEndpoint,
            and(
              eq(
                retainedOptOutEndpoint.rosterSnapshotId,
                smsOptOutRecords.rosterSnapshotId,
              ),
              eq(
                retainedOptOutEndpoint.recipientId,
                smsOptOutRecords.recipientId,
              ),
              eq(retainedOptOutEndpoint.id, smsOptOutRecords.endpointId),
              eq(
                retainedOptOutEndpoint.population,
                smsOptOutRecords.population,
              ),
              eq(retainedOptOutEndpoint.channel, smsOptOutRecords.channel),
            ),
          )
          .where(
            and(
              eq(smsOptOutRecords.channel, 'sms'),
              inArray(retainedOptOutEndpoint.phoneNumber, phoneNumbers),
            ),
          )
          .limit(MAX_SMS_ENDPOINTS);
  const optedOutPhoneNumbers = new Set(
    optedOutPhoneRows.flatMap(({ phoneNumber }) =>
      phoneNumber === null ? [] : [phoneNumber],
    ),
  );

  return Object.freeze(
    endpointRows
      .map((endpoint) => ({
        recipientId: endpoint.recipientId,
        endpointId: endpoint.endpointId,
        status:
          effectiveStatuses.get(candidateKey(endpoint)) ?? endpoint.status,
        optedOut:
          endpoint.phoneNumber !== null &&
          optedOutPhoneNumbers.has(endpoint.phoneNumber),
      }))
      .sort(
        (left, right) =>
          left.recipientId.localeCompare(right.recipientId) ||
          left.endpointId.localeCompare(right.endpointId),
      ),
  );
}

/**
 * Transactional PostgreSQL policy store. Opt-out replay is serialized by both
 * endpoint and provider-reference identity; the retained opt-out and disabled
 * status facts commit together and are never updated or deleted.
 */
export function createDrizzleSmsPolicyStore(
  database: Database,
  options: DrizzleSmsPolicyStoreOptions = {},
): SmsPolicyStore {
  const uuid = options.uuid ?? randomUUID;
  return Object.freeze({
    async resolveSmsDestination(
      inputValue: ResolveSmsDestinationInput,
    ): Promise<ResolvedSmsDestination | null> {
      const inputResult =
        ResolveSmsDestinationInputSchema.safeParse(inputValue);
      if (!inputResult.success) {
        throw new SmsPolicyError(
          'SMS_OPT_OUT_INPUT_INVALID',
          'The SMS destination lookup was invalid.',
        );
      }
      const input = inputResult.data;
      const rows = await smsPolicyQueryDatabase(database)
        .select({
          rosterSnapshotId: rosterEndpoints.rosterSnapshotId,
          recipientId: rosterEndpoints.recipientId,
          endpointId: rosterEndpoints.id,
        })
        .from(rosterEndpoints)
        .where(
          and(
            eq(rosterEndpoints.rosterSnapshotId, input.rosterSnapshotId),
            eq(rosterEndpoints.channel, 'sms'),
            eq(rosterEndpoints.phoneNumber, input.phoneNumber),
          ),
        )
        .orderBy(asc(rosterEndpoints.recipientId), asc(rosterEndpoints.id))
        .limit(2);
      if (rows.length > 1) {
        throw new SmsPolicyError(
          'SMS_OPT_OUT_CONFLICT',
          'The SMS destination did not resolve to one retained endpoint.',
        );
      }
      const row = rows[0];
      return row === undefined ? null : Object.freeze(row);
    },

    async loadEndpointPolicy(
      queryValue: SmsEndpointPolicyQuery,
    ): Promise<readonly SmsEndpointPolicyEvidence[]> {
      const queryResult = SmsEndpointPolicyQuerySchema.safeParse(queryValue);
      if (!queryResult.success) {
        throw new SmsPolicyError(
          'INVALID_SMS_ENDPOINT_POLICY',
          'The SMS endpoint policy query was invalid.',
        );
      }
      return database.transaction(async (transaction) => {
        const queryDatabase = smsPolicyQueryDatabase(transaction);
        await queryDatabase.execute(
          sql`set transaction isolation level repeatable read, read only`,
        );
        return loadDrizzleEndpointPolicy(queryDatabase, queryResult.data);
      });
    },

    recordSmsOptOut(
      inputValue: RecordSmsOptOutInput,
    ): Promise<SmsOptOutRecord> {
      const inputResult = RecordSmsOptOutInputSchema.safeParse(inputValue);
      if (!inputResult.success) {
        throw new SmsPolicyError(
          'SMS_OPT_OUT_INPUT_INVALID',
          'The SMS opt-out request was invalid.',
        );
      }
      const input = inputResult.data;
      return database.transaction(async (transaction) => {
        const queryDatabase = smsPolicyQueryDatabase(transaction);
        await lockSmsOptOut(queryDatabase, input);
        const [endpoint] = await queryDatabase
          .select({
            population: rosterEndpoints.population,
            channel: rosterEndpoints.channel,
          })
          .from(rosterEndpoints)
          .where(
            and(
              eq(rosterEndpoints.rosterSnapshotId, input.rosterSnapshotId),
              eq(rosterEndpoints.recipientId, input.recipientId),
              eq(rosterEndpoints.id, input.endpointId),
            ),
          )
          .limit(1);
        if (endpoint === undefined || endpoint.channel !== 'sms') {
          throw new SmsPolicyError(
            'SMS_OPT_OUT_CONFLICT',
            'The SMS opt-out did not identify a retained SMS endpoint.',
          );
        }

        const existingRows = await queryDatabase
          .select()
          .from(smsOptOutRecords)
          .where(
            and(
              eq(smsOptOutRecords.rosterSnapshotId, input.rosterSnapshotId),
              eq(smsOptOutRecords.recipientId, input.recipientId),
              eq(smsOptOutRecords.endpointId, input.endpointId),
              eq(smsOptOutRecords.provider, input.provider),
              eq(smsOptOutRecords.providerReference, input.providerReference),
            ),
          )
          .orderBy(asc(smsOptOutRecords.recordedAt), asc(smsOptOutRecords.id))
          .limit(2);
        if (existingRows.some((row) => row.channel !== 'sms')) {
          throw new SmsPolicyError(
            'SMS_OPT_OUT_CONFLICT',
            'The retained opt-out evidence has an invalid channel.',
          );
        }

        const existing = existingRows[0];
        const recordedAt =
          existing === undefined
            ? await readDatabaseTime(queryDatabase)
            : new Date(dateIso(existing.recordedAt));
        const record =
          existing === undefined
            ? SmsOptOutRecordSchema.parse({
                id: UuidSchema.parse(uuid()),
                ...input,
                recordedAt: recordedAt.toISOString(),
              })
            : smsOptOutFromRow(existing);
        if (existing === undefined) {
          await queryDatabase.insert(smsOptOutRecords).values({
            id: record.id,
            rosterSnapshotId: record.rosterSnapshotId,
            recipientId: record.recipientId,
            endpointId: record.endpointId,
            population: endpoint.population,
            channel: 'sms',
            provider: record.provider,
            providerReference: record.providerReference,
            recordedAt,
          });
        }
        await ensureSmsOptOutEndpointStatus(
          queryDatabase,
          input,
          { population: endpoint.population, channel: 'sms' },
          recordedAt,
          uuid,
        );
        return record;
      });
    },
  });
}
