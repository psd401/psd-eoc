import { describe, expect, test } from 'bun:test';
import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  DispatchBatchSchema,
  EmailEndpointSchema,
  type DeliveryEvidence,
} from '@psd-eoc/contracts';

import {
  parseDeliveryStateWriteRequest,
  type AttemptEvidenceWriter,
  type AttemptExecutionStore,
  type DeliveryStateWriteRequest,
} from '../shared';
import {
  IDS,
  TIMES,
  attemptFor,
  deliveryTestBatch,
} from '../shared/test-fixtures';
import {
  SES_EMAIL_QUEUE_ARN,
  SesEmailRuntime,
  SesEmailRuntimeError,
  type SesEmailRuntimeMode,
} from './runtime';
import {
  SES_V2_PROVIDER,
  type DurableSesSendLedger,
  type SesV2SendEmailInput,
} from './ses-adapter';

const INVOCATION = Object.freeze({
  requestId: '20000000-0000-4000-8000-000000000001',
  sourceArn: SES_EMAIL_QUEUE_ARN,
  authorization: Object.freeze({ kind: 'verified-sqs-source' }),
});

function emailWorkItem() {
  const source = deliveryTestBatch();
  const batch = DispatchBatchSchema.parse({
    ...source,
    channel: 'email',
    renderedMessage: {
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'email',
      subject: '[DRILL] Live-pilot email test',
      textBody: '[DRILL] LIVE PILOT TEST — NO EMERGENCY.',
    },
    integrationStatus: {
      ...source.integrationStatus,
      integrationId: 'ses-email',
    },
  });
  const attempt = ChannelAttemptSchema.parse({
    ...attemptFor(batch),
    channel: 'email',
  });
  const endpoint = EmailEndpointSchema.parse({
    id: IDS.endpoint,
    status: 'active',
    capturedAt: TIMES.created,
    channel: 'email',
    email: 'controlled-recipient@example.invalid',
  });
  return Object.freeze({ batch, attempt, endpoint });
}

class MemoryExecutionStore implements AttemptExecutionStore {
  public releases = 0;
  public completion: unknown = null;

  public lookup() {
    return Promise.resolve({ kind: 'missing' as const });
  }

  public claim() {
    return Promise.resolve({
      kind: 'acquired' as const,
      leaseToken: 'durable-execution-lease',
    });
  }

  public complete(request: { readonly completion: unknown }) {
    this.completion = request.completion;
    return Promise.resolve();
  }

  public release() {
    this.releases += 1;
    return Promise.resolve();
  }
}

class MemoryEvidenceWriter implements AttemptEvidenceWriter {
  public readonly evidence: DeliveryEvidence[] = [];

  public recordAttemptEvidence(value: DeliveryStateWriteRequest | unknown) {
    const request = parseDeliveryStateWriteRequest(value);
    const previous = this.evidence.at(-1) ?? null;
    const evidence = DeliveryEvidenceSchema.parse({
      id: `30000000-0000-4000-8000-${String(this.evidence.length + 1).padStart(12, '0')}`,
      subject: request.evidence.subject,
      sequence: this.evidence.length + 1,
      previousEvidenceId: previous?.id ?? null,
      state: request.evidence.state,
      recordedAt: TIMES.recorded,
      provider: request.evidence.provider,
      providerReference: request.evidence.providerReference,
      proof: request.evidence.proof,
      reasonCode: request.evidence.reasonCode,
      diagnosticDigest: request.evidence.diagnosticDigest,
    });
    this.evidence.push(evidence);
    return Promise.resolve(evidence);
  }
}

class MemorySesLedger implements DurableSesSendLedger {
  public readonly durability = 'durable' as const;
  public claims = 0;

  public claim() {
    this.claims += 1;
    return Promise.resolve({
      kind: 'acquired' as const,
      leaseToken: 'durable-ses-lease',
    });
  }

  public complete() {
    return Promise.resolve();
  }

  public release() {
    return Promise.resolve();
  }
}

function enabledMode(
  providerInputs: SesV2SendEmailInput[],
  authorizeProviderSend: () => boolean,
) {
  const executionStore = new MemoryExecutionStore();
  const evidenceWriter = new MemoryEvidenceWriter();
  const sendLedger = new MemorySesLedger();
  const mode: SesEmailRuntimeMode = {
    state: 'enabled',
    client: {
      sendEmail(input) {
        providerInputs.push(input);
        return Promise.resolve({ MessageId: 'live-pilot-provider-reference' });
      },
    },
    sendLedger,
    executionStore,
    evidenceWriter,
    authorizeLiveProvider: () => true,
    authorizeProviderSend,
  };
  return { mode, executionStore, evidenceWriter, sendLedger };
}

describe('SES email live-pilot runtime', () => {
  test('omitted mode stays dark after authenticating the exact queue invocation', async () => {
    let invocationChecks = 0;
    const runtime = new SesEmailRuntime({
      authorizeQueueInvocation: () => {
        invocationChecks += 1;
        return true;
      },
    });
    const unreadableWork = Object.create(null, {
      batch: {
        get() {
          throw new Error('Dark mode inspected provider work.');
        },
      },
    });

    await expect(
      runtime.processQueueAttempt(unreadableWork, INVOCATION),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'FEATURE_DISABLED',
      }),
    );
    expect(invocationChecks).toBe(1);
  });

  test('rejects an unverified queue invocation before reporting dark state', async () => {
    const runtime = new SesEmailRuntime({
      authorizeQueueInvocation: () => false,
    });

    await expect(
      runtime.processQueueAttempt(emailWorkItem(), INVOCATION),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INVOCATION_UNVERIFIED',
      }),
    );
  });

  test('rejects a neighboring queue before calling the injected authorizer', async () => {
    let invocationChecks = 0;
    const runtime = new SesEmailRuntime({
      authorizeQueueInvocation: () => {
        invocationChecks += 1;
        return true;
      },
    });

    await expect(
      runtime.processQueueAttempt(emailWorkItem(), {
        ...INVOCATION,
        sourceArn: 'arn:aws:sqs:us-west-2:338414773271:psd-eoc-email-neighbor',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'INVOCATION_UNVERIFIED',
      }),
    );
    expect(invocationChecks).toBe(0);
  });

  test('enabled composition requires every durable and final authorization gate', () => {
    const providerInputs: SesV2SendEmailInput[] = [];
    const valid = enabledMode(providerInputs, () => true).mode;

    expect(
      () =>
        new SesEmailRuntime({
          authorizeQueueInvocation: () => true,
          mode: {
            ...valid,
            authorizeProviderSend: undefined,
          } as unknown as SesEmailRuntimeMode,
        }),
    ).toThrow(SesEmailRuntimeError);
  });

  test('final send denial releases execution and never reaches SES or its ledger', async () => {
    const providerInputs: SesV2SendEmailInput[] = [];
    const composed = enabledMode(providerInputs, () => false);
    const runtime = new SesEmailRuntime({
      authorizeQueueInvocation: () => true,
      mode: composed.mode,
    });

    await expect(
      runtime.processQueueAttempt(emailWorkItem(), INVOCATION),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PROVIDER_SEND_DISABLED',
      }),
    );
    expect(composed.executionStore.releases).toBe(1);
    expect(composed.sendLedger.claims).toBe(0);
    expect(providerInputs).toHaveLength(0);
  });

  test('fully authorized composition preserves DRILL copy and records provider acceptance', async () => {
    const providerInputs: SesV2SendEmailInput[] = [];
    const composed = enabledMode(providerInputs, () => true);
    const runtime = new SesEmailRuntime({
      authorizeQueueInvocation: () => true,
      mode: composed.mode,
    });

    await expect(
      runtime.processQueueAttempt(emailWorkItem(), INVOCATION),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'completed',
        outcome: expect.objectContaining({
          state: 'provider-accepted',
          provider: SES_V2_PROVIDER,
        }),
      }),
    );
    expect(providerInputs).toHaveLength(1);
    expect(
      providerInputs[0]?.Content.Simple.Subject.Data.startsWith('[DRILL]'),
    ).toBe(true);
    expect(providerInputs[0]?.Content.Simple.Subject.Data).not.toContain(
      '[INCIDENT]',
    );
    expect(providerInputs[0]?.Destination.ToAddresses).toEqual([
      'controlled-recipient@example.invalid',
    ]);
    expect(composed.sendLedger.claims).toBe(1);
    expect(composed.evidenceWriter.evidence.map((item) => item.state)).toEqual([
      'attempted',
      'provider-accepted',
    ]);
  });
});
