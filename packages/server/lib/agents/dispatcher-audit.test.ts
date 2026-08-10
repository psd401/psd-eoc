import { describe, expect, test } from 'bun:test';

import {
  CAPABILITY_CATALOG,
  type AgentGrantableCapabilityId,
  type FacilityScope,
} from '@psd-eoc/contracts';

import type { EventTypeStore } from '../capabilities/event-types';
import type { EventCapabilityRuntime } from '../capabilities/events';
import { AGENT_DEPLOYED_CAPABILITY_IDS } from './availability';
import {
  createDefaultAgentCapabilityDispatcher,
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
    eventTypes,
    preparedActivations: unavailableDependency,
    securityAudit: unavailableDependency,
  };
  return createDefaultAgentCapabilityDispatcher(dependencies);
}

function dispatcherWithEvents(events: EventCapabilityRuntime) {
  const unavailableDependency = undefined as never;
  const dependencies: DefaultAgentCapabilityDispatcherDependencies = {
    events,
    eventTypes: new StubEventTypeStore(),
    preparedActivations: unavailableDependency,
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

  test('denies a staff-targeting close before the canonical mutation runs', async () => {
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
        if (capabilityId === 'get-event') {
          return { rosterPopulation: 'staff' };
        }
        throw new Error('The close mutation must not run for a staff roster.');
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
      capabilityId: 'get-event',
      invocation: {
        actor: authenticated.actor,
        scope: authenticated.scope,
        mutation: null,
      },
    });
    expect(calls[0]?.invocation.requestId).not.toBe(closeInvocation.requestId);
  });

  test('allows a synthetic close to continue through the canonical mutation', async () => {
    const calls: string[] = [];
    const expected = { synthetic: 'close-result' };
    const events = {
      async execute(capabilityId: string) {
        calls.push(capabilityId);
        return capabilityId === 'get-event'
          ? { rosterPopulation: 'synthetic' }
          : expected;
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
    expect(calls).toEqual(['get-event', 'close-event']);
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
      ['list-journal-entries'],
    );

    await expect(
      dispatcher(new StubEventTypeStore()).execute(
        'list-journal-entries',
        { eventId: IDS.request, cursor: null, limit: 25 },
        invocation(authenticated),
        authenticated,
      ),
    ).rejects.toMatchObject({
      capabilityId: 'list-journal-entries',
      code: 'INTERNAL_ERROR',
      status: 503,
      retryable: false,
    });
  });
});
