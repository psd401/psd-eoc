import { describe, expect, test } from 'bun:test';

import {
  CAPABILITY_CATALOG,
  EventSchema,
  HUMAN_ONLY_ACTION_IDS,
  type AgentGrantableCapabilityId,
  type FacilityScope,
} from '@psd-eoc/contracts';

import type { EventTypeStore } from '../capabilities/event-types';
import type { StartFlowCapabilityRuntime } from '../../app/(app)/start/_lib/capabilities';
import {
  executeEventCapability,
  type EventCapabilityRuntime,
  type EventCapabilityStore,
  type EventCapabilityTransaction,
} from '../capabilities/events';
import type { CapabilityAuditEvent } from '../capabilities/engine';
import type { JournalCapabilityRuntime } from '../capabilities/journal';
import type { RecordsCapabilityRuntime } from '../capabilities/records';
import { AGENT_DEPLOYED_CAPABILITY_IDS } from './availability';
import {
  createDefaultAgentCapabilityDispatcher,
  type AgentDeliveryTestReportRuntime,
  type DefaultAgentCapabilityDispatcherDependencies,
} from './dispatcher';
import type { AuthenticatedAgentApiKey } from './keys';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000301',
  apiKey: '00000000-0000-4000-8000-000000000302',
  issuer: '00000000-0000-4000-8000-000000000303',
  facility: '00000000-0000-4000-8000-000000000304',
  request: '00000000-0000-4000-8000-000000000305',
});

class StubEventTypeStore implements EventTypeStore {
  public listCalls = 0;

  public constructor(private readonly failure: Error | null = null) {}

  public async list(): ReturnType<EventTypeStore['list']> {
    this.listCalls += 1;
    if (this.failure !== null) throw this.failure;
    return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
  }

  public readonly getVersion: EventTypeStore['getVersion'] = async () => {
    throw new Error('Unexpected getVersion call.');
  };

  public readonly getDraft: EventTypeStore['getDraft'] = async () => {
    throw new Error('Unexpected getDraft call.');
  };

  public readonly createDraft: EventTypeStore['createDraft'] = async () => {
    throw new Error('Unexpected createDraft call.');
  };

  public readonly updateDraft: EventTypeStore['updateDraft'] = async () => {
    throw new Error('Unexpected updateDraft call.');
  };

  public readonly publishVersion: EventTypeStore['publishVersion'] =
    async () => {
      throw new Error('Unexpected publishVersion call.');
    };
}

function authenticatedAgent(
  facilityScope: FacilityScope,
  capabilityIds: readonly AgentGrantableCapabilityId[],
): AuthenticatedAgentApiKey {
  return Object.freeze({
    actor: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    scope: { facilityScope },
    capabilityIds,
    key: {
      id: IDS.apiKey,
      agentId: IDS.agent,
      displayName: 'Synthetic dispatcher routing agent',
      facilityScope,
      capabilityIds,
      keyPrefix: 'abcdefghijkl',
      issuedByUserId: IDS.issuer,
      issuedAt: '2026-08-10T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    },
  });
}

function dispatcher(eventTypes: EventTypeStore) {
  const unavailableDependency = undefined as never;
  const dependencies: DefaultAgentCapabilityDispatcherDependencies = {
    events: unavailableDependency,
    journal: unavailableDependency,
    activationPreviews: unavailableDependency,
    records: unavailableDependency,
    administration: unavailableDependency,
    administrationFacilities: unavailableDependency,
    eventTypes,
    deliveryTestReports: unavailableDependency,
    preparedActivations: unavailableDependency,
    rosterReport: unavailableDependency,
    securityAudit: unavailableDependency,
  };
  return createDefaultAgentCapabilityDispatcher(dependencies);
}

function dispatcherWithEvents(events: EventCapabilityRuntime) {
  const unavailableDependency = undefined as never;
  const dependencies: DefaultAgentCapabilityDispatcherDependencies = {
    events,
    journal: unavailableDependency,
    activationPreviews: unavailableDependency,
    records: unavailableDependency,
    administration: unavailableDependency,
    administrationFacilities: unavailableDependency,
    eventTypes: new StubEventTypeStore(),
    deliveryTestReports: unavailableDependency,
    preparedActivations: unavailableDependency,
    rosterReport: unavailableDependency,
    securityAudit: unavailableDependency,
  };
  return createDefaultAgentCapabilityDispatcher(dependencies);
}

function dispatcherWithJournal(journal: JournalCapabilityRuntime) {
  const unavailableDependency = undefined as never;
  const dependencies: DefaultAgentCapabilityDispatcherDependencies = {
    events: unavailableDependency,
    journal,
    activationPreviews: unavailableDependency,
    records: unavailableDependency,
    administration: unavailableDependency,
    administrationFacilities: unavailableDependency,
    eventTypes: new StubEventTypeStore(),
    deliveryTestReports: unavailableDependency,
    preparedActivations: unavailableDependency,
    rosterReport: unavailableDependency,
    securityAudit: unavailableDependency,
  };
  return createDefaultAgentCapabilityDispatcher(dependencies);
}

function dispatcherWithActivationPreviews(
  activationPreviews: StartFlowCapabilityRuntime,
) {
  const unavailableDependency = undefined as never;
  const dependencies: DefaultAgentCapabilityDispatcherDependencies = {
    events: unavailableDependency,
    journal: unavailableDependency,
    activationPreviews,
    records: unavailableDependency,
    administration: unavailableDependency,
    administrationFacilities: unavailableDependency,
    eventTypes: new StubEventTypeStore(),
    deliveryTestReports: unavailableDependency,
    preparedActivations: unavailableDependency,
    rosterReport: unavailableDependency,
    securityAudit: unavailableDependency,
  };
  return createDefaultAgentCapabilityDispatcher(dependencies);
}

function dispatcherWithRecords(records: RecordsCapabilityRuntime) {
  const unavailableDependency = undefined as never;
  const dependencies: DefaultAgentCapabilityDispatcherDependencies = {
    events: unavailableDependency,
    journal: unavailableDependency,
    activationPreviews: unavailableDependency,
    records,
    administration: unavailableDependency,
    administrationFacilities: unavailableDependency,
    eventTypes: new StubEventTypeStore(),
    deliveryTestReports: unavailableDependency,
    preparedActivations: unavailableDependency,
    rosterReport: unavailableDependency,
    securityAudit: unavailableDependency,
  };
  return createDefaultAgentCapabilityDispatcher(dependencies);
}

function dispatcherWithDeliveryTestReports(
  deliveryTestReports: AgentDeliveryTestReportRuntime,
) {
  const unavailableDependency = undefined as never;
  const dependencies: DefaultAgentCapabilityDispatcherDependencies = {
    events: unavailableDependency,
    journal: unavailableDependency,
    activationPreviews: unavailableDependency,
    records: unavailableDependency,
    administration: unavailableDependency,
    administrationFacilities: unavailableDependency,
    eventTypes: new StubEventTypeStore(),
    deliveryTestReports,
    preparedActivations: unavailableDependency,
    rosterReport: unavailableDependency,
    securityAudit: unavailableDependency,
  };
  return createDefaultAgentCapabilityDispatcher(dependencies);
}

function invocation(authenticated: AuthenticatedAgentApiKey) {
  return {
    actor: authenticated.actor,
    source: 'agent-rest' as const,
    scope: authenticated.scope,
    requestId: IDS.request,
    serverTime: new Date('2026-08-10T18:01:00.000Z'),
    connectivityEpochId: null,
    mutation: null,
  };
}

function mutationInvocation(authenticated: AuthenticatedAgentApiKey) {
  return {
    ...invocation(authenticated),
    mutation: {
      idempotencyKey: 'synthetic-close-event-request',
      transport: {
        kind: 'agent-rest-command' as const,
        method: 'POST' as const,
      },
      humanConfirmationId: null,
    },
  };
}

describe('default agent dispatcher routing', () => {
  test('deploys only the destination-free delivery-test read to agents', () => {
    const deployedIds = new Set<string>(AGENT_DEPLOYED_CAPABILITY_IDS);
    expect(deployedIds.has('list-delivery-test-reports')).toBe(true);
    for (const protectedWorkflowId of [
      'create-delivery-test-target-set-version',
      'create-delivery-test-preview',
      'finalize-delivery-test-report',
    ]) {
      expect(deployedIds.has(protectedWorkflowId)).toBe(false);
    }
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(deployedIds.has(actionId)).toBe(false);
    }
  });

  test('keeps every deployed mutation on canonical atomic audit ownership', () => {
    const subject = dispatcher(new StubEventTypeStore());
    const deployedMutations = AGENT_DEPLOYED_CAPABILITY_IDS.filter(
      (capabilityId) =>
        CAPABILITY_CATALOG[capabilityId].operation === 'mutation',
    );

    expect(deployedMutations.length).toBeGreaterThan(0);
    expect(
      deployedMutations.map((capabilityId) => ({
        capabilityId,
        auditOwnership: subject.auditOwnership(capabilityId),
      })),
    ).toEqual(
      deployedMutations.map((capabilityId) => ({
        capabilityId,
        auditOwnership: 'canonical',
      })),
    );
  });

  test('preserves the canonical close denial without a side-door pre-read', async () => {
    const calls: Array<{
      capabilityId: string;
      invocation: ReturnType<typeof mutationInvocation>;
    }> = [];
    const events = {
      async execute(
        capabilityId: string,
        _input: unknown,
        callInvocation: never,
      ) {
        calls.push({
          capabilityId,
          invocation: callInvocation as ReturnType<typeof mutationInvocation>,
        });
        throw Object.assign(new Error('Canonical staff close denial.'), {
          code: 'FORBIDDEN',
          reasonCode: 'HUMAN_ONLY_REQUIRED',
          status: 403,
        });
      },
    } as unknown as EventCapabilityRuntime;
    const authenticated = authenticatedAgent({ kind: 'district' }, [
      'close-event',
    ]);
    const closeInvocation = mutationInvocation(authenticated);

    await expect(
      dispatcherWithEvents(events).execute(
        'close-event',
        { eventId: IDS.request },
        closeInvocation,
        authenticated,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'HUMAN_ONLY_REQUIRED',
      status: 403,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      capabilityId: 'close-event',
      invocation: {
        actor: authenticated.actor,
        scope: authenticated.scope,
        mutation: closeInvocation.mutation,
        requestId: closeInvocation.requestId,
      },
    });
  });

  test('allows a synthetic close to continue through the canonical mutation', async () => {
    const calls: string[] = [];
    const expected = { synthetic: 'close-result' };
    const events = {
      async execute(capabilityId: string) {
        calls.push(capabilityId);
        return expected;
      },
    } as unknown as EventCapabilityRuntime;
    const authenticated = authenticatedAgent({ kind: 'district' }, [
      'close-event',
    ]);

    await expect(
      dispatcherWithEvents(events).execute(
        'close-event',
        { eventId: IDS.request },
        mutationInvocation(authenticated),
        authenticated,
      ),
    ).resolves.toBe(expected);
    expect(calls).toEqual(['close-event']);
  });

  test('lets the real engine deny and audit an agent closing a staff drill', async () => {
    const event = EventSchema.parse({
      id: IDS.request,
      facilityId: IDS.facility,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: { id: IDS.issuer, templateMode: 'drill' },
      status: 'all-clear',
      rosterSnapshotId: IDS.agent,
      rosterPopulation: 'staff',
      createdBy: {
        kind: 'human',
        userId: IDS.issuer,
        sessionId: IDS.apiKey,
      },
      createdAt: '2026-08-10T17:00:00.000Z',
      activatedAt: '2026-08-10T17:01:00.000Z',
      allClearAt: '2026-08-10T17:02:00.000Z',
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: {
        kind: 'human-confirmed',
        activationPreviewId: IDS.apiKey,
        preparedActivationId: null,
        confirmationId: IDS.agent,
        consequenceDigest: 'a'.repeat(64),
        requestId: IDS.issuer,
      },
    });
    const audits: CapabilityAuditEvent[] = [];
    let persistLifecycleCalls = 0;
    const transaction = {
      async claimIdempotency() {
        return { kind: 'new' as const, recordId: IDS.apiKey };
      },
      async resolveEventFacilityId(eventId: string) {
        return eventId === event.id ? event.facilityId : null;
      },
      async resolveEventForUpdate(eventId: string) {
        return eventId === event.id
          ? { event, nextTransitionSequence: 3, nextJournalSequence: 3 }
          : null;
      },
      async persistLifecycle() {
        persistLifecycleCalls += 1;
      },
    } as unknown as EventCapabilityTransaction;
    const store: EventCapabilityStore = {
      async transaction<Result>(
        operation: (transaction: EventCapabilityTransaction) => Promise<Result>,
      ) {
        return operation(transaction);
      },
      async appendCapabilityAudit(audit) {
        audits.push(audit);
      },
    };
    const events = {
      store,
      execute: (capabilityId, input, callInvocation) =>
        executeEventCapability(capabilityId, input, callInvocation, store),
      async close() {},
    } satisfies EventCapabilityRuntime;
    const authenticated = authenticatedAgent({ kind: 'district' }, [
      'close-event',
    ]);
    const callInvocation = mutationInvocation(authenticated);

    await expect(
      dispatcherWithEvents(events).execute(
        'close-event',
        { eventId: event.id },
        callInvocation,
        authenticated,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'HUMAN_ONLY_REQUIRED',
      status: 403,
    });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'close-event',
        actionIds: [],
        actor: authenticated.actor,
        category: 'access-denial',
        facilityId: IDS.facility,
        outcome: 'denied',
        reasonCode: 'HUMAN_ONLY_REQUIRED',
        requestId: callInvocation.requestId,
      }),
    ]);
    expect(persistLifecycleCalls).toBe(0);
  });

  test('routes an implemented query through its canonical capability', async () => {
    const eventTypes = new StubEventTypeStore();
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['list-event-types'],
    );

    const result = await dispatcher(eventTypes).execute(
      'list-event-types',
      { templateMode: null, enabled: true, cursor: null, limit: 25 },
      invocation(authenticated),
      authenticated,
    );

    expect(result).toEqual({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(eventTypes.listCalls).toBe(1);
  });

  test('routes a current-main journal query through its canonical runtime', async () => {
    const calls: Array<{
      capabilityId: string;
      input: unknown;
      invocation: ReturnType<typeof invocation>;
    }> = [];
    const expected = {
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    };
    const journal = {
      async execute(
        capabilityId: string,
        input: unknown,
        callInvocation: never,
      ) {
        calls.push({
          capabilityId,
          input,
          invocation: callInvocation as ReturnType<typeof invocation>,
        });
        return expected;
      },
    } as unknown as JournalCapabilityRuntime;
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['list-journal-entries'],
    );
    const callInvocation = invocation(authenticated);
    const input = { eventId: IDS.request, cursor: null, limit: 25 };

    await expect(
      dispatcherWithJournal(journal).execute(
        'list-journal-entries',
        input,
        callInvocation,
        authenticated,
      ),
    ).resolves.toBe(expected);
    expect(calls).toEqual([
      {
        capabilityId: 'list-journal-entries',
        input,
        invocation: callInvocation,
      },
    ]);
  });

  test('routes journal search through the canonical scoped journal runtime', async () => {
    const calls: Array<{
      capabilityId: string;
      input: unknown;
      invocation: ReturnType<typeof invocation>;
    }> = [];
    const expected = {
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    };
    const journal = {
      async execute(
        capabilityId: string,
        input: unknown,
        callInvocation: never,
      ) {
        calls.push({
          capabilityId,
          input,
          invocation: callInvocation as ReturnType<typeof invocation>,
        });
        return expected;
      },
    } as unknown as JournalCapabilityRuntime;
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['search-journal-entries'],
    );
    const callInvocation = invocation(authenticated);
    const input = {
      eventId: null,
      kind: null,
      query: 'synthetic drill',
      occurredFrom: null,
      occurredThrough: null,
      cursor: null,
      limit: 25,
    };

    await expect(
      dispatcherWithJournal(journal).execute(
        'search-journal-entries',
        input,
        callInvocation,
        authenticated,
      ),
    ).resolves.toBe(expected);
    expect(calls).toEqual([
      {
        capabilityId: 'search-journal-entries',
        input,
        invocation: callInvocation,
      },
    ]);
  });

  test('routes records reads and exports through the canonical records runtime', async () => {
    const calls: Array<{
      capabilityId: string;
      input: unknown;
      invocation: ReturnType<typeof invocation>;
    }> = [];
    const expectedByCapability = {
      'list-drill-records': {
        items: [],
        pageInfo: { hasMore: false, nextCursor: null },
      },
      'export-drill-records': { synthetic: 'drill-export' },
      'export-event-summary': { synthetic: 'event-summary-export' },
    } as const;
    const records = {
      async execute(
        capabilityId: keyof typeof expectedByCapability,
        input: unknown,
        callInvocation: never,
      ) {
        calls.push({
          capabilityId,
          input,
          invocation: callInvocation as ReturnType<typeof invocation>,
        });
        return expectedByCapability[capabilityId];
      },
    } as unknown as RecordsCapabilityRuntime;
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['list-drill-records', 'export-drill-records', 'export-event-summary'],
    );
    const callInvocation = invocation(authenticated);
    const listInput = {
      facilityId: IDS.facility,
      eventTypeId: null,
      startedFrom: null,
      startedThrough: null,
      cursor: null,
      limit: 25,
    };
    const drillExportInput = {
      facilityId: IDS.facility,
      eventTypeId: null,
      startedFrom: '2026-08-01T07:00:00.000Z',
      startedThrough: '2026-08-12T06:59:59.999Z',
      format: 'csv',
    };
    const eventExportInput = { eventId: IDS.request, format: 'pdf' };

    await expect(
      dispatcherWithRecords(records).execute(
        'list-drill-records',
        listInput,
        callInvocation,
        authenticated,
      ),
    ).resolves.toBe(expectedByCapability['list-drill-records']);
    await expect(
      dispatcherWithRecords(records).execute(
        'export-drill-records',
        drillExportInput,
        callInvocation,
        authenticated,
      ),
    ).resolves.toBe(expectedByCapability['export-drill-records']);
    await expect(
      dispatcherWithRecords(records).execute(
        'export-event-summary',
        eventExportInput,
        callInvocation,
        authenticated,
      ),
    ).resolves.toBe(expectedByCapability['export-event-summary']);
    expect(calls).toEqual([
      {
        capabilityId: 'list-drill-records',
        input: listInput,
        invocation: callInvocation,
      },
      {
        capabilityId: 'export-drill-records',
        input: drillExportInput,
        invocation: callInvocation,
      },
      {
        capabilityId: 'export-event-summary',
        input: eventExportInput,
        invocation: callInvocation,
      },
    ]);
  });

  test('assigns canonical audit ownership to every deployed records capability', () => {
    const subject = dispatcherWithRecords(undefined as never);
    const capabilityIds = [
      'list-drill-records',
      'export-drill-records',
      'export-event-summary',
    ] as const satisfies readonly AgentGrantableCapabilityId[];

    expect(
      capabilityIds.map((capabilityId) => ({
        capabilityId,
        auditOwnership: subject.auditOwnership(capabilityId),
      })),
    ).toEqual([
      {
        capabilityId: 'list-drill-records',
        auditOwnership: 'canonical',
      },
      {
        capabilityId: 'export-drill-records',
        auditOwnership: 'canonical',
      },
      {
        capabilityId: 'export-event-summary',
        auditOwnership: 'canonical',
      },
    ]);
  });

  test('routes delivery-test report reads through the scoped read-only runtime', async () => {
    const calls: Array<{
      input: unknown;
      invocation: ReturnType<typeof invocation>;
      authenticated: AuthenticatedAgentApiKey;
    }> = [];
    const expected = {
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    };
    const deliveryTestReports: AgentDeliveryTestReportRuntime = {
      async execute(input, callInvocation, authenticated) {
        expect(authenticated).toBeDefined();
        calls.push({
          input,
          invocation: callInvocation as ReturnType<typeof invocation>,
          authenticated: authenticated as AuthenticatedAgentApiKey,
        });
        return expected;
      },
    };
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['list-delivery-test-reports'],
    );
    const callInvocation = invocation(authenticated);
    const input = {
      facilityId: IDS.facility,
      status: null,
      generatedFrom: null,
      generatedThrough: null,
      cursor: null,
      limit: 25,
    };

    await expect(
      dispatcherWithDeliveryTestReports(deliveryTestReports).execute(
        'list-delivery-test-reports',
        input,
        callInvocation,
        authenticated,
      ),
    ).resolves.toBe(expected);
    expect(calls).toEqual([
      { input, invocation: callInvocation, authenticated },
    ]);
    expect(
      dispatcherWithDeliveryTestReports(deliveryTestReports).auditOwnership(
        'list-delivery-test-reports',
      ),
    ).toBe('canonical');
  });

  test('routes activation preview creation before the existing prepare handoff', async () => {
    const calls: Array<{
      capabilityId: string;
      input: unknown;
      invocation: ReturnType<typeof invocation>;
    }> = [];
    const expected = { synthetic: 'activation-preview' };
    const activationPreviews = {
      async execute(
        capabilityId: string,
        input: unknown,
        callInvocation: never,
      ) {
        calls.push({
          capabilityId,
          input,
          invocation: callInvocation as ReturnType<typeof invocation>,
        });
        return expected;
      },
    } as unknown as StartFlowCapabilityRuntime;
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['create-activation-preview', 'prepare-activation'],
    );
    const callInvocation = invocation(authenticated);
    const input = {
      facilityId: IDS.facility,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: { id: IDS.issuer, templateMode: 'drill' },
      rosterPopulation: 'staff',
    };

    await expect(
      dispatcherWithActivationPreviews(activationPreviews).execute(
        'create-activation-preview',
        input,
        callInvocation,
        authenticated,
      ),
    ).resolves.toBe(expected);
    expect(calls).toEqual([
      {
        capabilityId: 'create-activation-preview',
        input,
        invocation: callInvocation,
      },
    ]);
  });

  test('preserves the authenticated scope for canonical authorization', async () => {
    const eventTypes = new StubEventTypeStore();
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['list-event-types'],
    );

    await expect(
      dispatcher(eventTypes).execute(
        'list-event-types',
        { templateMode: null, enabled: null, cursor: null, limit: 25 },
        invocation(authenticated),
        authenticated,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    expect(eventTypes.listCalls).toBe(0);
  });

  test('does not convert an implementation failure into a successful result', async () => {
    const eventTypes = new StubEventTypeStore(
      new Error('Synthetic persistence failure.'),
    );
    const authenticated = authenticatedAgent({ kind: 'district' }, [
      'list-event-types',
    ]);

    await expect(
      dispatcher(eventTypes).execute(
        'list-event-types',
        { templateMode: null, enabled: true, cursor: null, limit: 25 },
        invocation(authenticated),
        authenticated,
      ),
    ).rejects.toThrow('Synthetic persistence failure.');
  });

  test('fails closed with 503 when a catalog capability is not deployed', async () => {
    const authenticated = authenticatedAgent(
      { kind: 'facilities', facilityIds: [IDS.facility] },
      ['get-roster-snapshot'],
    );

    await expect(
      dispatcher(new StubEventTypeStore()).execute(
        'get-roster-snapshot',
        {},
        invocation(authenticated),
        authenticated,
      ),
    ).rejects.toMatchObject({
      capabilityId: 'get-roster-snapshot',
      code: 'INTERNAL_ERROR',
      status: 503,
      retryable: false,
    });
  });
});
