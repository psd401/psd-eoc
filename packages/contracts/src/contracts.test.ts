import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import * as Contracts from './index';
import {
  AccessMembershipSnapshotSchema,
  AgentApiKeyPageSchema,
  AgentApiKeySchema,
  AgentCapabilityGrantSchema,
  ActivationPreviewSchema,
  AllClearEventResultSchema,
  CAPABILITY_CATALOG,
  CAPABILITY_MUTATION_SAFETY_MANIFEST,
  CAPABILITY_QUERY_MANIFEST,
  CapabilityEnvelopeSchema,
  ChannelAttemptSchema,
  ConnectivityEpochInvalidationSchema,
  ConnectivityEpochSchema,
  CloseEventResultSchema,
  CreateActivationPreviewInputSchema,
  CreateDeliveryTestPreviewInputSchema,
  CreateDeliveryTestTargetSetVersionInputSchema,
  DeliveryTestCanaryEligibilityFactSchema,
  DeliveryTestPreviewChannelSchema,
  DeliveryTestPreviewSchema,
  DeliveryTestRunSchema,
  DeliveryTestTargetSetVersionSchema,
  DeliveryEvidenceSchema,
  DeliveryReportSchema,
  DeliveryTruthStateSchema,
  DeliveryTruthTransitionSchema,
  DispatchBatchSchema,
  DispatchOutboxResultSchema,
  DrillRecordSchema,
  EventRecordSchema,
  EventClassificationSchema,
  EventRoomHeaderSchema,
  EventRoomSyncResultSchema,
  EventSchema,
  EventSummaryExportSchema,
  EventTargetingSchema,
  EventTransitionSchema,
  EventTypeRenderingPreviewSchema,
  EventTypeVersionSchema,
  EventTypeVersionDraftSchema,
  ExportDrillRecordsInputSchema,
  ExportEventSummaryInputSchema,
  GroupSourceSchema,
  HUMAN_ONLY_ACTION_IDS,
  HttpsUrlSchema,
  JournalEntrySchema,
  JournalEntryPageSchema,
  JournalEntryReadProjectionSchema,
  JournalEntryInputSchema,
  HumanConfirmationRecordSchema,
  IdempotencyRecordSchema,
  IntegrationChannelChangeAuthorizationSchema,
  IntegrationStatusSchema,
  LifecycleConsequencePreviewSchema,
  ListDrillRecordsInputSchema,
  ListEventRecordsInputSchema,
  ListDeliveryTestReportsInputSchema,
  MediaReadGrantSchema,
  McpDraftMessageRevisionInputSchema,
  McpDraftMessageRevisionResultSchema,
  MutationCapabilityEnvelopeSchema,
  MobileOidcExchangeRequestSchema,
  MobileOidcStartRequestSchema,
  MobileOidcStartResponseSchema,
  MessageTemplateCatalogSchema,
  MonthlyDeliveryTestReportPageSchema,
  MonthlyDeliveryTestReportSchema,
  MobilePushReceivePayloadSchema,
  PushEndpointSendEligibilityInputSchema,
  PushEndpointSendEligibilityResultSchema,
  NotificationIntentSchema,
  NotificationOutboxMessageSchema,
  NotificationStatusSchema,
  OidcCallbackRejectionEvidenceSchema,
  OpaqueSessionBearerSchema,
  OutboxRecordSchema,
  PreparedActivationSchema,
  PreviewEventTypeRenderingInputSchema,
  PublishEventTypeVersionInputSchema,
  RecordDeliveryTestCanaryEligibilityInputSchema,
  RosterSnapshotSchema,
  RosterSourceConfigurationSchema,
  RosterSyncResultSchema,
  RefreshCredentialRejectionEvidenceSchema,
  RecordEndpointStatusInputSchema,
  RenderedMessageSchema,
  RecordsExportSchema,
  SecurityAuditEntrySchema,
  SecurityAuditQuerySchema,
  SMS_LIFECYCLE_PROVIDER,
  SMS_OPT_OUT_REASON_CODE,
  SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
  SmsLifecycleCapabilityContextSchema,
  SetChannelEnabledInputSchema,
  SessionSchema,
  SessionTokenIssuanceSchema,
  SessionTokenReplaySchema,
  SessionTokenRotationSchema,
  StaffRosterEmailSchema,
  staffRosterEmailSchemaForDomain,
  SyncAccessMembershipInputSchema,
  SyncAccessMembershipResultSchema,
  StaleRosterReportSchema,
  StartEventInputSchema,
  UpdateEventTypeDraftInputSchema,
  VerifyEmailIntegrationInputSchema,
  defineCapability,
  getEventClassificationPresentation,
  getCapabilityInvocationPolicy,
  parseCapabilityEnvelopeFor,
  parseCapabilityInput,
  resolveHumanActionRequirement,
  type EventKind,
  type RosterPopulation,
  type TemplateMode,
} from './index';

const ids = {
  actor: '00000000-0000-4000-8000-000000000001',
  session: '00000000-0000-4000-8000-000000000002',
  request: '00000000-0000-4000-8000-000000000003',
  confirmation: '00000000-0000-4000-8000-000000000004',
  facility: '00000000-0000-4000-8000-000000000005',
  otherFacility: '00000000-0000-4000-8000-000000000006',
  neighborhood: '00000000-0000-4000-8000-000000000007',
  audience: '00000000-0000-4000-8000-000000000008',
  group: '00000000-0000-4000-8000-000000000009',
  roster: '00000000-0000-4000-8000-000000000010',
  recipient: '00000000-0000-4000-8000-000000000011',
  endpoint: '00000000-0000-4000-8000-000000000012',
  eventType: '00000000-0000-4000-8000-000000000013',
  eventTypeVersion: '00000000-0000-4000-8000-000000000014',
  event: '00000000-0000-4000-8000-000000000015',
  journal: '00000000-0000-4000-8000-000000000016',
  earlierJournal: '00000000-0000-4000-8000-000000000017',
  intent: '00000000-0000-4000-8000-000000000018',
  batch: '00000000-0000-4000-8000-000000000019',
  attempt: '00000000-0000-4000-8000-000000000020',
  evidence: '00000000-0000-4000-8000-000000000021',
  agent: '00000000-0000-4000-8000-000000000022',
  apiKey: '00000000-0000-4000-8000-000000000023',
  device: '00000000-0000-4000-8000-000000000024',
  smsEndpoint: '00000000-0000-4000-8000-000000000025',
  pushEndpoint: '00000000-0000-4000-8000-000000000026',
  preview: '00000000-0000-4000-8000-000000000027',
  prepared: '00000000-0000-4000-8000-000000000028',
  outbox: '00000000-0000-4000-8000-000000000029',
  replay: '00000000-0000-4000-8000-000000000030',
  rotation: '00000000-0000-4000-8000-000000000031',
  audit: '00000000-0000-4000-8000-000000000032',
  secondRecipient: '00000000-0000-4000-8000-000000000033',
  secondEndpoint: '00000000-0000-4000-8000-000000000034',
  membershipSnapshot: '00000000-0000-4000-8000-000000000035',
  connectivityEpoch: '00000000-0000-4000-8000-000000000036',
  previousConnectivityEpoch: '00000000-0000-4000-8000-000000000037',
  rosterConfiguration: '00000000-0000-4000-8000-000000000038',
  tokenIssuance: '00000000-0000-4000-8000-000000000039',
  transition: '00000000-0000-4000-8000-000000000040',
  media: '00000000-0000-4000-8000-000000000041',
  deliveryTargetSet: '00000000-0000-4000-8000-000000000042',
  priorDeliveryTargetSet: '00000000-0000-4000-8000-000000000043',
  deliveryRun: '00000000-0000-4000-8000-000000000044',
  deliveryReport: '00000000-0000-4000-8000-000000000045',
  deliveryEligibilityPush: '00000000-0000-4000-8000-000000000046',
  deliveryEligibilityEmail: '00000000-0000-4000-8000-000000000047',
  deliveryEligibilityRevocation: '00000000-0000-4000-8000-000000000048',
} as const;

const times = {
  before: '2026-08-07T03:59:00.000Z',
  created: '2026-08-07T04:00:00.000Z',
  activated: '2026-08-07T04:01:00.000Z',
  later: '2026-08-07T04:02:00.000Z',
  confirmationExpiry: '2026-08-07T04:04:00.000Z',
  previewExpiry: '2026-08-07T04:10:00.000Z',
  afterExpiry: '2026-08-07T04:20:00.000Z',
  sessionExpiry: '2026-08-08T04:00:00.000Z',
} as const;

const humanActor = {
  kind: 'human',
  userId: ids.actor,
  sessionId: ids.session,
} as const;

const agentActor = {
  kind: 'agent',
  agentId: ids.agent,
  apiKeyId: ids.apiKey,
} as const;

const systemActor = {
  kind: 'system',
  serviceId: 'synthetic-test-runner',
} as const;

const seedActor = {
  kind: 'system',
  serviceId: 'database-seed',
} as const;

const districtScope = {
  facilityScope: { kind: 'district' },
} as const;

const webMutationTransport = {
  kind: 'web-interactive',
  method: 'POST',
  interaction: 'explicit-user-submit',
  csrfVerified: true,
} as const;

const mcpMutationTransport = { kind: 'mcp-tool-call' } as const;

const agentRestMutationTransport = {
  kind: 'agent-rest-command',
  method: 'POST',
} as const;

const scheduledMutationTransport = {
  kind: 'scheduled-execution',
} as const;

const capabilityByProtectedAction = {
  'start-real-incident': 'start-event',
  'send-real-notification': 'start-event',
  'all-clear': 'all-clear-event',
  'close-real-event': 'close-event',
} as const;

const realTypeRef = {
  id: ids.eventTypeVersion,
  templateMode: 'real',
} as const;

const drillTypeRef = {
  id: ids.eventTypeVersion,
  templateMode: 'drill',
} as const;

function templateSet(
  mode: TemplateMode,
  purpose: 'activation' | 'all-clear' | 'reactivation',
) {
  const classificationMarker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  const purposeText = {
    activation: 'Follow safety procedures',
    'all-clear': 'The event is all clear',
    reactivation: 'The event has been reactivated',
  }[purpose];
  return {
    templateMode: mode,
    purpose,
    push: {
      channel: 'push',
      templateMode: mode,
      purpose,
      classificationMarker,
      title: `${purposeText} at {{site}}`,
      body: `${purposeText} at {{site}}.`,
    },
    email: {
      channel: 'email',
      templateMode: mode,
      purpose,
      classificationMarker,
      subject: `${purposeText} at {{site}}`,
      textBody: `${purposeText} at {{site}}.`,
    },
    sms: {
      channel: 'sms',
      templateMode: mode,
      purpose,
      classificationMarker,
      body: `${purposeText} at {{site}}.`,
    },
  } as const;
}

function templateCatalog(mode: TemplateMode) {
  return {
    activation: templateSet(mode, 'activation'),
    'all-clear': templateSet(mode, 'all-clear'),
    reactivation: templateSet(mode, 'reactivation'),
  } as const;
}

function eventTypeVersion(mode: TemplateMode) {
  return {
    id: ids.eventTypeVersion,
    eventTypeId: ids.eventType,
    version: 1,
    templateMode: mode,
    name: mode === 'real' ? 'Lockdown' : 'Lockdown Drill',
    description: null,
    enabled: true,
    templates: templateCatalog(mode),
    supersedesVersionId: null,
    createdBy: seedActor,
    publicationAuthorization: {
      kind: 'repository-seed',
      approvalReference: 'reviewed-seed-change',
    },
    createdAt: times.created,
  } as const;
}

function targeting(
  kind: EventKind,
  templateMode: TemplateMode,
  rosterPopulation: RosterPopulation,
) {
  return { kind, templateMode, rosterPopulation } as const;
}

function activeEvent(
  kind: EventKind,
  templateMode: TemplateMode,
  rosterPopulation: RosterPopulation,
) {
  const target = targeting(kind, templateMode, rosterPopulation);
  const requiresHuman =
    kind === 'incident' || (kind === 'drill' && rosterPopulation === 'staff');
  return {
    id: ids.event,
    facilityId: ids.facility,
    kind,
    templateMode,
    eventTypeVersion: { id: ids.eventTypeVersion, templateMode },
    status: 'active',
    rosterSnapshotId: ids.roster,
    rosterPopulation,
    createdBy: requiresHuman ? humanActor : agentActor,
    createdAt: times.created,
    activatedAt: times.activated,
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: activationAuthorization(target),
  } as const;
}

function activationPreview(target = targeting('incident', 'real', 'staff')) {
  return {
    id: ids.preview,
    facilityId: ids.facility,
    ...target,
    eventTypeVersion:
      target.templateMode === 'real' ? realTypeRef : drillTypeRef,
    rosterSnapshotId: ids.roster,
    recipientCount: 42,
    channels: channelPlan(target),
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: [],
    consequenceDigest: 'a'.repeat(64),
    createdAt: times.created,
    expiresAt: times.previewExpiry,
  } as const;
}

const deliveryTestMetadata = {
  purpose: 'monthly-live-delivery-test',
  targetSet: { id: ids.deliveryTargetSet, version: 1 },
  endpointReferenceDigest: 'd'.repeat(64),
} as const;

function deliveryTestTargetSetVersion() {
  return {
    id: ids.deliveryTargetSet,
    version: 1,
    facilityId: ids.facility,
    rosterSnapshotId: ids.roster,
    supersedesVersionId: null,
    endpoints: [
      {
        eligibilityFactId: ids.deliveryEligibilityPush,
        recipientId: ids.recipient,
        endpointId: ids.pushEndpoint,
        channel: 'push',
        attestation: 'approved-synthetic-canary',
        optedInAt: times.before,
        attestedAt: times.created,
        attestedByUserId: ids.actor,
        authorizationReference: 'product-owner-canary-approval-2026-08',
      },
      {
        eligibilityFactId: ids.deliveryEligibilityEmail,
        recipientId: ids.secondRecipient,
        endpointId: ids.secondEndpoint,
        channel: 'email',
        attestation: 'approved-synthetic-canary',
        optedInAt: times.before,
        attestedAt: times.created,
        attestedByUserId: ids.actor,
        authorizationReference: 'product-owner-canary-approval-2026-08',
      },
    ],
    endpointReferenceDigest: deliveryTestMetadata.endpointReferenceDigest,
    approvedByUserId: ids.actor,
    approvedWithSessionId: ids.session,
    approvedAt: times.activated,
    createdAt: times.created,
  } as const;
}

function monthlyDeliveryTestPreview() {
  const activation = {
    ...activationPreview(targeting('drill', 'drill', 'staff')),
    deliveryTest: deliveryTestMetadata,
  } as const;
  return {
    purpose: 'monthly-live-delivery-test',
    activationPreview: activation,
    targetSet: deliveryTestMetadata.targetSet,
    endpointReferenceDigest: deliveryTestMetadata.endpointReferenceDigest,
    channels: activation.channels.map((channel) => ({
      channel: channel.channel,
      endpointCount: channel.endpointCount,
      integrationStatus: channel.integrationStatus,
      credentialVerified: true,
    })),
    consequenceDigest: activation.consequenceDigest,
    createdAt: activation.createdAt,
    expiresAt: activation.expiresAt,
  } as const;
}

function monthlyDeliveryTestReport() {
  return {
    id: ids.deliveryReport,
    runId: ids.deliveryRun,
    sequence: 1,
    supersedesReportId: null,
    status: 'succeeded',
    channels: [
      {
        channel: 'push',
        endpointCount: 1,
        activationToProviderAcceptMs: 500,
        latestStateCounts: [{ state: 'provider-accepted', count: 1 }],
        completedAt: times.activated,
      },
      {
        channel: 'email',
        endpointCount: 1,
        activationToProviderAcceptMs: 750,
        latestStateCounts: [{ state: 'delivered', count: 1 }],
        completedAt: times.activated,
      },
    ],
    generatedAt: times.later,
    finalizedBy: systemActor,
    source: 'worker',
    reasonCode: null,
  } as const;
}

function lifecyclePreview(
  purpose: 'all-clear' | 'reactivation',
  target = targeting('incident', 'real', 'staff'),
) {
  return {
    id: ids.preview,
    eventId: ids.event,
    purpose,
    ...target,
    eventTypeVersion:
      target.templateMode === 'real' ? realTypeRef : drillTypeRef,
    rosterSnapshotId: ids.roster,
    recipientCount: 42,
    channels: channelPlan(target, purpose),
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    consequenceDigest: 'a'.repeat(64),
    createdAt: times.created,
    expiresAt: times.previewExpiry,
  } as const;
}

function renderedMessage(
  channel: 'push' | 'email' | 'sms',
  target: ReturnType<typeof targeting>,
  purpose: 'activation' | 'all-clear' | 'reactivation' = 'activation',
) {
  const marker = target.templateMode === 'real' ? 'INCIDENT' : 'DRILL';
  const common = {
    eventKind: target.kind,
    templateMode: target.templateMode,
    purpose,
    classificationMarker: marker,
  } as const;
  switch (channel) {
    case 'push':
      return {
        ...common,
        channel,
        title: `[${marker}] Lockdown`,
        body: `[${marker}] Follow district safety procedures.`,
      } as const;
    case 'email':
      return {
        ...common,
        channel,
        subject: `[${marker}] Lockdown`,
        textBody: `[${marker}] Follow district safety procedures.`,
      } as const;
    case 'sms':
      return {
        ...common,
        channel,
        body: `[${marker}] Follow district safety procedures.`,
      } as const;
  }
}

function integrationStatus(
  channel: 'push' | 'email' | 'sms',
  population: RosterPopulation,
) {
  const integrationId = {
    push: 'expo-push',
    email: 'ses-email',
    sms: 'aws-eum-sms',
  }[channel];
  return population === 'synthetic'
    ? ({
        integrationId,
        label: 'mocked',
        verifiedAt: null,
        verifiedByUserId: null,
        authorizationReference: null,
        reasonCode: null,
        observedAt: times.created,
      } as const)
    : ({
        integrationId,
        label: 'live-verified',
        verifiedAt: times.created,
        verifiedByUserId: ids.actor,
        authorizationReference: 'approved-synthetic-contract-fixture',
        reasonCode: null,
        observedAt: times.activated,
      } as const);
}

function channelPlan(
  target: ReturnType<typeof targeting>,
  purpose: 'activation' | 'all-clear' | 'reactivation' = 'activation',
) {
  return (['push', 'email', 'sms'] as const).map((channel) => ({
    channel,
    endpointCount: 14,
    renderedMessage: renderedMessage(channel, target, purpose),
    integrationStatus: integrationStatus(channel, target.rosterPopulation),
  }));
}

function activationAuthorization(target: ReturnType<typeof targeting>) {
  const common = {
    activationPreviewId: ids.preview,
    consequenceDigest: 'a'.repeat(64),
    requestId: ids.request,
  } as const;
  return target.rosterPopulation === 'staff'
    ? ({
        ...common,
        kind: 'human-confirmed',
        preparedActivationId: null,
        confirmationId: ids.confirmation,
      } as const)
    : ({ ...common, kind: 'synthetic-training' } as const);
}

function lifecycleAuthorization(
  purpose: 'all-clear' | 'reactivation',
  target: ReturnType<typeof targeting>,
) {
  const common = {
    purpose,
    targeting: target,
    lifecyclePreviewId: ids.preview,
    transitionId: ids.transition,
    consequenceDigest: 'a'.repeat(64),
    requestId: ids.request,
  } as const;
  if (target.rosterPopulation === 'synthetic') {
    return { ...common, kind: 'synthetic-lifecycle' } as const;
  }
  const actionIds =
    purpose === 'all-clear'
      ? (['all-clear', 'send-real-notification'] as const)
      : target.kind === 'incident'
        ? (['start-real-incident', 'send-real-notification'] as const)
        : (['send-real-notification'] as const);
  return {
    ...common,
    kind: 'human-confirmed-lifecycle',
    actionIds,
    confirmationId: ids.confirmation,
  } as const;
}

function notificationClassification(
  eventKind: EventKind,
  templateMode: TemplateMode,
  rosterPopulation: RosterPopulation,
) {
  return { eventKind, templateMode, rosterPopulation } as const;
}

function syntheticAllClearResult() {
  const target = targeting('test', 'drill', 'synthetic');
  const authorization = lifecycleAuthorization('all-clear', target);
  const transition = {
    id: ids.transition,
    sequence: 2,
    actor: agentActor,
    source: 'mcp',
    occurredAt: times.later,
    requestId: ids.request,
    confirmationId: null,
    consequenceDigest: null,
    targeting: target,
    idempotencyKey: 'synthetic-all-clear-contract-0001',
    transition: 'all-clear',
    eventId: ids.event,
    from: 'active',
    to: 'all-clear',
    notificationAuthorization: authorization,
  } as const;
  const notificationIntent = {
    id: ids.intent,
    eventId: ids.event,
    ...notificationClassification('test', 'drill', 'synthetic'),
    purpose: 'all-clear',
    eventTypeVersion: drillTypeRef,
    rosterSnapshotId: ids.roster,
    createdBy: agentActor,
    source: 'mcp',
    requestId: ids.request,
    authorization,
    channels: channelPlan(target, 'all-clear'),
    createdAt: times.later,
  } as const;
  return {
    event: {
      ...activeEvent('test', 'drill', 'synthetic'),
      status: 'all-clear',
      allClearAt: times.later,
    },
    transition,
    journalEntries: [
      {
        id: ids.journal,
        eventId: ids.event,
        sequence: 2,
        kind: 'system',
        author: agentActor,
        source: 'mcp',
        serverTime: times.later,
        clientTime: null,
        supersedes: null,
        payload: {
          code: 'all-clear-issued',
          summary: 'Synthetic test event is all clear.',
          transition,
        },
      },
      {
        id: ids.earlierJournal,
        eventId: ids.event,
        sequence: 3,
        kind: 'system',
        author: agentActor,
        source: 'mcp',
        serverTime: times.later,
        clientTime: null,
        supersedes: null,
        payload: {
          code: 'notification-intent-recorded',
          summary: 'Synthetic all-clear notification recorded.',
          relatedRecordId: ids.intent,
        },
      },
    ],
    notificationIntent,
    preparedActivationConsumption: null,
  } as const;
}

function syntheticCloseResult() {
  const target = targeting('test', 'drill', 'synthetic');
  const transition = {
    id: ids.transition,
    sequence: 3,
    actor: agentActor,
    source: 'mcp',
    occurredAt: times.confirmationExpiry,
    requestId: ids.request,
    confirmationId: null,
    consequenceDigest: null,
    targeting: target,
    idempotencyKey: 'synthetic-close-contract-0001',
    transition: 'close',
    eventId: ids.event,
    from: 'all-clear',
    to: 'closed',
  } as const;
  return {
    event: {
      ...activeEvent('test', 'drill', 'synthetic'),
      status: 'closed',
      allClearAt: times.later,
      closedAt: times.confirmationExpiry,
    },
    transition,
    journalEntries: [
      {
        id: ids.journal,
        eventId: ids.event,
        sequence: 4,
        kind: 'system',
        author: agentActor,
        source: 'mcp',
        serverTime: times.confirmationExpiry,
        clientTime: null,
        supersedes: null,
        payload: {
          code: 'event-closed',
          summary: 'Synthetic test event closed.',
          transition,
        },
      },
    ],
    notificationIntent: null,
    preparedActivationConsumption: null,
  } as const;
}

describe('event type, targeting, and activation contracts', () => {
  test('accepts only explicit kind/mode and targeting combinations', () => {
    for (const classification of [
      { kind: 'incident', templateMode: 'real' },
      { kind: 'drill', templateMode: 'drill' },
      { kind: 'test', templateMode: 'drill' },
    ] as const) {
      expect(EventClassificationSchema.safeParse(classification).success).toBe(
        true,
      );
    }

    for (const classification of [
      { kind: 'incident', templateMode: 'drill' },
      { kind: 'drill', templateMode: 'real' },
      { kind: 'test', templateMode: 'real' },
    ] as const) {
      expect(EventClassificationSchema.safeParse(classification).success).toBe(
        false,
      );
    }

    for (const target of [
      targeting('incident', 'real', 'staff'),
      targeting('drill', 'drill', 'staff'),
      targeting('drill', 'drill', 'synthetic'),
      targeting('test', 'drill', 'synthetic'),
    ]) {
      expect(EventTargetingSchema.safeParse(target).success).toBe(true);
    }
    expect(
      EventTargetingSchema.safeParse(targeting('incident', 'real', 'synthetic'))
        .success,
    ).toBe(false);
    expect(
      EventTargetingSchema.safeParse(targeting('test', 'drill', 'staff'))
        .success,
    ).toBe(false);
  });

  test('owns one visible label and color treatment for every classification', () => {
    expect(
      getEventClassificationPresentation({
        kind: 'incident',
        templateMode: 'real',
      }),
    ).toMatchObject({
      label: 'REAL INCIDENT',
      colors: { bannerBackground: '#7A1020', onBanner: '#FFFFFF' },
    });
    expect(
      getEventClassificationPresentation({
        kind: 'drill',
        templateMode: 'drill',
      }),
    ).toMatchObject({
      label: 'DRILL — TRAINING ONLY',
      colors: { bannerBackground: '#075985', onBanner: '#FFFFFF' },
    });
    expect(
      getEventClassificationPresentation({
        kind: 'test',
        templateMode: 'drill',
      }),
    ).toMatchObject({
      label: 'TEST — NOT A REAL INCIDENT',
      colors: { bannerBackground: '#765A00', onBanner: '#FFFFFF' },
    });
  });

  test('pins classification across every channel template', () => {
    const valid = eventTypeVersion('real');
    expect(EventTypeVersionSchema.safeParse(valid).success).toBe(true);
    expect(
      EventTypeVersionSchema.safeParse({
        ...valid,
        templates: {
          ...valid.templates,
          activation: {
            ...valid.templates.activation,
            push: {
              ...valid.templates.activation.push,
              templateMode: 'drill',
              classificationMarker: 'DRILL',
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  test('accepts only the documented template grammar and no raw HTML', () => {
    const valid = eventTypeVersion('drill');
    expect(EventTypeVersionSchema.safeParse(valid).success).toBe(true);
    expect(
      EventTypeVersionSchema.safeParse({
        ...valid,
        templates: {
          ...valid.templates,
          activation: {
            ...valid.templates.activation,
            sms: {
              ...valid.templates.activation.sms,
              body: 'At {{unknown}}.',
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      EventTypeVersionSchema.safeParse({ ...valid, createdBy: agentActor })
        .success,
    ).toBe(false);
    expect(
      EventTypeVersionSchema.safeParse({
        ...valid,
        createdBy: agentActor,
        publicationAuthorization: {
          kind: 'agent-configuration',
          agentId: ids.agent,
          apiKeyId: ids.apiKey,
          authorizationReference: 'explicit-event-type-publish-grant',
        },
      }).success,
    ).toBe(true);
    expect(
      EventTypeVersionDraftSchema.safeParse({
        id: ids.prepared,
        eventTypeId: ids.eventType,
        status: 'draft',
        templateMode: 'drill',
        name: 'Agent proposed drill wording',
        description: null,
        baseVersionId: ids.eventTypeVersion,
        enabled: true,
        templates: templateCatalog('drill'),
        draftedBy: agentActor,
        draftRevision: 'a'.repeat(64),
        createdAt: times.created,
      }).success,
    ).toBe(true);
    expect(
      EventTypeVersionSchema.safeParse({
        ...valid,
        templates: {
          ...valid.templates,
          activation: {
            ...valid.templates.activation,
            push: {
              ...valid.templates.activation.push,
              body: 'At {{site}.',
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      EventTypeVersionSchema.safeParse({
        ...valid,
        templates: {
          ...valid.templates,
          activation: {
            ...valid.templates.activation,
            email: {
              ...valid.templates.activation.email,
              htmlBody: '<script>unsafe()</script>',
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  test('binds event-type draft updates, previews, and publication to exact revisions', () => {
    const draftRevision = 'a'.repeat(64);
    const draft = {
      id: ids.prepared,
      eventTypeId: ids.eventType,
      status: 'draft',
      templateMode: 'drill',
      name: 'Agent proposed drill wording',
      description: null,
      baseVersionId: ids.eventTypeVersion,
      enabled: false,
      templates: templateCatalog('drill'),
      draftedBy: agentActor,
      draftRevision,
      createdAt: times.created,
    } as const;
    expect(EventTypeVersionDraftSchema.parse(draft).enabled).toBe(false);
    const { draftRevision: _missingDraftRevision, ...draftWithoutRevision } =
      draft;
    expect(_missingDraftRevision).toBe(draftRevision);
    expect(
      EventTypeVersionDraftSchema.safeParse(draftWithoutRevision).success,
    ).toBe(false);
    expect(
      EventTypeVersionDraftSchema.safeParse({
        ...draft,
        draftRevision: 'A'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      EventTypeVersionDraftSchema.safeParse({
        ...draft,
        draftRevision: 'a'.repeat(63),
      }).success,
    ).toBe(false);
    expect(
      EventTypeVersionDraftSchema.safeParse({
        ...draft,
        baseVersionId: null,
      }).success,
    ).toBe(true);
    expect(
      EventTypeVersionDraftSchema.safeParse({
        ...draft,
        expectedDraftRevision: draftRevision,
      }).success,
    ).toBe(false);

    const createExisting = {
      target: {
        kind: 'existing-event-type',
        eventTypeId: ids.eventType,
        baseVersionId: ids.eventTypeVersion,
      },
      name: draft.name,
      description: draft.description,
      enabled: false,
      templates: draft.templates,
    } as const;
    expect(
      Contracts.CreateEventTypeDraftInputSchema.parse(createExisting).enabled,
    ).toBe(false);
    expect(
      Contracts.CreateEventTypeDraftInputSchema.safeParse({
        ...createExisting,
        target: {
          kind: 'existing-event-type',
          eventTypeId: ids.eventType,
        },
      }).success,
    ).toBe(false);
    const { enabled: _missingCreateEnabled, ...createWithoutEnabled } =
      createExisting;
    expect(_missingCreateEnabled).toBe(false);
    expect(
      Contracts.CreateEventTypeDraftInputSchema.safeParse(createWithoutEnabled)
        .success,
    ).toBe(false);
    expect(
      Contracts.CreateEventTypeDraftInputSchema.safeParse({
        ...createExisting,
        target: {
          kind: 'new-event-type',
          key: 'lockdown-drill',
          familyKey: 'lockdown',
          templateMode: 'drill',
          baseVersionId: ids.eventTypeVersion,
        },
      }).success,
    ).toBe(false);

    const update = {
      draftId: ids.prepared,
      expectedDraftRevision: draftRevision,
      name: draft.name,
      description: draft.description,
      enabled: false,
      templates: draft.templates,
    } as const;
    expect(UpdateEventTypeDraftInputSchema.parse(update).enabled).toBe(false);
    const {
      expectedDraftRevision: _missingUpdateRevision,
      ...updateWithoutRevision
    } = update;
    expect(_missingUpdateRevision).toBe(draftRevision);
    expect(
      UpdateEventTypeDraftInputSchema.safeParse(updateWithoutRevision).success,
    ).toBe(false);
    expect(
      UpdateEventTypeDraftInputSchema.safeParse({
        ...update,
        baseVersionId: ids.eventTypeVersion,
      }).success,
    ).toBe(false);
    expect(
      UpdateEventTypeDraftInputSchema.safeParse({
        ...update,
        expectedDraftRevision: 'A'.repeat(64),
      }).success,
    ).toBe(false);
    const { enabled: _missingUpdateEnabled, ...updateWithoutEnabled } = update;
    expect(_missingUpdateEnabled).toBe(false);
    expect(
      UpdateEventTypeDraftInputSchema.safeParse(updateWithoutEnabled).success,
    ).toBe(false);

    const previewInput = {
      draftId: ids.prepared,
      expectedDraftRevision: draftRevision,
      eventKind: 'drill',
      purpose: 'activation',
    } as const;
    expect(
      PreviewEventTypeRenderingInputSchema.safeParse(previewInput).success,
    ).toBe(true);
    expect(
      PreviewEventTypeRenderingInputSchema.safeParse({
        draftId: ids.prepared,
        eventKind: 'drill',
        purpose: 'activation',
      }).success,
    ).toBe(false);
    expect(
      PreviewEventTypeRenderingInputSchema.safeParse({
        ...previewInput,
        expectedDraftRevision: 'A'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      PreviewEventTypeRenderingInputSchema.safeParse({
        ...previewInput,
        draftRevision,
      }).success,
    ).toBe(false);
    const preview = {
      draftId: ids.prepared,
      draftRevision,
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      messages: [
        renderedMessage('push', targeting('drill', 'drill', 'synthetic')),
        renderedMessage('email', targeting('drill', 'drill', 'synthetic')),
        renderedMessage('sms', targeting('drill', 'drill', 'synthetic')),
      ],
    } as const;
    expect(EventTypeRenderingPreviewSchema.safeParse(preview).success).toBe(
      true,
    );
    expect(
      EventTypeRenderingPreviewSchema.safeParse({
        ...preview,
        draftRevision: undefined,
      }).success,
    ).toBe(false);

    const publish = {
      draftId: ids.prepared,
      expectedDraftRevision: draftRevision,
    } as const;
    expect(PublishEventTypeVersionInputSchema.safeParse(publish).success).toBe(
      true,
    );
    expect(
      PublishEventTypeVersionInputSchema.safeParse({
        draftId: ids.prepared,
      }).success,
    ).toBe(false);
    expect(
      PublishEventTypeVersionInputSchema.safeParse({
        ...publish,
        expectedDraftRevision: 'A'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      PublishEventTypeVersionInputSchema.safeParse({
        ...publish,
        enabled: false,
      }).success,
    ).toBe(false);

    expect(
      parseCapabilityInput('create-event-type-draft', createExisting),
    ).toEqual(createExisting);
    expect(parseCapabilityInput('update-event-type-draft', update)).toEqual(
      update,
    );
    expect(
      parseCapabilityInput('preview-event-type-rendering', previewInput),
    ).toEqual(previewInput);
    expect(parseCapabilityInput('publish-event-type-version', publish)).toEqual(
      publish,
    );
  });

  test('rejects Unicode controls that can visually spoof real versus drill', () => {
    const bidiSpoof = '[DRILL] \u202E]TNEDICNI[\u202C';
    expect(
      RenderedMessageSchema.safeParse({
        ...renderedMessage('push', targeting('drill', 'drill', 'synthetic')),
        body: bidiSpoof,
      }).success,
    ).toBe(false);

    const drillTemplates = templateCatalog('drill');
    expect(
      MessageTemplateCatalogSchema.safeParse({
        ...drillTemplates,
        activation: {
          ...drillTemplates.activation,
          push: {
            ...drillTemplates.activation.push,
            body: `Drill instructions \u2066${bidiSpoof}\u2069`,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      MessageTemplateCatalogSchema.safeParse({
        ...drillTemplates,
        activation: {
          ...drillTemplates.activation,
          sms: {
            ...drillTemplates.activation.sms,
            body: 'Cafe\u0301 drill instructions',
          },
        },
      }).success,
    ).toBe(false);
  });

  test('keeps real incidents and staff drills human-created', () => {
    expect(
      EventSchema.safeParse(activeEvent('incident', 'real', 'staff')).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse(activeEvent('drill', 'drill', 'staff')).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse(activeEvent('drill', 'drill', 'synthetic')).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse(activeEvent('test', 'drill', 'synthetic')).success,
    ).toBe(true);

    expect(
      EventSchema.safeParse({
        ...activeEvent('incident', 'real', 'staff'),
        createdBy: agentActor,
      }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({
        ...activeEvent('drill', 'drill', 'staff'),
        createdBy: agentActor,
      }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({
        ...activeEvent('incident', 'real', 'staff'),
        status: 'draft',
        rosterSnapshotId: null,
        rosterPopulation: null,
        createdBy: agentActor,
        activatedAt: null,
        allClearAt: null,
        reactivatedAt: null,
        closedAt: null,
        correctionOfEventId: ids.prepared,
        correctionReason: 'Append-only incident correction draft.',
        activationAuthorization: null,
      }).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse(activeEvent('test', 'drill', 'staff')).success,
    ).toBe(false);
  });

  test('lets agents prepare but never activate staff-targeting events', () => {
    const prepared = {
      id: ids.prepared,
      preview: activationPreview(),
      preparedBy: agentActor,
      preparedAt: times.activated,
    } as const;
    expect(PreparedActivationSchema.safeParse(prepared).success).toBe(true);
    expect(
      PreparedActivationSchema.safeParse({
        ...prepared,
        preparedBy: systemActor,
      }).success,
    ).toBe(false);
    expect(
      PreparedActivationSchema.safeParse({
        ...prepared,
        preparedAt: times.afterExpiry,
      }).success,
    ).toBe(false);
    expect(
      PreparedActivationSchema.safeParse({
        ...prepared,
        preview: activationPreview(targeting('test', 'drill', 'synthetic')),
      }).success,
    ).toBe(false);
    expect(
      PreparedActivationSchema.safeParse({
        ...prepared,
        preview: {
          ...activationPreview(targeting('drill', 'drill', 'staff')),
          deliveryTest: deliveryTestMetadata,
        },
      }).success,
    ).toBe(false);
  });

  test('binds activation to server-issued previews and an explicit start choice', () => {
    expect(ActivationPreviewSchema.safeParse(activationPreview()).success).toBe(
      true,
    );
    expect(
      ActivationPreviewSchema.safeParse({
        ...activationPreview(),
        channels: [activationPreview().channels[2]],
      }).success,
    ).toBe(false);
    expect(
      ActivationPreviewSchema.safeParse({
        ...activationPreview(),
        recipientCount: 0,
      }).success,
    ).toBe(false);
    expect(
      ActivationPreviewSchema.safeParse({
        ...activationPreview(),
        recipientCount: 0,
        channels: activationPreview().channels.map((channel) => ({
          ...channel,
          endpointCount: 0,
        })),
        sendReadiness: 'blocked',
        blockingReasonCodes: ['NO_RECIPIENTS'],
      }).success,
    ).toBe(true);
    expect(
      IntegrationStatusSchema.safeParse({
        ...integrationStatus('push', 'staff'),
        authorizationReference: null,
      }).success,
    ).toBe(false);
    expect(
      IntegrationStatusSchema.safeParse({
        ...integrationStatus('push', 'synthetic'),
        verifiedAt: times.created,
      }).success,
    ).toBe(false);
    expect(
      LifecycleConsequencePreviewSchema.safeParse(lifecyclePreview('all-clear'))
        .success,
    ).toBe(true);
    expect(
      LifecycleConsequencePreviewSchema.safeParse({
        ...lifecyclePreview('all-clear'),
        channels: channelPlan(
          targeting('incident', 'real', 'staff'),
          'activation',
        ),
      }).success,
    ).toBe(false);
    expect(
      ActivationPreviewSchema.safeParse({
        ...activationPreview(),
        expiresAt: times.sessionExpiry,
      }).success,
    ).toBe(false);
    const misleadingPush = activationPreview();
    expect(
      ActivationPreviewSchema.safeParse({
        ...misleadingPush,
        channels: misleadingPush.channels.map((channel) =>
          channel.channel === 'push'
            ? {
                ...channel,
                renderedMessage: {
                  ...channel.renderedMessage,
                  body: '[INCIDENT] [DRILL] This is only a drill.',
                },
              }
            : channel,
        ),
      }).success,
    ).toBe(false);
    expect(
      CreateActivationPreviewInputSchema.safeParse({
        facilityId: ids.facility,
        kind: 'test',
        templateMode: 'drill',
        eventTypeVersion: drillTypeRef,
        rosterPopulation: 'synthetic',
      }).success,
    ).toBe(true);

    const start = {
      source: 'activation-preview',
      activationPreviewId: ids.preview,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [],
      },
    } as const;
    expect(StartEventInputSchema.safeParse(start).success).toBe(true);
    expect(
      StartEventInputSchema.safeParse({
        ...start,
        activeEventDecision: {
          decision: 'join-existing',
          eventId: ids.event,
        },
      }).success,
    ).toBe(false);
    expect(
      StartEventInputSchema.safeParse({
        ...start,
        rosterSnapshotId: ids.roster,
      }).success,
    ).toBe(false);
    expect(
      StartEventInputSchema.safeParse({
        source: 'prepared-activation',
        preparedActivationId: ids.prepared,
        activeEventDecision: {
          decision: 'start-new',
          activeEventIdsSeen: [ids.event],
        },
      }).success,
    ).toBe(true);
  });

  test('persists complete human or synthetic transition provenance', () => {
    const staffTarget = targeting('incident', 'real', 'staff');
    const staffTransition = {
      id: ids.transition,
      sequence: 1,
      actor: humanActor,
      source: 'web',
      occurredAt: times.activated,
      requestId: ids.request,
      confirmationId: ids.confirmation,
      consequenceDigest: 'a'.repeat(64),
      targeting: staffTarget,
      idempotencyKey: 'activate-staff-event-0001',
      transition: 'activate',
      eventId: ids.event,
      from: 'draft',
      to: 'active',
      activationAuthorization: activationAuthorization(staffTarget),
    } as const;
    expect(EventTransitionSchema.safeParse(staffTransition).success).toBe(true);
    expect(
      EventTransitionSchema.safeParse({
        ...staffTransition,
        actor: agentActor,
        source: 'mcp',
      }).success,
    ).toBe(false);
    expect(
      EventTransitionSchema.safeParse({
        ...staffTransition,
        activationAuthorization: activationAuthorization(
          targeting('test', 'drill', 'synthetic'),
        ),
      }).success,
    ).toBe(false);

    const syntheticTarget = targeting('test', 'drill', 'synthetic');
    expect(
      EventTransitionSchema.safeParse({
        ...staffTransition,
        actor: agentActor,
        source: 'mcp',
        confirmationId: null,
        consequenceDigest: null,
        targeting: syntheticTarget,
        activationAuthorization: activationAuthorization(syntheticTarget),
      }).success,
    ).toBe(true);

    const staffReactivate = {
      id: ids.transition,
      sequence: 3,
      actor: humanActor,
      source: 'web',
      occurredAt: times.later,
      requestId: ids.request,
      confirmationId: ids.confirmation,
      consequenceDigest: 'a'.repeat(64),
      targeting: staffTarget,
      idempotencyKey: 'reactivate-staff-event-0001',
      transition: 'reactivate',
      eventId: ids.event,
      from: 'all-clear',
      to: 'active',
      notificationAuthorization: lifecycleAuthorization(
        'reactivation',
        staffTarget,
      ),
    } as const;
    expect(EventTransitionSchema.safeParse(staffReactivate).success).toBe(true);
    expect(
      EventTransitionSchema.safeParse({
        ...staffReactivate,
        actor: agentActor,
        source: 'mcp',
        confirmationId: null,
        consequenceDigest: null,
      }).success,
    ).toBe(false);

    expect(
      EventSchema.safeParse({
        ...activeEvent('incident', 'real', 'staff'),
        allClearAt: times.later,
        reactivatedAt: times.confirmationExpiry,
      }).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse({
        ...activeEvent('incident', 'real', 'staff'),
        allClearAt: times.later,
      }).success,
    ).toBe(false);

    const staffDrillClose = {
      id: ids.transition,
      sequence: 4,
      actor: humanActor,
      source: 'web',
      occurredAt: times.later,
      requestId: ids.request,
      confirmationId: null,
      consequenceDigest: null,
      targeting: targeting('drill', 'drill', 'staff'),
      idempotencyKey: 'close-staff-drill-0001',
      transition: 'close',
      eventId: ids.event,
      from: 'all-clear',
      to: 'closed',
    } as const;
    expect(EventTransitionSchema.safeParse(staffDrillClose).success).toBe(true);
    expect(
      EventTransitionSchema.safeParse({
        ...staffDrillClose,
        actor: agentActor,
        source: 'mcp',
      }).success,
    ).toBe(false);
  });

  test('strictly binds live channel changes to a fresh authorization artifact', () => {
    const authorization = {
      reference: 'approved-production-change-001',
      integrationStatusId: ids.audit,
      integrationId: 'expo-push',
      desiredEnabled: true,
      requestDigest:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      consequenceDigest:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      authorizedByUserId: ids.actor,
      authorizedWithSessionId: ids.session,
      issuedAt: '2026-08-07T04:00:00.000Z',
      expiresAt: '2026-08-07T04:15:00.000Z',
    } as const;

    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse(authorization)
        .success,
    ).toBe(true);
    expect(
      IntegrationChannelChangeAuthorizationSchema.parse({
        ...authorization,
        integrationStatusId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        authorizedByUserId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
        authorizedWithSessionId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
      }),
    ).toMatchObject({
      integrationStatusId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorizedByUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      authorizedWithSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...authorization,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...authorization,
        expiresAt: authorization.issuedAt,
      }).success,
    ).toBe(false);
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...authorization,
        expiresAt: '2026-08-07T04:15:00.001Z',
      }).success,
    ).toBe(false);
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...authorization,
        issuedAt: '2026-08-07T04:00:00.0001Z',
      }).success,
    ).toBe(false);
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...authorization,
        expiresAt: '2026-08-07T04:15:00.0001Z',
      }).success,
    ).toBe(false);

    expect(
      SetChannelEnabledInputSchema.safeParse({
        integrationId: 'expo-push',
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      SetChannelEnabledInputSchema.safeParse({
        integrationId: 'expo-push',
        enabled: true,
        authorization: null,
      }).success,
    ).toBe(true);
    expect(
      SetChannelEnabledInputSchema.safeParse({
        integrationId: 'expo-push',
        enabled: true,
        authorization,
      }).success,
    ).toBe(true);
    expect(
      SetChannelEnabledInputSchema.safeParse({
        integrationId: 'google-groups',
        enabled: true,
        authorization,
      }).success,
    ).toBe(false);
    expect(
      SetChannelEnabledInputSchema.safeParse({
        integrationId: 'expo-push',
        enabled: false,
        authorization,
      }).success,
    ).toBe(false);

    expect(
      VerifyEmailIntegrationInputSchema.safeParse({
        integrationId: 'ses-email',
      }).success,
    ).toBe(true);
    expect(
      VerifyEmailIntegrationInputSchema.safeParse({
        integrationId: 'expo-push',
      }).success,
    ).toBe(false);
    expect(
      VerifyEmailIntegrationInputSchema.safeParse({
        integrationId: 'ses-email',
        verificationReference: 'client-supplied-evidence-is-forbidden',
      }).success,
    ).toBe(false);
  });
});

describe('human-only capability boundary', () => {
  test('catalogs room sync as the sole human-interactive reduced-success-audit query', () => {
    const sync = defineCapability('sync-event-room');
    expect(sync.operation).toBe('query');
    expect(sync.auditPolicy).toBe('denied-and-failed');
    expect(getCapabilityInvocationPolicy('sync-event-room')).toEqual({
      principalKinds: ['human'],
      sources: ['web', 'mobile'],
      agentGrantable: false,
    });
    expect(
      AgentCapabilityGrantSchema.safeParse('sync-event-room').success,
    ).toBe(false);
    expect(
      defineCapability('create-lifecycle-consequence-preview').operation,
    ).toBe('mutation');

    const reducedAuditIds = Object.values(CAPABILITY_CATALOG)
      .filter((definition) => definition.auditPolicy === 'denied-and-failed')
      .map((definition) => definition.id);
    expect(reducedAuditIds).toEqual(['sync-event-room']);
    for (const definition of Object.values(CAPABILITY_CATALOG)) {
      if (
        definition.operation === 'mutation' ||
        getCapabilityInvocationPolicy(definition.id).agentGrantable
      ) {
        expect(definition.auditPolicy).toBe('all-outcomes');
      }
    }
  });

  test('owns coherent event-room synchronization pages', () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, e: ids.event, s: 1 }),
      'utf8',
    ).toString('base64url');
    const entry = {
      id: ids.journal,
      eventId: ids.event,
      sequence: 1,
      kind: 'text',
      author: humanActor,
      source: 'web',
      serverTime: times.activated,
      clientTime: null,
      supersedes: null,
      payload: { text: 'Synthetic room update.' },
    } as const;
    const header = {
      facility: {
        id: ids.facility,
        code: 'SYN-NORTH',
        name: 'Synthetic North School',
      },
      eventType: {
        id: ids.eventTypeVersion,
        name: 'Synthetic Lockdown',
        templateMode: 'real',
      },
    } as const;
    const result = {
      eventId: ids.event,
      header,
      event: activeEvent('incident', 'real', 'staff'),
      entries: [{ visibility: 'visible', entry }],
      cursor,
      hasMore: false,
      snapshotSequence: 1,
    } as const;
    expect(EventRoomSyncResultSchema.safeParse(result).success).toBe(true);
    expect(EventRoomHeaderSchema.parse(header)).toEqual(header);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        header: {
          ...header,
          facility: { ...header.facility, id: ids.otherFacility },
        },
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        header: {
          ...header,
          eventType: { ...header.eventType, id: ids.otherFacility },
        },
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        header: {
          ...header,
          eventType: { ...header.eventType, templateMode: 'drill' },
        },
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        header: {
          ...header,
          facility: { ...header.facility, code: 'synthetic north' },
        },
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        header: undefined,
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        entries: [
          {
            visibility: 'visible',
            entry: { ...entry, eventId: ids.otherFacility },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        entries: [{ visibility: 'visible', entry: { ...entry, sequence: 2 } }],
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        event: { ...result.event, id: ids.otherFacility },
      }).success,
    ).toBe(false);
    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        event: null,
        entries: [],
        hasMore: true,
      }).success,
    ).toBe(false);

    expect(
      EventRoomSyncResultSchema.safeParse({
        ...result,
        event: null,
        entries: [],
        cursor: Buffer.from(
          JSON.stringify({ v: 1, e: ids.event, s: 1 }),
          'utf8',
        ).toString('base64url'),
      }).success,
    ).toBe(true);

    const terminal = EventRoomSyncResultSchema.parse(result);
    expect(terminal.hasMore).toBe(false);
    expect(terminal.cursor).toBe(cursor);
  });

  test('projects redacted journal reads without any original payload fields', () => {
    const metadata = {
      id: ids.journal,
      eventId: ids.event,
      sequence: 1,
      kind: 'photo',
      author: humanActor,
      source: 'web',
      serverTime: times.activated,
      clientTime: null,
      supersedes: null,
    } as const;
    const projection = JournalEntryReadProjectionSchema.parse({
      visibility: 'redacted',
      entry: metadata,
    });

    expect('payload' in projection.entry).toBe(false);
    expect(JSON.stringify(projection)).not.toContain('mediaId');
    expect(
      JournalEntryReadProjectionSchema.safeParse({
        ...projection,
        entry: { ...projection.entry, payload: { mediaId: ids.media } },
      }).success,
    ).toBe(false);
    expect(
      JournalEntryPageSchema.safeParse({
        items: [projection],
        pageInfo: { hasMore: false, nextCursor: null },
      }).success,
    ).toBe(true);
    expect(
      JournalEntryPageSchema.safeParse({
        items: [
          {
            ...metadata,
            payload: {
              mediaId: ids.media,
              altText: 'Synthetic original alt text',
              caption: null,
            },
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      }).success,
    ).toBe(false);
  });

  test('binds all-clear and close outputs to exact lifecycle and journal facts', () => {
    const allClear = syntheticAllClearResult();
    expect(AllClearEventResultSchema.safeParse(allClear).success).toBe(true);
    expect(
      AllClearEventResultSchema.safeParse({
        ...allClear,
        journalEntries: [allClear.journalEntries[0]],
      }).success,
    ).toBe(false);
    expect(
      AllClearEventResultSchema.safeParse({
        ...allClear,
        notificationIntent: {
          ...allClear.notificationIntent,
          createdAt: times.confirmationExpiry,
        },
      }).success,
    ).toBe(false);
    expect(
      AllClearEventResultSchema.safeParse({
        ...allClear,
        journalEntries: [
          {
            ...allClear.journalEntries[0],
            author: humanActor,
            source: 'web',
          },
          allClear.journalEntries[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      AllClearEventResultSchema.safeParse({
        ...allClear,
        journalEntries: [
          allClear.journalEntries[0],
          {
            ...allClear.journalEntries[1],
            serverTime: times.confirmationExpiry,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AllClearEventResultSchema.safeParse({
        ...allClear,
        journalEntries: [
          ...allClear.journalEntries,
          allClear.journalEntries[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      AllClearEventResultSchema.safeParse({
        ...allClear,
        journalEntries: [
          allClear.journalEntries[0],
          {
            ...allClear.journalEntries[1],
            payload: {
              ...allClear.journalEntries[1].payload,
              relatedRecordId: ids.outbox,
            },
          },
        ],
      }).success,
    ).toBe(false);

    const closed = syntheticCloseResult();
    expect(CloseEventResultSchema.safeParse(closed).success).toBe(true);
    expect(
      CloseEventResultSchema.safeParse({
        ...closed,
        journalEntries: [
          {
            id: ids.journal,
            eventId: ids.event,
            sequence: 4,
            kind: 'text',
            author: agentActor,
            source: 'mcp',
            serverTime: times.confirmationExpiry,
            clientTime: null,
            supersedes: null,
            payload: { text: 'Not a close fact.' },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CloseEventResultSchema.safeParse({
        ...closed,
        journalEntries: [
          {
            ...closed.journalEntries[0],
            source: 'agent-rest',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CloseEventResultSchema.safeParse({
        ...closed,
        journalEntries: [
          closed.journalEntries[0],
          {
            ...allClear.journalEntries[1],
            eventId: closed.event.id,
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('allows each protected action only for its confirmed human session', () => {
    for (const capabilityId of HUMAN_ONLY_ACTION_IDS) {
      const operationId = capabilityByProtectedAction[capabilityId];
      const common = {
        capabilityId: operationId,
        operation: 'mutation',
        scope: districtScope,
        requestId: ids.request,
        serverTime: times.activated,
        input: {},
        idempotencyKey: `protected-${capabilityId}-0001`,
        transport: webMutationTransport,
        connectivityEpochId: ids.connectivityEpoch,
        requiredHumanActionIds: [capabilityId],
        requiredConsequenceDigest: 'b'.repeat(64),
      } as const;
      const humanConfirmation = {
        id: ids.confirmation,
        capabilityId: operationId,
        actionIds: [capabilityId],
        connectivityEpochId: ids.connectivityEpoch,
        confirmedByUserId: ids.actor,
        confirmedWithSessionId: ids.session,
        consequenceDigest: 'b'.repeat(64),
        issuedAt: times.created,
        expiresAt: times.confirmationExpiry,
      } as const;

      expect(
        MutationCapabilityEnvelopeSchema.safeParse({
          ...common,
          actor: humanActor,
          source: 'web',
          humanConfirmation,
        }).success,
      ).toBe(true);
      expect(
        MutationCapabilityEnvelopeSchema.safeParse({
          ...common,
          actor: agentActor,
          source: 'mcp',
          transport: mcpMutationTransport,
          connectivityEpochId: null,
          humanConfirmation: null,
        }).success,
      ).toBe(false);
      expect(
        MutationCapabilityEnvelopeSchema.safeParse({
          ...common,
          actor: systemActor,
          source: 'scheduled-job',
          transport: scheduledMutationTransport,
          connectivityEpochId: null,
          humanConfirmation: null,
        }).success,
      ).toBe(false);
    }
  });

  test('closes capability aliases and multi-action bypasses', () => {
    const common = {
      capabilityId: 'start-event',
      operation: 'mutation',
      scope: districtScope,
      requestId: ids.request,
      serverTime: times.activated,
      input: { source: 'prepared-activation' },
      idempotencyKey: 'start-event-protected-0001',
      transport: webMutationTransport,
      connectivityEpochId: ids.connectivityEpoch,
      requiredHumanActionIds: ['start-real-incident', 'send-real-notification'],
      requiredConsequenceDigest: 'c'.repeat(64),
    } as const;
    const confirmation = {
      id: ids.confirmation,
      capabilityId: 'start-event',
      actionIds: ['start-real-incident', 'send-real-notification'],
      connectivityEpochId: ids.connectivityEpoch,
      confirmedByUserId: ids.actor,
      confirmedWithSessionId: ids.session,
      consequenceDigest: 'c'.repeat(64),
      issuedAt: times.created,
      expiresAt: times.confirmationExpiry,
    } as const;

    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        actor: agentActor,
        source: 'mcp',
        transport: mcpMutationTransport,
        connectivityEpochId: null,
        humanConfirmation: null,
      }).success,
    ).toBe(false);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        actor: humanActor,
        source: 'web',
        humanConfirmation: confirmation,
      }).success,
    ).toBe(true);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        actor: humanActor,
        source: 'web',
        humanConfirmation: {
          ...confirmation,
          actionIds: ['start-real-incident'],
        },
      }).success,
    ).toBe(false);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        actor: humanActor,
        source: 'web',
        humanConfirmation: {
          ...confirmation,
          consequenceDigest: 'd'.repeat(64),
        },
      }).success,
    ).toBe(false);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        actor: humanActor,
        source: 'web',
        humanConfirmation: {
          ...confirmation,
          connectivityEpochId: ids.previousConnectivityEpoch,
        },
      }).success,
    ).toBe(false);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        serverTime: times.afterExpiry,
        actor: humanActor,
        source: 'web',
        humanConfirmation: confirmation,
      }).success,
    ).toBe(false);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        actor: humanActor,
        source: 'web',
        transport: {
          ...webMutationTransport,
          method: 'GET',
        },
        humanConfirmation: confirmation,
      }).success,
    ).toBe(false);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        ...common,
        actor: humanActor,
        source: 'web',
        transport: {
          ...webMutationTransport,
          csrfVerified: false,
        },
        humanConfirmation: confirmation,
      }).success,
    ).toBe(false);
  });

  test('derives protected actions centrally from trusted current state', async () => {
    const startInput = {
      source: 'activation-preview',
      activationPreviewId: ids.preview,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [],
      },
    } as const;
    const centralSafetyResolver = {
      resolve: async () =>
        ({
          eventKind: 'incident',
          rosterPopulation: 'staff',
          consequenceDigest: 'e'.repeat(64),
        }) as const,
    };
    const requirement = await resolveHumanActionRequirement(
      'start-event',
      startInput,
      {
        actor: humanActor,
        source: 'web',
        scope: districtScope,
        requestId: ids.request,
        serverTime: times.activated,
        connectivityEpochId: ids.connectivityEpoch,
      },
      centralSafetyResolver,
    );
    expect(requirement).toEqual({
      actionIds: ['start-real-incident', 'send-real-notification'],
      consequenceDigest: 'e'.repeat(64),
    });
    const staffDrillCloseRequirement = await resolveHumanActionRequirement(
      'close-event',
      { eventId: ids.event },
      {
        actor: humanActor,
        source: 'web',
        scope: districtScope,
        requestId: ids.request,
        serverTime: times.activated,
        connectivityEpochId: ids.connectivityEpoch,
      },
      {
        resolve: async () => ({
          eventKind: 'drill',
          rosterPopulation: 'staff',
          consequenceDigest: 'f'.repeat(64),
        }),
      },
    );
    expect(staffDrillCloseRequirement).toEqual({
      actionIds: [],
      consequenceDigest: null,
    });
    await expect(
      resolveHumanActionRequirement(
        'close-event',
        { eventId: ids.event },
        {
          actor: agentActor,
          source: 'mcp',
          scope: districtScope,
          requestId: ids.request,
          serverTime: times.activated,
          connectivityEpochId: null,
        },
        {
          resolve: async () => ({
            eventKind: 'drill',
            rosterPopulation: 'staff',
            consequenceDigest: 'f'.repeat(64),
          }),
        },
      ),
    ).rejects.toThrow();

    expect(
      await resolveHumanActionRequirement(
        'all-clear-event',
        { eventId: ids.event, lifecyclePreviewId: ids.preview },
        {
          actor: humanActor,
          source: 'web',
          scope: districtScope,
          requestId: ids.request,
          serverTime: times.activated,
          connectivityEpochId: ids.connectivityEpoch,
        },
        {
          resolve: async () => ({
            eventKind: 'incident',
            rosterPopulation: 'staff',
            consequenceDigest: '1'.repeat(64),
          }),
        },
      ),
    ).toEqual({
      actionIds: ['all-clear', 'send-real-notification'],
      consequenceDigest: '1'.repeat(64),
    });
    expect(() =>
      Reflect.apply(defineCapability, undefined, ['activate-now']),
    ).toThrow();
  });

  test('owns one immutable signature for every callable capability ID', () => {
    const definition = defineCapability('all-clear-event');
    expect(definition.humanActionPolicy.kind).toBe('central');
    expect(definition.inputSchema).toBe(
      CAPABILITY_CATALOG['all-clear-event'].inputSchema,
    );
    expect(defineCapability('all-clear-event')).toBe(definition);
    expect(
      Reflect.apply(defineCapability, undefined, [
        'all-clear-event',
        { inputSchema: 'caller-declared-schema-is-ignored' },
      ]),
    ).toBe(definition);
    expect(() =>
      parseCapabilityInput('all-clear-event', { eventId: ids.event }),
    ).toThrow();
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.humanActionPolicy)).toBe(true);
  });

  test('bounds single-use confirmation and idempotency lifecycles', () => {
    const confirmation = {
      id: ids.confirmation,
      capabilityId: 'all-clear-event',
      actionIds: ['all-clear'],
      connectivityEpochId: ids.connectivityEpoch,
      confirmedByUserId: ids.actor,
      confirmedWithSessionId: ids.session,
      consequenceDigest: 'a'.repeat(64),
      issuedAt: times.created,
      expiresAt: times.confirmationExpiry,
    } as const;
    expect(
      HumanConfirmationRecordSchema.safeParse({
        confirmation,
        status: 'consumed',
        consumedAt: times.activated,
        consumedForRequestId: ids.request,
        expiredAt: null,
      }).success,
    ).toBe(true);
    expect(
      HumanConfirmationRecordSchema.safeParse({
        confirmation,
        status: 'consumed',
        consumedAt: times.afterExpiry,
        consumedForRequestId: ids.request,
        expiredAt: null,
      }).success,
    ).toBe(false);
    expect(
      IdempotencyRecordSchema.safeParse({
        id: ids.request,
        key: 'idempotency-record-0001',
        capabilityId: 'all-clear-event',
        principal: humanActor,
        requestDigest: 'b'.repeat(64),
        status: 'completed',
        createdAt: times.created,
        completedAt: times.later,
        resultReference: `event:${ids.event}`,
      }).success,
    ).toBe(true);
    expect(
      IdempotencyRecordSchema.safeParse({
        id: ids.request,
        key: 'idempotency-record-0001',
        capabilityId: 'all-clear-event',
        principal: humanActor,
        requestDigest: 'b'.repeat(64),
        status: 'completed',
        createdAt: times.created,
        completedAt: times.later,
        resultReference: null,
      }).success,
    ).toBe(false);
  });

  test('keeps synthetic training available without a real confirmation', () => {
    expect(
      CapabilityEnvelopeSchema.safeParse({
        capabilityId: 'all-clear-event',
        operation: 'mutation',
        actor: agentActor,
        source: 'mcp',
        scope: districtScope,
        requestId: ids.request,
        serverTime: times.activated,
        input: { rosterPopulation: 'synthetic' },
        idempotencyKey: 'synthetic-training-run-0001',
        transport: mcpMutationTransport,
        connectivityEpochId: null,
        requiredHumanActionIds: [],
        requiredConsequenceDigest: null,
        humanConfirmation: null,
      }).success,
    ).toBe(true);
  });

  test('requires one envelope idempotency key and truthful provenance', () => {
    const valid = {
      capabilityId: 'append-journal-entry',
      operation: 'mutation',
      actor: agentActor,
      source: 'agent-rest',
      scope: districtScope,
      requestId: ids.request,
      serverTime: times.activated,
      input: {},
      idempotencyKey: 'draft-message-idempotent-0001',
      transport: agentRestMutationTransport,
      connectivityEpochId: null,
      requiredHumanActionIds: [],
      requiredConsequenceDigest: null,
      humanConfirmation: null,
    } as const;
    expect(CapabilityEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...valid,
        input: { idempotencyKey: 'different-inner-key-0001' },
      }).success,
    ).toBe(false);
    const withoutIdempotency: Record<string, unknown> = { ...valid };
    delete withoutIdempotency.idempotencyKey;
    expect(CapabilityEnvelopeSchema.safeParse(withoutIdempotency).success).toBe(
      false,
    );
    expect(
      CapabilityEnvelopeSchema.safeParse({ ...valid, source: 'web' }).success,
    ).toBe(false);
  });

  test('uses a narrow verified GET envelope only for OIDC completion', () => {
    const oidcCallback = {
      capabilityId: 'complete-oidc-sign-in',
      operation: 'mutation',
      principal: {
        kind: 'verified-oidc-claims',
        issuer: 'https://accounts.google.com',
        audience: 'synthetic-psd-eoc-client',
        subject: 'synthetic-google-subject',
        subjectDigest: '2'.repeat(64),
        claimsDigest: '3'.repeat(64),
        audienceVerified: true,
        hostedDomain: 'example.invalid',
        email: 'synthetic.staff@example.invalid',
        emailVerified: true,
        displayName: 'Synthetic Staff',
      },
      source: 'web',
      requestId: ids.request,
      serverTime: times.activated,
      input: {
        claims: {
          issuer: 'https://accounts.google.com',
          audience: 'synthetic-psd-eoc-client',
          subject: 'synthetic-google-subject',
          subjectDigest: '2'.repeat(64),
          claimsDigest: '3'.repeat(64),
          hostedDomain: 'example.invalid',
          email: 'synthetic.staff@example.invalid',
          emailVerified: true,
          displayName: 'Synthetic Staff',
        },
        device: {
          platform: 'web',
          unlockMethod: 'secure-session-cookie',
          installationId: 'synthetic-installation-0001',
        },
      },
      idempotencyKey: 'oidc-callback-idempotent-0001',
      transport: {
        kind: 'oidc-code-callback',
        method: 'GET',
        stateVerified: true,
        nonceVerified: true,
        pkceVerified: true,
        signatureVerified: true,
      },
    } as const;
    expect(CapabilityEnvelopeSchema.safeParse(oidcCallback).success).toBe(true);
    expect(() =>
      parseCapabilityEnvelopeFor('complete-oidc-sign-in', oidcCallback),
    ).not.toThrow();
    const exactGroupSelectedIdentity = {
      ...oidcCallback,
      principal: {
        ...oidcCallback.principal,
        hostedDomain: 'example.org',
        email: 'selected.member@example.org',
      },
      input: {
        ...oidcCallback.input,
        claims: {
          ...oidcCallback.input.claims,
          hostedDomain: 'example.org',
          email: 'selected.member@example.org',
        },
      },
    } as const;
    expect(() =>
      parseCapabilityEnvelopeFor(
        'complete-oidc-sign-in',
        exactGroupSelectedIdentity,
      ),
    ).not.toThrow();
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...exactGroupSelectedIdentity,
        principal: {
          ...exactGroupSelectedIdentity.principal,
          email: 'Selected.Member@example.org',
        },
        input: {
          ...exactGroupSelectedIdentity.input,
          claims: {
            ...exactGroupSelectedIdentity.input.claims,
            email: 'Selected.Member@example.org',
          },
        },
      }).success,
    ).toBe(false);
    expect(() =>
      parseCapabilityEnvelopeFor('complete-oidc-sign-in', {
        ...oidcCallback,
        input: {
          ...oidcCallback.input,
          claims: {
            ...oidcCallback.input.claims,
            audience: 'attacker-client',
            subject: 'different-subject',
            subjectDigest: 'c'.repeat(64),
            claimsDigest: 'd'.repeat(64),
            email: 'different.staff@example.invalid',
          },
        },
      }),
    ).toThrow();
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...oidcCallback,
        transport: { ...oidcCallback.transport, stateVerified: false },
      }).success,
    ).toBe(false);
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...oidcCallback,
        capabilityId: 'start-event',
      }).success,
    ).toBe(false);
    expect(
      OidcCallbackRejectionEvidenceSchema.safeParse({
        checkId: ids.audit,
        issuer: 'https://accounts.google.com',
        errorCode: 'access-denied',
        responseDigest: '4'.repeat(64),
        stateVerified: true,
        checkedAt: times.activated,
      }).success,
    ).toBe(true);
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...oidcCallback,
        principal: {
          kind: 'oidc-provider-denial',
          issuer: 'https://accounts.google.com',
          errorCode: 'access-denied',
          responseDigest: '4'.repeat(64),
        },
        transport: {
          kind: 'oidc-denial-callback',
          method: 'GET',
          stateVerified: true,
        },
      }).success,
    ).toBe(false);
  });

  test('accepts only strict native OIDC transport request shapes', () => {
    const challenge = 'A'.repeat(43);
    const state = `m1.${'B'.repeat(43)}`;
    const flowToken = `m1.${'C'.repeat(16)}.${'D'.repeat(80)}`;
    expect(
      MobileOidcStartRequestSchema.parse({
        platform: 'ios',
        installationId: 'native-installation-0001',
        codeChallenge: challenge,
      }),
    ).toEqual({
      platform: 'ios',
      installationId: 'native-installation-0001',
      codeChallenge: challenge,
    });
    expect(
      MobileOidcStartRequestSchema.safeParse({
        platform: 'web',
        installationId: 'native-installation-0001',
        codeChallenge: challenge,
      }).success,
    ).toBe(false);
    expect(
      MobileOidcStartRequestSchema.safeParse({
        platform: 'android',
        installationId: 'native-installation-0001',
        codeChallenge: challenge,
        redirectUri: 'https://attacker.invalid/callback',
      }).success,
    ).toBe(false);
    expect(
      MobileOidcStartResponseSchema.safeParse({
        clientId: 'synthetic-client.apps.googleusercontent.com',
        authorizationUrl: 'http://127.0.0.1:4106/authorize',
        flowToken,
        state,
        appRedirectUri: 'psdeoc://auth/callback',
        expiresAt: times.previewExpiry,
      }).success,
    ).toBe(true);
    expect(
      MobileOidcStartResponseSchema.safeParse({
        clientId: 'synthetic-client.apps.googleusercontent.com',
        authorizationUrl: 'http://[::1]:4106/authorize',
        flowToken,
        state,
        appRedirectUri: 'psdeoc://auth/callback',
        expiresAt: times.previewExpiry,
      }).success,
    ).toBe(true);
    expect(
      MobileOidcStartResponseSchema.safeParse({
        clientId: 'synthetic-client.apps.googleusercontent.com',
        authorizationUrl: 'http://attacker.invalid/authorize',
        flowToken,
        state,
        appRedirectUri: 'psdeoc://auth/callback',
        expiresAt: times.previewExpiry,
      }).success,
    ).toBe(false);
    expect(
      MobileOidcExchangeRequestSchema.safeParse({
        authorizationCode: 'synthetic-one-time-code',
        state,
        codeVerifier: 'v'.repeat(64),
        flowToken,
      }).success,
    ).toBe(true);
    expect(
      MobileOidcExchangeRequestSchema.safeParse({
        authorizationCode: 'synthetic-one-time-code',
        state,
        codeVerifier: 'too-short',
        flowToken,
      }).success,
    ).toBe(false);
    expect(OpaqueSessionBearerSchema.safeParse('z'.repeat(43)).success).toBe(
      true,
    );
    expect(OpaqueSessionBearerSchema.safeParse('plain-token').success).toBe(
      false,
    );
  });

  test('admits verified native OIDC only through the mobile exchange transport', () => {
    const claims = {
      issuer: 'https://accounts.google.com',
      audience: 'synthetic-psd-eoc-client',
      subject: 'synthetic-google-subject',
      subjectDigest: '2'.repeat(64),
      claimsDigest: '3'.repeat(64),
      hostedDomain: 'example.invalid',
      email: 'synthetic.staff@example.invalid',
      emailVerified: true,
      displayName: 'Synthetic Staff',
    } as const;
    const mobileExchange = {
      capabilityId: 'complete-oidc-sign-in',
      operation: 'mutation',
      principal: {
        kind: 'verified-oidc-claims',
        ...claims,
        audienceVerified: true,
      },
      source: 'mobile',
      requestId: ids.request,
      serverTime: times.activated,
      input: {
        claims,
        device: {
          platform: 'android',
          unlockMethod: 'biometric',
          installationId: 'native-installation-0001',
        },
      },
      idempotencyKey: 'oidc-mobile-idempotent-0001',
      transport: {
        kind: 'mobile-oidc-code-exchange',
        method: 'POST',
        stateVerified: true,
        nonceVerified: true,
        pkceVerified: true,
        signatureVerified: true,
      },
    } as const;
    expect(() =>
      parseCapabilityEnvelopeFor('complete-oidc-sign-in', mobileExchange),
    ).not.toThrow();
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...mobileExchange,
        source: 'web',
      }).success,
    ).toBe(false);
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...mobileExchange,
        transport: {
          ...mobileExchange.transport,
          pkceVerified: false,
        },
      }).success,
    ).toBe(false);
    expect(
      (() => {
        try {
          parseCapabilityEnvelopeFor('complete-oidc-sign-in', {
            ...mobileExchange,
            input: {
              ...mobileExchange.input,
              device: {
                ...mobileExchange.input.device,
                unlockMethod: 'secure-session-cookie',
              },
            },
          });
          return true;
        } catch {
          return false;
        }
      })(),
    ).toBe(false);
  });

  test('refreshes only a verified current credential without fabricating a session actor', () => {
    const refresh = {
      capabilityId: 'refresh-session',
      operation: 'mutation',
      principal: {
        kind: 'verified-current-refresh-credential',
        verificationId: ids.audit,
        userId: ids.actor,
        sessionId: ids.session,
        deviceEnrollmentId: ids.device,
        recordRef: {
          kind: 'initial-issuance',
          issuanceId: ids.tokenIssuance,
        },
        presentedTokenDigest: '4'.repeat(64),
        credentialGeneration: 1,
        credentialState: 'current',
        sessionState: 'active',
        deviceState: 'active',
        sessionExpiresAt: times.sessionExpiry,
        verifiedAt: times.activated,
      },
      source: 'web',
      requestId: ids.request,
      serverTime: times.activated,
      input: {},
      idempotencyKey: 'refresh-session-idempotent-0001',
      transport: {
        kind: 'web-refresh-cookie',
        method: 'POST',
        csrfVerified: true,
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      },
    } as const;
    expect(CapabilityEnvelopeSchema.safeParse(refresh).success).toBe(true);
    expect(parseCapabilityInput('refresh-session', {})).toEqual({});
    expect(() =>
      parseCapabilityInput('refresh-session', { sessionId: ids.session }),
    ).toThrow();
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...refresh,
        actor: humanActor,
      }).success,
    ).toBe(false);
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...refresh,
        capabilityId: 'start-event',
      }).success,
    ).toBe(false);
    expect(
      CapabilityEnvelopeSchema.safeParse({
        ...refresh,
        serverTime: times.later,
      }).success,
    ).toBe(false);
    expect(
      MutationCapabilityEnvelopeSchema.safeParse({
        capabilityId: 'refresh-session',
        operation: 'mutation',
        actor: humanActor,
        source: 'web',
        scope: districtScope,
        requestId: ids.request,
        serverTime: times.activated,
        input: {},
        idempotencyKey: 'refresh-session-idempotent-0002',
        transport: webMutationTransport,
        connectivityEpochId: ids.connectivityEpoch,
        requiredHumanActionIds: [],
        requiredConsequenceDigest: null,
        humanConfirmation: null,
      }).success,
    ).toBe(false);

    const rejection = {
      checkId: ids.audit,
      presentedTokenDigest: '5'.repeat(64),
      checkedAt: times.activated,
    } as const;
    expect(
      RefreshCredentialRejectionEvidenceSchema.safeParse({
        ...rejection,
        reason: 'session-expired',
        sessionId: ids.session,
        expiresAt: times.sessionExpiry,
      }).success,
    ).toBe(false);
    expect(
      RefreshCredentialRejectionEvidenceSchema.safeParse({
        ...rejection,
        reason: 'device-revoked',
        sessionId: ids.session,
        deviceEnrollmentId: ids.device,
        revokedAt: times.sessionExpiry,
      }).success,
    ).toBe(false);
    expect(
      RefreshCredentialRejectionEvidenceSchema.safeParse({
        ...rejection,
        reason: 'device-revoked',
        sessionId: ids.session,
        deviceEnrollmentId: ids.device,
        revokedAt: times.created,
      }).success,
    ).toBe(true);
  });

  test('rejects protected query registration and query envelopes', () => {
    expect(
      CapabilityEnvelopeSchema.safeParse({
        capabilityId: 'all-clear',
        operation: 'query',
        actor: humanActor,
        source: 'web',
        scope: districtScope,
        requestId: ids.request,
        serverTime: times.activated,
        input: {},
      }).success,
    ).toBe(false);
    expect(() =>
      Reflect.apply(defineCapability, undefined, ['start-real-incident']),
    ).toThrow();
    expect(() =>
      Reflect.apply(defineCapability, undefined, ['activate-now']),
    ).toThrow();
    expect(defineCapability('start-event').operation).toBe('mutation');
    expect(Object.keys(CAPABILITY_CATALOG).sort()).toEqual(
      [
        ...Object.keys(CAPABILITY_MUTATION_SAFETY_MANIFEST),
        ...Object.keys(CAPABILITY_QUERY_MANIFEST),
      ].sort(),
    );
    expect(
      CapabilityEnvelopeSchema.safeParse({
        capabilityId: 'list-active-events',
        operation: 'query',
        actor: humanActor,
        source: 'web',
        scope: districtScope,
        requestId: ids.request,
        serverTime: times.activated,
        input: {},
      }).success,
    ).toBe(true);
  });

  test('keeps authentication and provider-truth capabilities off agent keys', () => {
    expect(AgentCapabilityGrantSchema.safeParse('get-event').success).toBe(
      true,
    );
    for (const capabilityId of [
      'complete-oidc-sign-in',
      'refresh-session',
      'sync-access-membership',
      'dispatch-outbox',
      'record-delivery-evidence',
      'issue-agent-api-key',
    ]) {
      expect(AgentCapabilityGrantSchema.safeParse(capabilityId).success).toBe(
        false,
      );
    }

    expect(getCapabilityInvocationPolicy('sync-access-membership')).toEqual({
      principalKinds: ['system'],
      sources: ['scheduled-job'],
      agentGrantable: false,
    });
    // The sync takes no parameters. It used to carry the one permitted group
    // address and a staged/finalize transition phase, which is how the trusted
    // group became unchangeable without a source edit; the groups are rows now
    // and the command simply reads them.
    expect(SyncAccessMembershipInputSchema.safeParse({}).success).toBe(true);
    expect(
      SyncAccessMembershipInputSchema.safeParse({
        designatedGroupEmail: 'anything@example.invalid',
      }).success,
    ).toBe(false);
    expect(
      SyncAccessMembershipInputSchema.safeParse({
        transition: { phase: 'stage' },
      }).success,
    ).toBe(false);

    expect(
      SyncAccessMembershipResultSchema.safeParse({
        snapshotId: ids.membershipSnapshot,
        snapshotVersion: 2,
        capturedAt: times.activated,
        activeAccessGroupCount: 2,
        evaluatedMembershipCount: 1,
        membershipDigest: 'a'.repeat(64),
        providerGroupIdDigest: 'b'.repeat(64),
        publication: 'created',
      }).success,
    ).toBe(true);
    expect(
      SyncAccessMembershipResultSchema.safeParse({
        snapshotId: ids.membershipSnapshot,
        snapshotVersion: 3,
        capturedAt: times.activated,
        activeAccessGroupCount: 1,
        evaluatedMembershipCount: 1,
        membershipDigest: 'a'.repeat(64),
        providerGroupIdDigest: 'b'.repeat(64),
        publication: 'already-current',
      }).success,
    ).toBe(true);
    // No phase, no designated source, no proof kind: the retired transition
    // protocol must not parse back into the result.
    expect(
      SyncAccessMembershipResultSchema.safeParse({
        phase: 'stage',
        snapshotId: ids.membershipSnapshot,
        snapshotVersion: 4,
        capturedAt: times.activated,
        activeAccessGroupCount: 1,
        evaluatedMembershipCount: 1,
        membershipDigest: 'a'.repeat(64),
        providerGroupIdDigest: 'b'.repeat(64),
        publication: 'created',
      }).success,
    ).toBe(false);

    const providerInput = {
      subject: { kind: 'attempt', attemptId: ids.attempt },
      state: 'delivered',
      provider: 'synthetic-provider',
      providerReference: 'synthetic-delivery-reference',
      proof: {
        kind: 'provider-delivery-receipt',
        provider: 'synthetic-provider',
        receiptId: 'synthetic-delivery-receipt',
        deliveredAt: times.activated,
      },
      reasonCode: null,
      diagnosticDigest: null,
    } as const;
    const envelope = {
      capabilityId: 'record-delivery-evidence',
      operation: 'mutation',
      actor: agentActor,
      source: 'mcp',
      scope: districtScope,
      requestId: ids.request,
      serverTime: times.later,
      input: providerInput,
      idempotencyKey: 'provider-evidence-idempotent-0001',
      transport: mcpMutationTransport,
      connectivityEpochId: null,
      requiredHumanActionIds: [],
      requiredConsequenceDigest: null,
      humanConfirmation: null,
    } as const;
    expect(CapabilityEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(() =>
      parseCapabilityEnvelopeFor('record-delivery-evidence', envelope),
    ).toThrow();
    expect(() =>
      parseCapabilityEnvelopeFor('record-delivery-evidence', {
        ...envelope,
        actor: systemActor,
        source: 'webhook',
        transport: { kind: 'webhook-delivery' },
      }),
    ).not.toThrow();
  });

  test('limits SMS lifecycle persistence to authenticated system producers and exact provider provenance', () => {
    expect(getCapabilityInvocationPolicy('record-endpoint-status')).toEqual({
      principalKinds: ['system'],
      sources: ['worker', 'webhook'],
      agentGrantable: false,
    });
    expect(getCapabilityInvocationPolicy('record-sms-opt-out')).toEqual({
      principalKinds: ['system'],
      sources: ['worker', 'scheduled-job'],
      agentGrantable: false,
    });

    const active = {
      rosterSnapshotId: ids.roster,
      recipientId: ids.recipient,
      endpointId: ids.smsEndpoint,
      status: 'active',
      reasonCode: SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
      provider: SMS_LIFECYCLE_PROVIDER,
      providerReference: 'synthetic-opt-in-proof',
      providerOccurredAt: '2026-08-11T18:00:00.000Z',
    } as const;
    expect(RecordEndpointStatusInputSchema.safeParse(active).success).toBe(
      true,
    );
    const nonProviderStatus = {
      rosterSnapshotId: ids.roster,
      recipientId: ids.recipient,
      endpointId: ids.smsEndpoint,
      status: 'invalid',
      reasonCode: 'PUSH_TOKEN_INVALID',
    } as const;
    expect(RecordEndpointStatusInputSchema.parse(nonProviderStatus)).toEqual(
      nonProviderStatus,
    );
    expect(
      RecordEndpointStatusInputSchema.safeParse({
        ...nonProviderStatus,
        provider: null,
        providerReference: null,
        providerOccurredAt: null,
      }).success,
    ).toBe(false);
    for (const partialProvider of [
      { provider: SMS_LIFECYCLE_PROVIDER },
      {
        provider: SMS_LIFECYCLE_PROVIDER,
        providerReference: 'synthetic-incomplete-proof',
      },
      {
        provider: SMS_LIFECYCLE_PROVIDER,
        providerOccurredAt: '2026-08-11T18:00:00.000Z',
      },
    ]) {
      expect(
        RecordEndpointStatusInputSchema.safeParse({
          ...nonProviderStatus,
          ...partialProvider,
        }).success,
      ).toBe(false);
    }
    expect(RecordEndpointStatusInputSchema.parse(active)).toEqual(active);
    for (const reservedReason of [
      SMS_OPT_OUT_REASON_CODE,
      SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
    ]) {
      expect(
        RecordEndpointStatusInputSchema.safeParse({
          ...nonProviderStatus,
          reasonCode: reservedReason,
        }).success,
      ).toBe(false);
    }
    const endpointStatusEnvelope = {
      capabilityId: 'record-endpoint-status',
      operation: 'mutation',
      actor: systemActor,
      source: 'worker',
      scope: districtScope,
      requestId: ids.request,
      serverTime: times.later,
      input: {
        ...nonProviderStatus,
      },
      idempotencyKey: 'endpoint-status-worker-idempotent-0001',
      transport: { kind: 'worker-execution' },
      connectivityEpochId: null,
      requiredHumanActionIds: [],
      requiredConsequenceDigest: null,
      humanConfirmation: null,
    } as const;
    expect(() =>
      parseCapabilityEnvelopeFor(
        'record-endpoint-status',
        endpointStatusEnvelope,
      ),
    ).not.toThrow();
    expect(() =>
      parseCapabilityEnvelopeFor('record-endpoint-status', {
        ...endpointStatusEnvelope,
        actor: agentActor,
        source: 'mcp',
        transport: mcpMutationTransport,
      }),
    ).toThrow();
    expect(
      RecordEndpointStatusInputSchema.safeParse({
        ...active,
        providerReference: null,
      }).success,
    ).toBe(false);
    expect(
      RecordEndpointStatusInputSchema.safeParse({
        ...active,
        reasonCode: 'ARBITRARY_REENABLE',
      }).success,
    ).toBe(false);
    expect(
      RecordEndpointStatusInputSchema.safeParse({
        ...active,
        status: 'invalid',
        reasonCode: 'SYNTHETIC_INVALID',
      }).success,
    ).toBe(false);

    const optedOut = {
      ...active,
      status: 'disabled',
      reasonCode: SMS_OPT_OUT_REASON_CODE,
      providerReference: 'synthetic-opt-out-proof',
    } as const;
    expect(RecordEndpointStatusInputSchema.safeParse(optedOut).success).toBe(
      true,
    );
    expect(
      RecordEndpointStatusInputSchema.safeParse({
        ...optedOut,
        provider: null,
        providerReference: null,
        providerOccurredAt: null,
      }).success,
    ).toBe(false);

    expect(
      SmsLifecycleCapabilityContextSchema.safeParse({
        actor: { kind: 'system', serviceId: 'sms-worker' },
        source: 'worker',
        transport: 'sqs',
        requestId: ids.request,
        authenticated: true,
      }).success,
    ).toBe(true);
    expect(
      SmsLifecycleCapabilityContextSchema.safeParse({
        actor: { kind: 'system', serviceId: 'sms-opt-in-webhook' },
        source: 'worker',
        transport: 'sqs',
        requestId: ids.request,
        authenticated: true,
      }).success,
    ).toBe(false);
  });
});

describe('append-only journal contract', () => {
  const textEntry = {
    id: ids.journal,
    eventId: ids.event,
    sequence: 2,
    author: humanActor,
    source: 'mobile',
    serverTime: times.later,
    clientTime: times.activated,
    supersedes: null,
    kind: 'text',
    payload: { text: 'Synthetic exercise update.' },
  } as const;

  test('parses a strict frozen shape with no mutation fields', () => {
    const parsed = JournalEntrySchema.parse(textEntry);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);
    expect(
      JournalEntrySchema.safeParse({ ...textEntry, updatedAt: times.later })
        .success,
    ).toBe(false);
    expect(
      JournalEntrySchema.safeParse({ ...textEntry, deletedAt: times.later })
        .success,
    ).toBe(false);
    expect(() => Object.assign(parsed, { sequence: 99 })).toThrow();
  });

  test('requires backward supersession and truthful actor/source provenance', () => {
    expect(
      JournalEntrySchema.safeParse({
        ...textEntry,
        supersedes: {
          entryId: ids.earlierJournal,
          entrySequence: 1,
          kind: 'correction',
          reason: 'Correct synthetic wording.',
        },
      }).success,
    ).toBe(true);
    expect(
      JournalEntrySchema.safeParse({
        ...textEntry,
        supersedes: {
          entryId: ids.earlierJournal,
          entrySequence: 2,
          kind: 'correction',
          reason: 'Not earlier.',
        },
      }).success,
    ).toBe(false);
    expect(
      JournalEntrySchema.safeParse({
        ...textEntry,
        author: agentActor,
        source: 'web',
      }).success,
    ).toBe(false);
  });

  test('derives lifecycle system facts only from validated transitions', () => {
    const staffTarget = targeting('incident', 'real', 'staff');
    const allClearTransition = {
      id: ids.transition,
      sequence: 2,
      actor: humanActor,
      source: 'web',
      occurredAt: times.later,
      requestId: ids.request,
      confirmationId: ids.confirmation,
      consequenceDigest: 'a'.repeat(64),
      targeting: staffTarget,
      idempotencyKey: 'all-clear-staff-event-0001',
      transition: 'all-clear',
      eventId: ids.event,
      from: 'active',
      to: 'all-clear',
      notificationAuthorization: lifecycleAuthorization(
        'all-clear',
        staffTarget,
      ),
    } as const;
    const lifecycleEntry = {
      id: ids.journal,
      eventId: ids.event,
      sequence: 3,
      author: humanActor,
      source: 'web',
      serverTime: times.later,
      clientTime: null,
      supersedes: null,
      kind: 'system',
      payload: {
        code: 'all-clear-issued',
        summary: 'A human issued all-clear.',
        transition: allClearTransition,
      },
    } as const;
    expect(JournalEntrySchema.safeParse(lifecycleEntry).success).toBe(true);
    expect(
      JournalEntrySchema.safeParse({
        ...lifecycleEntry,
        author: agentActor,
        source: 'mcp',
        payload: {
          ...lifecycleEntry.payload,
          transition: {
            ...allClearTransition,
            actor: agentActor,
            source: 'mcp',
            confirmationId: null,
            consequenceDigest: null,
          },
        },
      }).success,
    ).toBe(false);

    const syntheticTarget = targeting('test', 'drill', 'synthetic');
    expect(
      JournalEntrySchema.safeParse({
        ...lifecycleEntry,
        author: agentActor,
        source: 'mcp',
        payload: {
          ...lifecycleEntry.payload,
          transition: {
            ...allClearTransition,
            actor: agentActor,
            source: 'mcp',
            confirmationId: null,
            consequenceDigest: null,
            targeting: syntheticTarget,
            notificationAuthorization: lifecycleAuthorization(
              'all-clear',
              syntheticTarget,
            ),
          },
        },
      }).success,
    ).toBe(true);
    expect(
      JournalEntryInputSchema.safeParse({
        eventId: ids.event,
        clientTime: null,
        supersedes: null,
        kind: 'system',
        payload: lifecycleEntry.payload,
      }).success,
    ).toBe(false);
  });
});

describe('notification delivery truth', () => {
  const commonEvidence = {
    id: ids.evidence,
    sequence: 1,
    previousEvidenceId: null,
    recordedAt: times.later,
    provider: null,
    providerReference: null,
    proof: null,
    reasonCode: null,
    diagnosticDigest: null,
  } as const;
  const intentSubject = { kind: 'intent', intentId: ids.intent } as const;
  const attemptSubject = { kind: 'attempt', attemptId: ids.attempt } as const;

  test('represents every state, including unknown, at its truthful subject', () => {
    expect(DeliveryTruthStateSchema.options).toEqual([
      'accepted',
      'recorded',
      'attempted',
      'provider-accepted',
      'delivered',
      'failed',
      'expired',
      'unknown',
    ]);
    for (const state of ['accepted', 'recorded'] as const) {
      expect(
        DeliveryEvidenceSchema.safeParse({
          ...commonEvidence,
          subject: intentSubject,
          state,
        }).success,
      ).toBe(true);
    }
    expect(
      DeliveryEvidenceSchema.safeParse({
        ...commonEvidence,
        subject: attemptSubject,
        state: 'attempted',
      }).success,
    ).toBe(true);
    expect(
      DeliveryEvidenceSchema.safeParse({
        ...commonEvidence,
        subject: attemptSubject,
        state: 'provider-accepted',
        provider: 'synthetic-provider',
        providerReference: 'synthetic-acceptance-reference',
      }).success,
    ).toBe(true);
    expect(
      DeliveryEvidenceSchema.safeParse({
        ...commonEvidence,
        subject: attemptSubject,
        state: 'delivered',
        provider: 'synthetic-provider',
        providerReference: 'synthetic-delivery-reference',
        proof: {
          kind: 'provider-delivery-receipt',
          provider: 'synthetic-provider',
          receiptId: 'synthetic-delivery-receipt',
          deliveredAt: times.activated,
        },
      }).success,
    ).toBe(true);
    for (const state of ['failed', 'expired', 'unknown'] as const) {
      expect(
        DeliveryEvidenceSchema.safeParse({
          ...commonEvidence,
          subject: attemptSubject,
          state,
          reasonCode: `SYNTHETIC_${state.toUpperCase()}`,
          diagnosticDigest: 'd'.repeat(64),
        }).success,
      ).toBe(true);
    }
    expect(
      DeliveryEvidenceSchema.safeParse({
        ...commonEvidence,
        subject: attemptSubject,
        state: 'failed',
        reasonCode: 'raw provider said recipient@example.com failed',
      }).success,
    ).toBe(false);
  });

  test('does not overstate provider acceptance or mismatched proof', () => {
    const delivered = {
      ...commonEvidence,
      subject: attemptSubject,
      state: 'delivered',
      provider: 'synthetic-provider',
      providerReference: 'delivery-reference',
      proof: {
        kind: 'provider-delivery-receipt',
        provider: 'synthetic-provider',
        receiptId: 'delivery-receipt',
        deliveredAt: times.activated,
      },
    } as const;
    expect(DeliveryEvidenceSchema.safeParse(delivered).success).toBe(true);
    expect(
      DeliveryEvidenceSchema.safeParse({ ...delivered, proof: null }).success,
    ).toBe(false);
    expect(
      DeliveryEvidenceSchema.safeParse({
        ...delivered,
        proof: { ...delivered.proof, provider: 'different-provider' },
      }).success,
    ).toBe(false);
    expect(
      DeliveryEvidenceSchema.safeParse({
        ...delivered,
        proof: { ...delivered.proof, deliveredAt: times.sessionExpiry },
      }).success,
    ).toBe(false);
    expect(
      DeliveryEvidenceSchema.safeParse({
        ...commonEvidence,
        subject: attemptSubject,
        state: 'accepted',
      }).success,
    ).toBe(false);
  });

  test('allows only monotonic evidence transitions, including late truth', () => {
    expect(
      DeliveryTruthTransitionSchema.safeParse({
        subjectKind: 'attempt',
        from: 'provider-accepted',
        to: 'unknown',
      }).success,
    ).toBe(true);
    expect(
      DeliveryTruthTransitionSchema.safeParse({
        subjectKind: 'attempt',
        from: 'unknown',
        to: 'delivered',
      }).success,
    ).toBe(true);
    expect(
      DeliveryTruthTransitionSchema.safeParse({
        subjectKind: 'attempt',
        from: 'unknown',
        to: 'provider-accepted',
      }).success,
    ).toBe(true);
    expect(
      DeliveryTruthTransitionSchema.safeParse({
        subjectKind: 'attempt',
        from: 'delivered',
        to: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      DeliveryTruthTransitionSchema.safeParse({
        subjectKind: 'attempt',
        from: 'failed',
        to: 'delivered',
      }).success,
    ).toBe(false);
  });
});

describe('notification and outbox classification continuity', () => {
  test('accepts only complete, exact, classification-safe mobile push data', () => {
    const payload = {
      version: 1,
      eventId: ids.event,
      eventKind: 'incident',
      templateMode: 'real',
      facilityId: ids.facility,
      eventTypeVersionId: ids.eventTypeVersion,
      purpose: 'activation',
    } as const;

    const parsed = MobilePushReceivePayloadSchema.parse(payload);
    expect(parsed).toEqual(payload);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      MobilePushReceivePayloadSchema.safeParse({
        ...payload,
        eventKind: 'drill',
      }).success,
    ).toBe(false);
    expect(
      MobilePushReceivePayloadSchema.safeParse({
        ...payload,
        facilityId: undefined,
      }).success,
    ).toBe(false);
    expect(
      MobilePushReceivePayloadSchema.safeParse({
        ...payload,
        site: 'untrusted display text',
      }).success,
    ).toBe(false);
  });

  test('binds token-free push send eligibility to one exact native endpoint', () => {
    const input = {
      version: 1,
      rosterSnapshotId: ids.roster,
      rosterPopulation: 'staff',
      recipientId: ids.recipient,
      endpointId: ids.endpoint,
      platform: 'ios',
      tokenDigest: 'a'.repeat(64),
    } as const;

    expect(PushEndpointSendEligibilityInputSchema.parse(input)).toEqual(input);
    expect(
      PushEndpointSendEligibilityInputSchema.safeParse({
        ...input,
        tokenDigest: 'ExponentPushToken[forbidden]',
      }).success,
    ).toBe(false);
    expect(
      PushEndpointSendEligibilityInputSchema.safeParse({ ...input, token: 'x' })
        .success,
    ).toBe(false);
    expect(
      PushEndpointSendEligibilityResultSchema.safeParse({
        version: 1,
        eligible: false,
      }).success,
    ).toBe(true);
  });

  test('pins fresh purpose-specific all-clear authorization and copy', () => {
    const staffTarget = targeting('incident', 'real', 'staff');
    const allClearIntent = {
      id: ids.intent,
      eventId: ids.event,
      ...notificationClassification('incident', 'real', 'staff'),
      purpose: 'all-clear',
      eventTypeVersion: realTypeRef,
      rosterSnapshotId: ids.roster,
      createdBy: humanActor,
      source: 'web',
      requestId: ids.request,
      authorization: lifecycleAuthorization('all-clear', staffTarget),
      channels: channelPlan(staffTarget, 'all-clear'),
      createdAt: times.created,
    } as const;
    expect(NotificationIntentSchema.safeParse(allClearIntent).success).toBe(
      true,
    );
    expect(
      NotificationIntentSchema.safeParse({
        ...allClearIntent,
        authorization: activationAuthorization(staffTarget),
      }).success,
    ).toBe(false);
    expect(
      NotificationIntentSchema.safeParse({
        ...allClearIntent,
        channels: channelPlan(staffTarget, 'activation'),
      }).success,
    ).toBe(false);
  });

  test('pins type, roster, audience, and classification through the send', () => {
    const staffTarget = targeting('incident', 'real', 'staff');
    const intent = {
      id: ids.intent,
      eventId: ids.event,
      ...notificationClassification('incident', 'real', 'staff'),
      purpose: 'activation',
      eventTypeVersion: realTypeRef,
      rosterSnapshotId: ids.roster,
      createdBy: humanActor,
      source: 'web',
      requestId: ids.request,
      authorization: activationAuthorization(staffTarget),
      channels: channelPlan(staffTarget),
      createdAt: times.created,
    } as const;
    expect(NotificationIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      NotificationIntentSchema.safeParse({
        ...intent,
        templateMode: 'drill',
      }).success,
    ).toBe(false);
    expect(
      NotificationIntentSchema.safeParse({
        ...intent,
        createdBy: agentActor,
      }).success,
    ).toBe(false);

    const syntheticTarget = targeting('test', 'drill', 'synthetic');
    const batch = {
      id: ids.batch,
      intentId: ids.intent,
      eventId: ids.event,
      facilityId: ids.facility,
      ...notificationClassification('test', 'drill', 'synthetic'),
      purpose: 'activation',
      eventTypeVersion: drillTypeRef,
      rosterSnapshotId: ids.roster,
      requestId: ids.request,
      authorization: activationAuthorization(syntheticTarget),
      channel: 'push',
      renderedMessage: renderedMessage('push', syntheticTarget),
      integrationStatus: integrationStatus('push', 'synthetic'),
      sequence: 1,
      endpointCount: 1,
      createdAt: times.created,
    } as const;
    expect(DispatchBatchSchema.safeParse(batch).success).toBe(true);
    expect(
      DispatchBatchSchema.safeParse({
        ...batch,
        rosterPopulation: 'staff',
      }).success,
    ).toBe(false);
    expect(
      NotificationStatusSchema.safeParse({
        intent,
        batches: [batch],
        stateCounts: [],
        generatedAt: times.later,
      }).success,
    ).toBe(false);

    const attempt = {
      id: ids.attempt,
      batchId: ids.batch,
      intentId: ids.intent,
      eventId: ids.event,
      ...notificationClassification('test', 'drill', 'synthetic'),
      purpose: 'activation',
      eventTypeVersion: drillTypeRef,
      rosterSnapshotId: ids.roster,
      recipientId: ids.recipient,
      endpointId: ids.endpoint,
      channel: 'push',
      attemptNumber: 1,
      attemptedAt: times.later,
    } as const;
    expect(ChannelAttemptSchema.safeParse(attempt).success).toBe(true);
    expect(
      ChannelAttemptSchema.safeParse({
        ...attempt,
        eventTypeVersion: realTypeRef,
      }).success,
    ).toBe(false);
  });

  test('allows only synthetic drill/test intents for agents', () => {
    const syntheticTarget = targeting('drill', 'drill', 'synthetic');
    const syntheticDrill = {
      id: ids.intent,
      eventId: ids.event,
      ...notificationClassification('drill', 'drill', 'synthetic'),
      purpose: 'activation',
      eventTypeVersion: drillTypeRef,
      rosterSnapshotId: ids.roster,
      createdBy: agentActor,
      source: 'mcp',
      requestId: ids.request,
      authorization: activationAuthorization(syntheticTarget),
      channels: channelPlan(syntheticTarget),
      createdAt: times.created,
    } as const;
    expect(NotificationIntentSchema.safeParse(syntheticDrill).success).toBe(
      true,
    );
    expect(
      NotificationIntentSchema.safeParse({
        ...syntheticDrill,
        rosterPopulation: 'staff',
      }).success,
    ).toBe(false);
  });

  test('keeps the outbox destination-free and classification-pinned', () => {
    const syntheticTarget = targeting('drill', 'drill', 'synthetic');
    const message = {
      version: 2,
      outboxId: ids.outbox,
      intentId: ids.intent,
      eventId: ids.event,
      facilityId: ids.facility,
      ...notificationClassification('drill', 'drill', 'synthetic'),
      purpose: 'activation',
      eventTypeVersion: drillTypeRef,
      rosterSnapshotId: ids.roster,
      requestId: ids.request,
      authorization: activationAuthorization(syntheticTarget),
      channels: channelPlan(syntheticTarget),
      createdAt: times.created,
    } as const;
    expect(NotificationOutboxMessageSchema.safeParse(message).success).toBe(
      true,
    );
    const { facilityId: version2FacilityId, ...legacyFields } = message;
    expect(version2FacilityId).toBe(ids.facility);
    const legacyMessage = { ...legacyFields, version: 1 } as const;
    expect(
      NotificationOutboxMessageSchema.safeParse(legacyMessage).success,
    ).toBe(true);
    expect(NotificationOutboxMessageSchema.parse(legacyMessage)).toEqual(
      legacyMessage,
    );
    expect(
      NotificationOutboxMessageSchema.safeParse({
        ...legacyMessage,
        facilityId: ids.facility,
      }).success,
    ).toBe(false);
    expect(
      NotificationOutboxMessageSchema.safeParse({
        ...message,
        facilityId: undefined,
      }).success,
    ).toBe(false);
    expect(
      NotificationOutboxMessageSchema.safeParse({
        ...message,
        version: 3,
      }).success,
    ).toBe(false);
    expect(
      NotificationOutboxMessageSchema.safeParse({
        ...message,
        templateMode: 'real',
      }).success,
    ).toBe(false);
    expect(
      NotificationOutboxMessageSchema.safeParse({
        ...message,
        destination: 'somebody@example.invalid',
      }).success,
    ).toBe(false);

    const record = {
      id: ids.outbox,
      message,
      status: 'pending',
      attempts: 0,
      availableAt: times.created,
      lockedUntil: null,
      publishedAt: null,
      failedAt: null,
      lastErrorCode: null,
    } as const;
    expect(OutboxRecordSchema.safeParse(record).success).toBe(true);
    expect(
      OutboxRecordSchema.safeParse({
        ...record,
        status: 'processing',
      }).success,
    ).toBe(false);
    expect(
      OutboxRecordSchema.safeParse({
        ...record,
        status: 'published',
        publishedAt: times.later,
      }).success,
    ).toBe(true);

    const batchIds = [ids.batch, ids.attempt, ids.evidence] as const;
    const batches = message.channels.map((plan, index) =>
      DispatchBatchSchema.parse({
        id: batchIds[index],
        intentId: message.intentId,
        eventId: message.eventId,
        facilityId: ids.facility,
        eventKind: message.eventKind,
        templateMode: message.templateMode,
        purpose: message.purpose,
        eventTypeVersion: message.eventTypeVersion,
        rosterSnapshotId: message.rosterSnapshotId,
        rosterPopulation: message.rosterPopulation,
        requestId: message.requestId,
        authorization: message.authorization,
        channel: plan.channel,
        renderedMessage: plan.renderedMessage,
        integrationStatus: plan.integrationStatus,
        sequence: index + 1,
        endpointCount: plan.endpointCount,
        createdAt: message.createdAt,
      }),
    );
    const result = {
      facilityId: ids.facility,
      outboxRecord: record,
      batches,
    } as const;
    expect(DispatchOutboxResultSchema.safeParse(result).success).toBe(true);
    expect(
      DispatchOutboxResultSchema.safeParse({
        ...result,
        outboxRecord: { ...record, message: legacyMessage },
      }).success,
    ).toBe(true);
    expect(
      DispatchOutboxResultSchema.safeParse({
        ...result,
        facilityId: ids.otherFacility,
      }).success,
    ).toBe(false);
  });
});

describe('roster, facility, and identity boundaries', () => {
  test('keeps organization identity display-safe and byte-bounded', () => {
    expect(Contracts.OrganizationNameSchema.parse('  Example District  ')).toBe(
      'Example District',
    );
    expect(
      Contracts.OrganizationNameSchema.safeParse('😀'.repeat(80)).success,
    ).toBe(true);
    expect(
      Contracts.OrganizationNameSchema.safeParse('界'.repeat(106)).success,
    ).toBe(true);

    for (const invalid of [
      'x'.repeat(161),
      '😀'.repeat(81),
      '界'.repeat(107),
      'District\u202eName',
      'District\u2028Name',
      'District\u2029Name',
    ]) {
      expect(Contracts.OrganizationNameSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  const staffBuildingGroupRef = {
    id: ids.group,
    kind: 'google-group',
    purpose: 'building',
    facilityId: ids.facility,
  } as const;
  const syntheticBuildingGroupRef = {
    id: ids.group,
    kind: 'synthetic',
    purpose: 'building',
    facilityId: ids.facility,
  } as const;
  const accessGroupRef = {
    id: ids.group,
    kind: 'google-group',
    purpose: 'access',
    facilityId: null,
  } as const;
  const syntheticSnapshot = {
    id: ids.roster,
    version: 1,
    population: 'synthetic',
    complete: true,
    sourceConfiguration: { id: ids.rosterConfiguration, version: 1 },
    facilityIds: [ids.facility],
    expectedSourceGroupRefs: [syntheticBuildingGroupRef],
    sourceGroupRefs: [syntheticBuildingGroupRef],
    recipients: [
      {
        id: ids.recipient,
        population: 'synthetic',
        googleSubject: null,
        displayName: 'Synthetic Staff One',
        groupSourceRefs: [syntheticBuildingGroupRef],
        endpoints: [
          {
            id: ids.endpoint,
            channel: 'email',
            status: 'active',
            email: 'synthetic.one@example.invalid',
            capturedAt: times.created,
          },
          {
            id: ids.smsEndpoint,
            channel: 'sms',
            status: 'active',
            phoneNumber: '+12025550123',
            capturedAt: times.created,
          },
          {
            id: ids.pushEndpoint,
            channel: 'push',
            status: 'active',
            platform: 'ios',
            token: 'synthetic-unroutable:device-one',
            capturedAt: times.created,
          },
        ],
      },
    ],
    syncStartedAt: times.created,
    capturedAt: times.activated,
  } as const;
  const staffSnapshot = {
    id: ids.roster,
    version: 1,
    population: 'staff',
    complete: true,
    sourceConfiguration: { id: ids.rosterConfiguration, version: 1 },
    facilityIds: [ids.facility],
    expectedSourceGroupRefs: [staffBuildingGroupRef],
    sourceGroupRefs: [staffBuildingGroupRef],
    recipients: [
      {
        id: ids.recipient,
        population: 'staff',
        googleSubject: 'verified-google-subject-one',
        displayName: 'Staff One',
        groupSourceRefs: [staffBuildingGroupRef],
        endpoints: [],
      },
    ],
    syncStartedAt: times.created,
    capturedAt: times.activated,
  } as const;

  test('represents canonical staff email keys without inventing Google subjects', () => {
    expect(RosterSnapshotSchema.safeParse(staffSnapshot).success).toBe(true);

    const emailOnly = RosterSnapshotSchema.safeParse({
      ...staffSnapshot,
      recipients: [
        {
          ...staffSnapshot.recipients[0],
          googleSubject: null,
          staffEmail: '  STAFF.ONE@EXAMPLE.INVALID  ',
        },
      ],
    });
    expect(emailOnly.success).toBe(true);
    if (emailOnly.success) {
      expect(emailOnly.data.recipients[0]?.googleSubject).toBeNull();
      expect(emailOnly.data.recipients[0]?.staffEmail).toBe(
        'staff.one@example.invalid',
      );
    }

    expect(
      RosterSnapshotSchema.safeParse({
        ...staffSnapshot,
        recipients: [
          {
            ...staffSnapshot.recipients[0],
            staffEmail: 'staff.one@example.invalid',
          },
        ],
      }).success,
    ).toBe(true);
  });

  test('rejects missing, malformed, and cross-population staff identity keys', () => {
    expect(
      RosterSnapshotSchema.safeParse({
        ...staffSnapshot,
        recipients: [
          {
            ...staffSnapshot.recipients[0],
            googleSubject: null,
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [
          {
            ...syntheticSnapshot.recipients[0],
            staffEmail: 'staff.one@example.invalid',
          },
        ],
      }).success,
    ).toBe(false);

    // Shape alone: an address is an address whatever district it belongs to.
    for (const staffEmail of [
      'not-an-email',
      `${'a'.repeat(310)}@example.invalid`,
    ]) {
      expect(StaffRosterEmailSchema.safeParse(staffEmail).success).toBe(false);
    }
    // The domain is the deployment's, so the check that a member belongs to
    // this district lives on the schema bound to its domain. Near misses are
    // what this is really guarding: a lookalike domain, and a subdomain that
    // ends in somebody else's.
    const districtEmail = staffRosterEmailSchemaForDomain('example.invalid');
    expect(districtEmail.safeParse('staff.one@example.invalid').success).toBe(
      true,
    );
    for (const staffEmail of [
      'staff.one@example.com',
      'staff.one@evilexample.invalid',
      'staff.one@example.invalid.example.com',
      'staff.one@sub.example.invalid',
    ]) {
      expect(districtEmail.safeParse(staffEmail).success).toBe(false);
    }
  });

  test('rejects duplicate and ambiguous staff identity bindings', () => {
    const firstRecipient = {
      ...staffSnapshot.recipients[0],
      staffEmail: 'staff.one@example.invalid',
    } as const;
    const secondRecipient = {
      ...firstRecipient,
      id: ids.secondRecipient,
      googleSubject: 'verified-google-subject-two',
      staffEmail: 'staff.two@example.invalid',
      displayName: 'Staff Two',
    } as const;

    expect(
      RosterSnapshotSchema.safeParse({
        ...staffSnapshot,
        recipients: [firstRecipient, secondRecipient],
      }).success,
    ).toBe(true);

    expect(
      RosterSnapshotSchema.safeParse({
        ...staffSnapshot,
        recipients: [
          firstRecipient,
          {
            ...secondRecipient,
            googleSubject: firstRecipient.googleSubject,
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      RosterSnapshotSchema.safeParse({
        ...staffSnapshot,
        recipients: [
          firstRecipient,
          {
            ...secondRecipient,
            staffEmail: '  STAFF.ONE@EXAMPLE.INVALID  ',
          },
        ],
      }).success,
    ).toBe(false);

    for (const ambiguousSecondRecipient of [
      {
        ...secondRecipient,
        googleSubject: firstRecipient.googleSubject,
      },
      {
        ...secondRecipient,
        staffEmail: firstRecipient.staffEmail,
      },
    ]) {
      expect(
        RosterSnapshotSchema.safeParse({
          ...staffSnapshot,
          recipients: [firstRecipient, ambiguousSecondRecipient],
        }).success,
      ).toBe(false);
    }
  });

  test('refuses a synthetic source for access or a real roster', () => {
    expect(
      GroupSourceSchema.safeParse({
        id: ids.group,
        kind: 'synthetic',
        purpose: 'access',
        facilityId: null,
        displayName: 'Unsafe synthetic access source',
        active: true,
        createdAt: times.created,
        fixtureKey: 'unsafe-access',
      }).success,
    ).toBe(false);
    expect(
      RosterSourceConfigurationSchema.safeParse({
        id: ids.rosterConfiguration,
        version: 1,
        population: 'staff',
        facilityIds: [ids.facility],
        groupSourceRefs: [syntheticBuildingGroupRef],
        createdAt: times.created,
      }).success,
    ).toBe(false);
  });

  test('keeps every synthetic endpoint provably unroutable', () => {
    expect(RosterSnapshotSchema.safeParse(syntheticSnapshot).success).toBe(
      true,
    );
    const recipient = syntheticSnapshot.recipients[0];
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [
          {
            ...recipient,
            endpoints: recipient.endpoints.map((endpoint) =>
              endpoint.channel === 'sms'
                ? { ...endpoint, phoneNumber: '+999000000000000' }
                : endpoint,
            ),
          },
        ],
      }).success,
    ).toBe(true);
    for (const phoneNumber of [
      '+99900000000000',
      '+9990000000000000',
      '+998000000000000',
    ]) {
      expect(
        RosterSnapshotSchema.safeParse({
          ...syntheticSnapshot,
          recipients: [
            {
              ...recipient,
              endpoints: recipient.endpoints.map((endpoint) =>
                endpoint.channel === 'sms'
                  ? { ...endpoint, phoneNumber }
                  : endpoint,
              ),
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [{ ...recipient, googleSubject: 'real-looking-subject' }],
      }).success,
    ).toBe(false);
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [
          {
            ...recipient,
            endpoints: [
              {
                ...recipient.endpoints[0],
                email: 'real-route@example.com',
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [
          {
            ...recipient,
            endpoints: [
              {
                ...recipient.endpoints[1],
                phoneNumber: '+12125550100',
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [
          {
            ...recipient,
            endpoints: [
              {
                ...recipient.endpoints[2],
                token: 'ExponentPushToken[routable]',
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('requires internally consistent, deduplicated roster provenance', () => {
    const recipient = syntheticSnapshot.recipients[0];
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [
          {
            ...recipient,
            groupSourceRefs: [
              { ...syntheticBuildingGroupRef, id: ids.otherFacility },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        recipients: [
          recipient,
          {
            ...recipient,
            id: ids.secondRecipient,
            endpoints: [{ ...recipient.endpoints[0], id: ids.secondEndpoint }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      RosterSnapshotSchema.safeParse({
        ...syntheticSnapshot,
        expectedSourceGroupRefs: [
          syntheticBuildingGroupRef,
          { ...syntheticBuildingGroupRef, id: ids.otherFacility },
        ],
      }).success,
    ).toBe(false);
    expect(
      RosterSyncResultSchema.safeParse({
        id: ids.transition,
        sourceConfiguration: { id: ids.rosterConfiguration, version: 1 },
        population: 'synthetic',
        outcome: 'complete',
        startedAt: times.created,
        completedAt: times.later,
        expectedSourceGroupRefs: [syntheticBuildingGroupRef],
        completedSourceGroupRefs: [syntheticBuildingGroupRef],
        publishedSnapshotId: ids.roster,
        groupFailures: [],
      }).success,
    ).toBe(true);
  });

  test('exposes a bounded, PII-free stale-roster report', () => {
    expect(
      StaleRosterReportSchema.safeParse({
        generatedAt: times.later,
        status: 'stale',
        latestCompleteSnapshotId: ids.roster,
        latestCompleteCapturedAt: times.created,
        latestCompleteAgeSeconds: 120,
        failedGroups: [
          {
            groupSourceRef: syntheticBuildingGroupRef,
            errorCode: 'GOOGLE_UNAVAILABLE',
            attemptedAt: times.later,
          },
        ],
        staleRecipients: [
          { recipientId: ids.recipient, reason: 'no-active-endpoint' },
        ],
        staleEndpoints: [
          {
            recipientId: ids.recipient,
            endpointId: ids.endpoint,
            channel: 'sms',
            reason: 'sms-opted-out',
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      StaleRosterReportSchema.safeParse({
        generatedAt: times.later,
        status: 'current',
        latestCompleteSnapshotId: ids.roster,
        latestCompleteCapturedAt: times.created,
        latestCompleteAgeSeconds: 120,
        failedGroups: [],
        staleRecipients: [],
        staleEndpoints: [
          {
            recipientId: ids.recipient,
            endpointId: ids.endpoint,
            channel: 'sms',
            reason: 'sms-opted-out',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      StaleRosterReportSchema.safeParse({
        generatedAt: times.later,
        status: 'stale',
        latestCompleteSnapshotId: ids.roster,
        latestCompleteCapturedAt: times.created,
        latestCompleteAgeSeconds: 120,
        failedGroups: [],
        staleRecipients: [],
        staleEndpoints: [
          {
            recipientId: ids.recipient,
            endpointId: ids.endpoint,
            channel: 'push',
            reason: 'sms-opted-out',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      StaleRosterReportSchema.safeParse({
        generatedAt: times.later,
        status: 'failed',
        latestCompleteSnapshotId: null,
        latestCompleteCapturedAt: null,
        latestCompleteAgeSeconds: null,
        failedGroups: [
          {
            groupSourceRef: syntheticBuildingGroupRef,
            errorCode: 'FIRST_SYNC_FAILED',
            attemptedAt: times.later,
          },
        ],
        staleRecipients: [],
      }).success,
    ).toBe(true);
  });

  test('pins membership evidence and keeps token history append-only', () => {
    const session = {
      id: ids.session,
      userId: ids.actor,
      deviceEnrollmentId: ids.device,
      createdAt: times.created,
      expiresAt: times.sessionExpiry,
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: ids.membershipSnapshot,
        membershipValidUntil: times.activated,
        membershipGraceUntil: times.later,
      },
      revokedAt: null,
    } as const;
    expect(SessionSchema.safeParse(session).success).toBe(true);
    // A session is no longer pinned to a snapshot. Authorization asks the
    // trusted groups about the present on every request, so the field is a
    // record of which sync run was current at issuance and may be absent.
    expect(
      SessionSchema.safeParse({
        ...session,
        authorization: {
          ...session.authorization,
          membershipSnapshotId: null,
        },
      }).success,
    ).toBe(true);
    expect(
      SessionSchema.safeParse({
        ...session,
        authorization: {
          ...session.authorization,
          membershipGraceUntil: times.created,
        },
      }).success,
    ).toBe(false);
    expect(
      SessionSchema.safeParse({ ...session, refreshToken: 'not-allowed' })
        .success,
    ).toBe(false);
    expect(
      SessionSchema.safeParse({
        ...session,
        authorization: {
          kind: 'bootstrap-admin',
          source: 'bootstrap-admin-subject',
          grantedRole: 'admin',
          subjectDigest: '8'.repeat(64),
          configurationDigest: '9'.repeat(64),
          authorizationReference: 'environment-bootstrap-subject-v1',
          authorizedAt: times.created,
        },
      }).success,
    ).toBe(false);
    const accessSnapshot = {
      id: ids.membershipSnapshot,
      version: 1,
      complete: true,
      expectedAccessGroupSourceRefs: [accessGroupRef],
      completedAccessGroupSourceRefs: [accessGroupRef],
      evaluatedMemberships: [
        {
          email: 'member@example.invalid',
          accessGroupSourceRefs: [accessGroupRef],
        },
      ],
      members: [
        {
          userId: ids.actor,
          googleSubject: 'synthetic-google-subject',
          accessGroupSourceRefs: [accessGroupRef],
          facilityScope: { kind: 'district' },
        },
      ],
      syncStartedAt: times.created,
      capturedAt: times.activated,
    } as const;
    expect(
      AccessMembershipSnapshotSchema.safeParse(accessSnapshot).success,
    ).toBe(true);
    expect(
      AccessMembershipSnapshotSchema.safeParse({
        ...accessSnapshot,
        evaluatedMemberships: [
          {
            email: 'unbound.member@example.com',
            accessGroupSourceRefs: [accessGroupRef],
          },
        ],
        members: [],
      }).success,
    ).toBe(true);
    expect(
      AccessMembershipSnapshotSchema.safeParse({
        ...accessSnapshot,
        complete: false,
      }).success,
    ).toBe(false);
    expect(
      AccessMembershipSnapshotSchema.safeParse({
        ...accessSnapshot,
        evaluatedMemberships: undefined,
      }).success,
    ).toBe(false);
    expect(
      AccessMembershipSnapshotSchema.safeParse({
        ...accessSnapshot,
        evaluatedMemberships: [
          {
            email: 'Member@example.invalid',
            accessGroupSourceRefs: [accessGroupRef],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AccessMembershipSnapshotSchema.safeParse({
        ...accessSnapshot,
        evaluatedMemberships: [
          {
            email: 'member@example.invalid',
            accessGroupSourceRefs: [
              { ...accessGroupRef, id: ids.otherFacility },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AccessMembershipSnapshotSchema.safeParse({
        ...accessSnapshot,
        evaluatedMemberships: [
          ...accessSnapshot.evaluatedMemberships,
          {
            email: 'member@example.invalid',
            accessGroupSourceRefs: [accessGroupRef],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      SessionTokenIssuanceSchema.safeParse({
        id: ids.tokenIssuance,
        sessionId: ids.session,
        tokenDigest: 'c'.repeat(64),
        issuedAt: times.created,
      }).success,
    ).toBe(true);

    const rotation = {
      id: ids.rotation,
      sessionId: ids.session,
      previousTokenDigest: 'd'.repeat(64),
      nextTokenDigest: 'e'.repeat(64),
      rotatedAt: times.activated,
    } as const;
    expect(SessionTokenRotationSchema.safeParse(rotation).success).toBe(true);
    expect(
      SessionTokenRotationSchema.safeParse({
        ...rotation,
        replayDetectedAt: times.later,
      }).success,
    ).toBe(false);
    expect(
      SessionTokenReplaySchema.safeParse({
        id: ids.replay,
        sessionId: ids.session,
        rotationId: ids.rotation,
        detectedAt: times.later,
      }).success,
    ).toBe(true);
    expect(
      ConnectivityEpochSchema.safeParse({
        id: ids.connectivityEpoch,
        sessionId: ids.session,
        establishedAt: times.activated,
      }).success,
    ).toBe(true);
    expect(
      ConnectivityEpochInvalidationSchema.safeParse({
        id: ids.replay,
        connectivityEpochId: ids.previousConnectivityEpoch,
        reason: 'reconnected',
        invalidatedAt: times.activated,
      }).success,
    ).toBe(true);
  });
});

describe('security audit boundary', () => {
  test('records minimized unknown-user denials in a hash chain', () => {
    const entry = {
      id: ids.audit,
      sequence: 1,
      previousHash: null,
      entryHash: 'f'.repeat(64),
      category: 'access-denial',
      action: 'sign-in',
      actionIds: [],
      confirmationId: null,
      outcome: 'denied',
      principal: {
        kind: 'unauthenticated',
        subjectDigest: 'a'.repeat(64),
      },
      source: 'web',
      facilityId: null,
      target: null,
      requestId: ids.request,
      reasonCode: 'UNKNOWN_USER',
      occurredAt: times.created,
    } as const;
    expect(SecurityAuditEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      SecurityAuditEntrySchema.safeParse({ ...entry, email: 'not-allowed' })
        .success,
    ).toBe(false);
    expect(
      SecurityAuditEntrySchema.safeParse({
        ...entry,
        source: 'agent-rest',
      }).success,
    ).toBe(true);
    expect(
      SecurityAuditEntrySchema.safeParse({
        ...entry,
        category: 'human-only-rejection',
        action: 'start-event',
        actionIds: ['start-real-incident'],
        outcome: 'success',
        reasonCode: null,
      }).success,
    ).toBe(false);
  });

  test('can query unauthenticated facts without inventing an actor', () => {
    expect(
      SecurityAuditQuerySchema.safeParse({
        actorKind: 'unauthenticated',
        principal: {
          kind: 'unauthenticated',
          subjectDigest: 'a'.repeat(64),
        },
        category: 'access-denial',
        outcome: 'denied',
        action: null,
        facilityId: null,
        occurredFrom: times.created,
        occurredThrough: times.later,
        cursor: null,
        limit: 100,
      }).success,
    ).toBe(true);
  });
});

describe('client-facing transient links', () => {
  test('permits HTTPS only for private upload, read, and export grants', () => {
    expect(
      HttpsUrlSchema.safeParse('https://example.invalid/grant').success,
    ).toBe(true);
    for (const unsafeUrl of [
      'javascript:alert(1)',
      'ftp://example.invalid/grant',
      'http://example.invalid/grant',
      'not a URL',
    ]) {
      expect(HttpsUrlSchema.safeParse(unsafeUrl).success).toBe(false);
      expect(
        MediaReadGrantSchema.safeParse({
          eventId: ids.event,
          mediaId: ids.outbox,
          readUrl: unsafeUrl,
          issuedAt: times.created,
          expiresAt: times.activated,
        }).success,
      ).toBe(false);
    }
  });
});

describe('monthly live delivery-test contracts', () => {
  test('owns independent append-only destination-free eligibility facts', () => {
    const approval = {
      id: ids.deliveryEligibilityPush,
      supersedesFactId: null,
      facilityId: ids.facility,
      rosterSnapshotId: ids.roster,
      recipientId: ids.recipient,
      endpointId: ids.pushEndpoint,
      channel: 'push',
      decision: 'approved-synthetic-canary',
      optedInAt: times.before,
      decidedAt: times.created,
      decidedByUserId: ids.actor,
      decidedWithSessionId: ids.session,
      authorizationReference: 'product-owner-canary-approval-2026-08',
    } as const;
    expect(
      DeliveryTestCanaryEligibilityFactSchema.safeParse(approval).success,
    ).toBe(true);
    expect(
      RecordDeliveryTestCanaryEligibilityInputSchema.safeParse({
        supersedesFactId: ids.deliveryEligibilityRevocation,
        facilityId: ids.facility,
        rosterSnapshotId: ids.roster,
        recipientId: ids.recipient,
        endpointId: ids.pushEndpoint,
        channel: 'push',
        decision: 'approved-synthetic-canary',
        optedInAt: times.later,
        authorizationReference: 'product-owner-canary-reapproval-2026-08',
      }).success,
    ).toBe(true);
    expect(
      DeliveryTestCanaryEligibilityFactSchema.safeParse({
        ...approval,
        destination: 'synthetic@example.invalid',
      }).success,
    ).toBe(false);
    expect(
      RecordDeliveryTestCanaryEligibilityInputSchema.safeParse({
        supersedesFactId: null,
        facilityId: ids.facility,
        rosterSnapshotId: ids.roster,
        recipientId: ids.recipient,
        endpointId: ids.pushEndpoint,
        channel: 'push',
        decision: 'approved-synthetic-canary',
        optedInAt: times.before,
        authorizationReference: 'contact@example.invalid',
      }).success,
    ).toBe(false);
    expect(
      RecordDeliveryTestCanaryEligibilityInputSchema.safeParse({
        supersedesFactId: null,
        facilityId: ids.facility,
        rosterSnapshotId: ids.roster,
        recipientId: ids.recipient,
        endpointId: ids.pushEndpoint,
        channel: 'push',
        decision: 'approved-synthetic-canary',
        optedInAt: times.before,
        authorizationReference: 'product-owner-canary-approval-2026-08',
      }).success,
    ).toBe(true);
    expect(
      RecordDeliveryTestCanaryEligibilityInputSchema.safeParse({
        supersedesFactId: null,
        facilityId: ids.facility,
        rosterSnapshotId: ids.roster,
        recipientId: ids.recipient,
        endpointId: ids.pushEndpoint,
        channel: 'push',
        decision: 'revoked',
        optedInAt: times.before,
        authorizationReference: 'product-owner-canary-revocation-2026-08',
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestCanaryEligibilityFactSchema.safeParse({
        ...approval,
        id: ids.deliveryEligibilityRevocation,
        decision: 'revoked',
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestCanaryEligibilityFactSchema.safeParse({
        ...approval,
        decidedAt: '2026-08-07T03:58:00.000Z',
      }).success,
    ).toBe(false);
  });

  test('owns immutable destination-free product-owner-approved target versions', () => {
    const targetSet = deliveryTestTargetSetVersion();
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse(targetSet).success,
    ).toBe(true);
    expect(
      CreateDeliveryTestTargetSetVersionInputSchema.safeParse({
        previousVersion: null,
        facilityId: targetSet.facilityId,
        rosterSnapshotId: targetSet.rosterSnapshotId,
        eligibilityFactIds: targetSet.endpoints.map(
          (endpoint) => endpoint.eligibilityFactId,
        ),
      }).success,
    ).toBe(true);

    expect(
      DeliveryTestTargetSetVersionSchema.safeParse({
        ...targetSet,
        endpoints: [
          {
            ...targetSet.endpoints[0],
            destination: 'synthetic@example.invalid',
          },
          targetSet.endpoints[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse({
        ...targetSet,
        endpoints: [
          targetSet.endpoints[0],
          {
            ...targetSet.endpoints[1],
            attestedByUserId: ids.agent,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse({
        ...targetSet,
        approvedAt: times.before,
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestTargetSetVersionSchema.safeParse({
        ...targetSet,
        version: 2,
      }).success,
    ).toBe(false);
    expect(
      CreateDeliveryTestTargetSetVersionInputSchema.safeParse({
        previousVersion: null,
        facilityId: targetSet.facilityId,
        rosterSnapshotId: targetSet.rosterSnapshotId,
        eligibilityFactIds: targetSet.endpoints.map(
          (endpoint) => endpoint.eligibilityFactId,
        ),
        destination: 'synthetic@example.invalid',
      }).success,
    ).toBe(false);
    expect(
      CreateDeliveryTestTargetSetVersionInputSchema.safeParse({
        previousVersion: null,
        facilityId: targetSet.facilityId,
        rosterSnapshotId: targetSet.rosterSnapshotId,
        eligibilityFactIds: [
          ids.deliveryEligibilityPush,
          ids.deliveryEligibilityPush,
        ],
      }).success,
    ).toBe(false);
    expect(
      CreateDeliveryTestTargetSetVersionInputSchema.safeParse({
        previousVersion: null,
        facilityId: targetSet.facilityId,
        rosterSnapshotId: targetSet.rosterSnapshotId,
        endpoints: targetSet.endpoints,
      }).success,
    ).toBe(false);
  });

  test('binds a monthly test to the ordinary drill/staff activation preview', () => {
    const preview = monthlyDeliveryTestPreview();
    expect(DeliveryTestPreviewSchema.safeParse(preview).success).toBe(true);
    expect(ActivationPreviewSchema.safeParse(activationPreview()).success).toBe(
      true,
    );
    expect(
      CreateDeliveryTestPreviewInputSchema.safeParse({
        targetSet: deliveryTestMetadata.targetSet,
        eventTypeVersion: drillTypeRef,
      }).success,
    ).toBe(true);
    expect(
      CreateDeliveryTestPreviewInputSchema.safeParse({
        targetSet: deliveryTestMetadata.targetSet,
        eventTypeVersion: realTypeRef,
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestPreviewSchema.safeParse({
        ...preview,
        activationPreview: {
          ...preview.activationPreview,
          deliveryTest: null,
        },
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestPreviewSchema.safeParse({
        ...preview,
        endpointReferenceDigest: 'e'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestPreviewSchema.safeParse({
        ...preview,
        channels: preview.channels.map((channel, index) =>
          index === 0
            ? { ...channel, endpointCount: channel.endpointCount + 1 }
            : channel,
        ),
      }).success,
    ).toBe(false);
    expect(
      DeliveryTestPreviewSchema.safeParse({
        ...preview,
        activationPreview: {
          ...preview.activationPreview,
          sendReadiness: 'blocked',
          blockingReasonCodes: ['DELIVERY_TEST_CREDENTIAL_UNVERIFIED'],
        },
        channels: preview.channels.map((channel, index) =>
          index === 0 ? { ...channel, credentialVerified: false } : channel,
        ),
      }).success,
    ).toBe(true);
    expect(
      DeliveryTestPreviewChannelSchema.safeParse({
        ...preview.channels[0],
        integrationStatus: {
          label: 'mocked',
          verifiedAt: null,
          verifiedByUserId: null,
          authorizationReference: null,
          reasonCode: null,
          observedAt: times.created,
        },
        credentialVerified: true,
      }).success,
    ).toBe(false);
    expect(
      ActivationPreviewSchema.safeParse({
        ...activationPreview(),
        deliveryTest: deliveryTestMetadata,
      }).success,
    ).toBe(false);
  });

  test('preserves monthly-test provenance across notification boundaries', () => {
    const target = targeting('drill', 'drill', 'staff');
    const intent = {
      id: ids.intent,
      eventId: ids.event,
      ...notificationClassification('drill', 'drill', 'staff'),
      purpose: 'activation',
      eventTypeVersion: drillTypeRef,
      rosterSnapshotId: ids.roster,
      deliveryTest: deliveryTestMetadata,
      createdBy: humanActor,
      source: 'web',
      requestId: ids.request,
      authorization: activationAuthorization(target),
      channels: channelPlan(target),
      createdAt: times.created,
    } as const;
    const plannedChannel = intent.channels[0]!;
    const outbox = {
      version: 1,
      outboxId: ids.outbox,
      intentId: intent.id,
      eventId: intent.eventId,
      ...notificationClassification('drill', 'drill', 'staff'),
      purpose: intent.purpose,
      eventTypeVersion: intent.eventTypeVersion,
      rosterSnapshotId: intent.rosterSnapshotId,
      deliveryTest: deliveryTestMetadata,
      requestId: intent.requestId,
      authorization: intent.authorization,
      channels: intent.channels,
      createdAt: intent.createdAt,
    } as const;
    const batch = {
      id: ids.batch,
      intentId: intent.id,
      eventId: intent.eventId,
      facilityId: ids.facility,
      ...notificationClassification('drill', 'drill', 'staff'),
      purpose: intent.purpose,
      eventTypeVersion: intent.eventTypeVersion,
      rosterSnapshotId: intent.rosterSnapshotId,
      deliveryTest: deliveryTestMetadata,
      requestId: intent.requestId,
      authorization: intent.authorization,
      channel: plannedChannel.channel,
      renderedMessage: plannedChannel.renderedMessage,
      integrationStatus: plannedChannel.integrationStatus,
      sequence: 1,
      endpointCount: plannedChannel.endpointCount,
      createdAt: times.activated,
    } as const;
    const attempt = {
      id: ids.attempt,
      batchId: ids.batch,
      intentId: ids.intent,
      eventId: ids.event,
      ...notificationClassification('drill', 'drill', 'staff'),
      purpose: 'activation',
      eventTypeVersion: drillTypeRef,
      rosterSnapshotId: ids.roster,
      deliveryTest: deliveryTestMetadata,
      recipientId: ids.recipient,
      endpointId: ids.pushEndpoint,
      channel: 'push',
      attemptNumber: 1,
      attemptedAt: times.activated,
    } as const;

    expect(NotificationIntentSchema.safeParse(intent).success).toBe(true);
    expect(NotificationOutboxMessageSchema.safeParse(outbox).success).toBe(
      true,
    );
    expect(DispatchBatchSchema.safeParse(batch).success).toBe(true);
    expect(ChannelAttemptSchema.safeParse(attempt).success).toBe(true);
    expect(
      NotificationStatusSchema.safeParse({
        intent,
        batches: [batch],
        stateCounts: [{ state: 'unknown', count: 1 }],
        generatedAt: times.later,
      }).success,
    ).toBe(true);
    expect(
      NotificationStatusSchema.safeParse({
        intent,
        batches: [
          {
            ...batch,
            deliveryTest: {
              ...deliveryTestMetadata,
              endpointReferenceDigest: 'e'.repeat(64),
            },
          },
        ],
        stateCounts: [],
        generatedAt: times.later,
      }).success,
    ).toBe(false);
    expect(
      NotificationIntentSchema.safeParse({
        ...intent,
        purpose: 'all-clear',
      }).success,
    ).toBe(false);
  });

  test('records immutable runs and evidence-honest append-only reports', () => {
    const run = {
      id: ids.deliveryRun,
      activationPreviewId: ids.preview,
      eventId: ids.event,
      notificationIntentId: ids.intent,
      targetSet: deliveryTestMetadata.targetSet,
      endpointReferenceDigest: deliveryTestMetadata.endpointReferenceDigest,
      consequenceDigest: 'a'.repeat(64),
      confirmationId: ids.confirmation,
      startedByUserId: ids.actor,
      startedWithSessionId: ids.session,
      startedAt: times.activated,
    } as const;
    expect(DeliveryTestRunSchema.safeParse(run).success).toBe(true);
    expect(
      DeliveryTestRunSchema.safeParse({
        ...run,
        destination: 'synthetic@example.invalid',
      }).success,
    ).toBe(false);

    const succeeded = monthlyDeliveryTestReport();
    expect(MonthlyDeliveryTestReportSchema.safeParse(succeeded).success).toBe(
      true,
    );
    expect(
      MonthlyDeliveryTestReportSchema.safeParse({
        ...succeeded,
        channels: [
          {
            ...succeeded.channels[0],
            latestStateCounts: [{ state: 'unknown', count: 1 }],
          },
          succeeded.channels[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      MonthlyDeliveryTestReportSchema.safeParse({
        ...succeeded,
        channels: [
          {
            ...succeeded.channels[0],
            activationToProviderAcceptMs: null,
            completedAt: null,
          },
          succeeded.channels[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      MonthlyDeliveryTestReportSchema.safeParse({
        ...succeeded,
        channels: [
          {
            ...succeeded.channels[0],
            latestStateCounts: [{ state: 'provider-accepted', count: 2 }],
          },
          succeeded.channels[1],
        ],
      }).success,
    ).toBe(false);

    const incomplete = {
      ...succeeded,
      status: 'incomplete',
      reasonCode: 'PROVIDER_TRUTH_PENDING',
      channels: [
        {
          ...succeeded.channels[0],
          activationToProviderAcceptMs: null,
          latestStateCounts: [{ state: 'unknown', count: 1 }],
          completedAt: null,
        },
        succeeded.channels[1],
      ],
    } as const;
    expect(MonthlyDeliveryTestReportSchema.safeParse(incomplete).success).toBe(
      true,
    );
    expect(
      MonthlyDeliveryTestReportSchema.safeParse({
        ...incomplete,
        reasonCode: null,
      }).success,
    ).toBe(false);
    expect(
      MonthlyDeliveryTestReportSchema.safeParse({
        ...incomplete,
        channels: succeeded.channels,
      }).success,
    ).toBe(false);
    expect(
      MonthlyDeliveryTestReportSchema.safeParse({
        ...succeeded,
        status: 'failed',
        reasonCode: 'PROVIDER_REJECTED',
      }).success,
    ).toBe(false);
    expect(
      MonthlyDeliveryTestReportSchema.safeParse({
        ...succeeded,
        status: 'failed',
        reasonCode: 'PROVIDER_REJECTED',
        channels: [
          {
            ...succeeded.channels[0],
            activationToProviderAcceptMs: null,
            latestStateCounts: [{ state: 'failed', count: 1 }],
            completedAt: null,
          },
          succeeded.channels[1],
        ],
      }).success,
    ).toBe(true);
    expect(
      MonthlyDeliveryTestReportPageSchema.safeParse({
        items: [incomplete],
        pageInfo: { nextCursor: null, hasMore: false },
      }).success,
    ).toBe(true);
    expect(
      ListDeliveryTestReportsInputSchema.safeParse({
        facilityId: ids.facility,
        status: null,
        generatedFrom: times.later,
        generatedThrough: times.created,
        cursor: null,
        limit: 50,
      }).success,
    ).toBe(false);
  });

  test('keeps sending behind start-event and grants agents only report reads', () => {
    expect(
      getCapabilityInvocationPolicy('record-delivery-test-canary-eligibility'),
    ).toEqual({
      principalKinds: ['human'],
      sources: ['web'],
      agentGrantable: false,
    });
    expect(
      getCapabilityInvocationPolicy('create-delivery-test-target-set-version'),
    ).toEqual({
      principalKinds: ['human'],
      sources: ['web'],
      agentGrantable: false,
    });
    expect(
      getCapabilityInvocationPolicy('create-delivery-test-preview'),
    ).toEqual({
      principalKinds: ['human'],
      sources: ['web', 'mobile'],
      agentGrantable: false,
    });
    expect(
      getCapabilityInvocationPolicy('finalize-delivery-test-report'),
    ).toEqual({
      principalKinds: ['system'],
      sources: ['worker'],
      agentGrantable: false,
    });
    expect(getCapabilityInvocationPolicy('list-delivery-test-reports')).toEqual(
      {
        principalKinds: ['human', 'agent'],
        sources: ['web', 'mobile', 'agent-rest', 'mcp'],
        agentGrantable: true,
      },
    );
    expect(
      AgentCapabilityGrantSchema.safeParse('list-delivery-test-reports')
        .success,
    ).toBe(true);
    for (const capabilityId of [
      'record-delivery-test-canary-eligibility',
      'create-delivery-test-target-set-version',
      'create-delivery-test-preview',
      'finalize-delivery-test-report',
    ] as const) {
      expect(AgentCapabilityGrantSchema.safeParse(capabilityId).success).toBe(
        false,
      );
      expect(defineCapability(capabilityId).safetyEffect).toBe('none');
    }
    expect(defineCapability('start-event').safetyEffect).toBe('start-event');
  });
});

describe('records and report projections', () => {
  test('cannot invent channels or overstate endpoint delivery counts', () => {
    const syntheticTarget = targeting('test', 'drill', 'synthetic');
    const plannedChannels = channelPlan(syntheticTarget).slice(0, 2);
    const intent = {
      id: ids.intent,
      eventId: ids.event,
      ...notificationClassification('test', 'drill', 'synthetic'),
      purpose: 'activation',
      eventTypeVersion: drillTypeRef,
      rosterSnapshotId: ids.roster,
      createdBy: agentActor,
      source: 'mcp',
      requestId: ids.request,
      authorization: activationAuthorization(syntheticTarget),
      channels: plannedChannels,
      createdAt: times.created,
    } as const;
    const notification = {
      intent,
      batches: [],
      stateCounts: [{ state: 'delivered', count: 14 }],
      generatedAt: times.later,
    } as const;
    const channels = plannedChannels.map((channel) => ({
      channel: channel.channel,
      latestStateCounts: [{ state: 'delivered', count: 14 }],
    }));
    const report = {
      notification,
      channels,
      generatedAt: times.later,
    } as const;
    expect(DeliveryReportSchema.safeParse(report).success).toBe(true);
    expect(
      DeliveryReportSchema.safeParse({
        ...report,
        channels: [{ channel: 'sms', latestStateCounts: [] }, channels[1]],
      }).success,
    ).toBe(false);
    expect(
      DeliveryReportSchema.safeParse({
        ...report,
        channels: [
          {
            ...channels[0],
            latestStateCounts: [{ state: 'delivered', count: 15 }],
          },
          channels[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      NotificationStatusSchema.safeParse({
        ...notification,
        stateCounts: [{ state: 'delivered', count: 29 }],
      }).success,
    ).toBe(false);
  });

  test('derives operational record classification and status from retained lifecycle timestamps', () => {
    const activeRecord = {
      id: ids.outbox,
      eventId: ids.event,
      facilityId: ids.facility,
      kind: 'drill',
      eventTypeVersion: drillTypeRef,
      eventTypeName: 'Lockdown Drill',
      status: 'active',
      startedAt: times.created,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
    } as const;
    expect(DrillRecordSchema.safeParse(activeRecord).success).toBe(true);
    const incidentRecord = {
      ...activeRecord,
      kind: 'incident',
      eventTypeVersion: {
        ...activeRecord.eventTypeVersion,
        templateMode: 'real',
      },
      eventTypeName: 'Synthetic Incident',
    } as const;
    expect(EventRecordSchema.safeParse(incidentRecord).success).toBe(true);
    expect(DrillRecordSchema.safeParse(incidentRecord).success).toBe(false);
    expect(
      EventRecordSchema.safeParse({
        ...activeRecord,
        kind: 'incident',
      }).success,
    ).toBe(false);
    expect(
      DrillRecordSchema.safeParse({ ...activeRecord, status: 'draft' }).success,
    ).toBe(false);
    expect(
      DrillRecordSchema.safeParse({ ...activeRecord, status: 'closed' })
        .success,
    ).toBe(false);
    expect(
      DrillRecordSchema.safeParse({
        ...activeRecord,
        status: 'closed',
        allClearAt: times.activated,
        closedAt: times.later,
      }).success,
    ).toBe(true);
  });

  test('requires an explicit nullable event-type filter for drill-record lists', () => {
    const input = {
      facilityId: ids.facility,
      eventTypeId: null,
      startedFrom: null,
      startedThrough: null,
      cursor: null,
      limit: 100,
    } as const;

    expect(ListDrillRecordsInputSchema.parse(input)).toEqual(input);
    expect(ListEventRecordsInputSchema.parse(input)).toEqual(input);
    expect(
      ListDrillRecordsInputSchema.safeParse({
        ...input,
        eventTypeId: ids.eventType,
      }).success,
    ).toBe(true);
    expect(
      ListDrillRecordsInputSchema.safeParse({
        facilityId: input.facilityId,
        startedFrom: input.startedFrom,
        startedThrough: input.startedThrough,
        cursor: input.cursor,
        limit: input.limit,
      }).success,
    ).toBe(false);
  });

  test('keeps mixed incident records off agent and MCP grants', () => {
    expect(getCapabilityInvocationPolicy('list-event-records')).toMatchObject({
      principalKinds: ['human'],
      sources: ['web', 'mobile'],
      agentGrantable: false,
    });
    expect(
      Contracts.AGENT_GRANTABLE_CAPABILITY_IDS as readonly string[],
    ).not.toContain('list-event-records');
    expect(getCapabilityInvocationPolicy('list-drill-records')).toMatchObject({
      agentGrantable: true,
    });
  });

  test('bounds CSV drill exports to one explicit facility and 366 Pacific calendar days', () => {
    const input = {
      facilityId: ids.facility,
      eventTypeId: null,
      startedFrom: '2024-01-01T00:00:00.000Z',
      startedThrough: '2025-01-01T00:00:00.000Z',
      format: 'csv',
    } as const;

    expect(ExportDrillRecordsInputSchema.parse(input)).toEqual(input);
    expect(
      ExportDrillRecordsInputSchema.safeParse({
        ...input,
        eventTypeId: ids.eventType,
      }).success,
    ).toBe(true);
    expect(
      ExportDrillRecordsInputSchema.safeParse({
        ...input,
        startedFrom: '2024-11-02T07:00:00.000Z',
        startedThrough: '2025-11-03T07:59:59.999Z',
      }).success,
    ).toBe(true);
    for (const rejectedInput of [
      { ...input, facilityId: null },
      { ...input, eventTypeId: undefined },
      { ...input, startedFrom: null },
      { ...input, startedThrough: null },
      { ...input, startedThrough: '2025-01-01T01:00:00.001Z' },
      {
        ...input,
        startedFrom: '2025-01-01T00:00:00.000Z',
        startedThrough: '2024-01-01T00:00:00.000Z',
      },
      { ...input, format: 'pdf' },
    ]) {
      expect(
        ExportDrillRecordsInputSchema.safeParse(rejectedInput).success,
      ).toBe(false);
    }
  });

  test('keeps per-event summaries PDF-only', () => {
    const input = { eventId: ids.event, format: 'pdf' } as const;

    expect(ExportEventSummaryInputSchema.parse(input)).toEqual(input);
    expect(
      ExportEventSummaryInputSchema.safeParse({ ...input, format: 'csv' })
        .success,
    ).toBe(false);
  });

  test('binds private export grants to exact safe artifact metadata', () => {
    const csvArtifact = {
      id: ids.outbox,
      format: 'csv',
      contentType: 'text/csv; charset=utf-8',
      fileName: 'drill-records-2026-08-11.csv',
      byteLength: 128,
      contentSha256: 'a'.repeat(64),
      rowCount: 2,
      downloadUrl: 'https://example.invalid/private/drill-records',
      generatedAt: times.created,
      expiresAt: times.activated,
    } as const;

    expect(RecordsExportSchema.parse(csvArtifact)).toEqual(csvArtifact);
    const pdfArtifact = {
      ...csvArtifact,
      format: 'pdf' as const,
      contentType: 'application/pdf' as const,
      fileName: 'event-summary.pdf',
    };
    expect(RecordsExportSchema.safeParse(pdfArtifact).success).toBe(true);
    expect(
      EventSummaryExportSchema.safeParse({
        eventId: ids.event,
        artifact: pdfArtifact,
      }).success,
    ).toBe(true);
    expect(
      EventSummaryExportSchema.safeParse({
        eventId: ids.event,
        artifact: csvArtifact,
      }).success,
    ).toBe(false);
    for (const rejectedArtifact of [
      { ...csvArtifact, contentType: 'application/pdf' },
      { ...csvArtifact, contentType: 'text/csv' },
      { ...csvArtifact, fileName: 'drill-records.pdf' },
      { ...csvArtifact, fileName: '../drill-records.csv' },
      { ...csvArtifact, fileName: 'drill records.csv' },
      { ...csvArtifact, fileName: 'drill..records.csv' },
      { ...csvArtifact, fileName: 'drill.records.csv' },
      { ...csvArtifact, fileName: 'drill-records.csv.pdf' },
      { ...csvArtifact, byteLength: 0 },
      { ...csvArtifact, contentSha256: 'A'.repeat(64) },
      { ...csvArtifact, rowCount: -1 },
      { ...csvArtifact, downloadUrl: 'http://example.invalid/public.csv' },
      { ...csvArtifact, expiresAt: times.afterExpiry },
    ]) {
      expect(RecordsExportSchema.safeParse(rejectedArtifact).success).toBe(
        false,
      );
    }
  });
});

describe('agent key credential boundaries', () => {
  test('keeps persisted verifier digests out of list responses', () => {
    const summary = {
      id: ids.apiKey,
      agentId: ids.agent,
      displayName: 'Synthetic reporting agent',
      facilityScope: { kind: 'district' },
      capabilityIds: ['get-event'],
      keyPrefix: 'psdeoc_key',
      issuedByUserId: ids.actor,
      issuedAt: times.created,
      expiresAt: null,
      revokedAt: null,
    } as const;
    const persisted = {
      ...summary,
      credentialDigest: 'e'.repeat(64),
    } as const;
    expect(AgentApiKeySchema.safeParse(persisted).success).toBe(true);
    expect(
      AgentApiKeyPageSchema.safeParse({
        items: [summary],
        pageInfo: { nextCursor: null, hasMore: false },
      }).success,
    ).toBe(true);
    expect(
      AgentApiKeyPageSchema.safeParse({
        items: [persisted],
        pageInfo: { nextCursor: null, hasMore: false },
      }).success,
    ).toBe(false);
  });
});

describe('MCP message-revision facade', () => {
  test('owns a safe single-channel revision without protected action vocabulary', () => {
    const input = {
      source: {
        kind: 'published-version',
        baseVersionId: ids.eventTypeVersion,
      },
      phase: 'resolution',
      wording: {
        channel: 'push',
        title: 'Resolved at {{site}}',
        body: 'Follow the next instructions from PSD EOC.',
      },
    } as const;

    expect(McpDraftMessageRevisionInputSchema.parse(input)).toEqual(input);
    expect(
      McpDraftMessageRevisionInputSchema.safeParse({
        ...input,
        phase: 'all-clear',
      }).success,
    ).toBe(false);
    expect(
      McpDraftMessageRevisionInputSchema.safeParse({
        ...input,
        wording: { ...input.wording, title: 'Malformed {{unknown}}' },
      }).success,
    ).toBe(false);

    const serializedSchema = JSON.stringify(
      z.toJSONSchema(McpDraftMessageRevisionInputSchema),
    );
    for (const protectedActionId of HUMAN_ONLY_ACTION_IDS) {
      expect(serializedSchema).not.toContain(protectedActionId);
    }
  });

  test('accepts exact draft concurrency and returns only a bounded summary', () => {
    expect(
      McpDraftMessageRevisionInputSchema.safeParse({
        source: {
          kind: 'existing-draft',
          draftId: ids.preview,
          expectedDraftRevision: 'a'.repeat(64),
        },
        phase: 'reactivation',
        wording: {
          channel: 'email',
          subject: 'Synthetic operational update',
          textBody: 'Continue following staff instructions.',
        },
      }).success,
    ).toBe(true);

    expect(
      McpDraftMessageRevisionResultSchema.safeParse({
        draftId: ids.preview,
        draftRevision: 'b'.repeat(64),
        eventTypeId: ids.eventType,
        baseVersionId: ids.eventTypeVersion,
        templateMode: 'drill',
        changedPhase: 'resolution',
        changedChannel: 'sms',
        createdAt: times.created,
      }).success,
    ).toBe(true);
  });
});

describe('barrel exports', () => {
  test('exposes stable downstream schemas from the package entry point', () => {
    expect(typeof Contracts.EventSchema.parse).toBe('function');
    expect(typeof Contracts.NotificationIntentSchema.parse).toBe('function');
    expect(typeof Contracts.MobilePushReceivePayloadSchema.parse).toBe(
      'function',
    );
    expect(typeof Contracts.PushEndpointSendEligibilityInputSchema.parse).toBe(
      'function',
    );
    expect(typeof Contracts.NotificationOutboxMessageSchema.parse).toBe(
      'function',
    );
    expect(typeof Contracts.StaleRosterReportSchema.parse).toBe('function');
    expect(typeof Contracts.DeliveryTestPreviewSchema.parse).toBe('function');
    expect(typeof Contracts.MonthlyDeliveryTestReportSchema.parse).toBe(
      'function',
    );
    expect(typeof Contracts.SecurityAuditEntrySchema.parse).toBe('function');
    expect(typeof Contracts.JournalEntrySchema.parse).toBe('function');
    expect(typeof Contracts.McpDraftMessageRevisionInputSchema.parse).toBe(
      'function',
    );
    expect(typeof Contracts.defineCapability).toBe('function');
    expect(Contracts.HUMAN_ONLY_ACTION_IDS).toHaveLength(4);
  });
});
