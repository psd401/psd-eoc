import { RecordDeliveryEvidenceInputSchema } from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  workerAttemptFingerprint,
} from '../shared/attempt';
import type {
  AttemptIdempotentProviderAdapter,
  ProviderSendOutcome,
  ProviderSendRequest,
} from '../shared/processor';
import {
  ProviderDispatchError,
  normalizeProviderFailure,
  type ProviderFailure,
} from '../shared/retry';
import { EXPO_PUSH_PROVIDER, type ExpoProviderOutcome } from './protocol';
import type { ExpoPushTransport } from './transport';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{16,512}$/u;

export type ExpoSendLedgerCompletion =
  | Readonly<{
      kind: 'outcome';
      outcome: ProviderSendOutcome;
    }>
  | Readonly<{
      kind: 'failure';
      failure: ProviderFailure;
    }>;

export type ExpoSendLedgerClaim =
  | Readonly<{ kind: 'execute'; claimToken: string }>
  | Readonly<{ kind: 'completed'; completion: ExpoSendLedgerCompletion }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{ kind: 'conflict' }>;

export interface ClaimExpoProviderIoRequest {
  readonly attemptId: string;
  /** SHA-256 only; destination and rendered message never enter the ledger API. */
  readonly workFingerprint: string;
}

export interface CompleteExpoProviderIoRequest
  extends ClaimExpoProviderIoRequest {
  readonly claimToken: string;
  readonly completion: ExpoSendLedgerCompletion;
}

/**
 * A production implementation must durably and atomically key records by
 * attemptId and workFingerprint. Once `execute` has been returned, that attempt
 * may never receive another provider-I/O permit, even after a crash or timeout.
 */
export interface DurableExpoSendLedger {
  claimProviderIo(
    request: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerClaim>;
  completeProviderIo(request: CompleteExpoProviderIoRequest): Promise<void>;
}

export type LedgeredExpoPushAdapterErrorCode =
  | 'EXPO_SEND_REQUEST_INVALID'
  | 'EXPO_SEND_LEDGER_CONFLICT'
  | 'EXPO_SEND_LEDGER_FAILED'
  | 'EXPO_SEND_LEDGER_INVALID';

/** Safe adapter failure that never includes a destination or provider body. */
export class LedgeredExpoPushAdapterError extends Error {
  public constructor(public readonly code: LedgeredExpoPushAdapterErrorCode) {
    super('The Expo send adapter failed closed.');
    this.name = 'LedgeredExpoPushAdapterError';
  }
}

export interface LedgeredExpoPushAdapterOptions {
  readonly transport: ExpoPushTransport;
  readonly sendLedger: DurableExpoSendLedger;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function unknownSendOutcome(): ProviderSendOutcome {
  return Object.freeze({
    state: 'unknown',
    provider: EXPO_PUSH_PROVIDER,
    providerReference: null,
    proof: null,
    reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
    diagnosticDigest: null,
  });
}

function parseLedgerOutcome(
  value: unknown,
  attemptId: string,
): ProviderSendOutcome {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'diagnosticDigest',
      'proof',
      'provider',
      'providerReference',
      'reasonCode',
      'state',
    ])
  ) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  const result = RecordDeliveryEvidenceInputSchema.safeParse({
    subject: { kind: 'attempt', attemptId },
    ...value,
  });
  if (
    !result.success ||
    !['provider-accepted', 'failed', 'expired', 'unknown'].includes(
      result.data.state,
    ) ||
    result.data.subject.kind !== 'attempt' ||
    result.data.subject.attemptId !== attemptId ||
    result.data.provider !== EXPO_PUSH_PROVIDER
  ) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  return Object.freeze({
    state: result.data.state,
    provider: result.data.provider,
    providerReference: result.data.providerReference,
    proof: result.data.proof,
    reasonCode: result.data.reasonCode,
    diagnosticDigest: result.data.diagnosticDigest,
  }) as ProviderSendOutcome;
}

function parseLedgerFailure(value: unknown): ProviderFailure {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['code', 'diagnosticDigest', 'disposition']) ||
    typeof value.code !== 'string' ||
    typeof value.disposition !== 'string' ||
    !['safe-to-retry', 'terminal-failure', 'ambiguous'].includes(
      value.disposition,
    ) ||
    !(
      value.diagnosticDigest === null ||
      (typeof value.diagnosticDigest === 'string' &&
        DIGEST_PATTERN.test(value.diagnosticDigest))
    )
  ) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  try {
    const error = new ProviderDispatchError(
      value.code,
      value.disposition as ProviderFailure['disposition'],
      value.diagnosticDigest,
    );
    return normalizeProviderFailure(error);
  } catch {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
}

function parseLedgerCompletion(
  value: unknown,
  attemptId: string,
): ExpoSendLedgerCompletion {
  if (!isPlainRecord(value)) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  if (value.kind === 'outcome' && hasExactKeys(value, ['kind', 'outcome'])) {
    return Object.freeze({
      kind: 'outcome',
      outcome: parseLedgerOutcome(value.outcome, attemptId),
    });
  }
  if (value.kind === 'failure' && hasExactKeys(value, ['failure', 'kind'])) {
    return Object.freeze({
      kind: 'failure',
      failure: parseLedgerFailure(value.failure),
    });
  }
  throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
}

function parseLedgerClaim(
  value: unknown,
  attemptId: string,
): ExpoSendLedgerClaim {
  if (!isPlainRecord(value)) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  if (
    value.kind === 'execute' &&
    hasExactKeys(value, ['claimToken', 'kind']) &&
    typeof value.claimToken === 'string' &&
    SAFE_TOKEN_PATTERN.test(value.claimToken)
  ) {
    return Object.freeze({ kind: 'execute', claimToken: value.claimToken });
  }
  if (
    value.kind === 'completed' &&
    hasExactKeys(value, ['completion', 'kind'])
  ) {
    return Object.freeze({
      kind: 'completed',
      completion: parseLedgerCompletion(value.completion, attemptId),
    });
  }
  if (
    (value.kind === 'uncertain' || value.kind === 'conflict') &&
    hasExactKeys(value, ['kind'])
  ) {
    return Object.freeze({ kind: value.kind });
  }
  throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
}

function outcomeFromExpo(value: ExpoProviderOutcome): ProviderSendOutcome {
  return Object.freeze({
    state: value.state,
    provider: EXPO_PUSH_PROVIDER,
    providerReference: value.providerReference,
    proof: null,
    reasonCode: value.reasonCode,
    diagnosticDigest: null,
  }) as ProviderSendOutcome;
}

function failureFromError(error: unknown): ProviderFailure {
  return normalizeProviderFailure(error);
}

function throwFailure(failure: ProviderFailure): never {
  throw new ProviderDispatchError(
    failure.code,
    failure.disposition,
    failure.diagnosticDigest,
  );
}

/**
 * Live-capable Expo adapter whose idempotency is supplied by the injected
 * irreversible ledger, not by Expo. It has no default store or runtime wiring.
 */
export class LedgeredExpoPushAdapter
  implements AttemptIdempotentProviderAdapter
{
  public readonly channel = 'push' as const;
  public readonly integrationId = 'expo-push' as const;
  public readonly truthLabel = 'live-verified' as const;
  public readonly provider = EXPO_PUSH_PROVIDER;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;

  readonly #transport: ExpoPushTransport;
  readonly #ledger: DurableExpoSendLedger;

  public constructor(options: LedgeredExpoPushAdapterOptions) {
    this.#transport = options.transport;
    this.#ledger = options.sendLedger;
  }

  public async send(
    request: ProviderSendRequest,
  ): Promise<ProviderSendOutcome> {
    const workItem = parseWorkerAttemptWorkItem(request.workItem);
    if (
      request.idempotencyKey !== workItem.attempt.id ||
      workItem.batch.integrationStatus.integrationId !== this.integrationId ||
      workItem.batch.integrationStatus.label !== this.truthLabel ||
      workItem.batch.rosterPopulation !== 'staff'
    ) {
      throw new LedgeredExpoPushAdapterError('EXPO_SEND_REQUEST_INVALID');
    }
    const workFingerprint = workerAttemptFingerprint(workItem);
    let claim: ExpoSendLedgerClaim;
    try {
      claim = parseLedgerClaim(
        await this.#ledger.claimProviderIo({
          attemptId: workItem.attempt.id,
          workFingerprint,
        }),
        workItem.attempt.id,
      );
    } catch (error) {
      if (error instanceof LedgeredExpoPushAdapterError) throw error;
      throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_FAILED');
    }

    if (claim.kind === 'conflict') {
      throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_CONFLICT');
    }
    if (claim.kind === 'uncertain') return unknownSendOutcome();
    if (claim.kind === 'completed') {
      if (claim.completion.kind === 'outcome') {
        return claim.completion.outcome;
      }
      return throwFailure(claim.completion.failure);
    }

    let completion: ExpoSendLedgerCompletion;
    try {
      const outcomes = await this.#transport.sendChunk([workItem]);
      const outcome = outcomes[0];
      if (outcomes.length !== 1 || outcome === undefined) {
        completion = Object.freeze({
          kind: 'outcome',
          outcome: unknownSendOutcome(),
        });
      } else if (outcome.kind === 'retry') {
        completion = Object.freeze({
          kind: 'failure',
          failure: normalizeProviderFailure(
            new ProviderDispatchError(outcome.reasonCode, 'safe-to-retry'),
          ),
        });
      } else {
        completion = Object.freeze({
          kind: 'outcome',
          outcome: outcomeFromExpo(outcome),
        });
      }
    } catch (error) {
      completion = Object.freeze({
        kind: 'failure',
        failure: failureFromError(error),
      });
    }

    try {
      await this.#ledger.completeProviderIo({
        attemptId: workItem.attempt.id,
        workFingerprint,
        claimToken: claim.claimToken,
        completion,
      });
    } catch {
      // The provider boundary may have been crossed. The irreversible claim
      // makes unknown the only safe local result; it must never be released.
      return unknownSendOutcome();
    }

    if (completion.kind === 'failure') {
      return throwFailure(completion.failure);
    }
    return completion.outcome;
  }
}
