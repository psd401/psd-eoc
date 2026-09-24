import { randomUUID } from 'node:crypto';

import {
  DispatchBatchSchema,
  EndpointIdSchema,
  EndpointStatusRecordSchema,
  EndpointStatusSchema,
  RecipientIdSchema,
  RecordEndpointStatusInputSchema,
  RecordSmsOptOutInputSchema,
  RenderedMessageSchema,
  RosterPopulationSchema,
  RosterSnapshotIdSchema,
  SMS_OPT_OUT_REASON_CODE as CONTRACT_SMS_OPT_OUT_REASON_CODE,
  SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
  SmsEndpointSchema,
  SmsLifecycleCapabilityContextSchema,
  SmsOptOutRecordSchema,
  UuidSchema,
  invokeAuthorizedCapabilityHandler as executeCanonicalCapability,
  registerCapabilityHandler,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type DispatchBatch,
  type Endpoint,
  type EventKind,
  type EndpointStatusRecord,
  type RecordEndpointStatusInput,
  type RecordSmsOptOutInput,
  type RegisteredCapabilityId,
  type RegisteredCapabilityHandler,
  type RenderedMessage,
  type SmsMessageTemplate,
  type SmsLifecycleCapabilityContext,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
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
export const SMS_OPT_OUT_REASON_CODE = CONTRACT_SMS_OPT_OUT_REASON_CODE;
export const SMS_OPT_IN_REASON_CODE = SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE;

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
  | 'SMS_ENDPOINT_STATUS_INPUT_INVALID'
  | 'SMS_ENDPOINT_STATUS_PERSISTENCE_INVALID'
  | 'SMS_LIFECYCLE_INVOCATION_DENIED'
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
    result.data.integrationId !== SMS_INTEGRATION_ID
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
    endpointCount: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_SMS_ENDPOINTS)
      .optional(),
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

/** Append-only endpoint lifecycle boundary for the canonical capability. */
export interface SmsEndpointStatusStore {
  recordEndpointStatus(
    input: RecordEndpointStatusInput,
  ): Promise<EndpointStatusRecord>;
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
  extends
    SmsEndpointPolicyStore,
    SmsOptOutStore,
    SmsEndpointStatusStore,
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
  // The audience is the school now, not a versioned configuration object,
  // so the provenance check compares the school the batch was built for.
  if (audience.facilityId !== batch.facilityId) {
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
    endpointCount: batch.endpointCount,
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
  const input = Object.freeze({
    ...inputResult.data,
    providerOccurredAt: new Date(
      inputResult.data.providerOccurredAt,
    ).toISOString(),
  });
  const recordResult = SmsOptOutRecordSchema.safeParse(
    await store.recordSmsOptOut(input),
  );
  if (
    !recordResult.success ||
    recordResult.data.rosterSnapshotId !== input.rosterSnapshotId ||
    recordResult.data.recipientId !== input.recipientId ||
    recordResult.data.endpointId !== input.endpointId ||
    recordResult.data.provider !== input.provider ||
    recordResult.data.providerReference !== input.providerReference ||
    recordResult.data.providerOccurredAt !== input.providerOccurredAt
  ) {
    throw new SmsPolicyError(
      'SMS_OPT_OUT_PERSISTENCE_INVALID',
      'The SMS opt-out store returned inconsistent evidence.',
    );
  }
  return recordResult.data;
}

/** Registers canonical worker/scheduled-job opt-out persistence. */
export function createRecordSmsOptOutHandler<Context>(
  store: SmsOptOutStore,
): Readonly<RegisteredCapabilityHandler<'record-sms-opt-out', Context>> {
  return registerCapabilityHandler('record-sms-opt-out', (input) =>
    recordSmsOptOut(input, store),
  );
}

/** Parses a lifecycle append and requires exact returned canonical evidence. */
export async function recordEndpointStatus(
  inputValue: unknown,
  store: SmsEndpointStatusStore,
): Promise<EndpointStatusRecord> {
  const inputResult = RecordEndpointStatusInputSchema.safeParse(inputValue);
  if (!inputResult.success) {
    throw new SmsPolicyError(
      'SMS_ENDPOINT_STATUS_INPUT_INVALID',
      'The SMS endpoint-status request was invalid.',
    );
  }
  const parsedInput = inputResult.data;
  const input =
    parsedInput.providerOccurredAt === undefined
      ? parsedInput
      : RecordEndpointStatusInputSchema.parse({
          ...parsedInput,
          providerOccurredAt: new Date(
            parsedInput.providerOccurredAt,
          ).toISOString(),
        });
  const recordResult = EndpointStatusRecordSchema.safeParse(
    await store.recordEndpointStatus(input),
  );
  if (
    !recordResult.success ||
    recordResult.data.rosterSnapshotId !== input.rosterSnapshotId ||
    recordResult.data.recipientId !== input.recipientId ||
    recordResult.data.endpointId !== input.endpointId ||
    recordResult.data.status !== input.status ||
    recordResult.data.reasonCode !== input.reasonCode ||
    recordResult.data.provider !== input.provider ||
    recordResult.data.providerReference !== input.providerReference ||
    recordResult.data.providerOccurredAt !== input.providerOccurredAt
  ) {
    throw new SmsPolicyError(
      'SMS_ENDPOINT_STATUS_PERSISTENCE_INVALID',
      'The endpoint-status store returned inconsistent evidence.',
    );
  }
  return recordResult.data;
}

/** Registers the canonical append-only endpoint lifecycle mutation. */
export function createRecordEndpointStatusHandler<Context>(
  store: SmsEndpointStatusStore,
): Readonly<RegisteredCapabilityHandler<'record-endpoint-status', Context>> {
  return registerCapabilityHandler('record-endpoint-status', (input) =>
    recordEndpointStatus(input, store),
  );
}

/** Deny-by-default authorization for the two SMS lifecycle mutations. */
export function createSmsLifecycleCapabilityAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<SmsLifecycleCapabilityContext>
> {
  return Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        SmsLifecycleCapabilityContext
      >,
    ): void {
      const context = SmsLifecycleCapabilityContextSchema.safeParse(
        request.context,
      );
      const sourceMayInvokeCapability =
        (request.definition.id === 'record-sms-opt-out' &&
          context.success &&
          ['worker', 'scheduled-job'].includes(context.data.source)) ||
        (request.definition.id === 'record-endpoint-status' &&
          context.success &&
          context.data.source === 'webhook');
      if (
        !context.success ||
        !['record-sms-opt-out', 'record-endpoint-status'].includes(
          request.definition.id,
        ) ||
        !sourceMayInvokeCapability ||
        request.definition.operation !== 'mutation' ||
        !request.invocationPolicy.principalKinds.includes('system') ||
        !request.invocationPolicy.sources.includes(context.data.source) ||
        request.humanActionRequirement.actionIds.length !== 0 ||
        request.humanActionRequirement.consequenceDigest !== null
      ) {
        throw new SmsPolicyError(
          'SMS_LIFECYCLE_INVOCATION_DENIED',
          'The SMS lifecycle capability invocation was not authorized.',
        );
      }
    },
  });
}

export function executeRecordSmsOptOutCapability(
  input: unknown,
  context: SmsLifecycleCapabilityContext,
  store: SmsOptOutStore,
): Promise<SmsOptOutRecord> {
  return executeCanonicalCapability(
    createRecordSmsOptOutHandler<SmsLifecycleCapabilityContext>(store),
    input,
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createSmsLifecycleCapabilityAuthorizer(),
    },
  );
}

export function executeRecordEndpointStatusCapability(
  input: unknown,
  context: SmsLifecycleCapabilityContext,
  store: SmsEndpointStatusStore,
): Promise<EndpointStatusRecord> {
  return executeCanonicalCapability(
    createRecordEndpointStatusHandler<SmsLifecycleCapabilityContext>(store),
    input,
    {
      context,
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: createSmsLifecycleCapabilityAuthorizer(),
    },
  );
}

export interface DrizzleSmsPolicyStoreOptions {
  readonly uuid?: () => string;
}

type SmsPolicyQueryDatabase = DatabaseQuery;
type SmsOptOutRow = typeof smsOptOutRecords.$inferSelect;
type EndpointStatusRow = typeof endpointStatusRecords.$inferSelect;

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
    providerOccurredAt: dateIso(row.providerOccurredAt ?? row.recordedAt),
    recordedAt: dateIso(row.recordedAt),
  });
}

function endpointStatusFromRow(row: EndpointStatusRow): EndpointStatusRecord {
  const hasNoProviderTruth =
    row.provider === null &&
    row.providerReference === null &&
    row.providerOccurredAt === null;
  const hasCompleteProviderTruth =
    row.provider !== null &&
    row.providerReference !== null &&
    row.providerOccurredAt !== null;
  if (!hasNoProviderTruth && !hasCompleteProviderTruth) {
    throw new SmsPolicyError(
      'SMS_ENDPOINT_STATUS_PERSISTENCE_INVALID',
      'Persisted endpoint lifecycle provider evidence was incomplete.',
    );
  }
  return EndpointStatusRecordSchema.parse({
    id: row.id,
    rosterSnapshotId: row.rosterSnapshotId,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    status: row.status,
    reasonCode: row.reasonCode,
    ...(hasNoProviderTruth
      ? {}
      : {
          provider: row.provider as string,
          providerReference: row.providerReference as string,
          providerOccurredAt: dateIso(row.providerOccurredAt as Date),
        }),
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

async function lockSmsEndpointPolicy(
  database: SmsPolicyQueryDatabase,
  input: Readonly<{
    rosterSnapshotId: string;
    recipientId: string;
    endpointId: string;
  }>,
): Promise<void> {
  const endpointIdentity = `${input.rosterSnapshotId}:${input.recipientId}:${input.endpointId}`;
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sms-endpoint-policy:${endpointIdentity}`}, ${SMS_POLICY_LOCK_NAMESPACE}))`,
  );
}

async function appendSmsEndpointStatus(
  database: SmsPolicyQueryDatabase,
  input: RecordEndpointStatusInput,
  endpoint: Readonly<{
    population: 'staff' | 'synthetic';
    channel: 'sms';
  }>,
  recordedAt: Date,
  uuid: () => string,
): Promise<EndpointStatusRecord> {
  if (input.provider !== undefined && input.providerReference !== undefined) {
    const exactRows = await database
      .select()
      .from(endpointStatusRecords)
      .where(
        and(
          eq(endpointStatusRecords.rosterSnapshotId, input.rosterSnapshotId),
          eq(endpointStatusRecords.recipientId, input.recipientId),
          eq(endpointStatusRecords.endpointId, input.endpointId),
          eq(endpointStatusRecords.channel, 'sms'),
          eq(endpointStatusRecords.provider, input.provider),
          eq(endpointStatusRecords.providerReference, input.providerReference),
        ),
      )
      .limit(2);
    if (exactRows.length > 1) {
      throw new SmsPolicyError(
        'SMS_ENDPOINT_STATUS_PERSISTENCE_INVALID',
        'The endpoint lifecycle provider reference was not unique.',
      );
    }
    const exact = exactRows[0];
    if (exact !== undefined) {
      const record = endpointStatusFromRow(exact);
      if (
        record.status !== input.status ||
        record.reasonCode !== input.reasonCode ||
        record.providerOccurredAt !== input.providerOccurredAt
      ) {
        throw new SmsPolicyError(
          'SMS_ENDPOINT_STATUS_PERSISTENCE_INVALID',
          'The endpoint lifecycle replay did not match retained evidence.',
        );
      }
      return record;
    }
  }
  const [existing] = await database
    .select()
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.rosterSnapshotId, input.rosterSnapshotId),
        eq(endpointStatusRecords.recipientId, input.recipientId),
        eq(endpointStatusRecords.endpointId, input.endpointId),
        eq(endpointStatusRecords.channel, 'sms'),
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${endpointStatusRecords.providerOccurredAt}, ${endpointStatusRecords.recordedAt})`,
      ),
      desc(endpointStatusRecords.sequence),
    )
    .limit(1);
  if (
    existing !== undefined &&
    existing.status === input.status &&
    existing.reasonCode === input.reasonCode &&
    existing.provider === (input.provider ?? null) &&
    existing.providerReference === (input.providerReference ?? null) &&
    (existing.providerOccurredAt === null
      ? null
      : dateIso(existing.providerOccurredAt)) ===
      (input.providerOccurredAt ?? null)
  ) {
    return endpointStatusFromRow(existing);
  }
  const record = EndpointStatusRecordSchema.parse({
    id: UuidSchema.parse(uuid()),
    rosterSnapshotId: input.rosterSnapshotId,
    recipientId: input.recipientId,
    endpointId: input.endpointId,
    status: input.status,
    reasonCode: input.reasonCode,
    ...(input.provider === undefined ||
    input.providerReference === undefined ||
    input.providerOccurredAt === undefined
      ? {}
      : {
          provider: input.provider,
          providerReference: input.providerReference,
          providerOccurredAt: input.providerOccurredAt,
        }),
    recordedAt: recordedAt.toISOString(),
  });
  await database.insert(endpointStatusRecords).values({
    ...record,
    population: endpoint.population,
    channel: endpoint.channel,
    provider: record.provider ?? null,
    providerReference: record.providerReference ?? null,
    providerOccurredAt:
      record.providerOccurredAt === undefined
        ? null
        : new Date(record.providerOccurredAt),
    recordedAt,
  });
  return record;
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
    .selectDistinctOn([endpointStatusRecords.endpointId], {
      endpointId: endpointStatusRecords.endpointId,
      recipientId: endpointStatusRecords.recipientId,
      status: endpointStatusRecords.status,
      reasonCode: endpointStatusRecords.reasonCode,
      provider: endpointStatusRecords.provider,
      providerReference: endpointStatusRecords.providerReference,
      providerOccurredAt: endpointStatusRecords.providerOccurredAt,
      sequence: endpointStatusRecords.sequence,
    })
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.rosterSnapshotId, query.rosterSnapshotId),
        eq(endpointStatusRecords.population, query.rosterPopulation),
        eq(endpointStatusRecords.channel, 'sms'),
        inArray(endpointStatusRecords.endpointId, endpointIds),
        notInArray(endpointStatusRecords.reasonCode, [
          SMS_OPT_OUT_REASON_CODE,
          SMS_OPT_IN_REASON_CODE,
        ]),
      ),
    )
    .orderBy(
      endpointStatusRecords.endpointId,
      desc(
        sql`coalesce(${endpointStatusRecords.providerOccurredAt}, ${endpointStatusRecords.recordedAt})`,
      ),
      desc(endpointStatusRecords.sequence),
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
  statusRows.forEach((status) => {
    if (
      status.status === 'active' ||
      status.provider !== null ||
      status.providerReference !== null ||
      status.providerOccurredAt !== null
    ) {
      throw new SmsPolicyError(
        'INVALID_SMS_ENDPOINT_POLICY',
        'Persisted non-provider SMS endpoint evidence was inconsistent.',
      );
    }
    effectiveStatuses.set(
      candidateKey(status),
      EndpointStatusSchema.parse(status.status),
    );
  });

  const phoneNumbers = endpointRows.flatMap(({ phoneNumber }) =>
    phoneNumber === null ? [] : [phoneNumber],
  );
  const retainedLifecycleEndpoint = alias(
    rosterEndpoints,
    'retained_sms_lifecycle_endpoint',
  );
  const phoneLifecycleRows =
    phoneNumbers.length === 0
      ? []
      : await database
          .selectDistinctOn([retainedLifecycleEndpoint.phoneNumber], {
            phoneNumber: retainedLifecycleEndpoint.phoneNumber,
            status: endpointStatusRecords.status,
            reasonCode: endpointStatusRecords.reasonCode,
            provider: endpointStatusRecords.provider,
            providerReference: endpointStatusRecords.providerReference,
            providerOccurredAt: endpointStatusRecords.providerOccurredAt,
            sequence: endpointStatusRecords.sequence,
          })
          .from(endpointStatusRecords)
          .innerJoin(
            retainedLifecycleEndpoint,
            and(
              eq(
                retainedLifecycleEndpoint.rosterSnapshotId,
                endpointStatusRecords.rosterSnapshotId,
              ),
              eq(
                retainedLifecycleEndpoint.recipientId,
                endpointStatusRecords.recipientId,
              ),
              eq(
                retainedLifecycleEndpoint.id,
                endpointStatusRecords.endpointId,
              ),
              eq(
                retainedLifecycleEndpoint.population,
                endpointStatusRecords.population,
              ),
              eq(
                retainedLifecycleEndpoint.channel,
                endpointStatusRecords.channel,
              ),
            ),
          )
          .where(
            and(
              eq(endpointStatusRecords.channel, 'sms'),
              inArray(retainedLifecycleEndpoint.phoneNumber, phoneNumbers),
              inArray(endpointStatusRecords.reasonCode, [
                SMS_OPT_OUT_REASON_CODE,
                SMS_OPT_IN_REASON_CODE,
              ]),
            ),
          )
          .orderBy(
            retainedLifecycleEndpoint.phoneNumber,
            desc(
              sql`coalesce(${endpointStatusRecords.providerOccurredAt}, ${endpointStatusRecords.recordedAt})`,
            ),
            desc(endpointStatusRecords.sequence),
          );
  const effectivePhoneOptOut = new Map<string, boolean>();
  phoneLifecycleRows.forEach((row) => {
    if (row.phoneNumber === null) return;
    if (
      row.reasonCode === SMS_OPT_OUT_REASON_CODE &&
      row.status === 'disabled' &&
      row.provider === SMS_INTEGRATION_ID &&
      row.providerReference !== null &&
      row.providerOccurredAt !== null
    ) {
      effectivePhoneOptOut.set(row.phoneNumber, true);
      return;
    }
    if (
      row.reasonCode === SMS_OPT_IN_REASON_CODE &&
      row.status === 'active' &&
      row.provider === SMS_INTEGRATION_ID &&
      row.providerReference !== null &&
      row.providerOccurredAt !== null
    ) {
      effectivePhoneOptOut.set(row.phoneNumber, false);
      return;
    }
    throw new SmsPolicyError(
      'INVALID_SMS_ENDPOINT_POLICY',
      'Persisted SMS opt-out lifecycle evidence was inconsistent.',
    );
  });

  return Object.freeze(
    endpointRows
      .map((endpoint) => ({
        recipientId: endpoint.recipientId,
        endpointId: endpoint.endpointId,
        status:
          effectiveStatuses.get(candidateKey(endpoint)) ?? endpoint.status,
        optedOut:
          endpoint.phoneNumber !== null &&
          (effectivePhoneOptOut.get(endpoint.phoneNumber) ?? false),
      }))
      .sort(
        (left, right) =>
          left.recipientId.localeCompare(right.recipientId) ||
          left.endpointId.localeCompare(right.endpointId),
      ),
  );
}

/**
 * Transactional PostgreSQL policy store. Lifecycle appends are serialized per
 * endpoint. Retained opt-out and disabled facts commit together; a later
 * provider-verified active fact supersedes them without rewriting history.
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
          sql`set transaction isolation level read committed, read only`,
        );
        return loadDrizzleEndpointPolicy(queryDatabase, queryResult.data);
      });
    },

    recordEndpointStatus(
      inputValue: RecordEndpointStatusInput,
    ): Promise<EndpointStatusRecord> {
      const inputResult = RecordEndpointStatusInputSchema.safeParse(inputValue);
      if (!inputResult.success) {
        throw new SmsPolicyError(
          'SMS_ENDPOINT_STATUS_INPUT_INVALID',
          'The SMS endpoint-status request was invalid.',
        );
      }
      const input = inputResult.data;
      return database.transaction(async (transaction) => {
        const queryDatabase = smsPolicyQueryDatabase(transaction);
        await lockSmsEndpointPolicy(queryDatabase, input);
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
            'The endpoint-status append did not identify a retained SMS endpoint.',
          );
        }
        return appendSmsEndpointStatus(
          queryDatabase,
          input,
          { population: endpoint.population, channel: 'sms' },
          await readDatabaseTime(queryDatabase),
          uuid,
        );
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
        await lockSmsEndpointPolicy(queryDatabase, input);
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
            providerOccurredAt: new Date(record.providerOccurredAt),
            recordedAt,
          });
        }
        await appendSmsEndpointStatus(
          queryDatabase,
          RecordEndpointStatusInputSchema.parse({
            rosterSnapshotId: input.rosterSnapshotId,
            recipientId: input.recipientId,
            endpointId: input.endpointId,
            status: 'disabled',
            reasonCode: SMS_OPT_OUT_REASON_CODE,
            provider: input.provider,
            providerReference: input.providerReference,
            providerOccurredAt: input.providerOccurredAt,
          }),
          { population: endpoint.population, channel: 'sms' },
          recordedAt,
          uuid,
        );
        return record;
      });
    },
  });
}
