import { describe, expect, test } from 'bun:test';

import type {
  CapabilityInput,
  EventPage,
  HumanConfirmationRecord,
} from '@psd-eoc/contracts';

import {
  executeEventCapability,
  type EventCapabilityStore,
  type EventCapabilityTransaction,
} from '../capabilities/events';
import type {
  CapabilityAuditEvent,
  TrustedCapabilityInvocation,
} from '../capabilities/engine';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000401',
  apiKey: '00000000-0000-4000-8000-000000000402',
  user: '00000000-0000-4000-8000-000000000403',
  session: '00000000-0000-4000-8000-000000000404',
  epoch: '00000000-0000-4000-8000-000000000405',
  facility: '00000000-0000-4000-8000-000000000406',
  otherFacility: '00000000-0000-4000-8000-000000000407',
  humanRequest: '00000000-0000-4000-8000-000000000408',
  agentRequest: '00000000-0000-4000-8000-000000000409',
});

function unexpectedCall(): never {
  throw new Error('Unexpected event persistence call.');
}

class ScopeEventStore
  implements EventCapabilityStore, EventCapabilityTransaction
{
  public readonly audits: CapabilityAuditEvent[] = [];
  public readonly observedScopes: TrustedCapabilityInvocation['scope'][] = [];

  public async transaction<Result>(
    operation: (transaction: EventCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this);
  }

  public async readCurrentTime(requestReceivedAt: Date): Promise<Date> {
    return requestReceivedAt;
  }

  public readonly claimIdempotency: EventCapabilityTransaction['claimIdempotency'] =
    async () => unexpectedCall();

  public readonly completeIdempotency: EventCapabilityTransaction['completeIdempotency'] =
    async () => unexpectedCall();

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

  public readonly resolveActivationFacilityId: EventCapabilityTransaction['resolveActivationFacilityId'] =
    async () => unexpectedCall();

  public readonly resolveActivationSource: EventCapabilityTransaction['resolveActivationSource'] =
    async () => unexpectedCall();

  public readonly resolveEventFacilityId: EventCapabilityTransaction['resolveEventFacilityId'] =
    async () => unexpectedCall();

  public readonly resolveEventForUpdate: EventCapabilityTransaction['resolveEventForUpdate'] =
    async () => unexpectedCall();

  public readonly resolveLifecyclePreview: EventCapabilityTransaction['resolveLifecyclePreview'] =
    async () => unexpectedCall();

  public readonly resolveNotificationWording: EventCapabilityTransaction['resolveNotificationWording'] =
    async () => unexpectedCall();

  public readonly getEvent: EventCapabilityTransaction['getEvent'] = async () =>
    unexpectedCall();

  public async listActiveEvents(
    input: CapabilityInput<'list-active-events'>,
    scope: TrustedCapabilityInvocation['scope'],
  ): Promise<EventPage> {
    void input;
    this.observedScopes.push(scope);
    return { items: [], pageInfo: { hasMore: false, nextCursor: null } };
  }

  public readonly persistLifecycle: EventCapabilityTransaction['persistLifecycle'] =
    async () => unexpectedCall();

  public readonly persistJoin: EventCapabilityTransaction['persistJoin'] =
    async () => unexpectedCall();

  public readonly resolveReplayFacilityId: EventCapabilityTransaction['resolveReplayFacilityId'] =
    async () => unexpectedCall();

  public readonly loadLifecycleResult: EventCapabilityTransaction['loadLifecycleResult'] =
    async () => unexpectedCall();

  public readonly loadJoinResult: EventCapabilityTransaction['loadJoinResult'] =
    async () => unexpectedCall();
}

function invocation(
  principal: 'agent' | 'human',
  facilityId: string,
): TrustedCapabilityInvocation {
  const shared = {
    scope: {
      facilityScope: {
        kind: 'facilities' as const,
        facilityIds: [facilityId],
      },
    },
    serverTime: new Date('2026-08-10T18:01:00.000Z'),
    mutation: null,
  };
  return principal === 'agent'
    ? {
        ...shared,
        actor: {
          kind: 'agent',
          agentId: IDS.agent,
          apiKeyId: IDS.apiKey,
        },
        source: 'agent-rest',
        requestId: IDS.agentRequest,
        connectivityEpochId: null,
      }
    : {
        ...shared,
        actor: {
          kind: 'human',
          userId: IDS.user,
          sessionId: IDS.session,
        },
        source: 'web',
        requestId: IDS.humanRequest,
        connectivityEpochId: IDS.epoch,
      };
}

const query = Object.freeze({
  facilityId: IDS.facility,
  cursor: null,
  limit: 25,
});

describe('agent facility scope parity', () => {
  test('passes the same in-scope facility constraint for human and agent reads', async () => {
    const store = new ScopeEventStore();
    const human = invocation('human', IDS.facility);
    const agent = invocation('agent', IDS.facility);

    const humanResult = await executeEventCapability(
      'list-active-events',
      query,
      human,
      store,
    );
    const agentResult = await executeEventCapability(
      'list-active-events',
      query,
      agent,
      store,
    );

    expect(agentResult).toEqual(humanResult);
    expect(store.observedScopes).toEqual([human.scope, agent.scope]);
    expect(store.audits).toEqual([
      expect.objectContaining({
        category: 'capability-execution',
        action: 'list-active-events',
        outcome: 'success',
        actor: human.actor,
        facilityId: IDS.facility,
      }),
      expect.objectContaining({
        category: 'agent-access',
        action: 'list-active-events',
        outcome: 'success',
        actor: agent.actor,
        facilityId: IDS.facility,
      }),
    ]);
  });

  test('denies human and agent identically before an out-of-scope read handler', async () => {
    const store = new ScopeEventStore();
    const human = invocation('human', IDS.otherFacility);
    const agent = invocation('agent', IDS.otherFacility);

    await expect(
      executeEventCapability('list-active-events', query, human, store),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
      status: 403,
    });
    await expect(
      executeEventCapability('list-active-events', query, agent, store),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
      status: 403,
    });

    expect(store.observedScopes).toEqual([]);
    expect(store.audits).toEqual([
      expect.objectContaining({
        category: 'access-denial',
        action: 'list-active-events',
        outcome: 'denied',
        actor: human.actor,
        facilityId: IDS.facility,
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
      }),
      expect.objectContaining({
        category: 'access-denial',
        action: 'list-active-events',
        outcome: 'denied',
        actor: agent.actor,
        facilityId: IDS.facility,
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
      }),
    ]);
  });
});
