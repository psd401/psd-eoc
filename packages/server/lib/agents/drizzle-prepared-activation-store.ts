import { randomUUID } from 'node:crypto';

import {
  ActivationPreviewSchema,
  PreparedActivationSchema,
  SecurityAuditEntrySchema,
  type ActivationPreview,
  type PreparedActivation,
} from '@psd-eoc/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  databaseExecuteRows,
  type Database,
  type DatabaseQuery,
} from '../../db/client';
import {
  activationPreviews,
  audienceConfigurations,
  idempotencyRecords,
  preparedActivations,
  securityAuditEntries,
} from '../../db/schema';
import { ACCESS_GATE_AUDIT_LOCK_SQL } from '../auth/sign-in-audit';
import {
  CapabilityEngineError,
  digestCapabilityValue,
  type CapabilityAuditEvent,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
} from '../capabilities/engine';
import type {
  PersistPreparedActivationInput,
  PreparedActivationCapabilityStore,
  PreparedActivationCapabilityTransaction,
} from './prepared-activation';

// Both configured Drizzle transports expose this schema-aware query surface.
// The direct-driver type avoids a union of incompatible overloaded signatures.
type AgentQueryDatabase = DatabaseQuery;

function agentQueryDatabase(database: unknown): AgentQueryDatabase {
  return database as AgentQueryDatabase;
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

/** Reads the authoritative clock through either configured Drizzle transport. */
export async function readPreparedActivationDatabaseTime(
  database: Pick<DatabaseQuery, 'execute'>,
): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw conflict('The authoritative database clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

async function claimIdempotency(
  database: AgentQueryDatabase,
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
  database: AgentQueryDatabase,
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

async function appendCapabilityAudit(
  database: AgentQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  await database.execute(ACCESS_GATE_AUDIT_LOCK_SQL);
  const [previous] = await database
    .select({
      sequence: securityAuditEntries.sequence,
      entryHash: securityAuditEntries.entryHash,
    })
    .from(securityAuditEntries)
    .orderBy(desc(securityAuditEntries.sequence))
    .limit(1);
  const sequence = (previous?.sequence ?? 0) + 1;
  const previousHash = previous?.entryHash ?? null;
  const id = randomUUID();
  const hashPayload = {
    id,
    sequence,
    previousHash,
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability' as const, id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  };
  const entry = SecurityAuditEntrySchema.parse({
    ...hashPayload,
    entryHash: digestCapabilityValue(hashPayload),
  });
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

async function activationPreviewById(
  database: AgentQueryDatabase,
  previewId: string,
): Promise<ActivationPreview | null> {
  const [row] = await database
    .select()
    .from(activationPreviews)
    .where(eq(activationPreviews.id, previewId))
    .limit(1);
  if (row === undefined) return null;

  const [audience] = await database
    .select({ facilityId: audienceConfigurations.facilityId })
    .from(audienceConfigurations)
    .where(
      and(
        eq(audienceConfigurations.id, row.audienceConfigId),
        eq(audienceConfigurations.version, row.audienceConfigVersion),
      ),
    )
    .limit(1);
  if (audience?.facilityId !== row.facilityId) {
    throw conflict(
      'The activation audience is not owned by the event facility.',
    );
  }
  return ActivationPreviewSchema.parse({
    id: row.id,
    facilityId: row.facilityId,
    kind: row.kind,
    templateMode: row.templateMode,
    eventTypeVersion: {
      id: row.eventTypeVersionId,
      templateMode: row.templateMode,
    },
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    audienceConfig: {
      id: row.audienceConfigId,
      version: row.audienceConfigVersion,
    },
    recipientCount: row.recipientCount,
    channels: row.channels,
    sendReadiness: row.sendReadiness,
    blockingReasonCodes: row.blockingReasonCodes,
    activeEventIds: row.activeEventIds,
    consequenceDigest: row.consequenceDigest,
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

async function preparedActivationById(
  database: AgentQueryDatabase,
  preparedId: string,
): Promise<PreparedActivation | null> {
  const [row] = await database
    .select()
    .from(preparedActivations)
    .where(eq(preparedActivations.id, preparedId))
    .limit(1);
  if (row === undefined) return null;
  const preview = await activationPreviewById(
    database,
    row.activationPreviewId,
  );
  if (
    preview === null ||
    preview.facilityId !== row.facilityId ||
    preview.consequenceDigest !== row.consequenceDigest
  ) {
    throw conflict('The prepared activation no longer matches its preview.');
  }
  return PreparedActivationSchema.parse({
    id: row.id,
    preview,
    preparedBy: row.preparedBy,
    preparedAt: dateIso(row.preparedAt),
  });
}

async function createPreparedActivation(
  database: AgentQueryDatabase,
  input: PersistPreparedActivationInput,
): Promise<PreparedActivation> {
  const [inserted] = await database
    .insert(preparedActivations)
    .values({
      activationPreviewId: input.preview.id,
      facilityId: input.preview.facilityId,
      kind: input.preview.kind,
      templateMode: input.preview.templateMode,
      eventTypeVersionId: input.preview.eventTypeVersion.id,
      rosterSnapshotId: input.preview.rosterSnapshotId,
      rosterPopulation: input.preview.rosterPopulation,
      audienceConfigId: input.preview.audienceConfig.id,
      audienceConfigVersion: input.preview.audienceConfig.version,
      consequenceDigest: input.preview.consequenceDigest,
      preparedBy: input.preparedBy,
      preparedAt: input.preparedAt,
    })
    .onConflictDoNothing({ target: preparedActivations.activationPreviewId })
    .returning({ id: preparedActivations.id });
  if (inserted === undefined) {
    throw conflict('The prepared activation could not be retained.');
  }
  return PreparedActivationSchema.parse({
    id: inserted.id,
    preview: input.preview,
    preparedBy: input.preparedBy,
    preparedAt: input.preparedAt.toISOString(),
  });
}

function createTransaction(
  database: AgentQueryDatabase,
): PreparedActivationCapabilityTransaction {
  return {
    readCurrentTime: () => readPreparedActivationDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) => appendCapabilityAudit(database, event),
    getActivationPreview: (id) => activationPreviewById(database, id),
    getPreparedActivation: (id) => preparedActivationById(database, id),
    createPreparedActivation: (input) =>
      createPreparedActivation(database, input),
    async getPreparedActivationFacilityId(id) {
      const [row] = await database
        .select({ facilityId: preparedActivations.facilityId })
        .from(preparedActivations)
        .where(eq(preparedActivations.id, id))
        .limit(1);
      return row?.facilityId ?? null;
    },
  };
}

/** Creates the atomic Aurora/PostgreSQL prepared-activation capability store. */
export function createDrizzlePreparedActivationCapabilityStore(
  database: Database,
): PreparedActivationCapabilityStore {
  const queryDatabase = database as AgentQueryDatabase;
  return {
    transaction<Result>(
      operation: (
        transaction: PreparedActivationCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return queryDatabase.transaction((transaction) =>
        operation(createTransaction(agentQueryDatabase(transaction))),
      );
    },
    appendCapabilityAudit(event) {
      return queryDatabase.transaction((transaction) =>
        appendCapabilityAudit(agentQueryDatabase(transaction), event),
      );
    },
  };
}
