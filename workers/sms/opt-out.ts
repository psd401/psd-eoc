import {
  EndpointStatusRecordSchema,
  RecordEndpointStatusInputSchema,
  RecordSmsOptOutInputSchema,
  RosterSnapshotIdSchema,
  SMS_LIFECYCLE_PROVIDER,
  SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
  SmsEndpointSchema,
  SmsOptOutRecordSchema,
  TimestampSchema,
  UuidSchema,
  type EndpointStatusRecord,
  type RecordEndpointStatusInput,
  type RecordSmsOptOutInput,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import { AWS_EUM_SMS_PROVIDER } from './delivery-events';

const OPT_OUT_LIST_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const OPT_OUT_LIST_ARN_PATTERN =
  /^arn:[a-z0-9-]+:sms-voice:[a-z0-9-]{1,32}:[0-9]{12}:opt-out-list\/([A-Za-z0-9_-]{1,64})$/u;
const NEXT_TOKEN_PATTERN = /^.{1,1024}$/u;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9._:/+=-]{1,500}$/u;
const MAX_RESULTS_PER_PAGE = 100;
const MAX_RECONCILIATION_PAGES = 100;
const MAX_RECONCILIATION_RECORDS = 1_200;

export const SMS_PROVIDER_VERIFIED_OPT_IN_REASON =
  SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE;

export type SmsOptOutErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVOCATION_UNVERIFIED'
  | 'PROVIDER_READ_FAILED'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'INVALID_RECORDER_RESPONSE'
  | 'OPT_OUT_PAGINATION_EXCEEDED'
  | 'OPT_OUT_ENDPOINT_MISMATCH';

/** Safe opt-out failure which never repeats a phone number. */
export class SmsOptOutError extends Error {
  public constructor(public readonly code: SmsOptOutErrorCode) {
    super('The SMS opt-out operation failed safely.');
    this.name = 'SmsOptOutError';
  }
}

export interface SmsOptOutRecorder {
  recordSmsOptOut(input: RecordSmsOptOutInput): Promise<SmsOptOutRecord>;
}

/** Canonical `record-endpoint-status` execution boundary. */
export interface SmsEndpointStatusRecorder {
  recordEndpointStatus(
    input: RecordEndpointStatusInput,
  ): Promise<EndpointStatusRecord>;
}

export interface SmsOptOutDestinationResolver {
  resolveSmsDestination(input: {
    readonly rosterSnapshotId: string;
    readonly phoneNumber: string;
  }): Promise<Readonly<{
    rosterSnapshotId: string;
    recipientId: string;
    endpointId: string;
  }> | null>;
}

export interface AwsEumDescribeOptedOutNumbersRequest {
  readonly OptOutListName: string;
  readonly MaxResults: 1 | 100;
  readonly NextToken?: string;
  readonly OptedOutNumbers?: readonly [string];
}

export interface AwsEumOptOutListIdentity {
  readonly name: string;
  readonly arn: string;
}

export interface AwsEumOptOutTransport {
  describeOptedOutNumbers(
    input: AwsEumDescribeOptedOutNumbersRequest,
  ): Promise<unknown>;
}

/** Trusted inbound-keyword facts supplied separately from AWS response data. */
export interface SmsOptInInvocation {
  readonly requestId: string;
  readonly keyword: 'START' | 'UNSTOP';
  /** Authenticated inbound sender used for the exact filtered provider read. */
  readonly phoneNumber: string;
  /** Authenticated provider-webhook occurrence time used for causal ordering. */
  readonly occurredAt: string;
  readonly authorization: unknown;
}

export type SmsOptInInvocationAuthorizer = (
  invocation: SmsOptInInvocation,
) => boolean | Promise<boolean>;

export interface RecordAwsManagedOptInOptions {
  readonly transport: AwsEumOptOutTransport;
  readonly resolver: SmsOptOutDestinationResolver;
  readonly recorder: SmsEndpointStatusRecorder;
  readonly authorizeInvocation: SmsOptInInvocationAuthorizer;
}

export interface SmsOptOutReconcilerOptions {
  readonly transport: AwsEumOptOutTransport;
  readonly resolver: SmsOptOutDestinationResolver;
  readonly recorder: SmsOptOutRecorder;
  readonly optOutListName: string;
  readonly optOutListArn: string;
}

export interface SmsOptOutReconcileInput {
  readonly rosterSnapshotId: string;
  readonly continuationToken?: string | null;
}

export interface SmsOptOutReconcileReport {
  readonly examinedCount: number;
  readonly recordedCount: number;
  readonly unresolvedCount: number;
  readonly pageCount: number;
  readonly continuationToken: string | null;
}

interface ParsedOptedOutNumber {
  readonly phoneNumber: string;
  readonly optedOutAtMilliseconds: number;
}

interface ParsedOptOutPage {
  readonly numbers: readonly ParsedOptedOutNumber[];
  readonly nextToken: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function parseProviderReference(value: string): string {
  if (!PROVIDER_REFERENCE_PATTERN.test(value)) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  return value;
}

function parseOptOutListIdentity(
  value: AwsEumOptOutListIdentity | unknown,
): Readonly<AwsEumOptOutListIdentity> {
  if (
    !isPlainRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.arn !== 'string'
  ) {
    throw new SmsOptOutError('INVALID_CONFIGURATION');
  }
  const arnMatch = OPT_OUT_LIST_ARN_PATTERN.exec(value.arn);
  if (
    !OPT_OUT_LIST_NAME_PATTERN.test(value.name) ||
    arnMatch === null ||
    arnMatch[1] !== value.name
  ) {
    throw new SmsOptOutError('INVALID_CONFIGURATION');
  }
  return Object.freeze({ name: value.name, arn: value.arn });
}

/** Validates and copies the exact configured AWS managed opt-out list. */
export function validateAwsEumOptOutListIdentity(
  value: AwsEumOptOutListIdentity | unknown,
): Readonly<AwsEumOptOutListIdentity> {
  return parseOptOutListIdentity(value);
}

function parseProviderTimestamp(value: unknown): number {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  return milliseconds;
}

function parseSmsPhoneNumber(value: unknown): string {
  const endpoint = SmsEndpointSchema.safeParse({
    id: '00000000-0000-4000-8000-000000000001',
    status: 'active',
    capturedAt: '2026-01-01T00:00:00.000Z',
    channel: 'sms',
    phoneNumber: value,
  });
  if (!endpoint.success) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  return endpoint.data.phoneNumber;
}

function assertProviderListIdentity(
  value: Record<string, unknown>,
  expected: AwsEumOptOutListIdentity,
): void {
  if (
    value.OptOutListName !== expected.name ||
    value.OptOutListArn !== expected.arn
  ) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
}

function parseOptOutPage(
  value: unknown,
  expectedList: AwsEumOptOutListIdentity,
): ParsedOptOutPage {
  if (!isPlainRecord(value) || !Array.isArray(value.OptedOutNumbers)) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  assertProviderListIdentity(value, expectedList);
  if (value.OptedOutNumbers.length > MAX_RESULTS_PER_PAGE) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  const numbers: ParsedOptedOutNumber[] = [];
  for (const candidate of value.OptedOutNumbers) {
    if (!isPlainRecord(candidate)) {
      throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
    }
    if (
      candidate.EndUserOptedOut !== true &&
      candidate.EndUserOptedOut !== false
    ) {
      throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
    }
    numbers.push(
      Object.freeze({
        phoneNumber: parseSmsPhoneNumber(candidate.OptedOutNumber),
        optedOutAtMilliseconds: parseProviderTimestamp(
          candidate.OptedOutTimestamp,
        ),
      }),
    );
  }
  let nextToken: string | null = null;
  if (value.NextToken !== undefined) {
    if (
      typeof value.NextToken !== 'string' ||
      !NEXT_TOKEN_PATTERN.test(value.NextToken)
    ) {
      throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
    }
    nextToken = value.NextToken;
  }
  return Object.freeze({
    numbers: Object.freeze(numbers),
    nextToken,
  });
}

async function loadOptOutPage(
  transport: AwsEumOptOutTransport,
  request: AwsEumDescribeOptedOutNumbersRequest,
  expectedList: AwsEumOptOutListIdentity,
): Promise<ParsedOptOutPage> {
  let response: unknown;
  try {
    response = await transport.describeOptedOutNumbers(request);
  } catch {
    // AWS errors are untrusted and can echo request data such as a staff phone
    // number. Surface only this fixed, PII-free domain error.
    throw new SmsOptOutError('PROVIDER_READ_FAILED');
  }
  return parseOptOutPage(response, expectedList);
}

function parseExactSmsOptOutRecord(
  value: unknown,
  input: RecordSmsOptOutInput,
): SmsOptOutRecord {
  const record = SmsOptOutRecordSchema.safeParse(value);
  if (
    !record.success ||
    record.data.rosterSnapshotId !== input.rosterSnapshotId ||
    record.data.recipientId !== input.recipientId ||
    record.data.endpointId !== input.endpointId ||
    record.data.provider !== input.provider ||
    record.data.providerReference !== input.providerReference ||
    record.data.providerOccurredAt !== input.providerOccurredAt
  ) {
    throw new SmsOptOutError('INVALID_RECORDER_RESPONSE');
  }
  return record.data;
}

function parseExactEndpointStatusRecord(
  value: unknown,
  input: RecordEndpointStatusInput,
): EndpointStatusRecord {
  const record = EndpointStatusRecordSchema.safeParse(value);
  if (
    !record.success ||
    record.data.rosterSnapshotId !== input.rosterSnapshotId ||
    record.data.recipientId !== input.recipientId ||
    record.data.endpointId !== input.endpointId ||
    record.data.status !== input.status ||
    record.data.reasonCode !== input.reasonCode ||
    record.data.provider !== input.provider ||
    record.data.providerReference !== input.providerReference ||
    record.data.providerOccurredAt !== input.providerOccurredAt
  ) {
    throw new SmsOptOutError('INVALID_RECORDER_RESPONSE');
  }
  return record.data;
}

function optOutProviderReference(
  optOutListArn: string,
  optedOutAtMilliseconds: number,
): string {
  return parseProviderReference(
    `opt-out:${optOutListArn}:${optedOutAtMilliseconds}`,
  );
}

function optInProviderReference(
  optOutListArn: string,
  requestId: string,
): string {
  return parseProviderReference(`opt-in:${optOutListArn}:${requestId}`);
}

/**
 * Captures the managed-list send conflict using the already resolved endpoint.
 * No phone number enters the retained capability input.
 */
export async function recordAwsManagedOptOutConflict(
  workValue: WorkerAttemptWorkItem | unknown,
  providerRequestId: string,
  providerOccurredAt: string,
  recorder: SmsOptOutRecorder,
): Promise<SmsOptOutRecord> {
  const workItem = parseWorkerAttemptWorkItem(workValue);
  const occurredAt = TimestampSchema.safeParse(providerOccurredAt);
  if (workItem.batch.channel !== 'sms' || workItem.endpoint.channel !== 'sms') {
    throw new SmsOptOutError('OPT_OUT_ENDPOINT_MISMATCH');
  }
  if (!occurredAt.success || typeof recorder?.recordSmsOptOut !== 'function') {
    throw new SmsOptOutError('INVALID_CONFIGURATION');
  }
  const input = RecordSmsOptOutInputSchema.parse({
    rosterSnapshotId: workItem.batch.rosterSnapshotId,
    recipientId: workItem.attempt.recipientId,
    endpointId: workItem.endpoint.id,
    provider: AWS_EUM_SMS_PROVIDER,
    providerReference: parseProviderReference(providerRequestId),
    providerOccurredAt: new Date(occurredAt.data).toISOString(),
  });
  return parseExactSmsOptOutRecord(
    await recorder.recordSmsOptOut(input),
    input,
  );
}

/**
 * Appends an active supersession fact only after an authenticated inbound
 * START/UNSTOP and a filtered provider read prove that AWS's keyword action
 * removed that exact sender from the exact configured list. Administrative
 * removal alone cannot manufacture the authenticated keyword invocation.
 */
export async function recordAwsManagedOptIn(
  inputValue: Readonly<{ rosterSnapshotId: string }>,
  listValue: AwsEumOptOutListIdentity,
  invocation: SmsOptInInvocation,
  options: RecordAwsManagedOptInOptions,
): Promise<EndpointStatusRecord | null> {
  const rosterSnapshotId = RosterSnapshotIdSchema.safeParse(
    inputValue.rosterSnapshotId,
  );
  const occurredAt = TimestampSchema.safeParse(invocation?.occurredAt);
  const list = parseOptOutListIdentity(listValue);
  if (
    !rosterSnapshotId.success ||
    typeof options.transport?.describeOptedOutNumbers !== 'function' ||
    typeof options.resolver?.resolveSmsDestination !== 'function' ||
    typeof options.recorder?.recordEndpointStatus !== 'function' ||
    typeof options.authorizeInvocation !== 'function'
  ) {
    throw new SmsOptOutError('INVALID_CONFIGURATION');
  }
  if (
    !isPlainRecord(invocation) ||
    !UuidSchema.safeParse(invocation.requestId).success ||
    (invocation.keyword !== 'START' && invocation.keyword !== 'UNSTOP') ||
    !occurredAt.success
  ) {
    throw new SmsOptOutError('INVOCATION_UNVERIFIED');
  }
  let invocationPhoneNumber: string;
  try {
    invocationPhoneNumber = parseSmsPhoneNumber(invocation.phoneNumber);
  } catch {
    throw new SmsOptOutError('INVOCATION_UNVERIFIED');
  }
  let authorized = false;
  try {
    authorized = (await options.authorizeInvocation(invocation)) === true;
  } catch {
    authorized = false;
  }
  if (!authorized) {
    throw new SmsOptOutError('INVOCATION_UNVERIFIED');
  }
  const verification = await loadOptOutPage(
    options.transport,
    {
      OptOutListName: list.arn,
      MaxResults: 1,
      OptedOutNumbers: [invocationPhoneNumber],
    },
    list,
  );
  if (verification.numbers.length !== 0 || verification.nextToken !== null) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  const resolved = await options.resolver.resolveSmsDestination({
    rosterSnapshotId: rosterSnapshotId.data,
    phoneNumber: invocationPhoneNumber,
  });
  if (resolved === null) return null;
  if (resolved.rosterSnapshotId !== rosterSnapshotId.data) {
    throw new SmsOptOutError('OPT_OUT_ENDPOINT_MISMATCH');
  }
  const input = RecordEndpointStatusInputSchema.parse({
    rosterSnapshotId: resolved.rosterSnapshotId,
    recipientId: resolved.recipientId,
    endpointId: resolved.endpointId,
    status: 'active',
    reasonCode: SMS_PROVIDER_VERIFIED_OPT_IN_REASON,
    provider: SMS_LIFECYCLE_PROVIDER,
    providerReference: optInProviderReference(list.arn, invocation.requestId),
    providerOccurredAt: new Date(occurredAt.data).toISOString(),
  });
  return parseExactEndpointStatusRecord(
    await options.recorder.recordEndpointStatus(input),
    input,
  );
}

/**
 * Reconciles AWS-managed STOP state off the critical send path. Results expose
 * only counts; destination numbers are discarded after exact endpoint lookup.
 */
export class SmsOptOutReconciler {
  readonly #transport: AwsEumOptOutTransport;
  readonly #resolver: SmsOptOutDestinationResolver;
  readonly #recorder: SmsOptOutRecorder;
  readonly #optOutList: Readonly<AwsEumOptOutListIdentity>;

  public constructor(options: SmsOptOutReconcilerOptions) {
    if (
      typeof options.transport?.describeOptedOutNumbers !== 'function' ||
      typeof options.resolver?.resolveSmsDestination !== 'function' ||
      typeof options.recorder?.recordSmsOptOut !== 'function'
    ) {
      throw new SmsOptOutError('INVALID_CONFIGURATION');
    }
    this.#transport = options.transport;
    this.#resolver = options.resolver;
    this.#recorder = options.recorder;
    this.#optOutList = parseOptOutListIdentity({
      name: options.optOutListName,
      arn: options.optOutListArn,
    });
  }

  public async reconcile(
    input: SmsOptOutReconcileInput,
  ): Promise<SmsOptOutReconcileReport> {
    const rosterSnapshotId = RosterSnapshotIdSchema.safeParse(
      input.rosterSnapshotId,
    );
    if (!rosterSnapshotId.success) {
      throw new SmsOptOutError('INVALID_CONFIGURATION');
    }
    let examinedCount = 0;
    let recordedCount = 0;
    let unresolvedCount = 0;
    let pageCount = 0;
    const suppliedToken = input.continuationToken ?? null;
    if (
      suppliedToken !== null &&
      (typeof suppliedToken !== 'string' ||
        !NEXT_TOKEN_PATTERN.test(suppliedToken))
    ) {
      throw new SmsOptOutError('INVALID_CONFIGURATION');
    }
    let nextToken: string | null = suppliedToken;
    const seenTokens = new Set<string>();

    do {
      pageCount += 1;
      const requestedToken = nextToken;
      const page = await loadOptOutPage(
        this.#transport,
        {
          OptOutListName: this.#optOutList.arn,
          MaxResults: MAX_RESULTS_PER_PAGE,
          ...(requestedToken === null ? {} : { NextToken: requestedToken }),
        },
        this.#optOutList,
      );
      if (examinedCount + page.numbers.length > MAX_RECONCILIATION_RECORDS) {
        return Object.freeze({
          examinedCount,
          recordedCount,
          unresolvedCount,
          pageCount: pageCount - 1,
          continuationToken: requestedToken,
        });
      }
      for (const number of page.numbers) {
        examinedCount += 1;
        const resolved = await this.#resolver.resolveSmsDestination({
          rosterSnapshotId: rosterSnapshotId.data,
          phoneNumber: number.phoneNumber,
        });
        if (resolved === null) {
          unresolvedCount += 1;
          continue;
        }
        if (resolved.rosterSnapshotId !== rosterSnapshotId.data) {
          throw new SmsOptOutError('OPT_OUT_ENDPOINT_MISMATCH');
        }
        const recordInput = RecordSmsOptOutInputSchema.parse({
          rosterSnapshotId: resolved.rosterSnapshotId,
          recipientId: resolved.recipientId,
          endpointId: resolved.endpointId,
          provider: AWS_EUM_SMS_PROVIDER,
          providerReference: optOutProviderReference(
            this.#optOutList.arn,
            number.optedOutAtMilliseconds,
          ),
          providerOccurredAt: new Date(
            number.optedOutAtMilliseconds,
          ).toISOString(),
        });
        parseExactSmsOptOutRecord(
          await this.#recorder.recordSmsOptOut(recordInput),
          recordInput,
        );
        recordedCount += 1;
      }
      nextToken = page.nextToken;
      if (nextToken !== null) {
        if (nextToken === requestedToken || seenTokens.has(nextToken)) {
          throw new SmsOptOutError('OPT_OUT_PAGINATION_EXCEEDED');
        }
        seenTokens.add(nextToken);
      }
      if (
        nextToken !== null &&
        (examinedCount >= MAX_RECONCILIATION_RECORDS ||
          pageCount >= MAX_RECONCILIATION_PAGES)
      ) {
        return Object.freeze({
          examinedCount,
          recordedCount,
          unresolvedCount,
          pageCount,
          continuationToken: nextToken,
        });
      }
    } while (nextToken !== null);

    return Object.freeze({
      examinedCount,
      recordedCount,
      unresolvedCount,
      pageCount,
      continuationToken: null,
    });
  }
}
