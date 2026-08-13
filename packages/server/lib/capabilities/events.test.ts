import { describe, expect, test } from 'bun:test';

import {
  ActivationPreviewSchema,
  EventSchema,
  HumanConfirmationRecordSchema,
  LifecycleConsequencePreviewSchema,
  StartEventInputSchema,
  type ActivationPreview,
  type CapabilityInput,
  type CapabilityScope,
  type Event,
  type EventLifecycleMutationResult,
  type EventPage,
  type EventTransition,
  type HumanConfirmationRecord,
  type IntegrationStatus,
  type JoinEventResult,
  type JournalEntry,
  type LifecycleConsequencePreview,
  type NotificationIntent,
  type OutboxRecord,
  type Role,
  type RosterPopulation,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../auth/sessions';
import {
  CapabilityEngineError,
  resolveHumanCapabilityInvocation,
  type CapabilityAuditEvent,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type ConsumeHumanConfirmationInput,
  type IdempotencyClaim,
  type TrustedCapabilityInvocation,
} from './engine';
import {
  executeEventCapability,
  type EventCapabilityStore,
  type EventCapabilityTransaction,
  type JoinPersistenceBundle,
  type LifecyclePersistenceBundle,
  type ResolvedActivationSource,
  type ResolvedEventState,
  type ResolvedLifecyclePreview,
} from './events';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  facility: uuid(1),
  otherFacility: uuid(2),
  user: uuid(3),
  session: uuid(4),
  connectivityEpoch: uuid(5),
  agent: uuid(6),
  apiKey: uuid(7),
  rosterSnapshot: uuid(8),
  eventTypeVersion: uuid(9),
  audience: uuid(10),
  activationPreview: uuid(11),
  alternateActivationPreview: uuid(12),
  allClearPreview: uuid(13),
  reactivationPreview: uuid(14),
  secondAllClearPreview: uuid(15),
  existingEvent: uuid(16),
  activationRequest: uuid(17),
  activationConfirmation: uuid(18),
});

const TIMES = Object.freeze({
  eventCreated: '2026-08-08T15:50:00.000Z',
  eventActivated: '2026-08-08T15:55:00.000Z',
  seededAllClear: '2026-08-08T15:57:00.000Z',
  previewCreated: '2026-08-08T15:59:00.000Z',
  activation: '2026-08-08T16:00:00.000Z',
  firstAllClearPreview: '2026-08-08T16:01:00.000Z',
  firstAllClear: '2026-08-08T16:02:00.000Z',
  reactivationPreview: '2026-08-08T16:03:00.000Z',
  reactivation: '2026-08-08T16:04:00.000Z',
  secondAllClearPreview: '2026-08-08T16:05:00.000Z',
  secondAllClear: '2026-08-08T16:06:00.000Z',
  close: '2026-08-08T16:07:00.000Z',
  previewExpires: '2026-08-08T16:10:00.000Z',
});

const HUMAN_ACTOR = Object.freeze({
  kind: 'human' as const,
  userId: IDS.user,
  sessionId: IDS.session,
});

const AGENT_ACTOR = Object.freeze({
  kind: 'agent' as const,
  agentId: IDS.agent,
  apiKeyId: IDS.apiKey,
});

const SYSTEM_ACTOR = Object.freeze({
  kind: 'system' as const,
  serviceId: 'synthetic-event-test',
});

const DISTRICT_SCOPE = Object.freeze({
  facilityScope: { kind: 'district' as const },
});

interface MemoryIdempotencyRecord {
  readonly id: string;
  readonly requestDigest: string;
  status: 'in-progress' | 'completed' | 'failed';
  resultReference: string | null;
}

interface MemoryState {
  readonly idempotency: Map<string, MemoryIdempotencyRecord>;
  readonly confirmations: Map<string, HumanConfirmationRecord>;
  readonly audits: CapabilityAuditEvent[];
  readonly activationSources: Map<string, ResolvedActivationSource>;
  readonly lifecyclePreviews: Map<string, ResolvedLifecyclePreview>;
  readonly events: Map<string, Event>;
  readonly transitions: EventTransition[];
  readonly journals: JournalEntry[];
  readonly notificationIntents: NotificationIntent[];
  readonly outboxRecords: OutboxRecord[];
  readonly lifecycleBundles: LifecyclePersistenceBundle[];
  readonly lifecycleResults: Map<string, EventLifecycleMutationResult>;
  readonly joinBundles: JoinPersistenceBundle[];
  readonly joinResults: Map<string, JoinEventResult>;
  nextRecordNumber: number;
  persistLifecycleCalls: number;
  persistJoinCalls: number;
  lifecycleReplayLoads: number;
  joinReplayLoads: number;
  failLifecycleAfterWrite: boolean;
  currentTime: Date | null;
}

function cloneMemoryState(state: MemoryState): MemoryState {
  return {
    idempotency: new Map(
      [...state.idempotency].map(([key, record]) => [key, { ...record }]),
    ),
    confirmations: new Map(state.confirmations),
    audits: [...state.audits],
    activationSources: new Map(state.activationSources),
    lifecyclePreviews: new Map(state.lifecyclePreviews),
    events: new Map(state.events),
    transitions: [...state.transitions],
    journals: [...state.journals],
    notificationIntents: [...state.notificationIntents],
    outboxRecords: [...state.outboxRecords],
    lifecycleBundles: [...state.lifecycleBundles],
    lifecycleResults: new Map(state.lifecycleResults),
    joinBundles: [...state.joinBundles],
    joinResults: new Map(state.joinResults),
    nextRecordNumber: state.nextRecordNumber,
    persistLifecycleCalls: state.persistLifecycleCalls,
    persistJoinCalls: state.persistJoinCalls,
    lifecycleReplayLoads: state.lifecycleReplayLoads,
    joinReplayLoads: state.joinReplayLoads,
    failLifecycleAfterWrite: state.failLifecycleAfterWrite,
    currentTime: state.currentTime,
  };
}

function idempotencyScopeKey(input: ClaimIdempotencyInput): string {
  return `${input.capabilityId}:${input.principalDigest}:${input.key}`;
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

class MemoryEventCapabilityTransaction implements EventCapabilityTransaction {
  public constructor(private readonly state: MemoryState) {}

  public async readCurrentTime(requestReceivedAt: Date): Promise<Date> {
    return this.state.currentTime ?? requestReceivedAt;
  }

  public async claimIdempotency(
    input: ClaimIdempotencyInput,
  ): Promise<IdempotencyClaim> {
    const scopeKey = idempotencyScopeKey(input);
    const existing = this.state.idempotency.get(scopeKey);
    if (existing !== undefined) {
      switch (existing.status) {
        case 'in-progress':
          return {
            kind: 'in-progress',
            requestDigest: existing.requestDigest,
          };
        case 'completed':
          if (existing.resultReference === null) {
            throw new Error('Completed idempotency record has no result.');
          }
          return {
            kind: 'completed',
            requestDigest: existing.requestDigest,
            resultReference: existing.resultReference,
          };
        case 'failed':
          if (existing.resultReference === null) {
            throw new Error('Failed idempotency record has no result.');
          }
          return {
            kind: 'failed',
            requestDigest: existing.requestDigest,
            resultReference: existing.resultReference,
          };
      }
    }

    const recordId = uuid(900 + this.state.nextRecordNumber);
    this.state.nextRecordNumber += 1;
    this.state.idempotency.set(scopeKey, {
      id: recordId,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      resultReference: null,
    });
    return { kind: 'new', recordId };
  }

  public async completeIdempotency(
    input: CompleteIdempotencyInput,
  ): Promise<void> {
    const record = [...this.state.idempotency.values()].find(
      (candidate) => candidate.id === input.recordId,
    );
    if (record === undefined || record.status !== 'in-progress') {
      throw new Error('Idempotency completion was not reserved.');
    }
    record.status = 'completed';
    record.resultReference = input.resultReference;
  }

  public async getHumanConfirmation(
    id: string,
  ): Promise<HumanConfirmationRecord | null> {
    return this.state.confirmations.get(id) ?? null;
  }

  public async consumeHumanConfirmation(
    input: ConsumeHumanConfirmationInput,
  ): Promise<boolean> {
    const record = this.state.confirmations.get(input.confirmationId);
    if (record === undefined || record.status !== 'issued') {
      return false;
    }
    this.state.confirmations.set(
      input.confirmationId,
      HumanConfirmationRecordSchema.parse({
        confirmation: record.confirmation,
        status: 'consumed',
        consumedAt: input.consumedAt.toISOString(),
        consumedForRequestId: input.requestId,
        expiredAt: null,
      }),
    );
    return true;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.state.audits.push(event);
  }

  public async resolveActivationFacilityId(
    input: CapabilityInput<'start-event'>,
  ): Promise<string | null> {
    const sourceId =
      input.source === 'activation-preview'
        ? input.activationPreviewId
        : input.preparedActivationId;
    return (
      this.state.activationSources.get(sourceId)?.preview.facilityId ?? null
    );
  }

  public async resolveActivationSource(
    input: CapabilityInput<'start-event'>,
  ): Promise<ResolvedActivationSource | null> {
    const sourceId =
      input.source === 'activation-preview'
        ? input.activationPreviewId
        : input.preparedActivationId;
    const resolved = this.state.activationSources.get(sourceId);
    if (resolved === undefined) {
      return null;
    }
    const currentActiveEventIds = [...this.state.events.values()]
      .filter(
        (event) =>
          event.facilityId === resolved.preview.facilityId &&
          event.status === 'active',
      )
      .map((event) => event.id);
    return { ...resolved, currentActiveEventIds };
  }

  public async resolveEventFacilityId(eventId: string): Promise<string | null> {
    return this.state.events.get(eventId)?.facilityId ?? null;
  }

  public async resolveEventForUpdate(
    eventId: string,
  ): Promise<ResolvedEventState | null> {
    const event = this.state.events.get(eventId);
    if (event === undefined) {
      return null;
    }
    const transitionSequences = this.state.transitions
      .filter((transition) =>
        'eventId' in transition
          ? transition.eventId === eventId
          : transition.correctionEventId === eventId,
      )
      .map((transition) => transition.sequence);
    const journalSequences = this.state.journals
      .filter((entry) => entry.eventId === eventId)
      .map((entry) => entry.sequence);
    return {
      event,
      nextTransitionSequence: Math.max(0, ...transitionSequences) + 1,
      nextJournalSequence: Math.max(0, ...journalSequences) + 1,
    };
  }

  public async resolveLifecyclePreview(
    previewId: string,
  ): Promise<ResolvedLifecyclePreview | null> {
    return this.state.lifecyclePreviews.get(previewId) ?? null;
  }

  public async getEvent(eventId: string): Promise<Event | null> {
    return this.state.events.get(eventId) ?? null;
  }

  public async listActiveEvents(
    input: CapabilityInput<'list-active-events'>,
    scope: TrustedCapabilityInvocation['scope'],
  ): Promise<EventPage> {
    const allowedFacilityIds =
      scope.facilityScope.kind === 'district'
        ? null
        : new Set(scope.facilityScope.facilityIds);
    const items = [...this.state.events.values()]
      .filter(
        (event) =>
          event.status === 'active' &&
          (input.facilityId === null ||
            event.facilityId === input.facilityId) &&
          (allowedFacilityIds === null ||
            allowedFacilityIds.has(event.facilityId)),
      )
      .slice(0, input.limit);
    return { items, pageInfo: { hasMore: false, nextCursor: null } };
  }

  public async persistLifecycle(
    bundle: LifecyclePersistenceBundle,
  ): Promise<void> {
    const { result, outboxRecord } = bundle;
    if ((result.notificationIntent === null) !== (outboxRecord === null)) {
      throw new Error('Notification intent and outbox must be atomic.');
    }
    if (
      result.notificationIntent !== null &&
      outboxRecord?.message.intentId !== result.notificationIntent.id
    ) {
      throw new Error('Outbox does not reference the persisted intent.');
    }

    this.state.persistLifecycleCalls += 1;
    this.state.events.set(result.event.id, result.event);
    this.state.transitions.push(result.transition);
    this.state.journals.push(...result.journalEntries);
    if (result.notificationIntent !== null) {
      this.state.notificationIntents.push(result.notificationIntent);
    }
    if (outboxRecord !== null) {
      this.state.outboxRecords.push(outboxRecord);
    }
    this.state.lifecycleBundles.push(bundle);
    this.state.lifecycleResults.set(lifecycleResultReference(result), result);
    if (this.state.failLifecycleAfterWrite) {
      throw new Error('Synthetic persistence failure after staged writes.');
    }
  }

  public async persistJoin(bundle: JoinPersistenceBundle): Promise<void> {
    this.state.persistJoinCalls += 1;
    this.state.journals.push(bundle.journalEntry);
    this.state.joinBundles.push(bundle);
    this.state.joinResults.set(
      joinResultReference(bundle.result, bundle.journalEntry.id),
      bundle.result,
    );
  }

  public async resolveReplayFacilityId(
    resultReference: string,
  ): Promise<string | null> {
    return (
      this.state.lifecycleResults.get(resultReference)?.event.facilityId ??
      this.state.joinResults.get(resultReference)?.event.facilityId ??
      null
    );
  }

  public async loadLifecycleResult(
    resultReference: string,
  ): Promise<EventLifecycleMutationResult | null> {
    this.state.lifecycleReplayLoads += 1;
    return this.state.lifecycleResults.get(resultReference) ?? null;
  }

  public async loadJoinResult(
    resultReference: string,
  ): Promise<JoinEventResult | null> {
    this.state.joinReplayLoads += 1;
    return this.state.joinResults.get(resultReference) ?? null;
  }
}

class MemoryEventCapabilityStore implements EventCapabilityStore {
  private state: MemoryState = {
    idempotency: new Map(),
    confirmations: new Map(),
    audits: [],
    activationSources: new Map(),
    lifecyclePreviews: new Map(),
    events: new Map(),
    transitions: [],
    journals: [],
    notificationIntents: [],
    outboxRecords: [],
    lifecycleBundles: [],
    lifecycleResults: new Map(),
    joinBundles: [],
    joinResults: new Map(),
    nextRecordNumber: 1,
    persistLifecycleCalls: 0,
    persistJoinCalls: 0,
    lifecycleReplayLoads: 0,
    joinReplayLoads: 0,
    failLifecycleAfterWrite: false,
    currentTime: null,
  };

  public async transaction<Result>(
    operation: (transaction: EventCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    const candidate = cloneMemoryState(this.state);
    const result = await operation(
      new MemoryEventCapabilityTransaction(candidate),
    );
    this.state = candidate;
    return result;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.state.audits.push(event);
  }

  public seedActivationSource(source: ResolvedActivationSource): void {
    this.state.activationSources.set(source.preview.id, source);
    if (source.preparedActivation !== null) {
      this.state.activationSources.set(source.preparedActivation.id, source);
    }
  }

  public seedLifecyclePreview(source: ResolvedLifecyclePreview): void {
    this.state.lifecyclePreviews.set(source.preview.id, source);
  }

  public seedEvent(event: Event): void {
    const parsed = EventSchema.parse(event);
    this.state.events.set(parsed.id, parsed);
  }

  public seedConfirmation(record: HumanConfirmationRecord): void {
    const parsed = HumanConfirmationRecordSchema.parse(record);
    this.state.confirmations.set(parsed.confirmation.id, parsed);
  }

  public failNextLifecyclePersistenceAfterWrite(): void {
    this.state.failLifecycleAfterWrite = true;
  }

  public setCurrentTime(currentTime: Date): void {
    this.state.currentTime = currentTime;
  }

  public getConfirmation(id: string): HumanConfirmationRecord | undefined {
    return this.state.confirmations.get(id);
  }

  public get events(): readonly Event[] {
    return [...this.state.events.values()];
  }

  public get transitions(): readonly EventTransition[] {
    return this.state.transitions;
  }

  public get journals(): readonly JournalEntry[] {
    return this.state.journals;
  }

  public get notificationIntents(): readonly NotificationIntent[] {
    return this.state.notificationIntents;
  }

  public get outboxRecords(): readonly OutboxRecord[] {
    return this.state.outboxRecords;
  }

  public get lifecycleBundles(): readonly LifecyclePersistenceBundle[] {
    return this.state.lifecycleBundles;
  }

  public get auditEvents(): readonly CapabilityAuditEvent[] {
    return this.state.audits;
  }

  public get persistLifecycleCalls(): number {
    return this.state.persistLifecycleCalls;
  }

  public get persistJoinCalls(): number {
    return this.state.persistJoinCalls;
  }

  public get lifecycleReplayLoads(): number {
    return this.state.lifecycleReplayLoads;
  }

  public get joinReplayLoads(): number {
    return this.state.joinReplayLoads;
  }

  public get idempotencyRecordCount(): number {
    return this.state.idempotency.size;
  }
}

type Target = Readonly<{
  kind: 'incident' | 'drill' | 'test';
  templateMode: 'real' | 'drill';
  rosterPopulation: RosterPopulation;
}>;

const SYNTHETIC_TARGET = Object.freeze({
  kind: 'test' as const,
  templateMode: 'drill' as const,
  rosterPopulation: 'synthetic' as const,
});

const REAL_TARGET = Object.freeze({
  kind: 'incident' as const,
  templateMode: 'real' as const,
  rosterPopulation: 'staff' as const,
});

function integrationStatus(
  channel: 'push' | 'email',
  population: RosterPopulation,
  observedAt: string,
): IntegrationStatus {
  const integrationId = channel === 'push' ? 'expo-push' : 'ses-email';
  return population === 'synthetic'
    ? {
        integrationId,
        label: 'mocked',
        verifiedAt: null,
        verifiedByUserId: null,
        authorizationReference: null,
        reasonCode: null,
        observedAt,
      }
    : {
        integrationId,
        label: 'live-verified',
        verifiedAt: observedAt,
        verifiedByUserId: IDS.user,
        authorizationReference: 'approved-synthetic-test-fixture',
        reasonCode: null,
        observedAt,
      };
}

function channelPlan(
  target: Target,
  purpose: 'activation' | 'all-clear' | 'reactivation',
  observedAt: string,
): ActivationPreview['channels'] {
  const classificationMarker =
    target.templateMode === 'real' ? 'INCIDENT' : 'DRILL';
  const prefix = `[${classificationMarker}]`;
  return [
    {
      channel: 'push',
      endpointCount: 2,
      renderedMessage: {
        channel: 'push',
        eventKind: target.kind,
        templateMode: target.templateMode,
        purpose,
        classificationMarker,
        title: `${prefix} Synthetic event update`,
        body: `${prefix} Synthetic event fixture message.`,
      },
      integrationStatus: integrationStatus(
        'push',
        target.rosterPopulation,
        observedAt,
      ),
    },
    {
      channel: 'email',
      endpointCount: 2,
      renderedMessage: {
        channel: 'email',
        eventKind: target.kind,
        templateMode: target.templateMode,
        purpose,
        classificationMarker,
        subject: `${prefix} Synthetic event update`,
        textBody: `${prefix} Synthetic event fixture message.`,
      },
      integrationStatus: integrationStatus(
        'email',
        target.rosterPopulation,
        observedAt,
      ),
    },
  ];
}

function activationPreview(
  input: Readonly<{
    id?: string;
    target?: Target;
    activeEventIds?: readonly string[];
    createdAt?: string;
    expiresAt?: string;
    consequenceDigest?: string;
  }> = {},
): ActivationPreview {
  const target = input.target ?? SYNTHETIC_TARGET;
  const createdAt = input.createdAt ?? TIMES.previewCreated;
  return ActivationPreviewSchema.parse({
    id: input.id ?? IDS.activationPreview,
    facilityId: IDS.facility,
    ...target,
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: target.templateMode,
    },
    rosterSnapshotId: IDS.rosterSnapshot,
    audienceConfig: { id: IDS.audience, version: 1 },
    recipientCount: 2,
    channels: channelPlan(target, 'activation', createdAt),
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: input.activeEventIds ?? [],
    consequenceDigest: input.consequenceDigest ?? 'a'.repeat(64),
    createdAt,
    expiresAt: input.expiresAt ?? TIMES.previewExpires,
  });
}

function lifecyclePreview(
  event: Event,
  purpose: 'all-clear' | 'reactivation',
  input: Readonly<{
    id: string;
    createdAt: string;
    expiresAt?: string;
    consequenceDigest?: string;
  }>,
): LifecycleConsequencePreview {
  if (event.rosterPopulation === null || event.rosterSnapshotId === null) {
    throw new Error('Lifecycle preview requires an activated event.');
  }
  const target = {
    kind: event.kind,
    templateMode: event.templateMode,
    rosterPopulation: event.rosterPopulation,
  } as const;
  return LifecycleConsequencePreviewSchema.parse({
    id: input.id,
    eventId: event.id,
    purpose,
    ...target,
    eventTypeVersion: event.eventTypeVersion,
    rosterSnapshotId: event.rosterSnapshotId,
    audienceConfig: { id: IDS.audience, version: 1 },
    recipientCount: 2,
    channels: channelPlan(target, purpose, input.createdAt),
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    consequenceDigest: input.consequenceDigest ?? 'b'.repeat(64),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt ?? TIMES.previewExpires,
  });
}

function activeEvent(
  input: Readonly<{
    id?: string;
    target?: Target;
    status?: 'active' | 'all-clear' | 'closed';
  }> = {},
): Event {
  const id = input.id ?? IDS.existingEvent;
  const target = input.target ?? SYNTHETIC_TARGET;
  const status = input.status ?? 'active';
  const requiresHuman =
    target.kind === 'incident' ||
    (target.kind === 'drill' && target.rosterPopulation === 'staff');
  return EventSchema.parse({
    id,
    facilityId: IDS.facility,
    kind: target.kind,
    templateMode: target.templateMode,
    eventTypeVersion: {
      id: IDS.eventTypeVersion,
      templateMode: target.templateMode,
    },
    status,
    rosterSnapshotId: IDS.rosterSnapshot,
    rosterPopulation: target.rosterPopulation,
    createdBy: requiresHuman ? HUMAN_ACTOR : AGENT_ACTOR,
    createdAt: TIMES.eventCreated,
    activatedAt: TIMES.eventActivated,
    allClearAt: status === 'active' ? null : TIMES.seededAllClear,
    reactivatedAt: null,
    closedAt: status === 'closed' ? TIMES.previewCreated : null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization:
      target.rosterPopulation === 'staff'
        ? {
            kind: 'human-confirmed',
            activationPreviewId: IDS.activationPreview,
            preparedActivationId: null,
            confirmationId: IDS.activationConfirmation,
            consequenceDigest: 'a'.repeat(64),
            requestId: IDS.activationRequest,
          }
        : {
            kind: 'synthetic-training',
            activationPreviewId: IDS.activationPreview,
            consequenceDigest: 'a'.repeat(64),
            requestId: IDS.activationRequest,
          },
  });
}

function seedActivation(
  store: MemoryEventCapabilityStore,
  preview: ActivationPreview,
): void {
  store.seedActivationSource({
    preview,
    preparedActivation: null,
    integrationStatusIds: {
      push: uuid(100),
      email: uuid(101),
    },
    currentActiveEventIds: preview.activeEventIds,
  });
}

function seedLifecycle(
  store: MemoryEventCapabilityStore,
  preview: LifecycleConsequencePreview,
): void {
  store.seedLifecyclePreview({
    preview,
    integrationStatusIds: {
      push: uuid(102),
      email: uuid(103),
    },
  });
}

function humanMutationInvocation(
  input: Readonly<{
    requestId: string;
    idempotencyKey: string;
    serverTime: string;
    confirmationId?: string | null;
    scope?: CapabilityScope;
  }>,
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope: input.scope ?? DISTRICT_SCOPE,
    requestId: input.requestId,
    serverTime: new Date(input.serverTime),
    connectivityEpochId: IDS.connectivityEpoch,
    mutation: {
      idempotencyKey: input.idempotencyKey,
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId: input.confirmationId ?? null,
    },
  };
}

function nonHumanMutationInvocation(
  principal: 'agent' | 'system',
  input: Readonly<{
    requestId: string;
    idempotencyKey: string;
    serverTime: string;
  }>,
): TrustedCapabilityInvocation {
  return principal === 'agent'
    ? {
        actor: AGENT_ACTOR,
        source: 'mcp',
        scope: DISTRICT_SCOPE,
        requestId: input.requestId,
        serverTime: new Date(input.serverTime),
        connectivityEpochId: null,
        mutation: {
          idempotencyKey: input.idempotencyKey,
          transport: { kind: 'mcp-tool-call' },
          humanConfirmationId: null,
        },
      }
    : {
        actor: SYSTEM_ACTOR,
        source: 'scheduled-job',
        scope: DISTRICT_SCOPE,
        requestId: input.requestId,
        serverTime: new Date(input.serverTime),
        connectivityEpochId: null,
        mutation: {
          idempotencyKey: input.idempotencyKey,
          transport: { kind: 'scheduled-execution' },
          humanConfirmationId: null,
        },
      };
}

function issuedConfirmation(
  input: Readonly<{
    id: string;
    capabilityId:
      | 'start-event'
      | 'all-clear-event'
      | 'reactivate-event'
      | 'close-event';
    actionIds: readonly (
      | 'start-real-incident'
      | 'send-real-notification'
      | 'all-clear'
      | 'close-real-event'
    )[];
    consequenceDigest: string;
    issuedAt: string;
    expiresAt: string;
  }>,
): HumanConfirmationRecord {
  return HumanConfirmationRecordSchema.parse({
    confirmation: {
      id: input.id,
      capabilityId: input.capabilityId,
      actionIds: input.actionIds,
      connectivityEpochId: IDS.connectivityEpoch,
      confirmedByUserId: IDS.user,
      confirmedWithSessionId: IDS.session,
      consequenceDigest: input.consequenceDigest,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    },
    status: 'issued',
    consumedAt: null,
    consumedForRequestId: null,
    expiredAt: null,
  });
}

async function captureEngineError(
  operation: () => Promise<unknown>,
): Promise<CapabilityEngineError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityEngineError);
    return error as CapabilityEngineError;
  }
  throw new Error('Expected capability execution to fail.');
}

function domainCounts(store: MemoryEventCapabilityStore) {
  return {
    events: store.events.length,
    transitions: store.transitions.length,
    journals: store.journals.length,
    intents: store.notificationIntents.length,
    outbox: store.outboxRecords.length,
    lifecycleWrites: store.persistLifecycleCalls,
    joinWrites: store.persistJoinCalls,
  };
}

async function startSyntheticEvent(
  store: MemoryEventCapabilityStore,
  input: Readonly<{
    requestId?: string;
    idempotencyKey?: string;
    preview?: ActivationPreview;
  }> = {},
) {
  const preview = input.preview ?? activationPreview();
  seedActivation(store, preview);
  return executeEventCapability(
    'start-event',
    {
      source: 'activation-preview',
      activationPreviewId: preview.id,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: preview.activeEventIds,
      },
    },
    humanMutationInvocation({
      requestId: input.requestId ?? uuid(200),
      idempotencyKey: input.idempotencyKey ?? 'synthetic-start-key-0001',
      serverTime: TIMES.activation,
    }),
    store,
  );
}

describe('event lifecycle capabilities', () => {
  test('persists activation acceptance as one atomic event, transition, journal, intent, and outbox bundle', async () => {
    const store = new MemoryEventCapabilityStore();

    const result = await startSyntheticEvent(store);

    expect(result.event.status).toBe('active');
    expect(result.transition).toMatchObject({
      eventId: result.event.id,
      sequence: 1,
      transition: 'activate',
      from: 'draft',
      to: 'active',
    });
    expect(
      result.journalEntries.map((entry) =>
        'code' in entry.payload ? entry.payload.code : null,
      ),
    ).toEqual([
      'event-created',
      'event-activated',
      'notification-intent-recorded',
    ]);
    expect(domainCounts(store)).toEqual({
      events: 1,
      transitions: 1,
      journals: 3,
      intents: 1,
      outbox: 1,
      lifecycleWrites: 1,
      joinWrites: 0,
    });
    expect(store.lifecycleBundles).toHaveLength(1);
    expect(store.lifecycleBundles[0]).toMatchObject({
      result,
      integrationStatusIds: {
        push: uuid(100),
        email: uuid(101),
      },
    });
    expect(store.outboxRecords[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      message: {
        eventId: result.event.id,
        facilityId: IDS.facility,
        intentId: result.notificationIntent?.id,
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'activation',
        rosterPopulation: 'synthetic',
        eventTypeVersion: {
          id: IDS.eventTypeVersion,
          templateMode: 'drill',
        },
      },
    });
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        action: 'start-event',
        actionIds: [],
        outcome: 'success',
        facilityId: IDS.facility,
      }),
    ]);
  });

  test('rolls back every staged activation record when durable persistence fails', async () => {
    const store = new MemoryEventCapabilityStore();
    seedActivation(store, activationPreview());
    store.failNextLifecyclePersistenceAfterWrite();

    const error = await captureEngineError(() =>
      executeEventCapability(
        'start-event',
        {
          source: 'activation-preview',
          activationPreviewId: IDS.activationPreview,
          activeEventDecision: {
            decision: 'start-new',
            activeEventIdsSeen: [],
          },
        },
        humanMutationInvocation({
          requestId: uuid(201),
          idempotencyKey: 'atomic-failure-key-0001',
          serverTime: TIMES.activation,
        }),
        store,
      ),
    );

    expect(error).toMatchObject({
      code: 'INTERNAL_ERROR',
      reasonCode: 'PERSISTENCE_CONFLICT',
    });
    expect(domainCounts(store)).toEqual({
      events: 0,
      transitions: 0,
      journals: 0,
      intents: 0,
      outbox: 0,
      lifecycleWrites: 0,
      joinWrites: 0,
    });
    expect(store.idempotencyRecordCount).toBe(0);
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        action: 'start-event',
        outcome: 'failure',
        reasonCode: 'PERSISTENCE_CONFLICT',
      }),
    ]);
  });

  test('rejects a preview that expires while the transaction waits for locked truth', async () => {
    const store = new MemoryEventCapabilityStore();
    seedActivation(store, activationPreview());
    store.setCurrentTime(new Date('2026-08-08T16:11:00.000Z'));

    const error = await captureEngineError(() =>
      executeEventCapability(
        'start-event',
        {
          source: 'activation-preview',
          activationPreviewId: IDS.activationPreview,
          activeEventDecision: {
            decision: 'start-new',
            activeEventIdsSeen: [],
          },
        },
        humanMutationInvocation({
          requestId: uuid(215),
          idempotencyKey: 'preview-lock-expiry-key-0001',
          serverTime: TIMES.activation,
        }),
        store,
      ),
    );

    expect(error).toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 409,
    });
    expect(domainCounts(store)).toEqual({
      events: 0,
      transitions: 0,
      journals: 0,
      intents: 0,
      outbox: 0,
      lifecycleWrites: 0,
      joinWrites: 0,
    });
    expect(store.idempotencyRecordCount).toBe(0);
  });

  test('returns the original activation on same-key replay without a second write', async () => {
    const store = new MemoryEventCapabilityStore();
    const preview = activationPreview();
    seedActivation(store, preview);
    const input = {
      source: 'activation-preview',
      activationPreviewId: preview.id,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [],
      },
    } as const;
    const idempotencyKey = 'activation-replay-key-0001';

    const first = await executeEventCapability(
      'start-event',
      input,
      humanMutationInvocation({
        requestId: uuid(202),
        idempotencyKey,
        serverTime: TIMES.activation,
      }),
      store,
    );
    const beforeReplay = domainCounts(store);
    const replay = await executeEventCapability(
      'start-event',
      input,
      humanMutationInvocation({
        requestId: uuid(203),
        idempotencyKey,
        serverTime: TIMES.firstAllClear,
      }),
      store,
    );

    expect(replay).toEqual(first);
    expect(domainCounts(store)).toEqual(beforeReplay);
    expect(store.persistLifecycleCalls).toBe(1);
    expect(store.lifecycleReplayLoads).toBe(1);
    expect(store.events).toHaveLength(1);
    expect(store.notificationIntents).toHaveLength(1);
    expect(store.outboxRecords).toHaveLength(1);
  });

  test('keeps join-existing separate from an explicit start-new decision', async () => {
    const store = new MemoryEventCapabilityStore();
    const existing = activeEvent();
    store.seedEvent(existing);
    const preview = activationPreview({
      id: IDS.alternateActivationPreview,
      activeEventIds: [existing.id],
    });
    seedActivation(store, preview);

    expect(
      StartEventInputSchema.safeParse({
        source: 'activation-preview',
        activationPreviewId: preview.id,
        activeEventDecision: {
          decision: 'join-existing',
          eventId: existing.id,
        },
      }).success,
    ).toBe(false);

    const started = await executeEventCapability(
      'start-event',
      {
        source: 'activation-preview',
        activationPreviewId: preview.id,
        activeEventDecision: {
          decision: 'start-new',
          activeEventIdsSeen: [existing.id],
        },
      },
      humanMutationInvocation({
        requestId: uuid(204),
        idempotencyKey: 'explicit-start-new-key-0001',
        serverTime: TIMES.activation,
      }),
      store,
    );

    expect(started.event.id).not.toBe(existing.id);
    expect(store.events.map((event) => event.id)).toEqual(
      expect.arrayContaining([existing.id, started.event.id]),
    );
    const countsBeforeJoin = domainCounts(store);

    const joined = await executeEventCapability(
      'join-event',
      { eventId: existing.id },
      humanMutationInvocation({
        requestId: uuid(205),
        idempotencyKey: 'join-existing-key-0001',
        serverTime: TIMES.firstAllClear,
      }),
      store,
    );

    expect(joined).toMatchObject({ event: existing, joined: true });
    expect(store.events).toHaveLength(countsBeforeJoin.events);
    expect(store.transitions).toHaveLength(countsBeforeJoin.transitions);
    expect(store.notificationIntents).toHaveLength(countsBeforeJoin.intents);
    expect(store.outboxRecords).toHaveLength(countsBeforeJoin.outbox);
    expect(store.journals).toHaveLength(countsBeforeJoin.journals + 1);
    expect(store.journals.at(-1)).toMatchObject({
      eventId: existing.id,
      payload: {
        code: 'participant-joined',
        relatedRecordId: joined.participantId,
      },
    });
    expect(store.persistJoinCalls).toBe(1);
  });

  test('rejects start-new when the locked active-event set differs from the reviewed preview', async () => {
    const store = new MemoryEventCapabilityStore();
    const preview = activationPreview({ activeEventIds: [] });
    seedActivation(store, preview);
    store.seedEvent(activeEvent());
    const before = domainCounts(store);

    const error = await captureEngineError(() =>
      executeEventCapability(
        'start-event',
        {
          source: 'activation-preview',
          activationPreviewId: preview.id,
          activeEventDecision: {
            decision: 'start-new',
            activeEventIdsSeen: [],
          },
        },
        humanMutationInvocation({
          requestId: uuid(211),
          idempotencyKey: 'stale-active-event-set-0001',
          serverTime: TIMES.activation,
        }),
        store,
      ),
    );

    expect(error).toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 409,
    });
    expect(domainCounts(store)).toEqual(before);
    expect(store.idempotencyRecordCount).toBe(0);
  });

  test('checks facility scope before exposing activation readiness details', async () => {
    const store = new MemoryEventCapabilityStore();
    const preview = ActivationPreviewSchema.parse({
      ...activationPreview(),
      sendReadiness: 'blocked',
      blockingReasonCodes: ['NO_RECIPIENTS'],
    });
    seedActivation(store, preview);

    const error = await captureEngineError(() =>
      executeEventCapability(
        'start-event',
        {
          source: 'activation-preview',
          activationPreviewId: preview.id,
          activeEventDecision: {
            decision: 'start-new',
            activeEventIdsSeen: [],
          },
        },
        humanMutationInvocation({
          requestId: uuid(214),
          idempotencyKey: 'out-of-scope-readiness-key-0001',
          serverTime: TIMES.activation,
          scope: {
            facilityScope: {
              kind: 'facilities',
              facilityIds: [IDS.otherFacility],
            },
          },
        }),
        store,
      ),
    );

    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
      status: 403,
    });
    expect(domainCounts(store)).toEqual({
      events: 0,
      transitions: 0,
      journals: 0,
      intents: 0,
      outbox: 0,
      lifecycleWrites: 0,
      joinWrites: 0,
    });
    expect(store.idempotencyRecordCount).toBe(0);
  });

  test('appends all-clear, reactivation, second all-clear, and close truth without deleting history', async () => {
    const store = new MemoryEventCapabilityStore();
    const started = await startSyntheticEvent(store, {
      requestId: uuid(206),
      idempotencyKey: 'full-lifecycle-start-0001',
    });
    const activationTransitionId = started.transition.id;
    const activationJournalIds = started.journalEntries.map(
      (entry) => entry.id,
    );

    const firstPreview = lifecyclePreview(started.event, 'all-clear', {
      id: IDS.allClearPreview,
      createdAt: TIMES.firstAllClearPreview,
    });
    seedLifecycle(store, firstPreview);
    const firstAllClear = await executeEventCapability(
      'all-clear-event',
      {
        eventId: started.event.id,
        lifecyclePreviewId: firstPreview.id,
      },
      humanMutationInvocation({
        requestId: uuid(207),
        idempotencyKey: 'full-lifecycle-clear-0001',
        serverTime: TIMES.firstAllClear,
      }),
      store,
    );

    const reactivation = lifecyclePreview(firstAllClear.event, 'reactivation', {
      id: IDS.reactivationPreview,
      createdAt: TIMES.reactivationPreview,
    });
    seedLifecycle(store, reactivation);
    const reactivated = await executeEventCapability(
      'reactivate-event',
      {
        eventId: started.event.id,
        lifecyclePreviewId: reactivation.id,
      },
      humanMutationInvocation({
        requestId: uuid(208),
        idempotencyKey: 'full-lifecycle-reactivate-0001',
        serverTime: TIMES.reactivation,
      }),
      store,
    );

    const secondPreview = lifecyclePreview(reactivated.event, 'all-clear', {
      id: IDS.secondAllClearPreview,
      createdAt: TIMES.secondAllClearPreview,
    });
    seedLifecycle(store, secondPreview);
    const secondAllClear = await executeEventCapability(
      'all-clear-event',
      {
        eventId: started.event.id,
        lifecyclePreviewId: secondPreview.id,
      },
      humanMutationInvocation({
        requestId: uuid(209),
        idempotencyKey: 'full-lifecycle-clear-0002',
        serverTime: TIMES.secondAllClear,
      }),
      store,
    );
    const journalsBeforeClose = store.journals.map((entry) => entry.id);

    const closed = await executeEventCapability(
      'close-event',
      { eventId: started.event.id },
      humanMutationInvocation({
        requestId: uuid(210),
        idempotencyKey: 'full-lifecycle-close-0001',
        serverTime: TIMES.close,
      }),
      store,
    );

    expect(firstAllClear.event.status).toBe('all-clear');
    expect(reactivated.event.status).toBe('active');
    expect(secondAllClear.event.status).toBe('all-clear');
    expect(closed.event.status).toBe('closed');
    expect(closed.notificationIntent).toBeNull();
    expect(store.events).toEqual([closed.event]);
    expect(
      store.transitions.map((transition) => transition.transition),
    ).toEqual(['activate', 'all-clear', 'reactivate', 'all-clear', 'close']);
    expect(store.transitions.map((transition) => transition.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(store.transitions.map((transition) => transition.id)).toContain(
      activationTransitionId,
    );
    expect(store.journals).toHaveLength(10);
    expect(store.journals.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(store.journals.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([...activationJournalIds, ...journalsBeforeClose]),
    );
    expect(
      store.journals.map((entry) =>
        'code' in entry.payload ? entry.payload.code : null,
      ),
    ).toEqual([
      'event-created',
      'event-activated',
      'notification-intent-recorded',
      'all-clear-issued',
      'notification-intent-recorded',
      'event-reactivated',
      'notification-intent-recorded',
      'all-clear-issued',
      'notification-intent-recorded',
      'event-closed',
    ]);
    expect(store.notificationIntents).toHaveLength(4);
    expect(store.outboxRecords).toHaveLength(4);
    expect(store.persistLifecycleCalls).toBe(5);
  });

  test('reopens a closed event as a distinct retained correction and replays it idempotently', async () => {
    const store = new MemoryEventCapabilityStore();
    const source = activeEvent({ status: 'closed' });
    store.seedEvent(source);
    const input = {
      sourceEventId: source.id,
      reason: 'Correct the closed synthetic event record.',
    } as const;
    const idempotencyKey = 'reopen-correction-key-0001';

    const first = await executeEventCapability(
      'reopen-as-correction',
      input,
      humanMutationInvocation({
        requestId: uuid(212),
        idempotencyKey,
        serverTime: TIMES.close,
      }),
      store,
    );
    const beforeReplay = domainCounts(store);
    const replay = await executeEventCapability(
      'reopen-as-correction',
      input,
      humanMutationInvocation({
        requestId: uuid(213),
        idempotencyKey,
        serverTime: TIMES.previewExpires,
      }),
      store,
    );

    expect(first.event).toMatchObject({
      status: 'draft',
      correctionOfEventId: source.id,
      correctionReason: input.reason,
    });
    expect(first.event.id).not.toBe(source.id);
    expect(first.transition).toMatchObject({
      transition: 'reopen-as-correction',
      sourceEventId: source.id,
      correctionEventId: first.event.id,
      from: 'closed',
      to: 'draft',
    });
    expect(
      first.journalEntries.map((entry) =>
        'code' in entry.payload ? entry.payload.code : null,
      ),
    ).toEqual(['event-created', 'correction-opened']);
    expect(store.events).toHaveLength(2);
    expect(store.events.find((event) => event.id === source.id)).toEqual(
      source,
    );
    expect(replay).toEqual(first);
    expect(domainCounts(store)).toEqual(beforeReplay);
    expect(store.persistLifecycleCalls).toBe(1);
    expect(store.lifecycleReplayLoads).toBe(1);
  });

  test('allows authenticated humans to all-clear independently of staff or admin role', async () => {
    for (const [index, role] of (['staff', 'admin'] as const).entries()) {
      const store = new MemoryEventCapabilityStore();
      const event = activeEvent({ target: REAL_TARGET });
      store.seedEvent(event);
      const consequenceDigest = `${index + 3}`.repeat(64);
      const preview = lifecyclePreview(event, 'all-clear', {
        id: uuid(300 + index),
        createdAt: TIMES.previewCreated,
        consequenceDigest,
      });
      seedLifecycle(store, preview);
      const confirmationId = uuid(310 + index);
      store.seedConfirmation(
        issuedConfirmation({
          id: confirmationId,
          capabilityId: 'all-clear-event',
          actionIds: ['all-clear', 'send-real-notification'],
          consequenceDigest,
          issuedAt: TIMES.previewCreated,
          expiresAt: TIMES.firstAllClear,
        }),
      );
      const authenticated = {
        actor: HUMAN_ACTOR,
        source: 'web',
        roles: [role] satisfies readonly Role[],
        scope: DISTRICT_SCOPE,
        membershipState: 'fresh',
        result: { connectivityEpoch: { id: IDS.connectivityEpoch } },
      } as unknown as AuthenticatedSession;
      const requestId = uuid(320 + index);
      const invocation = resolveHumanCapabilityInvocation(authenticated, {
        requestId,
        serverTime: new Date(TIMES.activation),
        mutation: {
          idempotencyKey: `role-independent-clear-${role}-0001`,
          humanConfirmationId: confirmationId,
        },
      });

      const result = await executeEventCapability(
        'all-clear-event',
        { eventId: event.id, lifecyclePreviewId: preview.id },
        invocation,
        store,
      );

      expect('roles' in invocation).toBe(false);
      expect(result.event.status).toBe('all-clear');
      expect(result.transition.actor).toEqual(HUMAN_ACTOR);
      expect(store.getConfirmation(confirmationId)).toMatchObject({
        status: 'consumed',
        consumedForRequestId: requestId,
      });
      expect(store.auditEvents).toEqual([
        expect.objectContaining({
          category: 'capability-execution',
          action: 'all-clear-event',
          actionIds: ['all-clear', 'send-real-notification'],
          confirmationId,
          outcome: 'success',
          actor: HUMAN_ACTOR,
          facilityId: IDS.facility,
          requestId,
          reasonCode: null,
        }),
      ]);
    }
  });

  test('rejects illegal close and join transitions without partial domain writes', async () => {
    const activeStore = new MemoryEventCapabilityStore();
    const active = activeEvent();
    activeStore.seedEvent(active);
    const closeBefore = domainCounts(activeStore);

    const closeError = await captureEngineError(() =>
      executeEventCapability(
        'close-event',
        { eventId: active.id },
        humanMutationInvocation({
          requestId: uuid(400),
          idempotencyKey: 'illegal-close-key-0001',
          serverTime: TIMES.activation,
        }),
        activeStore,
      ),
    );

    expect(closeError).toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 409,
    });
    expect(domainCounts(activeStore)).toEqual(closeBefore);

    const clearedStore = new MemoryEventCapabilityStore();
    const cleared = activeEvent({ status: 'all-clear' });
    clearedStore.seedEvent(cleared);
    const joinBefore = domainCounts(clearedStore);
    const joinError = await captureEngineError(() =>
      executeEventCapability(
        'join-event',
        { eventId: cleared.id },
        humanMutationInvocation({
          requestId: uuid(401),
          idempotencyKey: 'illegal-join-key-0001',
          serverTime: TIMES.activation,
        }),
        clearedStore,
      ),
    );

    expect(joinError).toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 409,
    });
    expect(domainCounts(clearedStore)).toEqual(joinBefore);
  });

  test('fails closed on a real-versus-drill mismatch at both contract and capability boundaries', async () => {
    const realPreview = activationPreview({ target: REAL_TARGET });
    const drillPreview = activationPreview();
    const mismatches = [
      {
        key: 'real-event-drill-template',
        preview: {
          ...realPreview,
          eventTypeVersion: {
            ...realPreview.eventTypeVersion,
            templateMode: 'drill' as const,
          },
        },
        confirmationId: uuid(402),
      },
      {
        key: 'drill-event-real-template',
        preview: {
          ...drillPreview,
          eventTypeVersion: {
            ...drillPreview.eventTypeVersion,
            templateMode: 'real' as const,
          },
        },
        confirmationId: null,
      },
    ] as const;

    for (const [index, mismatch] of mismatches.entries()) {
      expect(ActivationPreviewSchema.safeParse(mismatch.preview).success).toBe(
        false,
      );
      const store = new MemoryEventCapabilityStore();
      seedActivation(store, mismatch.preview as unknown as ActivationPreview);
      if (mismatch.confirmationId !== null) {
        store.seedConfirmation(
          issuedConfirmation({
            id: mismatch.confirmationId,
            capabilityId: 'start-event',
            actionIds: ['start-real-incident', 'send-real-notification'],
            consequenceDigest: mismatch.preview.consequenceDigest,
            issuedAt: TIMES.previewCreated,
            expiresAt: TIMES.activation,
          }),
        );
      }
      const error = await captureEngineError(() =>
        executeEventCapability(
          'start-event',
          {
            source: 'activation-preview',
            activationPreviewId: mismatch.preview.id,
            activeEventDecision: {
              decision: 'start-new',
              activeEventIdsSeen: [],
            },
          },
          humanMutationInvocation({
            requestId: uuid(410 + index),
            idempotencyKey: `${mismatch.key}-0001`,
            serverTime: TIMES.activation,
            confirmationId: mismatch.confirmationId,
          }),
          store,
        ),
      );

      expect(error).toMatchObject({
        code: 'INTERNAL_ERROR',
        reasonCode: 'PERSISTENCE_CONFLICT',
      });
      expect(domainCounts(store)).toEqual({
        events: 0,
        transitions: 0,
        journals: 0,
        intents: 0,
        outbox: 0,
        lifecycleWrites: 0,
        joinWrites: 0,
      });
      expect(store.idempotencyRecordCount).toBe(0);
    }
  });

  test('rejects agent and system principals across staff/real critical lifecycle actions', async () => {
    const criticalCases: readonly Readonly<{
      name: string;
      expectedActionIds: readonly string[];
      arrange: (store: MemoryEventCapabilityStore) => void;
      execute: (
        store: MemoryEventCapabilityStore,
        invocation: TrustedCapabilityInvocation,
      ) => Promise<unknown>;
    }>[] = [
      {
        name: 'start',
        expectedActionIds: ['start-real-incident', 'send-real-notification'],
        arrange(store) {
          seedActivation(store, activationPreview({ target: REAL_TARGET }));
        },
        execute: (store, invocation) =>
          executeEventCapability(
            'start-event',
            {
              source: 'activation-preview',
              activationPreviewId: IDS.activationPreview,
              activeEventDecision: {
                decision: 'start-new',
                activeEventIdsSeen: [],
              },
            },
            invocation,
            store,
          ),
      },
      {
        name: 'all-clear',
        expectedActionIds: ['all-clear', 'send-real-notification'],
        arrange(store) {
          const event = activeEvent({ target: REAL_TARGET });
          store.seedEvent(event);
          seedLifecycle(
            store,
            lifecyclePreview(event, 'all-clear', {
              id: IDS.allClearPreview,
              createdAt: TIMES.previewCreated,
            }),
          );
        },
        execute: (store, invocation) =>
          executeEventCapability(
            'all-clear-event',
            {
              eventId: IDS.existingEvent,
              lifecyclePreviewId: IDS.allClearPreview,
            },
            invocation,
            store,
          ),
      },
      {
        name: 'reactivate',
        expectedActionIds: ['start-real-incident', 'send-real-notification'],
        arrange(store) {
          const event = activeEvent({
            target: REAL_TARGET,
            status: 'all-clear',
          });
          store.seedEvent(event);
          seedLifecycle(
            store,
            lifecyclePreview(event, 'reactivation', {
              id: IDS.reactivationPreview,
              createdAt: TIMES.previewCreated,
            }),
          );
        },
        execute: (store, invocation) =>
          executeEventCapability(
            'reactivate-event',
            {
              eventId: IDS.existingEvent,
              lifecyclePreviewId: IDS.reactivationPreview,
            },
            invocation,
            store,
          ),
      },
      {
        name: 'close',
        expectedActionIds: ['close-real-event'],
        arrange(store) {
          store.seedEvent(
            activeEvent({ target: REAL_TARGET, status: 'all-clear' }),
          );
        },
        execute: (store, invocation) =>
          executeEventCapability(
            'close-event',
            { eventId: IDS.existingEvent },
            invocation,
            store,
          ),
      },
    ];

    let requestSuffix = 500;
    for (const criticalCase of criticalCases) {
      for (const principal of ['agent', 'system'] as const) {
        const store = new MemoryEventCapabilityStore();
        criticalCase.arrange(store);
        const before = domainCounts(store);
        const requestId = uuid(requestSuffix);
        requestSuffix += 1;
        const error = await captureEngineError(() =>
          criticalCase.execute(
            store,
            nonHumanMutationInvocation(principal, {
              requestId,
              idempotencyKey: `${principal}-${criticalCase.name}-denied-0001`,
              serverTime: TIMES.activation,
            }),
          ),
        );

        expect(error).toMatchObject({
          code: 'FORBIDDEN',
          reasonCode: 'HUMAN_ONLY_REQUIRED',
          status: 403,
        });
        expect(domainCounts(store)).toEqual(before);
        expect(store.idempotencyRecordCount).toBe(0);
        expect(store.auditEvents).toEqual([
          expect.objectContaining({
            action: `${criticalCase.name === 'start' ? 'start-event' : criticalCase.name === 'all-clear' ? 'all-clear-event' : `${criticalCase.name}-event`}`,
            actionIds: criticalCase.expectedActionIds,
            category: 'human-only-rejection',
            outcome: 'denied',
            actor: principal === 'agent' ? AGENT_ACTOR : SYSTEM_ACTOR,
            requestId,
            reasonCode: 'HUMAN_ONLY_REQUIRED',
          }),
        ]);
      }
    }
  });
});
