import { describe, expect, test } from 'bun:test';

import type { Actor, Facility, SecurityAuditTarget } from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import type {
  CapabilityAuditEvent,
  ClaimIdempotencyInput,
  CompleteIdempotencyInput,
  IdempotencyClaim,
  ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  executeAdminMutationCapability,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminQueryDatabase,
} from './admin-core';
import {
  executeCreateFacilityCapability,
  executeListFacilitiesCapability,
} from './capabilities';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  user: uuid(1),
  session: uuid(2),
  connectivityEpoch: uuid(3),
  facility: uuid(4),
});

const NOW = new Date('2026-08-10T16:00:00.000Z');

function authenticatedSession(
  roles: AuthenticatedSession['roles'],
): AuthenticatedSession {
  return {
    actor: {
      kind: 'human',
      userId: IDS.user,
      sessionId: IDS.session,
    },
    source: 'web',
    roles,
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: IDS.connectivityEpoch } },
  } as AuthenticatedSession;
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
    onDatabaseRead: () => void,
  ) {
    this.database = new Proxy(
      {},
      {
        get() {
          onDatabaseRead();
          throw new Error('The capability handler reached database access.');
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

  public databaseReads = 0;

  public constructor(private readonly authenticated: AuthenticatedSession) {}

  public async transaction<Result>(
    operation: (transaction: AdminCapabilityTransaction) => Promise<Result>,
  ): Promise<Result> {
    const candidate = cloneState(this.state);
    const result = await operation(
      new MemoryAdminTransaction(candidate, this.authenticated, () => {
        this.databaseReads += 1;
      }),
    );
    this.state = candidate;
    return result;
  }

  public appendCapabilityAudit(event: CapabilityAuditEvent): Promise<void> {
    if (
      this.state.audits.some(({ requestId }) => requestId === event.requestId)
    ) {
      return Promise.resolve();
    }
    this.state.audits.push(event);
    return Promise.resolve();
  }

  public get auditEvents(): readonly CapabilityAuditEvent[] {
    return this.state.audits;
  }

  public get idempotencyRecords(): number {
    return this.state.idempotency.size;
  }
}

async function captureAdminError(
  operation: () => Promise<unknown>,
): Promise<AdminCapabilityError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminCapabilityError);
    return error as AdminCapabilityError;
  }
  throw new Error('Expected the admin capability to fail.');
}

describe('facilities admin capability boundary', () => {
  test('returns 403 and audits a non-admin query before its handler reads data', async () => {
    const authenticated = authenticatedSession(['staff']);
    const store = new MemoryAdminStore(authenticated);

    const error = await captureAdminError(() =>
      executeListFacilitiesCapability({
        authenticated,
        store,
        query: { includeInactive: true, cursor: null, limit: 20 },
        metadata: { requestId: uuid(20), now: NOW },
      }),
    );

    expect(error.status).toBe(403);
    expect(error.reasonCode).toBe('CAPABILITY_INVOCATION_DENIED');
    expect(store.databaseReads).toBe(0);
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({
      action: 'list-facilities',
      category: 'access-denial',
      outcome: 'denied',
      reasonCode: 'CAPABILITY_INVOCATION_DENIED',
    });
  });

  test('rolls back a non-admin mutation reservation and never calls persistence', async () => {
    const authenticated = authenticatedSession(['staff']);
    const store = new MemoryAdminStore(authenticated);

    const error = await captureAdminError(() =>
      executeCreateFacilityCapability({
        authenticated,
        store,
        command: { code: 'NEW-SITE', name: 'New Site' },
        metadata: {
          idempotencyKey: 'issue-26-non-admin-0001',
          requestId: uuid(21),
          now: NOW,
        },
      }),
    );

    expect(error.status).toBe(403);
    expect(store.databaseReads).toBe(0);
    expect(store.idempotencyRecords).toBe(0);
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({
      action: 'create-facility',
      category: 'access-denial',
      outcome: 'denied',
    });
  });

  test('replays idempotently and rejects request-ID reuse before a second handler call', async () => {
    const authenticated = authenticatedSession(['admin']);
    const store = new MemoryAdminStore(authenticated);
    const facility: Facility = {
      id: IDS.facility,
      code: 'NEW-SITE',
      name: 'New Site',
      active: true,
      createdAt: NOW.toISOString(),
    };
    let handlerCalls = 0;
    const registration: ServerCapabilityRegistration<
      'create-facility',
      AdminCapabilityTransaction
    > = {
      id: 'create-facility',
      resolveFacilityId: (_input, context) => {
        requireAdminCapabilityAuthorization(
          context.invocation.actor,
          context.transaction,
        );
        return null;
      },
      handler: () => {
        handlerCalls += 1;
        return facility;
      },
      resultReference: () => IDS.facility,
      loadReplay: (reference) => {
        if (reference !== IDS.facility) {
          throw new Error('Unexpected replay reference.');
        }
        return facility;
      },
      resolveReplayFacilityId: (_reference, context) => {
        requireAdminCapabilityAuthorization(
          context.invocation.actor,
          context.transaction,
        );
        return IDS.facility;
      },
      replayFacilityId: (output) => output.id,
    };
    const metadata = {
      idempotencyKey: 'issue-26-admin-replay-0001',
      now: NOW,
    } as const;

    const first = await executeAdminMutationCapability(
      registration,
      { code: 'NEW-SITE', name: 'New Site' },
      authenticated,
      store,
      { ...metadata, requestId: uuid(22) },
    );
    const replay = await executeAdminMutationCapability(
      registration,
      { code: 'NEW-SITE', name: 'New Site' },
      authenticated,
      store,
      { ...metadata, requestId: uuid(23) },
    );
    const duplicateRequestError = await captureAdminError(() =>
      executeAdminMutationCapability(
        registration,
        { code: 'NEW-SITE', name: 'New Site' },
        authenticated,
        store,
        {
          idempotencyKey: 'issue-26-admin-new-key-0002',
          requestId: uuid(22),
          now: NOW,
        },
      ),
    );

    expect(first).toEqual(facility);
    expect(replay).toEqual(facility);
    expect(duplicateRequestError.status).toBe(409);
    expect(handlerCalls).toBe(1);
    expect(store.idempotencyRecords).toBe(1);
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({
      action: 'create-facility',
      category: 'capability-execution',
      outcome: 'success',
    });
  });
});
