import { describe, expect, test } from 'bun:test';

import {
  HUMAN_ONLY_ACTION_IDS,
  type CapabilityInput,
  type CapabilityOutput,
  type CapabilitySafetyResolution,
  type HumanOnlyActionId,
} from '@psd-eoc/contracts';

import {
  executeAuditedCapabilityTransaction,
  type CapabilityEngineError,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000001',
  apiKey: '00000000-0000-4000-8000-000000000002',
  request: '00000000-0000-4000-8000-000000000003',
  facility: '00000000-0000-4000-8000-000000000004',
  preview: '00000000-0000-4000-8000-000000000005',
  event: '00000000-0000-4000-8000-000000000006',
});

type ProtectedCapabilityId = 'start-event' | 'all-clear-event' | 'close-event';

interface ProtectedCase<Id extends ProtectedCapabilityId> {
  readonly actionId: HumanOnlyActionId;
  readonly capabilityId: Id;
  readonly input: CapabilityInput<Id>;
  readonly safety: CapabilitySafetyResolution;
}

class DenialTransaction implements CapabilityEngineTransaction {
  public readonly audits: CapabilityAuditEvent[] = [];

  public async readCurrentTime(requestReceivedAt: Date): Promise<Date> {
    return requestReceivedAt;
  }

  public async claimIdempotency() {
    return { kind: 'new' as const, recordId: IDS.request };
  }

  public async completeIdempotency(): Promise<void> {
    throw new Error('A human-only request must never complete idempotency.');
  }

  public async getHumanConfirmation() {
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
}

class DenialStore implements CapabilityEngineStore<DenialTransaction> {
  public readonly transactionState = new DenialTransaction();
  public readonly denialAudits: CapabilityAuditEvent[] = [];

  public async transaction<Result>(
    operation: (transaction: DenialTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this.transactionState);
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.denialAudits.push(event);
  }
}

function agentInvocation(index: number): TrustedCapabilityInvocation {
  return Object.freeze({
    actor: { kind: 'agent' as const, agentId: IDS.agent, apiKeyId: IDS.apiKey },
    source: 'agent-rest',
    scope: { facilityScope: { kind: 'district' as const } },
    requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    serverTime: new Date('2026-08-10T18:00:00.000Z'),
    connectivityEpochId: null,
    mutation: {
      idempotencyKey: `agent-human-only-${String(index).padStart(4, '0')}`,
      transport: {
        kind: 'agent-rest-command' as const,
        method: 'POST' as const,
      },
      humanConfirmationId: null,
    },
  });
}

function deniedRegistration<Id extends ProtectedCapabilityId>(
  capabilityCase: ProtectedCase<Id>,
): ServerCapabilityRegistration<Id, DenialTransaction> {
  const registration = {
    id: capabilityCase.capabilityId,
    handler: (): CapabilityOutput<Id> => {
      throw new Error('A human-only handler must never execute for an agent.');
    },
    resolveFacilityId: () => IDS.facility,
    resolveSafety: () => capabilityCase.safety,
    resultReference: () => 'unreachable',
    loadReplay: (): CapabilityOutput<Id> => {
      throw new Error('A human-only agent request must never replay.');
    },
    resolveReplayFacilityId: () => IDS.facility,
    replayFacilityId: () => IDS.facility,
  };
  return registration as ServerCapabilityRegistration<Id, DenialTransaction>;
}

const PROTECTED_CASES: readonly ProtectedCase<ProtectedCapabilityId>[] = [
  {
    actionId: 'start-real-incident',
    capabilityId: 'start-event',
    input: {
      source: 'activation-preview',
      activationPreviewId: IDS.preview,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [],
      },
    },
    safety: {
      eventKind: 'incident',
      rosterPopulation: 'staff',
      consequenceDigest: '1'.repeat(64),
    },
  },
  {
    actionId: 'send-real-notification',
    capabilityId: 'start-event',
    input: {
      source: 'activation-preview',
      activationPreviewId: IDS.preview,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [],
      },
    },
    safety: {
      eventKind: 'drill',
      rosterPopulation: 'staff',
      consequenceDigest: '2'.repeat(64),
    },
  },
  {
    actionId: 'all-clear',
    capabilityId: 'all-clear-event',
    input: { eventId: IDS.event, lifecyclePreviewId: IDS.preview },
    safety: {
      eventKind: 'incident',
      rosterPopulation: 'staff',
      consequenceDigest: '3'.repeat(64),
    },
  },
  {
    actionId: 'close-real-event',
    capabilityId: 'close-event',
    input: { eventId: IDS.event },
    safety: {
      eventKind: 'incident',
      rosterPopulation: 'staff',
      consequenceDigest: '4'.repeat(64),
    },
  },
];

describe('AGENTS.md human-only API-key enforcement', () => {
  test('covers every canonical human-only action with an explicit 403 case', () => {
    expect(PROTECTED_CASES.map(({ actionId }) => actionId).sort()).toEqual(
      [...HUMAN_ONLY_ACTION_IDS].sort(),
    );
  });

  for (const [index, capabilityCase] of PROTECTED_CASES.entries()) {
    test(`returns 403 for api-key actors attempting ${capabilityCase.actionId}`, async () => {
      const store = new DenialStore();

      await expect(
        executeAuditedCapabilityTransaction(
          deniedRegistration(capabilityCase),
          capabilityCase.input,
          agentInvocation(index + 10),
          store,
        ),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        reasonCode: 'HUMAN_ONLY_REQUIRED',
        status: 403,
      } satisfies Partial<CapabilityEngineError>);

      expect(store.transactionState.audits).toEqual([]);
      expect(store.denialAudits).toHaveLength(1);
      expect(store.denialAudits[0]).toMatchObject({
        category: 'human-only-rejection',
        action: capabilityCase.capabilityId,
        actionIds: expect.arrayContaining([capabilityCase.actionId]),
        outcome: 'denied',
        actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
        source: 'agent-rest',
        facilityId: IDS.facility,
        reasonCode: 'HUMAN_ONLY_REQUIRED',
      });
    });
  }
});
