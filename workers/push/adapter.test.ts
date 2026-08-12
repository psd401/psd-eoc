import { describe, expect, test } from 'bun:test';

import type { ProviderSendRequest } from '../shared/processor';
import { workerAttemptFingerprint } from '../shared/attempt';
import { ProviderDispatchError } from '../shared/retry';
import {
  IDS,
  realBatch,
  syntheticBatch,
  workItem,
} from '../shared/test-fixtures';
import {
  LedgeredExpoPushAdapter,
  LedgeredExpoPushAdapterError,
  type ClaimExpoProviderIoRequest,
  type CompleteExpoProviderIoRequest,
  type DurableExpoSendLedger,
  type ExpoSendLedgerClaim,
} from './adapter';
import { failed, retry, unknown, type ExpoProviderOutcome } from './protocol';
import type { ExpoPushTransport } from './transport';

const CLAIM_TOKEN = 'synthetic-claim-token-0001';

function accepted(reference = 'ticket-1'): ExpoProviderOutcome {
  return Object.freeze({
    kind: 'provider-accepted',
    state: 'provider-accepted',
    providerReference: reference,
    reasonCode: null,
    invalidatesEndpoint: false,
  });
}

class ControlledTransport implements ExpoPushTransport {
  public calls = 0;
  public readonly work = [] as ProviderSendRequest['workItem'][];
  public readonly chunks = [] as ProviderSendRequest['workItem'][][];

  public constructor(
    private readonly behavior:
      | readonly ExpoProviderOutcome[]
      | Error
      | ((
          workItems: readonly ProviderSendRequest['workItem'][],
        ) => Promise<readonly ExpoProviderOutcome[]>),
  ) {}

  public sendChunk(
    workItems: readonly ProviderSendRequest['workItem'][],
  ): Promise<readonly ExpoProviderOutcome[]> {
    this.calls += 1;
    this.work.push(...workItems);
    this.chunks.push([...workItems]);
    if (typeof this.behavior === 'function') return this.behavior(workItems);
    if (this.behavior instanceof Error) return Promise.reject(this.behavior);
    return Promise.resolve(this.behavior);
  }

  public queryReceiptChunk(): Promise<readonly ExpoProviderOutcome[]> {
    throw new Error('Send adapter must not query receipts.');
  }
}

type LedgerState =
  | Readonly<{ kind: 'uncertain'; fingerprint: string }>
  | Readonly<{
      kind: 'completed';
      fingerprint: string;
      completion: CompleteExpoProviderIoRequest['completion'];
    }>;

class MemoryDurableLedger implements DurableExpoSendLedger {
  public readonly claims: ClaimExpoProviderIoRequest[] = [];
  public readonly completions: CompleteExpoProviderIoRequest[] = [];
  public beginError: Error | null = null;
  public readonly beginErrorAttemptIds = new Set<string>();
  public completionError: Error | null = null;
  public overrideClaim: ExpoSendLedgerClaim | null = null;
  readonly #states = new Map<string, LedgerState>();

  public seedUncertain(attemptId: string, fingerprint = 'a'.repeat(64)): void {
    this.#states.set(attemptId, { kind: 'uncertain', fingerprint });
  }

  public claimProviderIo(
    request: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerClaim> {
    this.claims.push(request);
    if (
      this.beginError !== null ||
      this.beginErrorAttemptIds.has(request.attemptId)
    ) {
      return Promise.reject(
        this.beginError ?? new Error('synthetic per-attempt ledger outage'),
      );
    }
    if (this.overrideClaim !== null) return Promise.resolve(this.overrideClaim);
    const existing = this.#states.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.workFingerprint) {
        return Promise.resolve({ kind: 'conflict' });
      }
      return Promise.resolve(
        existing.kind === 'completed'
          ? { kind: 'completed', completion: existing.completion }
          : { kind: 'uncertain' },
      );
    }
    this.#states.set(request.attemptId, {
      kind: 'uncertain',
      fingerprint: request.workFingerprint,
    });
    return Promise.resolve({ kind: 'execute', claimToken: CLAIM_TOKEN });
  }

  public completeProviderIo(
    request: CompleteExpoProviderIoRequest,
  ): Promise<void> {
    this.completions.push(request);
    if (this.completionError !== null) {
      return Promise.reject(this.completionError);
    }
    const existing = this.#states.get(request.attemptId);
    if (
      request.claimToken !== CLAIM_TOKEN ||
      existing === undefined ||
      existing.fingerprint !== request.workFingerprint ||
      existing.kind !== 'uncertain'
    ) {
      return Promise.reject(new Error('conflicting completion'));
    }
    this.#states.set(request.attemptId, {
      kind: 'completed',
      fingerprint: request.workFingerprint,
      completion: request.completion,
    });
    return Promise.resolve();
  }
}

function adapterRuntime(
  behavior:
    | readonly ExpoProviderOutcome[]
    | Error
    | ((
        workItems: readonly ProviderSendRequest['workItem'][],
      ) => Promise<readonly ExpoProviderOutcome[]>) = [accepted()],
  clock: () => Date | string | number = () => realBatch().createdAt,
) {
  const transport = new ControlledTransport(behavior);
  const ledger = new MemoryDurableLedger();
  const adapter = new LedgeredExpoPushAdapter({
    transport,
    sendLedger: ledger,
    batchWindowMilliseconds: 0,
    clock,
  });
  return { adapter, ledger, transport };
}

function request(item = workItem(realBatch())): ProviderSendRequest {
  return Object.freeze({
    workItem: item,
    idempotencyKey: item.attempt.id,
  });
}

function liveItemWithAttempt(suffix: number) {
  return workItem(realBatch(), {
    attemptId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
  });
}

describe('ledgered Expo live adapter', () => {
  test('has conditional live metadata and records only PII-safe ledger inputs', async () => {
    const app = adapterRuntime();

    await expect(app.adapter.send(request())).resolves.toMatchObject({
      state: 'provider-accepted',
      provider: 'expo-push',
      providerReference: 'ticket-1',
    });

    expect(app.adapter).toMatchObject({
      channel: 'push',
      integrationId: 'expo-push',
      truthLabel: 'live-verified',
      deliverySemantics: 'attempt-id-idempotent',
    });
    expect(app.transport.calls).toBe(1);
    expect(app.ledger.claims).toEqual([
      {
        attemptId: IDS.attempt,
        workFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    const serializedLedgerRequests = JSON.stringify([
      ...app.ledger.claims,
      ...app.ledger.completions,
    ]);
    expect(serializedLedgerRequests).not.toContain('ExponentPushToken');
    expect(serializedLedgerRequests).not.toContain('[INCIDENT]');
  });

  test('rejects non-live work and mismatched attempt keys before ledger or provider I/O', async () => {
    const app = adapterRuntime();
    const synthetic = workItem(syntheticBatch());

    await expect(app.adapter.send(request(synthetic))).rejects.toMatchObject({
      code: 'EXPO_SEND_REQUEST_INVALID',
    });
    await expect(
      app.adapter.send({
        ...request(),
        idempotencyKey: IDS.secondAttempt,
      }),
    ).rejects.toMatchObject({ code: 'EXPO_SEND_REQUEST_INVALID' });
    expect(app.ledger.claims).toHaveLength(0);
    expect(app.transport.calls).toBe(0);
  });

  test('allows one concurrent provider call and makes the competing claim unknown', async () => {
    let release:
      | ((outcomes: readonly ExpoProviderOutcome[]) => void)
      | undefined;
    const response = new Promise<readonly ExpoProviderOutcome[]>((resolve) => {
      release = resolve;
    });
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const app = adapterRuntime(() => {
      markProviderStarted?.();
      return response;
    });

    const first = app.adapter.send(request());
    const second = app.adapter.send(request());
    await expect(second).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
    });
    await providerStarted;
    expect(app.transport.calls).toBe(1);
    release?.([accepted()]);
    await expect(first).resolves.toMatchObject({ state: 'provider-accepted' });
  });

  test('replays a completed outcome without another provider call', async () => {
    const app = adapterRuntime();

    const first = await app.adapter.send(request());
    const replay = await app.adapter.send(request());

    expect(replay).toEqual(first);
    expect(app.transport.calls).toBe(1);
    expect(app.ledger.completions).toHaveLength(1);
  });

  test('treats a recovered irreversible pre-send claim as unknown without I/O', async () => {
    const app = adapterRuntime();
    const item = workItem(realBatch());
    const fingerprint = workerAttemptFingerprint(item);
    app.ledger.seedUncertain(IDS.attempt, fingerprint);

    await expect(app.adapter.send(request(item))).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
    });
    expect(app.transport.calls).toBe(0);
  });

  test('never resends after provider success when ledger completion is uncertain', async () => {
    const app = adapterRuntime();
    app.ledger.completionError = new Error('synthetic commit ambiguity');

    await expect(app.adapter.send(request())).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
    });
    await expect(app.adapter.send(request())).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
    });
    expect(app.transport.calls).toBe(1);
  });

  test('durably replays safe provider failures without repeating I/O', async () => {
    for (const [code, disposition] of [
      ['EXPO_HTTP_RATE_LIMITED', 'safe-to-retry'],
      ['EXPO_HTTP_SERVER_ERROR', 'safe-to-retry'],
      ['EXPO_MESSAGE_RATE_EXCEEDED', 'safe-to-retry'],
      ['EXPO_HTTP_CLIENT_ERROR', 'terminal-failure'],
      ['EXPO_INVALID_CREDENTIALS', 'terminal-failure'],
      ['EXPO_LIVE_TRANSPORT_DISABLED', 'terminal-failure'],
      ['EXPO_NETWORK_OUTCOME_AMBIGUOUS', 'ambiguous'],
      ['EXPO_RESPONSE_TOO_LARGE', 'ambiguous'],
    ] as const) {
      const app = adapterRuntime(new ProviderDispatchError(code, disposition));

      for (let replay = 0; replay < 2; replay += 1) {
        await expect(app.adapter.send(request())).rejects.toMatchObject({
          code,
          disposition,
        });
      }
      expect(app.transport.calls).toBe(1);
      expect(app.ledger.completions).toHaveLength(1);
      expect(app.ledger.completions[0]?.completion).toMatchObject({
        kind: 'failure',
        failure: { code, disposition },
      });
    }
  });

  test('persists an item-level retry as a safe failure before replaying it', async () => {
    const app = adapterRuntime([retry('EXPO_MESSAGE_RATE_EXCEEDED')]);

    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_MESSAGE_RATE_EXCEEDED',
      disposition: 'safe-to-retry',
    });
    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_MESSAGE_RATE_EXCEEDED',
      disposition: 'safe-to-retry',
    });
    expect(app.transport.calls).toBe(1);
  });

  test('batches ledger-claimed provider I/O and preserves positional partial outcomes', async () => {
    const app = adapterRuntime([
      accepted('ticket-batch-1'),
      failed('EXPO_DEVICE_NOT_REGISTERED', null, true),
      retry('EXPO_MESSAGE_RATE_EXCEEDED'),
    ]);
    const items = [
      liveItemWithAttempt(101),
      liveItemWithAttempt(102),
      liveItemWithAttempt(103),
    ];

    const settled = await Promise.allSettled(
      items.map((item) => app.adapter.send(request(item))),
    );

    expect(app.transport.chunks.map((chunk) => chunk.length)).toEqual([3]);
    expect(settled[0]).toMatchObject({
      status: 'fulfilled',
      value: {
        state: 'provider-accepted',
        providerReference: 'ticket-batch-1',
      },
    });
    expect(settled[1]).toMatchObject({
      status: 'fulfilled',
      value: { state: 'failed', reasonCode: 'EXPO_DEVICE_NOT_REGISTERED' },
    });
    expect(settled[2]).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'EXPO_MESSAGE_RATE_EXCEEDED',
        disposition: 'safe-to-retry',
      },
    });
    expect(app.ledger.completions).toHaveLength(3);
  });

  test('expires stale claimed work without provider I/O and preserves fresh siblings', async () => {
    const batch = realBatch();
    const staleItem = liveItemWithAttempt(104);
    const freshBatch = {
      ...batch,
      id: '00000000-0000-4000-8000-000000000105',
      createdAt: '2026-08-10T16:00:00.500Z',
    };
    const freshItem = workItem(freshBatch, {
      attemptId: '00000000-0000-4000-8000-000000000106',
    });
    const app = adapterRuntime(
      (items) =>
        Promise.resolve(
          items.map((item) => accepted(`ticket-${item.attempt.id}`)),
        ),
      () => '2026-08-10T17:00:00.000Z',
    );

    const outcomes = await Promise.all([
      app.adapter.send(request(staleItem)),
      app.adapter.send(request(freshItem)),
    ]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        state: 'expired',
        reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
      }),
      expect.objectContaining({
        state: 'provider-accepted',
        providerReference: `ticket-${freshItem.attempt.id}`,
      }),
    ]);
    expect(app.transport.chunks).toEqual([[freshItem]]);
    expect(app.ledger.completions).toHaveLength(2);
  });

  test('isolates malformed item outcomes without discarding valid siblings', async () => {
    const app = adapterRuntime([
      accepted('ticket-isolated-1'),
      {
        kind: 'provider-accepted',
        state: 'delivered',
        providerReference:
          'ticket-isolated-2\nExponentPushToken[hostile-ledger-text]',
        reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        invalidatesEndpoint: true,
      } as never,
      accepted('ticket-isolated-3'),
    ]);
    const items = [
      liveItemWithAttempt(111),
      liveItemWithAttempt(112),
      liveItemWithAttempt(113),
    ];

    const outcomes = await Promise.all(
      items.map((item) => app.adapter.send(request(item))),
    );

    expect(outcomes.map((outcome) => outcome.state)).toEqual([
      'provider-accepted',
      'unknown',
      'provider-accepted',
    ]);
    expect(app.transport.chunks.map((chunk) => chunk.length)).toEqual([3]);
    expect(app.ledger.completions).toHaveLength(3);
    expect(app.ledger.completions[1]?.completion).toEqual({
      kind: 'outcome',
      outcome: {
        state: 'unknown',
        provider: 'expo-push',
        providerReference: null,
        proof: null,
        reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
        diagnosticDigest: null,
      },
    });
    const durableJson = JSON.stringify(app.ledger.completions);
    expect(durableJson).not.toContain('hostile-ledger-text');
    expect(durableJson).not.toContain('ExponentPushToken');
  });

  test('isolates a pre-send ledger outage while batching eligible siblings', async () => {
    const app = adapterRuntime((items) =>
      Promise.resolve(
        items.map((item) => accepted(`ticket-${item.attempt.id}`)),
      ),
    );
    const items = [
      liveItemWithAttempt(121),
      liveItemWithAttempt(122),
      liveItemWithAttempt(123),
    ];
    app.ledger.beginErrorAttemptIds.add(items[1]!.attempt.id);

    const settled = await Promise.allSettled(
      items.map((item) => app.adapter.send(request(item))),
    );

    expect(settled.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(settled[1]).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'EXPO_SEND_LEDGER_FAILED',
        disposition: 'ambiguous',
      },
    });
    expect(app.transport.chunks.map((chunk) => chunk.length)).toEqual([2]);
    expect(app.ledger.completions).toHaveLength(2);
  });

  test('never sends more than 100 ledger-claimed attempts per provider request', async () => {
    const app = adapterRuntime((items) =>
      Promise.resolve(
        items.map((item) => accepted(`ticket-${item.attempt.id}`)),
      ),
    );
    const items = Array.from({ length: 201 }, (_unused, index) =>
      liveItemWithAttempt(index + 1_000),
    );

    await Promise.all(items.map((item) => app.adapter.send(request(item))));

    expect(app.transport.chunks.map((chunk) => chunk.length)).toEqual([
      100, 100, 1,
    ]);
    expect(app.ledger.completions).toHaveLength(201);
  });

  test('durably replays terminal and unknown item outcomes without overclaiming', async () => {
    const cases: readonly (readonly ExpoProviderOutcome[])[] = [
      [failed('EXPO_DEVICE_NOT_REGISTERED', null, true)],
      [unknown('EXPO_TICKET_ERROR_UNKNOWN')],
      [],
      [accepted('ticket-1'), accepted('ticket-2')],
    ];
    for (const values of cases) {
      const app = adapterRuntime(values);

      const first = await app.adapter.send(request());
      const replay = await app.adapter.send(request());
      expect(replay).toEqual(first);
      expect(first.state).not.toBe('delivered');
      expect(app.transport.calls).toBe(1);
    }
  });

  test('fails closed on fingerprint conflict and ledger failures before provider I/O', async () => {
    const conflict = adapterRuntime();
    conflict.ledger.overrideClaim = { kind: 'conflict' };
    await expect(conflict.adapter.send(request())).rejects.toBeInstanceOf(
      LedgeredExpoPushAdapterError,
    );
    await expect(conflict.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_CONFLICT',
      disposition: 'terminal-failure',
    });
    expect(conflict.transport.calls).toBe(0);

    const unavailable = adapterRuntime();
    unavailable.ledger.beginError = new Error('synthetic ledger outage');
    await expect(unavailable.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_FAILED',
      disposition: 'ambiguous',
    });
    expect(unavailable.transport.calls).toBe(0);

    const malformed = adapterRuntime();
    malformed.ledger.overrideClaim = {
      kind: 'execute',
      claimToken: 'short',
    };
    await expect(malformed.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_INVALID',
      disposition: 'ambiguous',
    });
    expect(malformed.transport.calls).toBe(0);
  });

  test('never treats a completed-row ledger read outage as safe to resend', async () => {
    const app = adapterRuntime();
    await expect(app.adapter.send(request())).resolves.toMatchObject({
      state: 'provider-accepted',
    });
    app.ledger.beginError = new Error('synthetic completed-row read outage');

    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_FAILED',
      disposition: 'ambiguous',
    });
    expect(app.transport.calls).toBe(1);
  });

  test('treats even a branded ledger rejection as ambiguous and never sends', async () => {
    const app = adapterRuntime();
    app.ledger.beginError = new LedgeredExpoPushAdapterError(
      'EXPO_SEND_LEDGER_CONFLICT',
    );

    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_FAILED',
      disposition: 'ambiguous',
    });
    expect(app.transport.calls).toBe(0);
  });

  test('rejects contradictory or unsafe completed ledger truth before provider I/O', async () => {
    const base = Object.freeze({
      provider: 'expo-push',
      providerReference: null,
      proof: null,
      diagnosticDigest: null,
    });
    const cases = [
      {
        name: 'wrong provider',
        outcome: {
          ...base,
          state: 'provider-accepted',
          provider: 'wrong-provider',
          providerReference: 'ticket-1',
          reasonCode: null,
        },
      },
      {
        name: 'unsafe provider reference',
        outcome: {
          ...base,
          state: 'provider-accepted',
          providerReference: 'ExponentPushToken[hostile-ledger-token]',
          reasonCode: null,
        },
      },
      {
        name: 'expired DeviceNotRegistered',
        outcome: {
          ...base,
          state: 'expired',
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        },
      },
      {
        name: 'failed expiration',
        outcome: {
          ...base,
          state: 'failed',
          reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
        },
      },
      {
        name: 'failed rate-limit retry',
        outcome: {
          ...base,
          state: 'failed',
          reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
        },
      },
      {
        name: 'receipt failure in send ledger',
        outcome: {
          ...base,
          state: 'failed',
          reasonCode: 'PROVIDER_RETRY_EXHAUSTED',
        },
      },
      {
        name: 'receipt unknown in send ledger',
        outcome: {
          ...base,
          state: 'unknown',
          reasonCode: 'EXPO_RECEIPT_MISSING',
        },
      },
      {
        name: 'failed outcome with receipt reference',
        outcome: {
          ...base,
          state: 'failed',
          providerReference: 'receipt-wrong-phase',
          reasonCode: 'EXPO_MESSAGE_TOO_BIG',
        },
      },
      {
        name: 'unknown DeviceNotRegistered',
        outcome: {
          ...base,
          state: 'unknown',
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
        },
      },
      {
        name: 'unknown rate-limit retry',
        outcome: {
          ...base,
          state: 'unknown',
          reasonCode: 'EXPO_MESSAGE_RATE_EXCEEDED',
        },
      },
      {
        name: 'unknown expiration',
        outcome: {
          ...base,
          state: 'unknown',
          reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
        },
      },
      {
        name: 'unrecognized safe-looking reason',
        outcome: {
          ...base,
          state: 'unknown',
          reasonCode: 'ATTACKER_CONTROLLED_REASON',
        },
      },
      {
        name: 'unexpected diagnostic digest',
        outcome: {
          ...base,
          state: 'failed',
          reasonCode: 'EXPO_MESSAGE_TOO_BIG',
          diagnosticDigest: 'a'.repeat(64),
        },
      },
    ] as const;

    for (const testCase of cases) {
      const app = adapterRuntime();
      app.ledger.overrideClaim = {
        kind: 'completed',
        completion: {
          kind: 'outcome',
          outcome: testCase.outcome,
        },
      } as ExpoSendLedgerClaim;

      await expect(
        app.adapter.send(request()),
        testCase.name,
      ).rejects.toMatchObject({
        code: 'EXPO_SEND_LEDGER_INVALID',
        disposition: 'ambiguous',
      });
      expect(app.transport.calls, testCase.name).toBe(0);
    }
  });

  test('rejects accessor-backed ledger values without invoking their getters', async () => {
    let getterCalls = 0;
    const accessorOutcome = {
      state: 'provider-accepted',
      provider: 'expo-push',
      providerReference: 'ticket-accessor',
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    };
    Object.defineProperty(accessorOutcome, 'providerReference', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'ticket-accessor';
      },
    });
    const app = adapterRuntime();
    app.ledger.overrideClaim = {
      kind: 'completed',
      completion: { kind: 'outcome', outcome: accessorOutcome },
    } as ExpoSendLedgerClaim;

    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_INVALID',
      disposition: 'ambiguous',
    });
    expect(getterCalls).toBe(0);
    expect(app.transport.calls).toBe(0);
  });

  test('rejects contradictory completed failure classifications before provider I/O', async () => {
    const cases = [
      {
        name: 'DeviceNotRegistered marked retryable',
        failure: {
          code: 'EXPO_DEVICE_NOT_REGISTERED',
          disposition: 'safe-to-retry',
          diagnosticDigest: null,
        },
      },
      {
        name: 'network ambiguity marked retryable',
        failure: {
          code: 'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
          disposition: 'safe-to-retry',
          diagnosticDigest: null,
        },
      },
      {
        name: 'rate limit marked ambiguous',
        failure: {
          code: 'EXPO_HTTP_RATE_LIMITED',
          disposition: 'ambiguous',
          diagnosticDigest: null,
        },
      },
      {
        name: 'arbitrary terminal code',
        failure: {
          code: 'ATTACKER_CONTROLLED_REASON',
          disposition: 'terminal-failure',
          diagnosticDigest: null,
        },
      },
      {
        name: 'unexpected diagnostic digest',
        failure: {
          code: 'EXPO_HTTP_SERVER_ERROR',
          disposition: 'safe-to-retry',
          diagnosticDigest: 'a'.repeat(64),
        },
      },
    ] as const;

    for (const testCase of cases) {
      const app = adapterRuntime();
      app.ledger.overrideClaim = {
        kind: 'completed',
        completion: { kind: 'failure', failure: testCase.failure },
      } as ExpoSendLedgerClaim;

      await expect(
        app.adapter.send(request()),
        testCase.name,
      ).rejects.toMatchObject({
        code: 'EXPO_SEND_LEDGER_INVALID',
        disposition: 'ambiguous',
      });
      expect(app.transport.calls, testCase.name).toBe(0);
    }
  });

  test('canonicalizes unexpected transport failure metadata before persistence', async () => {
    const app = adapterRuntime(
      new ProviderDispatchError(
        'EXPO_DEVICE_NOT_REGISTERED',
        'safe-to-retry',
        'a'.repeat(64),
      ),
    );

    for (let replay = 0; replay < 2; replay += 1) {
      await expect(app.adapter.send(request())).rejects.toMatchObject({
        code: 'PROVIDER_OUTCOME_AMBIGUOUS',
        disposition: 'ambiguous',
        diagnosticDigest: null,
      });
    }
    expect(app.transport.calls).toBe(1);
    expect(app.ledger.completions[0]?.completion).toEqual({
      kind: 'failure',
      failure: {
        code: 'PROVIDER_OUTCOME_AMBIGUOUS',
        disposition: 'ambiguous',
        diagnosticDigest: null,
      },
    });
  });

  test('never trusts a fulfilled transport container or its overridden map', async () => {
    let mapCalls = 0;
    const hostile = [accepted()] as ExpoProviderOutcome[];
    Object.defineProperty(hostile, 'map', {
      configurable: true,
      value: () => {
        mapCalls += 1;
        return [
          {
            kind: 'outcome',
            outcome: {
              state: 'delivered',
              provider: 'expo-push',
              providerReference: 'forged-receipt',
              proof: 'forged',
              reasonCode: null,
              diagnosticDigest: null,
            },
          },
        ];
      },
    });
    const app = adapterRuntime(async () => hostile);

    await expect(app.adapter.send(request())).resolves.toMatchObject({
      state: 'provider-accepted',
      providerReference: 'ticket-1',
    });
    expect(mapCalls).toBe(0);
    expect(JSON.stringify(app.ledger.completions)).not.toContain('delivered');
    expect(JSON.stringify(app.ledger.completions)).not.toContain('forged');
  });

  test('makes a throwing fulfilled transport container unknown, never retryable', async () => {
    const hostile = new Proxy([accepted()], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new ProviderDispatchError(
            'EXPO_HTTP_SERVER_ERROR',
            'safe-to-retry',
          );
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const app = adapterRuntime(
      async () => hostile as readonly ExpoProviderOutcome[],
    );

    for (let replay = 0; replay < 2; replay += 1) {
      await expect(app.adapter.send(request())).resolves.toMatchObject({
        state: 'unknown',
        reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
      });
    }
    expect(app.transport.calls).toBe(1);
    expect(app.ledger.completions[0]?.completion).toMatchObject({
      kind: 'outcome',
      outcome: {
        state: 'unknown',
        reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
      },
    });
  });

  test('isolates a throwing fulfilled item while preserving its valid sibling', async () => {
    const items = [liveItemWithAttempt(132), liveItemWithAttempt(133)];
    const hostile = [accepted('ticket-valid'), accepted('ticket-hostile')];
    Object.defineProperty(hostile, 1, {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error('synthetic hostile outcome slot');
      },
    });
    const app = adapterRuntime(async () => hostile);

    await expect(
      Promise.all(items.map((item) => app.adapter.send(request(item)))),
    ).resolves.toEqual([
      expect.objectContaining({
        state: 'provider-accepted',
        providerReference: 'ticket-valid',
      }),
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
      }),
    ]);
    expect(app.transport.calls).toBe(1);
  });

  test('settles every claimed item as unknown if the pre-I/O clock throws', async () => {
    const app = adapterRuntime([accepted()], () => {
      throw new Error('synthetic clock outage');
    });
    const items = [liveItemWithAttempt(130), liveItemWithAttempt(131)];

    await expect(
      Promise.all(items.map((item) => app.adapter.send(request(item)))),
    ).resolves.toEqual([
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
      }),
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
      }),
    ]);
    expect(app.transport.calls).toBe(0);
    expect(app.ledger.completions).toHaveLength(2);
  });
});
