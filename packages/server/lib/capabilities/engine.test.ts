import { describe, expect, test } from 'bun:test';

import {
  HumanConfirmationRecordSchema,
  type CapabilityOutput,
  type CapabilityScope,
  type HumanConfirmationRecord,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../auth/sessions';
import {
  CapabilityEngineError,
  executeCapability,
  requireCapabilityAuthorization,
  resolveHumanCapabilityInvocation,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type ConsumeHumanConfirmationInput,
  type IdempotencyClaim,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';

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
  event: uuid(8),
  otherEvent: uuid(9),
  eventTypeVersion: uuid(10),
  rosterSnapshot: uuid(11),
  activationPreview: uuid(12),
  activationConfirmation: uuid(13),
  activationRequest: uuid(14),
  participant: uuid(15),
  closeTransition: uuid(16),
  closeJournal: uuid(17),
  closeConfirmation: uuid(18),
  consumedRequest: uuid(19),
});

const TIMES = Object.freeze({
  created: '2026-08-08T16:00:00.000Z',
  activated: '2026-08-08T16:01:00.000Z',
  allClear: '2026-08-08T16:02:00.000Z',
  confirmationIssued: '2026-08-08T16:02:30.000Z',
  execution: '2026-08-08T16:03:00.000Z',
  confirmationExpires: '2026-08-08T16:04:30.000Z',
  expiredConfirmationIssued: '2026-08-08T15:56:00.000Z',
  expiredConfirmationExpires: '2026-08-08T16:01:00.000Z',
});

const CLOSE_CONSEQUENCE_DIGEST = 'c'.repeat(64);

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
  serviceId: 'synthetic-engine-test',
});

const DISTRICT_SCOPE = Object.freeze({
  facilityScope: { kind: 'district' as const },
});

function facilityScope(facilityId: string): CapabilityScope {
  return {
    facilityScope: { kind: 'facilities', facilityIds: [facilityId] },
  };
}

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
  nextRecordNumber: number;
  currentTime: Date | null;
}

function cloneMemoryState(state: MemoryState): MemoryState {
  return {
    idempotency: new Map(
      [...state.idempotency].map(([key, record]) => [key, { ...record }]),
    ),
    confirmations: new Map(state.confirmations),
    audits: [...state.audits],
    nextRecordNumber: state.nextRecordNumber,
    currentTime: state.currentTime,
  };
}

function idempotencyScopeKey(input: ClaimIdempotencyInput): string {
  return `${input.capabilityId}:${input.principalDigest}:${input.key}`;
}

class MemoryCapabilityTransaction implements CapabilityEngineTransaction {
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
}

class MemoryCapabilityStore
  implements CapabilityEngineStore<MemoryCapabilityTransaction>
{
  private state: MemoryState = {
    idempotency: new Map(),
    confirmations: new Map(),
    audits: [],
    nextRecordNumber: 1,
    currentTime: null,
  };

  public async transaction<Result>(
    operation: (transaction: MemoryCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    const candidate = cloneMemoryState(this.state);
    const result = await operation(new MemoryCapabilityTransaction(candidate));
    this.state = candidate;
    return result;
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.state.audits.push(event);
  }

  public seedConfirmation(record: HumanConfirmationRecord): void {
    const parsed = HumanConfirmationRecordSchema.parse(record);
    this.state.confirmations.set(parsed.confirmation.id, parsed);
  }

  public setCurrentTime(currentTime: Date): void {
    this.state.currentTime = currentTime;
  }

  public getConfirmation(id: string): HumanConfirmationRecord | undefined {
    return this.state.confirmations.get(id);
  }

  public get auditEvents(): readonly CapabilityAuditEvent[] {
    return this.state.audits;
  }
}

function humanMutationInvocation(
  input: Readonly<{
    requestId: string;
    idempotencyKey: string;
    humanConfirmationId?: string | null;
    scope?: CapabilityScope;
    serverTime?: Date;
  }>,
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope: input.scope ?? DISTRICT_SCOPE,
    requestId: input.requestId,
    serverTime: input.serverTime ?? new Date(TIMES.execution),
    connectivityEpochId: IDS.connectivityEpoch,
    mutation: {
      idempotencyKey: input.idempotencyKey,
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId: input.humanConfirmationId ?? null,
    },
  };
}

function humanQueryInvocation(
  requestId: string,
  scope: CapabilityScope,
): TrustedCapabilityInvocation {
  return {
    actor: HUMAN_ACTOR,
    source: 'web',
    scope,
    requestId,
    serverTime: new Date(TIMES.execution),
    connectivityEpochId: IDS.connectivityEpoch,
    mutation: null,
  };
}

const SYNTHETIC_ACTIVE_EVENT = Object.freeze({
  id: IDS.event,
  facilityId: IDS.facility,
  kind: 'test' as const,
  templateMode: 'drill' as const,
  eventTypeVersion: {
    id: IDS.eventTypeVersion,
    templateMode: 'drill' as const,
  },
  status: 'active' as const,
  rosterSnapshotId: IDS.rosterSnapshot,
  rosterPopulation: 'synthetic' as const,
  createdBy: AGENT_ACTOR,
  createdAt: TIMES.created,
  activatedAt: TIMES.activated,
  allClearAt: null,
  reactivatedAt: null,
  closedAt: null,
  correctionOfEventId: null,
  correctionReason: null,
  activationAuthorization: {
    kind: 'synthetic-training' as const,
    activationPreviewId: IDS.activationPreview,
    consequenceDigest: 'a'.repeat(64),
    requestId: IDS.activationRequest,
  },
});

const JOIN_RESULT = Object.freeze({
  event: SYNTHETIC_ACTIVE_EVENT,
  participantId: IDS.participant,
  joined: true as const,
}) satisfies CapabilityOutput<'join-event'>;

function createJoinRegistration(): Readonly<{
  registration: ServerCapabilityRegistration<
    'join-event',
    MemoryCapabilityTransaction
  >;
  handlerCalls: () => number;
  replayLoads: () => number;
}> {
  let handlerCalls = 0;
  let replayLoads = 0;
  const reference = `join:${IDS.participant}`;
  return {
    registration: {
      id: 'join-event',
      handler: () => {
        handlerCalls += 1;
        return JOIN_RESULT;
      },
      resolveFacilityId: () => IDS.facility,
      resultReference: () => reference,
      loadReplay: (resultReference) => {
        replayLoads += 1;
        if (resultReference !== reference) {
          throw new Error('Unknown join replay reference.');
        }
        return JOIN_RESULT;
      },
      resolveReplayFacilityId: () => IDS.facility,
      replayFacilityId: (output) => output.event.facilityId,
    },
    handlerCalls: () => handlerCalls,
    replayLoads: () => replayLoads,
  };
}

function createListRegistration(): Readonly<{
  registration: ServerCapabilityRegistration<
    'list-active-events',
    MemoryCapabilityTransaction
  >;
  handlerCalls: () => number;
}> {
  let handlerCalls = 0;
  return {
    registration: {
      id: 'list-active-events',
      handler: () => {
        handlerCalls += 1;
        return {
          items: [],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      },
      resolveFacilityId: (input) => input.facilityId,
    },
    handlerCalls: () => handlerCalls,
  };
}

function createCloseRegistration(): Readonly<{
  registration: ServerCapabilityRegistration<
    'close-event',
    MemoryCapabilityTransaction
  >;
  handlerCalls: () => number;
}> {
  let handlerCalls = 0;
  let persistedOutput: CapabilityOutput<'close-event'> | null = null;

  const registration: ServerCapabilityRegistration<
    'close-event',
    MemoryCapabilityTransaction
  > = {
    id: 'close-event',
    resolveFacilityId: () => IDS.facility,
    resolveSafety: () => ({
      eventKind: 'incident',
      rosterPopulation: 'staff',
      consequenceDigest: CLOSE_CONSEQUENCE_DIGEST,
    }),
    handler: (_input, context) => {
      handlerCalls += 1;
      const authorization = requireCapabilityAuthorization(context);
      if (
        authorization.humanConfirmation === null ||
        context.invocation.mutation === null
      ) {
        throw new Error('Close handler ran without protected authorization.');
      }

      const occurredAt = context.invocation.serverTime.toISOString();
      const transition = {
        id: IDS.closeTransition,
        sequence: 3,
        actor: context.invocation.actor,
        source: context.invocation.source,
        occurredAt,
        requestId: context.invocation.requestId,
        confirmationId: authorization.humanConfirmation.id,
        consequenceDigest:
          authorization.humanActionRequirement.consequenceDigest,
        targeting: {
          kind: 'incident' as const,
          templateMode: 'real' as const,
          rosterPopulation: 'staff' as const,
        },
        idempotencyKey: context.invocation.mutation.idempotencyKey,
        transition: 'close' as const,
        eventId: IDS.event,
        from: 'all-clear' as const,
        to: 'closed' as const,
      };
      const output = {
        event: {
          id: IDS.event,
          facilityId: IDS.facility,
          kind: 'incident' as const,
          templateMode: 'real' as const,
          eventTypeVersion: {
            id: IDS.eventTypeVersion,
            templateMode: 'real' as const,
          },
          status: 'closed' as const,
          rosterSnapshotId: IDS.rosterSnapshot,
          rosterPopulation: 'staff' as const,
          createdBy: HUMAN_ACTOR,
          createdAt: TIMES.created,
          activatedAt: TIMES.activated,
          allClearAt: TIMES.allClear,
          reactivatedAt: null,
          closedAt: occurredAt,
          correctionOfEventId: null,
          correctionReason: null,
          activationAuthorization: {
            kind: 'human-confirmed' as const,
            activationPreviewId: IDS.activationPreview,
            preparedActivationId: null,
            confirmationId: IDS.activationConfirmation,
            consequenceDigest: 'a'.repeat(64),
            requestId: IDS.activationRequest,
          },
        },
        transition,
        journalEntries: [
          {
            id: IDS.closeJournal,
            eventId: IDS.event,
            sequence: 3,
            kind: 'system' as const,
            author: context.invocation.actor,
            source: context.invocation.source,
            serverTime: occurredAt,
            clientTime: null,
            supersedes: null,
            payload: {
              code: 'event-closed' as const,
              summary: 'Synthetic incident closed.',
              transition,
            },
          },
        ],
        notificationIntent: null,
        preparedActivationConsumption: null,
      } satisfies CapabilityOutput<'close-event'>;
      persistedOutput = output;
      return output;
    },
    resultReference: (output) => `close:${output.transition.id}`,
    loadReplay: (reference) => {
      if (
        persistedOutput === null ||
        reference !== `close:${persistedOutput.transition.id}`
      ) {
        throw new Error('Unknown close replay reference.');
      }
      return persistedOutput;
    },
    resolveReplayFacilityId: () => IDS.facility,
    replayFacilityId: (output) => output.event.facilityId,
  };

  return {
    registration,
    handlerCalls: () => handlerCalls,
  };
}

function issuedCloseConfirmation(
  overrides: Readonly<{
    consequenceDigest?: string;
    issuedAt?: string;
    expiresAt?: string;
  }> = {},
): HumanConfirmationRecord {
  return HumanConfirmationRecordSchema.parse({
    confirmation: {
      id: IDS.closeConfirmation,
      capabilityId: 'close-event',
      actionIds: ['close-real-event'],
      connectivityEpochId: IDS.connectivityEpoch,
      confirmedByUserId: IDS.user,
      confirmedWithSessionId: IDS.session,
      consequenceDigest:
        overrides.consequenceDigest ?? CLOSE_CONSEQUENCE_DIGEST,
      issuedAt: overrides.issuedAt ?? TIMES.confirmationIssued,
      expiresAt: overrides.expiresAt ?? TIMES.confirmationExpires,
    },
    status: 'issued',
    consumedAt: null,
    consumedForRequestId: null,
    expiredAt: null,
  });
}

function consumedCloseConfirmation(): HumanConfirmationRecord {
  const issued = issuedCloseConfirmation();
  return HumanConfirmationRecordSchema.parse({
    confirmation: issued.confirmation,
    status: 'consumed',
    consumedAt: TIMES.confirmationIssued,
    consumedForRequestId: IDS.consumedRequest,
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

describe('capability engine', () => {
  test('derives a trusted human invocation from issue #7 session facts', () => {
    const authenticated = {
      actor: HUMAN_ACTOR,
      source: 'web',
      roles: ['staff'],
      scope: facilityScope(IDS.facility),
      membershipState: 'fresh',
      result: { connectivityEpoch: { id: IDS.connectivityEpoch } },
    } as unknown as AuthenticatedSession;
    const serverTime = new Date(TIMES.execution);

    const invocation = resolveHumanCapabilityInvocation(authenticated, {
      requestId: uuid(100),
      serverTime,
      mutation: {
        idempotencyKey: 'human-resolution-key-0001',
        humanConfirmationId: IDS.closeConfirmation,
      },
    });

    expect(invocation).toMatchObject({
      actor: HUMAN_ACTOR,
      source: 'web',
      scope: facilityScope(IDS.facility),
      requestId: uuid(100),
      serverTime,
      connectivityEpochId: IDS.connectivityEpoch,
      mutation: {
        idempotencyKey: 'human-resolution-key-0001',
        humanConfirmationId: IDS.closeConfirmation,
        transport: {
          kind: 'web-interactive',
          method: 'POST',
          interaction: 'explicit-user-submit',
          csrfVerified: true,
        },
      },
    });
    expect(Object.isFrozen(invocation)).toBe(true);
    expect(Object.isFrozen(invocation.mutation)).toBe(true);
  });

  test('returns the original mutation result on same-key replay without a second handler call', async () => {
    const store = new MemoryCapabilityStore();
    const join = createJoinRegistration();
    const idempotencyKey = 'join-replay-key-0001';
    const input = { eventId: IDS.event };

    const first = await executeCapability(
      join.registration,
      input,
      humanMutationInvocation({
        requestId: uuid(101),
        idempotencyKey,
      }),
      store,
    );
    const replay = await executeCapability(
      join.registration,
      input,
      humanMutationInvocation({
        requestId: uuid(102),
        idempotencyKey,
      }),
      store,
    );

    expect(replay).toEqual(first);
    expect(join.handlerCalls()).toBe(1);
    expect(join.replayLoads()).toBe(1);
  });

  test('validates static transport and connectivity truth before idempotent replay', async () => {
    const store = new MemoryCapabilityStore();
    const join = createJoinRegistration();
    const idempotencyKey = 'join-static-replay-key-0001';
    const input = { eventId: IDS.event };

    await executeCapability(
      join.registration,
      input,
      humanMutationInvocation({
        requestId: uuid(140),
        idempotencyKey,
      }),
      store,
    );
    const baseInvocation = humanMutationInvocation({
      requestId: uuid(141),
      idempotencyKey,
    });
    const invalidInvocations: readonly TrustedCapabilityInvocation[] = [
      { ...baseInvocation, connectivityEpochId: null },
      {
        ...baseInvocation,
        requestId: uuid(142),
        mutation: {
          ...baseInvocation.mutation!,
          transport: {
            kind: 'mobile-interactive',
            interaction: 'explicit-user-submit',
          },
        },
      },
    ];

    for (const invocation of invalidInvocations) {
      const error = await captureEngineError(() =>
        executeCapability(join.registration, input, invocation, store),
      );
      expect(error).toMatchObject({
        code: 'VALIDATION_ERROR',
        reasonCode: 'MUTATION_METADATA_INVALID',
        status: 400,
      });
    }
    expect(join.handlerCalls()).toBe(1);
    expect(join.replayLoads()).toBe(0);
  });

  test('rejects reuse of an idempotency key for different canonical input', async () => {
    const store = new MemoryCapabilityStore();
    const join = createJoinRegistration();
    const idempotencyKey = 'join-mismatch-key-0001';

    await executeCapability(
      join.registration,
      { eventId: IDS.event },
      humanMutationInvocation({
        requestId: uuid(103),
        idempotencyKey,
      }),
      store,
    );
    const error = await captureEngineError(() =>
      executeCapability(
        join.registration,
        { eventId: IDS.otherEvent },
        humanMutationInvocation({
          requestId: uuid(104),
          idempotencyKey,
        }),
        store,
      ),
    );

    expect(error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      reasonCode: 'IDEMPOTENCY_REQUEST_MISMATCH',
      status: 409,
    });
    expect(join.handlerCalls()).toBe(1);
  });

  test('executes an authorized query without mutation or confirmation metadata', async () => {
    const store = new MemoryCapabilityStore();
    const list = createListRegistration();

    const result = await executeCapability(
      list.registration,
      { facilityId: IDS.facility, cursor: null, limit: 20 },
      humanQueryInvocation(uuid(143), facilityScope(IDS.facility)),
      store,
    );

    expect(result).toEqual({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(list.handlerCalls()).toBe(1);
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        action: 'list-active-events',
        outcome: 'success',
        facilityId: IDS.facility,
      }),
    ]);
  });

  test('denies an explicitly filtered query outside the trusted facility scope', async () => {
    const store = new MemoryCapabilityStore();
    const list = createListRegistration();
    const requestId = uuid(105);

    const error = await captureEngineError(() =>
      executeCapability(
        list.registration,
        { facilityId: IDS.facility, cursor: null, limit: 20 },
        humanQueryInvocation(requestId, facilityScope(IDS.otherFacility)),
        store,
      ),
    );

    expect(error.reasonCode).toBe('CAPABILITY_SCOPE_DENIED');
    expect(list.handlerCalls()).toBe(0);
    expect(store.auditEvents).toContainEqual(
      expect.objectContaining({
        action: 'list-active-events',
        category: 'access-denial',
        outcome: 'denied',
        facilityId: IDS.facility,
        requestId,
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
      }),
    );
  });

  test('reauthorizes facility scope before returning an idempotent replay', async () => {
    const store = new MemoryCapabilityStore();
    const join = createJoinRegistration();
    const idempotencyKey = 'join-reauthorize-key-0001';

    await executeCapability(
      join.registration,
      { eventId: IDS.event },
      humanMutationInvocation({
        requestId: uuid(106),
        idempotencyKey,
        scope: facilityScope(IDS.facility),
      }),
      store,
    );
    const error = await captureEngineError(() =>
      executeCapability(
        join.registration,
        { eventId: IDS.event },
        humanMutationInvocation({
          requestId: uuid(107),
          idempotencyKey,
          scope: facilityScope(IDS.otherFacility),
        }),
        store,
      ),
    );

    expect(error.reasonCode).toBe('CAPABILITY_SCOPE_DENIED');
    expect(join.handlerCalls()).toBe(1);
    expect(join.replayLoads()).toBe(0);
    expect(store.auditEvents.at(-1)).toMatchObject({
      action: 'join-event',
      outcome: 'denied',
      facilityId: IDS.facility,
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
    });
  });

  test('rejects agent and system attempts at a staff-protected action and audits the human-only boundary', async () => {
    const attempts = [
      {
        name: 'agent',
        actor: AGENT_ACTOR,
        source: 'mcp' as const,
        transport: { kind: 'mcp-tool-call' as const },
      },
      {
        name: 'system',
        actor: SYSTEM_ACTOR,
        source: 'scheduled-job' as const,
        transport: { kind: 'scheduled-execution' as const },
      },
    ];

    for (const [index, attempt] of attempts.entries()) {
      const store = new MemoryCapabilityStore();
      const close = createCloseRegistration();
      const requestId = uuid(110 + index);
      const invocation: TrustedCapabilityInvocation = {
        actor: attempt.actor,
        source: attempt.source,
        scope: DISTRICT_SCOPE,
        requestId,
        serverTime: new Date(TIMES.execution),
        connectivityEpochId: null,
        mutation: {
          idempotencyKey: `${attempt.name}-close-key-0001`,
          transport: attempt.transport,
          humanConfirmationId: null,
        },
      };

      const error = await captureEngineError(() =>
        executeCapability(
          close.registration,
          { eventId: IDS.event },
          invocation,
          store,
        ),
      );

      expect(error).toMatchObject({
        code: 'FORBIDDEN',
        reasonCode: 'HUMAN_ONLY_REQUIRED',
        status: 403,
      });
      expect(close.handlerCalls()).toBe(0);
      expect(store.auditEvents).toEqual([
        expect.objectContaining({
          action: 'close-event',
          actionIds: ['close-real-event'],
          category: 'human-only-rejection',
          outcome: 'denied',
          actor: attempt.actor,
          requestId,
          reasonCode: 'HUMAN_ONLY_REQUIRED',
        }),
      ]);
    }
  });

  test('rejects missing, mismatched, expired, and consumed confirmations before the handler', async () => {
    const cases: readonly Readonly<{
      name: string;
      confirmationId: string | null;
      record: HumanConfirmationRecord | null;
      reasonCode:
        | 'CONFIRMATION_REQUIRED'
        | 'CONFIRMATION_INVALID'
        | 'CONFIRMATION_ALREADY_USED';
    }>[] = [
      {
        name: 'missing',
        confirmationId: null,
        record: null,
        reasonCode: 'CONFIRMATION_REQUIRED',
      },
      {
        name: 'mismatched',
        confirmationId: IDS.closeConfirmation,
        record: issuedCloseConfirmation({
          consequenceDigest: 'd'.repeat(64),
        }),
        reasonCode: 'CONFIRMATION_INVALID',
      },
      {
        name: 'expired',
        confirmationId: IDS.closeConfirmation,
        record: issuedCloseConfirmation({
          issuedAt: TIMES.expiredConfirmationIssued,
          expiresAt: TIMES.expiredConfirmationExpires,
        }),
        reasonCode: 'CONFIRMATION_INVALID',
      },
      {
        name: 'consumed',
        confirmationId: IDS.closeConfirmation,
        record: consumedCloseConfirmation(),
        reasonCode: 'CONFIRMATION_ALREADY_USED',
      },
    ];

    for (const [index, fixture] of cases.entries()) {
      const store = new MemoryCapabilityStore();
      if (fixture.record !== null) {
        store.seedConfirmation(fixture.record);
      }
      const close = createCloseRegistration();
      const error = await captureEngineError(() =>
        executeCapability(
          close.registration,
          { eventId: IDS.event },
          humanMutationInvocation({
            requestId: uuid(120 + index),
            idempotencyKey: `human-close-${fixture.name}-key-0001`,
            humanConfirmationId: fixture.confirmationId,
          }),
          store,
        ),
      );

      expect(error.reasonCode).toBe(fixture.reasonCode);
      expect(close.handlerCalls()).toBe(0);
    }
  });

  test('rechecks confirmation expiry against the authoritative transaction clock after lock waits', async () => {
    const store = new MemoryCapabilityStore();
    store.seedConfirmation(issuedCloseConfirmation());
    store.setCurrentTime(new Date('2026-08-08T16:05:00.000Z'));
    const close = createCloseRegistration();

    const error = await captureEngineError(() =>
      executeCapability(
        close.registration,
        { eventId: IDS.event },
        humanMutationInvocation({
          requestId: uuid(129),
          idempotencyKey: 'human-close-lock-expiry-key-0001',
          humanConfirmationId: IDS.closeConfirmation,
          serverTime: new Date(TIMES.execution),
        }),
        store,
      ),
    );

    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CONFIRMATION_INVALID',
      status: 403,
    });
    expect(close.handlerCalls()).toBe(0);
    expect(store.getConfirmation(IDS.closeConfirmation)?.status).toBe('issued');
  });

  test('consumes confirmation and atomically records protected success audit evidence', async () => {
    const store = new MemoryCapabilityStore();
    store.seedConfirmation(issuedCloseConfirmation());
    const close = createCloseRegistration();
    const requestId = uuid(130);

    const output = await executeCapability(
      close.registration,
      { eventId: IDS.event },
      humanMutationInvocation({
        requestId,
        idempotencyKey: 'human-close-success-key-0001',
        humanConfirmationId: IDS.closeConfirmation,
      }),
      store,
    );

    expect(output.transition.transition).toBe('close');
    expect(close.handlerCalls()).toBe(1);
    expect(store.getConfirmation(IDS.closeConfirmation)).toMatchObject({
      status: 'consumed',
      consumedAt: TIMES.execution,
      consumedForRequestId: requestId,
      expiredAt: null,
    });
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        action: 'close-event',
        actionIds: ['close-real-event'],
        category: 'capability-execution',
        confirmationId: IDS.closeConfirmation,
        outcome: 'success',
        actor: HUMAN_ACTOR,
        facilityId: IDS.facility,
        requestId,
        reasonCode: null,
      }),
    ]);
  });
});
