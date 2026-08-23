import { createHash } from 'node:crypto';

import {
  RecordDeliveryEvidenceInputSchema,
  type IntegrationTruthLabel,
} from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import {
  type AttemptIdempotentProviderAdapter,
  type ProviderSendOutcome,
  type ProviderSendRequest,
} from '../shared/processor';
import { ProviderDispatchError } from '../shared/retry';
import {
  buildEmailMessageContent,
  type EmailMessageContent,
} from './email-message';
import { SES_CONFIGURATION_SET_NAME } from './ses-events';

export const SES_EMAIL_INTEGRATION_ID = 'ses-email' as const;
export const SES_V2_PROVIDER = 'aws-ses-v2' as const;
export { SES_CONFIGURATION_SET_NAME };

export const SES_CORRELATION_TAG_NAMES = Object.freeze({
  attemptId: 'psd-eoc-attempt-id',
  endpointId: 'psd-eoc-endpoint-id',
  rosterSnapshotId: 'psd-eoc-roster-snapshot-id',
  recipientId: 'psd-eoc-recipient-id',
  templateMode: 'psd-eoc-template-mode',
  eventKind: 'psd-eoc-event-kind',
});

const SAFE_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._@:/+=-]+$/u;

export interface SesV2MessagePart {
  readonly Charset: 'UTF-8';
  readonly Data: string;
}

export interface SesV2SendEmailInput {
  readonly FromEmailAddress: string;
  readonly Destination: Readonly<{
    ToAddresses: readonly [string];
  }>;
  readonly Content: Readonly<{
    Simple: Readonly<{
      Subject: SesV2MessagePart;
      Body: Readonly<{
        Text: SesV2MessagePart;
        Html: SesV2MessagePart;
      }>;
    }>;
  }>;
  readonly ConfigurationSetName: typeof SES_CONFIGURATION_SET_NAME;
  readonly EmailTags: readonly Readonly<{
    Name: string;
    Value: string;
  }>[];
}

/**
 * Minimal injected SES v2 boundary; the worker package owns no AWS SDK.
 * Implementations may throw ProviderDispatchError only when they can classify
 * provider acceptance from a confirmed response or pre-dispatch failure.
 */
export interface SesV2Client {
  sendEmail(input: SesV2SendEmailInput): Promise<unknown>;
}

export interface SesSendLedgerClaimRequest {
  readonly attemptId: string;
  readonly requestFingerprint: string;
}

export interface SesSendLedgerCompleteRequest
  extends SesSendLedgerClaimRequest {
  readonly leaseToken: string;
  readonly outcome: ProviderSendOutcome;
}

export interface SesSendLedgerReleaseRequest extends SesSendLedgerClaimRequest {
  readonly leaseToken: string;
}

export type SesSendLedgerClaim =
  | Readonly<{ kind: 'acquired'; leaseToken: string }>
  | Readonly<{ kind: 'in-progress' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'completed'; outcome: ProviderSendOutcome }>;

/**
 * A live adapter requires a durable ledger in front of SES because SendEmail
 * has no attempt-ID idempotency facility. An implementation must retain an
 * acquired claim after ambiguous provider I/O; it must never release it for a
 * blind resend. It may release a claim only when the injected client proves
 * that no provider acceptance was possible.
 */
export interface DurableSesSendLedger {
  readonly durability: 'durable';
  claim(request: SesSendLedgerClaimRequest): Promise<SesSendLedgerClaim>;
  complete(request: SesSendLedgerCompleteRequest): Promise<void>;
  release(request: SesSendLedgerReleaseRequest): Promise<void>;
}

export interface SesV2EmailAdapterOptions {
  readonly client: SesV2Client;
  readonly sendLedger: DurableSesSendLedger;
  readonly fromEmailAddress: string;
  readonly truthLabel: IntegrationTruthLabel;
}

export type SesV2EmailAdapterErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_LEDGER_CLAIM';

/** Safe configuration failure that never includes credentials or addresses. */
export class SesV2EmailAdapterError extends Error {
  public constructor(public readonly code: SesV2EmailAdapterErrorCode) {
    super('The SES email adapter is not configured safely.');
    this.name = 'SesV2EmailAdapterError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const EMAIL_LOCAL_ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const EMAIL_LOCAL_PART_PATTERN = new RegExp(
  `^${EMAIL_LOCAL_ATOM}(?:\\.${EMAIL_LOCAL_ATOM})*$`,
  'u',
);
const EMAIL_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;

export function validSesFromEmailAddress(value: string): boolean {
  if (
    typeof value !== 'string' ||
    value.length > 320 ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  ) {
    return false;
  }
  const separator = value.lastIndexOf('@');
  const localPart = value.slice(0, separator);
  return (
    separator > 0 &&
    localPart.length <= 64 &&
    EMAIL_LOCAL_PART_PATTERN.test(localPart) &&
    EMAIL_DOMAIN_PATTERN.test(value.slice(separator + 1))
  );
}

function parseOptions(options: SesV2EmailAdapterOptions): Readonly<{
  client: SesV2Client;
  sendLedger: DurableSesSendLedger;
  fromEmailAddress: string;
}> {
  if (
    options === null ||
    typeof options !== 'object' ||
    options.truthLabel !== 'live-verified' ||
    options.client === null ||
    typeof options.client !== 'object' ||
    typeof options.client.sendEmail !== 'function' ||
    options.sendLedger === null ||
    typeof options.sendLedger !== 'object' ||
    options.sendLedger.durability !== 'durable' ||
    typeof options.sendLedger.claim !== 'function' ||
    typeof options.sendLedger.complete !== 'function' ||
    typeof options.sendLedger.release !== 'function' ||
    !validSesFromEmailAddress(options.fromEmailAddress)
  ) {
    throw new SesV2EmailAdapterError('INVALID_CONFIGURATION');
  }
  return Object.freeze({
    client: options.client,
    sendLedger: options.sendLedger,
    fromEmailAddress: options.fromEmailAddress,
  });
}

function parseWork(request: ProviderSendRequest): Readonly<{
  workItem: WorkerAttemptWorkItem &
    Readonly<{
      endpoint: WorkerAttemptWorkItem['endpoint'] &
        Readonly<{ channel: 'email'; email: string }>;
    }>;
  message: EmailMessageContent;
}> {
  const workItem = parseWorkerAttemptWorkItem(request.workItem);
  if (
    request.idempotencyKey !== workItem.attempt.id ||
    workItem.batch.channel !== 'email' ||
    workItem.attempt.channel !== 'email' ||
    workItem.endpoint.channel !== 'email' ||
    workItem.batch.integrationStatus.integrationId !==
      SES_EMAIL_INTEGRATION_ID ||
    workItem.batch.integrationStatus.label !== 'live-verified' ||
    workItem.batch.rosterPopulation === 'synthetic'
  ) {
    throw new ProviderDispatchError(
      'SES_WORK_ITEM_REJECTED',
      'terminal-failure',
    );
  }
  return Object.freeze({
    workItem: workItem as WorkerAttemptWorkItem &
      Readonly<{
        endpoint: WorkerAttemptWorkItem['endpoint'] &
          Readonly<{ channel: 'email'; email: string }>;
      }>,
    message: buildEmailMessageContent(workItem.batch.renderedMessage),
  });
}

function part(data: string): SesV2MessagePart {
  return Object.freeze({ Charset: 'UTF-8', Data: data });
}

function correlationTags(
  workItem: WorkerAttemptWorkItem,
): SesV2SendEmailInput['EmailTags'] {
  const attempt = workItem.attempt;
  return Object.freeze([
    Object.freeze({
      Name: SES_CORRELATION_TAG_NAMES.attemptId,
      Value: attempt.id,
    }),
    Object.freeze({
      Name: SES_CORRELATION_TAG_NAMES.endpointId,
      Value: attempt.endpointId,
    }),
    Object.freeze({
      Name: SES_CORRELATION_TAG_NAMES.rosterSnapshotId,
      Value: attempt.rosterSnapshotId,
    }),
    Object.freeze({
      Name: SES_CORRELATION_TAG_NAMES.recipientId,
      Value: attempt.recipientId,
    }),
    Object.freeze({
      Name: SES_CORRELATION_TAG_NAMES.templateMode,
      Value: attempt.templateMode,
    }),
    Object.freeze({
      Name: SES_CORRELATION_TAG_NAMES.eventKind,
      Value: attempt.eventKind,
    }),
  ]);
}

function buildSendInput(
  fromEmailAddress: string,
  workItem: WorkerAttemptWorkItem &
    Readonly<{
      endpoint: WorkerAttemptWorkItem['endpoint'] &
        Readonly<{ channel: 'email'; email: string }>;
    }>,
  message: EmailMessageContent,
): SesV2SendEmailInput {
  return Object.freeze({
    FromEmailAddress: fromEmailAddress,
    Destination: Object.freeze({
      ToAddresses: Object.freeze([workItem.endpoint.email]) as readonly [
        string,
      ],
    }),
    Content: Object.freeze({
      Simple: Object.freeze({
        Subject: part(message.subject),
        Body: Object.freeze({
          Text: part(message.textBody),
          Html: part(message.htmlBody),
        }),
      }),
    }),
    ConfigurationSetName: SES_CONFIGURATION_SET_NAME,
    EmailTags: correlationTags(workItem),
  });
}

function requestFingerprint(input: SesV2SendEmailInput): string {
  return createHash('sha256')
    .update(JSON.stringify(input), 'utf8')
    .digest('hex');
}

function acceptedOutcome(messageId: string): ProviderSendOutcome {
  return Object.freeze({
    state: 'provider-accepted',
    provider: SES_V2_PROVIDER,
    providerReference: messageId,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
}

function unknownOutcome(
  reasonCode: string,
  diagnosticDigest: string | null = null,
): ProviderSendOutcome {
  return Object.freeze({
    state: 'unknown',
    provider: SES_V2_PROVIDER,
    providerReference: null,
    proof: null,
    reasonCode,
    diagnosticDigest,
  });
}

function failedOutcome(
  reasonCode: string,
  diagnosticDigest: string | null,
): ProviderSendOutcome {
  return Object.freeze({
    state: 'failed',
    provider: SES_V2_PROVIDER,
    providerReference: null,
    proof: null,
    reasonCode,
    diagnosticDigest,
  });
}

function parseMessageId(value: unknown): string | null {
  if (!isPlainRecord(value)) return null;
  const messageId = value.MessageId;
  return typeof messageId === 'string' &&
    messageId.length >= 1 &&
    messageId.length <= 500 &&
    messageId.trim() === messageId &&
    SAFE_MESSAGE_ID_PATTERN.test(messageId)
    ? messageId
    : null;
}

function parseStoredOutcome(
  value: ProviderSendOutcome | unknown,
  attemptId: string,
): ProviderSendOutcome {
  if (!isPlainRecord(value)) {
    throw new SesV2EmailAdapterError('INVALID_LEDGER_CLAIM');
  }
  const parsed = RecordDeliveryEvidenceInputSchema.safeParse({
    ...value,
    // The ledger cannot substitute another evidence subject at runtime.
    subject: { kind: 'attempt', attemptId },
  });
  if (
    !parsed.success ||
    !['provider-accepted', 'failed', 'unknown'].includes(parsed.data.state) ||
    parsed.data.provider !== SES_V2_PROVIDER
  ) {
    throw new SesV2EmailAdapterError('INVALID_LEDGER_CLAIM');
  }
  return Object.freeze({
    state: parsed.data.state,
    provider: parsed.data.provider,
    providerReference: parsed.data.providerReference,
    proof: parsed.data.proof,
    reasonCode: parsed.data.reasonCode,
    diagnosticDigest: parsed.data.diagnosticDigest,
  }) as ProviderSendOutcome;
}

function parseLedgerClaim(
  value: SesSendLedgerClaim | unknown,
  attemptId: string,
): SesSendLedgerClaim {
  if (!isPlainRecord(value)) {
    throw new SesV2EmailAdapterError('INVALID_LEDGER_CLAIM');
  }
  if (value.kind === 'in-progress') {
    return Object.freeze({ kind: 'in-progress' });
  }
  if (value.kind === 'conflict') {
    return Object.freeze({ kind: 'conflict' });
  }
  if (value.kind === 'acquired') {
    if (
      typeof value.leaseToken !== 'string' ||
      value.leaseToken.length < 1 ||
      value.leaseToken.length > 512 ||
      value.leaseToken.trim() !== value.leaseToken
    ) {
      throw new SesV2EmailAdapterError('INVALID_LEDGER_CLAIM');
    }
    return Object.freeze({ kind: 'acquired', leaseToken: value.leaseToken });
  }
  if (value.kind === 'completed') {
    return Object.freeze({
      kind: 'completed',
      outcome: parseStoredOutcome(value.outcome, attemptId),
    });
  }
  throw new SesV2EmailAdapterError('INVALID_LEDGER_CLAIM');
}

/**
 * Live SES adapter. Construction and direct sends both fail closed unless the
 * canonical integration is live-verified and a durable send ledger is present.
 */
export class SesV2EmailAdapter implements AttemptIdempotentProviderAdapter {
  public readonly channel = 'email' as const;
  public readonly integrationId = SES_EMAIL_INTEGRATION_ID;
  public readonly truthLabel = 'live-verified' as const;
  public readonly provider = SES_V2_PROVIDER;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;

  readonly #client: SesV2Client;
  readonly #ledger: DurableSesSendLedger;
  readonly #fromEmailAddress: string;

  public constructor(options: SesV2EmailAdapterOptions) {
    const parsed = parseOptions(options);
    this.#client = parsed.client;
    this.#ledger = parsed.sendLedger;
    this.#fromEmailAddress = parsed.fromEmailAddress;
  }

  public async send(
    request: ProviderSendRequest,
  ): Promise<ProviderSendOutcome> {
    const { workItem, message } = parseWork(request);
    const input = buildSendInput(this.#fromEmailAddress, workItem, message);
    const claimRequest = Object.freeze({
      attemptId: workItem.attempt.id,
      requestFingerprint: requestFingerprint(input),
    });

    let claim: SesSendLedgerClaim;
    try {
      claim = parseLedgerClaim(
        await this.#ledger.claim(claimRequest),
        workItem.attempt.id,
      );
    } catch (error) {
      if (error instanceof SesV2EmailAdapterError) throw error;
      throw new ProviderDispatchError(
        'SES_SEND_LEDGER_UNAVAILABLE',
        'safe-to-retry',
      );
    }

    if (claim.kind === 'completed') return claim.outcome;
    if (claim.kind === 'in-progress') {
      return unknownOutcome('SES_SEND_ALREADY_CLAIMED');
    }
    if (claim.kind === 'conflict') {
      throw new ProviderDispatchError(
        'SES_SEND_LEDGER_CONFLICT',
        'terminal-failure',
      );
    }

    let outcome: ProviderSendOutcome;
    try {
      const response = await this.#client.sendEmail(input);
      const messageId = parseMessageId(response);
      outcome =
        messageId === null
          ? unknownOutcome('SES_RESPONSE_INVALID')
          : acceptedOutcome(messageId);
    } catch (error) {
      if (
        error instanceof ProviderDispatchError &&
        error.disposition === 'safe-to-retry'
      ) {
        // The injected client may use this disposition only when it has proof
        // that SES could not have accepted the request. Releasing the fence is
        // therefore safe and lets the shared processor schedule its bounded
        // retry as a new immutable attempt. If release itself fails, a stale
        // fence can only suppress this attempt; it cannot create a duplicate.
        try {
          await this.#ledger.release({
            ...claimRequest,
            leaseToken: claim.leaseToken,
          });
        } catch {
          // Preserve the provider classification even when a ledger method
          // throws before returning a promise or rejects asynchronously.
        }
        throw error;
      }
      if (
        error instanceof ProviderDispatchError &&
        error.disposition === 'terminal-failure'
      ) {
        outcome = failedOutcome(error.code, error.diagnosticDigest);
      } else {
        // Raw transport failures and explicitly ambiguous provider failures
        // may have followed acceptance. Without a provider idempotency token,
        // a retry would risk a duplicate logical send.
        outcome = unknownOutcome(
          error instanceof ProviderDispatchError
            ? error.code
            : 'SES_SEND_OUTCOME_UNKNOWN',
          error instanceof ProviderDispatchError
            ? error.diagnosticDigest
            : null,
        );
      }
    }

    try {
      await this.#ledger.complete({
        ...claimRequest,
        leaseToken: claim.leaseToken,
        outcome,
      });
    } catch {
      // The durable acquired claim remains a no-resend fence. Return the known
      // provider truth; a signed SES callback can recover missing completion.
    }
    return outcome;
  }
}
