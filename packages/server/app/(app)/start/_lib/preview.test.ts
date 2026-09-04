import { describe, expect, test } from 'bun:test';
import {
  type ActivationSelection,
  type ActivationThreat,
  type Actor,
  type ChannelConfiguration,
  type EventTypeVersion,
  type Facility,
  type MessageTemplateCatalog,
  type NotificationPurpose,
  type RosterGroupSourceRef,
  type RosterPopulation,
  type RosterSnapshot,
  type TemplateMode,
} from '@psd-eoc/contracts';

import {
  ActivationPreviewBuildError,
  buildActivationPreview,
  renderedResponseLabel,
  renderedThreatLabel,
  type ActivationPreviewEvidence,
} from '../../../../lib/capabilities/start-preview';
import { digestCapabilityValue } from '../../../../lib/capabilities/engine';
import { formatNotificationStartTime } from '../../../../lib/notify/render';

const CREATED_AT = new Date('2026-08-10T17:00:00.000Z');
const CREATED_AT_ISO = CREATED_AT.toISOString();

const IDS = Object.freeze({
  facility: '00000000-0000-4000-8000-000000000001',
  audience: '00000000-0000-4000-8000-000000000002',
  group: '00000000-0000-4000-8000-000000000003',
  rosterConfiguration: '00000000-0000-4000-8000-000000000004',
  roster: '00000000-0000-4000-8000-000000000005',
  recipientEmail: '00000000-0000-4000-8000-000000000006',
  recipientPush: '00000000-0000-4000-8000-000000000007',
  emailEndpoint: '00000000-0000-4000-8000-000000000008',
  pushEndpoint: '00000000-0000-4000-8000-000000000009',
  eventType: '00000000-0000-4000-8000-000000000010',
  eventTypeVersion: '00000000-0000-4000-8000-000000000011',
  preview: '00000000-0000-4000-8000-000000000012',
  user: '00000000-0000-4000-8000-000000000013',
  session: '00000000-0000-4000-8000-000000000014',
  verifier: '00000000-0000-4000-8000-000000000015',
  activeEventA: '00000000-0000-4000-8000-000000000016',
  activeEventB: '00000000-0000-4000-8000-000000000017',
  targetSet: '00000000-0000-4000-8000-000000000018',
  ordinaryEndpoint: '00000000-0000-4000-8000-000000000019',
  threat: '00000000-0000-4000-8000-000000000020',
});

const THREAT = Object.freeze({
  id: IDS.threat,
  name: 'Synthetic wildlife',
  detail: null,
}) satisfies ActivationThreat;

const ACTOR = Object.freeze({
  kind: 'human',
  userId: IDS.user,
  sessionId: IDS.session,
}) satisfies Actor;

const FACILITY = Object.freeze({
  id: IDS.facility,
  code: 'HARBOR',
  name: 'Harbor Ridge High School',
  active: true,
  createdAt: CREATED_AT_ISO,
}) satisfies Facility;

function groupSource(population: RosterPopulation): RosterGroupSourceRef {
  return Object.freeze({
    id: IDS.group,
    kind: population === 'staff' ? 'google-group' : 'synthetic',
    purpose: 'building',
    facilityId: IDS.facility,
  });
}

function roster(population: RosterPopulation): RosterSnapshot {
  const source = groupSource(population);
  return Object.freeze({
    id: IDS.roster,
    version: 1,
    population,
    complete: true,
    sourceConfiguration: {
      id: IDS.rosterConfiguration,
      version: 1,
    },
    facilityIds: Object.freeze([IDS.facility]),
    expectedSourceGroupRefs: Object.freeze([source]),
    sourceGroupRefs: Object.freeze([source]),
    recipients: Object.freeze([
      Object.freeze({
        id: IDS.recipientEmail,
        population,
        googleSubject:
          population === 'staff' ? 'synthetic-google-subject-email' : null,
        displayName: 'Email Recipient',
        groupSourceRefs: Object.freeze([source]),
        endpoints: Object.freeze([
          Object.freeze({
            id: IDS.emailEndpoint,
            channel: 'email',
            status: 'active',
            capturedAt: CREATED_AT_ISO,
            email: 'recipient@example.invalid',
          }),
        ]),
      }),
      Object.freeze({
        id: IDS.recipientPush,
        population,
        googleSubject:
          population === 'staff' ? 'synthetic-google-subject-push' : null,
        displayName: 'Push Recipient',
        groupSourceRefs: Object.freeze([source]),
        endpoints: Object.freeze([
          Object.freeze({
            id: IDS.pushEndpoint,
            channel: 'push',
            status: 'active',
            capturedAt: CREATED_AT_ISO,
            platform: 'ios',
            provider: 'expo',
            serviceEnvironment: 'production',
            token: 'synthetic-unroutable:preview-test',
          }),
        ]),
      }),
    ]),
    syncStartedAt: CREATED_AT_ISO,
    capturedAt: CREATED_AT_ISO,
  });
}

function templates(templateMode: TemplateMode): MessageTemplateCatalog {
  const classificationMarker =
    templateMode === 'real' ? ('INCIDENT' as const) : ('DRILL' as const);
  const set = (purpose: NotificationPurpose) =>
    Object.freeze({
      templateMode,
      purpose,
      push: Object.freeze({
        templateMode,
        purpose,
        classificationMarker,
        channel: 'push' as const,
        title: '{{eventType}} at {{site}} — {{startTime}}',
        body: 'Threat: {{threat}}. Started {{startTime}} by {{initiator}}.',
      }),
      email: Object.freeze({
        templateMode,
        purpose,
        classificationMarker,
        channel: 'email' as const,
        subject: '{{eventType}} at {{site}} — {{startTime}}',
        textBody: 'Threat: {{threat}}. Started {{startTime}} by {{initiator}}.',
      }),
      sms: Object.freeze({
        templateMode,
        purpose,
        classificationMarker,
        channel: 'sms' as const,
        body: '{{eventType}} at {{site}} once {{startTime}}.',
      }),
    });
  return Object.freeze({
    activation: set('activation'),
    'all-clear': set('all-clear'),
    reactivation: set('reactivation'),
  });
}

function eventTypeVersion(templateMode: TemplateMode): EventTypeVersion {
  return Object.freeze({
    id: IDS.eventTypeVersion,
    eventTypeId: IDS.eventType,
    version: 1,
    templateMode,
    name: templateMode === 'real' ? 'Lockdown' : 'Lockdown Drill',
    description: null,
    enabled: true,
    templates: templates(templateMode),
    supersedesVersionId: null,
    createdBy: { kind: 'system' as const, serviceId: 'database-seed' },
    publicationAuthorization: {
      kind: 'repository-seed' as const,
      approvalReference: 'reviewed-test-fixture',
    },
    createdAt: CREATED_AT_ISO,
  });
}

function channelConfigurations(
  population: RosterPopulation,
): readonly ChannelConfiguration[] {
  const label = population === 'staff' ? 'live-verified' : 'mocked';
  const status = (integrationId: string) =>
    Object.freeze({
      integrationId,
      label,
      verifiedAt: population === 'staff' ? CREATED_AT_ISO : null,
      verifiedByUserId: population === 'staff' ? IDS.verifier : null,
      authorizationReference:
        population === 'staff' ? 'approved-synthetic-test-evidence' : null,
      reasonCode: null,
      observedAt: CREATED_AT_ISO,
    });
  return Object.freeze([
    Object.freeze({
      integrationId: 'mobile-push',
      enabled: true,
      status: status('mobile-push'),
      changedAt: CREATED_AT_ISO,
    }),
    Object.freeze({
      integrationId: 'ses-email',
      enabled: true,
      status: status('ses-email'),
      changedAt: CREATED_AT_ISO,
    }),
    Object.freeze({
      integrationId: 'aws-eum-sms',
      enabled: false,
      status: status('aws-eum-sms'),
      changedAt: CREATED_AT_ISO,
    }),
  ]);
}

function evidence(
  templateMode: TemplateMode,
  population: RosterPopulation,
): ActivationPreviewEvidence {
  const kind =
    templateMode === 'real' ? ('incident' as const) : ('drill' as const);
  const selection: ActivationSelection = {
    facilityId: IDS.facility,
    kind,
    templateMode,
    eventTypeVersion: { id: IDS.eventTypeVersion, templateMode },
    rosterPopulation: population,
  };
  return {
    id: IDS.preview,
    selection,
    threat: THREAT,
    responseDetail: null,
    facility: FACILITY,
    eventTypeVersion: eventTypeVersion(templateMode),
    rosterSnapshot: roster(population),
    channelConfigurations: channelConfigurations(population),
    activeEventIds: [IDS.activeEventB, IDS.activeEventA],
    initiator: ACTOR,
    initiatorDisplayName: 'Taylor Morgan',
    createdAt: CREATED_AT,
  };
}

describe('activation consequence preview threat pinning', () => {
  test('pins the threat and both descriptions inside the signed consequence', () => {
    const base = buildActivationPreview(evidence('real', 'staff'));
    const described = buildActivationPreview({
      ...evidence('real', 'staff'),
      threat: { ...THREAT, detail: 'Gas smell near the gym' },
      responseDetail: 'Move everyone to the field',
    });

    expect(base.threat).toEqual(THREAT);
    expect(base.responseDetail).toBeNull();
    expect(described.threat?.detail).toBe('Gas smell near the gym');
    expect(described.responseDetail).toBe('Move everyone to the field');
    // A preview for different words is a different consequence: the digest a
    // human signs cannot be reused for another threat or description.
    expect(described.consequenceDigest).not.toBe(base.consequenceDigest);
    expect(
      buildActivationPreview({
        ...evidence('real', 'staff'),
        threat: { ...THREAT, id: IDS.activeEventA },
      }).consequenceDigest,
    ).not.toBe(base.consequenceDigest);
  });

  test('refuses an operator activation without a threat', () => {
    expect(() =>
      buildActivationPreview({
        ...evidence('drill', 'synthetic'),
        threat: null,
      }),
    ).toThrow(
      expect.objectContaining({
        name: 'ActivationPreviewBuildError',
        code: 'THREAT_UNAVAILABLE',
      }),
    );
  });

  test('refuses a description the message contract would refuse', () => {
    for (const detail of ['', '   ', 'a'.repeat(201), 'bad​word']) {
      expect(() =>
        buildActivationPreview({
          ...evidence('real', 'staff'),
          threat: { ...THREAT, detail },
        }),
      ).toThrow();
      expect(() =>
        buildActivationPreview({
          ...evidence('real', 'staff'),
          responseDetail: detail,
        }),
      ).toThrow();
    }
  });

  test('keeps a description that looks like a token as plain words', () => {
    const preview = buildActivationPreview({
      ...evidence('real', 'staff'),
      threat: { ...THREAT, detail: '{{initiator}} at {{site}}' },
    });
    expect(preview.threat?.detail).toBe('{{initiator}} at {{site}}');
    // The renderer substitutes once, so an operator's words are shown, never
    // interpreted: a description cannot reach for another variable's value.
    const push = preview.channels.find(({ channel }) => channel === 'push');
    const pushBody =
      push?.renderedMessage.channel === 'push' ? push.renderedMessage.body : '';
    expect(pushBody).toContain(
      'Synthetic wildlife — {{initiator}} at {{site}}',
    );
    expect(pushBody).not.toContain('Harbor Ridge High School');
  });

  test('renders the threat and both descriptions into the staff wording', () => {
    const preview = buildActivationPreview({
      ...evidence('real', 'staff'),
      threat: { ...THREAT, detail: 'Gas smell near the gym' },
      responseDetail: 'Hold in classrooms',
    });
    const push = preview.channels.find(({ channel }) => channel === 'push');
    const email = preview.channels.find(({ channel }) => channel === 'email');
    const pushBody =
      push?.renderedMessage.channel === 'push' ? push.renderedMessage.body : '';
    const emailSubject =
      email?.renderedMessage.channel === 'email'
        ? email.renderedMessage.subject
        : '';
    expect(pushBody).toContain('Synthetic wildlife — Gas smell near the gym');
    expect(pushBody).not.toContain('{{threat}}');
    // The response name carries the operator's words wherever the wording
    // already names the response.
    expect(emailSubject).toContain('Hold in classrooms');
  });

  test('composes the labels staff read for a threat and a response', () => {
    // A delivery test and a pre-catalog event carry no threat, so the copy
    // says so rather than leaving the sentence dangling.
    expect(renderedThreatLabel(null)).toBe('Not recorded');
    expect(renderedThreatLabel(THREAT)).toBe('Synthetic wildlife');
    expect(renderedThreatLabel({ ...THREAT, detail: 'Gas smell' })).toBe(
      'Synthetic wildlife — Gas smell',
    );
    expect(renderedResponseLabel('Lockdown', null)).toBe('Lockdown');
    expect(renderedResponseLabel('Other', 'Hold in classrooms')).toBe(
      'Other — Hold in classrooms',
    );
  });
});

describe('activation consequence preview', () => {
  test('pins a synthetic drill to the resolved roster counts and drill wording', () => {
    const preview = buildActivationPreview(evidence('drill', 'synthetic'));

    expect(preview.kind).toBe('drill');
    expect(preview.templateMode).toBe('drill');
    expect(preview.rosterPopulation).toBe('synthetic');
    expect(preview.rosterSnapshotId).toBe(IDS.roster);
    expect(preview.recipientCount).toBe(2);
    expect(
      preview.channels.map(({ channel, endpointCount }) => [
        channel,
        endpointCount,
      ]),
    ).toEqual([
      ['push', 1],
      ['email', 1],
    ]);
    expect(
      preview.channels.every(
        ({ renderedMessage }) =>
          renderedMessage.classificationMarker === 'DRILL' &&
          renderedMessage.templateMode === 'drill' &&
          renderedMessage.eventKind === 'drill',
      ),
    ).toBe(true);
    expect(preview.sendReadiness).toBe('ready');
    expect(preview.blockingReasonCodes).toEqual([]);
    expect(preview.activeEventIds).toEqual([
      IDS.activeEventA,
      IDS.activeEventB,
    ]);
  });

  test('keeps real incident previews on staff and live-verified wording', () => {
    const preview = buildActivationPreview(evidence('real', 'staff'));

    expect(preview.kind).toBe('incident');
    expect(preview.templateMode).toBe('real');
    expect(preview.rosterPopulation).toBe('staff');
    expect(preview.sendReadiness).toBe('ready');
    expect(
      preview.channels.every(
        ({ integrationStatus, renderedMessage }) =>
          integrationStatus.label === 'live-verified' &&
          renderedMessage.classificationMarker === 'INCIDENT' &&
          renderedMessage.templateMode === 'real' &&
          renderedMessage.eventKind === 'incident',
      ),
    ).toBe(true);
  });

  test('narrows a live delivery-test consequence to exact approved refs', () => {
    const base = evidence('drill', 'staff');
    const snapshot = roster('staff');
    const recipients = snapshot.recipients.map((recipient) =>
      recipient.id === IDS.recipientPush
        ? {
            ...recipient,
            endpoints: [
              ...recipient.endpoints,
              {
                id: IDS.ordinaryEndpoint,
                channel: 'email' as const,
                status: 'active' as const,
                capturedAt: CREATED_AT_ISO,
                email: 'ordinary-staff@example.invalid',
              },
            ],
          }
        : recipient,
    );
    const endpointReferenceDigest = 'a'.repeat(64);
    const preview = buildActivationPreview({
      ...base,
      rosterSnapshot: { ...snapshot, recipients },
      deliveryTest: {
        purpose: 'monthly-live-delivery-test',
        targetSet: { id: IDS.targetSet, version: 1 },
        endpointReferenceDigest,
      },
      deliveryTestEndpointReferences: [
        {
          recipientId: IDS.recipientEmail,
          endpointId: IDS.emailEndpoint,
          channel: 'email',
        },
        {
          recipientId: IDS.recipientPush,
          endpointId: IDS.pushEndpoint,
          channel: 'push',
        },
      ],
    });

    expect(preview.recipientCount).toBe(2);
    expect(
      preview.channels.map(({ channel, endpointCount }) => [
        channel,
        endpointCount,
      ]),
    ).toEqual([
      ['push', 1],
      ['email', 1],
    ]);
    expect(JSON.stringify(preview)).not.toContain(IDS.ordinaryEndpoint);
    expect(preview.deliveryTest?.endpointReferenceDigest).toBe(
      endpointReferenceDigest,
    );
  });

  test('builds one exact controlled DRILL email and signs only that consequence', () => {
    const base = evidence('drill', 'staff');
    const endpointReferenceDigest = 'b'.repeat(64);
    const preview = buildActivationPreview({
      ...base,
      deliveryTest: {
        purpose: 'monthly-live-delivery-test',
        targetSet: { id: IDS.targetSet, version: 1 },
        endpointReferenceDigest,
      },
      deliveryTestEndpointReferences: [
        {
          recipientId: IDS.recipientEmail,
          endpointId: IDS.emailEndpoint,
          channel: 'email',
        },
      ],
    });

    expect(preview.recipientCount).toBe(1);
    expect(
      preview.channels.map(({ channel, endpointCount }) => [
        channel,
        endpointCount,
      ]),
    ).toEqual([['email', 1]]);
    expect(preview.channels[0]?.renderedMessage).toMatchObject({
      channel: 'email',
      classificationMarker: 'DRILL',
      eventKind: 'drill',
      templateMode: 'drill',
    });
    expect(JSON.stringify(preview)).not.toContain('expo-push');
    expect(preview.sendReadiness).toBe('ready');
    expect(preview.blockingReasonCodes).toEqual([]);
    const { id: previewId, consequenceDigest, ...consequence } = preview;
    expect(previewId).toBe(IDS.preview);
    expect(consequenceDigest).toBe(
      digestCapabilityValue({
        capabilityId: 'start-event',
        consequence,
      }),
    );
  });

  test('blocks a controlled email canary on email truth without inventing push requirements', () => {
    const base = evidence('drill', 'staff');
    const preview = buildActivationPreview({
      ...base,
      deliveryTest: {
        purpose: 'monthly-live-delivery-test',
        targetSet: { id: IDS.targetSet, version: 1 },
        endpointReferenceDigest: 'c'.repeat(64),
      },
      deliveryTestEndpointReferences: [
        {
          recipientId: IDS.recipientEmail,
          endpointId: IDS.emailEndpoint,
          channel: 'email',
        },
      ],
      channelConfigurations: channelConfigurations('synthetic'),
    });

    expect(preview.channels.map(({ channel }) => channel)).toEqual(['email']);
    expect(preview.sendReadiness).toBe('blocked');
    expect(preview.blockingReasonCodes).toEqual(['EMAIL_NOT_LIVE_VERIFIED']);
  });

  test('builds one exact controlled DRILL push without requiring email', () => {
    const base = evidence('drill', 'staff');
    const preview = buildActivationPreview({
      ...base,
      deliveryTest: {
        purpose: 'monthly-live-delivery-test',
        targetSet: { id: IDS.targetSet, version: 1 },
        endpointReferenceDigest: 'd'.repeat(64),
      },
      deliveryTestEndpointReferences: [
        {
          recipientId: IDS.recipientPush,
          endpointId: IDS.pushEndpoint,
          channel: 'push',
        },
      ],
    });

    expect(preview.recipientCount).toBe(1);
    expect(
      preview.channels.map(({ channel, endpointCount }) => [
        channel,
        endpointCount,
      ]),
    ).toEqual([['push', 1]]);
    expect(preview.sendReadiness).toBe('ready');
    expect(preview.blockingReasonCodes).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain('ses-email');
  });

  test('keeps exact persisted activation copy independent of preview creation time', () => {
    const laterCreatedAt = new Date('2026-08-10T18:00:00.000Z');
    const first = buildActivationPreview(evidence('real', 'staff'));
    const later = buildActivationPreview({
      ...evidence('real', 'staff'),
      createdAt: laterCreatedAt,
    });

    expect(
      first.channels.map(({ renderedMessage }) => renderedMessage),
    ).toEqual(later.channels.map(({ renderedMessage }) => renderedMessage));
    const persistedChannels = JSON.stringify(first.channels);
    expect(persistedChannels).toContain('once confirmed');
    expect(persistedChannels).not.toContain(
      formatNotificationStartTime(CREATED_AT_ISO),
    );
    expect(persistedChannels).not.toContain(
      formatNotificationStartTime(laterCreatedAt.toISOString()),
    );
    expect(first.createdAt).toBe(CREATED_AT_ISO);
    expect(later.createdAt).toBe(laterCreatedAt.toISOString());
  });

  test('removes deferred start-time tokens from every exact channel field', () => {
    const base = evidence('real', 'staff');
    const preview = buildActivationPreview({
      ...base,
      channelConfigurations: base.channelConfigurations.map((configuration) =>
        configuration.integrationId === 'aws-eum-sms'
          ? { ...configuration, enabled: true }
          : configuration,
      ),
    });

    expect(preview.channels.map(({ channel }) => channel)).toEqual([
      'push',
      'email',
      'sms',
    ]);
    for (const { renderedMessage } of preview.channels) {
      const exactPayload = JSON.stringify(renderedMessage);
      expect(exactPayload).toContain('once confirmed');
      expect(exactPayload).not.toContain('{{startTime}}');
      expect(exactPayload).not.toContain(
        formatNotificationStartTime(CREATED_AT_ISO),
      );
    }
  });

  test('rejects an event-type version whose mode differs from the selection', () => {
    const mismatched = {
      ...evidence('drill', 'synthetic'),
      eventTypeVersion: eventTypeVersion('real'),
    };

    try {
      buildActivationPreview(mismatched);
      throw new Error('Expected mismatched classification to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ActivationPreviewBuildError);
      expect((error as ActivationPreviewBuildError).code).toBe(
        'EVENT_TYPE_UNAVAILABLE',
      );
    }
  });

  test('fails closed when synthetic flow is pointed at non-mocked channels', () => {
    const base = evidence('drill', 'synthetic');
    const preview = buildActivationPreview({
      ...base,
      channelConfigurations: channelConfigurations('staff'),
    });

    expect(preview.sendReadiness).toBe('blocked');
    expect(preview.blockingReasonCodes).toEqual([
      'EMAIL_NOT_MOCKED',
      'PUSH_NOT_MOCKED',
    ]);
  });

  test('blocks staff sends unless required channels are live-verified', () => {
    const base = evidence('real', 'staff');
    const preview = buildActivationPreview({
      ...base,
      channelConfigurations: channelConfigurations('synthetic'),
    });

    expect(preview.sendReadiness).toBe('blocked');
    expect(preview.blockingReasonCodes).toEqual([
      'EMAIL_NOT_LIVE_VERIFIED',
      'PUSH_NOT_LIVE_VERIFIED',
    ]);
  });
});
