import { describe, expect, test } from 'bun:test';

import {
  ActivationPreviewSchema,
  EventSchema,
  HumanConfirmationRecordSchema,
  PreparedActivationSchema,
  type ActivationPreview,
  type CapabilityInput,
  type Event,
  type EventLifecycleMutationResult,
  type EventPage,
  type HumanConfirmationRecord,
  type JoinEventResult,
  type PreparedActivation,
} from '@psd-eoc/contracts';

import {
  CapabilityEngineError,
  type CapabilityAuditEvent,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type ConsumeHumanConfirmationInput,
  type IdempotencyClaim,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import {
  executeEventCapability,
  type EventCapabilityStore,
  type EventCapabilityTransaction,
  type LifecyclePersistenceBundle,
  type ResolvedActivationSource,
  type ResolvedEventState,
  type ResolvedLifecyclePreview,
} from '../capabilities/events';
import {
  executePreparedActivationCapability,
  type PersistPreparedActivationInput,
  type PreparedActivationCapabilityStore,
  type PreparedActivationCapabilityTransaction,
} from './prepared-activation';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000101',
  apiKey: '00000000-0000-4000-8000-000000000102',
  request: '00000000-0000-4000-8000-000000000103',
  facility: '00000000-0000-4000-8000-000000000104',
  otherFacility: '00000000-0000-4000-8000-000000000105',
  preview: '00000000-0000-4000-8000-000000000106',
  eventType: '00000000-0000-4000-8000-000000000107',
  roster: '00000000-0000-4000-8000-000000000108',
  audience: '00000000-0000-4000-8000-000000000109',
  prepared: '00000000-0000-4000-8000-000000000110',
  human: '00000000-0000-4000-8000-000000000113',
  session: '00000000-0000-4000-8000-000000000114',
  connectivityEpoch: '00000000-0000-4000-8000-000000000115',
  confirmation: '00000000-0000-4000-8000-000000000116',
  humanRequest: '00000000-0000-4000-8000-000000000117',
  agentStartRequest: '00000000-0000-4000-8000-000000000118',
  pushIntegrationStatus: '00000000-0000-4000-8000-000000000119',
  emailIntegrationStatus: '00000000-0000-4000-8000-000000000120',
  event: '00000000-0000-4000-8000-000000000121',
  humanAllowedRead: '00000000-0000-4000-8000-000000000122',
  agentAllowedRead: '00000000-0000-4000-8000-000000000123',
  humanDeniedRead: '00000000-0000-4000-8000-000000000124',
  agentDeniedRead: '00000000-0000-4000-8000-000000000125',
  threat: '00000000-0000-4000-8000-000000000126',
});

interface MemoryIdempotency {
  readonly id: string;
  readonly requestDigest: string;
  resultReference: string | null;
}

function realActivationPreview(
  input: Readonly<{ expiresAt?: string }> = {},
): ActivationPreview {
  const createdAt = '2026-08-10T18:00:00.000Z';
  const integrationStatus = (integrationId: 'expo-push' | 'ses-email') => ({
    integrationId,
    label: 'live-verified' as const,
    verifiedAt: createdAt,
    verifiedByUserId: '00000000-0000-4000-8000-000000000111',
    authorizationReference: 'approved-synthetic-test-fixture',
    reasonCode: null,
    observedAt: createdAt,
  });
  return ActivationPreviewSchema.parse({
    id: IDS.preview,
    facilityId: IDS.facility,
    kind: 'incident',
    templateMode: 'real',
    eventTypeVersion: { id: IDS.eventType, templateMode: 'real' },
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'staff',
    recipientCount: 2,
    channels: [
      {
        channel: 'push',
        endpointCount: 2,
        renderedMessage: {
          channel: 'push',
          eventKind: 'incident',
          templateMode: 'real',
          purpose: 'activation',
          classificationMarker: 'INCIDENT',
          title: '[INCIDENT] Synthetic event update',
          body: '[INCIDENT] Synthetic event fixture message.',
        },
        integrationStatus: integrationStatus('expo-push'),
      },
      {
        channel: 'email',
        endpointCount: 2,
        renderedMessage: {
          channel: 'email',
          eventKind: 'incident',
          templateMode: 'real',
          purpose: 'activation',
          classificationMarker: 'INCIDENT',
          subject: '[INCIDENT] Synthetic event update',
          textBody: '[INCIDENT] Synthetic event fixture message.',
        },
        integrationStatus: integrationStatus('ses-email'),
      },
    ],
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    activeEventIds: [],
    threat: { id: IDS.threat, name: 'Synthetic wildlife', detail: null },
    responseDetail: null,
    consequenceDigest: 'a'.repeat(64),
    createdAt,
    expiresAt: input.expiresAt ?? '2026-08-10T18:10:00.000Z',
  });
}

class MemoryPreparedActivationStore
  implements
    PreparedActivationCapabilityStore,
    PreparedActivationCapabilityTransaction
{
  public readonly audits: CapabilityAuditEvent[] = [];
  public readonly previews = new Map<string, ActivationPreview>();
  public readonly prepared = new Map<string, PreparedActivation>();
  private readonly idempotency = new Map<string, MemoryIdempotency>();
  private currentTime = new Date('2026-08-10T18:01:00.000Z');

  public setCurrentTime(value: string): void {
    this.currentTime = new Date(value);
  }

  public async transaction<Result>(
    operation: (
      transaction: PreparedActivationCapabilityTransaction,
    ) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  public async readCurrentTime(): Promise<Date> {
    return this.currentTime;
  }

  public async claimIdempotency(
    input: ClaimIdempotencyInput,
  ): Promise<IdempotencyClaim> {
    const key = `${input.capabilityId}:${input.principalDigest}:${input.key}`;
    const existing = this.idempotency.get(key);
    if (existing !== undefined) {
      return existing.resultReference === null
        ? { kind: 'in-progress', requestDigest: existing.requestDigest }
        : {
            kind: 'completed',
            requestDigest: existing.requestDigest,
            resultReference: existing.resultReference,
          };
    }
    const record = {
      id: IDS.request,
      requestDigest: input.requestDigest,
      resultReference: null,
    };
    this.idempotency.set(key, record);
    return { kind: 'new', recordId: record.id };
  }

  public async completeIdempotency(
    input: CompleteIdempotencyInput,
  ): Promise<void> {
    const record = [...this.idempotency.values()].find(
      (candidate) => candidate.id === input.recordId,
    );
    if (record === undefined || record.resultReference !== null) {
      throw new Error('Idempotency completion was not reserved.');
    }
    record.resultReference = input.resultReference;
  }

  public async getHumanConfirmation(): Promise<HumanConfirmationRecord | null> {
    return null;
  }

  public async consumeHumanConfirmation(): Promise<boolean> {
    return false;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.audits.push(event);
  }

  public async getActivationPreview(
    activationPreviewId: string,
  ): Promise<ActivationPreview | null> {
    return this.previews.get(activationPreviewId) ?? null;
  }

  public async getPreparedActivation(
    preparedActivationId: string,
  ): Promise<PreparedActivation | null> {
    return this.prepared.get(preparedActivationId) ?? null;
  }

  public async createPreparedActivation(
    input: PersistPreparedActivationInput,
  ): Promise<PreparedActivation> {
    if (
      [...this.prepared.values()].some(
        (candidate) => candidate.preview.id === input.preview.id,
      )
    ) {
      throw new CapabilityEngineError(
        'CONFLICT',
        'PERSISTENCE_CONFLICT',
        'The prepared activation could not be retained.',
        409,
      );
    }
    const prepared = PreparedActivationSchema.parse({
      id: IDS.prepared,
      preview: input.preview,
      preparedBy: input.preparedBy,
      preparedAt: input.preparedAt.toISOString(),
    });
    this.prepared.set(prepared.id, prepared);
    return prepared;
  }

  public async getPreparedActivationFacilityId(
    preparedActivationId: string,
  ): Promise<string | null> {
    return this.prepared.get(preparedActivationId)?.preview.facilityId ?? null;
  }
}

function agentInvocation(
  input: Readonly<{
    requestId?: string;
    idempotencyKey?: string;
    facilityIds?: readonly string[];
    mutation?: boolean;
  }> = {},
): TrustedCapabilityInvocation {
  const mutation = input.mutation ?? true;
  return {
    actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
    source: 'agent-rest',
    scope: {
      facilityScope:
        input.facilityIds === undefined
          ? { kind: 'district' }
          : { kind: 'facilities', facilityIds: input.facilityIds },
    },
    requestId: input.requestId ?? IDS.request,
    serverTime: new Date('2026-08-10T18:01:00.000Z'),
    connectivityEpochId: null,
    mutation: mutation
      ? {
          idempotencyKey:
            input.idempotencyKey ?? 'prepare-activation-agent-0001',
          transport: { kind: 'agent-rest-command', method: 'POST' },
          humanConfirmationId: null,
        }
      : null,
  };
}

interface EventIdempotencyRecord {
  readonly id: string;
  readonly requestDigest: string;
  resultReference: string | null;
}

class PreparedConsumptionEventStore
  implements EventCapabilityStore, EventCapabilityTransaction
{
  public readonly audits: CapabilityAuditEvent[] = [];
  public lifecycleBundle: LifecyclePersistenceBundle | null = null;
  public confirmationConsumed = false;
  private readonly events = new Map<string, Event>();
  private readonly idempotency = new Map<string, EventIdempotencyRecord>();
  private readonly confirmation: HumanConfirmationRecord;

  public constructor(public readonly preparedActivation: PreparedActivation) {
    this.confirmation = HumanConfirmationRecordSchema.parse({
      confirmation: {
        id: IDS.confirmation,
        capabilityId: 'start-event',
        actionIds: ['start-real-incident', 'send-real-notification'],
        connectivityEpochId: IDS.connectivityEpoch,
        confirmedByUserId: IDS.human,
        confirmedWithSessionId: IDS.session,
        consequenceDigest: preparedActivation.preview.consequenceDigest,
        issuedAt: '2026-08-10T18:01:30.000Z',
        expiresAt: '2026-08-10T18:03:00.000Z',
      },
      status: 'issued',
      consumedAt: null,
      consumedForRequestId: null,
      expiredAt: null,
    });
  }

  public async transaction<Result>(
    operation: (transaction: EventCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  public async readCurrentTime(): Promise<Date> {
    return new Date('2026-08-10T18:02:00.000Z');
  }

  public async claimIdempotency(
    input: ClaimIdempotencyInput,
  ): Promise<IdempotencyClaim> {
    const key = `${input.capabilityId}:${input.principalDigest}:${input.key}`;
    const existing = this.idempotency.get(key);
    if (existing !== undefined) {
      return existing.resultReference === null
        ? { kind: 'in-progress', requestDigest: existing.requestDigest }
        : {
            kind: 'completed',
            requestDigest: existing.requestDigest,
            resultReference: existing.resultReference,
          };
    }
    const record = {
      id: `00000000-0000-4000-8000-${String(130 + this.idempotency.size).padStart(12, '0')}`,
      requestDigest: input.requestDigest,
      resultReference: null,
    };
    this.idempotency.set(key, record);
    return { kind: 'new', recordId: record.id };
  }

  public async completeIdempotency(
    input: CompleteIdempotencyInput,
  ): Promise<void> {
    const record = [...this.idempotency.values()].find(
      (candidate) => candidate.id === input.recordId,
    );
    if (record === undefined || record.resultReference !== null) {
      throw new Error('Event idempotency completion was not reserved.');
    }
    record.resultReference = input.resultReference;
  }

  public async getHumanConfirmation(
    confirmationId: string,
  ): Promise<HumanConfirmationRecord | null> {
    return confirmationId === this.confirmation.confirmation.id
      ? this.confirmation
      : null;
  }

  public async consumeHumanConfirmation(
    input: ConsumeHumanConfirmationInput,
  ): Promise<boolean> {
    if (
      input.confirmationId !== this.confirmation.confirmation.id ||
      this.confirmationConsumed
    ) {
      return false;
    }
    this.confirmationConsumed = true;
    return true;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.audits.push(event);
  }

  public async resolveActivationFacilityId(
    input: CapabilityInput<'start-event'>,
  ): Promise<string | null> {
    const sourceId =
      input.source === 'prepared-activation'
        ? input.preparedActivationId
        : input.activationPreviewId;
    return sourceId === this.preparedActivation.id ||
      sourceId === this.preparedActivation.preview.id
      ? this.preparedActivation.preview.facilityId
      : null;
  }

  public async resolveActivationSource(
    input: CapabilityInput<'start-event'>,
  ): Promise<ResolvedActivationSource | null> {
    if (
      input.source !== 'prepared-activation' ||
      input.preparedActivationId !== this.preparedActivation.id
    ) {
      return null;
    }
    return {
      preview: this.preparedActivation.preview,
      preparedActivation: this.preparedActivation,
      integrationStatusIds: {
        push: IDS.pushIntegrationStatus,
        email: IDS.emailIntegrationStatus,
      },
      currentActiveEventIds: [],
    };
  }

  public async resolveEventFacilityId(eventId: string): Promise<string | null> {
    return this.events.get(eventId)?.facilityId ?? null;
  }

  public async resolveEventForUpdate(): Promise<ResolvedEventState | null> {
    return null;
  }

  public async resolveLifecyclePreview(): Promise<ResolvedLifecyclePreview | null> {
    return null;
  }

  public async getEvent(eventId: string): Promise<Event | null> {
    return this.events.get(eventId) ?? null;
  }

  public async listActiveEvents(): Promise<EventPage> {
    return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
  }

  public async persistLifecycle(
    bundle: LifecyclePersistenceBundle,
  ): Promise<void> {
    this.lifecycleBundle = bundle;
    this.events.set(bundle.result.event.id, bundle.result.event);
  }

  public async persistJoin(): Promise<void> {
    throw new Error('Join persistence is not used by this focused store.');
  }

  public async resolveReplayFacilityId(): Promise<string | null> {
    return null;
  }

  public async loadLifecycleResult(): Promise<EventLifecycleMutationResult | null> {
    return null;
  }

  public async loadJoinResult(): Promise<JoinEventResult | null> {
    return null;
  }

  public seedEvent(event: Event): void {
    const parsed = EventSchema.parse(event);
    this.events.set(parsed.id, parsed);
  }
}

function humanStartInvocation(): TrustedCapabilityInvocation {
  return {
    actor: { kind: 'human', userId: IDS.human, sessionId: IDS.session },
    source: 'web',
    scope: { facilityScope: { kind: 'district' } },
    requestId: IDS.humanRequest,
    serverTime: new Date('2026-08-10T18:02:00.000Z'),
    connectivityEpochId: IDS.connectivityEpoch,
    mutation: {
      idempotencyKey: 'human-prepared-start-0001',
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId: IDS.confirmation,
    },
  };
}

function eventReadInvocation(
  actor: 'human' | 'agent',
  requestId: string,
  facilityIds: readonly string[],
): TrustedCapabilityInvocation {
  return {
    actor:
      actor === 'human'
        ? { kind: 'human', userId: IDS.human, sessionId: IDS.session }
        : { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
    source: actor === 'human' ? 'web' : 'agent-rest',
    scope: { facilityScope: { kind: 'facilities', facilityIds } },
    requestId,
    serverTime: new Date('2026-08-10T18:03:00.000Z'),
    connectivityEpochId: actor === 'human' ? IDS.connectivityEpoch : null,
    mutation: null,
  };
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

function activeEventFixture(): Event {
  return EventSchema.parse({
    id: IDS.event,
    facilityId: IDS.facility,
    kind: 'incident',
    templateMode: 'real',
    eventTypeVersion: { id: IDS.eventType, templateMode: 'real' },
    status: 'active',
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'staff',
    createdBy: { kind: 'human', userId: IDS.human, sessionId: IDS.session },
    threat: { id: IDS.threat, name: 'Synthetic wildlife', detail: null },
    responseDetail: null,
    createdAt: '2026-08-10T18:02:00.000Z',
    activatedAt: '2026-08-10T18:02:00.000Z',
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: {
      kind: 'human-confirmed',
      activationPreviewId: IDS.preview,
      preparedActivationId: IDS.prepared,
      confirmationId: IDS.confirmation,
      consequenceDigest: 'a'.repeat(64),
      requestId: IDS.humanRequest,
    },
  });
}

describe('prepared activation capability', () => {
  test('retains an agent-authored intent without activating or sending', async () => {
    const store = new MemoryPreparedActivationStore();
    store.previews.set(IDS.preview, realActivationPreview());

    const prepared = await executePreparedActivationCapability(
      'prepare-activation',
      { activationPreviewId: IDS.preview },
      agentInvocation(),
      store,
    );

    expect(prepared).toMatchObject({
      id: IDS.prepared,
      preview: {
        id: IDS.preview,
        facilityId: IDS.facility,
        kind: 'incident',
        rosterPopulation: 'staff',
      },
      preparedBy: {
        kind: 'agent',
        agentId: IDS.agent,
        apiKeyId: IDS.apiKey,
      },
      preparedAt: '2026-08-10T18:01:00.000Z',
    });
    expect(store.prepared).toHaveLength(1);
    expect(store.audits).toEqual([
      expect.objectContaining({
        category: 'agent-access',
        action: 'prepare-activation',
        actionIds: [],
        outcome: 'success',
        facilityId: IDS.facility,
        actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
      }),
    ]);
  });

  test('returns a bounded conflict when a preview was already prepared', async () => {
    const store = new MemoryPreparedActivationStore();
    store.previews.set(IDS.preview, realActivationPreview());

    const prepared = await executePreparedActivationCapability(
      'prepare-activation',
      { activationPreviewId: IDS.preview },
      agentInvocation(),
      store,
    );

    await expect(
      executePreparedActivationCapability(
        'prepare-activation',
        { activationPreviewId: IDS.preview },
        agentInvocation({
          requestId: IDS.agentStartRequest,
          idempotencyKey: 'prepare-activation-agent-duplicate-preview',
        }),
        store,
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 409,
      retryable: false,
    });

    expect(store.prepared).toHaveLength(1);
    expect(store.prepared.get(prepared.id)).toEqual(prepared);
    expect(store.audits.at(-1)).toMatchObject({
      action: 'prepare-activation',
      outcome: 'failure',
      reasonCode: 'PERSISTENCE_CONFLICT',
      facilityId: IDS.facility,
    });
  });

  test('returns the retained handoff through the canonical scoped read', async () => {
    const store = new MemoryPreparedActivationStore();
    const preview = realActivationPreview();
    store.previews.set(preview.id, preview);
    const prepared = await executePreparedActivationCapability(
      'prepare-activation',
      { activationPreviewId: preview.id },
      agentInvocation(),
      store,
    );

    const loaded = await executePreparedActivationCapability(
      'get-prepared-activation',
      { preparedActivationId: prepared.id },
      agentInvocation({
        requestId: '00000000-0000-4000-8000-000000000112',
        mutation: false,
      }),
      store,
    );

    expect(loaded).toEqual(prepared);
    expect(store.audits.at(-1)).toMatchObject({
      category: 'agent-access',
      action: 'get-prepared-activation',
      facilityId: IDS.facility,
      outcome: 'success',
    });
  });

  test('denies facility scope before retaining the prepared intent', async () => {
    const store = new MemoryPreparedActivationStore();
    store.previews.set(IDS.preview, realActivationPreview());

    await expect(
      executePreparedActivationCapability(
        'prepare-activation',
        { activationPreviewId: IDS.preview },
        agentInvocation({ facilityIds: [IDS.otherFacility] }),
        store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
      status: 403,
    });

    expect(store.prepared).toHaveLength(0);
    expect(store.audits).toEqual([
      expect.objectContaining({
        category: 'access-denial',
        action: 'prepare-activation',
        facilityId: IDS.facility,
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
      }),
    ]);
  });

  test('fails closed after preview expiry', async () => {
    const store = new MemoryPreparedActivationStore();
    store.previews.set(
      IDS.preview,
      realActivationPreview({ expiresAt: '2026-08-10T18:02:00.000Z' }),
    );
    store.setCurrentTime('2026-08-10T18:02:00.001Z');

    await expect(
      executePreparedActivationCapability(
        'prepare-activation',
        { activationPreviewId: IDS.preview },
        agentInvocation(),
        store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(store.prepared).toHaveLength(0);
  });

  test('preserves agent preparation provenance while only a confirmed human consumes the handoff', async () => {
    const preparationStore = new MemoryPreparedActivationStore();
    preparationStore.previews.set(IDS.preview, realActivationPreview());
    const prepared = await executePreparedActivationCapability(
      'prepare-activation',
      { activationPreviewId: IDS.preview },
      agentInvocation(),
      preparationStore,
    );
    const eventStore = new PreparedConsumptionEventStore(prepared);
    const startInput = {
      source: 'prepared-activation',
      preparedActivationId: prepared.id,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [],
      },
    } as const;

    const agentError = await captureEngineError(() =>
      executeEventCapability(
        'start-event',
        startInput,
        agentInvocation({
          requestId: IDS.agentStartRequest,
          idempotencyKey: 'agent-prepared-start-0001',
        }),
        eventStore,
      ),
    );

    expect(agentError).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'HUMAN_ONLY_REQUIRED',
      status: 403,
    });
    expect(eventStore.lifecycleBundle).toBeNull();
    expect(eventStore.confirmationConsumed).toBe(false);

    const result = await executeEventCapability(
      'start-event',
      startInput,
      humanStartInvocation(),
      eventStore,
    );

    expect(prepared.preparedBy).toEqual({
      kind: 'agent',
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    });
    expect(eventStore.preparedActivation.preparedBy).toEqual(
      prepared.preparedBy,
    );
    expect(result.event).toMatchObject({
      createdBy: {
        kind: 'human',
        userId: IDS.human,
        sessionId: IDS.session,
      },
      activationAuthorization: {
        kind: 'human-confirmed',
        preparedActivationId: prepared.id,
        confirmationId: IDS.confirmation,
      },
    });
    expect(result.preparedActivationConsumption).toMatchObject({
      preparedActivationId: prepared.id,
      eventId: result.event.id,
      consumedBy: {
        kind: 'human',
        userId: IDS.human,
        sessionId: IDS.session,
      },
      requestId: IDS.humanRequest,
    });
    expect(eventStore.confirmationConsumed).toBe(true);
    expect(eventStore.lifecycleBundle?.result).toEqual(result);
    expect(preparationStore.audits).toEqual([
      expect.objectContaining({
        category: 'agent-access',
        action: 'prepare-activation',
        actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
        outcome: 'success',
      }),
    ]);
    expect(eventStore.audits).toEqual([
      expect.objectContaining({
        category: 'human-only-rejection',
        action: 'start-event',
        actionIds: ['start-real-incident', 'send-real-notification'],
        actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
        outcome: 'denied',
        reasonCode: 'HUMAN_ONLY_REQUIRED',
      }),
      expect.objectContaining({
        category: 'capability-execution',
        action: 'start-event',
        actionIds: ['start-real-incident', 'send-real-notification'],
        actor: {
          kind: 'human',
          userId: IDS.human,
          sessionId: IDS.session,
        },
        confirmationId: IDS.confirmation,
        facilityId: IDS.facility,
        requestId: IDS.humanRequest,
        outcome: 'success',
      }),
    ]);
  });

  test('applies identical facility-scope authorization to human and agent event reads', async () => {
    const prepared = PreparedActivationSchema.parse({
      id: IDS.prepared,
      preview: realActivationPreview(),
      preparedBy: {
        kind: 'agent',
        agentId: IDS.agent,
        apiKeyId: IDS.apiKey,
      },
      preparedAt: '2026-08-10T18:01:00.000Z',
    });
    const store = new PreparedConsumptionEventStore(prepared);
    const event = activeEventFixture();
    store.seedEvent(event);

    const humanAllowed = await executeEventCapability(
      'get-event',
      { eventId: event.id },
      eventReadInvocation('human', IDS.humanAllowedRead, [IDS.facility]),
      store,
    );
    const agentAllowed = await executeEventCapability(
      'get-event',
      { eventId: event.id },
      eventReadInvocation('agent', IDS.agentAllowedRead, [IDS.facility]),
      store,
    );

    expect(humanAllowed).toEqual(event);
    expect(agentAllowed).toEqual(humanAllowed);

    const humanDenied = await captureEngineError(() =>
      executeEventCapability(
        'get-event',
        { eventId: event.id },
        eventReadInvocation('human', IDS.humanDeniedRead, [IDS.otherFacility]),
        store,
      ),
    );
    const agentDenied = await captureEngineError(() =>
      executeEventCapability(
        'get-event',
        { eventId: event.id },
        eventReadInvocation('agent', IDS.agentDeniedRead, [IDS.otherFacility]),
        store,
      ),
    );

    const authorizationEvidence = (error: CapabilityEngineError) => ({
      code: error.code,
      reasonCode: error.reasonCode,
      status: error.status,
    });
    expect(authorizationEvidence(humanDenied)).toEqual({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
      status: 403,
    });
    expect(authorizationEvidence(agentDenied)).toEqual(
      authorizationEvidence(humanDenied),
    );
    expect(
      store.audits.map(({ action, actor, outcome, reasonCode }) => ({
        action,
        actor: actor.kind,
        outcome,
        reasonCode,
      })),
    ).toEqual([
      {
        action: 'get-event',
        actor: 'human',
        outcome: 'success',
        reasonCode: null,
      },
      {
        action: 'get-event',
        actor: 'agent',
        outcome: 'success',
        reasonCode: null,
      },
      {
        action: 'get-event',
        actor: 'human',
        outcome: 'denied',
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
      },
      {
        action: 'get-event',
        actor: 'agent',
        outcome: 'denied',
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
      },
    ]);
  });
});
