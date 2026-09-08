import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  EndpointSchema,
  type Endpoint,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import type { ProviderSendRequest } from '../shared/processor';
import { attemptFor, realBatch, TIMES } from '../shared/test-fixtures';
import type {
  ClaimExpoProviderIoRequest,
  CompleteExpoProviderIoRequest,
  DurableExpoSendLedger,
  ExpoSendLedgerClaim,
  ExpoSendLedgerLookup,
} from './adapter';
import {
  LedgeredDirectPushAdapter,
  DIRECT_PUSH_INTEGRATION_ID,
} from './direct-adapter';
import type { PushEndpointEligibilityChecker } from './eligibility';
import {
  APNS_DIRECT_PROVIDER,
  FCM_DIRECT_PROVIDER,
  acceptedDirectPush,
  invalidatingDirectPush,
  retryableDirectPush,
  type DirectPushProvider,
  type DirectPushPreparation,
  type DirectPushProviderOutcome,
  type DirectPushTransport,
} from './direct-protocol';

const CLAIM_TOKEN = 'synthetic-direct-claim-0001';

function directWork(provider: 'apns' | 'fcm' = 'apns'): WorkerAttemptWorkItem {
  const base = realBatch();
  const batch = DispatchBatchSchema.parse({
    ...base,
    integrationId: DIRECT_PUSH_INTEGRATION_ID,
  });
  const endpoint: Endpoint = EndpointSchema.parse({
    id: '00000000-0000-4000-8000-000000000012',
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'push',
    platform: provider === 'apns' ? 'ios' : 'android',
    provider,
    serviceEnvironment: 'production',
    token:
      provider === 'apns'
        ? 'a'.repeat(64)
        : `synthetic-fcm-token-${'a'.repeat(64)}`,
  });
  return Object.freeze({ batch, attempt: attemptFor(batch), endpoint });
}

function request(workItem = directWork()): ProviderSendRequest {
  return Object.freeze({
    workItem,
    idempotencyKey: workItem.attempt.id,
  });
}

class MemoryLedger implements DurableExpoSendLedger {
  public claim: ExpoSendLedgerClaim = {
    kind: 'execute',
    claimToken: CLAIM_TOKEN,
  };
  public lookup: ExpoSendLedgerLookup = { kind: 'missing' };
  public readonly claims: ClaimExpoProviderIoRequest[] = [];
  public readonly completions: CompleteExpoProviderIoRequest[] = [];

  public lookupProviderIo(): Promise<ExpoSendLedgerLookup> {
    return Promise.resolve(this.lookup);
  }

  public claimProviderIo(
    value: ClaimExpoProviderIoRequest,
  ): Promise<ExpoSendLedgerClaim> {
    this.claims.push(value);
    return Promise.resolve(this.claim);
  }

  public completeProviderIo(
    value: CompleteExpoProviderIoRequest,
  ): Promise<void> {
    this.completions.push(value);
    this.claim = { kind: 'completed', completion: value.completion };
    this.lookup = { kind: 'completed', completion: value.completion };
    return Promise.resolve();
  }
}

class ControlledTransport implements DirectPushTransport {
  public preparations = 0;
  public calls = 0;

  public constructor(
    public readonly provider: DirectPushProvider,
    private readonly result: DirectPushProviderOutcome | unknown,
  ) {}

  public prepare(): Promise<DirectPushPreparation> {
    this.preparations += 1;
    return Promise.resolve({
      kind: 'prepared',
      provider: this.provider,
      send: () => {
        this.calls += 1;
        return Promise.resolve(this.result);
      },
    });
  }
}

class Eligibility implements PushEndpointEligibilityChecker {
  public calls = 0;

  public constructor(private readonly result: boolean | boolean[] = true) {}

  public isEligible(): Promise<boolean> {
    this.calls += 1;
    return Promise.resolve(
      Array.isArray(this.result) ? (this.result.shift() ?? false) : this.result,
    );
  }
}

function runtime(
  provider: DirectPushProvider = APNS_DIRECT_PROVIDER,
  outcome: DirectPushProviderOutcome | unknown = acceptedDirectPush(
    '12345678-1234-1234-1234-123456789abc',
  ),
  eligible = true,
) {
  const ledger = new MemoryLedger();
  const transport = new ControlledTransport(provider, outcome);
  const eligibility = new Eligibility(eligible);
  const adapter = new LedgeredDirectPushAdapter({
    transport,
    sendLedger: ledger,
    endpointEligibility: eligibility,
    authorizeLiveTransport: () => true,
    clock: () => TIMES.attempted,
  });
  return { adapter, eligibility, ledger, transport };
}

describe('ledgered direct push adapter', () => {
  test('implements the canonical adapter and keeps destinations out of provider-I/O claims', async () => {
    const app = runtime();
    await expect(app.adapter.send(request())).resolves.toMatchObject({
      state: 'provider-accepted',
      provider: APNS_DIRECT_PROVIDER,
      providerReference: '12345678-1234-1234-1234-123456789abc',
    });
    expect(app.adapter).toMatchObject({
      channel: 'push',
      integrationId: DIRECT_PUSH_INTEGRATION_ID,
      deliverySemantics: 'attempt-id-idempotent',
    });
    expect(app.ledger.claims).toEqual([
      {
        attemptId: directWork().attempt.id,
        workFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    const persisted = JSON.stringify([
      ...app.ledger.claims,
      ...app.ledger.completions,
    ]);
    expect(persisted).not.toContain('synthetic-fcm-token');
    expect(persisted).not.toContain('[INCIDENT]');
  });

  test('retains endpoint-invalidating provider truth for post-evidence worker handling', async () => {
    const app = runtime(
      FCM_DIRECT_PROVIDER,
      invalidatingDirectPush('FCM_UNREGISTERED'),
    );
    await expect(
      app.adapter.send(request(directWork('fcm'))),
    ).resolves.toMatchObject({
      state: 'failed',
      provider: FCM_DIRECT_PROVIDER,
      reasonCode: 'FCM_UNREGISTERED',
    });
    expect(app.ledger.completions[0]?.completion).toMatchObject({
      kind: 'outcome',
      outcome: { reasonCode: 'FCM_UNREGISTERED' },
    });
  });

  test('converts throttle to a durable retryable provider failure', async () => {
    const app = runtime(
      APNS_DIRECT_PROVIDER,
      retryableDirectPush('APNS_THROTTLED'),
    );
    await expect(app.adapter.send(request())).rejects.toMatchObject({
      code: 'APNS_THROTTLED',
      disposition: 'safe-to-retry',
    });
    expect(app.ledger.completions[0]?.completion).toMatchObject({
      kind: 'failure',
      failure: { code: 'APNS_THROTTLED', disposition: 'safe-to-retry' },
    });
  });

  test('retries credential preparation without making an irreversible provider claim', async () => {
    const ledger = new MemoryLedger();
    const adapter = new LedgeredDirectPushAdapter({
      transport: {
        provider: FCM_DIRECT_PROVIDER,
        prepare: () =>
          Promise.resolve({
            kind: 'outcome',
            provider: FCM_DIRECT_PROVIDER,
            outcome: retryableDirectPush('FCM_AUTHENTICATION_UNAVAILABLE'),
          }),
      },
      sendLedger: ledger,
      endpointEligibility: new Eligibility(),
      authorizeLiveTransport: () => true,
      clock: () => TIMES.attempted,
    });
    await expect(
      adapter.send(request(directWork('fcm'))),
    ).rejects.toMatchObject({
      code: 'FCM_AUTHENTICATION_UNAVAILABLE',
      disposition: 'safe-to-retry',
    });
    expect(ledger.claims).toHaveLength(0);
    expect(ledger.completions).toHaveLength(0);
  });

  test('preflights before claiming and never calls a provider when authorization or eligibility blocks', async () => {
    const blocked = runtime(
      APNS_DIRECT_PROVIDER,
      acceptedDirectPush(APNS_ID),
      false,
    );
    await expect(blocked.adapter.send(request())).rejects.toMatchObject({
      code: 'DIRECT_PUSH_ENDPOINT_ELIGIBILITY_BLOCKED',
      disposition: 'terminal-failure',
    });
    expect(blocked.ledger.claims).toHaveLength(0);
    expect(blocked.transport.preparations).toBe(0);
    expect(blocked.transport.calls).toBe(0);

    const ledger = new MemoryLedger();
    const transport = new ControlledTransport(
      APNS_DIRECT_PROVIDER,
      acceptedDirectPush(APNS_ID),
    );
    const adapter = new LedgeredDirectPushAdapter({
      transport,
      sendLedger: ledger,
      endpointEligibility: new Eligibility(),
      authorizeLiveTransport: () => false,
      clock: () => TIMES.attempted,
    });
    await expect(adapter.send(request())).rejects.toMatchObject({
      code: 'DIRECT_PUSH_LIVE_TRANSPORT_DISABLED',
    });
    expect(ledger.claims).toHaveLength(0);
    expect(transport.preparations).toBe(0);
    expect(transport.calls).toBe(0);
  });

  test('rechecks endpoint eligibility after credential preparation and immediately before send', async () => {
    const ledger = new MemoryLedger();
    const transport = new ControlledTransport(
      APNS_DIRECT_PROVIDER,
      acceptedDirectPush(APNS_ID),
    );
    const eligibility = new Eligibility([true, false]);
    const adapter = new LedgeredDirectPushAdapter({
      transport,
      sendLedger: ledger,
      endpointEligibility: eligibility,
      authorizeLiveTransport: () => true,
      clock: () => TIMES.attempted,
    });
    await expect(adapter.send(request())).rejects.toMatchObject({
      code: 'DIRECT_PUSH_ENDPOINT_ELIGIBILITY_BLOCKED',
    });
    expect(transport.preparations).toBe(1);
    expect(ledger.claims).toHaveLength(1);
    expect(transport.calls).toBe(0);
  });

  test('never replays uncertain claims and treats malformed transport outcomes as unknown', async () => {
    const uncertain = runtime();
    uncertain.ledger.claim = { kind: 'uncertain' };
    await expect(uncertain.adapter.send(request())).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'APNS_NETWORK_OUTCOME_AMBIGUOUS',
    });
    expect(uncertain.transport.calls).toBe(0);

    const malformed = runtime(APNS_DIRECT_PROVIDER, {
      kind: 'provider-accepted',
      state: 'provider-accepted',
      providerReference: 'unsafe/reference',
      reasonCode: null,
      invalidatesEndpoint: false,
    });
    await expect(malformed.adapter.send(request())).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'APNS_RESPONSE_INVALID',
    });

    const mixedProvider = runtime(
      APNS_DIRECT_PROVIDER,
      invalidatingDirectPush('FCM_UNREGISTERED'),
    );
    await expect(mixedProvider.adapter.send(request())).resolves.toMatchObject({
      state: 'unknown',
      reasonCode: 'APNS_RESPONSE_INVALID',
    });
  });
});

const APNS_ID = '12345678-1234-1234-1234-123456789abc';
