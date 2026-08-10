import {
  ACTIVATION_PREVIEW_MAX_AGE_SECONDS,
  ActivationPreviewSchema,
  ChannelConfigurationSchema,
  CreateActivationPreviewInputSchema,
  EventTypeVersionSchema,
  FacilitySchema,
  type ActivationPreview,
  type Actor,
  type AudienceConfig,
  type ChannelConfiguration,
  type CreateActivationPreviewInput,
  type EventTypeVersion,
  type Facility,
  type Neighborhood,
  type NotificationChannel,
  type RosterSnapshot,
} from '@psd-eoc/contracts';

import { digestCapabilityValue } from '../../../../lib/capabilities/engine';
import { renderTemplateSet } from '../../../../lib/notify/render';
import { resolveAudience } from '../../../../lib/roster/resolve';

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
  readonly audienceConfig: AudienceConfig;
  readonly neighborhoodVersions: readonly Neighborhood[];
  readonly rosterSnapshot: RosterSnapshot;
  readonly channelConfigurations: readonly ChannelConfiguration[];
  readonly activeEventIds: readonly string[];
  readonly initiator: Actor;
  readonly initiatorDisplayName: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
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
  if (
    evidenceValue.audienceConfig.facilityId !== facility.id ||
    evidenceValue.rosterSnapshot.population !== selection.rosterPopulation
  ) {
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
    audienceConfig: evidenceValue.audienceConfig,
    neighborhoodVersions: evidenceValue.neighborhoodVersions,
    rosterSnapshot: evidenceValue.rosterSnapshot,
  });
  const recipientCount = resolvedAudience.recipients.length;
  const endpointCounts: Record<NotificationChannel, number> = {
    push: 0,
    email: 0,
    sms: 0,
  };
  for (const recipient of resolvedAudience.recipients) {
    for (const endpoint of recipient.endpoints) {
      endpointCounts[endpoint.channel] += 1;
    }
  }

  const configurations = configurationByChannel(
    evidenceValue.channelConfigurations,
  );
  if (configurations.push === undefined || configurations.email === undefined) {
    throw new ActivationPreviewBuildError('CHANNEL_CONFIGURATION_UNAVAILABLE');
  }

  const renderedMessages = renderTemplateSet({
    eventKind: selection.kind,
    templates: eventTypeVersion.templates.activation,
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
  const selectedChannels = ALL_CHANNELS.filter(
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

  const blockingReasonCodes: string[] = [];
  if (recipientCount === 0) {
    blockingReasonCodes.push('NO_RECIPIENTS');
  }
  for (const channel of REQUIRED_CHANNELS) {
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
    audienceConfig: {
      id: resolvedAudience.audienceConfig.id,
      version: resolvedAudience.audienceConfig.version,
    },
    recipientCount,
    channels,
    sendReadiness:
      uniqueBlockingReasonCodes.length === 0
        ? ('ready' as const)
        : ('blocked' as const),
    blockingReasonCodes: uniqueBlockingReasonCodes,
    activeEventIds,
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
