import {
  RecordSmsOptOutInputSchema,
  RosterSnapshotIdSchema,
  SmsEndpointSchema,
  SmsOptOutRecordSchema,
  type RecordSmsOptOutInput,
  type SmsOptOutRecord,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import { AWS_EUM_SMS_PROVIDER } from './delivery-events';

const OPT_OUT_LIST_NAME_PATTERN = /^[A-Za-z0-9_:/-]{1,256}$/u;
const NEXT_TOKEN_PATTERN = /^.{1,1024}$/u;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9._:/+=-]{1,500}$/u;
const MAX_RESULTS_PER_PAGE = 100;
const MAX_RECONCILIATION_PAGES = 100;
const MAX_RECONCILIATION_RECORDS = 1_200;

export type SmsOptOutErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'OPT_OUT_PAGINATION_EXCEEDED'
  | 'OPT_OUT_RESULT_EXCEEDED'
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
  readonly MaxResults: 100;
  readonly NextToken?: string;
}

export interface AwsEumOptOutTransport {
  describeOptedOutNumbers(
    input: AwsEumDescribeOptedOutNumbersRequest,
  ): Promise<unknown>;
}

export interface SmsOptOutReconcilerOptions {
  readonly transport: AwsEumOptOutTransport;
  readonly resolver: SmsOptOutDestinationResolver;
  readonly recorder: SmsOptOutRecorder;
  readonly optOutListName: string;
}

export interface SmsOptOutReconcileInput {
  readonly rosterSnapshotId: string;
}

export interface SmsOptOutReconcileReport {
  readonly examinedCount: number;
  readonly recordedCount: number;
  readonly unresolvedCount: number;
  readonly pageCount: number;
}

interface ParsedOptedOutNumber {
  readonly phoneNumber: string;
  readonly optedOutAtMilliseconds: number;
}

interface ParsedOptOutPage {
  readonly optOutListName: string;
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

function parseOptOutListName(value: string): string {
  if (!OPT_OUT_LIST_NAME_PATTERN.test(value)) {
    throw new SmsOptOutError('INVALID_CONFIGURATION');
  }
  return value;
}

function parseOptOutPage(value: unknown): ParsedOptOutPage {
  if (!isPlainRecord(value) || !Array.isArray(value.OptedOutNumbers)) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  if (
    typeof value.OptOutListName !== 'string' ||
    !OPT_OUT_LIST_NAME_PATTERN.test(value.OptOutListName)
  ) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  if (value.OptedOutNumbers.length > MAX_RESULTS_PER_PAGE) {
    throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
  }
  const numbers: ParsedOptedOutNumber[] = [];
  for (const candidate of value.OptedOutNumbers) {
    if (!isPlainRecord(candidate)) {
      throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
    }
    if (candidate.EndUserOptedOut !== true) {
      if (candidate.EndUserOptedOut !== false) {
        throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
      }
      continue;
    }
    const endpoint = SmsEndpointSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'active',
      capturedAt: '2026-01-01T00:00:00.000Z',
      channel: 'sms',
      phoneNumber: candidate.OptedOutNumber,
    });
    if (
      !endpoint.success ||
      !Number.isSafeInteger(candidate.OptedOutTimestamp) ||
      (candidate.OptedOutTimestamp as number) < 0
    ) {
      throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
    }
    numbers.push(
      Object.freeze({
        phoneNumber: endpoint.data.phoneNumber,
        optedOutAtMilliseconds: candidate.OptedOutTimestamp as number,
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
    optOutListName: value.OptOutListName,
    numbers: Object.freeze(numbers),
    nextToken,
  });
}

function optOutProviderReference(
  optOutListName: string,
  optedOutAtMilliseconds: number,
): string {
  return parseProviderReference(
    `opt-out:${optOutListName}:${optedOutAtMilliseconds}`,
  );
}

/**
 * Captures the managed-list send conflict using the already resolved endpoint.
 * No phone number enters the retained capability input.
 */
export async function recordAwsManagedOptOutConflict(
  workValue: WorkerAttemptWorkItem | unknown,
  providerRequestId: string,
  recorder: SmsOptOutRecorder,
): Promise<SmsOptOutRecord> {
  const workItem = parseWorkerAttemptWorkItem(workValue);
  if (workItem.batch.channel !== 'sms' || workItem.endpoint.channel !== 'sms') {
    throw new SmsOptOutError('OPT_OUT_ENDPOINT_MISMATCH');
  }
  if (typeof recorder?.recordSmsOptOut !== 'function') {
    throw new SmsOptOutError('INVALID_CONFIGURATION');
  }
  const input = RecordSmsOptOutInputSchema.parse({
    rosterSnapshotId: workItem.batch.rosterSnapshotId,
    recipientId: workItem.attempt.recipientId,
    endpointId: workItem.endpoint.id,
    provider: AWS_EUM_SMS_PROVIDER,
    providerReference: parseProviderReference(providerRequestId),
  });
  return SmsOptOutRecordSchema.parse(await recorder.recordSmsOptOut(input));
}

/**
 * Reconciles AWS-managed STOP state off the critical send path. Results expose
 * only counts; destination numbers are discarded after exact endpoint lookup.
 */
export class SmsOptOutReconciler {
  readonly #transport: AwsEumOptOutTransport;
  readonly #resolver: SmsOptOutDestinationResolver;
  readonly #recorder: SmsOptOutRecorder;
  readonly #optOutListName: string;

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
    this.#optOutListName = parseOptOutListName(options.optOutListName);
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
    let nextToken: string | null = null;
    const seenTokens = new Set<string>();

    do {
      pageCount += 1;
      if (pageCount > MAX_RECONCILIATION_PAGES) {
        throw new SmsOptOutError('OPT_OUT_PAGINATION_EXCEEDED');
      }
      const response = await this.#transport.describeOptedOutNumbers({
        OptOutListName: this.#optOutListName,
        MaxResults: MAX_RESULTS_PER_PAGE,
        ...(nextToken === null ? {} : { NextToken: nextToken }),
      });
      const page = parseOptOutPage(response);
      if (page.optOutListName !== this.#optOutListName) {
        throw new SmsOptOutError('INVALID_PROVIDER_RESPONSE');
      }
      for (const number of page.numbers) {
        examinedCount += 1;
        if (examinedCount > MAX_RECONCILIATION_RECORDS) {
          throw new SmsOptOutError('OPT_OUT_RESULT_EXCEEDED');
        }
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
        const record = await this.#recorder.recordSmsOptOut(
          RecordSmsOptOutInputSchema.parse({
            rosterSnapshotId: resolved.rosterSnapshotId,
            recipientId: resolved.recipientId,
            endpointId: resolved.endpointId,
            provider: AWS_EUM_SMS_PROVIDER,
            providerReference: optOutProviderReference(
              this.#optOutListName,
              number.optedOutAtMilliseconds,
            ),
          }),
        );
        SmsOptOutRecordSchema.parse(record);
        recordedCount += 1;
      }
      nextToken = page.nextToken;
      if (nextToken !== null) {
        if (seenTokens.has(nextToken)) {
          throw new SmsOptOutError('OPT_OUT_PAGINATION_EXCEEDED');
        }
        seenTokens.add(nextToken);
      }
    } while (nextToken !== null);

    return Object.freeze({
      examinedCount,
      recordedCount,
      unresolvedCount,
      pageCount,
    });
  }
}
