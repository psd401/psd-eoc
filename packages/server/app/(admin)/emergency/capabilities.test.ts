import { describe, expect, test } from 'bun:test';

import type {
  Actor,
  FanoutControlEffectiveState,
  FanoutControlRecord,
  SecurityAuditTarget,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  executeCapability,
  type CapabilityAuditEvent,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
  type TrustedCapabilityInvocation,
} from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  executeAdminMutationCapability,
  executeAdminQueryCapability,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminQueryDatabase,
} from '../facilities/admin-core';
import {
  createGetFanoutControlRegistration,
  createSetFanoutControlRegistration,
} from './capabilities';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  adminUser: uuid(1),
  adminSession: uuid(2),
  staffUser: uuid(3),
  staffSession: uuid(4),
  connectivityEpoch: uuid(5),
  record: uuid(6),
  enableEpoch: uuid(7),
  firstRequest: uuid(8),
  replayRequest: uuid(9),
  mismatchRequest: uuid(10),
  agent: uuid(11),
  apiKey: uuid(12),
});

const NOW = new Date('2026-08-13T16:00:00.000Z');

function authenticatedSession(
  input: Readonly<{
    source: 'web' | 'mobile';
    role: 'admin' | 'staff';
  }>,
): AuthenticatedSession {
  const isAdmin = input.role === 'admin';
  return {
    actor: {
      kind: 'human',
      userId: isAdmin ? IDS.adminUser : IDS.staffUser,
      sessionId: isAdmin ? IDS.adminSession : IDS.staffSession,
    },
    source: input.source,
    roles: [input.role],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: IDS.connectivityEpoch } },
  } as unknown as AuthenticatedSession;
}

interface MemoryIdempotencyRecord {
  readonly id: string;
  readonly requestDigest: string;
  status: 'in-progress' | 'completed';
  resultReference: string | null;
}

interface MemoryState {
  readonly idempotency: Map<string, MemoryIdempotencyRecord>;
  readonly audits: CapabilityAuditEvent[];
  nextRecordNumber: number;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    idempotency: new Map(
      [...state.idempotency].map(([key, record]) => [key, { ...record }]),
    ),
    audits: [...state.audits],
    nextRecordNumber: state.nextRecordNumber,
  };
}

function idempotencyScope(input: ClaimIdempotencyInput): string {
  return `${input.capabilityId}:${input.principalDigest}:${input.key}`;
}

class MemoryAdminTransaction implements AdminCapabilityTransaction {
  public readonly database: AdminQueryDatabase;

  public constructor(
    private readonly state: MemoryState,
    private readonly authenticated: AuthenticatedSession,
    private readonly metrics: {
      databaseReads: number;
      currentTimeReads: number;
    },
  ) {
    this.database = new Proxy(
      {},
      {
        get: () => {
          this.metrics.databaseReads += 1;
          throw new Error('The capability reached unexpected database access.');
        },
      },
    ) as AdminQueryDatabase;
  }

  public assertAuditRequestAvailable(requestId: string): Promise<void> {
    if (this.state.audits.some((event) => event.requestId === requestId)) {
      throw new AdminCapabilityError(
        'CONFLICT',
        'The request identifier has already been used.',
        409,
      );
    }
    return Promise.resolve();
  }

  public requireAdministrator(actor: Actor): void {
    if (
      actor.kind !== 'human' ||
      actor.userId !== this.authenticated.actor.userId ||
      actor.sessionId !== this.authenticated.actor.sessionId ||
      this.authenticated.source !== 'web' ||
      !this.authenticated.roles.includes('admin') ||
      this.authenticated.scope.facilityScope.kind !== 'district'
    ) {
      throw new AdminCapabilityError(
        'FORBIDDEN',
        'District administrator access is required.',
        403,
      );
    }
  }

  public setAuditTarget(target: SecurityAuditTarget): void {
    void target;
  }

  public readCurrentTime(): Promise<Date> {
    this.metrics.currentTimeReads += 1;
    return Promise.resolve(NOW);
  }

  public claimIdempotency(
    input: ClaimIdempotencyInput,
  ): Promise<IdempotencyClaim> {
    const key = idempotencyScope(input);
    const existing = this.state.idempotency.get(key);
    if (existing !== undefined) {
      if (existing.status === 'in-progress') {
        return Promise.resolve({
          kind: 'in-progress',
          requestDigest: existing.requestDigest,
        });
      }
      if (existing.resultReference === null) {
        throw new Error('Completed idempotency result is missing.');
      }
      return Promise.resolve({
        kind: 'completed',
        requestDigest: existing.requestDigest,
        resultReference: existing.resultReference,
      });
    }
    const id = uuid(100 + this.state.nextRecordNumber);
    this.state.nextRecordNumber += 1;
    this.state.idempotency.set(key, {
      id,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      resultReference: null,
    });
    return Promise.resolve({ kind: 'new', recordId: id });
  }

  public completeIdempotency(input: CompleteIdempotencyInput): Promise<void> {
    const record = [...this.state.idempotency.values()].find(
      ({ id }) => id === input.recordId,
    );
    if (record === undefined || record.status !== 'in-progress') {
      throw new Error('Idempotency result was not reserved.');
    }
    record.status = 'completed';
    record.resultReference = input.resultReference;
    return Promise.resolve();
  }

  public getHumanConfirmation(): Promise<null> {
    return Promise.resolve(null);
  }

  public consumeHumanConfirmation(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public appendCapabilityAudit(event: CapabilityAuditEvent): Promise<void> {
    if (
      this.state.audits.some(({ requestId }) => requestId === event.requestId)
    ) {
      if (event.outcome === 'success') {
        throw new AdminCapabilityError(
          'CONFLICT',
          'The request identifier has already been used.',
          409,
        );
      }
      return Promise.resolve();
    }
    this.state.audits.push(event);
    return Promise.resolve();
  }
}

class MemoryAdminStore implements AdminCapabilityStore {
  private state: MemoryState = {
    idempotency: new Map(),
    audits: [],
    nextRecordNumber: 1,
  };

  private readonly metrics = { databaseReads: 0, currentTimeReads: 0 };

  public constructor(private readonly authenticated: AuthenticatedSession) {}

  public async transaction<Result>(
    operation: (transaction: AdminCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    const candidate = cloneState(this.state);
    const result = await operation(
      new MemoryAdminTransaction(candidate, this.authenticated, this.metrics),
    );
    this.state = candidate;
    return result;
  }

  public appendCapabilityAudit(event: CapabilityAuditEvent): Promise<void> {
    if (
      !this.state.audits.some(({ requestId }) => requestId === event.requestId)
    ) {
      this.state.audits.push(event);
    }
    return Promise.resolve();
  }

  public get auditEvents(): readonly CapabilityAuditEvent[] {
    return this.state.audits;
  }

  public get databaseReads(): number {
    return this.metrics.databaseReads;
  }

  public get currentTimeReads(): number {
    return this.metrics.currentTimeReads;
  }
}

async function captureCapabilityError(
  operation: () => Promise<unknown>,
): Promise<CapabilityEngineError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityEngineError);
    return error as CapabilityEngineError;
  }
  throw new Error('Expected the capability to fail.');
}

const ENABLED_RECORD: FanoutControlRecord = Object.freeze({
  id: IDS.record,
  revision: 1,
  previousRecordId: null,
  mode: 'enabled',
  enableEpochId: IDS.enableEpoch,
  reason: 'Restore fan-out after synthetic recovery verification.',
  productOwnerApprovalReference: 'synthetic-po-authorization-2026-08-13-01',
  changedByUserId: IDS.adminUser,
  changedWithSessionId: IDS.adminSession,
  changedAt: NOW.toISOString(),
  requestId: IDS.firstRequest,
});

const ENABLED_STATE: FanoutControlEffectiveState = Object.freeze({
  kind: 'current',
  effectiveMode: 'enabled',
  currentEpochId: IDS.enableEpoch,
  currentRecord: ENABLED_RECORD,
});

describe('emergency fan-out admin capability boundary', () => {
  test('exposes full provenance only to a district-admin web session and denies staff, mobile, and agents before its read handler', async () => {
    let readHandlerCalls = 0;
    const registration = createGetFanoutControlRegistration({
      readEffectiveState: () => {
        readHandlerCalls += 1;
        return Promise.resolve(ENABLED_STATE);
      },
    });
    const adminWeb = authenticatedSession({ source: 'web', role: 'admin' });
    const adminStore = new MemoryAdminStore(adminWeb);
    const result = await executeAdminQueryCapability(
      registration,
      {},
      adminWeb,
      adminStore,
      { requestId: uuid(20), now: NOW },
    );

    expect(result).toEqual(ENABLED_STATE);
    expect(result.currentRecord).toMatchObject({
      productOwnerApprovalReference:
        ENABLED_RECORD.productOwnerApprovalReference,
      changedByUserId: IDS.adminUser,
      changedWithSessionId: IDS.adminSession,
      requestId: IDS.firstRequest,
    });

    const staffWeb = authenticatedSession({ source: 'web', role: 'staff' });
    const staffStore = new MemoryAdminStore(staffWeb);
    const staffError = await captureCapabilityError(() =>
      executeAdminQueryCapability(registration, {}, staffWeb, staffStore, {
        requestId: uuid(21),
        now: NOW,
      }),
    );

    const adminMobile = authenticatedSession({
      source: 'mobile',
      role: 'admin',
    });
    const mobileStore = new MemoryAdminStore(adminMobile);
    const mobileError = await captureCapabilityError(() =>
      executeAdminQueryCapability(registration, {}, adminMobile, mobileStore, {
        requestId: uuid(22),
        now: NOW,
      }),
    );

    const agentStore = new MemoryAdminStore(adminWeb);
    const agentInvocation: TrustedCapabilityInvocation = {
      actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
      source: 'mcp',
      scope: { facilityScope: { kind: 'district' } },
      requestId: uuid(23),
      serverTime: NOW,
      connectivityEpochId: null,
      mutation: null,
    };
    const agentError = await captureCapabilityError(() =>
      executeCapability(registration, {}, agentInvocation, agentStore),
    );

    expect(staffError).toMatchObject({ status: 403 });
    expect(mobileError).toMatchObject({
      status: 403,
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
    });
    expect(agentError).toMatchObject({
      status: 403,
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
    });
    expect(readHandlerCalls).toBe(1);
    expect(adminStore.databaseReads).toBe(0);
    expect(staffStore.databaseReads).toBe(0);
    expect(mobileStore.databaseReads).toBe(0);
    expect(agentStore.databaseReads).toBe(0);
    expect(staffStore.auditEvents[0]).toMatchObject({
      action: 'get-fanout-control',
      outcome: 'denied',
    });
    expect(mobileStore.auditEvents[0]).toMatchObject({
      action: 'get-fanout-control',
      outcome: 'denied',
    });
    expect(agentStore.auditEvents[0]).toMatchObject({
      action: 'get-fanout-control',
      outcome: 'denied',
    });
  });

  test('replays the exact original set result without appending or re-reading freshness and conflicts on changed input', async () => {
    const authenticated = authenticatedSession({
      source: 'web',
      role: 'admin',
    });
    const store = new MemoryAdminStore(authenticated);
    let appendCalls = 0;
    let replayLoads = 0;
    const registration = createSetFanoutControlRegistration({
      appendRecord: (input) => {
        appendCalls += 1;
        expect(input).toMatchObject({
          requestId: IDS.firstRequest,
          expectedCurrentRecordId: null,
          desiredMode: 'enabled',
          productOwnerApprovalReference:
            ENABLED_RECORD.productOwnerApprovalReference,
          changedAt: NOW,
        });
        return Promise.resolve(ENABLED_RECORD);
      },
      loadRecordById: (_database, recordId) => {
        replayLoads += 1;
        expect(recordId).toBe(IDS.record);
        return Promise.resolve(ENABLED_RECORD);
      },
    });
    const command = {
      expectedCurrentRecordId: null,
      desiredMode: 'enabled',
      reason: ENABLED_RECORD.reason,
      productOwnerApprovalReference: 'synthetic-po-authorization-2026-08-13-01',
    } as const;
    const idempotencyKey = 'issue-34-fanout-enable-replay-0001';

    const first = await executeAdminMutationCapability(
      registration,
      command,
      authenticated,
      store,
      {
        idempotencyKey,
        requestId: IDS.firstRequest,
        now: NOW,
      },
    );
    const replay = await executeAdminMutationCapability(
      registration,
      command,
      authenticated,
      store,
      {
        idempotencyKey,
        requestId: IDS.replayRequest,
        now: new Date('2026-08-13T16:05:00.000Z'),
      },
    );
    const mismatch = await captureCapabilityError(() =>
      executeAdminMutationCapability(
        registration,
        { ...command, reason: 'A different requested transition.' },
        authenticated,
        store,
        {
          idempotencyKey,
          requestId: IDS.mismatchRequest,
          now: new Date('2026-08-13T16:10:00.000Z'),
        },
      ),
    );

    expect(first.appendedRecord).toEqual(ENABLED_RECORD);
    expect(replay).toEqual(first);
    expect(replay.appendedRecord).toEqual(ENABLED_RECORD);
    expect(mismatch).toMatchObject({
      status: 409,
      reasonCode: 'IDEMPOTENCY_REQUEST_MISMATCH',
    });
    expect(appendCalls).toBe(1);
    expect(replayLoads).toBe(1);
    expect(store.currentTimeReads).toBe(1);
    expect(store.databaseReads).toBe(0);
    expect(
      store.auditEvents.map(({ requestId, outcome, reasonCode }) => ({
        requestId,
        outcome,
        reasonCode,
      })),
    ).toEqual([
      { requestId: IDS.firstRequest, outcome: 'success', reasonCode: null },
      { requestId: IDS.replayRequest, outcome: 'success', reasonCode: null },
      {
        requestId: IDS.mismatchRequest,
        outcome: 'failure',
        reasonCode: 'IDEMPOTENCY_REQUEST_MISMATCH',
      },
    ]);
  });
});
