import { randomUUID } from 'node:crypto';

import {
  ActivationPreviewSchema,
  AllClearEventResultSchema,
  CapabilitySafetyResolutionSchema,
  CloseEventResultSchema,
  EventLifecycleMutationResultSchema,
  EventPageSchema,
  EventSchema,
  EventTargetingSchema,
  EventTransitionSchema,
  HumanConfirmationRecordSchema,
  IntegrationStatusSchema,
  JoinEventResultSchema,
  JournalEntrySchema,
  LifecycleConsequencePreviewSchema,
  NotificationIntentSchema,
  OutboxRecordSchema,
  PreparedActivationSchema,
  PreparedActivationConsumptionSchema,
  ReactivateEventResultSchema,
  ReopenAsCorrectionResultSchema,
  SecurityAuditEntrySchema,
  StartEventResultSchema,
  type ActivationPreview,
  type AllClearEventResult,
  type CapabilityInput,
  type CapabilityOutput,
  type CloseEventResult,
  type Event,
  type EventLifecycleMutationResult,
  type EventPage,
  type EventStatus,
  type EventTargeting,
  type EventTransition,
  type EventTransitionKind,
  type JoinEventResult,
  type JournalEntry,
  type LifecycleActionAuthorization,
  type LifecycleConsequencePreview,
  type NotificationIntent,
  type NotificationOutboxMessage,
  type OutboxRecord,
  type PreparedActivation,
  type PreparedActivationConsumption,
  type ReactivateEventResult,
  type RegisteredCapabilityId,
  type ReopenAsCorrectionResult,
  type RosterPopulation,
  type StartEventResult,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../db/client';
import {
  activationPreviews,
  audienceConfigurations,
  channelConfigurations,
  deliveryTestRuns,
  deliveryTestTargetEndpoints,
  deliveryTestTargetSetVersions,
  eventTransitions,
  events,
  facilities,
  humanConfirmationActions,
  humanConfirmationRecords,
  idempotencyRecords,
  integrationStatuses,
  journalEntries,
  lifecycleConsequencePreviews,
  notificationIntentChannels,
  notificationIntents,
  outbox,
  preparedActivationConsumptions,
  preparedActivations,
  securityAuditEntries,
} from '../../db/schema';
import { ACCESS_GATE_AUDIT_LOCK_SQL } from '../auth/sign-in-audit';
import {
  currentActiveAudienceEndpointReferences,
  deliveryTestCredentialIsVerified,
  loadAudienceConfiguration,
  loadRosterSnapshot,
  readDeliveryTestCredentialVerificationReferences,
  requireCurrentDeliveryTestTargetEligibility,
} from '../../app/(app)/start/_lib/capabilities';
import {
  CapabilityEngineError,
  digestCapabilityValue,
  executeCapability,
  readCapabilityTime,
  requireCapabilityAuthorization,
  scopeTransitionIdempotencyKey,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type CapabilityHandlerContext,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type ConsumeHumanConfirmationInput,
  type IdempotencyClaim,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';
import { transitionEventStatus } from '../events/state-machine';
import {
  DELIVERY_TEST_TARGET_LOCK_NAMESPACE,
  deliveryTestEndpointReferenceDigest,
  deliveryTestTargetLockIdentity,
} from '../testing/e2e-delivery';

/** Preview plus server-only persistence references required for one send. */
export interface ResolvedActivationSource {
  readonly preview: ActivationPreview;
  readonly preparedActivation: PreparedActivation | null;
  readonly integrationStatusIds: Readonly<Record<string, string>>;
  readonly currentActiveEventIds: readonly string[];
}

/** Locked event state and monotonically allocated append positions. */
export interface ResolvedEventState {
  readonly event: Event;
  readonly nextTransitionSequence: number;
  readonly nextJournalSequence: number;
}

/** Purpose-specific preview plus its exact persisted integration observations. */
export interface ResolvedLifecyclePreview {
  readonly preview: LifecycleConsequencePreview;
  readonly integrationStatusIds: Readonly<Record<string, string>>;
}

export interface LifecyclePersistenceBundle {
  readonly result: EventLifecycleMutationResult;
  readonly outboxRecord: OutboxRecord | null;
  readonly integrationStatusIds: Readonly<Record<string, string>>;
  /** Exact reviewed preview time; null only for non-notifying lifecycle work. */
  readonly sendPreviewCreatedAt: string | null;
}

export interface JoinPersistenceBundle {
  readonly result: JoinEventResult;
  readonly journalEntry: JournalEntry;
}

/** Event-specific transaction boundary used by handlers and in-memory tests. */
export interface EventCapabilityTransaction
  extends CapabilityEngineTransaction {
  resolveActivationFacilityId(
    input: CapabilityInput<'start-event'>,
  ): Promise<string | null>;
  resolveActivationSource(
    input: CapabilityInput<'start-event'>,
  ): Promise<ResolvedActivationSource | null>;
  resolveEventFacilityId(eventId: string): Promise<string | null>;
  resolveEventForUpdate(eventId: string): Promise<ResolvedEventState | null>;
  resolveLifecyclePreview(
    previewId: string,
  ): Promise<ResolvedLifecyclePreview | null>;
  getEvent(eventId: string): Promise<Event | null>;
  listActiveEvents(
    input: CapabilityInput<'list-active-events'>,
    scope: TrustedCapabilityInvocation['scope'],
  ): Promise<EventPage>;
  persistLifecycle(bundle: LifecyclePersistenceBundle): Promise<void>;
  persistJoin(bundle: JoinPersistenceBundle): Promise<void>;
  resolveReplayFacilityId(resultReference: string): Promise<string | null>;
  loadLifecycleResult(
    resultReference: string,
  ): Promise<EventLifecycleMutationResult | null>;
  loadJoinResult(resultReference: string): Promise<JoinEventResult | null>;
}

export type EventCapabilityStore =
  CapabilityEngineStore<EventCapabilityTransaction>;

type EventCapabilityId = Extract<
  RegisteredCapabilityId,
  | 'start-event'
  | 'list-active-events'
  | 'get-event'
  | 'join-event'
  | 'all-clear-event'
  | 'reactivate-event'
  | 'close-event'
  | 'reopen-as-correction'
>;

const START_CACHE_KEY = 'event:start-source';
const START_FACILITY_CACHE_KEY = 'event:start-facility';
const EVENT_CACHE_KEY = 'event:locked-state';
const EVENT_FACILITY_CACHE_KEY = 'event:facility';
const LIFECYCLE_PREVIEW_CACHE_KEY = 'event:lifecycle-preview';

function notFound(message = 'The event was not found.'): CapabilityEngineError {
  return new CapabilityEngineError(
    'NOT_FOUND',
    'PERSISTENCE_CONFLICT',
    message,
    404,
  );
}

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function unavailable(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'LIVE_ACTION_UNAVAILABLE',
    'PERSISTENCE_CONFLICT',
    message,
    503,
    true,
  );
}

function timestamp(date: Date): string {
  return date.toISOString();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const first = [...left].sort();
  const second = [...right].sort();
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function assertPreviewUsable(
  preview: ActivationPreview | LifecycleConsequencePreview,
  now: Date,
): void {
  if (preview.sendReadiness !== 'ready') {
    throw unavailable('Notification delivery is not currently ready.');
  }
  if (now.getTime() > Date.parse(preview.expiresAt)) {
    throw conflict('The consequence preview has expired.');
  }
  if (now.getTime() < Date.parse(preview.createdAt)) {
    throw conflict('The consequence preview is not current.');
  }
}

async function startSource(
  input: CapabilityInput<'start-event'>,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): Promise<ResolvedActivationSource> {
  const cached = context.cache.get(START_CACHE_KEY);
  if (cached !== undefined) {
    return cached as ResolvedActivationSource;
  }
  const resolved = await context.transaction.resolveActivationSource(input);
  if (resolved === null) {
    throw notFound('The activation preview was not found.');
  }
  assertPreviewUsable(resolved.preview, await readCapabilityTime(context));
  if (
    !sameSet(
      input.activeEventDecision.activeEventIdsSeen,
      resolved.preview.activeEventIds,
    ) ||
    !sameSet(
      input.activeEventDecision.activeEventIdsSeen,
      resolved.currentActiveEventIds,
    )
  ) {
    throw conflict(
      'The active event list changed; review it before starting a new event.',
    );
  }
  if (
    input.source === 'prepared-activation' &&
    resolved.preparedActivation?.id !== input.preparedActivationId
  ) {
    throw conflict('The prepared activation no longer matches its preview.');
  }
  if (
    input.source === 'activation-preview' &&
    resolved.preparedActivation !== null
  ) {
    throw conflict('The activation source is inconsistent.');
  }
  context.cache.set(START_CACHE_KEY, resolved);
  return resolved;
}

async function startFacilityId(
  input: CapabilityInput<'start-event'>,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): Promise<string> {
  const cached = context.cache.get(START_FACILITY_CACHE_KEY);
  if (typeof cached === 'string') {
    return cached;
  }
  const facilityId =
    await context.transaction.resolveActivationFacilityId(input);
  if (facilityId === null) {
    throw notFound('The activation preview was not found.');
  }
  context.cache.set(START_FACILITY_CACHE_KEY, facilityId);
  return facilityId;
}

async function eventFacilityId(
  eventId: string,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): Promise<string> {
  const cached = context.cache.get(EVENT_FACILITY_CACHE_KEY);
  if (typeof cached === 'string') {
    return cached;
  }
  const facilityId = await context.transaction.resolveEventFacilityId(eventId);
  if (facilityId === null) {
    throw notFound();
  }
  context.cache.set(EVENT_FACILITY_CACHE_KEY, facilityId);
  return facilityId;
}

async function eventReplayFacilityId(
  resultReference: string,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): Promise<string> {
  const facilityId =
    await context.transaction.resolveReplayFacilityId(resultReference);
  if (facilityId === null) {
    throw new CapabilityEngineError(
      'INTERNAL_ERROR',
      'IDEMPOTENCY_RESULT_UNAVAILABLE',
      'The original event result facility is unavailable.',
      500,
    );
  }
  return facilityId;
}

async function lockedEvent(
  eventId: string,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): Promise<ResolvedEventState> {
  const cached = context.cache.get(EVENT_CACHE_KEY);
  if (cached !== undefined) {
    return cached as ResolvedEventState;
  }
  const resolved = await context.transaction.resolveEventForUpdate(eventId);
  if (resolved === null) {
    throw notFound();
  }
  context.cache.set(EVENT_CACHE_KEY, resolved);
  return resolved;
}

async function lifecyclePreview(
  previewId: string,
  event: Event,
  purpose: 'all-clear' | 'reactivation',
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): Promise<ResolvedLifecyclePreview> {
  const cached = context.cache.get(LIFECYCLE_PREVIEW_CACHE_KEY);
  if (cached !== undefined) {
    return cached as ResolvedLifecyclePreview;
  }
  const resolved = await context.transaction.resolveLifecyclePreview(previewId);
  if (resolved === null) {
    throw notFound('The lifecycle consequence preview was not found.');
  }
  assertPreviewUsable(resolved.preview, await readCapabilityTime(context));
  const preview = resolved.preview;
  const stateChangedAt =
    purpose === 'all-clear'
      ? (event.reactivatedAt ?? event.activatedAt)
      : event.allClearAt;
  if (
    stateChangedAt === null ||
    Date.parse(preview.createdAt) < Date.parse(stateChangedAt) ||
    preview.eventId !== event.id ||
    preview.purpose !== purpose ||
    preview.kind !== event.kind ||
    preview.templateMode !== event.templateMode ||
    preview.eventTypeVersion.id !== event.eventTypeVersion.id ||
    preview.rosterSnapshotId !== event.rosterSnapshotId ||
    preview.rosterPopulation !== event.rosterPopulation
  ) {
    throw conflict('The lifecycle preview does not match the current event.');
  }
  context.cache.set(LIFECYCLE_PREVIEW_CACHE_KEY, resolved);
  return resolved;
}

function requireTransition(
  current: EventStatus,
  transition: EventTransitionKind,
): EventStatus {
  try {
    return transitionEventStatus(current, transition);
  } catch {
    throw conflict('The event is not in a state that permits this action.');
  }
}

function eventTargeting(event: Event): EventTargeting {
  if (event.rosterPopulation === null) {
    throw conflict('The event has not been activated.');
  }
  return EventTargetingSchema.parse({
    kind: event.kind,
    templateMode: event.templateMode,
    rosterPopulation: event.rosterPopulation,
  });
}

function capabilitySafetyResolution(
  eventKind: Event['kind'],
  rosterPopulation: RosterPopulation,
  consequenceDigest: string,
) {
  return CapabilitySafetyResolutionSchema.parse({
    eventKind,
    rosterPopulation,
    consequenceDigest,
  });
}

function transitionEvidenceKey(
  capabilityId: Extract<
    EventCapabilityId,
    | 'start-event'
    | 'all-clear-event'
    | 'reactivate-event'
    | 'close-event'
    | 'reopen-as-correction'
  >,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): string {
  const mutation = context.invocation.mutation;
  if (mutation === null) {
    throw conflict('Mutation idempotency is required.');
  }
  return scopeTransitionIdempotencyKey(
    capabilityId,
    digestCapabilityValue(context.invocation.actor),
    mutation.idempotencyKey,
  );
}

function makeSystemJournalEntry(
  input: Readonly<{
    id?: string;
    eventId: string;
    sequence: number;
    context: CapabilityHandlerContext<EventCapabilityTransaction>;
    payload: JournalEntry['payload'];
  }>,
): JournalEntry {
  return JournalEntrySchema.parse({
    id: input.id ?? randomUUID(),
    eventId: input.eventId,
    sequence: input.sequence,
    author: input.context.invocation.actor,
    source: input.context.invocation.source,
    serverTime: timestamp(input.context.invocation.serverTime),
    clientTime: null,
    supersedes: null,
    kind: 'system',
    payload: input.payload,
  });
}

function buildNotification(
  input: Readonly<{
    event: Event;
    purpose: 'activation' | 'all-clear' | 'reactivation';
    authorization:
      | Event['activationAuthorization']
      | LifecycleActionAuthorization;
    preview: ActivationPreview | LifecycleConsequencePreview;
    context: CapabilityHandlerContext<EventCapabilityTransaction>;
  }>,
): Readonly<{
  intent: NotificationIntent;
  outbox: OutboxRecord;
}> {
  if (
    input.authorization === null ||
    input.event.rosterSnapshotId === null ||
    input.event.rosterPopulation === null
  ) {
    throw conflict('Activated notification provenance is incomplete.');
  }
  const at = timestamp(input.context.invocation.serverTime);
  const deliveryTest =
    'deliveryTest' in input.preview ? input.preview.deliveryTest : null;
  const intent = NotificationIntentSchema.parse({
    id: randomUUID(),
    eventId: input.event.id,
    eventKind: input.event.kind,
    templateMode: input.event.templateMode,
    purpose: input.purpose,
    eventTypeVersion: input.event.eventTypeVersion,
    rosterSnapshotId: input.event.rosterSnapshotId,
    rosterPopulation: input.event.rosterPopulation,
    audienceConfig: input.preview.audienceConfig,
    deliveryTest,
    createdBy: input.context.invocation.actor,
    source: input.context.invocation.source,
    requestId: input.context.invocation.requestId,
    authorization: input.authorization,
    channels: input.preview.channels,
    createdAt: at,
  });
  const outboxId = randomUUID();
  const message: NotificationOutboxMessage = {
    version: 2,
    outboxId,
    intentId: intent.id,
    eventId: intent.eventId,
    facilityId: input.event.facilityId,
    eventKind: intent.eventKind,
    templateMode: intent.templateMode,
    purpose: intent.purpose,
    eventTypeVersion: intent.eventTypeVersion,
    rosterSnapshotId: intent.rosterSnapshotId,
    rosterPopulation: intent.rosterPopulation,
    audienceConfig: intent.audienceConfig,
    deliveryTest: intent.deliveryTest,
    requestId: intent.requestId,
    authorization: intent.authorization,
    channels: intent.channels,
    createdAt: at,
  };
  return {
    intent,
    outbox: OutboxRecordSchema.parse({
      id: outboxId,
      message,
      status: 'pending',
      attempts: 0,
      availableAt: at,
      lockedUntil: null,
      publishedAt: null,
      failedAt: null,
      lastErrorCode: null,
    }),
  };
}

function lifecycleResultReference(
  result: EventLifecycleMutationResult,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'l',
      t: result.transition.id,
      j: result.journalEntries.map((entry) => entry.id),
      n: result.notificationIntent?.id ?? null,
      p: result.preparedActivationConsumption?.preparedActivationId ?? null,
    }),
    'utf8',
  ).toString('base64url');
}

function joinResultReference(
  result: JoinEventResult,
  journalEntryId: string,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'j',
      e: result.event.id,
      j: journalEntryId,
      p: result.participantId,
    }),
    'utf8',
  ).toString('base64url');
}

/** Stable consequence digest for the non-notifying real-event close preview. */
export function deriveCloseConsequenceDigest(event: Event): string {
  return digestCapabilityValue({
    capabilityId: 'close-event',
    eventId: event.id,
    status: event.status,
    activatedAt: event.activatedAt,
    allClearAt: event.allClearAt,
    reactivatedAt: event.reactivatedAt,
    kind: event.kind,
    templateMode: event.templateMode,
    rosterSnapshotId: event.rosterSnapshotId,
  });
}

function canonicalStartInput(input: CapabilityInput<'start-event'>): unknown {
  return {
    ...input,
    activeEventDecision: {
      ...input.activeEventDecision,
      activeEventIdsSeen: [
        ...input.activeEventDecision.activeEventIdsSeen,
      ].sort(),
    },
  };
}

export const startEventRegistration: ServerCapabilityRegistration<
  'start-event',
  EventCapabilityTransaction
> = {
  id: 'start-event',
  canonicalizeIdempotencyInput: canonicalStartInput,
  async resolveFacilityId(input, context) {
    return startFacilityId(input, context);
  },
  async resolveSafety(_request, context) {
    const input = _request.input as CapabilityInput<'start-event'>;
    const resolved = await startSource(input, context);
    return capabilitySafetyResolution(
      resolved.preview.kind,
      resolved.preview.rosterPopulation,
      resolved.preview.consequenceDigest,
    );
  },
  async handler(input, context): Promise<StartEventResult> {
    const resolved = await startSource(input, context);
    const preview = resolved.preview;
    const authorization = requireCapabilityAuthorization(context);
    const confirmation = authorization.humanConfirmation;
    const activationAuthorization: NonNullable<
      Event['activationAuthorization']
    > =
      preview.rosterPopulation === 'staff'
        ? {
            kind: 'human-confirmed',
            activationPreviewId: preview.id,
            preparedActivationId: resolved.preparedActivation?.id ?? null,
            confirmationId: confirmation?.id ?? '',
            consequenceDigest: preview.consequenceDigest,
            requestId: context.invocation.requestId,
          }
        : {
            kind: 'synthetic-training',
            activationPreviewId: preview.id,
            consequenceDigest: preview.consequenceDigest,
            requestId: context.invocation.requestId,
          };
    const at = timestamp(context.invocation.serverTime);
    const event = EventSchema.parse({
      id: randomUUID(),
      facilityId: preview.facilityId,
      kind: preview.kind,
      templateMode: preview.templateMode,
      eventTypeVersion: preview.eventTypeVersion,
      status: requireTransition('draft', 'activate'),
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: preview.rosterPopulation,
      createdBy: context.invocation.actor,
      createdAt: at,
      activatedAt: at,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization,
    });
    const transition = EventTransitionSchema.parse({
      id: randomUUID(),
      sequence: 1,
      transition: 'activate',
      eventId: event.id,
      from: 'draft',
      to: 'active',
      actor: context.invocation.actor,
      source: context.invocation.source,
      occurredAt: at,
      requestId: context.invocation.requestId,
      confirmationId: confirmation?.id ?? null,
      consequenceDigest:
        preview.rosterPopulation === 'staff' ? preview.consequenceDigest : null,
      targeting: {
        kind: preview.kind,
        templateMode: preview.templateMode,
        rosterPopulation: preview.rosterPopulation,
      },
      idempotencyKey: transitionEvidenceKey('start-event', context),
      activationAuthorization,
    });
    const notification = buildNotification({
      event,
      purpose: 'activation',
      authorization: activationAuthorization,
      preview,
      context,
    });
    const journalEntries = [
      makeSystemJournalEntry({
        eventId: event.id,
        sequence: 1,
        context,
        payload: {
          code: 'event-created',
          summary: 'Event record created.',
          relatedRecordId: event.id,
        },
      }),
      makeSystemJournalEntry({
        eventId: event.id,
        sequence: 2,
        context,
        payload: {
          code: 'event-activated',
          summary: 'Event activated.',
          transition,
        },
      }),
      makeSystemJournalEntry({
        eventId: event.id,
        sequence: 3,
        context,
        payload: {
          code: 'notification-intent-recorded',
          summary: 'Notification send intent recorded.',
          relatedRecordId: notification.intent.id,
        },
      }),
    ] as const;
    const preparedActivationConsumption: PreparedActivationConsumption | null =
      resolved.preparedActivation === null
        ? null
        : {
            preparedActivationId: resolved.preparedActivation.id,
            eventId: event.id,
            authorization: activationAuthorization,
            requestId: context.invocation.requestId,
            consumedBy: context.invocation.actor,
            consumedAt: at,
          };
    const result = StartEventResultSchema.parse({
      event,
      transition,
      journalEntries,
      notificationIntent: notification.intent,
      preparedActivationConsumption,
    });
    await context.transaction.persistLifecycle({
      result,
      outboxRecord: notification.outbox,
      integrationStatusIds: resolved.integrationStatusIds,
      sendPreviewCreatedAt: preview.createdAt,
    });
    return result;
  },
  resultReference: lifecycleResultReference,
  async loadReplay(reference, context) {
    const result = await context.transaction.loadLifecycleResult(reference);
    if (result === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The original activation result is unavailable.',
        500,
      );
    }
    return StartEventResultSchema.parse(result);
  },
  resolveReplayFacilityId: eventReplayFacilityId,
  replayFacilityId: (result) => result.event.facilityId,
};

function lifecycleAuthorization(
  purpose: 'all-clear' | 'reactivation',
  transitionId: string,
  event: Event,
  preview: LifecycleConsequencePreview,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): LifecycleActionAuthorization {
  const authorization = requireCapabilityAuthorization(context);
  const confirmation = authorization.humanConfirmation;
  const targeting = eventTargeting(event);
  return preview.rosterPopulation === 'staff'
    ? {
        kind: 'human-confirmed-lifecycle',
        purpose,
        targeting,
        lifecyclePreviewId: preview.id,
        transitionId,
        actionIds: authorization.humanActionRequirement.actionIds,
        confirmationId: confirmation?.id ?? '',
        consequenceDigest: preview.consequenceDigest,
        requestId: context.invocation.requestId,
      }
    : {
        kind: 'synthetic-lifecycle',
        purpose,
        targeting,
        lifecyclePreviewId: preview.id,
        transitionId,
        consequenceDigest: preview.consequenceDigest,
        requestId: context.invocation.requestId,
      };
}

function updateEventForTransition(
  event: Event,
  transition: 'all-clear' | 'reactivate' | 'close',
  at: string,
): Event {
  const status = requireTransition(event.status, transition);
  return EventSchema.parse({
    ...event,
    status,
    allClearAt: transition === 'all-clear' ? at : event.allClearAt,
    reactivatedAt: transition === 'reactivate' ? at : event.reactivatedAt,
    closedAt: transition === 'close' ? at : event.closedAt,
  });
}

async function notifyingLifecycleResult(
  capabilityId: 'all-clear-event' | 'reactivate-event',
  transitionKind: 'all-clear' | 'reactivate',
  purpose: 'all-clear' | 'reactivation',
  input:
    | CapabilityInput<'all-clear-event'>
    | CapabilityInput<'reactivate-event'>,
  context: CapabilityHandlerContext<EventCapabilityTransaction>,
): Promise<AllClearEventResult | ReactivateEventResult> {
  const locked = await lockedEvent(input.eventId, context);
  requireTransition(locked.event.status, transitionKind);
  const resolvedPreview = await lifecyclePreview(
    input.lifecyclePreviewId,
    locked.event,
    purpose,
    context,
  );
  const at = timestamp(context.invocation.serverTime);
  const event = updateEventForTransition(locked.event, transitionKind, at);
  const transitionId = randomUUID();
  const notificationAuthorization = lifecycleAuthorization(
    purpose,
    transitionId,
    event,
    resolvedPreview.preview,
    context,
  );
  const confirmation =
    requireCapabilityAuthorization(context).humanConfirmation;
  const transition = EventTransitionSchema.parse({
    id: transitionId,
    sequence: locked.nextTransitionSequence,
    transition: transitionKind,
    eventId: event.id,
    from: transitionKind === 'all-clear' ? 'active' : 'all-clear',
    to: transitionKind === 'all-clear' ? 'all-clear' : 'active',
    actor: context.invocation.actor,
    source: context.invocation.source,
    occurredAt: at,
    requestId: context.invocation.requestId,
    confirmationId: confirmation?.id ?? null,
    consequenceDigest:
      event.rosterPopulation === 'staff'
        ? resolvedPreview.preview.consequenceDigest
        : null,
    targeting: eventTargeting(event),
    idempotencyKey: transitionEvidenceKey(capabilityId, context),
    notificationAuthorization,
  });
  const notification = buildNotification({
    event,
    purpose,
    authorization: notificationAuthorization,
    preview: resolvedPreview.preview,
    context,
  });
  const transitionCode =
    transitionKind === 'all-clear'
      ? ('all-clear-issued' as const)
      : ('event-reactivated' as const);
  const result = EventLifecycleMutationResultSchema.parse({
    event,
    transition,
    journalEntries: [
      makeSystemJournalEntry({
        eventId: event.id,
        sequence: locked.nextJournalSequence,
        context,
        payload: {
          code: transitionCode,
          summary:
            transitionKind === 'all-clear'
              ? 'All-clear issued.'
              : 'Event reactivated.',
          transition,
        },
      }),
      makeSystemJournalEntry({
        eventId: event.id,
        sequence: locked.nextJournalSequence + 1,
        context,
        payload: {
          code: 'notification-intent-recorded',
          summary: 'Notification send intent recorded.',
          relatedRecordId: notification.intent.id,
        },
      }),
    ],
    notificationIntent: notification.intent,
    preparedActivationConsumption: null,
  });
  await context.transaction.persistLifecycle({
    result,
    outboxRecord: notification.outbox,
    integrationStatusIds: resolvedPreview.integrationStatusIds,
    sendPreviewCreatedAt: resolvedPreview.preview.createdAt,
  });
  return result;
}

export const allClearEventRegistration: ServerCapabilityRegistration<
  'all-clear-event',
  EventCapabilityTransaction
> = {
  id: 'all-clear-event',
  async resolveFacilityId(input, context) {
    return eventFacilityId(input.eventId, context);
  },
  async resolveSafety(request, context) {
    const input = request.input as CapabilityInput<'all-clear-event'>;
    const locked = await lockedEvent(input.eventId, context);
    requireTransition(locked.event.status, 'all-clear');
    const preview = await lifecyclePreview(
      input.lifecyclePreviewId,
      locked.event,
      'all-clear',
      context,
    );
    return capabilitySafetyResolution(
      locked.event.kind,
      eventTargeting(locked.event).rosterPopulation,
      preview.preview.consequenceDigest,
    );
  },
  async handler(input, context) {
    return AllClearEventResultSchema.parse(
      await notifyingLifecycleResult(
        'all-clear-event',
        'all-clear',
        'all-clear',
        input,
        context,
      ),
    );
  },
  resultReference: lifecycleResultReference,
  async loadReplay(reference, context) {
    const result = await context.transaction.loadLifecycleResult(reference);
    if (result === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The original all-clear result is unavailable.',
        500,
      );
    }
    return AllClearEventResultSchema.parse(result);
  },
  resolveReplayFacilityId: eventReplayFacilityId,
  replayFacilityId: (result) => result.event.facilityId,
};

export const reactivateEventRegistration: ServerCapabilityRegistration<
  'reactivate-event',
  EventCapabilityTransaction
> = {
  id: 'reactivate-event',
  async resolveFacilityId(input, context) {
    return eventFacilityId(input.eventId, context);
  },
  async resolveSafety(request, context) {
    const input = request.input as CapabilityInput<'reactivate-event'>;
    const locked = await lockedEvent(input.eventId, context);
    requireTransition(locked.event.status, 'reactivate');
    const preview = await lifecyclePreview(
      input.lifecyclePreviewId,
      locked.event,
      'reactivation',
      context,
    );
    return capabilitySafetyResolution(
      locked.event.kind,
      eventTargeting(locked.event).rosterPopulation,
      preview.preview.consequenceDigest,
    );
  },
  async handler(input, context) {
    return ReactivateEventResultSchema.parse(
      await notifyingLifecycleResult(
        'reactivate-event',
        'reactivate',
        'reactivation',
        input,
        context,
      ),
    );
  },
  resultReference: lifecycleResultReference,
  async loadReplay(reference, context) {
    const result = await context.transaction.loadLifecycleResult(reference);
    if (result === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The original reactivation result is unavailable.',
        500,
      );
    }
    return ReactivateEventResultSchema.parse(result);
  },
  resolveReplayFacilityId: eventReplayFacilityId,
  replayFacilityId: (result) => result.event.facilityId,
};

export const closeEventRegistration: ServerCapabilityRegistration<
  'close-event',
  EventCapabilityTransaction
> = {
  id: 'close-event',
  async resolveFacilityId(input, context) {
    return eventFacilityId(input.eventId, context);
  },
  async resolveSafety(request, context) {
    const input = request.input as CapabilityInput<'close-event'>;
    const event = (await lockedEvent(input.eventId, context)).event;
    requireTransition(event.status, 'close');
    return capabilitySafetyResolution(
      event.kind,
      eventTargeting(event).rosterPopulation,
      deriveCloseConsequenceDigest(event),
    );
  },
  async handler(input, context): Promise<CloseEventResult> {
    const locked = await lockedEvent(input.eventId, context);
    const at = timestamp(context.invocation.serverTime);
    const event = updateEventForTransition(locked.event, 'close', at);
    const confirmation =
      requireCapabilityAuthorization(context).humanConfirmation;
    const targeting = eventTargeting(event);
    const transition = EventTransitionSchema.parse({
      id: randomUUID(),
      sequence: locked.nextTransitionSequence,
      transition: 'close',
      eventId: event.id,
      from: 'all-clear',
      to: 'closed',
      actor: context.invocation.actor,
      source: context.invocation.source,
      occurredAt: at,
      requestId: context.invocation.requestId,
      confirmationId: confirmation?.id ?? null,
      consequenceDigest:
        targeting.kind === 'incident'
          ? deriveCloseConsequenceDigest(locked.event)
          : null,
      targeting,
      idempotencyKey: transitionEvidenceKey('close-event', context),
    });
    const result = CloseEventResultSchema.parse({
      event,
      transition,
      journalEntries: [
        makeSystemJournalEntry({
          eventId: event.id,
          sequence: locked.nextJournalSequence,
          context,
          payload: {
            code: 'event-closed',
            summary: 'Event closed.',
            transition,
          },
        }),
      ],
      notificationIntent: null,
      preparedActivationConsumption: null,
    });
    await context.transaction.persistLifecycle({
      result,
      outboxRecord: null,
      integrationStatusIds: {},
      sendPreviewCreatedAt: null,
    });
    return result;
  },
  resultReference: lifecycleResultReference,
  async loadReplay(reference, context) {
    const result = await context.transaction.loadLifecycleResult(reference);
    if (result === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The original close result is unavailable.',
        500,
      );
    }
    return CloseEventResultSchema.parse(result);
  },
  resolveReplayFacilityId: eventReplayFacilityId,
  replayFacilityId: (result) => result.event.facilityId,
};

export const reopenAsCorrectionRegistration: ServerCapabilityRegistration<
  'reopen-as-correction',
  EventCapabilityTransaction
> = {
  id: 'reopen-as-correction',
  async resolveFacilityId(input, context) {
    return eventFacilityId(input.sourceEventId, context);
  },
  async handler(input, context): Promise<ReopenAsCorrectionResult> {
    const locked = await lockedEvent(input.sourceEventId, context);
    requireTransition(locked.event.status, 'reopen-as-correction');
    const at = timestamp(context.invocation.serverTime);
    const correction = EventSchema.parse({
      id: randomUUID(),
      facilityId: locked.event.facilityId,
      kind: locked.event.kind,
      templateMode: locked.event.templateMode,
      eventTypeVersion: locked.event.eventTypeVersion,
      status: 'draft',
      rosterSnapshotId: null,
      rosterPopulation: null,
      createdBy: context.invocation.actor,
      createdAt: at,
      activatedAt: null,
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: locked.event.id,
      correctionReason: input.reason,
      activationAuthorization: null,
    });
    const transition = EventTransitionSchema.parse({
      id: randomUUID(),
      sequence: 1,
      transition: 'reopen-as-correction',
      sourceEventId: locked.event.id,
      correctionEventId: correction.id,
      from: 'closed',
      to: 'draft',
      reason: input.reason,
      actor: context.invocation.actor,
      source: context.invocation.source,
      occurredAt: at,
      requestId: context.invocation.requestId,
      confirmationId: null,
      consequenceDigest: null,
      targeting: eventTargeting(locked.event),
      idempotencyKey: transitionEvidenceKey('reopen-as-correction', context),
    });
    const result = ReopenAsCorrectionResultSchema.parse({
      event: correction,
      transition,
      journalEntries: [
        makeSystemJournalEntry({
          eventId: correction.id,
          sequence: 1,
          context,
          payload: {
            code: 'event-created',
            summary: 'Correction event record created.',
            relatedRecordId: correction.id,
          },
        }),
        makeSystemJournalEntry({
          eventId: correction.id,
          sequence: 2,
          context,
          payload: {
            code: 'correction-opened',
            summary: 'Closed event reopened as a correction record.',
            transition,
          },
        }),
      ],
      notificationIntent: null,
      preparedActivationConsumption: null,
    });
    await context.transaction.persistLifecycle({
      result,
      outboxRecord: null,
      integrationStatusIds: {},
      sendPreviewCreatedAt: null,
    });
    return result;
  },
  resultReference: lifecycleResultReference,
  async loadReplay(reference, context) {
    const result = await context.transaction.loadLifecycleResult(reference);
    if (result === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The original correction result is unavailable.',
        500,
      );
    }
    return ReopenAsCorrectionResultSchema.parse(result);
  },
  resolveReplayFacilityId: eventReplayFacilityId,
  replayFacilityId: (result) => result.event.facilityId,
};

export const joinEventRegistration: ServerCapabilityRegistration<
  'join-event',
  EventCapabilityTransaction
> = {
  id: 'join-event',
  async resolveFacilityId(input, context) {
    return eventFacilityId(input.eventId, context);
  },
  async handler(input, context): Promise<JoinEventResult> {
    const locked = await lockedEvent(input.eventId, context);
    if (locked.event.status !== 'active') {
      throw conflict('Only an active event can be joined.');
    }
    const participantId = randomUUID();
    const journalEntry = makeSystemJournalEntry({
      eventId: locked.event.id,
      sequence: locked.nextJournalSequence,
      context,
      payload: {
        code: 'participant-joined',
        summary: 'Authenticated participant joined the event.',
        relatedRecordId: participantId,
      },
    });
    const result = JoinEventResultSchema.parse({
      event: locked.event,
      participantId,
      joined: true,
    });
    await context.transaction.persistJoin({ result, journalEntry });
    context.cache.set('event:join-journal-id', journalEntry.id);
    return result;
  },
  resultReference(result, context) {
    const journalEntryId = context.cache.get('event:join-journal-id');
    if (typeof journalEntryId !== 'string') {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The join result could not be retained.',
        500,
      );
    }
    return joinResultReference(result, journalEntryId);
  },
  async loadReplay(reference, context) {
    const result = await context.transaction.loadJoinResult(reference);
    if (result === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The original join result is unavailable.',
        500,
      );
    }
    return JoinEventResultSchema.parse(result);
  },
  resolveReplayFacilityId: eventReplayFacilityId,
  replayFacilityId: (result) => result.event.facilityId,
};

export const listActiveEventsRegistration: ServerCapabilityRegistration<
  'list-active-events',
  EventCapabilityTransaction
> = {
  id: 'list-active-events',
  resolveFacilityId: (input) => input.facilityId,
  async handler(input, context): Promise<EventPage> {
    return EventPageSchema.parse(
      await context.transaction.listActiveEvents(
        input,
        context.invocation.scope,
      ),
    );
  },
};

export const getEventRegistration: ServerCapabilityRegistration<
  'get-event',
  EventCapabilityTransaction
> = {
  id: 'get-event',
  async resolveFacilityId(input, context) {
    return eventFacilityId(input.eventId, context);
  },
  async handler(input, context): Promise<Event> {
    const event = await context.transaction.getEvent(input.eventId);
    if (event === null) {
      throw notFound();
    }
    return EventSchema.parse(event);
  },
};

const registrations = Object.freeze({
  'start-event': startEventRegistration,
  'list-active-events': listActiveEventsRegistration,
  'get-event': getEventRegistration,
  'join-event': joinEventRegistration,
  'all-clear-event': allClearEventRegistration,
  'reactivate-event': reactivateEventRegistration,
  'close-event': closeEventRegistration,
  'reopen-as-correction': reopenAsCorrectionRegistration,
});

export async function executeEventCapability<Id extends EventCapabilityId>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: EventCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, EventCapabilityTransaction>;
  return executeCapability(registration, input, invocation, store);
}

export interface EventCapabilityRuntime {
  readonly store: EventCapabilityStore;
  execute<Id extends EventCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  close(): Promise<void>;
}

type EventQueryDatabase = DatabaseQuery;

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function readDatabaseTime(database: EventQueryDatabase): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw conflict('The authoritative database clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

function decodeOffsetCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/u.test(decoded)) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'PERSISTENCE_CONFLICT',
      'The pagination cursor is invalid.',
      400,
    );
  }
  return Number(decoded);
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function eventFromRow(row: typeof events.$inferSelect): Event {
  return EventSchema.parse({
    id: row.id,
    facilityId: row.facilityId,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    status: row.status,
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    createdBy: row.createdBy,
    createdAt: dateIso(row.createdAt),
    activatedAt: row.activatedAt === null ? null : dateIso(row.activatedAt),
    allClearAt: row.allClearAt === null ? null : dateIso(row.allClearAt),
    reactivatedAt:
      row.reactivatedAt === null ? null : dateIso(row.reactivatedAt),
    closedAt: row.closedAt === null ? null : dateIso(row.closedAt),
    correctionOfEventId: row.correctionOfEventId,
    correctionReason: row.correctionReason,
    activationAuthorization: row.activationAuthorization,
  });
}

function transitionFromRow(
  row: typeof eventTransitions.$inferSelect,
): EventTransition {
  const common = {
    id: row.id,
    sequence: row.sequence,
    transition: row.transition,
    from: row.fromStatus,
    to: row.toStatus,
    actor: row.actor,
    source: row.source,
    occurredAt: dateIso(row.occurredAt),
    requestId: row.requestId,
    confirmationId: row.confirmationId,
    consequenceDigest: row.consequenceDigest,
    targeting: {
      kind: row.kind,
      templateMode: row.templateMode,
      rosterPopulation: row.rosterPopulation,
    },
    idempotencyKey: row.idempotencyKey,
  };
  switch (row.transition) {
    case 'activate':
      return EventTransitionSchema.parse({
        ...common,
        eventId: row.eventId,
        activationAuthorization: row.activationAuthorization,
      });
    case 'all-clear':
    case 'reactivate':
      return EventTransitionSchema.parse({
        ...common,
        eventId: row.eventId,
        notificationAuthorization: row.notificationAuthorization,
      });
    case 'close':
      return EventTransitionSchema.parse({
        ...common,
        eventId: row.eventId,
      });
    case 'reopen-as-correction':
      return EventTransitionSchema.parse({
        ...common,
        sourceEventId: row.sourceEventId,
        correctionEventId: row.correctionEventId,
        reason: row.correctionReason,
      });
  }
}

function journalFromRow(row: typeof journalEntries.$inferSelect): JournalEntry {
  return JournalEntrySchema.parse({
    id: row.id,
    eventId: row.eventId,
    sequence: row.sequence,
    kind: row.kind,
    author: row.author,
    source: row.source,
    serverTime: dateIso(row.serverTime),
    clientTime: row.clientTime === null ? null : dateIso(row.clientTime),
    payload: row.payload,
    supersedes:
      row.supersedesEntryId === null
        ? null
        : {
            entryId: row.supersedesEntryId,
            entrySequence: row.supersedesEntrySequence,
            kind: row.supersessionKind,
            reason: row.supersessionReason,
          },
  });
}

function applyTransitionSnapshot(
  current: Event,
  transition: EventTransition,
  persisted: Event,
): Event {
  switch (transition.transition) {
    case 'activate':
      return EventSchema.parse({
        ...current,
        status: 'active',
        rosterSnapshotId: persisted.rosterSnapshotId,
        rosterPopulation: transition.targeting.rosterPopulation,
        activatedAt: transition.occurredAt,
        allClearAt: null,
        reactivatedAt: null,
        closedAt: null,
        activationAuthorization: transition.activationAuthorization,
      });
    case 'all-clear':
      return EventSchema.parse({
        ...current,
        status: 'all-clear',
        allClearAt: transition.occurredAt,
      });
    case 'reactivate':
      return EventSchema.parse({
        ...current,
        status: 'active',
        reactivatedAt: transition.occurredAt,
      });
    case 'close':
      return EventSchema.parse({
        ...current,
        status: 'closed',
        closedAt: transition.occurredAt,
      });
    case 'reopen-as-correction':
      return current;
  }
}

async function hydrateEventAtJournalSequence(
  database: EventQueryDatabase,
  eventId: string,
  journalSequence: number,
): Promise<Event | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const persisted = eventFromRow(row);
  let snapshot = EventSchema.parse({
    ...persisted,
    status: 'draft',
    rosterSnapshotId: null,
    rosterPopulation: null,
    activatedAt: null,
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    activationAuthorization: null,
  });
  const rows = await database
    .select({ transition: eventTransitions })
    .from(eventTransitions)
    .innerJoin(
      journalEntries,
      and(
        eq(journalEntries.transitionId, eventTransitions.id),
        eq(journalEntries.eventId, eventId),
        sql`${journalEntries.sequence} <= ${journalSequence}`,
      ),
    )
    .where(eq(eventTransitions.journalEventId, eventId))
    .orderBy(asc(eventTransitions.sequence));
  for (const transitionRow of rows) {
    snapshot = applyTransitionSnapshot(
      snapshot,
      transitionFromRow(transitionRow.transition),
      persisted,
    );
  }
  return snapshot;
}

function parseLifecycleReference(value: string): Readonly<{
  transitionId: string;
  journalEntryIds: readonly string[];
  notificationIntentId: string | null;
  preparedActivationId: string | null;
}> | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      parsed.k !== 'l' ||
      typeof parsed.t !== 'string' ||
      !Array.isArray(parsed.j) ||
      !parsed.j.every((id) => typeof id === 'string') ||
      (parsed.n !== null && typeof parsed.n !== 'string') ||
      (parsed.p !== null && typeof parsed.p !== 'string')
    ) {
      return null;
    }
    return {
      transitionId: parsed.t,
      journalEntryIds: parsed.j,
      notificationIntentId: parsed.n as string | null,
      preparedActivationId: parsed.p as string | null,
    };
  } catch {
    return null;
  }
}

function parseJoinReference(value: string): Readonly<{
  eventId: string;
  journalEntryId: string;
  participantId: string;
}> | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      parsed.k !== 'j' ||
      typeof parsed.e !== 'string' ||
      typeof parsed.j !== 'string' ||
      typeof parsed.p !== 'string'
    ) {
      return null;
    }
    return {
      eventId: parsed.e,
      journalEntryId: parsed.j,
      participantId: parsed.p,
    };
  } catch {
    return null;
  }
}

function integrationStatusFromRow(
  row: typeof integrationStatuses.$inferSelect,
) {
  return IntegrationStatusSchema.parse({
    integrationId: row.integrationId,
    label: row.label,
    verifiedAt: row.verifiedAt === null ? null : dateIso(row.verifiedAt),
    verifiedByUserId: row.verifiedByUserId,
    authorizationReference: row.authorizationReference,
    reasonCode: row.reasonCode,
    observedAt: dateIso(row.observedAt),
  });
}

async function resolveIntegrationStatusIds(
  database: EventQueryDatabase,
  channels: ActivationPreview['channels'],
): Promise<Readonly<Record<string, string>>> {
  const integrationIds = channels.map(
    (channel) => channel.integrationStatus.integrationId,
  );
  const rows = await database
    .select({
      enabled: channelConfigurations.enabled,
      status: integrationStatuses,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      eq(channelConfigurations.statusId, integrationStatuses.id),
    )
    .where(inArray(channelConfigurations.integrationId, integrationIds))
    .for('share');
  const resolved: Record<string, string> = {};
  for (const channel of channels) {
    const expected = channel.integrationStatus;
    const matching = rows.find((row) => {
      const actual = integrationStatusFromRow(row.status);
      return (
        row.enabled &&
        actual.integrationId === expected.integrationId &&
        actual.label === expected.label &&
        actual.verifiedByUserId === expected.verifiedByUserId &&
        actual.authorizationReference === expected.authorizationReference &&
        actual.reasonCode === expected.reasonCode &&
        Date.parse(actual.observedAt) === Date.parse(expected.observedAt) &&
        (actual.verifiedAt === null
          ? expected.verifiedAt === null
          : expected.verifiedAt !== null &&
            Date.parse(actual.verifiedAt) === Date.parse(expected.verifiedAt))
      );
    });
    if (matching === undefined) {
      throw conflict(
        'The consequence preview no longer matches current integration readiness.',
      );
    }
    resolved[channel.channel] = matching.status.id;
  }
  return Object.freeze(resolved);
}

async function activationPreviewById(
  database: EventQueryDatabase,
  previewId: string,
): Promise<ActivationPreview | null> {
  const [row] = await database
    .select()
    .from(activationPreviews)
    .where(eq(activationPreviews.id, previewId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const [audience] = await database
    .select({ facilityId: audienceConfigurations.facilityId })
    .from(audienceConfigurations)
    .where(
      and(
        eq(audienceConfigurations.id, row.audienceConfigId),
        eq(audienceConfigurations.version, row.audienceConfigVersion),
      ),
    )
    .limit(1);
  if (audience?.facilityId !== row.facilityId) {
    throw conflict(
      'The activation audience is not owned by the event facility.',
    );
  }
  return ActivationPreviewSchema.parse({
    id: row.id,
    facilityId: row.facilityId,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    recipientCount: row.recipientCount,
    channels: row.channels,
    sendReadiness: row.sendReadiness,
    blockingReasonCodes: row.blockingReasonCodes,
    activeEventIds: row.activeEventIds,
    deliveryTest:
      row.deliveryTestTargetSetId === null ||
      row.deliveryTestTargetSetVersion === null ||
      row.deliveryTestEndpointReferenceDigest === null
        ? null
        : {
            purpose: 'monthly-live-delivery-test',
            targetSet: {
              id: row.deliveryTestTargetSetId,
              version: row.deliveryTestTargetSetVersion,
            },
            endpointReferenceDigest: row.deliveryTestEndpointReferenceDigest,
          },
    consequenceDigest: row.consequenceDigest,
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

async function lifecyclePreviewById(
  database: EventQueryDatabase,
  previewId: string,
): Promise<LifecycleConsequencePreview | null> {
  const [row] = await database
    .select()
    .from(lifecycleConsequencePreviews)
    .where(eq(lifecycleConsequencePreviews.id, previewId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const [eventAudience] = await database
    .select({ facilityId: events.facilityId })
    .from(events)
    .innerJoin(
      audienceConfigurations,
      and(
        eq(audienceConfigurations.id, row.audienceConfigId),
        eq(audienceConfigurations.version, row.audienceConfigVersion),
        eq(audienceConfigurations.facilityId, events.facilityId),
      ),
    )
    .where(eq(events.id, row.eventId))
    .limit(1);
  if (eventAudience === undefined) {
    throw conflict(
      'The lifecycle audience is not owned by the event facility.',
    );
  }
  return LifecycleConsequencePreviewSchema.parse({
    id: row.id,
    eventId: row.eventId,
    purpose: row.purpose,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    recipientCount: row.recipientCount,
    channels: row.channels,
    sendReadiness: row.sendReadiness,
    blockingReasonCodes: row.blockingReasonCodes,
    consequenceDigest: row.consequenceDigest,
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

async function notificationIntentById(
  database: EventQueryDatabase,
  intentId: string,
): Promise<NotificationIntent | null> {
  const [row] = await database
    .select()
    .from(notificationIntents)
    .where(eq(notificationIntents.id, intentId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const [outboxRow] = await database
    .select({ channels: outbox.channels })
    .from(outbox)
    .where(eq(outbox.intentId, intentId))
    .limit(1);
  if (outboxRow === undefined) {
    return null;
  }
  return NotificationIntentSchema.parse({
    id: row.id,
    eventId: row.eventId,
    eventKind: row.eventKind,
    templateMode: row.templateMode,
    purpose: row.purpose,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    deliveryTest:
      row.deliveryTestTargetSetId === null ||
      row.deliveryTestTargetSetVersion === null ||
      row.deliveryTestEndpointReferenceDigest === null
        ? null
        : {
            purpose: 'monthly-live-delivery-test',
            targetSet: {
              id: row.deliveryTestTargetSetId,
              version: row.deliveryTestTargetSetVersion,
            },
            endpointReferenceDigest: row.deliveryTestEndpointReferenceDigest,
          },
    createdBy: row.createdBy,
    source: row.source,
    requestId: row.requestId,
    authorization: row.authorization,
    channels: outboxRow.channels,
    createdAt: dateIso(row.createdAt),
  });
}

function preparedConsumptionFromRow(
  row: typeof preparedActivationConsumptions.$inferSelect,
): PreparedActivationConsumption {
  return PreparedActivationConsumptionSchema.parse({
    preparedActivationId: row.preparedActivationId,
    eventId: row.eventId,
    authorization: row.authorization,
    requestId: row.requestId,
    consumedBy: row.consumedBy,
    consumedAt: dateIso(row.consumedAt),
  });
}

async function appendCapabilityAuditEntry(
  database: EventQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  await database.execute(ACCESS_GATE_AUDIT_LOCK_SQL);
  const [previous] = await database
    .select({
      sequence: securityAuditEntries.sequence,
      entryHash: securityAuditEntries.entryHash,
    })
    .from(securityAuditEntries)
    .orderBy(desc(securityAuditEntries.sequence))
    .limit(1);
  const sequence = (previous?.sequence ?? 0) + 1;
  const previousHash = previous?.entryHash ?? null;
  const id = randomUUID();
  const hashPayload = {
    id,
    sequence,
    previousHash,
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability' as const, id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: timestamp(event.occurredAt),
  };
  const entry = SecurityAuditEntrySchema.parse({
    ...hashPayload,
    entryHash: digestCapabilityValue(hashPayload),
  });
  await database.insert(securityAuditEntries).values({
    id: entry.id,
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    entryHash: entry.entryHash,
    category: entry.category,
    action: entry.action,
    actionIds: entry.actionIds,
    confirmationId: entry.confirmationId,
    outcome: entry.outcome,
    principalKind: entry.principal.kind,
    principal: entry.principal,
    source: entry.source,
    facilityId: entry.facilityId,
    targetKind: entry.target?.kind ?? null,
    targetId: entry.target?.id ?? null,
    requestId: entry.requestId,
    reasonCode: entry.reasonCode,
    occurredAt: new Date(entry.occurredAt),
  });
}

async function claimIdempotency(
  database: EventQueryDatabase,
  input: ClaimIdempotencyInput,
): Promise<IdempotencyClaim> {
  const [inserted] = await database
    .insert(idempotencyRecords)
    .values({
      capabilityId: input.capabilityId,
      principal: input.actor,
      principalDigest: input.principalDigest,
      key: input.key,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.capabilityId,
        idempotencyRecords.principalDigest,
        idempotencyRecords.key,
      ],
    })
    .returning({ id: idempotencyRecords.id });
  if (inserted !== undefined) {
    return { kind: 'new', recordId: inserted.id };
  }
  const [existing] = await database
    .select({
      requestDigest: idempotencyRecords.requestDigest,
      status: idempotencyRecords.status,
      resultReference: idempotencyRecords.resultReference,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.capabilityId, input.capabilityId),
        eq(idempotencyRecords.principalDigest, input.principalDigest),
        eq(idempotencyRecords.key, input.key),
      ),
    )
    .for('update')
    .limit(1);
  if (existing === undefined) {
    throw conflict('The idempotency reservation could not be resolved.');
  }
  if (existing.status === 'completed' && existing.resultReference !== null) {
    return {
      kind: 'completed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  if (existing.status === 'failed' && existing.resultReference !== null) {
    return {
      kind: 'failed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  return { kind: 'in-progress', requestDigest: existing.requestDigest };
}

async function completeIdempotency(
  database: EventQueryDatabase,
  input: CompleteIdempotencyInput,
): Promise<void> {
  const [completed] = await database
    .update(idempotencyRecords)
    .set({
      status: 'completed',
      completedAt: input.completedAt,
      resultReference: input.resultReference,
    })
    .where(
      and(
        eq(idempotencyRecords.id, input.recordId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (completed === undefined) {
    throw conflict('The idempotency result could not be completed.');
  }
}

async function getHumanConfirmation(
  database: EventQueryDatabase,
  confirmationId: string,
) {
  const [row] = await database
    .select()
    .from(humanConfirmationRecords)
    .where(eq(humanConfirmationRecords.id, confirmationId))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const actions = await database
    .select({ actionId: humanConfirmationActions.actionId })
    .from(humanConfirmationActions)
    .where(eq(humanConfirmationActions.confirmationId, confirmationId))
    .orderBy(asc(humanConfirmationActions.actionId));
  return HumanConfirmationRecordSchema.parse({
    confirmation: {
      id: row.id,
      capabilityId: row.capabilityId,
      actionIds: actions.map((action) => action.actionId),
      connectivityEpochId: row.connectivityEpochId,
      confirmedByUserId: row.confirmedByUserId,
      confirmedWithSessionId: row.confirmedWithSessionId,
      consequenceDigest: row.consequenceDigest,
      issuedAt: dateIso(row.issuedAt),
      expiresAt: dateIso(row.expiresAt),
    },
    status: row.status,
    consumedAt: row.consumedAt === null ? null : dateIso(row.consumedAt),
    consumedForRequestId: row.consumedForRequestId,
    expiredAt: row.expiredAt === null ? null : dateIso(row.expiredAt),
  });
}

async function consumeHumanConfirmation(
  database: EventQueryDatabase,
  input: ConsumeHumanConfirmationInput,
): Promise<boolean> {
  const [consumed] = await database
    .update(humanConfirmationRecords)
    .set({
      status: 'consumed',
      consumedAt: sql`clock_timestamp()`,
      consumedForRequestId: input.requestId,
    })
    .where(
      and(
        eq(humanConfirmationRecords.id, input.confirmationId),
        eq(humanConfirmationRecords.status, 'issued'),
        sql`${humanConfirmationRecords.issuedAt} <= clock_timestamp()`,
        sql`${humanConfirmationRecords.expiresAt} >= clock_timestamp()`,
      ),
    )
    .returning({ id: humanConfirmationRecords.id });
  return consumed !== undefined;
}

function eventInsertValues(event: Event): typeof events.$inferInsert {
  return {
    id: event.id,
    facilityId: event.facilityId,
    kind: event.kind,
    templateMode: event.templateMode,
    eventTypeVersionId: event.eventTypeVersion.id,
    status: event.status,
    rosterSnapshotId: event.rosterSnapshotId,
    rosterPopulation: event.rosterPopulation,
    createdBy: event.createdBy,
    createdAt: new Date(event.createdAt),
    activatedAt:
      event.activatedAt === null ? null : new Date(event.activatedAt),
    allClearAt: event.allClearAt === null ? null : new Date(event.allClearAt),
    reactivatedAt:
      event.reactivatedAt === null ? null : new Date(event.reactivatedAt),
    closedAt: event.closedAt === null ? null : new Date(event.closedAt),
    correctionOfEventId: event.correctionOfEventId,
    correctionReason: event.correctionReason,
    activationAuthorization: event.activationAuthorization,
  };
}

function transitionInsertValues(
  transition: EventTransition,
): typeof eventTransitions.$inferInsert {
  const common = {
    id: transition.id,
    sequence: transition.sequence,
    transition: transition.transition,
    journalEventId:
      transition.transition === 'reopen-as-correction'
        ? transition.correctionEventId
        : transition.eventId,
    fromStatus: transition.from,
    toStatus: transition.to,
    kind: transition.targeting.kind,
    templateMode: transition.targeting.templateMode,
    rosterPopulation: transition.targeting.rosterPopulation,
    actor: transition.actor,
    source: transition.source,
    occurredAt: new Date(transition.occurredAt),
    requestId: transition.requestId,
    confirmationId: transition.confirmationId,
    confirmationStatus:
      transition.confirmationId === null ? null : ('consumed' as const),
    consequenceDigest: transition.consequenceDigest,
    idempotencyKey: transition.idempotencyKey,
  };
  switch (transition.transition) {
    case 'activate':
      return {
        ...common,
        eventId: transition.eventId,
        sourceEventId: null,
        correctionEventId: null,
        activationAuthorization: transition.activationAuthorization,
        notificationAuthorization: null,
        correctionReason: null,
      };
    case 'all-clear':
    case 'reactivate':
      return {
        ...common,
        eventId: transition.eventId,
        sourceEventId: null,
        correctionEventId: null,
        activationAuthorization: null,
        notificationAuthorization: transition.notificationAuthorization,
        correctionReason: null,
      };
    case 'close':
      return {
        ...common,
        eventId: transition.eventId,
        sourceEventId: null,
        correctionEventId: null,
        activationAuthorization: null,
        notificationAuthorization: null,
        correctionReason: null,
      };
    case 'reopen-as-correction':
      return {
        ...common,
        eventId: null,
        sourceEventId: transition.sourceEventId,
        correctionEventId: transition.correctionEventId,
        activationAuthorization: null,
        notificationAuthorization: null,
        correctionReason: transition.reason,
      };
  }
}

function journalInsertValues(
  entry: JournalEntry,
): typeof journalEntries.$inferInsert {
  const transitionId =
    entry.kind === 'system' && 'transition' in entry.payload
      ? entry.payload.transition.id
      : null;
  const mediaId = entry.kind === 'photo' ? entry.payload.mediaId : null;
  return {
    id: entry.id,
    eventId: entry.eventId,
    sequence: entry.sequence,
    kind: entry.kind,
    author: entry.author,
    source: entry.source,
    serverTime: new Date(entry.serverTime),
    clientTime: entry.clientTime === null ? null : new Date(entry.clientTime),
    payload: entry.payload,
    mediaId,
    transitionId,
    supersedesEntryId: entry.supersedes?.entryId ?? null,
    supersedesEntrySequence: entry.supersedes?.entrySequence ?? null,
    supersessionKind: entry.supersedes?.kind ?? null,
    supersessionReason: entry.supersedes?.reason ?? null,
  };
}

async function persistNotification(
  database: EventQueryDatabase,
  intent: NotificationIntent,
  outboxRecord: OutboxRecord,
  integrationStatusIds: Readonly<Record<string, string>>,
): Promise<void> {
  // A notification intent is inserted plainly. It used to be bound at insert to
  // a notification control record and its enable epoch, so a deployment that had
  // never been switched on refused every activation and said only that sending
  // was "unavailable". What authorizes this send is upstream and unchanged:
  // an authenticated human, a fresh consequence preview, and the human-only
  // capability registry.
  await database.insert(notificationIntents).values({
    id: intent.id,
    eventId: intent.eventId,
    eventKind: intent.eventKind,
    templateMode: intent.templateMode,
    purpose: intent.purpose,
    eventTypeVersionId: intent.eventTypeVersion.id,
    rosterSnapshotId: intent.rosterSnapshotId,
    rosterPopulation: intent.rosterPopulation,
    audienceConfigId: intent.audienceConfig.id,
    audienceConfigVersion: intent.audienceConfig.version,
    createdBy: intent.createdBy,
    source: intent.source,
    requestId: intent.requestId,
    authorization: intent.authorization,
    deliveryTestTargetSetId: intent.deliveryTest?.targetSet.id ?? null,
    deliveryTestTargetSetVersion:
      intent.deliveryTest?.targetSet.version ?? null,
    deliveryTestEndpointReferenceDigest:
      intent.deliveryTest?.endpointReferenceDigest ?? null,
    createdAt: new Date(intent.createdAt),
  });
  await database.insert(notificationIntentChannels).values(
    intent.channels.map((channel, index) => {
      const integrationStatusId = integrationStatusIds[channel.channel];
      if (integrationStatusId === undefined) {
        throw conflict(
          'The notification channel integration evidence is unavailable.',
        );
      }
      return {
        intentId: intent.id,
        sequence: index + 1,
        channel: channel.channel,
        eventKind: intent.eventKind,
        templateMode: intent.templateMode,
        purpose: intent.purpose,
        rosterPopulation: intent.rosterPopulation,
        classificationMarker: channel.renderedMessage.classificationMarker,
        endpointCount: channel.endpointCount,
        renderedMessage: channel.renderedMessage,
        integrationStatusId,
        integrationId: channel.integrationStatus.integrationId,
        integrationLabel: channel.integrationStatus.label,
      };
    }),
  );
  const message = outboxRecord.message;
  await database.insert(outbox).values({
    id: outboxRecord.id,
    messageVersion: message.version,
    intentId: message.intentId,
    eventId: message.eventId,
    eventKind: message.eventKind,
    templateMode: message.templateMode,
    purpose: message.purpose,
    eventTypeVersionId: message.eventTypeVersion.id,
    rosterSnapshotId: message.rosterSnapshotId,
    rosterPopulation: message.rosterPopulation,
    audienceConfigId: message.audienceConfig.id,
    audienceConfigVersion: message.audienceConfig.version,
    requestId: message.requestId,
    authorization: message.authorization,
    channels: message.channels,
    message,
    status: outboxRecord.status,
    attempts: outboxRecord.attempts,
    availableAt: new Date(outboxRecord.availableAt),
    lockedUntil:
      outboxRecord.lockedUntil === null
        ? null
        : new Date(outboxRecord.lockedUntil),
    publishedAt:
      outboxRecord.publishedAt === null
        ? null
        : new Date(outboxRecord.publishedAt),
    failedAt:
      outboxRecord.failedAt === null ? null : new Date(outboxRecord.failedAt),
    lastErrorCode: outboxRecord.lastErrorCode,
    createdAt: new Date(message.createdAt),
  });
}

async function persistLifecycleBundle(
  database: EventQueryDatabase,
  bundle: LifecyclePersistenceBundle,
): Promise<void> {
  const { event, transition } = bundle.result;
  if (
    transition.transition === 'activate' ||
    transition.transition === 'reopen-as-correction'
  ) {
    await database.insert(events).values(eventInsertValues(event));
  } else {
    const [updated] = await database
      .update(events)
      .set({
        status: event.status,
        allClearAt:
          event.allClearAt === null ? null : new Date(event.allClearAt),
        reactivatedAt:
          event.reactivatedAt === null ? null : new Date(event.reactivatedAt),
        closedAt: event.closedAt === null ? null : new Date(event.closedAt),
      })
      .where(
        and(
          eq(events.id, event.id),
          eq(events.status, transition.from),
          eq(events.kind, event.kind),
          eq(events.templateMode, event.templateMode),
        ),
      )
      .returning({ id: events.id });
    if (updated === undefined) {
      throw conflict('The event lifecycle changed before it could be saved.');
    }
  }
  await database
    .insert(eventTransitions)
    .values(transitionInsertValues(transition));
  await database
    .insert(journalEntries)
    .values(bundle.result.journalEntries.map(journalInsertValues));

  const consumption = bundle.result.preparedActivationConsumption;
  if (consumption !== null) {
    const intent = bundle.result.notificationIntent;
    if (intent === null) {
      throw conflict(
        'Prepared activation consumption requires notification truth.',
      );
    }
    await database.insert(preparedActivationConsumptions).values({
      preparedActivationId: consumption.preparedActivationId,
      eventId: consumption.eventId,
      facilityId: event.facilityId,
      kind: event.kind,
      templateMode: event.templateMode,
      eventTypeVersionId: event.eventTypeVersion.id,
      rosterSnapshotId: intent.rosterSnapshotId,
      rosterPopulation: intent.rosterPopulation,
      audienceConfigId: intent.audienceConfig.id,
      audienceConfigVersion: intent.audienceConfig.version,
      consequenceDigest: consumption.authorization.consequenceDigest,
      authorization: consumption.authorization,
      requestId: consumption.requestId,
      consumedBy: consumption.consumedBy,
      consumedAt: new Date(consumption.consumedAt),
    });
  }

  if (bundle.result.notificationIntent !== null) {
    if (bundle.outboxRecord === null) {
      throw conflict('Notification intent requires an atomic outbox record.');
    }
    if (bundle.sendPreviewCreatedAt === null) {
      throw conflict(
        'Notification intent requires exact consequence-preview provenance.',
      );
    }
    await persistNotification(
      database,
      bundle.result.notificationIntent,
      bundle.outboxRecord,
      bundle.integrationStatusIds,
    );
    const intent = bundle.result.notificationIntent;
    if (intent.deliveryTest != null) {
      const authorization = intent.authorization;
      if (
        bundle.result.transition.transition !== 'activate' ||
        authorization.kind !== 'human-confirmed' ||
        intent.createdBy.kind !== 'human' ||
        (intent.source !== 'web' && intent.source !== 'mobile') ||
        bundle.result.event.kind !== 'drill' ||
        bundle.result.event.templateMode !== 'drill' ||
        bundle.result.event.rosterPopulation !== 'staff' ||
        bundle.result.event.activatedAt === null ||
        authorization.preparedActivationId !== null ||
        bundle.result.transition.confirmationId !== authorization.confirmationId
      ) {
        throw conflict(
          'The monthly delivery-test activation evidence is inconsistent.',
        );
      }
      await database.insert(deliveryTestRuns).values({
        id: randomUUID(),
        activationPreviewId: authorization.activationPreviewId,
        eventId: bundle.result.event.id,
        notificationIntentId: intent.id,
        targetSetVersionId: intent.deliveryTest.targetSet.id,
        targetSetVersion: intent.deliveryTest.targetSet.version,
        endpointReferenceDigest: intent.deliveryTest.endpointReferenceDigest,
        consequenceDigest: authorization.consequenceDigest,
        confirmationId: authorization.confirmationId,
        confirmationStatus: 'consumed',
        requestId: intent.requestId,
        startedByUserId: intent.createdBy.userId,
        startedWithSessionId: intent.createdBy.sessionId,
        startedAt: new Date(bundle.result.event.activatedAt),
      });
    }
  } else if (
    bundle.outboxRecord !== null ||
    bundle.sendPreviewCreatedAt !== null
  ) {
    throw conflict(
      'Send provenance cannot exist without a notification intent.',
    );
  }
}

async function resolveReplayFacilityIdFromDatabase(
  database: EventQueryDatabase,
  resultReference: string,
): Promise<string | null> {
  const lifecycleReference = parseLifecycleReference(resultReference);
  if (lifecycleReference !== null) {
    const [row] = await database
      .select({ facilityId: events.facilityId })
      .from(eventTransitions)
      .innerJoin(events, eq(events.id, eventTransitions.journalEventId))
      .where(eq(eventTransitions.id, lifecycleReference.transitionId))
      .limit(1);
    return row?.facilityId ?? null;
  }
  const joinReference = parseJoinReference(resultReference);
  if (joinReference === null) {
    return null;
  }
  return resolveEventFacilityIdFromDatabase(database, joinReference.eventId);
}

async function loadLifecycleResultFromDatabase(
  database: EventQueryDatabase,
  resultReference: string,
): Promise<EventLifecycleMutationResult | null> {
  const reference = parseLifecycleReference(resultReference);
  if (reference === null || reference.journalEntryIds.length === 0) {
    return null;
  }
  const [transitionRow] = await database
    .select()
    .from(eventTransitions)
    .where(eq(eventTransitions.id, reference.transitionId))
    .limit(1);
  if (transitionRow === undefined) {
    return null;
  }
  const transition = transitionFromRow(transitionRow);
  const eventId =
    transition.transition === 'reopen-as-correction'
      ? transition.correctionEventId
      : transition.eventId;
  const persistedJournalRows = await database
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.eventId, eventId),
        inArray(journalEntries.id, [...reference.journalEntryIds]),
      ),
    )
    .orderBy(asc(journalEntries.sequence));
  if (
    persistedJournalRows.length !== reference.journalEntryIds.length ||
    !sameSet(
      persistedJournalRows.map((row) => row.id),
      reference.journalEntryIds,
    )
  ) {
    return null;
  }
  const journal = persistedJournalRows.map(journalFromRow);
  const lifecycleJournal = journal.find(
    (entry) =>
      entry.kind === 'system' &&
      'transition' in entry.payload &&
      entry.payload.transition.id === transition.id,
  );
  if (lifecycleJournal === undefined) {
    return null;
  }
  const lastJournal = persistedJournalRows.at(-1);
  if (lastJournal === undefined) {
    return null;
  }
  const event = await hydrateEventAtJournalSequence(
    database,
    eventId,
    lastJournal.sequence,
  );
  if (event === null) {
    return null;
  }
  const notificationIntent =
    reference.notificationIntentId === null
      ? null
      : await notificationIntentById(database, reference.notificationIntentId);
  if (
    (reference.notificationIntentId === null) !==
    (notificationIntent === null)
  ) {
    return null;
  }
  let preparedActivationConsumption: PreparedActivationConsumption | null =
    null;
  if (reference.preparedActivationId !== null) {
    const [row] = await database
      .select()
      .from(preparedActivationConsumptions)
      .where(
        eq(
          preparedActivationConsumptions.preparedActivationId,
          reference.preparedActivationId,
        ),
      )
      .limit(1);
    if (row === undefined) {
      return null;
    }
    preparedActivationConsumption = preparedConsumptionFromRow(row);
  }
  return EventLifecycleMutationResultSchema.parse({
    event,
    transition,
    journalEntries: journal,
    notificationIntent,
    preparedActivationConsumption,
  });
}

async function loadJoinResultFromDatabase(
  database: EventQueryDatabase,
  resultReference: string,
): Promise<JoinEventResult | null> {
  const reference = parseJoinReference(resultReference);
  if (reference === null) {
    return null;
  }
  const [row] = await database
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, reference.journalEntryId),
        eq(journalEntries.eventId, reference.eventId),
      ),
    )
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const journal = journalFromRow(row);
  if (
    journal.kind !== 'system' ||
    journal.payload.code !== 'participant-joined' ||
    journal.payload.relatedRecordId !== reference.participantId
  ) {
    return null;
  }
  const event = await hydrateEventAtJournalSequence(
    database,
    reference.eventId,
    journal.sequence,
  );
  return event === null
    ? null
    : JoinEventResultSchema.parse({
        event,
        participantId: reference.participantId,
        joined: true,
      });
}

async function resolveActivationFacilityIdFromDatabase(
  database: EventQueryDatabase,
  input: CapabilityInput<'start-event'>,
): Promise<string | null> {
  if (input.source === 'prepared-activation') {
    const [row] = await database
      .select({ facilityId: preparedActivations.facilityId })
      .from(preparedActivations)
      .where(eq(preparedActivations.id, input.preparedActivationId))
      .limit(1);
    return row?.facilityId ?? null;
  }
  const [row] = await database
    .select({ facilityId: activationPreviews.facilityId })
    .from(activationPreviews)
    .where(eq(activationPreviews.id, input.activationPreviewId))
    .limit(1);
  return row?.facilityId ?? null;
}

async function resolveEventFacilityIdFromDatabase(
  database: EventQueryDatabase,
  eventId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ facilityId: events.facilityId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row?.facilityId ?? null;
}

async function resolveActivationSourceFromDatabase(
  database: EventQueryDatabase,
  input: CapabilityInput<'start-event'>,
): Promise<ResolvedActivationSource | null> {
  let previewId: string;
  let preparedActivation: PreparedActivation | null = null;
  if (input.source === 'prepared-activation') {
    const [preparedRow] = await database
      .select()
      .from(preparedActivations)
      .where(eq(preparedActivations.id, input.preparedActivationId))
      .for('update')
      .limit(1);
    if (preparedRow === undefined) {
      return null;
    }
    const [alreadyConsumed] = await database
      .select({ id: preparedActivationConsumptions.preparedActivationId })
      .from(preparedActivationConsumptions)
      .where(
        eq(preparedActivationConsumptions.preparedActivationId, preparedRow.id),
      )
      .limit(1);
    if (alreadyConsumed !== undefined) {
      throw conflict('The prepared activation has already been consumed.');
    }
    previewId = preparedRow.activationPreviewId;
    const preview = await activationPreviewById(database, previewId);
    if (preview === null) {
      return null;
    }
    preparedActivation = PreparedActivationSchema.parse({
      id: preparedRow.id,
      preview,
      preparedBy: preparedRow.preparedBy,
      preparedAt: dateIso(preparedRow.preparedAt),
    });
  } else {
    previewId = input.activationPreviewId;
  }
  const preview =
    preparedActivation?.preview ??
    (await activationPreviewById(database, previewId));
  if (preview === null) {
    return null;
  }
  if (preview.deliveryTest != null) {
    if (preparedActivation !== null || input.source !== 'activation-preview') {
      throw conflict(
        'A monthly delivery test requires a fresh interactive activation preview.',
      );
    }
    const metadata = preview.deliveryTest;
    // Coordinate with target-version creation. Without this shared lineage
    // lock a successor could commit after the stale check but before this
    // activation transaction commits and queues its outbox.
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${deliveryTestTargetLockIdentity(preview.facilityId)}, ${DELIVERY_TEST_TARGET_LOCK_NAMESPACE}))`,
    );
    const [targetSet] = await database
      .select()
      .from(deliveryTestTargetSetVersions)
      .where(
        and(
          eq(deliveryTestTargetSetVersions.id, metadata.targetSet.id),
          eq(deliveryTestTargetSetVersions.version, metadata.targetSet.version),
        ),
      )
      .for('share')
      .limit(1);
    if (
      targetSet === undefined ||
      targetSet.facilityId !== preview.facilityId ||
      targetSet.rosterSnapshotId !== preview.rosterSnapshotId ||
      targetSet.rosterPopulation !== 'staff' ||
      targetSet.endpointReferenceDigest !== metadata.endpointReferenceDigest
    ) {
      throw conflict(
        'The monthly delivery-test target approval no longer matches its preview.',
      );
    }
    const [successor] = await database
      .select({ id: deliveryTestTargetSetVersions.id })
      .from(deliveryTestTargetSetVersions)
      .where(
        eq(deliveryTestTargetSetVersions.supersedesVersionId, targetSet.id),
      )
      .limit(1);
    if (successor !== undefined) {
      throw conflict(
        'The monthly delivery-test target approval has been superseded.',
      );
    }
    const endpointRows = await database
      .select({
        eligibilityFactId: deliveryTestTargetEndpoints.eligibilityFactId,
        recipientId: deliveryTestTargetEndpoints.recipientId,
        endpointId: deliveryTestTargetEndpoints.endpointId,
        channel: deliveryTestTargetEndpoints.channel,
        attestation: deliveryTestTargetEndpoints.attestation,
        optedInAt: deliveryTestTargetEndpoints.optedInAt,
        attestedAt: deliveryTestTargetEndpoints.attestedAt,
        attestedByUserId: deliveryTestTargetEndpoints.attestedByUserId,
        authorizationReference:
          deliveryTestTargetEndpoints.authorizationReference,
      })
      .from(deliveryTestTargetEndpoints)
      .where(eq(deliveryTestTargetEndpoints.targetSetVersionId, targetSet.id))
      .orderBy(
        asc(deliveryTestTargetEndpoints.channel),
        asc(deliveryTestTargetEndpoints.recipientId),
        asc(deliveryTestTargetEndpoints.endpointId),
      );
    if (
      endpointRows.length === 0 ||
      deliveryTestEndpointReferenceDigest(endpointRows) !==
        metadata.endpointReferenceDigest
    ) {
      throw conflict(
        'The monthly delivery-test endpoint approval is inconsistent.',
      );
    }
    await requireCurrentDeliveryTestTargetEligibility(
      database,
      {
        id: targetSet.id,
        version: targetSet.version,
        facilityId: targetSet.facilityId,
        rosterSnapshotId: targetSet.rosterSnapshotId,
        supersedesVersionId: targetSet.supersedesVersionId,
        endpoints: endpointRows.map((endpoint) => ({
          ...endpoint,
          attestation: 'approved-synthetic-canary' as const,
          optedInAt: dateIso(endpoint.optedInAt),
          attestedAt: dateIso(endpoint.attestedAt),
          attestedByUserId: endpoint.attestedByUserId,
          authorizationReference: endpoint.authorizationReference,
        })),
        endpointReferenceDigest: targetSet.endpointReferenceDigest,
        approvedByUserId: targetSet.approvedByUserId,
        approvedWithSessionId: targetSet.approvedWithSessionId,
        approvedAt: dateIso(targetSet.approvedAt),
        createdAt: dateIso(targetSet.createdAt),
      },
      await readDatabaseTime(database),
    );
    const credentialReferences =
      readDeliveryTestCredentialVerificationReferences();
    if (
      preview.channels.some(
        (channel) =>
          !deliveryTestCredentialIsVerified(
            channel.integrationStatus,
            credentialReferences[channel.channel],
          ),
      )
    ) {
      throw conflict(
        'The monthly delivery-test credential evidence no longer matches its preview.',
      );
    }
    const audience = await loadAudienceConfiguration(
      database,
      preview.facilityId,
    );
    const rosterSnapshot = await loadRosterSnapshot(
      database,
      'staff',
      preview.facilityId,
      targetSet.rosterSnapshotId,
    );
    const activeAudienceEndpoints =
      rosterSnapshot === null || audience === null
        ? []
        : await currentActiveAudienceEndpointReferences(
            database,
            rosterSnapshot,
            audience,
          );
    const currentAudienceHeader = audience?.audienceConfig;
    const activeKeys = new Set(
      activeAudienceEndpoints.map(
        (endpoint) =>
          `${endpoint.channel}:${endpoint.recipientId}:${endpoint.endpointId}`,
      ),
    );
    if (
      rosterSnapshot === null ||
      currentAudienceHeader === undefined ||
      currentAudienceHeader.id !== preview.audienceConfig.id ||
      currentAudienceHeader.version !== preview.audienceConfig.version ||
      endpointRows.some(
        (endpoint) =>
          !activeKeys.has(
            `${endpoint.channel}:${endpoint.recipientId}:${endpoint.endpointId}`,
          ),
      ) ||
      preview.channels.some(
        (channel) =>
          channel.endpointCount !==
          endpointRows.filter(
            (endpoint) => endpoint.channel === channel.channel,
          ).length,
      )
    ) {
      throw conflict(
        'The monthly delivery-test endpoints are no longer the exact active approved subset.',
      );
    }
  }
  await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.id, preview.facilityId))
    .for('update')
    .limit(1);
  const currentActiveRows = await database
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.facilityId, preview.facilityId),
        eq(events.status, 'active'),
      ),
    )
    .orderBy(asc(events.id));
  return {
    preview,
    preparedActivation,
    integrationStatusIds: await resolveIntegrationStatusIds(
      database,
      preview.channels,
    ),
    currentActiveEventIds: currentActiveRows.map((row) => row.id),
  };
}

async function resolveEventForUpdateFromDatabase(
  database: EventQueryDatabase,
  eventId: string,
): Promise<ResolvedEventState | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for('update')
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const [lockedFacility] = await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.id, row.facilityId))
    .for('update')
    .limit(1);
  if (lockedFacility === undefined) {
    throw conflict('The event facility is unavailable.');
  }
  const [transitionSequence] = await database
    .select({
      value: sql<number>`coalesce(max(${eventTransitions.sequence}), 0)`,
    })
    .from(eventTransitions)
    .where(eq(eventTransitions.journalEventId, eventId));
  const [journalSequence] = await database
    .select({
      value: sql<number>`coalesce(max(${journalEntries.sequence}), 0)`,
    })
    .from(journalEntries)
    .where(eq(journalEntries.eventId, eventId));
  return {
    event: eventFromRow(row),
    nextTransitionSequence: Number(transitionSequence?.value ?? 0) + 1,
    nextJournalSequence: Number(journalSequence?.value ?? 0) + 1,
  };
}

function createDrizzleEventTransaction(
  database: EventQueryDatabase,
): EventCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    getHumanConfirmation: (id) => getHumanConfirmation(database, id),
    consumeHumanConfirmation: (input) =>
      consumeHumanConfirmation(database, input),
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
    resolveActivationFacilityId: (input) =>
      resolveActivationFacilityIdFromDatabase(database, input),
    resolveActivationSource: (input) =>
      resolveActivationSourceFromDatabase(database, input),
    resolveEventFacilityId: (eventId) =>
      resolveEventFacilityIdFromDatabase(database, eventId),
    resolveEventForUpdate: (eventId) =>
      resolveEventForUpdateFromDatabase(database, eventId),
    async resolveLifecyclePreview(previewId) {
      const preview = await lifecyclePreviewById(database, previewId);
      return preview === null
        ? null
        : {
            preview,
            integrationStatusIds: await resolveIntegrationStatusIds(
              database,
              preview.channels,
            ),
          };
    },
    async getEvent(eventId) {
      const [row] = await database
        .select()
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      return row === undefined ? null : eventFromRow(row);
    },
    async listActiveEvents(input, scope) {
      const facilityScope = scope.facilityScope;
      const facilityIds =
        input.facilityId !== null
          ? [input.facilityId]
          : facilityScope.kind === 'facilities'
            ? [...facilityScope.facilityIds]
            : null;
      const rows = await database
        .select()
        .from(events)
        .where(
          facilityIds === null
            ? eq(events.status, 'active')
            : and(
                eq(events.status, 'active'),
                inArray(events.facilityId, facilityIds),
              ),
        )
        .orderBy(desc(events.createdAt), asc(events.id));
      const offset = decodeOffsetCursor(input.cursor);
      const selected = rows.slice(offset, offset + input.limit);
      const nextOffset = offset + selected.length;
      return EventPageSchema.parse({
        items: selected.map(eventFromRow),
        pageInfo: {
          hasMore: nextOffset < rows.length,
          nextCursor:
            nextOffset < rows.length ? encodeOffsetCursor(nextOffset) : null,
        },
      });
    },
    persistLifecycle: (bundle) => persistLifecycleBundle(database, bundle),
    async persistJoin(bundle) {
      if (
        bundle.result.event.id !== bundle.journalEntry.eventId ||
        bundle.journalEntry.kind !== 'system' ||
        bundle.journalEntry.payload.code !== 'participant-joined' ||
        bundle.journalEntry.payload.relatedRecordId !==
          bundle.result.participantId
      ) {
        throw conflict('The participant journal evidence is inconsistent.');
      }
      await database
        .insert(journalEntries)
        .values(journalInsertValues(bundle.journalEntry));
    },
    resolveReplayFacilityId: (reference) =>
      resolveReplayFacilityIdFromDatabase(database, reference),
    loadLifecycleResult: (reference) =>
      loadLifecycleResultFromDatabase(database, reference),
    loadJoinResult: (reference) =>
      loadJoinResultFromDatabase(database, reference),
  };
}

function eventQueryDatabase(database: unknown): EventQueryDatabase {
  // Both supported Drizzle transports expose the same schema-aware query
  // surface. The direct-driver type is used solely to avoid a union of
  // overloaded method signatures; no driver-specific API is called here.
  return database as EventQueryDatabase;
}

/** Creates the production one-transaction event capability persistence. */
export function createDrizzleEventCapabilityStore(
  database: Database,
): EventCapabilityStore {
  return {
    transaction<Result>(
      operation: (transaction: EventCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) => {
        const queryDatabase = eventQueryDatabase(transaction);
        return operation(createDrizzleEventTransaction(queryDatabase));
      });
    },
    appendCapabilityAudit(event) {
      return database.transaction(async (transaction) =>
        appendCapabilityAuditEntry(eventQueryDatabase(transaction), event),
      );
    },
  };
}

/** Builds a runtime around an explicitly managed database connection. */
export function createEventCapabilityRuntime(
  connection: DatabaseConnection,
): EventCapabilityRuntime {
  const store = createDrizzleEventCapabilityStore(connection.db);
  return {
    store,
    execute: (capabilityId, input, invocation) =>
      executeEventCapability(capabilityId, input, invocation, store),
    close: () => connection.close(),
  };
}

let defaultEventCapabilityRuntime: EventCapabilityRuntime | undefined;

/** Lazily creates the database-backed runtime used by REST event routes. */
export function getDefaultEventCapabilityRuntime(): EventCapabilityRuntime {
  defaultEventCapabilityRuntime ??= createEventCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultEventCapabilityRuntime;
}

/** Lifecycle hook for tests and scripts; Next.js retains the normal pool. */
export async function closeDefaultEventCapabilityRuntime(): Promise<void> {
  const runtime = defaultEventCapabilityRuntime;
  defaultEventCapabilityRuntime = undefined;
  await runtime?.close();
}
