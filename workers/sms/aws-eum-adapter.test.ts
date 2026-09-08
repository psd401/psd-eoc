import { describe, expect, test } from 'bun:test';
import {
  DispatchBatchSchema,
  EndpointSchema,
  type DispatchBatch,
  type Endpoint,
} from '@psd-eoc/contracts';

import { ProviderDispatchError, type ProviderSendRequest } from '../shared';
import {
  IDS,
  TIMES,
  attemptFor,
  realBatch,
  syntheticBatch,
} from '../shared/test-fixtures';
import {
  AWS_EUM_SMS_PROVIDER,
  AwsEumSmsAdapter,
  measureAwsEumSmsLength,
  type AwsEumSendTextMessageRequest,
  type AwsEumSmsAdapterOptions,
  type AwsEumSmsClient,
  type AwsEumSmsLedgerClaim,
  type AwsEumSmsLedgerClaimRequest,
  type AwsEumSmsLedgerCompleteRequest,
  type AwsEumSmsLedgerCompletion,
  type AwsEumSmsLedgerLookup,
  type AwsEumSmsLedgerLookupRequest,
  type AwsEumSmsSendLedger,
} from './aws-eum-adapter';

const INCIDENT_BODY =
  '[INCIDENT] REAL INCIDENT - ACTIVATION: Synthetic lockdown. [INCIDENT]';
const DRILL_BODY =
  '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic drill only. [DRILL]';

function smsBatch(mode: 'live' | 'mock' = 'live'): DispatchBatch {
  const base = mode === 'live' ? realBatch() : syntheticBatch();
  const marker = mode === 'live' ? 'INCIDENT' : 'DRILL';
  return DispatchBatchSchema.parse({
    ...base,
    channel: 'sms',
    renderedMessage: {
      eventKind: base.eventKind,
      templateMode: base.templateMode,
      purpose: base.purpose,
      classificationMarker: marker,
      channel: 'sms',
      body: mode === 'live' ? INCIDENT_BODY : DRILL_BODY,
    },
    integrationId: 'aws-eum-sms',
  });
}

function staffDrillSmsBatch(): DispatchBatch {
  const base = smsBatch('live');
  return DispatchBatchSchema.parse({
    ...base,
    eventKind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: {
      ...base.eventTypeVersion,
      templateMode: 'drill',
    },
    renderedMessage: {
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: base.purpose,
      classificationMarker: 'DRILL',
      channel: 'sms',
      body: DRILL_BODY,
    },
  });
}

function smsEndpoint(): Endpoint {
  return EndpointSchema.parse({
    id: IDS.endpoint,
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'sms',
    phoneNumber: '+12025550123',
  });
}

function providerRequest(
  batch: DispatchBatch = smsBatch(),
): ProviderSendRequest {
  const attempt = attemptFor(batch);
  return Object.freeze({
    workItem: Object.freeze({
      batch,
      attempt,
      endpoint: smsEndpoint(),
    }),
    idempotencyKey: attempt.id,
  });
}

function classifiedBody(
  totalUnits: number,
  encoding: 'gsm-7' | 'ucs-2',
): string {
  const prefix = '[INCIDENT] REAL INCIDENT - ACTIVATION: ';
  const suffix = ' [INCIDENT]';
  const unicode = encoding === 'ucs-2' ? '漢' : '';
  const frame = `${prefix}${unicode}${suffix}`;
  const frameUnits = measureAwsEumSmsLength(frame).units;
  return `${prefix}${unicode}${'A'.repeat(totalUnits - frameUnits)}${suffix}`;
}

function smsBatchWithBody(body: string): DispatchBatch {
  const base = smsBatch();
  return DispatchBatchSchema.parse({
    ...base,
    renderedMessage: { ...base.renderedMessage, body },
  });
}

class RecordingClient implements AwsEumSmsClient {
  public readonly deliverySemantics = 'single-wire-attempt' as const;
  public readonly requests: AwsEumSendTextMessageRequest[] = [];

  public constructor(
    private readonly handler: (
      request: AwsEumSendTextMessageRequest,
    ) => Promise<unknown> = () =>
      Promise.resolve({ MessageId: 'synthetic-provider-message-id' }),
  ) {}

  public sendTextMessage(
    request: AwsEumSendTextMessageRequest,
  ): Promise<unknown> {
    this.requests.push(request);
    return this.handler(request);
  }
}

interface LedgerRow {
  readonly fingerprint: string;
  readonly leaseToken: string;
  completion: AwsEumSmsLedgerCompletion | null;
  indeterminate: boolean;
}

class MemorySendLedger implements AwsEumSmsSendLedger {
  public readonly rows = new Map<string, LedgerRow>();
  public lookupCalls = 0;
  public claimCalls = 0;
  public completeCalls = 0;
  public failCompleteOnce = false;

  public lookup(
    request: AwsEumSmsLedgerLookupRequest,
  ): Promise<AwsEumSmsLedgerLookup> {
    this.lookupCalls += 1;
    const existing = this.rows.get(request.attemptId);
    if (existing === undefined) {
      return Promise.resolve({ kind: 'missing' });
    }
    if (existing.fingerprint !== request.fingerprint) {
      throw new Error('Synthetic ledger fingerprint conflict.');
    }
    if (existing.completion !== null) {
      return Promise.resolve({
        kind: 'completed',
        completion: existing.completion,
      });
    }
    return Promise.resolve(
      existing.indeterminate
        ? { kind: 'indeterminate' }
        : { kind: 'in-progress' },
    );
  }

  public claim(
    request: AwsEumSmsLedgerClaimRequest,
  ): Promise<AwsEumSmsLedgerClaim> {
    this.claimCalls += 1;
    const existing = this.rows.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.fingerprint) {
        throw new Error('Synthetic ledger fingerprint conflict.');
      }
      if (existing.completion !== null) {
        return Promise.resolve({
          kind: 'completed',
          completion: existing.completion,
        });
      }
      return Promise.resolve(
        existing.indeterminate
          ? { kind: 'indeterminate' }
          : { kind: 'in-progress' },
      );
    }
    const row: LedgerRow = {
      fingerprint: request.fingerprint,
      leaseToken: IDS.secondAttempt,
      completion: null,
      indeterminate: false,
    };
    this.rows.set(request.attemptId, row);
    return Promise.resolve({ kind: 'acquired', leaseToken: row.leaseToken });
  }

  public complete(request: AwsEumSmsLedgerCompleteRequest): Promise<void> {
    this.completeCalls += 1;
    const row = this.rows.get(request.attemptId);
    if (
      row === undefined ||
      row.fingerprint !== request.fingerprint ||
      row.leaseToken !== request.leaseToken
    ) {
      throw new Error('Synthetic ledger completion conflict.');
    }
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false;
      row.indeterminate = true;
      throw new Error('Synthetic ledger completion ambiguity.');
    }
    row.completion = request.completion;
    return Promise.resolve();
  }
}

const BASE_OPTIONS = Object.freeze({
  originationIdentity:
    'arn:aws:sms-voice:us-west-2:000000000000:phone-number/synthetic',
  configurationSetName: 'psd-eoc-sms',
  protectConfigurationId: 'protect-synthetic',
  maxPrice: '0.05',
  timeToLiveSeconds: 300,
  clock: () => 0,
});

function adapter(
  client = new RecordingClient(),
  ledger = new MemorySendLedger(),
  overrides: Partial<AwsEumSmsAdapterOptions> = {},
): Readonly<{
  adapter: AwsEumSmsAdapter;
  client: RecordingClient;
  ledger: MemorySendLedger;
  providerAuthorizationWorkItems: ProviderSendRequest['workItem'][];
}> {
  const providerAuthorizationWorkItems: ProviderSendRequest['workItem'][] = [];
  return Object.freeze({
    client,
    ledger,
    providerAuthorizationWorkItems,
    adapter: new AwsEumSmsAdapter({
      client,
      ledger,
      ...BASE_OPTIONS,
      featureEnabled: true,
      authorizeProviderSend: (workItem) => {
        providerAuthorizationWorkItems.push(workItem);
        return Object.freeze({ authorized: true, timeToLiveSeconds: 299 });
      },
      ...overrides,
    }),
  });
}

function providerException(
  name: string,
  options: Readonly<{
    reason?: string;
    requestId?: string;
    status?: number;
  }> = {},
): Error {
  return Object.assign(new Error('Untrusted provider text is not inspected.'), {
    name,
    ...(options.reason === undefined ? {} : { Reason: options.reason }),
    $metadata: {
      ...(options.requestId === undefined
        ? {}
        : { requestId: options.requestId }),
      ...(options.status === undefined
        ? {}
        : { httpStatusCode: options.status }),
    },
  });
}

describe('AWS EUM SMS request and live gates', () => {
  test('constructs an exact transactional request without altering INCIDENT copy', async () => {
    const app = adapter();
    const request = providerRequest();

    await expect(app.adapter.send(request)).resolves.toEqual({
      state: 'provider-accepted',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: 'synthetic-provider-message-id',
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });

    expect(app.client.requests).toEqual([
      {
        DestinationPhoneNumber: '+12025550123',
        OriginationIdentity:
          'arn:aws:sms-voice:us-west-2:000000000000:phone-number/synthetic',
        MessageBody: INCIDENT_BODY,
        MessageType: 'TRANSACTIONAL',
        ConfigurationSetName: 'psd-eoc-sms',
        MaxPrice: '0.05',
        TimeToLive: 299,
        Context: {
          psdAttemptId: IDS.attempt,
          psdProviderClaimToken: IDS.secondAttempt,
        },
        DryRun: false,
        ProtectConfigurationId: 'protect-synthetic',
      },
    ]);
    expect(app.providerAuthorizationWorkItems).toEqual([request.workItem]);
  });

  test('preserves an exact staff DRILL request at the provider boundary', async () => {
    const app = adapter();
    const request = providerRequest(staffDrillSmsBatch());

    await expect(app.adapter.send(request)).resolves.toEqual(
      expect.objectContaining({ state: 'provider-accepted' }),
    );

    expect(app.client.requests).toEqual([
      {
        DestinationPhoneNumber: '+12025550123',
        OriginationIdentity:
          'arn:aws:sms-voice:us-west-2:000000000000:phone-number/synthetic',
        MessageBody: DRILL_BODY,
        MessageType: 'TRANSACTIONAL',
        ConfigurationSetName: 'psd-eoc-sms',
        MaxPrice: '0.05',
        TimeToLive: 299,
        Context: {
          psdAttemptId: IDS.attempt,
          psdProviderClaimToken: IDS.secondAttempt,
        },
        DryRun: false,
        ProtectConfigurationId: 'protect-synthetic',
      },
    ]);
  });

  test('fails closed for an arbitrary client that does not prove single-wire semantics', () => {
    let hiddenWireAttempts = 0;
    const retryingClient = {
      async sendTextMessage(): Promise<unknown> {
        hiddenWireAttempts += 2;
        return { MessageId: 'unsafe-retried-message' };
      },
    } as unknown as AwsEumSmsClient;
    const ledger = new MemorySendLedger();

    expect(
      () =>
        new AwsEumSmsAdapter({
          client: retryingClient,
          ledger,
          ...BASE_OPTIONS,
          featureEnabled: true,
        }),
    ).toThrow('must guarantee one wire attempt');
    expect(hiddenWireAttempts).toBe(0);
    expect(ledger.lookupCalls).toBe(0);
    expect(ledger.claimCalls).toBe(0);
  });

  test('is dark by default and also requires a successful runtime authorization', async () => {
    for (const overrides of [
      {
        featureEnabled: false,
        authorizeProviderSend: () => ({
          authorized: true,
          timeToLiveSeconds: 300,
        }),
      },
      { featureEnabled: true },
    ] satisfies readonly Partial<AwsEumSmsAdapterOptions>[]) {
      const client = new RecordingClient();
      const ledger = new MemorySendLedger();
      const instance = new AwsEumSmsAdapter({
        client,
        ledger,
        ...BASE_OPTIONS,
        ...overrides,
      });
      await expect(instance.send(providerRequest())).rejects.toBeInstanceOf(
        ProviderDispatchError,
      );
      expect(client.requests).toHaveLength(0);
      expect(ledger.claimCalls).toBe(0);
    }
  });

  test('terminally records a fresh full-work-item denial after the send claim', async () => {
    const client = new RecordingClient();
    const ledger = new MemorySendLedger();
    let authorizationCalls = 0;
    const request = providerRequest();
    const app = adapter(client, ledger, {
      authorizeProviderSend: (workItem) => {
        authorizationCalls += 1;
        expect(workItem).toEqual(request.workItem);
        expect(ledger.claimCalls).toBe(1);
        expect(ledger.rows.get(IDS.attempt)?.completion).toBeNull();
        expect(client.requests).toHaveLength(0);
        return Object.freeze({ authorized: false });
      },
    });

    for (let invocation = 0; invocation < 2; invocation += 1) {
      await expect(app.adapter.send(request)).rejects.toMatchObject({
        code: 'AWS_EUM_SEND_UNAUTHORIZED',
        disposition: 'terminal-failure',
      });
    }

    expect(authorizationCalls).toBe(1);
    expect(ledger.claimCalls).toBe(1);
    expect(ledger.completeCalls).toBe(1);
    expect(ledger.rows.get(IDS.attempt)?.completion).toEqual({
      kind: 'provider-error',
      code: 'AWS_EUM_SEND_UNAUTHORIZED',
      disposition: 'terminal-failure',
      diagnosticDigest: null,
    });
    expect(client.requests).toHaveLength(0);
  });

  test('ages the server TTL across authorization transit before provider I/O', async () => {
    let now = 1_000;
    const app = adapter(undefined, undefined, {
      clock: () => now,
      authorizeProviderSend: () => {
        now = 2_001;
        return Object.freeze({ authorized: true, timeToLiveSeconds: 10 });
      },
    });

    await expect(app.adapter.send(providerRequest())).resolves.toMatchObject({
      state: 'provider-accepted',
    });

    expect(app.client.requests[0]?.TimeToLive).toBe(8);
  });

  test('safely retries unavailable or expired final authorization without provider I/O', async () => {
    const cases = [
      {
        expectedCode: 'AWS_EUM_AUTHORIZATION_UNAVAILABLE',
        authorizeProviderSend: () => {
          throw new Error('Synthetic authorization outage.');
        },
        clock: () => 0,
      },
      {
        expectedCode: 'AWS_EUM_AUTHORIZATION_UNAVAILABLE',
        authorizeProviderSend: () => ({ authorized: true }),
        clock: () => 0,
      },
      {
        expectedCode: 'AWS_EUM_AUTHORIZATION_EXPIRED',
        authorizeProviderSend: () => {
          now = 5_000;
          return Object.freeze({ authorized: true, timeToLiveSeconds: 5 });
        },
        clock: () => now,
      },
    ] as const;
    let now = 0;

    for (const testCase of cases) {
      now = 0;
      const client = new RecordingClient();
      const ledger = new MemorySendLedger();
      const app = adapter(client, ledger, {
        clock: testCase.clock,
        authorizeProviderSend: testCase.authorizeProviderSend as never,
      });

      await expect(app.adapter.send(providerRequest())).rejects.toMatchObject({
        code: testCase.expectedCode,
        disposition: 'safe-to-retry',
      });
      expect(ledger.rows.get(IDS.attempt)?.completion).toMatchObject({
        kind: 'provider-error',
        code: testCase.expectedCode,
        disposition: 'safe-to-retry',
      });
      expect(client.requests).toHaveLength(0);
    }
  });

  test('rejects multipart GSM-7 and UCS-2 payloads before ledger or provider I/O', async () => {
    const unsafeBodies = [
      classifiedBody(161, 'gsm-7'),
      classifiedBody(71, 'ucs-2'),
    ] as const;

    expect(measureAwsEumSmsLength(unsafeBodies[0])).toMatchObject({
      encoding: 'gsm-7',
      units: 161,
      exceedsProviderLimit: false,
    });
    expect(measureAwsEumSmsLength(unsafeBodies[1])).toMatchObject({
      encoding: 'ucs-2',
      units: 71,
      exceedsProviderLimit: false,
    });

    for (const body of unsafeBodies) {
      const app = adapter();
      await expect(
        app.adapter.send(providerRequest(smsBatchWithBody(body))),
      ).rejects.toMatchObject({
        code: 'AWS_EUM_WORK_ITEM_INVALID',
        disposition: 'terminal-failure',
      });
      expect(app.ledger.lookupCalls).toBe(0);
      expect(app.ledger.claimCalls).toBe(0);
      expect(app.client.requests).toHaveLength(0);
    }
  });

  test('measures exact AWS GSM-7 and UCS-2 provider ceilings', () => {
    expect(measureAwsEumSmsLength('A'.repeat(1_530))).toEqual({
      encoding: 'gsm-7',
      units: 1_530,
      exceedsProviderLimit: false,
    });
    expect(measureAwsEumSmsLength('A'.repeat(1_531))).toEqual({
      encoding: 'gsm-7',
      units: 1_531,
      exceedsProviderLimit: true,
    });
    expect(measureAwsEumSmsLength('漢'.repeat(630))).toEqual({
      encoding: 'ucs-2',
      units: 630,
      exceedsProviderLimit: false,
    });
    expect(measureAwsEumSmsLength('漢'.repeat(631))).toEqual({
      encoding: 'ucs-2',
      units: 631,
      exceedsProviderLimit: true,
    });
  });
});

describe('AWS EUM attempt-ID send ledger', () => {
  test('replays a completed attempt without a second provider call', async () => {
    const app = adapter();
    const request = providerRequest();

    const first = await app.adapter.send(request);
    const replay = await app.adapter.send(request);

    expect(replay).toEqual(first);
    expect(app.client.requests).toHaveLength(1);
    expect(app.ledger.lookupCalls).toBe(2);
    expect(app.ledger.claimCalls).toBe(1);
    expect(app.ledger.completeCalls).toBe(1);
  });

  test('never re-sends after provider success followed by an indeterminate ledger commit', async () => {
    const client = new RecordingClient();
    const ledger = new MemorySendLedger();
    ledger.failCompleteOnce = true;
    const app = adapter(client, ledger);
    const request = providerRequest();

    await expect(app.adapter.send(request)).rejects.toMatchObject({
      code: 'AWS_EUM_LEDGER_COMMIT_AMBIGUOUS',
      disposition: 'ambiguous',
    });
    await expect(app.adapter.send(request)).rejects.toMatchObject({
      code: 'AWS_EUM_LEDGER_INDETERMINATE',
      disposition: 'ambiguous',
    });
    expect(client.requests).toHaveLength(1);
  });

  test('recovers retained provider truth even after live gates turn dark', async () => {
    const client = new RecordingClient();
    const ledger = new MemorySendLedger();
    const enabled = adapter(client, ledger).adapter;
    const request = providerRequest();
    const accepted = await enabled.send(request);
    const dark = new AwsEumSmsAdapter({
      client,
      ledger,
      ...BASE_OPTIONS,
      featureEnabled: false,
    });

    await expect(dark.send(request)).resolves.toEqual(accepted);
    expect(client.requests).toHaveLength(1);
  });

  test('read-only recovery returns retained truth and never claims or sends', async () => {
    const client = new RecordingClient();
    const ledger = new MemorySendLedger();
    const enabled = adapter(client, ledger).adapter;
    const request = providerRequest();
    const accepted = await enabled.send(request);
    const claimsAfterSend = ledger.claimCalls;
    const dark = new AwsEumSmsAdapter({
      client,
      ledger,
      ...BASE_OPTIONS,
      featureEnabled: false,
    });

    await expect(dark.recover(request)).resolves.toEqual({
      kind: 'outcome',
      outcome: accepted,
    });
    expect(client.requests).toHaveLength(1);
    expect(ledger.claimCalls).toBe(claimsAfterSend);
    const missingLedger = new MemorySendLedger();
    const missing = new AwsEumSmsAdapter({
      client,
      ledger: missingLedger,
      ...BASE_OPTIONS,
      featureEnabled: false,
    });
    await expect(missing.recover(request)).resolves.toEqual({
      kind: 'missing',
    });
    expect(client.requests).toHaveLength(1);
    expect(ledger.claimCalls).toBe(claimsAfterSend);
    expect(missingLedger.claimCalls).toBe(0);
  });
});

describe('AWS EUM provider truth mapping', () => {
  test('retries only explicit throttling and replays the same safe decision', async () => {
    const client = new RecordingClient(() =>
      Promise.reject(
        providerException('ThrottlingException', {
          requestId: 'synthetic-throttle-request',
          status: 400,
        }),
      ),
    );
    const app = adapter(client);
    const request = providerRequest();

    for (let invocation = 0; invocation < 2; invocation += 1) {
      await expect(app.adapter.send(request)).rejects.toMatchObject({
        code: 'AWS_EUM_THROTTLED',
        disposition: 'safe-to-retry',
        diagnosticDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
    expect(client.requests).toHaveLength(1);
  });

  test('maps known validation rejection to terminal failure', async () => {
    const client = new RecordingClient(() =>
      Promise.reject(
        providerException('ValidationException', {
          requestId: 'synthetic-validation-request',
          status: 400,
        }),
      ),
    );
    const app = adapter(client);

    await expect(app.adapter.send(providerRequest())).rejects.toMatchObject({
      code: 'AWS_EUM_REQUEST_INVALID',
      disposition: 'terminal-failure',
    });
  });

  test('maps 5xx, network, and malformed success to unknown without a replay send', async () => {
    const failures: readonly (() => Promise<unknown>)[] = [
      () =>
        Promise.reject(
          providerException('InternalServerException', {
            requestId: 'synthetic-server-request',
            status: 500,
          }),
        ),
      () => Promise.reject(new Error('synthetic network ambiguity')),
      () =>
        Promise.reject(
          new ProviderDispatchError(
            'SYNTHETIC_CLIENT_RETRY_REQUEST',
            'safe-to-retry',
          ),
        ),
      () => Promise.resolve({}),
    ];

    for (const failure of failures) {
      const client = new RecordingClient(failure);
      const app = adapter(client);
      const request = providerRequest();
      await expect(app.adapter.send(request)).rejects.toMatchObject({
        disposition: 'ambiguous',
      });
      await expect(app.adapter.send(request)).rejects.toMatchObject({
        disposition: 'ambiguous',
      });
      expect(client.requests).toHaveLength(1);
    }
  });

  test('surfaces provider opt-out as terminal failed truth for persistence', async () => {
    const client = new RecordingClient(() =>
      Promise.reject(
        providerException('ConflictException', {
          reason: 'DESTINATION_PHONE_NUMBER_OPTED_OUT',
          requestId: 'synthetic-opt-out-request',
          status: 400,
        }),
      ),
    );
    const app = adapter(client);
    const request = providerRequest();

    const outcome = await app.adapter.send(request);
    expect(outcome).toEqual({
      state: 'failed',
      provider: AWS_EUM_SMS_PROVIDER,
      providerReference: 'synthetic-opt-out-request',
      proof: null,
      reasonCode: 'DESTINATION_PHONE_NUMBER_OPTED_OUT',
      diagnosticDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(app.adapter.send(request)).resolves.toEqual(outcome);
    expect(client.requests).toHaveLength(1);
  });
});
