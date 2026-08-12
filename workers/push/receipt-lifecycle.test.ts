import { describe, expect, test } from 'bun:test';
import {
  DeliveryEvidenceSchema,
  type DeliveryEvidence,
  type RecordEndpointStatusInput,
} from '@psd-eoc/contracts';

import type { AttemptEvidenceWriter } from '../shared/delivery-state-client';
import { parseDeliveryStateWriteRequest } from '../shared/delivery-state-client';
import { ProviderDispatchError } from '../shared/retry';
import { TIMES, workItem } from '../shared/test-fixtures';
import type { PushEndpointInvalidator } from './invalidation';
import { MOCK_EXPO_PUSH_PROVIDER } from './mock';
import {
  isExpoSafeReasonCode,
  unknown,
  type ExpoProviderOutcome,
} from './protocol';
import {
  EXPO_RECEIPT_HORIZON_MILLISECONDS,
  EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS,
  ExpoReceiptLifecycle,
  ExpoReceiptLifecycleBatchError,
  createPersistedExpoReceiptTarget,
  parsePersistedExpoReceiptTarget,
  type DurableExpoReceiptStore,
  type ExpoReceiptClaim,
  type ExpoReceiptClaimRequest,
  type ExpoReceiptDecisionRequest,
  type ExpoReceiptDurableDecision,
  type ExpoReceiptPendingAction,
  type ExpoReceiptResendRequest,
  type ExpoReceiptResendResult,
  type ExpoReceiptResendScheduler,
  type ExpoReceiptScheduleRequest,
} from './receipt-lifecycle';
import type { ExpoPushTransport } from './transport';

const ATTEMPTED_EVIDENCE_ID = '00000000-0000-4000-8000-000000000701';
const ACCEPTED_EVIDENCE_ID = '00000000-0000-4000-8000-000000000702';

interface StoredReceipt {
  readonly schedule: ExpoReceiptScheduleRequest;
  dueAt: string;
  pollAttemptNumber: number;
  lastReasonCode: ExpoReceiptClaim['lastReasonCode'];
  receiptReferenceState: ExpoReceiptClaim['receiptReferenceState'];
  pendingAction: ExpoReceiptPendingAction | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  leaseGeneration: number;
  decision: ExpoReceiptDurableDecision | null;
}

class MemoryReceiptStore implements DurableExpoReceiptStore {
  public readonly rows = new Map<string, StoredReceipt>();
  public readonly scheduleCalls: ExpoReceiptScheduleRequest[] = [];
  public readonly claimCalls: ExpoReceiptClaimRequest[] = [];
  public readonly decisionCalls: ExpoReceiptDecisionRequest[] = [];
  public failSchedule = false;
  public failClaim = false;
  public failDecide = false;
  public failDecisionKindOnce: ExpoReceiptDurableDecision['kind'] | null = null;
  public failDecisionAttemptId: string | null = null;
  public leaseClockSkewMilliseconds = 0;
  public claimExtras: (
    claims: readonly ExpoReceiptClaim[],
  ) => readonly unknown[] = () => [];
  public claimResultDecorator: (
    claims: ExpoReceiptClaim[],
  ) => readonly ExpoReceiptClaim[] = (claims) => claims;
  public beforeDecide: (request: ExpoReceiptDecisionRequest) => Promise<void> =
    () => Promise.resolve();
  public afterDecide: (request: ExpoReceiptDecisionRequest) => void = () =>
    undefined;

  public constructor(
    private readonly events: string[] = [],
    private readonly clock: () => string = () => TIMES.recorded,
  ) {}

  public schedule(request: ExpoReceiptScheduleRequest): Promise<void> {
    if (this.failSchedule) throw new Error('Synthetic schedule store failure.');
    const target = parsePersistedExpoReceiptTarget(request.target);
    this.scheduleCalls.push(request);
    const existing = this.rows.get(target.attempt.id);
    if (existing !== undefined) {
      if (
        existing.schedule.target.fingerprint !== target.fingerprint ||
        existing.schedule.firstPollAt !== request.firstPollAt ||
        existing.schedule.horizonAt !== request.horizonAt
      ) {
        throw new Error('Synthetic receipt schedule conflict.');
      }
      return Promise.resolve();
    }
    const priorReceiptRows = [...this.rows.values()].filter(
      (row) => row.schedule.target.receiptId === target.receiptId,
    );
    this.rows.set(target.attempt.id, {
      schedule: request,
      dueAt: request.firstPollAt,
      pollAttemptNumber: 1,
      lastReasonCode: null,
      receiptReferenceState:
        priorReceiptRows.length === 0 ? 'unique' : 'conflict',
      pendingAction: null,
      leaseToken: null,
      leaseExpiresAt: null,
      leaseGeneration: 0,
      decision: null,
    });
    if (priorReceiptRows.length > 0) {
      for (const row of priorReceiptRows) {
        if (row.decision === null && row.pendingAction === null) {
          row.receiptReferenceState = 'conflict';
        }
      }
      const scheduled = this.rows.get(target.attempt.id);
      if (scheduled !== undefined) {
        scheduled.receiptReferenceState = 'conflict';
      }
    }
    return Promise.resolve();
  }

  public claimDue(
    request: ExpoReceiptClaimRequest,
  ): Promise<readonly ExpoReceiptClaim[]> {
    if (this.failClaim) throw new Error('Synthetic claim store failure.');
    this.claimCalls.push(request);
    const claims: ExpoReceiptClaim[] = [];
    const nowMilliseconds = Date.parse(request.now);
    for (const row of this.rows.values()) {
      const leaseIsCurrent =
        row.leaseToken !== null &&
        row.leaseExpiresAt !== null &&
        Date.parse(row.leaseExpiresAt) > nowMilliseconds;
      if (
        claims.length >= request.limit ||
        row.decision !== null ||
        leaseIsCurrent ||
        Date.parse(row.dueAt) > Date.parse(request.now)
      ) {
        continue;
      }
      row.leaseGeneration += 1;
      row.leaseToken = `lease-${row.schedule.target.attempt.id}-${row.leaseGeneration}`;
      row.leaseExpiresAt = new Date(
        nowMilliseconds +
          request.leaseMilliseconds +
          this.leaseClockSkewMilliseconds,
      ).toISOString();
      claims.push({
        target: row.schedule.target,
        dueAt: row.dueAt,
        horizonAt: row.schedule.horizonAt,
        pollAttemptNumber: row.pollAttemptNumber,
        lastReasonCode: row.lastReasonCode,
        receiptReferenceState: row.receiptReferenceState,
        pendingAction: row.pendingAction,
        leaseToken: row.leaseToken,
        leaseExpiresAt: row.leaseExpiresAt,
      });
    }
    const result = [
      ...claims,
      ...(this.claimExtras(claims) as readonly ExpoReceiptClaim[]),
    ];
    return Promise.resolve(this.claimResultDecorator(result));
  }

  public async decide(request: ExpoReceiptDecisionRequest): Promise<void> {
    await this.beforeDecide(request);
    if (this.failDecide) throw new Error('Synthetic decision store failure.');
    const row = this.rows.get(request.attemptId);
    if (
      row === undefined ||
      row.schedule.target.fingerprint !== request.fingerprint ||
      row.leaseToken !== request.leaseToken ||
      row.leaseExpiresAt === null ||
      Date.parse(row.leaseExpiresAt) <= Date.parse(this.clock()) ||
      row.decision !== null
    ) {
      throw new Error('Synthetic receipt decision conflict.');
    }
    if (
      row.receiptReferenceState === 'conflict' &&
      !(
        (request.decision.kind === 'known-outcome-pending' &&
          request.decision.action.kind === 'terminal-unknown' &&
          request.decision.action.reasonCode ===
            'EXPO_RECEIPT_REFERENCE_CONFLICT') ||
        (request.decision.kind === 'terminal-dlq' &&
          request.decision.state === 'unknown' &&
          request.decision.reasonCode === 'EXPO_RECEIPT_REFERENCE_CONFLICT')
      )
    ) {
      throw new Error('Synthetic receipt decision conflict.');
    }
    if (request.decision.kind === 'known-outcome-pending') {
      if (
        row.pendingAction !== null &&
        JSON.stringify(row.pendingAction) !==
          JSON.stringify(request.decision.action)
      ) {
        throw new Error('Synthetic receipt decision conflict.');
      }
    } else if (
      row.pendingAction !== null &&
      !decisionCompletesPendingAction(row.pendingAction, request.decision)
    ) {
      throw new Error('Synthetic receipt decision conflict.');
    }
    if (
      this.failDecisionKindOnce === request.decision.kind &&
      (this.failDecisionAttemptId === null ||
        this.failDecisionAttemptId === request.attemptId)
    ) {
      this.failDecisionKindOnce = null;
      this.failDecisionAttemptId = null;
      throw new Error('Synthetic decision store failure.');
    }
    this.decisionCalls.push(request);
    this.events.push(`store:${request.decision.kind}`);
    if (request.decision.kind === 'known-outcome-pending') {
      row.pendingAction = request.decision.action;
    } else if (request.decision.kind === 'reschedule') {
      row.dueAt = request.decision.nextPollAt;
      row.pollAttemptNumber = request.decision.nextPollAttemptNumber;
      row.lastReasonCode = request.decision.reasonCode;
      row.pendingAction = null;
      row.leaseToken = null;
      row.leaseExpiresAt = null;
    } else {
      row.decision = request.decision;
      row.pendingAction = null;
      row.leaseToken = null;
      row.leaseExpiresAt = null;
    }
    this.afterDecide(request);
    return Promise.resolve();
  }

  public forceDue(
    attemptId: string,
    dueAt: string,
    pollAttemptNumber: number,
    lastReasonCode: ExpoReceiptClaim['lastReasonCode'],
  ): void {
    const row = this.rows.get(attemptId);
    if (row === undefined) throw new Error('Synthetic receipt row is missing.');
    row.dueAt = dueAt;
    row.pollAttemptNumber = pollAttemptNumber;
    row.lastReasonCode = lastReasonCode;
    row.leaseToken = null;
    row.leaseExpiresAt = null;
  }
}

function decisionCompletesPendingAction(
  action: ExpoReceiptPendingAction,
  decision: ExpoReceiptDurableDecision,
): boolean {
  if (action.kind === 'terminal-unknown') {
    return (
      decision.kind === 'terminal-dlq' &&
      decision.state === action.state &&
      decision.reasonCode === action.reasonCode
    );
  }
  if (action.kind === 'terminal-expiry') {
    return (
      decision.kind === 'terminal-dlq' &&
      decision.state === action.state &&
      decision.reasonCode === action.reasonCode
    );
  }
  if (action.kind === 'terminal-failure') {
    return (
      decision.kind === 'terminal-dlq' &&
      decision.state === action.state &&
      decision.reasonCode === action.reasonCode
    );
  }
  if (
    decision.kind === 'terminal-dlq' &&
    decision.state === 'expired' &&
    decision.reasonCode === 'EXPO_NOTIFICATION_EXPIRED'
  ) {
    return true;
  }
  return (
    decision.kind === 'resend-scheduled' &&
    decision.state === action.state &&
    decision.reasonCode === action.reasonCode &&
    decision.nextAttemptNumber === action.nextAttemptNumber &&
    decision.delayMilliseconds === action.delayMilliseconds &&
    decision.retryAt === action.retryAt &&
    decision.expiresAt === action.expiresAt
  );
}

type TransportBehavior =
  | readonly ExpoProviderOutcome[]
  | Error
  | ProviderDispatchError;

class SequenceReceiptTransport implements ExpoPushTransport {
  public readonly queries: string[][] = [];

  public constructor(private readonly behaviors: TransportBehavior[]) {}

  public sendChunk(): Promise<readonly ExpoProviderOutcome[]> {
    throw new Error('Receipt lifecycle transport cannot send.');
  }

  public queryReceiptChunk(
    receiptIds: readonly string[],
  ): Promise<readonly ExpoProviderOutcome[]> {
    this.queries.push([...receiptIds]);
    const behavior = this.behaviors.shift();
    if (behavior instanceof Error) return Promise.reject(behavior);
    return Promise.resolve(behavior ?? []);
  }
}

class RecordingEvidenceWriter implements AttemptEvidenceWriter {
  public readonly evidence: DeliveryEvidence[] = [];

  public constructor(private readonly events: string[] = []) {}

  public recordAttemptEvidence(value: unknown): Promise<DeliveryEvidence> {
    const request = parseDeliveryStateWriteRequest(value);
    const existing = this.evidence.find(
      (entry) =>
        entry.subject.kind === 'attempt' &&
        entry.subject.attemptId === request.attempt.id &&
        entry.state === request.evidence.state &&
        entry.reasonCode === request.evidence.reasonCode,
    );
    if (existing !== undefined) return Promise.resolve(existing);
    const result = DeliveryEvidenceSchema.parse({
      id: `00000000-0000-4000-8000-${String(703 + this.evidence.length).padStart(12, '0')}`,
      subject: request.evidence.subject,
      sequence: 3,
      previousEvidenceId: ACCEPTED_EVIDENCE_ID,
      state: request.evidence.state,
      recordedAt: TIMES.recorded,
      provider: request.evidence.provider,
      providerReference: request.evidence.providerReference,
      proof: request.evidence.proof,
      reasonCode: request.evidence.reasonCode,
      diagnosticDigest: request.evidence.diagnosticDigest,
    });
    this.evidence.push(result);
    this.events.push(`evidence:${result.state}`);
    return Promise.resolve(result);
  }
}

class RecordingInvalidator implements PushEndpointInvalidator {
  public readonly inputs: RecordEndpointStatusInput[] = [];
  public failOnce = false;

  public constructor(private readonly events: string[] = []) {}

  public invalidate(input: RecordEndpointStatusInput): Promise<void> {
    if (this.failOnce) {
      this.failOnce = false;
      return Promise.reject(new Error('Synthetic invalidation failure.'));
    }
    if (
      this.inputs.some(
        (existing) => JSON.stringify(existing) === JSON.stringify(input),
      )
    ) {
      return Promise.resolve();
    }
    this.inputs.push(input);
    this.events.push('invalidate');
    return Promise.resolve();
  }
}

class RecordingResendScheduler implements ExpoReceiptResendScheduler {
  public readonly requests: ExpoReceiptResendRequest[] = [];
  public failOnce = false;
  readonly #scheduled = new Map<string, string>();

  public constructor(
    private readonly events: string[] = [],
    private readonly clock: () => string = () => TIMES.recorded,
  ) {}

  public scheduleReceiptRetry(
    request: ExpoReceiptResendRequest,
  ): Promise<ExpoReceiptResendResult> {
    const key = `${request.sourceAttempt.id}:${request.sourceFingerprint}`;
    const serialized = JSON.stringify(request);
    const existing = this.#scheduled.get(key);
    if (existing !== undefined) {
      if (existing !== serialized) {
        throw new Error('Synthetic receipt resend schedule conflict.');
      }
      return Promise.resolve({ kind: 'scheduled' });
    }
    if (this.failOnce) {
      this.failOnce = false;
      return Promise.reject(new Error('Synthetic resend schedule failure.'));
    }
    if (Date.parse(this.clock()) >= Date.parse(request.expiresAt)) {
      return Promise.resolve({ kind: 'expired' });
    }
    this.#scheduled.set(key, serialized);
    this.requests.push(request);
    this.events.push('resend');
    return Promise.resolve({ kind: 'scheduled' });
  }
}

function acceptedEvidence(
  attemptId: string,
  provider = MOCK_EXPO_PUSH_PROVIDER,
  providerReference = `receipt-${attemptId}`,
): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: ACCEPTED_EVIDENCE_ID,
    subject: { kind: 'attempt', attemptId },
    sequence: 2,
    previousEvidenceId: ATTEMPTED_EVIDENCE_ID,
    state: 'provider-accepted',
    recordedAt: TIMES.recorded,
    provider,
    providerReference,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
}

function receiptItemError(attemptId: string) {
  return {
    kind: 'error',
    attemptId,
    errorCode: 'EXPO_RECEIPT_ITEM_FAILED',
  } as const;
}

function after(milliseconds: number): string {
  return new Date(Date.parse(TIMES.recorded) + milliseconds).toISOString();
}

function runtime(
  behaviors: TransportBehavior[] = [],
  options: Readonly<{
    random?: () => number;
    attemptNumber?: number;
    maxSendAttempts?: number;
  }> = {},
) {
  const events: string[] = [];
  const item = workItem(undefined, {
    ...(options.attemptNumber === undefined
      ? {}
      : { attemptNumber: options.attemptNumber }),
  });
  const evidence = acceptedEvidence(item.attempt.id);
  const clock = { now: after(EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS) };
  const store = new MemoryReceiptStore(events, () => clock.now);
  const transport = new SequenceReceiptTransport(behaviors);
  const writer = new RecordingEvidenceWriter(events);
  const invalidator = new RecordingInvalidator(events);
  const resendScheduler = new RecordingResendScheduler(events, () => clock.now);
  const lifecycle = new ExpoReceiptLifecycle({
    store,
    transport,
    evidenceWriter: writer,
    endpointInvalidator: invalidator,
    resendScheduler,
    provider: MOCK_EXPO_PUSH_PROVIDER,
    clock: () => clock.now,
    random: options.random ?? (() => 0.5),
    ...(options.maxSendAttempts === undefined
      ? {}
      : { maxSendAttempts: options.maxSendAttempts }),
  });
  return {
    clock,
    evidence,
    events,
    invalidator,
    item,
    lifecycle,
    resendScheduler,
    store,
    transport,
    writer,
  };
}

async function scheduledRuntime(
  behaviors: TransportBehavior[] = [],
  options: Readonly<{
    random?: () => number;
    attemptNumber?: number;
    maxSendAttempts?: number;
  }> = {},
) {
  const app = runtime(behaviors, options);
  await app.lifecycle.scheduleProviderAccepted(app.item, app.evidence);
  return app;
}

describe('durable Expo receipt scheduling', () => {
  test('persists an exact token-free fingerprinted target idempotently at +15m with a +23h45m horizon', async () => {
    const app = runtime();

    await app.lifecycle.scheduleProviderAccepted(app.item, app.evidence);
    await app.lifecycle.scheduleProviderAccepted(app.item, app.evidence);

    expect(app.store.rows).toHaveLength(1);
    expect(app.store.scheduleCalls).toHaveLength(2);
    const schedule = app.store.scheduleCalls[0]!;
    expect(Object.keys(schedule.target).sort()).toEqual([
      'attempt',
      'batchCreatedAt',
      'expiresAt',
      'fingerprint',
      'providerAcceptedEvidence',
      'receiptId',
    ]);
    expect(schedule.firstPollAt).toBe(
      after(EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS),
    );
    expect(schedule.horizonAt).toBe(after(EXPO_RECEIPT_HORIZON_MILLISECONDS));
    expect(schedule.target.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(schedule.target.batchCreatedAt).toBe(app.item.batch.createdAt);
    expect(schedule.target.expiresAt).toBe(
      new Date(
        Date.parse(app.item.batch.createdAt) + 60 * 60_000,
      ).toISOString(),
    );
    expect(JSON.stringify(schedule.target)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(schedule.target)).not.toContain('"token":');
  });

  test('rejects fingerprint drift and extra destination fields, then isolates a malformed leased row', async () => {
    const app = await scheduledRuntime();
    const target = createPersistedExpoReceiptTarget(app.item, app.evidence);

    expect(() =>
      parsePersistedExpoReceiptTarget({
        ...target,
        fingerprint: '0'.repeat(64),
      }),
    ).toThrow('Persisted Expo receipt target is invalid.');
    expect(() =>
      parsePersistedExpoReceiptTarget({
        ...target,
        token: 'ExponentPushToken[forbidden]',
      }),
    ).toThrow('Persisted Expo receipt target is invalid.');

    app.store.forceDue(
      app.item.attempt.id,
      after(EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS - 1),
      2,
      'EXPO_RECEIPT_MISSING',
    );
    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(app.transport.queries).toHaveLength(0);
  });

  test('rejects accessor-backed durable targets and claims without invoking getters', async () => {
    const app = await scheduledRuntime();
    const target = createPersistedExpoReceiptTarget(app.item, app.evidence);
    let targetGetterCalls = 0;
    const accessorTarget = { ...target };
    Object.defineProperty(accessorTarget, 'receiptId', {
      enumerable: true,
      get: () => {
        targetGetterCalls += 1;
        return target.receiptId;
      },
    });
    expect(() => parsePersistedExpoReceiptTarget(accessorTarget)).toThrow(
      'Persisted Expo receipt target is invalid.',
    );
    expect(targetGetterCalls).toBe(0);

    let claimGetterCalls = 0;
    app.store.claimExtras = (claims) => {
      const accessorClaim = { ...claims[0]! };
      Object.defineProperty(accessorClaim, 'dueAt', {
        enumerable: true,
        get: () => {
          claimGetterCalls += 1;
          return claims[0]!.dueAt;
        },
      });
      return [accessorClaim];
    };
    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [
        expect.objectContaining({
          decision: expect.objectContaining({
            kind: 'reschedule',
            reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID',
          }),
        }),
        receiptItemError('00000000-0000-4000-8000-000000000000'),
      ],
    });
    expect(claimGetterCalls).toBe(0);
    expect(app.transport.queries).toHaveLength(1);
  });

  test('isolates an impossible persisted last reason instead of terminalizing definite truth', async () => {
    const app = await scheduledRuntime();
    const row = app.store.rows.get(app.item.attempt.id)!;
    row.dueAt = app.clock.now;
    row.pollAttemptNumber = 2;
    row.lastReasonCode = 'EXPO_DEVICE_NOT_REGISTERED' as never;

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(app.transport.queries).toHaveLength(0);
    expect(app.writer.evidence).toHaveLength(0);
    expect(row.decision).toBeNull();
  });

  test('isolates a corrupted ambiguous pending action instead of replaying it as a definite failure', async () => {
    const app = await scheduledRuntime();
    const row = app.store.rows.get(app.item.attempt.id)!;
    row.pendingAction = Object.freeze({
      kind: 'terminal-failure',
      state: 'failed',
      reasonCode: 'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
      invalidatesEndpoint: false,
    }) as unknown as ExpoReceiptPendingAction;
    app.clock.now = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(app.transport.queries).toHaveLength(0);
    expect(app.writer.evidence).toHaveLength(0);
    expect(app.invalidator.inputs).toHaveLength(0);
    expect(row.decision).toBeNull();
  });

  test('isolates terminal-unknown pending actions whose durable truth context is impossible', async () => {
    const uniqueConflict = await scheduledRuntime();
    const uniqueConflictRow = uniqueConflict.store.rows.get(
      uniqueConflict.item.attempt.id,
    )!;
    uniqueConflictRow.pendingAction = Object.freeze({
      kind: 'terminal-unknown',
      state: 'unknown',
      reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
    });

    await expect(uniqueConflict.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(uniqueConflict.writer.evidence).toHaveLength(0);
    expect(uniqueConflict.store.decisionCalls).toHaveLength(0);
    expect(uniqueConflictRow.decision).toBeNull();

    const prematureHorizon = await scheduledRuntime();
    const prematureHorizonRow = prematureHorizon.store.rows.get(
      prematureHorizon.item.attempt.id,
    )!;
    prematureHorizonRow.pendingAction = Object.freeze({
      kind: 'terminal-unknown',
      state: 'unknown',
      reasonCode: 'EXPO_RECEIPT_HORIZON_EXPIRED',
    });

    await expect(prematureHorizon.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(prematureHorizon.writer.evidence).toHaveLength(0);
    expect(prematureHorizon.store.decisionCalls).toHaveLength(0);
    expect(prematureHorizonRow.decision).toBeNull();

    const wrongHorizonReason = await scheduledRuntime();
    const wrongHorizonReasonRow = wrongHorizonReason.store.rows.get(
      wrongHorizonReason.item.attempt.id,
    )!;
    const horizonAt = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    wrongHorizonReason.store.forceDue(
      wrongHorizonReason.item.attempt.id,
      horizonAt,
      2,
      'EXPO_RECEIPT_MISSING',
    );
    wrongHorizonReasonRow.pendingAction = Object.freeze({
      kind: 'terminal-unknown',
      state: 'unknown',
      reasonCode: 'EXPO_HTTP_SERVER_ERROR',
    });
    wrongHorizonReason.clock.now = horizonAt;

    await expect(wrongHorizonReason.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(wrongHorizonReason.writer.evidence).toHaveLength(0);
    expect(wrongHorizonReason.store.decisionCalls).toHaveLength(0);
    expect(wrongHorizonReasonRow.decision).toBeNull();
  });

  test('isolates a non-conflict terminal unknown staged on a conflict row', async () => {
    const app = await scheduledRuntime();
    const row = app.store.rows.get(app.item.attempt.id)!;
    const horizonAt = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    app.store.forceDue(
      app.item.attempt.id,
      horizonAt,
      2,
      'EXPO_RECEIPT_MISSING',
    );
    row.receiptReferenceState = 'conflict';
    row.pendingAction = Object.freeze({
      kind: 'terminal-unknown',
      state: 'unknown',
      reasonCode: 'EXPO_RECEIPT_MISSING',
    });
    app.clock.now = horizonAt;

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(app.writer.evidence).toHaveLength(0);
    expect(app.store.decisionCalls).toHaveLength(0);
    expect(row.decision).toBeNull();
  });

  test('leases atomically, reclaims only at expiry with a fresh token, and fences the stale claimant', async () => {
    const app = await scheduledRuntime();
    const claimRequest: ExpoReceiptClaimRequest = {
      now: app.clock.now,
      limit: 1,
      leaseMilliseconds: 120_000,
    };
    const [firstClaim] = await app.store.claimDue(claimRequest);
    expect(firstClaim?.leaseExpiresAt).toBe(
      new Date(Date.parse(app.clock.now) + 120_000).toISOString(),
    );
    await expect(app.store.claimDue(claimRequest)).resolves.toEqual([]);

    app.clock.now = new Date(
      Date.parse(claimRequest.now) + claimRequest.leaseMilliseconds,
    ).toISOString();
    const completion: ExpoReceiptDurableDecision = {
      kind: 'complete',
      decidedAt: app.clock.now,
      state: 'provider-accepted',
    };
    await expect(
      Promise.resolve().then(() =>
        app.store.decide({
          attemptId: firstClaim!.target.attempt.id,
          fingerprint: firstClaim!.target.fingerprint,
          leaseToken: firstClaim!.leaseToken,
          decision: completion,
        }),
      ),
    ).rejects.toThrow('Synthetic receipt decision conflict.');

    const [reclaimed] = await app.store.claimDue({
      ...claimRequest,
      now: app.clock.now,
    });
    expect(reclaimed?.leaseToken).not.toBe(firstClaim?.leaseToken);
    await expect(
      Promise.resolve().then(() =>
        app.store.decide({
          attemptId: firstClaim!.target.attempt.id,
          fingerprint: firstClaim!.target.fingerprint,
          leaseToken: firstClaim!.leaseToken,
          decision: completion,
        }),
      ),
    ).rejects.toThrow('Synthetic receipt decision conflict.');
    await expect(
      app.store.decide({
        attemptId: reclaimed!.target.attempt.id,
        fingerprint: reclaimed!.target.fingerprint,
        leaseToken: reclaimed!.leaseToken,
        decision: completion,
      }),
    ).resolves.toBeUndefined();
  });

  test('accepts bounded store clock skew but isolates an overlong lease', async () => {
    const accepted = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    accepted.store.leaseClockSkewMilliseconds = 20_000;
    await expect(accepted.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
    ]);

    const overlong = await scheduledRuntime();
    overlong.store.leaseClockSkewMilliseconds = 30_001;
    await expect(overlong.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
    });
    expect(overlong.transport.queries).toHaveLength(0);
  });

  test('propagates schedule-store failure instead of reporting durable success', async () => {
    const app = runtime();
    app.store.failSchedule = true;

    await expect(
      app.lifecycle.scheduleProviderAccepted(app.item, app.evidence),
    ).rejects.toThrow('Synthetic schedule store failure.');
    expect(app.store.rows).toHaveLength(0);
  });
});

describe('due receipt claims and durable decisions', () => {
  test('isolates a malformed claim and preserves an exact duplicate result without duplicate I/O', async () => {
    const malformed = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    malformed.store.claimExtras = () => [{ malformed: true }];
    await expect(malformed.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [
        expect.objectContaining({
          decision: expect.objectContaining({ kind: 'complete' }),
        }),
        receiptItemError('00000000-0000-4000-8000-000000000000'),
      ],
    });
    expect(malformed.transport.queries).toHaveLength(1);

    const collision = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    collision.store.claimExtras = (claims) => [claims[0]!];
    await expect(collision.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        attemptId: collision.item.attempt.id,
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
      expect.objectContaining({
        attemptId: collision.item.attempt.id,
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
    ]);
    expect(collision.transport.queries).toEqual([[appReceiptId()]]);
    expect(collision.store.decisionCalls).toHaveLength(1);
  });

  test('uses bounded indexed claim traversal instead of a store array iterator', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    let iteratorCalls = 0;
    let lengthReads = 0;
    app.store.claimResultDecorator = (claims) => {
      Object.defineProperty(claims, Symbol.iterator, {
        configurable: true,
        value: () => {
          iteratorCalls += 1;
          throw new Error('synthetic hostile claim iterator');
        },
      });
      return new Proxy(claims, {
        get(target, property, receiver) {
          if (property === 'length') {
            lengthReads += 1;
            throw new Error('synthetic hostile claim length read');
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    };

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
    ]);
    expect(iteratorCalls).toBe(0);
    expect(lengthReads).toBe(0);
    expect(app.transport.queries).toHaveLength(1);
  });

  test('isolates an accessor-backed actual claim slot while preserving its valid sibling', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    let slotGetterCalls = 0;
    app.store.claimResultDecorator = (claims) => {
      claims.push(claims[0]!);
      Object.defineProperty(claims, 1, {
        configurable: true,
        enumerable: true,
        get: () => {
          slotGetterCalls += 1;
          throw new Error('synthetic hostile claim slot');
        },
      });
      return claims;
    };

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [
        expect.objectContaining({
          decision: expect.objectContaining({ kind: 'complete' }),
        }),
        receiptItemError('00000000-0000-4000-8000-000000000000'),
      ],
    });
    expect(slotGetterCalls).toBe(0);
    expect(app.transport.queries).toHaveLength(1);
  });

  test('keeps receipt-reference collisions sticky, never queries Expo, and ends both attempts unknown', async () => {
    const secondItem = workItem(undefined, {
      attemptId: '00000000-0000-4000-8000-000000000799',
    });
    const app = await scheduledRuntime();
    const secondEvidence = acceptedEvidence(
      secondItem.attempt.id,
      MOCK_EXPO_PUSH_PROVIDER,
      app.evidence.providerReference!,
    );
    await app.lifecycle.scheduleProviderAccepted(secondItem, secondEvidence);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        attemptId: app.item.attempt.id,
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
        }),
      }),
      expect.objectContaining({
        attemptId: secondItem.attempt.id,
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
        }),
      }),
    ]);
    expect(app.transport.queries).toHaveLength(0);
    expect(
      [...app.store.rows.values()].map((row) => row.receiptReferenceState),
    ).toEqual(['conflict', 'conflict']);

    expect(app.transport.queries).toHaveLength(0);
    expect(app.writer.evidence).toHaveLength(2);
    expect(
      app.writer.evidence.every(
        (entry) =>
          entry.state === 'unknown' &&
          entry.reasonCode === 'EXPO_RECEIPT_REFERENCE_CONFLICT',
      ),
    ).toBe(true);
  });

  test('rejects a stale unique-claim decision when a colliding schedule wins first', async () => {
    const app = await scheduledRuntime();
    const [staleUniqueClaim] = await app.store.claimDue({
      now: app.clock.now,
      limit: 1,
      leaseMilliseconds: 120_000,
    });
    expect(staleUniqueClaim?.receiptReferenceState).toBe('unique');

    const secondItem = workItem(undefined, {
      attemptId: '00000000-0000-4000-8000-000000000794',
    });
    await app.lifecycle.scheduleProviderAccepted(
      secondItem,
      acceptedEvidence(
        secondItem.attempt.id,
        MOCK_EXPO_PUSH_PROVIDER,
        app.evidence.providerReference!,
      ),
    );
    expect(app.store.rows.get(app.item.attempt.id)?.receiptReferenceState).toBe(
      'conflict',
    );

    await expect(
      app.store.decide({
        attemptId: staleUniqueClaim!.target.attempt.id,
        fingerprint: staleUniqueClaim!.target.fingerprint,
        leaseToken: staleUniqueClaim!.leaseToken,
        decision: {
          kind: 'complete',
          decidedAt: app.clock.now,
          state: 'provider-accepted',
        },
      }),
    ).rejects.toThrow('Synthetic receipt decision conflict.');
    expect(app.store.rows.get(app.item.attempt.id)?.decision).toBeNull();
    expect(app.store.decisionCalls).toHaveLength(0);
  });

  test('a staged outcome wins before a later receipt collision is recorded', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'failed',
          state: 'failed',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
          invalidatesEndpoint: true,
        },
      ],
    ]);
    app.invalidator.failOnce = true;
    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(app.item.attempt.id)],
    });
    expect(
      app.store.rows.get(app.item.attempt.id)?.pendingAction,
    ).toMatchObject({
      kind: 'terminal-failure',
      reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
    });

    const secondItem = workItem(undefined, {
      attemptId: '00000000-0000-4000-8000-000000000797',
    });
    await app.lifecycle.scheduleProviderAccepted(
      secondItem,
      acceptedEvidence(
        secondItem.attempt.id,
        MOCK_EXPO_PUSH_PROVIDER,
        app.evidence.providerReference!,
      ),
    );
    app.clock.now = new Date(Date.parse(app.clock.now) + 120_000).toISOString();

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        attemptId: app.item.attempt.id,
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'failed',
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        }),
      }),
      expect.objectContaining({
        attemptId: secondItem.attempt.id,
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
        }),
      }),
    ]);
    expect(app.transport.queries).toHaveLength(1);
    expect(app.invalidator.inputs).toHaveLength(1);
  });

  test('a staged resend wins in the same batch as its later colliding sibling', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'retry',
          state: 'failed',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
          invalidatesEndpoint: false,
        },
      ],
    ]);
    app.resendScheduler.failOnce = true;
    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(app.item.attempt.id)],
    });
    expect(
      app.store.rows.get(app.item.attempt.id)?.pendingAction,
    ).toMatchObject({
      kind: 'resend',
      reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
    });

    const secondItem = workItem(undefined, {
      attemptId: '00000000-0000-4000-8000-000000000796',
    });
    await app.lifecycle.scheduleProviderAccepted(
      secondItem,
      acceptedEvidence(
        secondItem.attempt.id,
        MOCK_EXPO_PUSH_PROVIDER,
        app.evidence.providerReference!,
      ),
    );
    app.clock.now = new Date(Date.parse(app.clock.now) + 120_000).toISOString();

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        attemptId: app.item.attempt.id,
        decision: expect.objectContaining({
          kind: 'resend-scheduled',
          reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
        }),
      }),
      expect.objectContaining({
        attemptId: secondItem.attempt.id,
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
        }),
      }),
    ]);
    expect(app.resendScheduler.requests).toHaveLength(1);
    expect(app.writer.evidence).toEqual([
      expect.objectContaining({
        state: 'failed',
        reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
      }),
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'EXPO_RECEIPT_REFERENCE_CONFLICT',
      }),
    ]);
  });

  test('isolates one claim decision failure while durably completing its sibling', async () => {
    const secondItem = workItem(undefined, {
      attemptId: '00000000-0000-4000-8000-000000000798',
    });
    const secondEvidence = acceptedEvidence(secondItem.attempt.id);
    const app = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: secondEvidence.providerReference!,
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    await app.lifecycle.scheduleProviderAccepted(secondItem, secondEvidence);
    app.store.failDecisionKindOnce = 'complete';
    app.store.failDecisionAttemptId = app.item.attempt.id;

    const captured = await app.lifecycle
      .runDue()
      .catch((error: unknown) => error);
    expect(captured).toBeInstanceOf(ExpoReceiptLifecycleBatchError);
    const batchError = captured as ExpoReceiptLifecycleBatchError;
    expect(batchError).toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [
        receiptItemError(app.item.attempt.id),
        expect.objectContaining({
          attemptId: secondItem.attempt.id,
          decision: expect.objectContaining({ kind: 'complete' }),
        }),
      ],
    });
    expect(Object.isFrozen(batchError)).toBe(true);
    expect(Object.isFrozen(batchError.results)).toBe(true);
    expect(batchError.results.every((result) => Object.isFrozen(result))).toBe(
      true,
    );
    expect(Object.hasOwn(batchError, 'cause')).toBe(false);
    expect(Object.hasOwn(batchError, 'errors')).toBe(false);
    expect(JSON.stringify(batchError)).not.toContain(
      'Synthetic decision store failure.',
    );

    expect(app.store.rows.get(app.item.attempt.id)?.decision).toBeNull();
    expect(app.store.rows.get(secondItem.attempt.id)?.decision).toMatchObject({
      kind: 'complete',
      state: 'provider-accepted',
    });
    expect(app.transport.queries).toHaveLength(1);
    expect(app.store.decisionCalls).toHaveLength(1);
  });

  test('starts sibling lifecycle decisions concurrently when one item is hung', async () => {
    const secondItem = workItem(undefined, {
      attemptId: '00000000-0000-4000-8000-000000000793',
    });
    const secondEvidence = acceptedEvidence(secondItem.attempt.id);
    const app = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: secondEvidence.providerReference!,
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    await app.lifecycle.scheduleProviderAccepted(secondItem, secondEvidence);

    let releaseHung!: () => void;
    const hung = new Promise<void>((resolve) => {
      releaseHung = resolve;
    });
    let reportSiblingDecision!: () => void;
    const siblingDecided = new Promise<void>((resolve) => {
      reportSiblingDecision = resolve;
    });
    app.store.beforeDecide = (request) =>
      request.attemptId === app.item.attempt.id ? hung : Promise.resolve();
    app.store.afterDecide = (request) => {
      if (request.attemptId === secondItem.attempt.id) reportSiblingDecision();
    };

    const running = app.lifecycle.runDue();
    await siblingDecided;
    expect(app.store.rows.get(secondItem.attempt.id)?.decision).toMatchObject({
      kind: 'complete',
      state: 'provider-accepted',
    });
    expect(app.store.rows.get(app.item.attempt.id)?.decision).toBeNull();

    releaseHung();
    await expect(running).resolves.toEqual([
      expect.objectContaining({
        attemptId: app.item.attempt.id,
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
      expect.objectContaining({
        attemptId: secondItem.attempt.id,
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
    ]);
  });

  test('claims only due work with a lease and completes receipt ok without delivered evidence', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    app.clock.now = after(EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS - 1);
    await expect(app.lifecycle.runDue()).resolves.toEqual([]);
    expect(app.transport.queries).toHaveLength(0);

    app.clock.now = after(EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS);
    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'complete',
          state: 'provider-accepted',
        }),
      }),
    ]);
    expect(app.store.claimCalls.at(-1)).toMatchObject({
      leaseMilliseconds: 120_000,
    });
    expect(app.writer.evidence).toHaveLength(0);
    expect(JSON.stringify(app.store.decisionCalls)).not.toContain('delivered');
  });

  test('treats a positionally mismatched provider reference as malformed and never completes the wrong receipt', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: 'receipt-for-another-attempt',
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'reschedule',
          reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID',
        }),
      }),
    ]);
    expect(app.writer.evidence).toHaveLength(0);
    expect(app.store.decisionCalls).not.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
    ]);
  });

  test('reschedules a wrong-phase ticket reason returned by receipt polling', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'unknown',
          state: 'unknown',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_TICKET_MISSING',
          invalidatesEndpoint: false,
        },
      ],
    ]);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'reschedule',
          reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID',
        }),
      }),
    ]);
    expect(app.writer.evidence).toHaveLength(0);
  });

  test('never trusts a fulfilled receipt container or its overridden map', async () => {
    let mapCalls = 0;
    const hostile = [unknown('EXPO_RECEIPT_MISSING', appReceiptId())];
    Object.defineProperty(hostile, 'map', {
      configurable: true,
      value: () => {
        mapCalls += 1;
        return [
          {
            kind: 'failed',
            state: 'failed',
            providerReference: appReceiptId(),
            reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
            invalidatesEndpoint: true,
          },
        ];
      },
    });
    const app = await scheduledRuntime([hostile]);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'reschedule',
          reasonCode: 'EXPO_RECEIPT_MISSING',
        }),
      }),
    ]);
    expect(mapCalls).toBe(0);
    expect(app.writer.evidence).toHaveLength(0);
    expect(app.invalidator.inputs).toHaveLength(0);
  });

  test('reschedules a throwing fulfilled receipt container as invalid', async () => {
    const hostile = new Proxy(
      [unknown('EXPO_RECEIPT_MISSING', appReceiptId())],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new ProviderDispatchError(
              'EXPO_HTTP_SERVER_ERROR',
              'safe-to-retry',
            );
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    const app = await scheduledRuntime([
      hostile as readonly ExpoProviderOutcome[],
    ]);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'reschedule',
          reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID',
        }),
      }),
    ]);
    expect(app.writer.evidence).toHaveLength(0);
  });

  test('isolates a throwing receipt item while completing its valid sibling', async () => {
    const secondItem = workItem(undefined, {
      attemptId: '00000000-0000-4000-8000-000000000795',
    });
    const secondEvidence = acceptedEvidence(secondItem.attempt.id);
    const outcomes = [
      {
        kind: 'provider-accepted',
        state: 'provider-accepted',
        providerReference: appReceiptId(),
        reasonCode: null,
        invalidatesEndpoint: false,
      },
      unknown('EXPO_RECEIPT_MISSING', secondEvidence.providerReference!),
    ] as ExpoProviderOutcome[];
    Object.defineProperty(outcomes, 1, {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('synthetic hostile receipt slot');
      },
    });
    const app = await scheduledRuntime([outcomes]);
    await app.lifecycle.scheduleProviderAccepted(secondItem, secondEvidence);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        attemptId: app.item.attempt.id,
        decision: expect.objectContaining({ kind: 'complete' }),
      }),
      expect.objectContaining({
        attemptId: secondItem.attempt.id,
        decision: expect.objectContaining({
          kind: 'reschedule',
          reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID',
        }),
      }),
    ]);
    expect(app.writer.evidence).toHaveLength(0);
  });

  test('does not accept an internal receipt-conflict code from transport errors', async () => {
    const app = await scheduledRuntime([
      new ProviderDispatchError(
        'EXPO_RECEIPT_REFERENCE_CONFLICT',
        'safe-to-retry',
      ),
    ]);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'reschedule',
          reasonCode: 'EXPO_RECEIPT_ERROR_UNKNOWN',
        }),
      }),
    ]);
    expect(app.store.rows.get(app.item.attempt.id)?.receiptReferenceState).toBe(
      'unique',
    );
    expect(app.writer.evidence).toHaveLength(0);
  });

  test('rejects contradictory provider outcome kinds and non-definite failed reasons before receipt decisions', async () => {
    const hostileOutcomes = [
      {
        kind: 'retry',
        state: 'failed',
        providerReference: appReceiptId(),
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        invalidatesEndpoint: false,
      },
      {
        kind: 'unknown',
        state: 'unknown',
        providerReference: appReceiptId(),
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        invalidatesEndpoint: false,
      },
      {
        kind: 'failed',
        state: 'failed',
        providerReference: appReceiptId(),
        reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
        invalidatesEndpoint: false,
      },
      {
        kind: 'failed',
        state: 'failed',
        providerReference: appReceiptId(),
        reasonCode: 'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
        invalidatesEndpoint: false,
      },
    ];

    for (const hostileOutcome of hostileOutcomes) {
      const app = await scheduledRuntime([
        [hostileOutcome as unknown as ExpoProviderOutcome],
      ]);
      await expect(app.lifecycle.runDue()).resolves.toEqual([
        expect.objectContaining({
          decision: expect.objectContaining({
            kind: 'reschedule',
            reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID',
          }),
        }),
      ]);
      expect(app.writer.evidence).toHaveLength(0);
      expect(app.invalidator.inputs).toHaveLength(0);
      expect(app.resendScheduler.requests).toHaveLength(0);
    }
  });

  test('durably reschedules missing, malformed, network, 429, and 5xx receipt reads before the horizon', async () => {
    const cases: Array<{
      behavior: TransportBehavior;
      reasonCode: string;
    }> = [
      {
        behavior: [unknown('EXPO_RECEIPT_MISSING', appReceiptId())],
        reasonCode: 'EXPO_RECEIPT_MISSING',
      },
      { behavior: [], reasonCode: 'EXPO_RECEIPT_RESPONSE_INVALID' },
      {
        behavior: new Error('Synthetic network failure.'),
        reasonCode: 'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
      },
      {
        behavior: new ProviderDispatchError(
          'EXPO_HTTP_RATE_LIMITED',
          'safe-to-retry',
        ),
        reasonCode: 'EXPO_HTTP_RATE_LIMITED',
      },
      {
        behavior: new ProviderDispatchError(
          'EXPO_HTTP_SERVER_ERROR',
          'safe-to-retry',
        ),
        reasonCode: 'EXPO_HTTP_SERVER_ERROR',
      },
    ];

    for (const testCase of cases) {
      const app = await scheduledRuntime([testCase.behavior]);
      await expect(app.lifecycle.runDue()).resolves.toEqual([
        expect.objectContaining({
          decision: expect.objectContaining({
            kind: 'reschedule',
            nextPollAttemptNumber: 2,
            reasonCode: testCase.reasonCode,
          }),
        }),
      ]);
      expect(app.writer.evidence).toHaveLength(0);
      expect(app.store.rows.get(app.item.attempt.id)).toMatchObject({
        pollAttemptNumber: 2,
        lastReasonCode: testCase.reasonCode,
      });
    }
  });

  test('applies deterministic bounded jitter to receipt polling', async () => {
    const early = await scheduledRuntime(
      [[unknown('EXPO_RECEIPT_MISSING', appReceiptId())]],
      { random: () => 0 },
    );
    await early.lifecycle.runDue();
    expect(early.store.decisionCalls.at(-1)?.decision).toMatchObject({
      kind: 'reschedule',
      nextPollAt: new Date(Date.parse(early.clock.now) + 48_000).toISOString(),
    });

    const late = await scheduledRuntime(
      [[unknown('EXPO_RECEIPT_MISSING', appReceiptId())]],
      { random: () => 1 },
    );
    await late.lifecycle.runDue();
    expect(late.store.decisionCalls.at(-1)?.decision).toMatchObject({
      kind: 'reschedule',
      nextPollAt: new Date(Date.parse(late.clock.now) + 72_000).toISOString(),
    });
  });

  test('retries terminal receipt-query failures read-only, then records unknown at the horizon', async () => {
    for (const reasonCode of [
      'EXPO_HTTP_CLIENT_ERROR',
      'EXPO_LIVE_TRANSPORT_DISABLED',
    ] as const) {
      const app = await scheduledRuntime([
        new ProviderDispatchError(reasonCode, 'terminal-failure'),
      ]);

      await expect(app.lifecycle.runDue()).resolves.toEqual([
        expect.objectContaining({
          decision: expect.objectContaining({
            kind: 'reschedule',
            reasonCode,
          }),
        }),
      ]);
      expect(app.writer.evidence).toHaveLength(0);

      const horizonAt = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
      app.store.forceDue(app.item.attempt.id, horizonAt, 2, reasonCode);
      app.clock.now = horizonAt;
      await app.lifecycle.runDue();
      expect(app.writer.evidence.at(-1)).toMatchObject({
        state: 'unknown',
        reasonCode,
      });
    }
  });

  test('records receipt MessageRateExceeded as failed and durably schedules a new immutable send attempt', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'retry',
          state: 'failed',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
          invalidatesEndpoint: false,
        },
      ],
    ]);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'resend-scheduled',
          state: 'failed',
          reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
          nextAttemptNumber: app.item.attempt.attemptNumber + 1,
          delayMilliseconds: 60_000,
        }),
      }),
    ]);
    expect(app.writer.evidence.at(-1)).toMatchObject({
      state: 'failed',
      reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
    });
    expect(app.resendScheduler.requests).toEqual([
      expect.objectContaining({
        sourceAttempt: app.item.attempt,
        sourceFingerprint: app.store.rows.get(app.item.attempt.id)?.schedule
          .target.fingerprint,
        receiptId: app.evidence.providerReference,
        nextAttemptNumber: app.item.attempt.attemptNumber + 1,
        delayMilliseconds: 60_000,
        reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
      }),
    ]);
    expect(JSON.stringify(app.resendScheduler.requests)).not.toContain(
      'ExponentPushToken',
    );
    expect(app.events).toEqual([
      'store:known-outcome-pending',
      'resend',
      'evidence:failed',
      'store:resend-scheduled',
    ]);
    await expect(app.lifecycle.runDue()).resolves.toEqual([]);
    expect(app.resendScheduler.requests).toHaveLength(1);
  });

  test('expires an unscheduled durable resend when its lease is reclaimed after the send deadline', async () => {
    let randomCalls = 0;
    const app = await scheduledRuntime(
      [
        [
          {
            kind: 'retry',
            state: 'failed',
            providerReference: appReceiptId(),
            reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
            invalidatesEndpoint: false,
          },
        ],
      ],
      {
        random: () => {
          randomCalls += 1;
          return randomCalls === 1 ? 0 : 1;
        },
      },
    );
    app.resendScheduler.failOnce = true;

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(app.item.attempt.id)],
    });
    expect(app.store.rows.get(app.item.attempt.id)).toMatchObject({
      pendingAction: {
        kind: 'resend',
        state: 'failed',
        reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
        nextAttemptNumber: app.item.attempt.attemptNumber + 1,
        delayMilliseconds: 48_000,
        retryAt: new Date(Date.parse(app.clock.now) + 48_000).toISOString(),
        expiresAt: new Date(
          Date.parse(app.item.batch.createdAt) + 60 * 60_000,
        ).toISOString(),
      },
      decision: null,
    });
    expect(app.resendScheduler.requests).toHaveLength(0);

    app.clock.now = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'expired',
          reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
        }),
      }),
    ]);
    expect(randomCalls).toBe(1);
    expect(app.transport.queries).toHaveLength(1);
    expect(app.resendScheduler.requests).toHaveLength(0);
    expect(app.writer.evidence).toHaveLength(1);
    expect(app.writer.evidence[0]).toMatchObject({
      state: 'expired',
      reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
    });
    expect(app.writer.evidence.some((entry) => entry.state === 'unknown')).toBe(
      false,
    );
  });

  test('replays a durably staged first-observed expiry after final decision failure', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'retry',
          state: 'failed',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
          invalidatesEndpoint: false,
        },
      ],
    ]);
    app.clock.now = new Date(
      Date.parse(app.item.batch.createdAt) + 60 * 60_000 - 1_000,
    ).toISOString();
    app.store.forceDue(
      app.item.attempt.id,
      app.clock.now,
      2,
      'EXPO_RECEIPT_MISSING',
    );
    app.store.failDecisionKindOnce = 'terminal-dlq';

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(app.item.attempt.id)],
    });
    expect(app.store.rows.get(app.item.attempt.id)).toMatchObject({
      pendingAction: {
        kind: 'terminal-expiry',
        state: 'expired',
        reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
      },
      decision: null,
    });

    app.clock.now = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'expired',
          reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
        }),
      }),
    ]);
    expect(app.transport.queries).toHaveLength(1);
    expect(app.writer.evidence).toHaveLength(1);
    expect(app.writer.evidence[0]).toMatchObject({
      state: 'expired',
      reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
    });
  });

  test('does not schedule a receipt-triggered resend beyond the send retry budget', async () => {
    const app = await scheduledRuntime(
      [
        [
          {
            kind: 'retry',
            state: 'failed',
            providerReference: appReceiptId(),
            reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
            invalidatesEndpoint: false,
          },
        ],
      ],
      { attemptNumber: 5, maxSendAttempts: 5 },
    );

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'failed',
          reasonCode: 'PROVIDER_RETRY_EXHAUSTED',
        }),
      }),
    ]);
    expect(app.resendScheduler.requests).toHaveLength(0);
    expect(app.writer.evidence.at(-1)).toMatchObject({
      state: 'failed',
      reasonCode: 'PROVIDER_RETRY_EXHAUSTED',
    });
  });

  test('ends at the horizon as unknown with the last safe reason and supports the explicit horizon code', async () => {
    const app = await scheduledRuntime();
    const horizonAt = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    app.store.forceDue(
      app.item.attempt.id,
      horizonAt,
      2,
      'EXPO_HTTP_SERVER_ERROR',
    );
    app.clock.now = horizonAt;

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'unknown',
          reasonCode: 'EXPO_HTTP_SERVER_ERROR',
        }),
      }),
    ]);
    expect(app.transport.queries).toHaveLength(0);
    expect(app.writer.evidence.at(-1)).toMatchObject({
      state: 'unknown',
      reasonCode: 'EXPO_HTTP_SERVER_ERROR',
    });
    expect(isExpoSafeReasonCode('EXPO_RECEIPT_HORIZON_EXPIRED')).toBe(true);

    const withoutPriorReason = await scheduledRuntime();
    withoutPriorReason.clock.now = horizonAt;
    await withoutPriorReason.lifecycle.runDue();
    expect(withoutPriorReason.writer.evidence.at(-1)).toMatchObject({
      state: 'unknown',
      reasonCode: 'EXPO_RECEIPT_HORIZON_EXPIRED',
    });
  });

  test('reclaims and replays a durably staged terminal unknown after final decision failure', async () => {
    const app = await scheduledRuntime();
    app.clock.now = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    app.store.failDecisionKindOnce = 'terminal-dlq';

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(app.item.attempt.id)],
    });
    expect(app.store.rows.get(app.item.attempt.id)).toMatchObject({
      pendingAction: {
        kind: 'terminal-unknown',
        state: 'unknown',
        reasonCode: 'EXPO_RECEIPT_HORIZON_EXPIRED',
      },
      decision: null,
    });
    expect(app.writer.evidence).toHaveLength(1);

    app.clock.now = new Date(Date.parse(app.clock.now) + 120_000).toISOString();
    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_HORIZON_EXPIRED',
        }),
      }),
    ]);
    expect(app.transport.queries).toHaveLength(0);
    expect(app.writer.evidence).toHaveLength(1);
  });

  test('writes DeviceNotRegistered evidence, then invalidates, then durably records terminal DLQ', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'failed',
          state: 'failed',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
          invalidatesEndpoint: true,
        },
      ],
    ]);

    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'failed',
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        }),
      }),
    ]);
    expect(app.events).toEqual([
      'store:known-outcome-pending',
      'evidence:failed',
      'invalidate',
      'store:terminal-dlq',
    ]);
    expect(app.invalidator.inputs).toHaveLength(1);
  });

  test('replays durable DeviceNotRegistered invalidation before horizon fallback after invalidation failure', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'failed',
          state: 'failed',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
          invalidatesEndpoint: true,
        },
      ],
    ]);
    app.invalidator.failOnce = true;

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(app.item.attempt.id)],
    });
    expect(app.store.rows.get(app.item.attempt.id)).toMatchObject({
      pendingAction: {
        kind: 'terminal-failure',
        state: 'failed',
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        invalidatesEndpoint: true,
      },
      decision: null,
    });

    app.clock.now = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'failed',
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        }),
      }),
    ]);
    expect(app.transport.queries).toHaveLength(1);
    expect(app.invalidator.inputs).toHaveLength(1);
    expect(app.writer.evidence).toHaveLength(1);
    expect(app.writer.evidence.some((entry) => entry.state === 'unknown')).toBe(
      false,
    );
  });

  test('replays a known terminal failure idempotently when its final durable decision fails before the horizon', async () => {
    const app = await scheduledRuntime([
      [
        {
          kind: 'failed',
          state: 'failed',
          providerReference: appReceiptId(),
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
          invalidatesEndpoint: true,
        },
      ],
    ]);
    app.store.failDecisionKindOnce = 'terminal-dlq';

    await expect(app.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(app.item.attempt.id)],
    });
    expect(app.invalidator.inputs).toHaveLength(1);
    expect(app.store.rows.get(app.item.attempt.id)).toMatchObject({
      pendingAction: {
        kind: 'terminal-failure',
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
      },
      decision: null,
    });

    app.clock.now = after(EXPO_RECEIPT_HORIZON_MILLISECONDS);
    await expect(app.lifecycle.runDue()).resolves.toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          kind: 'terminal-dlq',
          state: 'failed',
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        }),
      }),
    ]);
    expect(app.transport.queries).toHaveLength(1);
    expect(app.invalidator.inputs).toHaveLength(1);
    expect(app.writer.evidence).toHaveLength(1);
    expect(app.writer.evidence.some((entry) => entry.state === 'unknown')).toBe(
      false,
    );
  });

  test('store claim failure rejects before identities exist, while decision failure is isolated per item', async () => {
    const claimFailure = await scheduledRuntime();
    claimFailure.store.failClaim = true;
    await expect(claimFailure.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError('00000000-0000-4000-8000-000000000000')],
    });

    const decisionFailure = await scheduledRuntime([
      [
        {
          kind: 'provider-accepted',
          state: 'provider-accepted',
          providerReference: appReceiptId(),
          reasonCode: null,
          invalidatesEndpoint: false,
        },
      ],
    ]);
    decisionFailure.store.failDecide = true;
    await expect(decisionFailure.lifecycle.runDue()).rejects.toMatchObject({
      code: 'EXPO_RECEIPT_BATCH_FAILED',
      results: [receiptItemError(decisionFailure.item.attempt.id)],
    });
    expect(decisionFailure.store.decisionCalls).toHaveLength(0);
  });
});

function appReceiptId(): string {
  return `receipt-${workItem().attempt.id}`;
}
