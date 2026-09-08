import { RecordDeliveryEvidenceInputSchema } from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  workerAttemptFingerprint,
  type WorkerAttemptWorkItem,
} from '../shared/attempt';
import type {
  AttemptIdempotentProviderAdapter,
  ProviderRecoveryResult,
  ProviderSendOutcome,
  ProviderSendRequest,
} from '../shared/processor';
import {
  ProviderDispatchError,
  normalizeProviderFailure,
  type ProviderFailure,
} from '../shared/retry';
import type {
  DurableExpoSendLedger,
  ExpoSendLedgerClaim,
  ExpoSendLedgerCompletion,
  ExpoSendLedgerLookup,
} from './adapter';
import {
  PushEndpointEligibilityError,
  type PushEndpointEligibilityChecker,
} from './eligibility';
import {
  APNS_DIRECT_PROVIDER,
  FCM_DIRECT_PROVIDER,
  createDirectPushMessage,
  expiredDirectPush,
  parseDirectPushProviderOutcome,
  unknownDirectPush,
  type DirectPushProvider,
  type DirectPushPreparation,
  type DirectPushProviderOutcome,
  type DirectPushTransport,
} from './direct-protocol';

export const DIRECT_PUSH_INTEGRATION_ID = 'mobile-push' as const;

const FAILURE_DISPOSITIONS = Object.freeze({
  DIRECT_PUSH_ENDPOINT_ELIGIBILITY_BLOCKED: 'terminal-failure',
  DIRECT_PUSH_ENDPOINT_ELIGIBILITY_UNAVAILABLE: 'safe-to-retry',
  DIRECT_PUSH_LEDGER_FAILED: 'ambiguous',
  DIRECT_PUSH_LIVE_TRANSPORT_DISABLED: 'terminal-failure',
} satisfies Readonly<Record<string, ProviderFailure['disposition']>>);

const RETRYABLE_PROVIDER_REASONS: ReadonlySet<string> = new Set([
  'APNS_SERVER_ERROR',
  'APNS_THROTTLED',
  'FCM_SERVER_ERROR',
  'FCM_THROTTLED',
  'FCM_AUTHENTICATION_UNAVAILABLE',
]);

export interface LedgeredDirectPushAdapterOptions {
  readonly transport: DirectPushTransport;
  readonly sendLedger: DurableExpoSendLedger;
  readonly endpointEligibility: PushEndpointEligibilityChecker;
  /** Final authorization immediately before the transport may perform I/O. */
  readonly authorizeLiveTransport?: (
    workItem: WorkerAttemptWorkItem,
  ) => boolean | Promise<boolean>;
  readonly clock?: () => Date | string | number;
}

function providerReason(
  provider: DirectPushProvider,
): 'APNS_RESPONSE_INVALID' | 'FCM_RESPONSE_INVALID' {
  return provider === APNS_DIRECT_PROVIDER
    ? 'APNS_RESPONSE_INVALID'
    : 'FCM_RESPONSE_INVALID';
}

function unknownOutcome(provider: DirectPushProvider): ProviderSendOutcome {
  return outcomeFromDirect(
    unknownDirectPush(
      provider === APNS_DIRECT_PROVIDER
        ? 'APNS_NETWORK_OUTCOME_AMBIGUOUS'
        : 'FCM_NETWORK_OUTCOME_AMBIGUOUS',
    ),
    provider,
  );
}

function outcomeFromDirect(
  outcome: DirectPushProviderOutcome,
  provider: DirectPushProvider,
): ProviderSendOutcome {
  return Object.freeze({
    state: outcome.state,
    provider,
    providerReference: outcome.providerReference,
    proof: null,
    reasonCode: outcome.reasonCode,
    diagnosticDigest: null,
    ...(outcome.providerOccurredAt === null
      ? {}
      : { providerOccurredAt: outcome.providerOccurredAt }),
  }) as ProviderSendOutcome;
}

function completionFromDirect(
  outcome: DirectPushProviderOutcome,
  provider: DirectPushProvider,
): ExpoSendLedgerCompletion {
  if (outcome.kind === 'retryable-failure') {
    return Object.freeze({
      kind: 'failure',
      failure: normalizeProviderFailure(
        new ProviderDispatchError(outcome.reasonCode, 'safe-to-retry'),
      ),
    });
  }
  return Object.freeze({
    kind: 'outcome',
    outcome: outcomeFromDirect(outcome, provider),
  });
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseClaim(value: unknown): ExpoSendLedgerClaim | null {
  const record = exactRecord(value);
  if (record === null || typeof record.kind !== 'string') return null;
  if (record.kind === 'execute') {
    return Object.keys(record).length === 2 &&
      typeof record.claimToken === 'string' &&
      record.claimToken.length >= 1 &&
      record.claimToken.length <= 512
      ? Object.freeze({ kind: 'execute', claimToken: record.claimToken })
      : null;
  }
  if (
    (record.kind === 'uncertain' || record.kind === 'conflict') &&
    Object.keys(record).length === 1
  ) {
    return Object.freeze({ kind: record.kind });
  }
  if (
    record.kind === 'completed' &&
    Object.keys(record).length === 2 &&
    exactRecord(record.completion) !== null
  ) {
    return Object.freeze({
      kind: 'completed',
      completion: record.completion as ExpoSendLedgerCompletion,
    });
  }
  return null;
}

function parseLookup(value: unknown): ExpoSendLedgerLookup | null {
  const record = exactRecord(value);
  if (record === null || typeof record.kind !== 'string') return null;
  if (
    ['missing', 'uncertain', 'conflict'].includes(record.kind) &&
    Object.keys(record).length === 1
  ) {
    return Object.freeze({ kind: record.kind }) as ExpoSendLedgerLookup;
  }
  if (
    record.kind === 'completed' &&
    Object.keys(record).length === 2 &&
    exactRecord(record.completion) !== null
  ) {
    return Object.freeze({
      kind: 'completed',
      completion: record.completion as ExpoSendLedgerCompletion,
    });
  }
  return null;
}

function parseStoredOutcome(
  value: unknown,
  attemptId: string,
  provider: DirectPushProvider,
): ProviderSendOutcome | null {
  const record = exactRecord(value);
  if (record === null) return null;
  const parsed = RecordDeliveryEvidenceInputSchema.safeParse({
    subject: { kind: 'attempt', attemptId },
    ...record,
  });
  if (
    !parsed.success ||
    parsed.data.subject.kind !== 'attempt' ||
    parsed.data.subject.attemptId !== attemptId ||
    parsed.data.provider !== provider ||
    parsed.data.proof !== null ||
    parsed.data.diagnosticDigest !== null ||
    !['provider-accepted', 'failed', 'expired', 'unknown'].includes(
      parsed.data.state,
    )
  ) {
    return null;
  }
  const canonical =
    parsed.data.state === 'provider-accepted'
      ? parsed.data.providerReference !== null &&
        parsed.data.reasonCode === null
      : parsed.data.state === 'expired'
        ? parsed.data.providerReference === null &&
          parsed.data.reasonCode ===
            (provider === APNS_DIRECT_PROVIDER
              ? 'APNS_NOTIFICATION_EXPIRED'
              : 'FCM_NOTIFICATION_EXPIRED')
        : parsed.data.state === 'unknown'
          ? [
              provider === APNS_DIRECT_PROVIDER
                ? 'APNS_NETWORK_OUTCOME_AMBIGUOUS'
                : 'FCM_NETWORK_OUTCOME_AMBIGUOUS',
              provider === APNS_DIRECT_PROVIDER
                ? 'APNS_RESPONSE_INVALID'
                : 'FCM_RESPONSE_INVALID',
            ].includes(parsed.data.reasonCode ?? '')
          : [
              ...(provider === APNS_DIRECT_PROVIDER
                ? [
                    'APNS_AUTHENTICATION_FAILED',
                    'APNS_BAD_DEVICE_TOKEN',
                    'APNS_ENDPOINT_INELIGIBLE',
                    'APNS_LIVE_TRANSPORT_DISABLED',
                    'APNS_PAYLOAD_REJECTED',
                    'APNS_TOPIC_REJECTED',
                    'APNS_UNREGISTERED',
                  ]
                : [
                    'FCM_AUTHENTICATION_FAILED',
                    'FCM_ENDPOINT_INELIGIBLE',
                    'FCM_INVALID_ARGUMENT',
                    'FCM_LIVE_TRANSPORT_DISABLED',
                    'FCM_PAYLOAD_INVALID',
                    'FCM_UNREGISTERED',
                  ]),
            ].includes(parsed.data.reasonCode ?? '');
  if (!canonical) return null;
  return Object.freeze({
    state: parsed.data.state,
    provider: parsed.data.provider,
    providerReference: parsed.data.providerReference,
    proof: null,
    reasonCode: parsed.data.reasonCode,
    diagnosticDigest: null,
    ...(parsed.data.providerOccurredAt === undefined
      ? {}
      : { providerOccurredAt: parsed.data.providerOccurredAt }),
  }) as ProviderSendOutcome;
}

function storedCompletion(
  value: unknown,
  attemptId: string,
  provider: DirectPushProvider,
):
  | Readonly<{ kind: 'outcome'; outcome: ProviderSendOutcome }>
  | Readonly<{ kind: 'failure'; failure: ProviderFailure }>
  | null {
  const record = exactRecord(value);
  if (record === null || Object.keys(record).length !== 2) return null;
  if (record.kind === 'outcome') {
    const outcome = parseStoredOutcome(record.outcome, attemptId, provider);
    return outcome === null
      ? null
      : Object.freeze({ kind: 'outcome', outcome });
  }
  if (record.kind !== 'failure') return null;
  const failure = exactRecord(record.failure);
  if (
    failure === null ||
    Object.keys(failure).length !== 3 ||
    typeof failure.code !== 'string' ||
    typeof failure.disposition !== 'string' ||
    failure.diagnosticDigest !== null
  ) {
    return null;
  }
  const knownDisposition =
    FAILURE_DISPOSITIONS[failure.code as keyof typeof FAILURE_DISPOSITIONS] ??
    (RETRYABLE_PROVIDER_REASONS.has(failure.code)
      ? 'safe-to-retry'
      : undefined);
  if (knownDisposition !== failure.disposition) return null;
  return Object.freeze({
    kind: 'failure',
    failure: Object.freeze({
      code: failure.code,
      disposition: failure.disposition,
      diagnosticDigest: null,
    }) as ProviderFailure,
  });
}

function providerMatchesEndpoint(
  workItem: WorkerAttemptWorkItem,
  provider: DirectPushProvider,
): boolean {
  const endpoint = workItem.endpoint as unknown as Readonly<{
    provider?: unknown;
    serviceEnvironment?: unknown;
  }>;
  return (
    (endpoint.serviceEnvironment === 'development' ||
      endpoint.serviceEnvironment === 'production') &&
    ((provider === APNS_DIRECT_PROVIDER && endpoint.provider === 'apns') ||
      (provider === FCM_DIRECT_PROVIDER && endpoint.provider === 'fcm'))
  );
}

function failure(code: keyof typeof FAILURE_DISPOSITIONS): ProviderFailure {
  return Object.freeze({
    code,
    disposition: FAILURE_DISPOSITIONS[code],
    diagnosticDigest: null,
  });
}

function throwFailure(value: ProviderFailure): never {
  throw new ProviderDispatchError(
    value.code,
    value.disposition,
    value.diagnosticDigest,
  );
}

/**
 * Single-send direct-provider adapter. Credentials are prepared before the
 * irreversible ledger claim; live authorization and endpoint eligibility are
 * rechecked after the claim immediately before the prepared provider call.
 */
export class LedgeredDirectPushAdapter
  implements AttemptIdempotentProviderAdapter
{
  public readonly channel = 'push' as const;
  public readonly integrationId = DIRECT_PUSH_INTEGRATION_ID;
  public readonly provider: DirectPushProvider;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;

  readonly #transport: DirectPushTransport;
  readonly #ledger: DurableExpoSendLedger;
  readonly #eligibility: PushEndpointEligibilityChecker;
  readonly #authorize:
    | ((workItem: WorkerAttemptWorkItem) => boolean | Promise<boolean>)
    | undefined;
  readonly #clock: () => Date | string | number;

  public constructor(options: LedgeredDirectPushAdapterOptions) {
    if (
      options.transport === null ||
      typeof options.transport !== 'object' ||
      ![APNS_DIRECT_PROVIDER, FCM_DIRECT_PROVIDER].includes(
        options.transport.provider,
      ) ||
      typeof options.transport.prepare !== 'function' ||
      typeof options.sendLedger?.lookupProviderIo !== 'function' ||
      typeof options.sendLedger.claimProviderIo !== 'function' ||
      typeof options.sendLedger.completeProviderIo !== 'function' ||
      typeof options.endpointEligibility?.isEligible !== 'function'
    ) {
      throw new TypeError('Direct push adapter dependencies are invalid.');
    }
    this.provider = options.transport.provider;
    this.#transport = options.transport;
    this.#ledger = options.sendLedger;
    this.#eligibility = options.endpointEligibility;
    this.#authorize = options.authorizeLiveTransport;
    this.#clock = options.clock ?? Date.now;
  }

  public async recover(
    request: ProviderSendRequest,
  ): Promise<ProviderRecoveryResult> {
    const workItem = this.#parseRequest(request);
    let lookup: ExpoSendLedgerLookup | null;
    try {
      lookup = parseLookup(
        await this.#ledger.lookupProviderIo({
          attemptId: workItem.attempt.id,
          workFingerprint: workerAttemptFingerprint(workItem),
        }),
      );
    } catch {
      throwFailure(failure('DIRECT_PUSH_LEDGER_FAILED'));
    }
    if (lookup === null || lookup.kind === 'conflict') {
      throwFailure(failure('DIRECT_PUSH_LEDGER_FAILED'));
    }
    if (lookup.kind === 'missing') return Object.freeze({ kind: 'missing' });
    if (lookup.kind === 'uncertain') {
      return Object.freeze({
        kind: 'outcome',
        outcome: unknownOutcome(this.provider),
      });
    }
    return this.#recoverCompletion(lookup.completion, workItem);
  }

  public async send(
    request: ProviderSendRequest,
  ): Promise<ProviderSendOutcome> {
    const workItem = this.#parseRequest(request);
    const fingerprint = workerAttemptFingerprint(workItem);
    const preparation = await this.#prepare(workItem);
    if (preparation.kind === 'outcome') {
      if (preparation.completion.kind === 'failure') {
        return throwFailure(preparation.completion.failure);
      }
      return preparation.completion.outcome;
    }
    let claim: ExpoSendLedgerClaim | null;
    try {
      claim = parseClaim(
        await this.#ledger.claimProviderIo({
          attemptId: workItem.attempt.id,
          workFingerprint: fingerprint,
        }),
      );
    } catch {
      throwFailure(failure('DIRECT_PUSH_LEDGER_FAILED'));
    }
    if (claim === null || claim.kind === 'conflict') {
      throwFailure(failure('DIRECT_PUSH_LEDGER_FAILED'));
    }
    if (claim.kind === 'uncertain') return unknownOutcome(this.provider);
    if (claim.kind === 'completed') {
      const recovered = await this.#recoverCompletion(
        claim.completion,
        workItem,
      );
      if (recovered.kind === 'outcome') {
        const parsed = parseStoredOutcome(
          recovered.outcome,
          workItem.attempt.id,
          this.provider,
        );
        return parsed ?? unknownOutcome(this.provider);
      }
      if (recovered.kind === 'provider-error') throw recovered.error;
      return unknownOutcome(this.provider);
    }

    const completion = await this.#executePrepared(
      workItem,
      preparation.prepared,
    );
    try {
      await this.#ledger.completeProviderIo({
        attemptId: workItem.attempt.id,
        workFingerprint: fingerprint,
        claimToken: claim.claimToken,
        completion,
      });
    } catch {
      return unknownOutcome(this.provider);
    }
    if (completion.kind === 'failure') return throwFailure(completion.failure);
    return completion.outcome;
  }

  #parseRequest(request: ProviderSendRequest): WorkerAttemptWorkItem {
    let workItem: WorkerAttemptWorkItem;
    try {
      workItem = parseWorkerAttemptWorkItem(request.workItem);
    } catch {
      throw new ProviderDispatchError(
        'DIRECT_PUSH_SEND_REQUEST_INVALID',
        'terminal-failure',
      );
    }
    if (
      request.idempotencyKey !== workItem.attempt.id ||
      workItem.batch.integrationId !== this.integrationId ||
      workItem.batch.rosterPopulation !== 'staff' ||
      !providerMatchesEndpoint(workItem, this.provider)
    ) {
      throw new ProviderDispatchError(
        'DIRECT_PUSH_SEND_REQUEST_INVALID',
        'terminal-failure',
      );
    }
    return workItem;
  }

  async #prepare(workItem: WorkerAttemptWorkItem): Promise<
    | Readonly<{
        kind: 'prepared';
        prepared: Extract<DirectPushPreparation, { kind: 'prepared' }>;
      }>
    | Readonly<{ kind: 'outcome'; completion: ExpoSendLedgerCompletion }>
  > {
    const now = new Date(this.#clock()).getTime();
    const message = createDirectPushMessage(workItem);
    if (!Number.isFinite(now)) {
      return Object.freeze({
        kind: 'outcome',
        completion: completionFromDirect(
          unknownDirectPush(providerReason(this.provider)),
          this.provider,
        ),
      });
    }
    if (message.expiration <= Math.floor(now / 1_000)) {
      return Object.freeze({
        kind: 'outcome',
        completion: completionFromDirect(
          expiredDirectPush(this.provider),
          this.provider,
        ),
      });
    }
    let authorized = false;
    try {
      authorized =
        this.#authorize !== undefined &&
        (await this.#authorize(workItem)) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return Object.freeze({
        kind: 'outcome',
        completion: Object.freeze({
          kind: 'failure',
          failure: failure('DIRECT_PUSH_LIVE_TRANSPORT_DISABLED'),
        }),
      });
    }
    try {
      const eligible = await this.#eligibility.isEligible(workItem);
      if (eligible !== true) {
        return Object.freeze({
          kind: 'outcome',
          completion: Object.freeze({
            kind: 'failure',
            failure: failure('DIRECT_PUSH_ENDPOINT_ELIGIBILITY_BLOCKED'),
          }),
        });
      }
    } catch (error) {
      return Object.freeze({
        kind: 'outcome',
        completion: Object.freeze({
          kind: 'failure',
          failure: failure(
            error instanceof PushEndpointEligibilityError && error.retryable
              ? 'DIRECT_PUSH_ENDPOINT_ELIGIBILITY_UNAVAILABLE'
              : 'DIRECT_PUSH_ENDPOINT_ELIGIBILITY_BLOCKED',
          ),
        }),
      });
    }
    try {
      const raw = await this.#transport.prepare(workItem);
      const record = exactRecord(raw);
      if (
        record === null ||
        record.provider !== this.provider ||
        (record.kind !== 'prepared' && record.kind !== 'outcome')
      ) {
        return Object.freeze({
          kind: 'outcome',
          completion: completionFromDirect(
            unknownDirectPush(providerReason(this.provider)),
            this.provider,
          ),
        });
      }
      if (record.kind === 'outcome') {
        if (Object.keys(record).length !== 3) throw new TypeError();
        const parsed = parseDirectPushProviderOutcome(
          record.outcome,
          this.provider,
        );
        return Object.freeze({
          kind: 'outcome',
          completion: completionFromDirect(
            parsed ?? unknownDirectPush(providerReason(this.provider)),
            this.provider,
          ),
        });
      }
      if (
        Object.keys(record).length !== 3 ||
        typeof record.send !== 'function'
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        kind: 'prepared',
        prepared: raw as Extract<DirectPushPreparation, { kind: 'prepared' }>,
      });
    } catch {
      return Object.freeze({
        kind: 'outcome',
        completion: completionFromDirect(
          unknownDirectPush(providerReason(this.provider)),
          this.provider,
        ),
      });
    }
  }

  async #executePrepared(
    workItem: WorkerAttemptWorkItem,
    prepared: Extract<DirectPushPreparation, { kind: 'prepared' }>,
  ): Promise<ExpoSendLedgerCompletion> {
    let authorized = false;
    try {
      authorized =
        this.#authorize !== undefined &&
        (await this.#authorize(workItem)) === true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      return Object.freeze({
        kind: 'failure',
        failure: failure('DIRECT_PUSH_LIVE_TRANSPORT_DISABLED'),
      });
    }
    // This is deliberately the final awaited check before send() synchronously
    // invokes the prepared APNs/FCM request boundary.
    try {
      const eligible = await this.#eligibility.isEligible(workItem);
      if (eligible !== true) {
        return Object.freeze({
          kind: 'failure',
          failure: failure('DIRECT_PUSH_ENDPOINT_ELIGIBILITY_BLOCKED'),
        });
      }
    } catch (error) {
      return Object.freeze({
        kind: 'failure',
        failure: failure(
          error instanceof PushEndpointEligibilityError && error.retryable
            ? 'DIRECT_PUSH_ENDPOINT_ELIGIBILITY_UNAVAILABLE'
            : 'DIRECT_PUSH_ENDPOINT_ELIGIBILITY_BLOCKED',
        ),
      });
    }
    try {
      const parsed = parseDirectPushProviderOutcome(
        await prepared.send(),
        this.provider,
      );
      return completionFromDirect(
        parsed ?? unknownDirectPush(providerReason(this.provider)),
        this.provider,
      );
    } catch {
      return Object.freeze({
        kind: 'outcome',
        outcome: unknownOutcome(this.provider),
      });
    }
  }

  async #recoverCompletion(
    value: unknown,
    workItem: WorkerAttemptWorkItem,
  ): Promise<ProviderRecoveryResult> {
    const completion = storedCompletion(
      value,
      workItem.attempt.id,
      this.provider,
    );
    if (completion === null) throwFailure(failure('DIRECT_PUSH_LEDGER_FAILED'));
    if (completion.kind === 'failure') {
      return Object.freeze({
        kind: 'provider-error',
        error: new ProviderDispatchError(
          completion.failure.code,
          completion.failure.disposition,
          completion.failure.diagnosticDigest,
        ),
      });
    }
    return Object.freeze({ kind: 'outcome', outcome: completion.outcome });
  }
}
