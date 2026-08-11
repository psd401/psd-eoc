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
  createPersistedExpoReceiptTarget,
  parsePersistedExpoReceiptTarget,
  type DurableExpoReceiptStore,
  type ExpoReceiptClaim,
  type ExpoReceiptClaimRequest,
  type ExpoReceiptDecisionRequest,
  type ExpoReceiptDurableDecision,
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
  leaseToken: string | null;
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

  public constructor(private readonly events: string[] = []) {}

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
    this.rows.set(target.attempt.id, {
      schedule: request,
      dueAt: request.firstPollAt,
      pollAttemptNumber: 1,
      lastReasonCode: null,
      leaseToken: null,
      decision: null,
    });
    return Promise.resolve();
  }

  public claimDue(
    request: ExpoReceiptClaimRequest,
  ): Promise<readonly ExpoReceiptClaim[]> {
    if (this.failClaim) throw new Error('Synthetic claim store failure.');
    this.claimCalls.push(request);
    const claims: ExpoReceiptClaim[] = [];
    for (const row of this.rows.values()) {
      if (
        claims.length >= request.limit ||
        row.decision !== null ||
        row.leaseToken !== null ||
        Date.parse(row.dueAt) > Date.parse(request.now)
      ) {
        continue;
      }
      row.leaseToken = `lease-${row.schedule.target.attempt.id}`;
      claims.push({
        target: row.schedule.target,
        dueAt: row.dueAt,
        horizonAt: row.schedule.horizonAt,
        pollAttemptNumber: row.pollAttemptNumber,
        lastReasonCode: row.lastReasonCode,
        leaseToken: row.leaseToken,
      });
    }
    return Promise.resolve(claims);
  }

  public decide(request: ExpoReceiptDecisionRequest): Promise<void> {
    if (this.failDecide) throw new Error('Synthetic decision store failure.');
    const row = this.rows.get(request.attemptId);
    if (
      row === undefined ||
      row.schedule.target.fingerprint !== request.fingerprint ||
      row.leaseToken !== request.leaseToken ||
      row.decision !== null
    ) {
      throw new Error('Synthetic receipt decision conflict.');
    }
    this.decisionCalls.push(request);
    this.events.push(`store:${request.decision.kind}`);
    if (request.decision.kind === 'reschedule') {
      row.dueAt = request.decision.nextPollAt;
      row.pollAttemptNumber = request.decision.nextPollAttemptNumber;
      row.lastReasonCode = request.decision.reasonCode;
      row.leaseToken = null;
    } else {
      row.decision = request.decision;
    }
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
  }
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

  public constructor(private readonly events: string[] = []) {}

  public invalidate(input: RecordEndpointStatusInput): Promise<void> {
    this.inputs.push(input);
    this.events.push('invalidate');
    return Promise.resolve();
  }
}

function acceptedEvidence(
  attemptId: string,
  provider = MOCK_EXPO_PUSH_PROVIDER,
): DeliveryEvidence {
  return DeliveryEvidenceSchema.parse({
    id: ACCEPTED_EVIDENCE_ID,
    subject: { kind: 'attempt', attemptId },
    sequence: 2,
    previousEvidenceId: ATTEMPTED_EVIDENCE_ID,
    state: 'provider-accepted',
    recordedAt: TIMES.recorded,
    provider,
    providerReference: `receipt-${attemptId}`,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  });
}

function after(milliseconds: number): string {
  return new Date(Date.parse(TIMES.recorded) + milliseconds).toISOString();
}

function runtime(behaviors: TransportBehavior[] = []) {
  const events: string[] = [];
  const item = workItem();
  const evidence = acceptedEvidence(item.attempt.id);
  const store = new MemoryReceiptStore(events);
  const transport = new SequenceReceiptTransport(behaviors);
  const writer = new RecordingEvidenceWriter(events);
  const invalidator = new RecordingInvalidator(events);
  const clock = { now: after(EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS) };
  const lifecycle = new ExpoReceiptLifecycle({
    store,
    transport,
    evidenceWriter: writer,
    endpointInvalidator: invalidator,
    provider: MOCK_EXPO_PUSH_PROVIDER,
    clock: () => clock.now,
  });
  return {
    clock,
    evidence,
    events,
    invalidator,
    item,
    lifecycle,
    store,
    transport,
    writer,
  };
}

async function scheduledRuntime(behaviors: TransportBehavior[] = []) {
  const app = runtime(behaviors);
  await app.lifecycle.scheduleProviderAccepted(app.item.attempt, app.evidence);
  return app;
}

describe('durable Expo receipt scheduling', () => {
  test('persists an exact token-free fingerprinted target idempotently at +15m with a +23h45m horizon', async () => {
    const app = runtime();

    await app.lifecycle.scheduleProviderAccepted(
      app.item.attempt,
      app.evidence,
    );
    await app.lifecycle.scheduleProviderAccepted(
      app.item.attempt,
      app.evidence,
    );

    expect(app.store.rows).toHaveLength(1);
    expect(app.store.scheduleCalls).toHaveLength(2);
    const schedule = app.store.scheduleCalls[0]!;
    expect(Object.keys(schedule.target).sort()).toEqual([
      'attempt',
      'fingerprint',
      'providerAcceptedEvidence',
      'receiptId',
    ]);
    expect(schedule.firstPollAt).toBe(
      after(EXPO_RECEIPT_INITIAL_DELAY_MILLISECONDS),
    );
    expect(schedule.horizonAt).toBe(after(EXPO_RECEIPT_HORIZON_MILLISECONDS));
    expect(schedule.target.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(schedule.target)).not.toContain('ExponentPushToken');
    expect(JSON.stringify(schedule.target)).not.toContain('"token":');
  });

  test('rejects fingerprint drift, extra destination fields, and a later claim due before the first-poll boundary', async () => {
    const app = await scheduledRuntime();
    const target = createPersistedExpoReceiptTarget(
      app.item.attempt,
      app.evidence,
    );

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
    await expect(app.lifecycle.runDue()).rejects.toThrow(
      'Expo receipt claim is invalid.',
    );
    expect(app.transport.queries).toHaveLength(0);
  });

  test('propagates schedule-store failure instead of reporting durable success', async () => {
    const app = runtime();
    app.store.failSchedule = true;

    await expect(
      app.lifecycle.scheduleProviderAccepted(app.item.attempt, app.evidence),
    ).rejects.toThrow('Synthetic schedule store failure.');
    expect(app.store.rows).toHaveLength(0);
  });
});

describe('due receipt claims and durable decisions', () => {
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

  test('records terminal receipt transport failures with their original failed truth', async () => {
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
            kind: 'terminal-dlq',
            state: 'failed',
            reasonCode,
          }),
        }),
      ]);
      expect(app.writer.evidence.at(-1)).toMatchObject({
        state: 'failed',
        reasonCode,
      });
    }
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
      'evidence:failed',
      'invalidate',
      'store:terminal-dlq',
    ]);
    expect(app.invalidator.inputs).toHaveLength(1);
  });

  test('store claim and decision failures reject the run instead of returning success', async () => {
    const claimFailure = await scheduledRuntime();
    claimFailure.store.failClaim = true;
    await expect(claimFailure.lifecycle.runDue()).rejects.toThrow(
      'Synthetic claim store failure.',
    );

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
    await expect(decisionFailure.lifecycle.runDue()).rejects.toThrow(
      'Synthetic decision store failure.',
    );
    expect(decisionFailure.store.decisionCalls).toHaveLength(0);
  });
});

function appReceiptId(): string {
  return `receipt-${workItem().attempt.id}`;
}
