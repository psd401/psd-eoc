import type { CapabilityAuditEvent } from '../capabilities/engine';
import {
  DrizzleEventTypeStore,
  type EventTypeMutationMetadata,
  type EventTypeStore,
} from '../capabilities/event-types';
import type { Database } from '../../db/client';
import { createDrizzleSecurityAuditRepository } from '../audit';
import { createAgentGatewayAuditSink } from './audit';
import type { AgentGatewayAuditSink } from './gateway';

interface AgentEventTypeMutationTransaction {
  readonly eventTypes: EventTypeStore;
  readonly audit: AgentGatewayAuditSink;
}

/** Injectable transaction seam retained so rollback behavior is unit-testable. */
export interface AgentEventTypeMutationUnitOfWork {
  transaction<Result>(
    operation: (
      transaction: AgentEventTypeMutationTransaction,
    ) => Promise<Result>,
  ): Promise<Result>;
}

function successAudit(
  metadata: EventTypeMutationMetadata,
): CapabilityAuditEvent {
  if (metadata.actor.kind !== 'agent') {
    throw new TypeError(
      'The agent event-type store requires an authenticated agent actor.',
    );
  }
  return Object.freeze({
    category: 'agent-access',
    action: metadata.capabilityId,
    actionIds: [],
    confirmationId: null,
    outcome: 'success',
    actor: metadata.actor,
    source: 'agent-rest',
    facilityId: null,
    requestId: metadata.requestId,
    reasonCode: null,
    occurredAt: metadata.now,
  });
}

/**
 * Agent adapter around the canonical event-type store.
 *
 * Reads stay on the canonical store. Each mutation and its required security
 * audit share one outer transaction; the canonical store and audit repository
 * use nested savepoints, so an audit failure rolls back configuration and its
 * idempotency record together.
 */
export class AtomicAgentEventTypeStore implements EventTypeStore {
  public constructor(
    private readonly queries: EventTypeStore,
    private readonly mutations: AgentEventTypeMutationUnitOfWork,
  ) {}

  public readonly list: EventTypeStore['list'] = (input) =>
    this.queries.list(input);

  public readonly getVersion: EventTypeStore['getVersion'] = (input) =>
    this.queries.getVersion(input);

  public readonly getDraft: EventTypeStore['getDraft'] = (input) =>
    this.queries.getDraft(input);

  public readonly createDraft: EventTypeStore['createDraft'] = (
    input,
    metadata,
  ) =>
    this.mutations.transaction(async (transaction) => {
      const result = await transaction.eventTypes.createDraft(input, metadata);
      await transaction.audit.append(successAudit(metadata));
      return result;
    });

  public readonly updateDraft: EventTypeStore['updateDraft'] = (
    input,
    metadata,
  ) =>
    this.mutations.transaction(async (transaction) => {
      const result = await transaction.eventTypes.updateDraft(input, metadata);
      await transaction.audit.append(successAudit(metadata));
      return result;
    });

  public readonly publishVersion: EventTypeStore['publishVersion'] = (
    input,
    metadata,
  ) =>
    this.mutations.transaction(async (transaction) => {
      const result = await transaction.eventTypes.publishVersion(
        input,
        metadata,
      );
      await transaction.audit.append(successAudit(metadata));
      return result;
    });
}

function nestedTransactionDatabase(value: unknown): Database {
  // Both configured Drizzle PgTransaction implementations expose the same
  // schema-aware query surface and nested transaction/savepoint operation.
  return value as Database;
}

/** Creates the production agent store without duplicating canonical writes. */
export function createAtomicAgentEventTypeStore(
  database: Database,
): EventTypeStore {
  return new AtomicAgentEventTypeStore(new DrizzleEventTypeStore(database), {
    transaction<Result>(
      operation: (
        transaction: AgentEventTypeMutationTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) => {
        const transactionDatabase = nestedTransactionDatabase(transaction);
        return operation({
          eventTypes: new DrizzleEventTypeStore(transactionDatabase),
          audit: createAgentGatewayAuditSink(
            createDrizzleSecurityAuditRepository(transactionDatabase),
          ),
        });
      });
    },
  });
}
