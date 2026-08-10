import { randomUUID } from 'node:crypto';

import {
  TimestampSchema,
  type Actor,
  type CapabilityInput,
  type CapabilityOutput,
  type RegisteredCapabilityId,
  type SecurityAuditCategory,
} from '@psd-eoc/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type PostgresDatabase,
} from '../../../db/client';
import {
  idempotencyRecords,
  securityAuditChainAnchors,
  securityAuditEntries,
} from '../../../db/schema';
import {
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  buildSecurityAuditEntry,
} from '../../../lib/audit';
import {
  CapabilityEngineError,
  executeCapability,
  resolveHumanCapabilityInvocation,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from '../../../lib/capabilities/engine';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';

/**
 * Common schema-aware query surface used by both supported Drizzle drivers.
 * No direct-driver-only operation is permitted in route-owned admin code.
 */
export type AdminQueryDatabase = PostgresDatabase;

/** Metadata every explicit administrator mutation must supply. */
export interface AdminMutationMetadata {
  readonly idempotencyKey: string;
  readonly requestId?: string;
  readonly now?: Date;
}

/** Metadata every administrator query may supply for request correlation. */
export interface AdminQueryMetadata {
  readonly requestId?: string;
  readonly now?: Date;
}

/**
 * Shared transaction exposed to route-owned admin capability registrations.
 * Raw database access is available only after registrations pass the canonical
 * capability engine and call {@link requireAdminCapabilityAuthorization} from
 * their facility resolver.
 */
export interface AdminCapabilityTransaction
  extends CapabilityEngineTransaction {
  readonly database: AdminQueryDatabase;
  assertAuditRequestAvailable(requestId: string): Promise<void>;
  requireAdministrator(actor: Actor): void;
}

/** Shared idempotency and atomic-audit store used by every admin route tree. */
export type AdminCapabilityStore =
  CapabilityEngineStore<AdminCapabilityTransaction>;

const adminStoreDatabases = new WeakMap<AdminCapabilityStore, Database>();

/** Public-safe error raised by route-owned admin capability handlers. */
export class AdminCapabilityError extends CapabilityEngineError {
  public constructor(
    code:
      | 'CONFLICT'
      | 'FORBIDDEN'
      | 'INTERNAL_ERROR'
      | 'NOT_FOUND'
      | 'VALIDATION_ERROR',
    message: string,
    status: 400 | 403 | 404 | 409 | 500,
  ) {
    super(
      code,
      code === 'FORBIDDEN'
        ? 'CAPABILITY_INVOCATION_DENIED'
        : code === 'CONFLICT'
          ? 'PERSISTENCE_CONFLICT'
          : code === 'VALIDATION_ERROR'
            ? 'MUTATION_METADATA_INVALID'
            : 'PERSISTENCE_CONFLICT',
      message,
      status,
      status >= 500,
    );
    this.name = 'AdminCapabilityError';
  }
}

function conflict(message: string): AdminCapabilityError {
  return new AdminCapabilityError('CONFLICT', message, 409);
}

function asAdminDatabase(database: unknown): AdminQueryDatabase {
  // Both configured Drizzle transports expose the schema-aware operations used
  // here. This cast avoids a union of overloaded query-builder signatures.
  return database as AdminQueryDatabase;
}

async function readDatabaseTime(database: AdminQueryDatabase): Promise<Date> {
  // Use Drizzle's selected-field result shape rather than the transport's raw
  // execute result. postgres-js returns raw rows directly, while the pinned
  // RDS Data API driver wraps raw execute rows in an AWS response object.
  const [row] = await database
    .select({
      value: sql<Date | string>`admin_database_clock.value`,
    })
    .from(sql`(select clock_timestamp() as value) as admin_database_clock`)
    .limit(1);
  if (row === undefined) {
    throw conflict('The authoritative database clock is unavailable.');
  }
  const value = row.value instanceof Date ? row.value : new Date(row.value);
  TimestampSchema.parse(value.toISOString());
  return value;
}

async function claimIdempotency(
  database: AdminQueryDatabase,
  input: ClaimIdempotencyInput,
): Promise<IdempotencyClaim> {
  const [inserted] = await database
    .insert(idempotencyRecords)
    .values({
      capabilityId: input.capabilityId,
      principal: input.actor,
      principalDigest: input.principalDigest,
      key: input.key,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.capabilityId,
        idempotencyRecords.principalDigest,
        idempotencyRecords.key,
      ],
    })
    .returning({ id: idempotencyRecords.id });
  if (inserted !== undefined) {
    return { kind: 'new', recordId: inserted.id };
  }

  const [existing] = await database
    .select({
      requestDigest: idempotencyRecords.requestDigest,
      status: idempotencyRecords.status,
      resultReference: idempotencyRecords.resultReference,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.capabilityId, input.capabilityId),
        eq(idempotencyRecords.principalDigest, input.principalDigest),
        eq(idempotencyRecords.key, input.key),
      ),
    )
    .for('update')
    .limit(1);
  if (existing === undefined) {
    throw conflict('The idempotency reservation could not be resolved.');
  }
  if (existing.status === 'completed' && existing.resultReference !== null) {
    return {
      kind: 'completed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  if (existing.status === 'failed' && existing.resultReference !== null) {
    return {
      kind: 'failed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  return { kind: 'in-progress', requestDigest: existing.requestDigest };
}

async function completeIdempotency(
  database: AdminQueryDatabase,
  input: CompleteIdempotencyInput,
): Promise<void> {
  const [completed] = await database
    .update(idempotencyRecords)
    .set({
      status: 'completed',
      completedAt: input.completedAt,
      resultReference: input.resultReference,
    })
    .where(
      and(
        eq(idempotencyRecords.id, input.recordId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (completed === undefined) {
    throw conflict('The idempotency result could not be completed.');
  }
}

const ADMIN_MUTATION_IDS = new Set<RegisteredCapabilityId>([
  'create-audience-config-version',
  'create-facility',
  'create-group-source',
  'create-neighborhood-version',
  'set-channel-enabled',
  'set-user-roles',
  'update-facility',
  'update-group-source',
]);

function auditCategory(event: CapabilityAuditEvent): SecurityAuditCategory {
  return event.outcome === 'success' && ADMIN_MUTATION_IDS.has(event.action)
    ? 'admin-change'
    : event.category;
}

async function appendCapabilityAudit(
  database: AdminQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  await database.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
  const [anchor] = await database
    .select({
      sequence: securityAuditChainAnchors.sequence,
      entryHash: securityAuditChainAnchors.entryHash,
    })
    .from(securityAuditChainAnchors)
    .orderBy(desc(securityAuditChainAnchors.sequence))
    .limit(1)
    .for('share');
  const [head] = await database
    .select({
      sequence: securityAuditEntries.sequence,
      entryHash: securityAuditEntries.entryHash,
    })
    .from(securityAuditEntries)
    .orderBy(desc(securityAuditEntries.sequence))
    .limit(1)
    .for('share');
  if (
    (anchor === undefined) !== (head === undefined) ||
    anchor?.sequence !== head?.sequence ||
    anchor?.entryHash !== head?.entryHash
  ) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'Security audit chain integrity verification failed.',
      500,
    );
  }
  const [existingRequest] = await database
    .select({ id: securityAuditEntries.id })
    .from(securityAuditEntries)
    .where(eq(securityAuditEntries.requestId, event.requestId))
    .limit(1)
    .for('share');
  if (existingRequest !== undefined) {
    if (event.outcome === 'success') {
      throw conflict('The request identifier has already been used.');
    }
    // A normal execution preflights this immutable ID. Reaching this branch
    // for a failure means either that preflight rejected a reuse or another
    // transaction won the serialized append race. Existing evidence is kept;
    // no duplicate row can or should be invented for the same request ID.
    return;
  }
  const entry = buildSecurityAuditEntry(
    {
      category: auditCategory(event),
      action: event.action,
      outcome: event.outcome,
      principal: event.actor,
      source: event.source,
      target: { kind: 'capability', id: event.action },
      requestId: event.requestId,
      occurredAt: event.occurredAt.toISOString(),
      ...(event.actionIds === undefined ? {} : { actionIds: event.actionIds }),
      ...(event.confirmationId === undefined
        ? {}
        : { confirmationId: event.confirmationId }),
      ...(event.facilityId === undefined
        ? {}
        : { facilityId: event.facilityId }),
      ...(event.reasonCode === undefined
        ? {}
        : { reasonCode: event.reasonCode }),
    },
    anchor ?? null,
  );
  await database.insert(securityAuditEntries).values({
    id: entry.id,
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    entryHash: entry.entryHash,
    category: entry.category,
    action: entry.action,
    actionIds: entry.actionIds,
    confirmationId: entry.confirmationId,
    outcome: entry.outcome,
    principalKind: entry.principal.kind,
    principal: entry.principal,
    source: entry.source,
    facilityId: entry.facilityId,
    targetKind: entry.target?.kind ?? null,
    targetId: entry.target?.id ?? null,
    requestId: entry.requestId,
    reasonCode: entry.reasonCode,
    occurredAt: new Date(entry.occurredAt),
  });
}

async function assertAuditRequestAvailable(
  database: AdminQueryDatabase,
  requestId: string,
): Promise<void> {
  const [existing] = await database
    .select({ id: securityAuditEntries.id })
    .from(securityAuditEntries)
    .where(eq(securityAuditEntries.requestId, requestId))
    .limit(1)
    .for('share');
  if (existing !== undefined) {
    throw conflict('The request identifier has already been used.');
  }
}

function sameHumanActor(left: Actor, right: Actor): boolean {
  return (
    left.kind === 'human' &&
    right.kind === 'human' &&
    left.userId === right.userId &&
    left.sessionId === right.sessionId
  );
}

function createAdminTransaction(
  database: AdminQueryDatabase,
  authenticated: AuthenticatedSession,
): AdminCapabilityTransaction {
  return {
    database,
    assertAuditRequestAvailable: (requestId) =>
      assertAuditRequestAvailable(database, requestId),
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    getHumanConfirmation: () => Promise.resolve(null),
    consumeHumanConfirmation: () => Promise.resolve(false),
    appendCapabilityAudit: (event) => appendCapabilityAudit(database, event),
    requireAdministrator(actor) {
      if (
        !sameHumanActor(actor, authenticated.actor) ||
        authenticated.source !== 'web' ||
        !authenticated.roles.includes('admin') ||
        authenticated.scope.facilityScope.kind !== 'district'
      ) {
        throw new AdminCapabilityError(
          'FORBIDDEN',
          'District administrator access is required.',
          403,
        );
      }
    },
  };
}

function withAuditRequestGuard<Id extends RegisteredCapabilityId>(
  registration: ServerCapabilityRegistration<Id, AdminCapabilityTransaction>,
): ServerCapabilityRegistration<Id, AdminCapabilityTransaction> {
  return {
    ...registration,
    async resolveFacilityId(input, context) {
      const facilityId = await registration.resolveFacilityId(input, context);
      await context.transaction.assertAuditRequestAvailable(
        context.invocation.requestId,
      );
      return facilityId;
    },
  };
}

/**
 * Creates a store bound to one freshly authenticated request. Successful
 * mutations, idempotency completion, and admin-change audit evidence commit in
 * one transaction. Denial/failure evidence uses the same serialized writer.
 */
export function createDrizzleAdminCapabilityStore(
  database: Database,
  authenticated: AuthenticatedSession,
): AdminCapabilityStore {
  const store: AdminCapabilityStore = {
    transaction<Result>(
      operation: (transaction: AdminCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction((transaction) =>
        operation(
          createAdminTransaction(asAdminDatabase(transaction), authenticated),
        ),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction((transaction) =>
        appendCapabilityAudit(asAdminDatabase(transaction), event),
      );
    },
  };
  adminStoreDatabases.set(store, database);
  return store;
}

/**
 * Returns the exact root database injected into a Drizzle admin store.
 *
 * Read-only evidence stores that own their own transaction must start it from
 * this root rather than nesting under the capability transaction or falling
 * back to process-global state.
 */
export function getAdminCapabilityStoreDatabase(
  store: AdminCapabilityStore,
): Database {
  const database = adminStoreDatabases.get(store);
  if (database === undefined) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'The administrator store does not expose its injected database.',
      500,
    );
  }
  return database;
}

/**
 * Capability resolver guard. Registrations call this before returning their
 * facility ID so the canonical authorizer returns 403 before any handler runs.
 */
export function requireAdminCapabilityAuthorization(
  actor: Actor,
  transaction: AdminCapabilityTransaction,
): void {
  transaction.requireAdministrator(actor);
}

function queryInvocation(
  authenticated: AuthenticatedSession,
  metadata: AdminQueryMetadata,
): TrustedCapabilityInvocation {
  return resolveHumanCapabilityInvocation(authenticated, {
    requestId: metadata.requestId ?? randomUUID(),
    mutation: null,
    ...(metadata.now === undefined ? {} : { serverTime: metadata.now }),
  });
}

function mutationInvocation(
  authenticated: AuthenticatedSession,
  metadata: AdminMutationMetadata,
): TrustedCapabilityInvocation {
  return resolveHumanCapabilityInvocation(authenticated, {
    requestId: metadata.requestId ?? randomUUID(),
    mutation: {
      idempotencyKey: metadata.idempotencyKey,
      humanConfirmationId: null,
    },
    ...(metadata.now === undefined ? {} : { serverTime: metadata.now }),
  });
}

/** Executes a route-owned admin query through the canonical capability engine. */
export function executeAdminQueryCapability<Id extends RegisteredCapabilityId>(
  registration: ServerCapabilityRegistration<Id, AdminCapabilityTransaction>,
  input: CapabilityInput<Id>,
  authenticated: AuthenticatedSession,
  store: AdminCapabilityStore,
  metadata: AdminQueryMetadata = {},
): Promise<CapabilityOutput<Id>> {
  return executeCapability(
    withAuditRequestGuard(registration),
    input,
    queryInvocation(authenticated, metadata),
    store,
  );
}

/**
 * Executes a route-owned admin mutation with shared idempotency and atomic
 * hash-chain auditing. Access and integrations import this helper.
 */
export function executeAdminMutationCapability<
  Id extends RegisteredCapabilityId,
>(
  registration: ServerCapabilityRegistration<Id, AdminCapabilityTransaction>,
  input: CapabilityInput<Id>,
  authenticated: AuthenticatedSession,
  store: AdminCapabilityStore,
  metadata: AdminMutationMetadata,
): Promise<CapabilityOutput<Id>> {
  return executeCapability(
    withAuditRequestGuard(registration),
    input,
    mutationInvocation(authenticated, metadata),
    store,
  );
}

let defaultConnection: DatabaseConnection | undefined;

/** Returns the shared route-process database connection for admin surfaces. */
export function getDefaultAdminDatabase(): Database {
  defaultConnection ??= createDatabaseClient(readDatabaseConfig());
  return defaultConnection.db;
}

/** Test/script lifecycle hook; normal Next.js processes retain the connection. */
export async function closeDefaultAdminDatabase(): Promise<void> {
  const connection = defaultConnection;
  defaultConnection = undefined;
  await connection?.close();
}
