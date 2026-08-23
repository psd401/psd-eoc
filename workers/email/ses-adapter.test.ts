import { describe, expect, test } from 'bun:test';
import {
  ChannelAttemptSchema,
  DispatchBatchSchema,
  EmailEndpointSchema,
  type DispatchBatch,
} from '@psd-eoc/contracts';

import type { WorkerAttemptWorkItem } from '../shared/attempt';
import type { ProviderSendOutcome } from '../shared/processor';
import { ProviderDispatchError } from '../shared/retry';
import {
  SES_CONFIGURATION_SET_NAME,
  SES_CORRELATION_TAG_NAMES,
  SES_FROM_EMAIL_ADDRESS,
  SES_V2_PROVIDER,
  SesV2EmailAdapter,
  SesV2EmailAdapterError,
  type DurableSesSendLedger,
  type SesSendLedgerClaim,
  type SesSendLedgerClaimRequest,
  type SesSendLedgerCompleteRequest,
  type SesSendLedgerReleaseRequest,
  type SesV2Client,
  type SesV2SendEmailInput,
} from './ses-adapter';

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  request: '10000000-0000-4000-8000-000000000002',
  confirmation: '10000000-0000-4000-8000-000000000003',
  preview: '10000000-0000-4000-8000-000000000004',
  audience: '10000000-0000-4000-8000-000000000005',
  roster: '10000000-0000-4000-8000-000000000006',
  eventTypeVersion: '10000000-0000-4000-8000-000000000007',
  event: '10000000-0000-4000-8000-000000000008',
  facility: '10000000-0000-4000-8000-000000000014',
  intent: '10000000-0000-4000-8000-000000000009',
  batch: '10000000-0000-4000-8000-000000000010',
  recipient: '10000000-0000-4000-8000-000000000011',
  endpoint: '10000000-0000-4000-8000-000000000012',
  attempt: '10000000-0000-4000-8000-000000000013',
});

const CREATED_AT = '2026-08-11T16:00:00.000Z';
const ATTEMPTED_AT = '2026-08-11T16:00:01.000Z';

function batch(live: boolean): DispatchBatch {
  const real = live;
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    facilityId: IDS.facility,
    eventKind: real ? 'incident' : 'test',
    templateMode: real ? 'real' : 'drill',
    purpose: 'activation',
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: real ? 'real' : 'drill',
    },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: real ? 'staff' : 'synthetic',
    requestId: IDS.request,
    authorization: real
      ? {
          kind: 'human-confirmed',
          activationPreviewId: IDS.preview,
          preparedActivationId: null,
          confirmationId: IDS.confirmation,
          consequenceDigest: 'a'.repeat(64),
          requestId: IDS.request,
        }
      : {
          kind: 'synthetic-training',
          activationPreviewId: IDS.preview,
          consequenceDigest: 'b'.repeat(64),
          requestId: IDS.request,
        },
    channel: 'email',
    renderedMessage: real
      ? {
          eventKind: 'incident',
          templateMode: 'real',
          purpose: 'activation',
          classificationMarker: 'INCIDENT',
          channel: 'email',
          subject: '[INCIDENT] REAL INCIDENT - ACTIVATION: Lockdown [INCIDENT]',
          textBody:
            '[INCIDENT] REAL INCIDENT - ACTIVATION: Follow the response plan. [INCIDENT]',
        }
      : {
          eventKind: 'test',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          channel: 'email',
          subject: '[DRILL] TRAINING ONLY - ACTIVATION: Lockdown [DRILL]',
          textBody:
            '[DRILL] TRAINING ONLY - ACTIVATION: Follow the training plan. [DRILL]',
        },
    integrationStatus: real
      ? {
          integrationId: 'ses-email',
          label: 'live-verified',
          verifiedAt: CREATED_AT,
          verifiedByUserId: IDS.actor,
          authorizationReference: 'reviewed-product-owner-authorization',
          reasonCode: null,
          observedAt: CREATED_AT,
        }
      : {
          integrationId: 'ses-email',
          label: 'mocked',
          verifiedAt: null,
          verifiedByUserId: null,
          authorizationReference: null,
          reasonCode: null,
          observedAt: CREATED_AT,
        },
    sequence: 1,
    endpointCount: 1,
    createdAt: CREATED_AT,
  });
}

function workItem(live = true): WorkerAttemptWorkItem {
  const dispatch = batch(live);
  return Object.freeze({
    batch: dispatch,
    attempt: ChannelAttemptSchema.parse({
      id: IDS.attempt,
      batchId: dispatch.id,
      intentId: dispatch.intentId,
      eventId: dispatch.eventId,
      eventKind: dispatch.eventKind,
      templateMode: dispatch.templateMode,
      purpose: dispatch.purpose,
      eventTypeVersion: dispatch.eventTypeVersion,
      rosterSnapshotId: dispatch.rosterSnapshotId,
      rosterPopulation: dispatch.rosterPopulation,
      recipientId: IDS.recipient,
      endpointId: IDS.endpoint,
      channel: 'email',
      attemptNumber: 1,
      attemptedAt: ATTEMPTED_AT,
    }),
    endpoint: EmailEndpointSchema.parse({
      id: IDS.endpoint,
      status: 'active',
      capturedAt: CREATED_AT,
      channel: 'email',
      email: live
        ? 'authorized-staff@example.invalid'
        : 'synthetic-recipient@example.invalid',
    }),
  });
}

interface LedgerEntry {
  readonly fingerprint: string;
  readonly leaseToken: string;
  outcome: ProviderSendOutcome | null;
}

class MemoryDurableLedger implements DurableSesSendLedger {
  public readonly durability = 'durable' as const;
  public readonly entries = new Map<string, LedgerEntry>();
  public claimCalls = 0;
  public completeCalls = 0;
  public releaseCalls = 0;
  public failClaim = false;
  public failComplete = false;
  public failRelease: 'synchronously' | 'asynchronously' | null = null;

  public claim(
    request: SesSendLedgerClaimRequest,
  ): Promise<SesSendLedgerClaim> {
    this.claimCalls += 1;
    if (this.failClaim) throw new Error('Synthetic ledger unavailable.');
    const existing = this.entries.get(request.attemptId);
    if (existing !== undefined) {
      if (existing.fingerprint !== request.requestFingerprint) {
        throw new Error('Synthetic ledger fingerprint conflict.');
      }
      return Promise.resolve(
        existing.outcome === null
          ? { kind: 'in-progress' }
          : { kind: 'completed', outcome: existing.outcome },
      );
    }
    const entry: LedgerEntry = {
      fingerprint: request.requestFingerprint,
      leaseToken: `durable-lease:${request.attemptId}`,
      outcome: null,
    };
    this.entries.set(request.attemptId, entry);
    return Promise.resolve({
      kind: 'acquired',
      leaseToken: entry.leaseToken,
    });
  }

  public complete(request: SesSendLedgerCompleteRequest): Promise<void> {
    this.completeCalls += 1;
    if (this.failComplete) throw new Error('Synthetic completion failed.');
    const entry = this.entries.get(request.attemptId);
    if (
      entry === undefined ||
      entry.fingerprint !== request.requestFingerprint ||
      entry.leaseToken !== request.leaseToken
    ) {
      throw new Error('Synthetic completion conflict.');
    }
    entry.outcome = request.outcome;
    return Promise.resolve();
  }

  public release(request: SesSendLedgerReleaseRequest): Promise<void> {
    this.releaseCalls += 1;
    if (this.failRelease === 'synchronously') {
      throw new Error('Synthetic synchronous release failure.');
    }
    if (this.failRelease === 'asynchronously') {
      return Promise.reject(
        new Error('Synthetic asynchronous release failure.'),
      );
    }
    const entry = this.entries.get(request.attemptId);
    if (
      entry === undefined ||
      entry.fingerprint !== request.requestFingerprint ||
      entry.leaseToken !== request.leaseToken ||
      entry.outcome !== null
    ) {
      throw new Error('Synthetic release conflict.');
    }
    this.entries.delete(request.attemptId);
    return Promise.resolve();
  }
}

class CapturingSesClient implements SesV2Client {
  public readonly inputs: SesV2SendEmailInput[] = [];

  public constructor(
    private readonly handler: () => Promise<unknown> = () =>
      Promise.resolve({ MessageId: '01000191f0a1-example-000000' }),
  ) {}

  public sendEmail(input: SesV2SendEmailInput): Promise<unknown> {
    this.inputs.push(input);
    return this.handler();
  }
}

function adapter(
  client = new CapturingSesClient(),
  ledger = new MemoryDurableLedger(),
) {
  return {
    client,
    ledger,
    adapter: new SesV2EmailAdapter({
      client,
      sendLedger: ledger,
      fromEmailAddress: SES_FROM_EMAIL_ADDRESS,
      truthLabel: 'live-verified',
    }),
  };
}

describe('SES v2 live adapter', () => {
  test('sends one exact multipart message with configuration set and correlation tags', async () => {
    const app = adapter();
    const item = workItem();

    await expect(
      app.adapter.send({ workItem: item, idempotencyKey: IDS.attempt }),
    ).resolves.toEqual({
      state: 'provider-accepted',
      provider: SES_V2_PROVIDER,
      providerReference: '01000191f0a1-example-000000',
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });

    expect(app.client.inputs).toHaveLength(1);
    const input = app.client.inputs[0];
    expect(input).toEqual(
      expect.objectContaining({
        FromEmailAddress: SES_FROM_EMAIL_ADDRESS,
        ConfigurationSetName: SES_CONFIGURATION_SET_NAME,
        Destination: {
          ToAddresses: ['authorized-staff@example.invalid'],
        },
      }),
    );
    expect(input?.Content.Simple.Subject).toEqual({
      Charset: 'UTF-8',
      Data:
        item.batch.renderedMessage.channel === 'email'
          ? item.batch.renderedMessage.subject
          : '',
    });
    expect(input?.Content.Simple.Body.Text).toEqual({
      Charset: 'UTF-8',
      Data:
        item.batch.renderedMessage.channel === 'email'
          ? item.batch.renderedMessage.textBody
          : '',
    });
    expect(input?.Content.Simple.Body.Html.Data).toContain(
      '>[INCIDENT] REAL INCIDENT</h1>',
    );
    expect(input?.Content.Simple.Body.Html.Data).not.toContain('[DRILL]');
    expect(input?.EmailTags).toEqual([
      { Name: SES_CORRELATION_TAG_NAMES.attemptId, Value: IDS.attempt },
      { Name: SES_CORRELATION_TAG_NAMES.endpointId, Value: IDS.endpoint },
      { Name: SES_CORRELATION_TAG_NAMES.rosterSnapshotId, Value: IDS.roster },
      { Name: SES_CORRELATION_TAG_NAMES.recipientId, Value: IDS.recipient },
      { Name: SES_CORRELATION_TAG_NAMES.templateMode, Value: 'real' },
      { Name: SES_CORRELATION_TAG_NAMES.eventKind, Value: 'incident' },
    ]);
    expect(app.ledger.completeCalls).toBe(1);
  });

  test('durable completion replays the provider result without a second SES send', async () => {
    const app = adapter();
    const request = { workItem: workItem(), idempotencyKey: IDS.attempt };

    const first = await app.adapter.send(request);
    const replay = await app.adapter.send(request);

    expect(replay).toEqual(first);
    expect(app.client.inputs).toHaveLength(1);
    expect(app.ledger.claimCalls).toBe(2);
    expect(app.ledger.completeCalls).toBe(1);
  });

  test('an ambiguous SES exception becomes unknown and is never blindly resent', async () => {
    const client = new CapturingSesClient(() =>
      Promise.reject(new Error('Synthetic connection ended after request.')),
    );
    const app = adapter(client);
    const request = { workItem: workItem(), idempotencyKey: IDS.attempt };

    await expect(app.adapter.send(request)).resolves.toEqual(
      expect.objectContaining({
        state: 'unknown',
        provider: SES_V2_PROVIDER,
        reasonCode: 'SES_SEND_OUTCOME_UNKNOWN',
      }),
    );
    await expect(app.adapter.send(request)).resolves.toEqual(
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'SES_SEND_OUTCOME_UNKNOWN',
      }),
    );
    expect(client.inputs).toHaveLength(1);
  });

  test('a proven safe SES rejection releases its fence for bounded retry', async () => {
    let calls = 0;
    const client = new CapturingSesClient(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(
            new ProviderDispatchError(
              'SES_PROVIDER_THROTTLED',
              'safe-to-retry',
            ),
          )
        : Promise.resolve({ MessageId: '01000191f0a1-retry-000000' });
    });
    const app = adapter(client);
    const request = { workItem: workItem(), idempotencyKey: IDS.attempt };

    await expect(app.adapter.send(request)).rejects.toEqual(
      expect.objectContaining({
        code: 'SES_PROVIDER_THROTTLED',
        disposition: 'safe-to-retry',
      }),
    );
    expect(app.ledger.releaseCalls).toBe(1);
    expect(app.ledger.entries.size).toBe(0);

    await expect(app.adapter.send(request)).resolves.toEqual(
      expect.objectContaining({
        state: 'provider-accepted',
        providerReference: '01000191f0a1-retry-000000',
      }),
    );
    expect(client.inputs).toHaveLength(2);
  });

  test.each(['synchronously', 'asynchronously'] as const)(
    'a ledger that fails release %s cannot replace proven retry truth',
    async (failureMode) => {
      const client = new CapturingSesClient(() =>
        Promise.reject(
          new ProviderDispatchError('SES_PROVIDER_THROTTLED', 'safe-to-retry'),
        ),
      );
      const ledger = new MemoryDurableLedger();
      ledger.failRelease = failureMode;
      const app = adapter(client, ledger);

      await expect(
        app.adapter.send({
          workItem: workItem(),
          idempotencyKey: IDS.attempt,
        }),
      ).rejects.toEqual(
        expect.objectContaining({
          code: 'SES_PROVIDER_THROTTLED',
          disposition: 'safe-to-retry',
        }),
      );
      expect(ledger.releaseCalls).toBe(1);
      expect(ledger.entries.size).toBe(1);
      expect(client.inputs).toHaveLength(1);
    },
  );

  test('a proven terminal SES rejection is retained as failed truth', async () => {
    const diagnosticDigest = 'a'.repeat(64);
    const client = new CapturingSesClient(() =>
      Promise.reject(
        new ProviderDispatchError(
          'SES_RECIPIENT_REJECTED',
          'terminal-failure',
          diagnosticDigest,
        ),
      ),
    );
    const app = adapter(client);
    const request = { workItem: workItem(), idempotencyKey: IDS.attempt };

    await expect(app.adapter.send(request)).resolves.toEqual({
      state: 'failed',
      provider: SES_V2_PROVIDER,
      providerReference: null,
      proof: null,
      reasonCode: 'SES_RECIPIENT_REJECTED',
      diagnosticDigest,
    });
    await expect(app.adapter.send(request)).resolves.toEqual(
      expect.objectContaining({
        state: 'failed',
        reasonCode: 'SES_RECIPIENT_REJECTED',
      }),
    );
    expect(client.inputs).toHaveLength(1);
    expect(app.ledger.completeCalls).toBe(1);
  });

  test('a malformed success response becomes unknown rather than provider-accepted', async () => {
    const client = new CapturingSesClient(() => Promise.resolve({}));
    const app = adapter(client);

    await expect(
      app.adapter.send({
        workItem: workItem(),
        idempotencyKey: IDS.attempt,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'SES_RESPONSE_INVALID',
      }),
    );
  });

  test('a lost ledger completion keeps the acquired no-resend fence', async () => {
    const ledger = new MemoryDurableLedger();
    ledger.failComplete = true;
    const app = adapter(new CapturingSesClient(), ledger);
    const request = { workItem: workItem(), idempotencyKey: IDS.attempt };

    await expect(app.adapter.send(request)).resolves.toEqual(
      expect.objectContaining({ state: 'provider-accepted' }),
    );
    await expect(app.adapter.send(request)).resolves.toEqual(
      expect.objectContaining({
        state: 'unknown',
        reasonCode: 'SES_SEND_ALREADY_CLAIMED',
      }),
    );
    expect(app.client.inputs).toHaveLength(1);
  });

  test('ledger admission failure is safely retryable because SES was not called', async () => {
    const ledger = new MemoryDurableLedger();
    ledger.failClaim = true;
    const app = adapter(new CapturingSesClient(), ledger);

    await expect(
      app.adapter.send({
        workItem: workItem(),
        idempotencyKey: IDS.attempt,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'SES_SEND_LEDGER_UNAVAILABLE',
        disposition: 'safe-to-retry',
      }),
    );
    expect(app.client.inputs).toHaveLength(0);
  });

  test('ledger fingerprint conflict is terminal and never reaches SES', async () => {
    const client = new CapturingSesClient();
    const ledger: DurableSesSendLedger = {
      durability: 'durable',
      claim: () => Promise.resolve({ kind: 'conflict' }),
      complete: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
    const emailAdapter = new SesV2EmailAdapter({
      client,
      sendLedger: ledger,
      fromEmailAddress: SES_FROM_EMAIL_ADDRESS,
      truthLabel: 'live-verified',
    });

    await expect(
      emailAdapter.send({
        workItem: workItem(),
        idempotencyKey: IDS.attempt,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'SES_SEND_LEDGER_CONFLICT',
        disposition: 'terminal-failure',
      }),
    );
    expect(client.inputs).toHaveLength(0);
  });

  test('construction fails closed without live truth, durable ledger, or safe sender', () => {
    const client = new CapturingSesClient();
    const ledger = new MemoryDurableLedger();
    const base = {
      client,
      sendLedger: ledger,
      fromEmailAddress: SES_FROM_EMAIL_ADDRESS,
      truthLabel: 'live-verified' as const,
    };

    expect(
      () =>
        new SesV2EmailAdapter({
          ...base,
          truthLabel: 'mocked',
        }),
    ).toThrow(SesV2EmailAdapterError);
    expect(
      () =>
        new SesV2EmailAdapter({
          ...base,
          sendLedger: {
            ...ledger,
            durability: 'process-local',
          } as unknown as DurableSesSendLedger,
        }),
    ).toThrow(SesV2EmailAdapterError);
    expect(
      () =>
        new SesV2EmailAdapter({
          ...base,
          fromEmailAddress: 'notifications@example.invalid',
        }),
    ).toThrow(SesV2EmailAdapterError);
    expect(
      () =>
        new SesV2EmailAdapter({
          ...base,
          fromEmailAddress: 'other-sender@psd401.net',
        }),
    ).toThrow(SesV2EmailAdapterError);
  });

  test('direct invocation rejects mocked work before ledger or provider I/O', async () => {
    const app = adapter();

    await expect(
      app.adapter.send({
        workItem: workItem(false),
        idempotencyKey: IDS.attempt,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'SES_WORK_ITEM_REJECTED',
        disposition: 'terminal-failure',
      }),
    );
    expect(app.ledger.claimCalls).toBe(0);
    expect(app.client.inputs).toHaveLength(0);
  });
});
