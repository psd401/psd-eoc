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
  type ExpoSendLedgerLookup,
} from './adapter';
import {
  PushEndpointEligibilityError,
  type PushEndpointEligibilityChecker,
} from './eligibility';
import {
  EXPO_EMERGENCY_TTL_SECONDS,
  failed,
  retry,
  unknown,
  type ExpoProviderOutcome,
} from './protocol';
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
  public readonly lookups: ClaimExpoProviderIoRequest[] = [];
  public beginError: Error | null = null;
  public lookupError: Error | null = null;
  public readonly beginErrorAttemptIds = new Set<string>();
  public completionError: Error | null = null;
  public overrideClaim: ExpoSendLedgerClaim | null = null;
  public overrideLookup: ExpoSendLedgerLookup | null = null;
  public claimGate: Promise<void> | null = null;
  readonly #states = new Map<string, LedgerState>();

  public lookupProviderIo(
    request: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerLookup> {
    this.lookups.push(request);
    if (this.lookupError !== null) return Promise.reject(this.lookupError);
    if (this.overrideLookup !== null)
      return Promise.resolve(this.overrideLookup);
    const existing = this.#states.get(request.attemptId);
    if (existing === undefined) return Promise.resolve({ kind: 'missing' });
    if (existing.fingerprint !== request.workFingerprint) {
      return Promise.resolve({ kind: 'conflict' });
    }
    return Promise.resolve(
      existing.kind === 'completed'
        ? { kind: 'completed', completion: existing.completion }
        : { kind: 'uncertain' },
    );
  }

  public seedUncertain(attemptId: string, fingerprint = 'a'.repeat(64)): void {
    this.#states.set(attemptId, { kind: 'uncertain', fingerprint });
  }

  public async claimProviderIo(
    request: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerClaim> {
    this.claims.push(request);
    if (this.claimGate !== null) await this.claimGate;
    if (
      this.beginError !== null ||
      this.beginErrorAttemptIds.has(request.attemptId)
    ) {
      throw this.beginError ?? new Error('synthetic per-attempt ledger outage');
    }
    if (this.overrideClaim !== null) return this.overrideClaim;
    const existing = this.#states.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.workFingerprint) {
        return { kind: 'conflict' };
      }
      return existing.kind === 'completed'
        ? { kind: 'completed', completion: existing.completion }
        : { kind: 'uncertain' };
    }
    this.#states.set(request.attemptId, {
      kind: 'uncertain',
      fingerprint: request.workFingerprint,
    });
    return { kind: 'execute', claimToken: CLAIM_TOKEN };
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

type EligibilityBehavior =
  | boolean
  | Error
  | ((workItem: ProviderSendRequest['workItem']) => boolean | Promise<boolean>);

class ControlledEndpointEligibility implements PushEndpointEligibilityChecker {
  public readonly work: ProviderSendRequest['workItem'][] = [];

  public constructor(private readonly behavior: EligibilityBehavior = true) {}

  public async isEligible(
    workItem: ProviderSendRequest['workItem'],
  ): Promise<boolean> {
    this.work.push(workItem);
    if (typeof this.behavior === 'function') {
      return this.behavior(workItem);
    }
    if (this.behavior instanceof Error) throw this.behavior;
    return this.behavior;
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
  endpointEligibility = new ControlledEndpointEligibility(),
) {
  const transport = new ControlledTransport(behavior);
  const ledger = new MemoryDurableLedger();
  const adapter = new LedgeredExpoPushAdapter({
    transport,
    sendLedger: ledger,
    batchWindowMilliseconds: 0,
    clock,
    endpointEligibility,
  });
  return { adapter, endpointEligibility, ledger, transport };
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
  test('requires one executable checker and exposes only exact checker identity', () => {
    const transport = new ControlledTransport([accepted()]);
    const ledger = new MemoryDurableLedger();
    const checker = new ControlledEndpointEligibility();
    const adapter = new LedgeredExpoPushAdapter({
      transport,
      sendLedger: ledger,
      endpointEligibility: checker,
    });

    expect(
      LedgeredExpoPushAdapter.usesEndpointEligibility(adapter, checker),
    ).toBe(true);
    expect(
      LedgeredExpoPushAdapter.usesEndpointEligibility(
        adapter,
        new ControlledEndpointEligibility(),
      ),
    ).toBe(false);
    expect(
      LedgeredExpoPushAdapter.usesEndpointEligibility(
        new Proxy(adapter, {}),
        checker,
      ),
    ).toBe(false);
    expect(
      () =>
        new LedgeredExpoPushAdapter({
          transport,
          sendLedger: ledger,
        } as never),
    ).toThrow('Expo endpoint eligibility checker is invalid.');
    expect(
      () =>
        new LedgeredExpoPushAdapter({
          transport,
          sendLedger: ledger,
          endpointEligibility: { isEligible: true },
        } as never),
    ).toThrow('Expo endpoint eligibility checker is invalid.');
  });

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
    expect(app.endpointEligibility.work).toHaveLength(1);
  });

  test('rechecks after a deferred durable claim and retains a subsequent revocation without transport I/O', async () => {
    let releaseClaim: (() => void) | undefined;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let currentlyEligible = true;
    const checker = new ControlledEndpointEligibility(() => currentlyEligible);
    const app = adapterRuntime([accepted()], undefined, checker);
    app.ledger.claimGate = claimGate;

    const first = app.adapter.send(request());
    expect(app.ledger.claims).toHaveLength(1);
    expect(checker.work).toHaveLength(0);

    currentlyEligible = false;
    releaseClaim?.();

    await expect(first).rejects.toMatchObject({
      code: 'EXPO_ENDPOINT_INELIGIBLE',
      disposition: 'terminal-failure',
      diagnosticDigest: null,
    });
    expect(app.transport.calls).toBe(0);
    expect(checker.work).toHaveLength(1);
    expect(app.ledger.completions).toHaveLength(1);
    expect(app.ledger.completions[0]?.completion).toEqual({
      kind: 'failure',
      failure: {
        code: 'EXPO_ENDPOINT_INELIGIBLE',
        disposition: 'terminal-failure',
        diagnosticDigest: null,
      },
    });

    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'EXPO_ENDPOINT_INELIGIBLE',
      disposition: 'terminal-failure',
    });
    expect(app.transport.calls).toBe(0);
    expect(checker.work).toHaveLength(1);
    expect(app.ledger.completions).toHaveLength(1);
  });

  test('recovers completed provider truth read-only without a new claim or send', async () => {
    const app = adapterRuntime();
    const first = await app.adapter.send(request());
    const claimsAfterSend = app.ledger.claims.length;
    const providerCallsAfterSend = app.transport.calls;

    await expect(app.adapter.recover(request())).resolves.toEqual({
      kind: 'outcome',
      outcome: first,
    });
    expect(app.ledger.lookups).toHaveLength(1);
    expect(app.ledger.claims).toHaveLength(claimsAfterSend);
    expect(app.transport.calls).toBe(providerCallsAfterSend);
  });

  test('fails closed on malformed or unavailable read-only recovery', async () => {
    const malformed = adapterRuntime();
    malformed.ledger.overrideLookup = {
      kind: 'completed',
      completion: {
        kind: 'outcome',
        outcome: {
          state: 'failed',
          provider: 'expo-push',
          providerReference: 'c'.repeat(64),
          proof: null,
          reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
          diagnosticDigest: null,
        },
      },
    };
    await expect(malformed.adapter.recover(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_INVALID',
      disposition: 'ambiguous',
    });
    expect(malformed.ledger.claims).toHaveLength(0);
    expect(malformed.transport.calls).toBe(0);

    const unavailable = adapterRuntime();
    unavailable.ledger.lookupError = new Error('synthetic lookup outage');
    await expect(unavailable.adapter.recover(request())).rejects.toMatchObject({
      code: 'EXPO_SEND_LEDGER_FAILED',
      disposition: 'ambiguous',
    });
    expect(unavailable.ledger.claims).toHaveLength(0);
    expect(unavailable.transport.calls).toBe(0);
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
    const app = adapterRuntime((sent) => {
      const suffix = sent[0]!.attempt.id.slice(-3);
      if (suffix === '101') {
        return Promise.resolve([accepted('ticket-batch-1')]);
      }
      if (suffix === '102') {
        return Promise.resolve([
          failed('EXPO_DEVICE_NOT_REGISTERED', null, true),
        ]);
      }
      return Promise.resolve([retry('EXPO_MESSAGE_RATE_EXCEEDED')]);
    });
    const items = [
      liveItemWithAttempt(101),
      liveItemWithAttempt(102),
      liveItemWithAttempt(103),
    ];

    const settled = await Promise.allSettled(
      items.map((item) => app.adapter.send(request(item))),
    );

    expect(app.transport.chunks.map((chunk) => chunk.length)).toEqual([
      1, 1, 1,
    ]);
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

  test('filters mixed endpoint eligibility independently and safely completes every irreversible claim', async () => {
    const items = [
      liveItemWithAttempt(201),
      liveItemWithAttempt(202),
      liveItemWithAttempt(203),
      liveItemWithAttempt(204),
      liveItemWithAttempt(205),
    ];
    const hostileToken = 'ExponentPushToken[hostile-policy-error]';
    const checker = new ControlledEndpointEligibility((item) => {
      switch (item.attempt.id) {
        case items[0]?.attempt.id:
          return true;
        case items[1]?.attempt.id:
          return false;
        case items[2]?.attempt.id:
          throw new PushEndpointEligibilityError(
            'RETRYABLE_RESPONSE',
            true,
            503,
          );
        case items[3]?.attempt.id:
          throw new PushEndpointEligibilityError(
            'REQUEST_UNAUTHORIZED',
            false,
            403,
          );
        default:
          throw new Error(`hostile checker detail ${hostileToken}`);
      }
    });
    const app = adapterRuntime(
      [accepted('ticket-only-eligible')],
      undefined,
      checker,
    );

    const settled = await Promise.allSettled(
      items.map((item) => app.adapter.send(request(item))),
    );

    expect(app.transport.chunks).toEqual([[items[0]!]]);
    expect(checker.work).toEqual(items);
    expect(settled).toEqual([
      {
        status: 'fulfilled',
        value: expect.objectContaining({
          state: 'provider-accepted',
          providerReference: 'ticket-only-eligible',
        }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({
          code: 'EXPO_ENDPOINT_INELIGIBLE',
          disposition: 'terminal-failure',
          diagnosticDigest: null,
        }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({
          code: 'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE',
          disposition: 'safe-to-retry',
          diagnosticDigest: null,
        }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({
          code: 'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
          disposition: 'terminal-failure',
          diagnosticDigest: null,
        }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({
          code: 'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
          disposition: 'terminal-failure',
          diagnosticDigest: null,
        }),
      },
    ]);
    expect(app.ledger.completions).toHaveLength(items.length);
    expect(
      app.ledger.completions.map((completion) =>
        completion.completion.kind === 'failure'
          ? completion.completion.failure.code
          : completion.completion.outcome.state,
      ),
    ).toEqual([
      'provider-accepted',
      'EXPO_ENDPOINT_INELIGIBLE',
      'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE',
      'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
      'EXPO_ENDPOINT_ELIGIBILITY_BLOCKED',
    ]);
    const serializedSafeState = JSON.stringify({
      completions: app.ledger.completions,
      settled,
    });
    expect(serializedSafeState).not.toContain(hostileToken);
    expect(serializedSafeState).not.toContain('hostile checker detail');
  });

  test('fails an entirely unavailable eligibility batch safely without transport I/O and replays retained failures', async () => {
    const checker = new ControlledEndpointEligibility(
      new PushEndpointEligibilityError('REQUEST_FAILED', true),
    );
    const app = adapterRuntime([accepted()], undefined, checker);
    const items = [
      liveItemWithAttempt(211),
      liveItemWithAttempt(212),
      liveItemWithAttempt(213),
    ];

    const settled = await Promise.allSettled(
      items.map((item) => app.adapter.send(request(item))),
    );

    expect(settled).toEqual(
      items.map(() => ({
        status: 'rejected',
        reason: expect.objectContaining({
          code: 'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE',
          disposition: 'safe-to-retry',
          diagnosticDigest: null,
        }),
      })),
    );
    expect(app.transport.calls).toBe(0);
    expect(checker.work).toEqual(items);
    expect(app.ledger.completions).toHaveLength(items.length);

    await expect(app.adapter.send(request(items[0]))).rejects.toMatchObject({
      code: 'EXPO_ENDPOINT_ELIGIBILITY_UNAVAILABLE',
      disposition: 'safe-to-retry',
    });
    expect(app.transport.calls).toBe(0);
    expect(checker.work).toHaveLength(items.length);
    expect(app.ledger.completions).toHaveLength(items.length);
  });

  test('preserves duplicate accepted references across isolated requests', async () => {
    const app = adapterRuntime((sent) => {
      const suffix = sent[0]!.attempt.id.slice(-3);
      return Promise.resolve([
        accepted(suffix === '142' ? 'unique-ticket' : 'duplicate-ticket'),
      ]);
    });
    const items = [
      liveItemWithAttempt(141),
      liveItemWithAttempt(142),
      liveItemWithAttempt(143),
    ];

    await expect(
      Promise.all(items.map((item) => app.adapter.send(request(item)))),
    ).resolves.toEqual([
      expect.objectContaining({
        state: 'provider-accepted',
        providerReference: 'duplicate-ticket',
      }),
      expect.objectContaining({
        state: 'provider-accepted',
        providerReference: 'unique-ticket',
      }),
      expect.objectContaining({
        state: 'provider-accepted',
        providerReference: 'duplicate-ticket',
      }),
    ]);
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

  test('expires work that crosses its TTL during eligibility and never enters transport', async () => {
    const item = liveItemWithAttempt(221);
    const expiresAt =
      Date.parse(item.batch.createdAt) + EXPO_EMERGENCY_TTL_SECONDS * 1_000;
    let now = expiresAt - 1;
    const checker = new ControlledEndpointEligibility(() => {
      now = expiresAt;
      return true;
    });
    const app = adapterRuntime([accepted()], () => now, checker);

    await expect(app.adapter.send(request(item))).resolves.toMatchObject({
      state: 'expired',
      reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
    });
    expect(checker.work).toEqual([item]);
    expect(app.transport.calls).toBe(0);
    expect(app.ledger.completions).toHaveLength(1);
    expect(app.ledger.completions[0]?.completion).toMatchObject({
      kind: 'outcome',
      outcome: {
        state: 'expired',
        reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
      },
    });
  });

  test('skips current eligibility for already-expired and retained completed truth', async () => {
    const item = liveItemWithAttempt(222);
    const expiresAt =
      Date.parse(item.batch.createdAt) + EXPO_EMERGENCY_TTL_SECONDS * 1_000;
    const expiredChecker = new ControlledEndpointEligibility(
      new Error('expired work must not be checked'),
    );
    const expiredApp = adapterRuntime(
      [accepted()],
      () => expiresAt,
      expiredChecker,
    );

    await expect(expiredApp.adapter.send(request(item))).resolves.toMatchObject(
      {
        state: 'expired',
        reasonCode: 'EXPO_NOTIFICATION_EXPIRED',
      },
    );
    expect(expiredChecker.work).toHaveLength(0);
    expect(expiredApp.transport.calls).toBe(0);

    const completedChecker = new ControlledEndpointEligibility();
    const completedApp = adapterRuntime(
      [accepted('ticket-retained')],
      undefined,
      completedChecker,
    );
    const first = await completedApp.adapter.send(request());
    const replay = await completedApp.adapter.send(request());

    expect(replay).toEqual(first);
    expect(completedChecker.work).toHaveLength(1);
    expect(completedApp.transport.calls).toBe(1);
    expect(completedApp.ledger.completions).toHaveLength(1);
  });

  test('isolates malformed item outcomes without discarding valid siblings', async () => {
    const app = adapterRuntime((sent) => {
      const suffix = sent[0]!.attempt.id.slice(-3);
      return Promise.resolve([
        suffix === '112'
          ? ({
              kind: 'provider-accepted',
              state: 'delivered',
              providerReference:
                'ticket-isolated-2\nExponentPushToken[hostile-ledger-text]',
              reasonCode: 'EXPO_DEVICE_NOT_REGISTERED',
              invalidatesEndpoint: true,
            } as never)
          : accepted(`ticket-isolated-${suffix}`),
      ]);
    });
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
    expect(app.transport.chunks.map((chunk) => chunk.length)).toEqual([
      1, 1, 1,
    ]);
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
    expect(app.transport.chunks.map((chunk) => chunk.length)).toEqual([1, 1]);
    expect(app.ledger.completions).toHaveLength(2);
  });

  test('sends every ledger-claimed attempt through an isolated provider request', async () => {
    const app = adapterRuntime((items) =>
      Promise.resolve(
        items.map((item) => accepted(`ticket-${item.attempt.id}`)),
      ),
    );
    const items = Array.from({ length: 201 }, (_unused, index) =>
      liveItemWithAttempt(index + 1_000),
    );

    await Promise.all(items.map((item) => app.adapter.send(request(item))));

    expect(app.transport.chunks).toHaveLength(201);
    expect(app.transport.chunks.every((chunk) => chunk.length === 1)).toBe(
      true,
    );
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

  test('reads fulfilled transport arrays through descriptors without invoking get traps', async () => {
    let lengthGetCalls = 0;
    const hostile = new Proxy([accepted()], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthGetCalls += 1;
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
        state: 'provider-accepted',
        providerReference: 'ticket-1',
      });
    }
    expect(lengthGetCalls).toBe(0);
    expect(app.transport.calls).toBe(1);
    expect(app.ledger.completions[0]?.completion).toMatchObject({
      kind: 'outcome',
      outcome: {
        state: 'provider-accepted',
        providerReference: 'ticket-1',
      },
    });
  });

  test('isolates a throwing fulfilled item while preserving its valid sibling', async () => {
    const items = [liveItemWithAttempt(132), liveItemWithAttempt(133)];
    let call = 0;
    const app = adapterRuntime(async () => {
      call += 1;
      if (call === 1) return [accepted('ticket-valid')];
      const hostile = [accepted('ticket-hostile')];
      Object.defineProperty(hostile, 0, {
        configurable: true,
        enumerable: true,
        get: () => {
          throw new Error('synthetic hostile outcome slot');
        },
      });
      return hostile;
    });

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
    expect(app.transport.calls).toBe(2);
  });

  test('never trusts inherited or accessor-backed fulfilled transport slots', async () => {
    let getterCalls = 0;
    const inherited = new Array<ExpoProviderOutcome>(1);
    Object.setPrototypeOf(inherited, {
      0: accepted('inherited-ticket'),
      __proto__: Array.prototype,
    });
    const inheritedApp = adapterRuntime(async () => inherited);
    await expect(inheritedApp.adapter.send(request())).resolves.toMatchObject({
      state: 'unknown',
      providerReference: null,
    });

    const accessor = [accepted('placeholder-ticket')];
    Object.defineProperty(accessor, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return accepted('accessor-ticket');
      },
    });
    const accessorApp = adapterRuntime(async () => accessor);
    await expect(accessorApp.adapter.send(request())).resolves.toMatchObject({
      state: 'unknown',
      providerReference: null,
    });
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(inheritedApp.ledger.completions)).not.toContain(
      'inherited-ticket',
    );
    expect(JSON.stringify(accessorApp.ledger.completions)).not.toContain(
      'accessor-ticket',
    );
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
