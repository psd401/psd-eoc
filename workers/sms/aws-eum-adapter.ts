import { createHash } from 'node:crypto';

import {
  RecordDeliveryEvidenceInputSchema,
  SMS_PROVIDER_MINIMUM_TTL_SECONDS,
  SmsProviderSendAuthorizationSchema,
  type SmsProviderSendAuthorization,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  workerAttemptFingerprint,
  type AttemptIdempotentProviderAdapter,
  type ProviderFailureDisposition,
  type ProviderRecoveryResult,
  type ProviderSendOutcome,
  type ProviderSendRequest,
  ProviderDispatchError,
  type WorkerAttemptWorkItem,
} from '../shared';

export const AWS_EUM_SMS_INTEGRATION_ID = 'aws-eum-sms' as const;
export const AWS_EUM_SMS_PROVIDER = 'aws-eum-sms' as const;

export const AWS_EUM_SMS_GSM_MAX_SEPTETS = 1_530;
export const AWS_EUM_SMS_UCS2_MAX_CODE_UNITS = 630;

const SINGLE_PART_GSM_MAX_SEPTETS = 160;
const SINGLE_PART_UCS2_MAX_CODE_UNITS = 70;

const DEFAULT_LEDGER_LEASE_MILLISECONDS = 2 * 60_000;
const MAX_LEDGER_LEASE_MILLISECONDS = 15 * 60_000;
const SAFE_CODE_PATTERN = /^[A-Z0-9_]+$/u;
const SAFE_IDENTIFIER_PATTERN = /^[\x21-\x7e]+$/u;

const GSM_BASIC_CHARACTERS = new Set([
  '@',
  '£',
  '$',
  '¥',
  'è',
  'é',
  'ù',
  'ì',
  'ò',
  'Ç',
  '\n',
  'Ø',
  'ø',
  '\r',
  'Å',
  'å',
  'Δ',
  '_',
  'Φ',
  'Γ',
  'Λ',
  'Ω',
  'Π',
  'Ψ',
  'Σ',
  'Θ',
  'Ξ',
  'Æ',
  'æ',
  'ß',
  'É',
  ' ',
  '!',
  '"',
  '#',
  '¤',
  '%',
  '&',
  "'",
  '(',
  ')',
  '*',
  '+',
  ',',
  '-',
  '.',
  '/',
  ':',
  ';',
  '<',
  '=',
  '>',
  '?',
  '¡',
  'Ä',
  'Ö',
  'Ñ',
  'Ü',
  '§',
  '¿',
  'ä',
  'ö',
  'ñ',
  'ü',
  'à',
  ...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
]);

const GSM_EXTENSION_CHARACTERS = new Set([
  '^',
  '{',
  '}',
  '\\',
  '[',
  ']',
  '~',
  '|',
  '€',
]);

/** Exact provider request passed to a dependency-injected AWS client. */
export interface AwsEumSendTextMessageRequest {
  readonly DestinationPhoneNumber: string;
  readonly OriginationIdentity: string;
  readonly MessageBody: string;
  readonly MessageType: 'TRANSACTIONAL';
  readonly ConfigurationSetName: string;
  readonly MaxPrice: string;
  readonly TimeToLive: number;
  readonly Context: Readonly<{
    psdAttemptId: string;
    psdProviderClaimToken: string;
  }>;
  readonly DryRun: false;
  readonly ProtectConfigurationId: string;
}

/** Minimal SDK-independent provider boundary. Provider responses are untrusted. */
export interface AwsEumSmsClient {
  /**
   * The provider transport performs exactly one wire attempt per invocation.
   * AWS SDK clients with their default retry middleware do not satisfy this
   * boundary because retries would occur below the durable send ledger.
   */
  readonly deliverySemantics: 'single-wire-attempt';
  sendTextMessage(request: AwsEumSendTextMessageRequest): Promise<unknown>;
}

export interface AwsEumSmsLengthMeasurement {
  readonly encoding: 'gsm-7' | 'ucs-2';
  readonly units: number;
  readonly exceedsProviderLimit: boolean;
}

export interface AwsEumSmsLedgerClaimRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly leaseMilliseconds: number;
}

export interface AwsEumSmsLedgerLookupRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
}

export interface AwsEumSmsLedgerErrorCompletion {
  readonly kind: 'provider-error';
  readonly code: string;
  readonly disposition: ProviderFailureDisposition;
  readonly diagnosticDigest: string | null;
}

export interface AwsEumSmsLedgerOutcomeCompletion {
  readonly kind: 'outcome';
  readonly outcome: ProviderSendOutcome;
}

export type AwsEumSmsLedgerCompletion =
  | AwsEumSmsLedgerErrorCompletion
  | AwsEumSmsLedgerOutcomeCompletion;

export type AwsEumSmsLedgerClaim =
  | Readonly<{ kind: 'acquired'; leaseToken: string }>
  | Readonly<{ kind: 'completed'; completion: AwsEumSmsLedgerCompletion }>
  | Readonly<{ kind: 'in-progress' }>
  | Readonly<{ kind: 'indeterminate' }>;

export type AwsEumSmsLedgerLookup =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'completed'; completion: AwsEumSmsLedgerCompletion }>
  | Readonly<{ kind: 'in-progress' }>
  | Readonly<{ kind: 'indeterminate' }>;

export interface AwsEumSmsLedgerCompleteRequest {
  readonly attemptId: string;
  readonly fingerprint: string;
  readonly leaseToken: string;
  readonly completion: AwsEumSmsLedgerCompletion;
}

/**
 * Durable provider-send ledger. A claim that may have crossed the AWS side
 * effect must recover as `completed` or `indeterminate`, never as `acquired`.
 */
export interface AwsEumSmsSendLedger {
  /** Read-only recovery is always allowed and can never acquire send rights. */
  lookup(request: AwsEumSmsLedgerLookupRequest): Promise<AwsEumSmsLedgerLookup>;
  claim(request: AwsEumSmsLedgerClaimRequest): Promise<AwsEumSmsLedgerClaim>;
  complete(request: AwsEumSmsLedgerCompleteRequest): Promise<void>;
}

export type AwsEumSmsProviderAuthorizer = (
  workItem: WorkerAttemptWorkItem,
) => SmsProviderSendAuthorization | Promise<SmsProviderSendAuthorization>;

export interface AwsEumSmsAdapterOptions {
  readonly client: AwsEumSmsClient;
  readonly ledger: AwsEumSmsSendLedger;
  readonly originationIdentity: string;
  readonly configurationSetName: string;
  readonly protectConfigurationId: string;
  readonly maxPrice: string;
  readonly timeToLiveSeconds: number;
  /** Omission and false both keep the live provider dark. */
  readonly featureEnabled?: boolean;
  /** Fresh full-work-item authorization immediately before provider I/O. */
  readonly authorizeProviderSend?: AwsEumSmsProviderAuthorizer;
  /** Monotonic-enough wall clock used to age the server-issued provider TTL. */
  readonly clock?: () => number;
  readonly ledgerLeaseMilliseconds?: number;
}

type ParsedSmsProviderRequest = Readonly<{
  workItem: WorkerAttemptWorkItem &
    Readonly<{
      endpoint: Extract<WorkerAttemptWorkItem['endpoint'], { channel: 'sms' }>;
      batch: WorkerAttemptWorkItem['batch'] &
        Readonly<{
          renderedMessage: Extract<
            WorkerAttemptWorkItem['batch']['renderedMessage'],
            { channel: 'sms' }
          >;
        }>;
    }>;
  idempotencyKey: string;
}>;

interface NormalizedAwsEumFailure {
  readonly name: string | null;
  readonly reason: string | null;
  readonly requestId: string | null;
  readonly status: number | null;
  readonly diagnosticDigest: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function safeString(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    SAFE_IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

function safeCode(value: unknown): string | null {
  const parsed = safeString(value, 100);
  return parsed !== null && SAFE_CODE_PATTERN.test(parsed) ? parsed : null;
}

function safeStatus(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : null;
}

/**
 * Defense-in-depth copy of the SMS encoding and AWS provider-ceiling
 * calculation. The final send boundary separately applies the stricter
 * one-part product policy; canonical rendering remains server `sms-policy.ts`.
 */
export function measureAwsEumSmsLength(
  value: string,
): AwsEumSmsLengthMeasurement {
  let septets = 0;
  for (const character of value) {
    if (GSM_BASIC_CHARACTERS.has(character)) {
      septets += 1;
      continue;
    }
    if (GSM_EXTENSION_CHARACTERS.has(character)) {
      septets += 2;
      continue;
    }
    return Object.freeze({
      encoding: 'ucs-2' as const,
      units: value.length,
      exceedsProviderLimit: value.length > AWS_EUM_SMS_UCS2_MAX_CODE_UNITS,
    });
  }
  return Object.freeze({
    encoding: 'gsm-7' as const,
    units: septets,
    exceedsProviderLimit: septets > AWS_EUM_SMS_GSM_MAX_SEPTETS,
  });
}

function exceedsSmsSendLengthPolicy(
  measurement: AwsEumSmsLengthMeasurement,
): boolean {
  return (
    measurement.exceedsProviderLimit ||
    (measurement.encoding === 'gsm-7'
      ? measurement.units > SINGLE_PART_GSM_MAX_SEPTETS
      : measurement.units > SINGLE_PART_UCS2_MAX_CODE_UNITS)
  );
}

/** Strict channel request validation shared with the fail-closed CI mock. */
export function parseSmsProviderSendRequest(
  requestValue: ProviderSendRequest | unknown,
): ParsedSmsProviderRequest {
  if (!isPlainRecord(requestValue)) {
    throw new ProviderDispatchError(
      'AWS_EUM_WORK_ITEM_INVALID',
      'terminal-failure',
    );
  }
  let workItem: WorkerAttemptWorkItem;
  try {
    workItem = parseWorkerAttemptWorkItem(requestValue.workItem);
  } catch {
    throw new ProviderDispatchError(
      'AWS_EUM_WORK_ITEM_INVALID',
      'terminal-failure',
    );
  }
  const length = measureAwsEumSmsLength(
    workItem.batch.renderedMessage.channel === 'sms'
      ? workItem.batch.renderedMessage.body
      : '',
  );
  if (
    typeof requestValue.idempotencyKey !== 'string' ||
    requestValue.idempotencyKey !== workItem.attempt.id ||
    workItem.batch.channel !== 'sms' ||
    workItem.endpoint.channel !== 'sms' ||
    workItem.batch.renderedMessage.channel !== 'sms' ||
    workItem.batch.integrationId !== AWS_EUM_SMS_INTEGRATION_ID ||
    exceedsSmsSendLengthPolicy(length)
  ) {
    throw new ProviderDispatchError(
      'AWS_EUM_WORK_ITEM_INVALID',
      'terminal-failure',
    );
  }
  return Object.freeze({
    workItem: workItem as ParsedSmsProviderRequest['workItem'],
    idempotencyKey: requestValue.idempotencyKey,
  });
}

function requiredConfigurationValue(value: string, pattern: RegExp): string {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    !pattern.test(value)
  ) {
    throw new TypeError('AWS EUM SMS adapter configuration is invalid.');
  }
  return value;
}

function parseMaxPrice(value: string): string {
  if (!/^[0-9]{1,2}\.[0-9]{1,5}$/u.test(value) || Number(value) <= 0) {
    throw new TypeError('AWS EUM SMS adapter configuration is invalid.');
  }
  return value;
}

function parseTimeToLive(value: number): number {
  // Emergency notifications should not emerge from a provider queue hours
  // later. AWS permits a larger range; this adapter deliberately stays short.
  if (!Number.isInteger(value) || value < 5 || value > 15 * 60) {
    throw new TypeError('AWS EUM SMS adapter configuration is invalid.');
  }
  return value;
}

function parseLease(value: number | undefined): number {
  const parsed = value ?? DEFAULT_LEDGER_LEASE_MILLISECONDS;
  if (
    !Number.isInteger(parsed) ||
    parsed < 1_000 ||
    parsed > MAX_LEDGER_LEASE_MILLISECONDS
  ) {
    throw new TypeError('AWS EUM SMS adapter configuration is invalid.');
  }
  return parsed;
}

function normalizeAwsEumFailure(value: unknown): NormalizedAwsEumFailure {
  const record =
    value !== null && typeof value === 'object'
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  const metadata =
    record !== null &&
    record.$metadata !== null &&
    typeof record.$metadata === 'object' &&
    !Array.isArray(record.$metadata)
      ? (record.$metadata as Readonly<Record<string, unknown>>)
      : null;
  const name =
    safeString(record?.name, 100) ?? safeString(record?.code, 100) ?? null;
  const reason = safeCode(record?.Reason) ?? safeCode(record?.reason) ?? null;
  const requestId =
    safeString(metadata?.requestId, 500) ??
    safeString(record?.requestId, 500) ??
    null;
  const status =
    safeStatus(metadata?.httpStatusCode) ?? safeStatus(record?.statusCode);
  const diagnosticDigest = createHash('sha256')
    .update(
      JSON.stringify({
        name,
        reason,
        requestId,
        status,
      }),
      'utf8',
    )
    .digest('hex');
  return Object.freeze({
    name,
    reason,
    requestId,
    status,
    diagnosticDigest,
  });
}

function providerErrorFor(
  failure: NormalizedAwsEumFailure,
): ProviderDispatchError {
  const terminalCodes = Object.freeze({
    AccessDeniedException: 'AWS_EUM_ACCESS_DENIED',
    BadRequestException: 'AWS_EUM_REQUEST_INVALID',
    ConflictException: 'AWS_EUM_CONFLICT',
    ResourceNotFoundException: 'AWS_EUM_RESOURCE_NOT_FOUND',
    ServiceQuotaExceededException: 'AWS_EUM_QUOTA_EXCEEDED',
    ValidationException: 'AWS_EUM_REQUEST_INVALID',
  } as const);
  if (failure.name === 'ThrottlingException') {
    return new ProviderDispatchError(
      'AWS_EUM_THROTTLED',
      'safe-to-retry',
      failure.diagnosticDigest,
    );
  }
  const terminalCode =
    failure.name === null
      ? undefined
      : terminalCodes[failure.name as keyof typeof terminalCodes];
  if (terminalCode !== undefined) {
    return new ProviderDispatchError(
      terminalCode,
      'terminal-failure',
      failure.diagnosticDigest,
    );
  }
  return new ProviderDispatchError(
    'AWS_EUM_OUTCOME_AMBIGUOUS',
    'ambiguous',
    failure.diagnosticDigest,
  );
}

function optOutOutcome(failure: NormalizedAwsEumFailure): ProviderSendOutcome {
  return Object.freeze({
    state: 'failed' as const,
    provider: AWS_EUM_SMS_PROVIDER,
    providerReference: failure.requestId,
    proof: null,
    reasonCode: 'DESTINATION_PHONE_NUMBER_OPTED_OUT',
    diagnosticDigest: failure.diagnosticDigest,
  });
}

function responseOutcome(value: unknown): ProviderSendOutcome {
  const record = isPlainRecord(value) ? value : null;
  const messageId = safeString(record?.MessageId, 500);
  if (messageId === null) {
    throw new ProviderDispatchError('AWS_EUM_RESPONSE_INVALID', 'ambiguous');
  }
  return Object.freeze({
    state: 'provider-accepted' as const,
    provider: AWS_EUM_SMS_PROVIDER,
    providerReference: messageId,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
}

function parseErrorCompletion(value: unknown): AwsEumSmsLedgerErrorCompletion {
  if (!isPlainRecord(value)) {
    throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
  const code = safeCode(value.code);
  const disposition = value.disposition;
  const digest = value.diagnosticDigest;
  if (
    value.kind !== 'provider-error' ||
    code === null ||
    !['safe-to-retry', 'terminal-failure', 'ambiguous'].includes(
      String(disposition),
    ) ||
    !(
      digest === null ||
      (typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest))
    )
  ) {
    throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
  return Object.freeze({
    kind: 'provider-error',
    code,
    disposition: disposition as ProviderFailureDisposition,
    diagnosticDigest: digest,
  });
}

function parseOutcomeCompletion(
  value: unknown,
  attemptId: string,
): AwsEumSmsLedgerOutcomeCompletion {
  if (!isPlainRecord(value) || value.kind !== 'outcome') {
    throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
  const parsed = RecordDeliveryEvidenceInputSchema.safeParse({
    subject: { kind: 'attempt', attemptId },
    ...(isPlainRecord(value.outcome) ? value.outcome : {}),
  });
  if (
    !parsed.success ||
    !['provider-accepted', 'failed', 'expired', 'unknown'].includes(
      parsed.data.state,
    ) ||
    parsed.data.provider !== AWS_EUM_SMS_PROVIDER
  ) {
    throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
  return Object.freeze({
    kind: 'outcome',
    outcome: Object.freeze({
      state: parsed.data.state,
      provider: parsed.data.provider,
      providerReference: parsed.data.providerReference,
      proof: parsed.data.proof,
      reasonCode: parsed.data.reasonCode,
      diagnosticDigest: parsed.data.diagnosticDigest,
    }) as ProviderSendOutcome,
  });
}

function parseLedgerCompletion(
  value: unknown,
  attemptId: string,
): AwsEumSmsLedgerCompletion {
  return isPlainRecord(value) && value.kind === 'provider-error'
    ? parseErrorCompletion(value)
    : parseOutcomeCompletion(value, attemptId);
}

function replayCompletion(
  completion: AwsEumSmsLedgerCompletion,
): ProviderSendOutcome {
  if (completion.kind === 'outcome') return completion.outcome;
  throw new ProviderDispatchError(
    completion.code,
    completion.disposition,
    completion.diagnosticDigest,
  );
}

function parseLedgerClaim(
  value: AwsEumSmsLedgerClaim,
  attemptId: string,
): AwsEumSmsLedgerClaim {
  if (!isPlainRecord(value)) {
    throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
  switch (value.kind) {
    case 'acquired': {
      const leaseToken = safeString(value.leaseToken, 512);
      if (leaseToken === null) {
        throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
      }
      return Object.freeze({ kind: 'acquired', leaseToken });
    }
    case 'completed':
      return Object.freeze({
        kind: 'completed',
        completion: parseLedgerCompletion(value.completion, attemptId),
      });
    case 'in-progress':
      return Object.freeze({ kind: 'in-progress' });
    case 'indeterminate':
      return Object.freeze({ kind: 'indeterminate' });
    default:
      throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
}

function parseLedgerLookup(
  value: AwsEumSmsLedgerLookup,
  attemptId: string,
): AwsEumSmsLedgerLookup {
  if (!isPlainRecord(value)) {
    throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
  switch (value.kind) {
    case 'missing':
      return Object.freeze({ kind: 'missing' });
    case 'completed':
      return Object.freeze({
        kind: 'completed',
        completion: parseLedgerCompletion(value.completion, attemptId),
      });
    case 'in-progress':
      return Object.freeze({ kind: 'in-progress' });
    case 'indeterminate':
      return Object.freeze({ kind: 'indeterminate' });
    default:
      throw new ProviderDispatchError('AWS_EUM_LEDGER_INVALID', 'ambiguous');
  }
}

function errorCompletion(
  error: ProviderDispatchError,
): AwsEumSmsLedgerErrorCompletion {
  return Object.freeze({
    kind: 'provider-error',
    code: error.code,
    disposition: error.disposition,
    diagnosticDigest: error.diagnosticDigest,
  });
}

/** Live AWS adapter. It remains dark unless every explicit gate allows a send. */
export class AwsEumSmsAdapter implements AttemptIdempotentProviderAdapter {
  public readonly channel = 'sms' as const;
  public readonly integrationId = AWS_EUM_SMS_INTEGRATION_ID;
  public readonly provider = AWS_EUM_SMS_PROVIDER;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;

  readonly #client: AwsEumSmsClient;
  readonly #ledger: AwsEumSmsSendLedger;
  readonly #featureEnabled: boolean;
  readonly #authorizeProviderSend: AwsEumSmsProviderAuthorizer | undefined;
  readonly #clock: () => number;
  readonly #ledgerLeaseMilliseconds: number;
  readonly #requestConfiguration: Readonly<
    Pick<
      AwsEumSendTextMessageRequest,
      | 'OriginationIdentity'
      | 'ConfigurationSetName'
      | 'ProtectConfigurationId'
      | 'MaxPrice'
      | 'TimeToLive'
    >
  >;

  public constructor(options: AwsEumSmsAdapterOptions) {
    if (
      options.client.deliverySemantics !== 'single-wire-attempt' ||
      typeof options.client.sendTextMessage !== 'function'
    ) {
      throw new TypeError(
        'AWS EUM SMS client must guarantee one wire attempt per send.',
      );
    }
    this.#client = options.client;
    this.#ledger = options.ledger;
    this.#featureEnabled = options.featureEnabled === true;
    this.#authorizeProviderSend = options.authorizeProviderSend;
    this.#clock = options.clock ?? Date.now;
    this.#ledgerLeaseMilliseconds = parseLease(options.ledgerLeaseMilliseconds);
    this.#requestConfiguration = Object.freeze({
      OriginationIdentity: requiredConfigurationValue(
        options.originationIdentity,
        /^[A-Za-z0-9_:/+-]+$/u,
      ),
      ConfigurationSetName: requiredConfigurationValue(
        options.configurationSetName,
        /^[A-Za-z0-9_:/-]+$/u,
      ),
      ProtectConfigurationId: requiredConfigurationValue(
        options.protectConfigurationId,
        /^[A-Za-z0-9_:/-]+$/u,
      ),
      MaxPrice: parseMaxPrice(options.maxPrice),
      TimeToLive: parseTimeToLive(options.timeToLiveSeconds),
    });
  }

  /** Read-only recovery used before an outer worker live-send gate. */
  public async recover(
    requestValue: ProviderSendRequest,
  ): Promise<ProviderRecoveryResult> {
    let workItem: WorkerAttemptWorkItem;
    try {
      workItem = parseWorkerAttemptWorkItem(requestValue.workItem);
    } catch {
      return Object.freeze({ kind: 'missing' });
    }
    if (
      requestValue.idempotencyKey !== workItem.attempt.id ||
      workItem.batch.channel !== 'sms' ||
      workItem.endpoint.channel !== 'sms' ||
      workItem.batch.integrationId !== AWS_EUM_SMS_INTEGRATION_ID
    ) {
      return Object.freeze({ kind: 'missing' });
    }
    const fingerprint = workerAttemptFingerprint(workItem);
    let recovered: AwsEumSmsLedgerLookup;
    try {
      recovered = parseLedgerLookup(
        await this.#ledger.lookup({
          attemptId: requestValue.idempotencyKey,
          fingerprint,
        }),
        requestValue.idempotencyKey,
      );
    } catch (error) {
      if (error instanceof ProviderDispatchError) throw error;
      throw new ProviderDispatchError(
        'AWS_EUM_LEDGER_UNAVAILABLE',
        'ambiguous',
      );
    }
    if (recovered.kind === 'completed') {
      if (recovered.completion.kind === 'outcome') {
        return Object.freeze({
          kind: 'outcome',
          outcome: replayCompletion(recovered.completion),
        });
      }
      const error = recovered.completion;
      return Object.freeze({
        kind: 'provider-error',
        error: new ProviderDispatchError(
          error.code,
          error.disposition,
          error.diagnosticDigest,
        ),
      });
    }
    if (recovered.kind === 'missing') {
      return Object.freeze({ kind: 'missing' });
    }
    if (recovered.kind === 'in-progress') {
      return Object.freeze({ kind: 'in-progress' });
    }
    return Object.freeze({
      kind: 'provider-error',
      error: new ProviderDispatchError(
        'AWS_EUM_LEDGER_INDETERMINATE',
        'ambiguous',
        null,
      ),
    });
  }

  public async send(
    requestValue: ProviderSendRequest,
  ): Promise<ProviderSendOutcome> {
    const request = parseSmsProviderSendRequest(requestValue);
    const fingerprint = workerAttemptFingerprint(request.workItem);
    let recovered: AwsEumSmsLedgerLookup;
    try {
      recovered = parseLedgerLookup(
        await this.#ledger.lookup({
          attemptId: request.idempotencyKey,
          fingerprint,
        }),
        request.idempotencyKey,
      );
    } catch (error) {
      if (error instanceof ProviderDispatchError) throw error;
      throw new ProviderDispatchError(
        'AWS_EUM_LEDGER_UNAVAILABLE',
        'ambiguous',
      );
    }
    if (recovered.kind === 'completed') {
      return replayCompletion(recovered.completion);
    }
    if (recovered.kind === 'in-progress') {
      throw new ProviderDispatchError(
        'AWS_EUM_LEDGER_IN_PROGRESS',
        'ambiguous',
      );
    }
    if (recovered.kind === 'indeterminate') {
      throw new ProviderDispatchError(
        'AWS_EUM_LEDGER_INDETERMINATE',
        'ambiguous',
      );
    }

    const authorizeProviderSend = this.#authorizeProviderSend;
    if (!this.#featureEnabled || authorizeProviderSend === undefined) {
      throw new ProviderDispatchError(
        'AWS_EUM_FEATURE_DISABLED',
        'terminal-failure',
      );
    }

    let claim: AwsEumSmsLedgerClaim;
    try {
      claim = parseLedgerClaim(
        await this.#ledger.claim({
          attemptId: request.idempotencyKey,
          fingerprint,
          leaseMilliseconds: this.#ledgerLeaseMilliseconds,
        }),
        request.idempotencyKey,
      );
    } catch (error) {
      if (error instanceof ProviderDispatchError) throw error;
      throw new ProviderDispatchError(
        'AWS_EUM_LEDGER_UNAVAILABLE',
        'ambiguous',
      );
    }
    if (claim.kind === 'completed') {
      return replayCompletion(claim.completion);
    }
    if (claim.kind === 'in-progress') {
      throw new ProviderDispatchError(
        'AWS_EUM_LEDGER_IN_PROGRESS',
        'ambiguous',
      );
    }
    if (claim.kind === 'indeterminate') {
      throw new ProviderDispatchError(
        'AWS_EUM_LEDGER_INDETERMINATE',
        'ambiguous',
      );
    }

    const complete = async (
      completion: AwsEumSmsLedgerCompletion,
    ): Promise<void> => {
      try {
        await this.#ledger.complete({
          attemptId: request.idempotencyKey,
          fingerprint,
          leaseToken: claim.leaseToken,
          completion,
        });
      } catch {
        throw new ProviderDispatchError(
          'AWS_EUM_LEDGER_COMMIT_AMBIGUOUS',
          'ambiguous',
        );
      }
    };

    // The durable provider ledger claim above is the irreversible-send fence.
    // Re-read full endpoint and integration truth after that fence, with no
    // awaited work between this decision and the single provider wire attempt.
    const authorizationUnavailable = async (
      code:
        | 'AWS_EUM_AUTHORIZATION_UNAVAILABLE'
        | 'AWS_EUM_AUTHORIZATION_EXPIRED',
    ): Promise<never> => {
      const failure = new ProviderDispatchError(code, 'safe-to-retry');
      await complete(errorCompletion(failure));
      throw failure;
    };
    let authorizationStartedAt: number;
    let providerAuthorization: SmsProviderSendAuthorization;
    try {
      authorizationStartedAt = this.#clock();
      if (!Number.isFinite(authorizationStartedAt)) {
        throw new TypeError('SMS authorization clock is invalid.');
      }
      providerAuthorization = SmsProviderSendAuthorizationSchema.parse(
        await authorizeProviderSend(request.workItem),
      );
    } catch {
      return authorizationUnavailable('AWS_EUM_AUTHORIZATION_UNAVAILABLE');
    }
    if (!providerAuthorization.authorized) {
      const denial = new ProviderDispatchError(
        'AWS_EUM_SEND_UNAUTHORIZED',
        'terminal-failure',
      );
      await complete(errorCompletion(denial));
      throw denial;
    }
    let timeToLiveSeconds: number;
    try {
      const authorizedAt = this.#clock();
      if (
        !Number.isFinite(authorizedAt) ||
        authorizedAt < authorizationStartedAt
      ) {
        throw new TypeError('SMS authorization clock is invalid.');
      }
      timeToLiveSeconds = Math.min(
        this.#requestConfiguration.TimeToLive,
        providerAuthorization.timeToLiveSeconds -
          Math.ceil((authorizedAt - authorizationStartedAt) / 1_000),
      );
    } catch {
      return authorizationUnavailable('AWS_EUM_AUTHORIZATION_UNAVAILABLE');
    }
    if (timeToLiveSeconds < SMS_PROVIDER_MINIMUM_TTL_SECONDS) {
      return authorizationUnavailable('AWS_EUM_AUTHORIZATION_EXPIRED');
    }

    const providerRequest: AwsEumSendTextMessageRequest = Object.freeze({
      DestinationPhoneNumber: request.workItem.endpoint.phoneNumber,
      OriginationIdentity: this.#requestConfiguration.OriginationIdentity,
      MessageBody: request.workItem.batch.renderedMessage.body,
      MessageType: 'TRANSACTIONAL',
      ConfigurationSetName: this.#requestConfiguration.ConfigurationSetName,
      MaxPrice: this.#requestConfiguration.MaxPrice,
      TimeToLive: timeToLiveSeconds,
      Context: Object.freeze({
        psdAttemptId: request.idempotencyKey,
        psdProviderClaimToken: claim.leaseToken,
      }),
      DryRun: false,
      ProtectConfigurationId: this.#requestConfiguration.ProtectConfigurationId,
    });

    let response: unknown;
    try {
      response = await this.#client.sendTextMessage(providerRequest);
    } catch (error) {
      const failure = normalizeAwsEumFailure(error);
      if (
        failure.name === 'ConflictException' &&
        failure.reason === 'DESTINATION_PHONE_NUMBER_OPTED_OUT'
      ) {
        const outcome = optOutOutcome(failure);
        await complete(Object.freeze({ kind: 'outcome', outcome }));
        return outcome;
      }
      const mapped = providerErrorFor(failure);
      await complete(errorCompletion(mapped));
      throw mapped;
    }

    let outcome: ProviderSendOutcome;
    try {
      outcome = responseOutcome(response);
    } catch (error) {
      const mapped =
        error instanceof ProviderDispatchError
          ? error
          : new ProviderDispatchError('AWS_EUM_RESPONSE_INVALID', 'ambiguous');
      await complete(errorCompletion(mapped));
      throw mapped;
    }
    await complete(Object.freeze({ kind: 'outcome', outcome }));
    return outcome;
  }
}
