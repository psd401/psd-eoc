import { RecordDeliveryEvidenceInputSchema } from '@psd-eoc/contracts';

import {
  parseWorkerAttemptWorkItem,
  workerAttemptFingerprint,
  type WorkerAttemptWorkItem,
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
import {
  EXPO_PUSH_PROVIDER,
  EXPO_EMERGENCY_TTL_SECONDS,
  EXPO_SEND_CHUNK_SIZE,
  expired,
  parseExpoProviderOutcome,
  type ExpoProviderOutcome,
} from './protocol';
import type { ExpoPushTransport } from './transport';

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{16,512}$/u;
const SAFE_PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const DEFAULT_BATCH_WINDOW_MILLISECONDS = 5;
const MAX_BATCH_WINDOW_MILLISECONDS = 100;

const CANONICAL_SEND_OUTCOME_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'EXPO_DEVICE_NOT_REGISTERED',
  'EXPO_INVALID_CREDENTIALS',
  'EXPO_MESSAGE_TOO_BIG',
  'EXPO_MISMATCH_SENDER_ID',
]);
const CANONICAL_SEND_OUTCOME_UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  'EXPO_SEND_OUTCOME_AMBIGUOUS',
  'EXPO_TICKET_ERROR_UNKNOWN',
  'EXPO_TICKET_MISSING',
  'EXPO_TICKET_RESPONSE_INVALID',
]);

const CANONICAL_LEDGER_FAILURE_DISPOSITIONS = Object.freeze(
  new Map<string, ProviderFailure['disposition']>([
    ['EXPO_HTTP_RATE_LIMITED', 'safe-to-retry'],
    ['EXPO_HTTP_SERVER_ERROR', 'safe-to-retry'],
    ['EXPO_MESSAGE_RATE_EXCEEDED', 'safe-to-retry'],
    ['EXPO_HTTP_CLIENT_ERROR', 'terminal-failure'],
    ['EXPO_INVALID_CREDENTIALS', 'terminal-failure'],
    ['EXPO_LIVE_TRANSPORT_DISABLED', 'terminal-failure'],
    ['EXPO_NETWORK_OUTCOME_AMBIGUOUS', 'ambiguous'],
    ['EXPO_RESPONSE_TOO_LARGE', 'ambiguous'],
    ['PROVIDER_OUTCOME_AMBIGUOUS', 'ambiguous'],
  ]),
);

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
 * A thrown claim error is always treated as ambiguous because it cannot prove
 * whether a completed provider-I/O record already exists.
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
export class LedgeredExpoPushAdapterError extends ProviderDispatchError {
  public override readonly code: LedgeredExpoPushAdapterErrorCode;

  public constructor(code: LedgeredExpoPushAdapterErrorCode) {
    super(
      code,
      code === 'EXPO_SEND_LEDGER_FAILED' || code === 'EXPO_SEND_LEDGER_INVALID'
        ? 'ambiguous'
        : 'terminal-failure',
    );
    this.code = code;
    this.name = 'LedgeredExpoPushAdapterError';
  }
}

export interface LedgeredExpoPushAdapterOptions {
  readonly transport: ExpoPushTransport;
  readonly sendLedger: DurableExpoSendLedger;
  /** Small bounded coalescing window after irreversible per-attempt claims. */
  readonly batchWindowMilliseconds?: number;
  /** Authoritative clock checked immediately before provider I/O. */
  readonly clock?: () => Date | string | number;
}

interface PendingExpoProviderIo {
  readonly workItem: WorkerAttemptWorkItem;
  readonly resolve: (completion: ExpoSendLedgerCompletion) => void;
}

function exactDataProperties(
  value: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== 'string' || !expected.includes(key))
    ) {
      return null;
    }
    const properties: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      properties[key] = descriptor.value;
    }
    return properties;
  } catch {
    return null;
  }
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

function isCanonicalLedgerOutcome(
  outcome: Readonly<{
    state: string;
    providerReference: string | null;
    proof: unknown;
    reasonCode: string | null;
    diagnosticDigest: string | null;
  }>,
): boolean {
  if (
    outcome.proof !== null ||
    outcome.diagnosticDigest !== null ||
    (outcome.providerReference !== null &&
      !SAFE_PROVIDER_REFERENCE_PATTERN.test(outcome.providerReference))
  ) {
    return false;
  }
  if (outcome.state === 'provider-accepted') {
    return outcome.providerReference !== null && outcome.reasonCode === null;
  }
  if (outcome.state === 'expired') {
    return (
      outcome.providerReference === null &&
      outcome.reasonCode === 'EXPO_NOTIFICATION_EXPIRED'
    );
  }
  if (outcome.state === 'failed') {
    return (
      outcome.providerReference === null &&
      outcome.reasonCode !== null &&
      CANONICAL_SEND_OUTCOME_FAILURE_REASONS.has(outcome.reasonCode)
    );
  }
  if (outcome.state === 'unknown') {
    return (
      outcome.providerReference === null &&
      outcome.reasonCode !== null &&
      CANONICAL_SEND_OUTCOME_UNKNOWN_REASONS.has(outcome.reasonCode)
    );
  }
  return false;
}

function parseLedgerOutcome(
  value: unknown,
  attemptId: string,
): ProviderSendOutcome {
  const properties = exactDataProperties(value, [
    'diagnosticDigest',
    'proof',
    'provider',
    'providerReference',
    'reasonCode',
    'state',
  ]);
  if (properties === null) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  const result = RecordDeliveryEvidenceInputSchema.safeParse({
    subject: { kind: 'attempt', attemptId },
    ...properties,
  });
  if (
    !result.success ||
    !['provider-accepted', 'failed', 'expired', 'unknown'].includes(
      result.data.state,
    ) ||
    result.data.subject.kind !== 'attempt' ||
    result.data.subject.attemptId !== attemptId ||
    result.data.provider !== EXPO_PUSH_PROVIDER ||
    !isCanonicalLedgerOutcome(result.data)
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
  const properties = exactDataProperties(value, [
    'code',
    'diagnosticDigest',
    'disposition',
  ]);
  if (
    properties === null ||
    typeof properties.code !== 'string' ||
    typeof properties.disposition !== 'string' ||
    properties.diagnosticDigest !== null ||
    CANONICAL_LEDGER_FAILURE_DISPOSITIONS.get(properties.code) !==
      properties.disposition
  ) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  try {
    const error = new ProviderDispatchError(
      properties.code,
      properties.disposition as ProviderFailure['disposition'],
      properties.diagnosticDigest,
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
  const outcomeCompletion = exactDataProperties(value, ['kind', 'outcome']);
  if (outcomeCompletion?.kind === 'outcome') {
    return Object.freeze({
      kind: 'outcome',
      outcome: parseLedgerOutcome(outcomeCompletion.outcome, attemptId),
    });
  }
  const failureCompletion = exactDataProperties(value, ['failure', 'kind']);
  if (failureCompletion?.kind === 'failure') {
    return Object.freeze({
      kind: 'failure',
      failure: parseLedgerFailure(failureCompletion.failure),
    });
  }
  if (outcomeCompletion === null && failureCompletion === null) {
    throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
  }
  throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_INVALID');
}

function parseLedgerClaim(
  value: unknown,
  attemptId: string,
): ExpoSendLedgerClaim {
  const execute = exactDataProperties(value, ['claimToken', 'kind']);
  if (
    execute?.kind === 'execute' &&
    typeof execute.claimToken === 'string' &&
    SAFE_TOKEN_PATTERN.test(execute.claimToken)
  ) {
    return Object.freeze({ kind: 'execute', claimToken: execute.claimToken });
  }
  const completed = exactDataProperties(value, ['completion', 'kind']);
  if (completed?.kind === 'completed') {
    return Object.freeze({
      kind: 'completed',
      completion: parseLedgerCompletion(completed.completion, attemptId),
    });
  }
  const terminal = exactDataProperties(value, ['kind']);
  if (terminal?.kind === 'uncertain' || terminal?.kind === 'conflict') {
    return Object.freeze({ kind: terminal.kind });
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
  const failure = normalizeProviderFailure(error);
  if (
    failure.diagnosticDigest === null &&
    CANONICAL_LEDGER_FAILURE_DISPOSITIONS.get(failure.code) ===
      failure.disposition
  ) {
    return failure;
  }
  return Object.freeze({
    code: 'PROVIDER_OUTCOME_AMBIGUOUS',
    disposition: 'ambiguous',
    diagnosticDigest: null,
  });
}

function batchWindowMilliseconds(value: number | undefined): number {
  const milliseconds = value ?? DEFAULT_BATCH_WINDOW_MILLISECONDS;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_BATCH_WINDOW_MILLISECONDS
  ) {
    throw new TypeError('Expo send batch window is invalid.');
  }
  return milliseconds;
}

function completionFromExpoOutcome(
  outcome: ExpoProviderOutcome,
): ExpoSendLedgerCompletion {
  if (outcome.kind === 'retry') {
    return Object.freeze({
      kind: 'failure',
      failure: normalizeProviderFailure(
        new ProviderDispatchError(outcome.reasonCode, 'safe-to-retry'),
      ),
    });
  }
  return Object.freeze({
    kind: 'outcome',
    outcome: outcomeFromExpo(outcome),
  });
}

function safeCompletionFromExpoOutcome(
  value: unknown,
): ExpoSendLedgerCompletion {
  const outcome = parseExpoProviderOutcome(value, 'ticket');
  if (outcome === null) {
    return Object.freeze({
      kind: 'outcome',
      outcome: unknownSendOutcome(),
    });
  }
  try {
    const completion = completionFromExpoOutcome(outcome);
    if (
      completion.kind === 'outcome' &&
      !isCanonicalLedgerOutcome(completion.outcome)
    ) {
      return Object.freeze({
        kind: 'outcome',
        outcome: unknownSendOutcome(),
      });
    }
    return completion;
  } catch {
    return Object.freeze({
      kind: 'outcome',
      outcome: unknownSendOutcome(),
    });
  }
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
  readonly #batchWindowMilliseconds: number;
  readonly #clock: () => Date | string | number;
  readonly #pendingProviderIo: PendingExpoProviderIo[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: LedgeredExpoPushAdapterOptions) {
    this.#transport = options.transport;
    this.#ledger = options.sendLedger;
    this.#batchWindowMilliseconds = batchWindowMilliseconds(
      options.batchWindowMilliseconds,
    );
    this.#clock = options.clock ?? Date.now;
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
    let rawClaim: unknown;
    try {
      rawClaim = await this.#ledger.claimProviderIo({
        attemptId: workItem.attempt.id,
        workFingerprint,
      });
    } catch {
      throw new LedgeredExpoPushAdapterError('EXPO_SEND_LEDGER_FAILED');
    }
    const claim = parseLedgerClaim(rawClaim, workItem.attempt.id);

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

    const completion = await this.#enqueueProviderIo(workItem);

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

  #enqueueProviderIo(
    workItem: WorkerAttemptWorkItem,
  ): Promise<ExpoSendLedgerCompletion> {
    return new Promise((resolve) => {
      this.#pendingProviderIo.push({ workItem, resolve });
      if (this.#pendingProviderIo.length >= EXPO_SEND_CHUNK_SIZE) {
        if (this.#flushTimer !== null) {
          clearTimeout(this.#flushTimer);
          this.#flushTimer = null;
        }
        this.#flushPendingChunks(false);
        return;
      }
      this.#scheduleFlush();
    });
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flushPendingChunks(true);
    }, this.#batchWindowMilliseconds);
  }

  #flushPendingChunks(includePartial: boolean): void {
    while (
      this.#pendingProviderIo.length >= EXPO_SEND_CHUNK_SIZE ||
      (includePartial && this.#pendingProviderIo.length > 0)
    ) {
      const pending = this.#pendingProviderIo.splice(0, EXPO_SEND_CHUNK_SIZE);
      void this.#sendProviderChunk(pending).catch(() => {
        for (const entry of pending) {
          entry.resolve(
            Object.freeze({
              kind: 'outcome',
              outcome: unknownSendOutcome(),
            }),
          );
        }
      });
    }
    if (this.#pendingProviderIo.length > 0) this.#scheduleFlush();
  }

  async #sendProviderChunk(
    pending: readonly PendingExpoProviderIo[],
  ): Promise<void> {
    const now = new Date(this.#clock()).getTime();
    const fresh: PendingExpoProviderIo[] = [];
    const completions: Array<ExpoSendLedgerCompletion | undefined> =
      pending.map((entry) => {
        const expiresAt =
          Date.parse(entry.workItem.batch.createdAt) +
          EXPO_EMERGENCY_TTL_SECONDS * 1_000;
        if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
          return Object.freeze({
            kind: 'outcome' as const,
            outcome: unknownSendOutcome(),
          });
        }
        if (now < expiresAt) {
          fresh.push(entry);
          return undefined;
        }
        return completionFromExpoOutcome(expired());
      });
    if (fresh.length > 0) {
      let freshCompletions: readonly ExpoSendLedgerCompletion[] = fresh.map(
        () =>
          Object.freeze({
            kind: 'outcome' as const,
            outcome: unknownSendOutcome(),
          }),
      );
      let rawOutcomes: unknown;
      try {
        rawOutcomes = await this.#transport.sendChunk(
          fresh.map((entry) => entry.workItem),
        );
      } catch (error) {
        const failure = failureFromError(error);
        freshCompletions = fresh.map(() =>
          Object.freeze({ kind: 'failure' as const, failure }),
        );
        rawOutcomes = null;
      }
      if (rawOutcomes !== null) {
        try {
          if (
            !Array.isArray(rawOutcomes) ||
            rawOutcomes.length !== fresh.length
          ) {
            throw new TypeError('Expo send outcomes are invalid.');
          }
          freshCompletions = Array.from(
            { length: fresh.length },
            (_unused, index) => {
              try {
                return safeCompletionFromExpoOutcome(rawOutcomes[index]);
              } catch {
                return Object.freeze({
                  kind: 'outcome' as const,
                  outcome: unknownSendOutcome(),
                });
              }
            },
          );
        } catch {
          // Provider I/O returned successfully, so failures while validating
          // the untrusted result container are ambiguous and never retryable.
          freshCompletions = fresh.map(() =>
            Object.freeze({
              kind: 'outcome' as const,
              outcome: unknownSendOutcome(),
            }),
          );
        }
      }
      let freshIndex = 0;
      for (let index = 0; index < pending.length; index += 1) {
        if (completions[index] === undefined) {
          completions[index] = freshCompletions[freshIndex];
          freshIndex += 1;
        }
      }
    }
    pending.forEach((entry, index) => {
      const completion = completions[index];
      entry.resolve(
        completion ??
          Object.freeze({
            kind: 'outcome',
            outcome: unknownSendOutcome(),
          }),
      );
    });
  }
}
