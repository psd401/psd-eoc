import { describe, expect, test } from 'bun:test';
import {
  AudienceConfigSchema,
  DispatchBatchSchema,
  RosterSnapshotSchema,
  SmsMessageTemplateSchema,
  type DispatchBatch,
} from '@psd-eoc/contracts';

import {
  SmsPolicyError,
  renderSmsMessage,
  resolveSmsEndpoints,
  validateRenderedSmsMessage,
  type SmsEndpointPolicyQuery,
  type SmsEndpointPolicyStore,
} from '../../packages/server/lib/notify/sms-policy';

const TIMESTAMP = '2026-08-11T18:00:00.000Z';
const IDS = Object.freeze({
  facility: '00000000-0000-4000-8000-000000000001',
  audience: '00000000-0000-4000-8000-000000000002',
  group: '00000000-0000-4000-8000-000000000003',
  configuration: '00000000-0000-4000-8000-000000000004',
  roster: '00000000-0000-4000-8000-000000000005',
  recipient: '00000000-0000-4000-8000-000000000006',
  endpoint: '00000000-0000-4000-8000-000000000007',
  request: '00000000-0000-4000-8000-000000000008',
  preview: '00000000-0000-4000-8000-000000000009',
  eventType: '00000000-0000-4000-8000-000000000010',
  event: '00000000-0000-4000-8000-000000000011',
  intent: '00000000-0000-4000-8000-000000000012',
  batch: '00000000-0000-4000-8000-000000000013',
});

const GROUP = Object.freeze({
  id: IDS.group,
  kind: 'synthetic' as const,
  purpose: 'building' as const,
  facilityId: IDS.facility,
});

const audienceConfig = AudienceConfigSchema.parse({
  id: IDS.audience,
  facilityId: IDS.facility,
  version: 1,
  targets: [{ kind: 'building', facilityId: IDS.facility }],
  createdAt: TIMESTAMP,
});

const rosterSnapshot = RosterSnapshotSchema.parse({
  id: IDS.roster,
  version: 1,
  population: 'synthetic',
  complete: true,
  sourceConfiguration: { id: IDS.configuration, version: 1 },
  facilityIds: [IDS.facility],
  expectedSourceGroupRefs: [GROUP],
  sourceGroupRefs: [GROUP],
  recipients: [
    {
      id: IDS.recipient,
      population: 'synthetic',
      googleSubject: null,
      displayName: 'Synthetic SMS Staff',
      groupSourceRefs: [GROUP],
      endpoints: [
        {
          id: IDS.endpoint,
          channel: 'sms',
          status: 'active',
          capturedAt: TIMESTAMP,
          phoneNumber: '+12025550123',
        },
      ],
    },
  ],
  syncStartedAt: TIMESTAMP,
  capturedAt: TIMESTAMP,
});

function batch(): DispatchBatch {
  return DispatchBatchSchema.parse({
    id: IDS.batch,
    intentId: IDS.intent,
    eventId: IDS.event,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: { id: IDS.eventType, templateMode: 'drill' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    audienceConfig: { id: IDS.audience, version: 1 },
    requestId: IDS.request,
    authorization: {
      kind: 'synthetic-training',
      activationPreviewId: IDS.preview,
      consequenceDigest: 'a'.repeat(64),
      requestId: IDS.request,
    },
    channel: 'sms',
    renderedMessage: {
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'sms',
      body: '[DRILL] TRAINING ONLY - ACTIVATION: Synthetic test. [DRILL]',
    },
    integrationStatus: {
      integrationId: 'aws-eum-sms',
      label: 'mocked',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt: TIMESTAMP,
    },
    sequence: 3,
    endpointCount: 1,
    createdAt: TIMESTAMP,
  });
}

function audienceInput() {
  return {
    audienceConfig,
    neighborhoodVersions: [],
    rosterSnapshot,
  };
}

class PolicyStore implements SmsEndpointPolicyStore {
  public constructor(
    private readonly status: 'active' | 'disabled' | 'invalid' = 'active',
    private readonly optedOut = false,
  ) {}

  public loadEndpointPolicy(query: SmsEndpointPolicyQuery): Promise<unknown> {
    return Promise.resolve(
      query.candidates.map((candidate) => ({
        ...candidate,
        status: this.status,
        optedOut: this.optedOut,
      })),
    );
  }
}

function expectPolicyError(
  operation: () => unknown,
  code: SmsPolicyError['code'],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SmsPolicyError);
    expect((error as SmsPolicyError).code).toBe(code);
    return;
  }
  throw new Error(`Expected SMS policy to fail with ${code}.`);
}

describe('SMS rendering policy', () => {
  test('renders an unmistakable one-part drill SMS', () => {
    const template = SmsMessageTemplateSchema.parse({
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'sms',
      body: '{{eventType}} at {{site}}. Follow staff instructions.',
    });

    const rendered = renderSmsMessage({
      eventKind: 'test',
      template,
      variables: {
        site: 'Synthetic School',
        eventType: 'Synthetic drill',
        startTime: '2026-08-11T18:00:00.000Z',
        initiator: 'Synthetic Operator',
      },
    });

    expect(rendered.body).toStartWith('[DRILL] TRAINING ONLY - ACTIVATION:');
    expect(rendered.body).toEndWith('[DRILL]');
    expect(rendered.body).not.toContain('[INCIDENT]');
  });

  test('rejects a contract-valid SMS that would split into multiple parts', () => {
    expectPolicyError(
      () =>
        validateRenderedSmsMessage({
          eventKind: 'test',
          templateMode: 'drill',
          purpose: 'activation',
          classificationMarker: 'DRILL',
          channel: 'sms',
          body: `[DRILL] ${'A'.repeat(180)}`,
        }),
      'SMS_LENGTH_UNSAFE',
    );
  });
});

describe('SMS endpoint policy', () => {
  test('resolves only active endpoints in the exact pinned audience', async () => {
    await expect(
      resolveSmsEndpoints(
        { batch: batch(), audience: audienceInput() },
        new PolicyStore(),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        rosterSnapshotId: IDS.roster,
        recipientId: IDS.recipient,
        endpoint: expect.objectContaining({ id: IDS.endpoint }),
      }),
    ]);
  });

  test('honors retained opt-outs before exposing a destination', async () => {
    await expect(
      resolveSmsEndpoints(
        { batch: batch(), audience: audienceInput() },
        new PolicyStore('active', true),
      ),
    ).resolves.toEqual([]);
  });

  test('honors append-only disabled endpoint evidence', async () => {
    await expect(
      resolveSmsEndpoints(
        { batch: batch(), audience: audienceInput() },
        new PolicyStore('disabled'),
      ),
    ).resolves.toEqual([]);
  });
});
