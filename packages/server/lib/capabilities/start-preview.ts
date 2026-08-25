import {
  ACTIVATION_PREVIEW_MAX_AGE_SECONDS,
  ActivationPreviewSchema,
  ChannelConfigurationSchema,
  CreateActivationPreviewInputSchema,
  EventTypeVersionSchema,
  FacilitySchema,
  type ActivationPreview,
  type Actor,
  type ChannelConfiguration,
  type CreateActivationPreviewInput,
  type DeliveryTestNotificationMetadata,
  type DeliveryTestTargetEndpointRef,
  type EventTypeVersion,
  type Facility,
  type NotificationChannel,
  type RosterSnapshot,
} from '@psd-eoc/contracts';

import { renderTemplateSet } from '../notify/render';
import { resolveAudience } from '../roster/resolve';
import { digestCapabilityValue } from './engine';

const CHANNEL_INTEGRATION_IDS = Object.freeze({
  push: 'expo-push',
  email: 'ses-email',
  sms: 'aws-eum-sms',
} as const satisfies Readonly<Record<NotificationChannel, string>>);

const REQUIRED_CHANNELS = Object.freeze([
  'push',
  'email',
] as const satisfies readonly NotificationChannel[]);

const ALL_CHANNELS = Object.freeze([
  'push',
  'email',
  'sms',
] as const satisfies readonly NotificationChannel[]);

const CONFIRMATION_BOUND_START_TIME_COPY = 'once confirmed';

/** Safe, non-recipient-bearing reasons a preview cannot be assembled. */
export type ActivationPreviewBuildErrorCode =
  | 'AUDIENCE_UNAVAILABLE'
  | 'CHANNEL_CONFIGURATION_UNAVAILABLE'
  | 'EVENT_TYPE_UNAVAILABLE'
  | 'FACILITY_UNAVAILABLE'
  | 'INITIATOR_UNAVAILABLE'
  | 'PREVIEW_TIME_INVALID';

/** A bounded preview construction failure that never exposes roster content. */
export class ActivationPreviewBuildError extends Error {
  public constructor(public readonly code: ActivationPreviewBuildErrorCode) {
    super(
      {
        AUDIENCE_UNAVAILABLE:
          'The configured notification audience is unavailable.',
        CHANNEL_CONFIGURATION_UNAVAILABLE:
          'Notification channel configuration is unavailable.',
        EVENT_TYPE_UNAVAILABLE: 'The selected event type is unavailable.',
        FACILITY_UNAVAILABLE: 'The selected facility is unavailable.',
        INITIATOR_UNAVAILABLE: 'The initiating identity is unavailable.',
        PREVIEW_TIME_INVALID: 'The activation preview time is invalid.',
      }[code],
    );
    this.name = 'ActivationPreviewBuildError';
  }
}

/** Complete immutable evidence needed to build one activation preview. */
export interface ActivationPreviewEvidence {
  readonly id: string;
  readonly selection: CreateActivationPreviewInput;
  readonly facility: Facility;
  readonly eventTypeVersion: EventTypeVersion;
  readonly rosterSnapshot: RosterSnapshot;
  readonly channelConfigurations: readonly ChannelConfiguration[];
  readonly activeEventIds: readonly string[];
  readonly initiator: Actor;
  readonly initiatorDisplayName: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
  readonly deliveryTest?: DeliveryTestNotificationMetadata;
  /** Exact approved opaque refs which narrow the ordinary staff audience. */
  readonly deliveryTestEndpointReferences?: readonly Pick<
    DeliveryTestTargetEndpointRef,
    'recipientId' | 'endpointId' | 'channel'
  >[];
  /** Server-owned readiness facts which must be included in confirmation. */
  readonly additionalBlockingReasonCodes?: readonly string[];
}

function configurationByChannel(
  configurations: readonly ChannelConfiguration[],
): Readonly<Record<NotificationChannel, ChannelConfiguration | undefined>> {
  const byIntegration = new Map(
    configurations.map((configuration) => [
      configuration.integrationId,
      ChannelConfigurationSchema.parse(configuration),
    ]),
  );
  return Object.freeze({
    push: byIntegration.get(CHANNEL_INTEGRATION_IDS.push),
    email: byIntegration.get(CHANNEL_INTEGRATION_IDS.email),
    sms: byIntegration.get(CHANNEL_INTEGRATION_IDS.sms),
  });
}

function blockingCodeForTruth(
  channel: NotificationChannel,
  population: 'staff' | 'synthetic',
): string {
  return `${channel.toUpperCase()}_${
    population === 'staff' ? 'NOT_LIVE_VERIFIED' : 'NOT_MOCKED'
  }`;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function confirmationBoundActivationTemplates(
  templates: EventTypeVersion['templates']['activation'],
): EventTypeVersion['templates']['activation'] {
  const replaceStartTime = (text: string) =>
    text.replaceAll('{{startTime}}', CONFIRMATION_BOUND_START_TIME_COPY);
  return Object.freeze({
    ...templates,
    push: Object.freeze({
      ...templates.push,
      title: replaceStartTime(templates.push.title),
      body: replaceStartTime(templates.push.body),
    }),
    email: Object.freeze({
      ...templates.email,
      subject: replaceStartTime(templates.email.subject),
      textBody: replaceStartTime(templates.email.textBody),
    }),
    sms: Object.freeze({
      ...templates.sms,
      body: replaceStartTime(templates.sms.body),
    }),
  });
}

/**
 * Builds the exact consequence object a human reviews. All endpoint values
 * remain inside the resolver; only minimized counts leave this boundary.
 */
export function buildActivationPreview(
  evidenceValue: ActivationPreviewEvidence,
): ActivationPreview {
  const selection = CreateActivationPreviewInputSchema.parse(
    evidenceValue.selection,
  );
  const facility = FacilitySchema.parse(evidenceValue.facility);
  const eventTypeVersion = EventTypeVersionSchema.parse(
    evidenceValue.eventTypeVersion,
  );
  const createdAt = new Date(evidenceValue.createdAt);
  const expiresAt = new Date(
    evidenceValue.expiresAt?.getTime() ??
      createdAt.getTime() + ACTIVATION_PREVIEW_MAX_AGE_SECONDS * 1_000,
  );

  if (!facility.active || facility.id !== selection.facilityId) {
    throw new ActivationPreviewBuildError('FACILITY_UNAVAILABLE');
  }
  if (
    !eventTypeVersion.enabled ||
    eventTypeVersion.id !== selection.eventTypeVersion.id ||
    eventTypeVersion.templateMode !== selection.templateMode
  ) {
    throw new ActivationPreviewBuildError('EVENT_TYPE_UNAVAILABLE');
  }
  if (evidenceValue.rosterSnapshot.population !== selection.rosterPopulation) {
    throw new ActivationPreviewBuildError('AUDIENCE_UNAVAILABLE');
  }
  if (
    evidenceValue.initiator.kind === 'system' ||
    evidenceValue.initiatorDisplayName.trim().length === 0
  ) {
    throw new ActivationPreviewBuildError('INITIATOR_UNAVAILABLE');
  }
  if (
    !Number.isFinite(createdAt.getTime()) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() < createdAt.getTime() ||
    expiresAt.getTime() - createdAt.getTime() >
      ACTIVATION_PREVIEW_MAX_AGE_SECONDS * 1_000
  ) {
    throw new ActivationPreviewBuildError('PREVIEW_TIME_INVALID');
  }

  const resolvedAudience = resolveAudience({
    facilityId: facility.id,
    rosterSnapshot: evidenceValue.rosterSnapshot,
  });
  const approvedEndpointKeys =
    evidenceValue.deliveryTestEndpointReferences === undefined
      ? null
      : new Set(
          evidenceValue.deliveryTestEndpointReferences.map(
            (reference) =>
              `${reference.channel}:${reference.recipientId}:${reference.endpointId}`,
          ),
        );
  if (
    (evidenceValue.deliveryTest === undefined) !==
      (approvedEndpointKeys === null) ||
    (approvedEndpointKeys !== null &&
      approvedEndpointKeys.size !==
        evidenceValue.deliveryTestEndpointReferences?.length)
  ) {
    throw new ActivationPreviewBuildError('AUDIENCE_UNAVAILABLE');
  }
  const controlledEmailCanary =
    evidenceValue.deliveryTestEndpointReferences?.length === 1;
  if (
    controlledEmailCanary &&
    evidenceValue.deliveryTestEndpointReferences?.[0]?.channel !== 'email'
  ) {
    throw new ActivationPreviewBuildError('AUDIENCE_UNAVAILABLE');
  }
  const selectedRecipients = resolvedAudience.recipients.flatMap(
    (recipient) => {
      const endpoints = recipient.endpoints.filter(
        (endpoint) =>
          approvedEndpointKeys === null ||
          approvedEndpointKeys.has(
            `${endpoint.channel}:${recipient.recipientId}:${endpoint.id}`,
          ),
      );
      return endpoints.length === 0 ? [] : [{ ...recipient, endpoints }];
    },
  );
  if (
    approvedEndpointKeys !== null &&
    selectedRecipients.reduce(
      (count, recipient) => count + recipient.endpoints.length,
      0,
    ) !== approvedEndpointKeys.size
  ) {
    throw new ActivationPreviewBuildError('AUDIENCE_UNAVAILABLE');
  }
  const recipientCount = selectedRecipients.length;
  const endpointCounts: Record<NotificationChannel, number> = {
    push: 0,
    email: 0,
    sms: 0,
  };
  for (const recipient of selectedRecipients) {
    for (const endpoint of recipient.endpoints) {
      endpointCounts[endpoint.channel] += 1;
    }
  }

  const configurations = configurationByChannel(
    evidenceValue.channelConfigurations,
  );
  if (
    configurations.email === undefined ||
    (!controlledEmailCanary && configurations.push === undefined)
  ) {
    throw new ActivationPreviewBuildError('CHANNEL_CONFIGURATION_UNAVAILABLE');
  }

  const renderedMessages = renderTemplateSet({
    eventKind: selection.kind,
    // The exact preview is also the exact worker payload. A concrete event
    // time does not exist until the later explicit confirmation, so activation
    // copy is intentionally causal instead of backdating the event to preview
    // creation. The renderer still validates this required, now-unused value.
    templates: confirmationBoundActivationTemplates(
      eventTypeVersion.templates.activation,
    ),
    variables: {
      site: facility.name,
      eventType: eventTypeVersion.name,
      startTime: createdAt.toISOString(),
      initiator: evidenceValue.initiatorDisplayName,
    },
  });
  const renderedByChannel = new Map(
    renderedMessages.map((message) => [message.channel, message]),
  );
  const selectedChannels = controlledEmailCanary
    ? (['email'] as const)
    : ALL_CHANNELS.filter(
        (channel) => channel !== 'sms' || configurations.sms?.enabled === true,
      );
  const channels = selectedChannels.map((channel) => {
    const configuration = configurations[channel];
    const renderedMessage = renderedByChannel.get(channel);
    if (configuration === undefined || renderedMessage === undefined) {
      throw new ActivationPreviewBuildError(
        'CHANNEL_CONFIGURATION_UNAVAILABLE',
      );
    }
    return Object.freeze({
      channel,
      endpointCount: endpointCounts[channel],
      renderedMessage,
      integrationStatus: configuration.status,
    });
  });

  const blockingReasonCodes: string[] = [
    ...(evidenceValue.additionalBlockingReasonCodes ?? []),
  ];
  if (recipientCount === 0) {
    blockingReasonCodes.push('NO_RECIPIENTS');
  }
  const requiredChannels = controlledEmailCanary
    ? (['email'] as const)
    : REQUIRED_CHANNELS;
  for (const channel of requiredChannels) {
    const configuration = configurations[channel];
    if (configuration?.enabled !== true) {
      blockingReasonCodes.push(`${channel.toUpperCase()}_DISABLED`);
    }
    if (endpointCounts[channel] === 0) {
      blockingReasonCodes.push(`NO_${channel.toUpperCase()}_ENDPOINTS`);
    }
  }
  const expectedTruthLabel =
    selection.rosterPopulation === 'staff' ? 'live-verified' : 'mocked';
  for (const channel of channels) {
    if (channel.integrationStatus.label !== expectedTruthLabel) {
      blockingReasonCodes.push(
        blockingCodeForTruth(channel.channel, selection.rosterPopulation),
      );
    }
  }

  const uniqueBlockingReasonCodes = [...new Set(blockingReasonCodes)].sort(
    compareStrings,
  );
  const activeEventIds = [...new Set(evidenceValue.activeEventIds)].sort(
    compareStrings,
  );
  const consequence = Object.freeze({
    facilityId: facility.id,
    kind: selection.kind,
    templateMode: selection.templateMode,
    eventTypeVersion: selection.eventTypeVersion,
    rosterSnapshotId: resolvedAudience.rosterSnapshot.id,
    rosterPopulation: resolvedAudience.rosterSnapshot.population,

    recipientCount,
    channels,
    sendReadiness:
      uniqueBlockingReasonCodes.length === 0
        ? ('ready' as const)
        : ('blocked' as const),
    blockingReasonCodes: uniqueBlockingReasonCodes,
    activeEventIds,
    deliveryTest: evidenceValue.deliveryTest ?? null,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return ActivationPreviewSchema.parse({
    id: evidenceValue.id,
    ...consequence,
    consequenceDigest: digestCapabilityValue({
      capabilityId: 'start-event',
      consequence,
    }),
  });
}
