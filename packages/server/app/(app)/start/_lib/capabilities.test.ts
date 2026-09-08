import { describe, expect, test } from 'bun:test';
import {
  ActivationPreviewSchema,
  FacilityPageSchema,
  ThreatPageSchema,
  type ActivationPreview,
  type CapabilityInput,
  type CapabilityScope,
  type FacilityPage,
  type ThreatPage,
} from '@psd-eoc/contracts';

import {
  CapabilityEngineError,
  type CapabilityAuditEvent,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  executeStartFlowCapability,
  type StartFlowCapabilityStore,
  type StartFlowCapabilityTransaction,
} from '../../../../lib/capabilities/start';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  facility: uuid(1),
  otherFacility: uuid(2),
  user: uuid(3),
  session: uuid(4),
  connectivityEpoch: uuid(5),
  requestList: uuid(6),
  requestPreview: uuid(7),
  requestDenied: uuid(8),
  eventTypeVersion: uuid(9),
  rosterSnapshot: uuid(10),
  audience: uuid(11),
  preview: uuid(12),
  threat: uuid(13),
});

const NOW = new Date('2026-08-10T17:00:00.000Z');
const EXPIRES_AT = '2026-08-10T17:05:00.000Z';

const FACILITY_PAGE = FacilityPageSchema.parse({
  items: [
    {
      id: IDS.facility,
      code: 'HARBOR',
      name: 'Harbor Ridge High School',
      active: true,
      createdAt: NOW.toISOString(),
    },
  ],
  pageInfo: { hasMore: false, nextCursor: null },
});

const PREVIEW = ActivationPreviewSchema.parse({
  id: IDS.preview,
  facilityId: IDS.facility,
  kind: 'drill',
  templateMode: 'drill',
  eventTypeVersion: {
    id: IDS.eventTypeVersion,
    templateMode: 'drill',
  },
  rosterSnapshotId: IDS.rosterSnapshot,
  rosterPopulation: 'synthetic',
  recipientCount: 2,
  channels: [
    {
      channel: 'push',
      endpointCount: 2,
      renderedMessage: {
        channel: 'push',
        eventKind: 'drill',
        templateMode: 'drill',
        purpose: 'activation',
        classificationMarker: 'DRILL',
        title: '[DRILL] DRILL - TRAINING ONLY - ACTIVATION: Test [DRILL]',
        body: '[DRILL] DRILL - TRAINING ONLY - ACTIVATION: Test [DRILL]',
      },
      integrationId: 'expo-push',
    },
    {
      channel: 'email',
      endpointCount: 2,
      renderedMessage: {
        channel: 'email',
        eventKind: 'drill',
        templateMode: 'drill',
        purpose: 'activation',
        classificationMarker: 'DRILL',
        subject: '[DRILL] DRILL - TRAINING ONLY - ACTIVATION: Test [DRILL]',
        textBody: '[DRILL] DRILL - TRAINING ONLY - ACTIVATION: Test [DRILL]',
      },
      integrationId: 'ses-email',
    },
  ],
  sendReadiness: 'ready',
  blockingReasonCodes: [],
  threat: { id: IDS.threat, name: 'Wildlife', detail: null },
  responseDetail: null,
  activeEventIds: [],
  consequenceDigest: 'a'.repeat(64),
  createdAt: NOW.toISOString(),
  expiresAt: EXPIRES_AT,
});

const DISTRICT_SCOPE = Object.freeze({
  facilityScope: { kind: 'district' as const },
}) satisfies CapabilityScope;

function invocation(
  requestId: string,
  scope: CapabilityScope = DISTRICT_SCOPE,
): TrustedCapabilityInvocation {
  return {
    actor: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    source: 'web',
    scope,
    requestId,
    serverTime: NOW,
    connectivityEpochId: IDS.connectivityEpoch,
    mutation: null,
  };
}

const THREAT_PAGE: ThreatPage = ThreatPageSchema.parse({
  items: [
    {
      id: '00000000-0000-4000-8000-00000000a001',
      key: 'wildlife',
      name: 'Wildlife',
      sortOrder: 0,
      requiresDetail: false,
      active: true,
      createdAt: '2026-08-10T15:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-00000000a002',
      key: 'other',
      name: 'Other',
      sortOrder: 1,
      requiresDetail: true,
      active: true,
      createdAt: '2026-08-10T15:00:00.000Z',
    },
  ],
  pageInfo: { hasMore: false, nextCursor: null },
});

class MemoryStartFlowStore implements StartFlowCapabilityStore {
  public readonly transactionAudits: CapabilityAuditEvent[] = [];
  public readonly failureAudits: CapabilityAuditEvent[] = [];
  public readonly facilityCalls: Array<
    Readonly<{
      input: CapabilityInput<'list-facilities'>;
      scope: CapabilityScope;
    }>
  > = [];
  public readonly threatCalls: CapabilityInput<'list-threats'>[] = [];
  public readonly previewCalls: Array<
    Readonly<{
      input: CapabilityInput<'create-activation-preview'>;
      at: Date;
    }>
  > = [];

  private readonly transactionValue: StartFlowCapabilityTransaction = {
    readCurrentTime: async () => NOW,
    claimIdempotency: async () => {
      throw new Error('Query store cannot claim idempotency.');
    },
    completeIdempotency: async () => {
      throw new Error('Query store cannot complete idempotency.');
    },
    getHumanConfirmation: async () => {
      throw new Error('Query store cannot load confirmation.');
    },
    consumeHumanConfirmation: async () => {
      throw new Error('Query store cannot consume confirmation.');
    },
    appendCapabilityAudit: async (event) => {
      this.transactionAudits.push(event);
    },
    listFacilities: async (input, scope): Promise<FacilityPage> => {
      this.facilityCalls.push({ input, scope });
      return FACILITY_PAGE;
    },
    listThreats: async (input): Promise<ThreatPage> => {
      this.threatCalls.push(input);
      return THREAT_PAGE;
    },
    createActivationPreview: async (
      input,
      actor,
      at,
    ): Promise<ActivationPreview> => {
      void actor;
      this.previewCalls.push({ input, at });
      return PREVIEW;
    },
  };

  public transaction<Result>(
    operation: (transaction: StartFlowCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation(this.transactionValue);
  }

  public async appendCapabilityAudit(
    event: CapabilityAuditEvent,
  ): Promise<void> {
    this.failureAudits.push(event);
  }
}

async function captureEngineError(
  operation: () => Promise<unknown>,
): Promise<CapabilityEngineError> {
  try {
    await operation();
    throw new Error('Expected capability execution to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityEngineError);
    return error as CapabilityEngineError;
  }
}

describe('start-flow canonical capability execution', () => {
  test('lists facilities through authorization and append-only success audit', async () => {
    const store = new MemoryStartFlowStore();

    const output = await executeStartFlowCapability(
      'list-facilities',
      { includeInactive: false, cursor: null, limit: 25 },
      invocation(IDS.requestList),
      store,
    );

    expect(output).toEqual(FACILITY_PAGE);
    expect(store.facilityCalls).toHaveLength(1);
    expect(store.transactionAudits).toHaveLength(1);
    expect(store.transactionAudits[0]).toMatchObject({
      action: 'list-facilities',
      outcome: 'success',
      facilityId: null,
      requestId: IDS.requestList,
    });
    expect(store.failureAudits).toEqual([]);
  });

  test('lists threats without a facility scope and with a success audit', async () => {
    const store = new MemoryStartFlowStore();

    const output = await executeStartFlowCapability(
      'list-threats',
      { includeInactive: false, cursor: null, limit: 25 },
      invocation(IDS.requestList),
      store,
    );

    expect(output).toEqual(THREAT_PAGE);
    expect(store.threatCalls).toEqual([
      { includeInactive: false, cursor: null, limit: 25 },
    ]);
    expect(store.transactionAudits).toHaveLength(1);
    expect(store.transactionAudits[0]).toMatchObject({
      action: 'list-threats',
      outcome: 'success',
      facilityId: null,
      requestId: IDS.requestList,
    });
    expect(store.failureAudits).toEqual([]);
  });

  test('refuses a threat query the contract does not allow', async () => {
    const store = new MemoryStartFlowStore();

    const error = await captureEngineError(() =>
      executeStartFlowCapability(
        'list-threats',
        { includeInactive: false, cursor: null, limit: 201 } as never,
        invocation(IDS.requestList),
        store,
      ),
    );

    expect(error.status).toBe(400);
    expect(store.threatCalls).toEqual([]);
  });

  test('creates the preview through authoritative time and success audit', async () => {
    const store = new MemoryStartFlowStore();

    const output = await executeStartFlowCapability(
      'create-activation-preview',
      {
        facilityId: IDS.facility,
        kind: 'drill',
        templateMode: 'drill',
        eventTypeVersion: {
          id: IDS.eventTypeVersion,
          templateMode: 'drill',
        },
        rosterPopulation: 'synthetic',
        threatId: IDS.threat,
        threatDetail: null,
        responseDetail: null,
      },
      invocation(IDS.requestPreview),
      store,
    );

    expect(output).toEqual(PREVIEW);
    expect(store.previewCalls).toHaveLength(1);
    expect(store.previewCalls[0]?.at).toEqual(NOW);
    expect(store.transactionAudits[0]).toMatchObject({
      action: 'create-activation-preview',
      outcome: 'success',
      facilityId: IDS.facility,
      requestId: IDS.requestPreview,
    });
    expect(store.failureAudits).toEqual([]);
  });

  test('denies out-of-scope preview before reading consequence details and audits it', async () => {
    const store = new MemoryStartFlowStore();
    const error = await captureEngineError(() =>
      executeStartFlowCapability(
        'create-activation-preview',
        {
          facilityId: IDS.facility,
          kind: 'drill',
          templateMode: 'drill',
          eventTypeVersion: {
            id: IDS.eventTypeVersion,
            templateMode: 'drill',
          },
          rosterPopulation: 'synthetic',
          threatId: IDS.threat,
          threatDetail: null,
          responseDetail: null,
        },
        invocation(IDS.requestDenied, {
          facilityScope: {
            kind: 'facilities',
            facilityIds: [IDS.otherFacility],
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
    expect(store.previewCalls).toEqual([]);
    expect(store.transactionAudits).toEqual([]);
    expect(store.failureAudits).toHaveLength(1);
    expect(store.failureAudits[0]).toMatchObject({
      action: 'create-activation-preview',
      outcome: 'denied',
      facilityId: IDS.facility,
      requestId: IDS.requestDenied,
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
    });
  });
});
