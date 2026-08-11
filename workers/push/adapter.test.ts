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

  public constructor(
    private readonly behavior:
      | readonly ExpoProviderOutcome[]
      | Error
      | (() => Promise<readonly ExpoProviderOutcome[]>),
  ) {}

  public sendChunk(
    workItems: readonly ProviderSendRequest['workItem'][],
  ): Promise<readonly ExpoProviderOutcome[]> {
    this.calls += 1;
    this.work.push(...workItems);
    if (typeof this.behavior === 'function') return this.behavior();
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
    if (this.beginError !== null) return Promise.reject(this.beginError);
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
    | (() => Promise<readonly ExpoProviderOutcome[]>) = [accepted()],
) {
  const transport = new ControlledTransport(behavior);
  const ledger = new MemoryDurableLedger();
  const adapter = new LedgeredExpoPushAdapter({
    transport,
    sendLedger: ledger,
  });
  return { adapter, ledger, transport };
}

function request(item = workItem(realBatch())): ProviderSendRequest {
  return Object.freeze({
    workItem: item,
    idempotencyKey: item.attempt.id,
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
    const app = adapterRuntime(() => response);

    const first = app.adapter.send(request());
    const second = app.adapter.send(request());
    await expect(second).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'EXPO_SEND_OUTCOME_AMBIGUOUS',
    });
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
      ['EXPO_NETWORK_OUTCOME_AMBIGUOUS', 'ambiguous'],
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
    });
    expect(conflict.transport.calls).toBe(0);

    const unavailable = adapterRuntime();
    unavailable.ledger.beginError = new Error('synthetic ledger outage');
    await expect(unavailable.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_FAILED',
    });
    expect(unavailable.transport.calls).toBe(0);

    const malformed = adapterRuntime();
    malformed.ledger.overrideClaim = {
      kind: 'execute',
      claimToken: 'short',
    };
    await expect(malformed.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_INVALID',
    });
    expect(malformed.transport.calls).toBe(0);
  });

  test('rejects malformed completed ledger truth before provider I/O', async () => {
    const app = adapterRuntime();
    app.ledger.overrideClaim = {
      kind: 'completed',
      completion: {
        kind: 'outcome',
        outcome: {
          state: 'provider-accepted',
          provider: 'wrong-provider',
          providerReference: 'ticket-1',
          proof: null,
          reasonCode: null,
          diagnosticDigest: null,
        },
      },
    };

    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_INVALID',
    });
    expect(app.transport.calls).toBe(0);
  });
});
