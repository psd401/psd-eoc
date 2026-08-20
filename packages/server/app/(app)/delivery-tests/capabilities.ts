import { randomUUID } from 'node:crypto';

import {
  DeliveryTestCanaryEligibilityFactSchema,
  DeliveryTestTargetSetVersionSchema,
  MonthlyDeliveryTestReportPageSchema,
  MonthlyDeliveryTestReportSchema,
  SecurityAuditEntrySchema,
  UuidSchema,
  type AttemptDeliveryTruthState,
  type CapabilityInput,
  type CapabilityOutput,
  type CapabilityScope,
  type DeliveryTestChannelReport,
  type DeliveryTestCanaryEligibilityFact,
  type DeliveryTestTargetSetVersion,
  type MonthlyDeliveryTestReport,
  type MonthlyDeliveryTestReportPage,
  type NotificationChannel,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../../db/client';
import {
  channelAttempts,
  deliveryEvidence,
  deliveryTestCanaryEligibilityFacts,
  deliveryTestReports,
  deliveryTestRuns,
  deliveryTestTargetEndpoints,
  deliveryTestTargetSetVersions,
  dispatchBatches,
  facilities,
  idempotencyRecords,
  rosterEndpoints,
  securityAuditChainAnchors,
  securityAuditEntries,
} from '../../../db/schema';
import { canonicalSecurityAuditJson } from '../../../lib/audit/canonical';
import { buildSecurityAuditEntry } from '../../../lib/audit/entry';
import {
  parseSecurityAuditFact,
  securityAuditFactFromEntry,
} from '../../../lib/audit/model';
import { ACCESS_GATE_AUDIT_LOCK_SQL } from '../../../lib/auth/sign-in-audit';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  digestCapabilityValue,
  executeCapability,
  readCapabilityTime,
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
import type { AuthenticatedAgentApiKey } from '../../../lib/agents/keys';
import { resolveAudience } from '../../../lib/roster/resolve';
import {
  DELIVERY_TEST_TARGET_LOCK_NAMESPACE,
  assembleDeliveryTestChannelReport,
  assembleMonthlyDeliveryTestReport,
  deliveryTestEndpointReferenceDigest,
  deliveryTestTargetLockIdentity,
} from '../../../lib/testing/e2e-delivery';
import type {
  AdminMutationMetadata,
  AdminQueryMetadata,
} from '../../(admin)/facilities/admin-core';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  executeAdminMutationCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
} from '../../(admin)/facilities/admin-core';
import {
  loadAudienceConfiguration,
  loadRosterSnapshot,
} from '../start/_lib/capabilities';

export const DELIVERY_TEST_PRODUCT_OWNER_USER_ID_ENV =
  'PSD_EOC_PRODUCT_OWNER_USER_ID' as const;

export type DeliveryTestQueryDatabase = DatabaseQuery;

interface DeliveryTestCapabilityTransaction
  extends CapabilityEngineTransaction {
  readonly database: DeliveryTestQueryDatabase;
}

export type DeliveryTestCapabilityStore =
  CapabilityEngineStore<DeliveryTestCapabilityTransaction>;

function queryDatabase(value: unknown): DeliveryTestQueryDatabase {
  return value as DeliveryTestQueryDatabase;
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw unavailable('Persisted delivery-test time was invalid.');
  }
  return date.toISOString();
}

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function forbidden(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'FORBIDDEN',
    'CAPABILITY_INVOCATION_DENIED',
    message,
    403,
  );
}

function unavailable(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'LIVE_ACTION_UNAVAILABLE',
    'PERSISTENCE_CONFLICT',
    message,
    503,
    true,
  );
}

function productOwnerUserId(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const parsed = UuidSchema.safeParse(
    environment[DELIVERY_TEST_PRODUCT_OWNER_USER_ID_ENV],
  );
  if (!parsed.success) {
    throw unavailable(
      'The delivery-test product-owner authorization is unavailable.',
    );
  }
  return parsed.data;
}

function sameScope(left: CapabilityScope, right: CapabilityScope): boolean {
  return digestCapabilityValue(left) === digestCapabilityValue(right);
}

function scopeAllowsFacility(
  scope: CapabilityScope,
  facilityId: string | null,
): boolean {
  return (
    facilityId === null ||
    scope.facilityScope.kind === 'district' ||
    scope.facilityScope.facilityIds.includes(facilityId)
  );
}

async function readDatabaseTime(
  database: DeliveryTestQueryDatabase,
): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw unavailable('The authoritative delivery-test clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

async function claimIdempotency(
  database: DeliveryTestQueryDatabase,
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
    throw conflict(
      'The delivery-test idempotency reservation was unavailable.',
    );
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
  database: DeliveryTestQueryDatabase,
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
    throw conflict(
      'The delivery-test idempotency result could not be retained.',
    );
  }
}

async function appendCapabilityAudit(
  database: DeliveryTestQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  const fact = parseSecurityAuditFact({
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability', id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  });
  await database.execute(ACCESS_GATE_AUDIT_LOCK_SQL);
  const [existingRow] = await database
    .select()
    .from(securityAuditEntries)
    .where(eq(securityAuditEntries.requestId, fact.requestId))
    .limit(1)
    .for('share');
  if (existingRow !== undefined) {
    const existing = SecurityAuditEntrySchema.parse({
      id: existingRow.id,
      sequence: existingRow.sequence,
      previousHash: existingRow.previousHash,
      entryHash: existingRow.entryHash,
      category: existingRow.category,
      action: existingRow.action,
      actionIds: existingRow.actionIds,
      confirmationId: existingRow.confirmationId,
      outcome: existingRow.outcome,
      principal: existingRow.principal,
      source: existingRow.source,
      facilityId: existingRow.facilityId,
      target:
        existingRow.targetKind === null || existingRow.targetId === null
          ? null
          : { kind: existingRow.targetKind, id: existingRow.targetId },
      requestId: existingRow.requestId,
      reasonCode: existingRow.reasonCode,
      occurredAt: dateIso(existingRow.occurredAt),
    });
    if (
      canonicalSecurityAuditJson(securityAuditFactFromEntry(existing)) ===
      canonicalSecurityAuditJson(fact)
    ) {
      return;
    }
    throw conflict('The audit request is already bound to different evidence.');
  }
  const [anchor] = await database
    .select({
      sequence: securityAuditChainAnchors.sequence,
      entryHash: securityAuditChainAnchors.entryHash,
    })
    .from(securityAuditChainAnchors)
    .orderBy(desc(securityAuditChainAnchors.sequence))
    .limit(1);
  const entry = buildSecurityAuditEntry(fact, anchor ?? null);
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

function createDeliveryTestTransaction(
  database: DeliveryTestQueryDatabase,
): DeliveryTestCapabilityTransaction {
  return {
    database,
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) => appendCapabilityAudit(database, event),
  };
}

export function createDrizzleDeliveryTestCapabilityStore(
  database: Database,
): DeliveryTestCapabilityStore {
  return {
    transaction<Result>(
      operation: (
        transaction: DeliveryTestCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction((transaction) =>
        operation(createDeliveryTestTransaction(queryDatabase(transaction))),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction((transaction) =>
        appendCapabilityAudit(queryDatabase(transaction), event),
      );
    },
  };
}

type EndpointReference = Readonly<{
  recipientId: string;
  endpointId: string;
  channel: NotificationChannel;
}>;

/**
 * Revalidates the target-mode discriminator after opaque eligibility facts
 * have been resolved. The controlled mode is a singleton email branch;
 * ordinary target sets retain their push-and-email launch floor.
 */
export function deliveryTestTargetModeMatches(
  input: object,
  endpoints: readonly EndpointReference[],
): boolean {
  if ('mode' in input && input.mode === 'controlled-email-canary') {
    return endpoints.length === 1 && endpoints[0]?.channel === 'email';
  }
  const channels = new Set(endpoints.map((endpoint) => endpoint.channel));
  return endpoints.length >= 2 && channels.has('push') && channels.has('email');
}

function endpointKey(endpoint: EndpointReference): string {
  return `${endpoint.channel}:${endpoint.recipientId}:${endpoint.endpointId}`;
}

function canonicalEndpointReferences(
  endpoints: readonly EndpointReference[],
): readonly EndpointReference[] {
  return Object.freeze(
    endpoints
      .map((endpoint) => Object.freeze({ ...endpoint }))
      .sort((left, right) =>
        endpointKey(left).localeCompare(endpointKey(right)),
      ),
  );
}

function canaryEligibilityFactFromRow(
  row: typeof deliveryTestCanaryEligibilityFacts.$inferSelect,
): DeliveryTestCanaryEligibilityFact {
  return DeliveryTestCanaryEligibilityFactSchema.parse({
    id: row.id,
    supersedesFactId: row.supersedesFactId,
    facilityId: row.facilityId,
    rosterSnapshotId: row.rosterSnapshotId,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    channel: row.channel,
    decision: row.decision,
    optedInAt: dateIso(row.optedInAt),
    decidedAt: dateIso(row.decidedAt),
    decidedByUserId: row.decidedByUserId,
    decidedWithSessionId: row.decidedWithSessionId,
    authorizationReference: row.authorizationReference,
  });
}

async function loadDeliveryTestTargetSetVersion(
  database: DeliveryTestQueryDatabase,
  id: string,
  version: number,
): Promise<DeliveryTestTargetSetVersion | null> {
  const [row] = await database
    .select()
    .from(deliveryTestTargetSetVersions)
    .where(
      and(
        eq(deliveryTestTargetSetVersions.id, id),
        eq(deliveryTestTargetSetVersions.version, version),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  const endpoints = await database
    .select()
    .from(deliveryTestTargetEndpoints)
    .where(eq(deliveryTestTargetEndpoints.targetSetVersionId, row.id))
    .orderBy(
      asc(deliveryTestTargetEndpoints.channel),
      asc(deliveryTestTargetEndpoints.recipientId),
      asc(deliveryTestTargetEndpoints.endpointId),
    );
  return DeliveryTestTargetSetVersionSchema.parse({
    id: row.id,
    version: row.version,
    facilityId: row.facilityId,
    rosterSnapshotId: row.rosterSnapshotId,
    supersedesVersionId: row.supersedesVersionId,
    endpoints: endpoints.map((endpoint) => ({
      eligibilityFactId: endpoint.eligibilityFactId,
      recipientId: endpoint.recipientId,
      endpointId: endpoint.endpointId,
      channel: endpoint.channel,
      attestation: endpoint.attestation,
      optedInAt: dateIso(endpoint.optedInAt),
      attestedAt: dateIso(endpoint.attestedAt),
      attestedByUserId: endpoint.attestedByUserId,
      authorizationReference: endpoint.authorizationReference,
    })),
    endpointReferenceDigest: row.endpointReferenceDigest,
    approvedByUserId: row.approvedByUserId,
    approvedWithSessionId: row.approvedWithSessionId,
    approvedAt: dateIso(row.approvedAt),
    createdAt: dateIso(row.createdAt),
  });
}

async function currentActiveAudienceEndpointReferences(
  database: DeliveryTestQueryDatabase,
  input: Readonly<{ facilityId: string; rosterSnapshotId: string }>,
): Promise<readonly EndpointReference[]> {
  const [facility] = await database
    .select({ id: facilities.id, active: facilities.active })
    .from(facilities)
    .where(eq(facilities.id, input.facilityId))
    .limit(1);
  if (facility === undefined || !facility.active) {
    throw unavailable('The delivery-test facility is unavailable.');
  }
  const currentRoster = await loadRosterSnapshot(
    database,
    'staff',
    input.facilityId,
  );
  if (currentRoster?.id !== input.rosterSnapshotId) {
    throw conflict(
      'The target set must use the current complete staff roster snapshot.',
    );
  }
  const roster = currentRoster;
  const audience = await loadAudienceConfiguration(database, input.facilityId);
  if (roster === null || audience === null) {
    throw unavailable(
      'The current staff audience for delivery testing is unavailable.',
    );
  }

  const allEndpointsActive = {
    ...roster,
    recipients: roster.recipients.map((recipient) => ({
      ...recipient,
      endpoints: recipient.endpoints.map((endpoint) => ({
        ...endpoint,
        status: 'active' as const,
      })),
    })),
  };
  const resolved = resolveAudience({
    audienceConfig: audience.audienceConfig,
    neighborhoodVersions: audience.neighborhoodVersions,
    rosterSnapshot: allEndpointsActive,
  });
  const resolvedReferences = resolved.recipients.flatMap((recipient) =>
    recipient.endpoints.map((endpoint) => ({
      recipientId: recipient.recipientId,
      endpointId: endpoint.id,
      channel: endpoint.channel,
    })),
  );
  const endpointIds = resolvedReferences.map((endpoint) => endpoint.endpointId);
  if (endpointIds.length === 0) return [];
  const rows = await database
    .select({
      endpointId: rosterEndpoints.id,
      recipientId: rosterEndpoints.recipientId,
      channel: rosterEndpoints.channel,
      baseStatus: rosterEndpoints.status,
      latestStatus: sql<'active' | 'invalid' | 'disabled' | null>`(
        select esr.status
        from endpoint_status_records esr
        where esr.roster_snapshot_id = ${rosterEndpoints.rosterSnapshotId}
          and esr.endpoint_id = ${rosterEndpoints.id}
        order by esr.recorded_at desc, esr.sequence desc
        limit 1
      )`,
    })
    .from(rosterEndpoints)
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, input.rosterSnapshotId),
        inArray(rosterEndpoints.id, endpointIds),
      ),
    );
  if (rows.length !== endpointIds.length) {
    throw unavailable('The current delivery-test endpoints are unavailable.');
  }
  return canonicalEndpointReferences(
    rows
      .filter((row) => (row.latestStatus ?? row.baseStatus) === 'active')
      .map((row) => ({
        recipientId: row.recipientId,
        endpointId: row.endpointId,
        channel: row.channel,
      })),
  );
}

async function loadCurrentApprovedCanaryEligibilityFacts(
  database: DeliveryTestQueryDatabase,
  input: Readonly<{
    facilityId: string;
    rosterSnapshotId: string;
    eligibilityFactIds: readonly string[];
    now: Date;
  }>,
): Promise<readonly DeliveryTestCanaryEligibilityFact[]> {
  // RDS Data API permits only one in-flight statement per transaction.
  const rows = await database
    .select()
    .from(deliveryTestCanaryEligibilityFacts)
    .where(
      inArray(deliveryTestCanaryEligibilityFacts.id, input.eligibilityFactIds),
    );
  const successorRows = await database
    .select({
      supersedesFactId: deliveryTestCanaryEligibilityFacts.supersedesFactId,
    })
    .from(deliveryTestCanaryEligibilityFacts)
    .where(
      inArray(
        deliveryTestCanaryEligibilityFacts.supersedesFactId,
        input.eligibilityFactIds,
      ),
    );
  const facts = rows.map(canaryEligibilityFactFromRow);
  if (
    facts.length !== input.eligibilityFactIds.length ||
    successorRows.length !== 0 ||
    facts.some(
      (fact) =>
        fact.facilityId !== input.facilityId ||
        fact.rosterSnapshotId !== input.rosterSnapshotId ||
        fact.decision !== 'approved-synthetic-canary' ||
        Date.parse(fact.decidedAt) > input.now.getTime(),
    )
  ) {
    throw forbidden(
      'Every canary target must reference a current product-owner eligibility fact.',
    );
  }
  return facts;
}

function canaryEligibilityLockIdentity(
  input: Readonly<{
    facilityId: string;
    rosterSnapshotId: string;
    recipientId: string;
    endpointId: string;
    channel: NotificationChannel;
  }>,
): string {
  return [
    'delivery-test-canary-eligibility',
    input.facilityId,
    input.rosterSnapshotId,
    input.recipientId,
    input.endpointId,
    input.channel,
  ].join(':');
}

async function recordCanaryEligibility(
  database: DeliveryTestQueryDatabase,
  input: CapabilityInput<'record-delivery-test-canary-eligibility'>,
  authenticated: Extract<
    TrustedCapabilityInvocation['actor'],
    { readonly kind: 'human' }
  >,
  now: Date,
): Promise<DeliveryTestCanaryEligibilityFact> {
  // Eligibility changes share the facility lineage lock with target approval,
  // preview, and start-event. Acquire it first so revocation cannot commit
  // between last-mile revalidation and outbox creation.
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${deliveryTestTargetLockIdentity(input.facilityId)}, ${DELIVERY_TEST_TARGET_LOCK_NAMESPACE}))`,
  );
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${canaryEligibilityLockIdentity(input)}, ${DELIVERY_TEST_TARGET_LOCK_NAMESPACE}))`,
  );
  const existingRows = await database
    .select()
    .from(deliveryTestCanaryEligibilityFacts)
    .where(
      and(
        eq(deliveryTestCanaryEligibilityFacts.facilityId, input.facilityId),
        eq(
          deliveryTestCanaryEligibilityFacts.rosterSnapshotId,
          input.rosterSnapshotId,
        ),
        eq(deliveryTestCanaryEligibilityFacts.recipientId, input.recipientId),
        eq(deliveryTestCanaryEligibilityFacts.endpointId, input.endpointId),
        eq(deliveryTestCanaryEligibilityFacts.channel, input.channel),
      ),
    );
  const successorIds = new Set(
    existingRows
      .map((row) => row.supersedesFactId)
      .filter((id): id is string => id !== null),
  );
  const latestRows = existingRows.filter((row) => !successorIds.has(row.id));
  const latest = latestRows.length === 1 ? (latestRows[0] ?? null) : null;
  const validRevocation =
    latest !== null &&
    latest.id === input.supersedesFactId &&
    latest.decision === 'approved-synthetic-canary' &&
    dateIso(latest.optedInAt) === input.optedInAt;
  const validApproval =
    existingRows.length === 0
      ? input.supersedesFactId === null
      : latest !== null &&
        latest.id === input.supersedesFactId &&
        latest.decision === 'revoked' &&
        Date.parse(input.optedInAt) >= new Date(latest.decidedAt).getTime();
  if (
    latestRows.length > 1 ||
    Date.parse(input.optedInAt) > now.getTime() ||
    (input.decision === 'approved-synthetic-canary'
      ? !validApproval
      : !validRevocation)
  ) {
    throw conflict(
      'The canary eligibility decision does not advance the current endpoint fact chain.',
    );
  }
  if (input.decision === 'approved-synthetic-canary') {
    const activeReferences = await currentActiveAudienceEndpointReferences(
      database,
      input,
    );
    if (
      !activeReferences.some(
        (reference) => endpointKey(reference) === endpointKey(input),
      )
    ) {
      throw forbidden(
        'Canary eligibility may be approved only for a current active staff-audience endpoint.',
      );
    }
  }

  const output = DeliveryTestCanaryEligibilityFactSchema.parse({
    id: randomUUID(),
    supersedesFactId: input.supersedesFactId,
    facilityId: input.facilityId,
    rosterSnapshotId: input.rosterSnapshotId,
    recipientId: input.recipientId,
    endpointId: input.endpointId,
    channel: input.channel,
    decision: input.decision,
    optedInAt: input.optedInAt,
    decidedAt: now.toISOString(),
    decidedByUserId: authenticated.userId,
    decidedWithSessionId: authenticated.sessionId,
    authorizationReference: input.authorizationReference,
  });
  await database.insert(deliveryTestCanaryEligibilityFacts).values({
    id: output.id,
    supersedesFactId: output.supersedesFactId,
    facilityId: output.facilityId,
    rosterSnapshotId: output.rosterSnapshotId,
    rosterPopulation: 'staff',
    recipientId: output.recipientId,
    endpointId: output.endpointId,
    channel: output.channel,
    decision: output.decision,
    optedInAt: new Date(output.optedInAt),
    decidedAt: now,
    decidedByUserId: output.decidedByUserId,
    decidedWithSessionId: output.decidedWithSessionId,
    authorizationReference: output.authorizationReference,
  });
  return output;
}

async function createTargetSetVersion(
  database: DeliveryTestQueryDatabase,
  input: CapabilityInput<'create-delivery-test-target-set-version'>,
  authenticated: Extract<
    TrustedCapabilityInvocation['actor'],
    { readonly kind: 'human' }
  >,
  requestId: string,
  now: Date,
): Promise<DeliveryTestTargetSetVersion> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${deliveryTestTargetLockIdentity(input.facilityId)}, ${DELIVERY_TEST_TARGET_LOCK_NAMESPACE}))`,
  );
  const latestRows = await database
    .select()
    .from(deliveryTestTargetSetVersions)
    .where(eq(deliveryTestTargetSetVersions.facilityId, input.facilityId))
    .orderBy(desc(deliveryTestTargetSetVersions.version))
    .limit(1);
  const latest = latestRows[0] ?? null;
  if (
    input.previousVersion === null
      ? latest !== null
      : latest === null ||
        latest.id !== input.previousVersion.id ||
        latest.version !== input.previousVersion.version
  ) {
    throw conflict(
      'The delivery-test target-set version chain changed; refresh before approving.',
    );
  }

  const activeReferences = await currentActiveAudienceEndpointReferences(
    database,
    input,
  );
  const eligibilityFacts = await loadCurrentApprovedCanaryEligibilityFacts(
    database,
    {
      facilityId: input.facilityId,
      rosterSnapshotId: input.rosterSnapshotId,
      eligibilityFactIds: input.eligibilityFactIds,
      now,
    },
  );
  const endpoints = eligibilityFacts
    .map((fact) => ({
      eligibilityFactId: fact.id,
      recipientId: fact.recipientId,
      endpointId: fact.endpointId,
      channel: fact.channel,
      attestation: 'approved-synthetic-canary' as const,
      optedInAt: dateIso(fact.optedInAt),
      attestedAt: dateIso(fact.decidedAt),
      attestedByUserId: fact.decidedByUserId,
      authorizationReference: fact.authorizationReference,
    }))
    .sort((left, right) => endpointKey(left).localeCompare(endpointKey(right)));
  if (!deliveryTestTargetModeMatches(input, endpoints)) {
    throw forbidden(
      'The selected delivery-test mode does not match its current approved endpoint facts.',
    );
  }
  const requestedReferences = endpoints.map((endpoint) => ({
    recipientId: endpoint.recipientId,
    endpointId: endpoint.endpointId,
    channel: endpoint.channel,
  }));
  const activeKeys = new Set(activeReferences.map(endpointKey));
  if (
    requestedReferences.some(
      (reference) => !activeKeys.has(endpointKey(reference)),
    )
  ) {
    throw forbidden(
      'Every canary target must reference a current product-owner eligibility fact for an active staff-audience endpoint.',
    );
  }

  const id = randomUUID();
  const version = (latest?.version ?? 0) + 1;
  const endpointReferenceDigest =
    deliveryTestEndpointReferenceDigest(requestedReferences);
  const output = DeliveryTestTargetSetVersionSchema.parse({
    id,
    version,
    facilityId: input.facilityId,
    rosterSnapshotId: input.rosterSnapshotId,
    supersedesVersionId: latest?.id ?? null,
    endpoints,
    endpointReferenceDigest,
    approvedByUserId: authenticated.userId,
    approvedWithSessionId: authenticated.sessionId,
    approvedAt: now.toISOString(),
    createdAt: now.toISOString(),
  });
  await database.insert(deliveryTestTargetSetVersions).values({
    id: output.id,
    version: output.version,
    facilityId: output.facilityId,
    rosterSnapshotId: output.rosterSnapshotId,
    rosterPopulation: 'staff',
    supersedesVersionId: output.supersedesVersionId,
    endpointReferenceDigest: output.endpointReferenceDigest,
    idempotencyRequestId: requestId,
    approvedByUserId: output.approvedByUserId,
    approvedWithSessionId: output.approvedWithSessionId,
    approvedAt: now,
    createdAt: now,
  });
  await database.insert(deliveryTestTargetEndpoints).values(
    output.endpoints.map((endpoint) => ({
      targetSetVersionId: output.id,
      targetSetVersion: output.version,
      eligibilityFactId: endpoint.eligibilityFactId,
      rosterSnapshotId: output.rosterSnapshotId,
      rosterPopulation: 'staff' as const,
      recipientId: endpoint.recipientId,
      endpointId: endpoint.endpointId,
      channel: endpoint.channel,
      attestation: endpoint.attestation,
      optedInAt: new Date(endpoint.optedInAt),
      attestedAt: new Date(endpoint.attestedAt),
      attestedByUserId: endpoint.attestedByUserId,
      authorizationReference: endpoint.authorizationReference,
    })),
  );
  return output;
}

interface TargetSetResultReference {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

function targetSetResultReference(
  output: DeliveryTestTargetSetVersion,
): string {
  return Buffer.from(
    JSON.stringify({
      id: output.id,
      version: output.version,
      digest: digestCapabilityValue(output),
    }),
    'utf8',
  ).toString('base64url');
}

function parseTargetSetResultReference(
  value: string,
): TargetSetResultReference {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Readonly<Record<string, unknown>>;
    const result = {
      id: UuidSchema.parse(parsed.id),
      version: parsed.version,
      digest: parsed.digest,
    };
    if (
      !Number.isSafeInteger(result.version) ||
      Number(result.version) <= 0 ||
      typeof result.digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(result.digest)
    ) {
      throw new TypeError();
    }
    return {
      id: result.id,
      version: Number(result.version),
      digest: result.digest,
    };
  } catch {
    throw conflict('The target-set idempotency result is invalid.');
  }
}

interface CanaryEligibilityResultReference {
  readonly id: string;
  readonly digest: string;
}

function canaryEligibilityResultReference(
  output: DeliveryTestCanaryEligibilityFact,
): string {
  return Buffer.from(
    JSON.stringify({ id: output.id, digest: digestCapabilityValue(output) }),
    'utf8',
  ).toString('base64url');
}

function parseCanaryEligibilityResultReference(
  value: string,
): CanaryEligibilityResultReference {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Readonly<Record<string, unknown>>;
    const result = {
      id: UuidSchema.parse(parsed.id),
      digest: parsed.digest,
    };
    if (
      typeof result.digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(result.digest)
    ) {
      throw new TypeError();
    }
    return { id: result.id, digest: result.digest };
  } catch {
    throw conflict('The canary eligibility idempotency result is invalid.');
  }
}

async function loadCanaryEligibilityFact(
  database: DeliveryTestQueryDatabase,
  id: string,
): Promise<DeliveryTestCanaryEligibilityFact | null> {
  const [row] = await database
    .select()
    .from(deliveryTestCanaryEligibilityFacts)
    .where(eq(deliveryTestCanaryEligibilityFacts.id, id))
    .limit(1);
  return row === undefined ? null : canaryEligibilityFactFromRow(row);
}

function requireProductOwner(
  context: Readonly<{
    invocation: TrustedCapabilityInvocation;
    transaction: AdminCapabilityTransaction;
  }>,
): void {
  requireAdminCapabilityAuthorization(
    context.invocation.actor,
    context.transaction,
  );
  if (
    context.invocation.actor.kind !== 'human' ||
    context.invocation.actor.userId !== productOwnerUserId()
  ) {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'Only the configured product owner may approve delivery-test targets.',
      403,
    );
  }
}

export const recordDeliveryTestCanaryEligibilityRegistration: ServerCapabilityRegistration<
  'record-delivery-test-canary-eligibility',
  AdminCapabilityTransaction
> = {
  id: 'record-delivery-test-canary-eligibility',
  resolveFacilityId(input, context) {
    requireProductOwner(context);
    return input.facilityId;
  },
  async handler(input, context) {
    requireProductOwner(context);
    const actor = context.invocation.actor;
    if (actor.kind !== 'human') {
      throw forbidden('A human product owner is required.');
    }
    const output = await recordCanaryEligibility(
      queryDatabase(context.transaction.database),
      input,
      actor,
      await readCapabilityTime(context),
    );
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: canaryEligibilityResultReference,
  async loadReplay(reference, context) {
    requireProductOwner(context);
    const parsed = parseCanaryEligibilityResultReference(reference);
    const output = await loadCanaryEligibilityFact(
      queryDatabase(context.transaction.database),
      parsed.id,
    );
    if (output === null || digestCapabilityValue(output) !== parsed.digest) {
      throw conflict(
        'The original canary eligibility result is no longer reconstructable.',
      );
    }
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  async resolveReplayFacilityId(reference, context) {
    requireProductOwner(context);
    const parsed = parseCanaryEligibilityResultReference(reference);
    const output = await loadCanaryEligibilityFact(
      queryDatabase(context.transaction.database),
      parsed.id,
    );
    if (output === null) {
      throw conflict('The original canary eligibility result is unavailable.');
    }
    return output.facilityId;
  },
  replayFacilityId: (output) => output.facilityId,
};

export const createDeliveryTestTargetSetVersionRegistration: ServerCapabilityRegistration<
  'create-delivery-test-target-set-version',
  AdminCapabilityTransaction
> = {
  id: 'create-delivery-test-target-set-version',
  resolveFacilityId(input, context) {
    requireProductOwner(context);
    return input.facilityId;
  },
  async handler(input, context) {
    requireProductOwner(context);
    const actor = context.invocation.actor;
    if (actor.kind !== 'human') {
      throw forbidden('A human product owner is required.');
    }
    const output = await createTargetSetVersion(
      queryDatabase(context.transaction.database),
      input,
      actor,
      context.invocation.requestId,
      await readCapabilityTime(context),
    );
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: targetSetResultReference,
  async loadReplay(reference, context) {
    requireProductOwner(context);
    const parsed = parseTargetSetResultReference(reference);
    const output = await loadDeliveryTestTargetSetVersion(
      queryDatabase(context.transaction.database),
      parsed.id,
      parsed.version,
    );
    if (output === null || digestCapabilityValue(output) !== parsed.digest) {
      throw conflict(
        'The original target-set result is no longer reconstructable.',
      );
    }
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  async resolveReplayFacilityId(reference, context) {
    requireProductOwner(context);
    const parsed = parseTargetSetResultReference(reference);
    const output = await loadDeliveryTestTargetSetVersion(
      queryDatabase(context.transaction.database),
      parsed.id,
      parsed.version,
    );
    if (output === null) {
      throw conflict('The original target-set result is unavailable.');
    }
    return output.facilityId;
  },
  replayFacilityId: (output) => output.facilityId,
};

function reportFromRow(
  row: typeof deliveryTestReports.$inferSelect,
): MonthlyDeliveryTestReport {
  return MonthlyDeliveryTestReportSchema.parse({
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    supersedesReportId: row.supersedesReportId,
    status: row.status,
    channels: row.channels,
    generatedAt: dateIso(row.generatedAt),
    finalizedBy: row.finalizedBy,
    source: row.source,
    reasonCode: row.reasonCode,
  });
}

export interface DeliveryTestReportPageCursor {
  readonly version: 2;
  /** Reports generated in this millisecond or later belong to a later snapshot. */
  readonly snapshotExclusive: string;
  readonly after: Readonly<{ generatedAt: string; id: string }>;
  readonly filterDigest: string;
}

function reportFilterDigest(
  input: CapabilityInput<'list-delivery-test-reports'>,
  scope: CapabilityScope,
): string {
  return digestCapabilityValue({
    facilityId: input.facilityId,
    status: input.status,
    generatedFrom: input.generatedFrom,
    generatedThrough: input.generatedThrough,
    scope: scope.facilityScope,
  });
}

export function encodeDeliveryTestReportPageCursor(
  cursor: DeliveryTestReportPageCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeDeliveryTestReportPageCursor(
  value: string | null,
  filterDigest: string,
): DeliveryTestReportPageCursor | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Readonly<Record<string, unknown>>;
    const parsedAfter = parsed.after as
      | Readonly<Record<string, unknown>>
      | undefined;
    const canonical: DeliveryTestReportPageCursor = {
      version: 2,
      snapshotExclusive: String(parsed.snapshotExclusive),
      after: {
        generatedAt: String(parsedAfter?.generatedAt),
        id: UuidSchema.parse(parsedAfter?.id),
      },
      filterDigest: String(parsed.filterDigest),
    };
    if (
      parsed.version !== 2 ||
      !Number.isFinite(Date.parse(canonical.snapshotExclusive)) ||
      new Date(canonical.snapshotExclusive).toISOString() !==
        canonical.snapshotExclusive ||
      !Number.isFinite(Date.parse(canonical.after.generatedAt)) ||
      new Date(canonical.after.generatedAt).toISOString() !==
        canonical.after.generatedAt ||
      Date.parse(canonical.after.generatedAt) >=
        Date.parse(canonical.snapshotExclusive) ||
      canonical.filterDigest !== filterDigest ||
      encodeDeliveryTestReportPageCursor(canonical) !== value
    ) {
      throw new TypeError();
    }
    return canonical;
  } catch {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'CAPABILITY_INPUT_INVALID',
      'The delivery-test report cursor is invalid.',
      400,
    );
  }
}

/** Pure mirror of the descending `(generatedAt, id)` database keyset window. */
export function deliveryTestReportIsInPageWindow(
  report: Readonly<{ generatedAt: string; id: string }>,
  cursor: DeliveryTestReportPageCursor,
): boolean {
  const generatedAt = Date.parse(report.generatedAt);
  const snapshotExclusive = Date.parse(cursor.snapshotExclusive);
  const afterGeneratedAt = Date.parse(cursor.after.generatedAt);
  return (
    generatedAt < snapshotExclusive &&
    (generatedAt < afterGeneratedAt ||
      (generatedAt === afterGeneratedAt && report.id < cursor.after.id))
  );
}

async function listDeliveryTestReports(
  database: DeliveryTestQueryDatabase,
  input: CapabilityInput<'list-delivery-test-reports'>,
  scope: CapabilityScope,
  readSnapshotTime: () => Promise<Date>,
): Promise<MonthlyDeliveryTestReportPage> {
  const filterDigest = reportFilterDigest(input, scope);
  const cursor = decodeDeliveryTestReportPageCursor(input.cursor, filterDigest);
  // DB timestamps are millisecond-precise by invariant. A strict boundary at
  // the current millisecond excludes any concurrent insert sharing that same
  // millisecond, making the cross-request snapshot stable.
  const snapshotExclusive =
    cursor?.snapshotExclusive ?? (await readSnapshotTime()).toISOString();
  const conditions: SQL[] = [];
  conditions.push(
    lt(deliveryTestReports.generatedAt, new Date(snapshotExclusive)),
  );
  if (cursor !== null) {
    conditions.push(
      or(
        lt(deliveryTestReports.generatedAt, new Date(cursor.after.generatedAt)),
        and(
          eq(
            deliveryTestReports.generatedAt,
            new Date(cursor.after.generatedAt),
          ),
          lt(deliveryTestReports.id, cursor.after.id),
        ),
      )!,
    );
  }
  if (input.facilityId !== null) {
    conditions.push(
      eq(deliveryTestTargetSetVersions.facilityId, input.facilityId),
    );
  } else if (scope.facilityScope.kind === 'facilities') {
    conditions.push(
      inArray(deliveryTestTargetSetVersions.facilityId, [
        ...scope.facilityScope.facilityIds,
      ]),
    );
  }
  if (input.status !== null) {
    conditions.push(eq(deliveryTestReports.status, input.status));
  }
  if (input.generatedFrom !== null) {
    conditions.push(
      gte(deliveryTestReports.generatedAt, new Date(input.generatedFrom)),
    );
  }
  if (input.generatedThrough !== null) {
    conditions.push(
      lte(deliveryTestReports.generatedAt, new Date(input.generatedThrough)),
    );
  }
  const rows = await database
    .select({ report: deliveryTestReports })
    .from(deliveryTestReports)
    .innerJoin(
      deliveryTestRuns,
      eq(deliveryTestReports.runId, deliveryTestRuns.id),
    )
    .innerJoin(
      deliveryTestTargetSetVersions,
      and(
        eq(
          deliveryTestRuns.targetSetVersionId,
          deliveryTestTargetSetVersions.id,
        ),
        eq(
          deliveryTestRuns.targetSetVersion,
          deliveryTestTargetSetVersions.version,
        ),
      ),
    )
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(
      desc(deliveryTestReports.generatedAt),
      desc(deliveryTestReports.id),
    )
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = hasMore ? rows.slice(0, input.limit) : rows;
  return MonthlyDeliveryTestReportPageSchema.parse({
    items: selected.map(({ report }) => reportFromRow(report)),
    pageInfo: {
      hasMore,
      nextCursor: hasMore
        ? encodeDeliveryTestReportPageCursor({
            version: 2,
            snapshotExclusive,
            after: {
              generatedAt: dateIso(selected.at(-1)!.report.generatedAt),
              id: selected.at(-1)!.report.id,
            },
            filterDigest,
          })
        : null,
    },
  });
}

export const listDeliveryTestReportsRegistration: ServerCapabilityRegistration<
  'list-delivery-test-reports',
  DeliveryTestCapabilityTransaction
> = {
  id: 'list-delivery-test-reports',
  resolveFacilityId: (input) => input.facilityId,
  handler: (input, context) =>
    listDeliveryTestReports(
      context.transaction.database,
      input,
      context.invocation.scope,
      () => readCapabilityTime(context),
    ),
};

const REPORT_CHANNEL_ORDER = Object.freeze([
  'push',
  'email',
  'sms',
] as const satisfies readonly NotificationChannel[]);

interface LoadedDeliveryTestRun {
  readonly run: typeof deliveryTestRuns.$inferSelect;
  readonly facilityId: string;
}

interface DerivedReportProjection {
  readonly status: 'succeeded' | 'failed' | 'incomplete';
  readonly channels: readonly DeliveryTestChannelReport[];
  readonly reasonCode: string | null;
  readonly automaticFinalizationReady: boolean;
}

function attemptReportState(
  value: 'accepted' | 'recorded' | AttemptDeliveryTruthState | undefined,
): AttemptDeliveryTruthState {
  if (value === undefined || value === 'attempted') return 'unknown';
  if (value === 'accepted' || value === 'recorded') {
    throw conflict('Intent evidence was retained as endpoint attempt truth.');
  }
  return value;
}

async function loadDeliveryTestRun(
  database: DeliveryTestQueryDatabase,
  runId: string,
): Promise<LoadedDeliveryTestRun | null> {
  const [row] = await database
    .select({
      run: deliveryTestRuns,
      facilityId: deliveryTestTargetSetVersions.facilityId,
    })
    .from(deliveryTestRuns)
    .innerJoin(
      deliveryTestTargetSetVersions,
      and(
        eq(
          deliveryTestRuns.targetSetVersionId,
          deliveryTestTargetSetVersions.id,
        ),
        eq(
          deliveryTestRuns.targetSetVersion,
          deliveryTestTargetSetVersions.version,
        ),
      ),
    )
    .where(eq(deliveryTestRuns.id, runId))
    .limit(1);
  return row ?? null;
}

async function resolveDeliveryTestRunByIntent(
  database: DeliveryTestQueryDatabase,
  intentId: string,
): Promise<LoadedDeliveryTestRun | null> {
  const [run] = await database
    .select({ id: deliveryTestRuns.id })
    .from(deliveryTestRuns)
    .where(eq(deliveryTestRuns.notificationIntentId, intentId))
    .limit(1);
  return run === undefined ? null : loadDeliveryTestRun(database, run.id);
}

async function deriveReportProjection(
  database: DeliveryTestQueryDatabase,
  loaded: LoadedDeliveryTestRun,
): Promise<DerivedReportProjection> {
  const run = loaded.run;
  const targetRows = await database
    .select({
      recipientId: deliveryTestTargetEndpoints.recipientId,
      endpointId: deliveryTestTargetEndpoints.endpointId,
      channel: deliveryTestTargetEndpoints.channel,
    })
    .from(deliveryTestTargetEndpoints)
    .where(
      and(
        eq(
          deliveryTestTargetEndpoints.targetSetVersionId,
          run.targetSetVersionId,
        ),
        eq(deliveryTestTargetEndpoints.targetSetVersion, run.targetSetVersion),
      ),
    )
    .orderBy(
      asc(deliveryTestTargetEndpoints.channel),
      asc(deliveryTestTargetEndpoints.recipientId),
      asc(deliveryTestTargetEndpoints.endpointId),
    );
  const targetKeys = new Set(targetRows.map(endpointKey));
  if (
    targetRows.length === 0 ||
    targetKeys.size !== targetRows.length ||
    deliveryTestEndpointReferenceDigest(targetRows) !==
      run.endpointReferenceDigest
  ) {
    throw conflict('The delivery-test run target evidence is inconsistent.');
  }

  const batches = await database
    .select({
      channel: dispatchBatches.channel,
      endpointCount: dispatchBatches.endpointCount,
    })
    .from(dispatchBatches)
    .where(eq(dispatchBatches.intentId, run.notificationIntentId))
    .orderBy(asc(dispatchBatches.sequence));
  const batchChannels = new Set(batches.map((batch) => batch.channel));
  const targetChannels = new Set(targetRows.map((target) => target.channel));
  let automaticFinalizationReady = batches.length === targetChannels.size;
  if (
    batchChannels.size !== batches.length ||
    batches.some((batch) => !targetChannels.has(batch.channel))
  ) {
    throw conflict('The delivery-test channel batches are inconsistent.');
  }
  for (const channel of targetChannels) {
    const batch = batches.find((candidate) => candidate.channel === channel);
    const endpointCount = targetRows.filter(
      (target) => target.channel === channel,
    ).length;
    if (batch === undefined || batch.endpointCount !== endpointCount) {
      automaticFinalizationReady = false;
    }
  }

  const attemptRows = await database
    .select({
      id: channelAttempts.id,
      recipientId: channelAttempts.recipientId,
      endpointId: channelAttempts.endpointId,
      channel: channelAttempts.channel,
      attemptNumber: channelAttempts.attemptNumber,
      attemptedAt: channelAttempts.attemptedAt,
    })
    .from(channelAttempts)
    .where(eq(channelAttempts.intentId, run.notificationIntentId))
    .orderBy(
      asc(channelAttempts.channel),
      asc(channelAttempts.recipientId),
      asc(channelAttempts.endpointId),
      desc(channelAttempts.attemptNumber),
      desc(channelAttempts.attemptedAt),
      desc(channelAttempts.id),
    );
  if (
    attemptRows.some(
      (attempt) =>
        !targetKeys.has(
          endpointKey({
            recipientId: attempt.recipientId,
            endpointId: attempt.endpointId,
            channel: attempt.channel,
          }),
        ),
    )
  ) {
    throw conflict('A delivery-test attempt escaped its approved target set.');
  }
  const latestAttemptByEndpoint = new Map<
    string,
    (typeof attemptRows)[number]
  >();
  for (const attempt of attemptRows) {
    const key = endpointKey(attempt);
    if (!latestAttemptByEndpoint.has(key)) {
      latestAttemptByEndpoint.set(key, attempt);
    }
  }

  const latestAttemptIds = [...latestAttemptByEndpoint.values()].map(
    (attempt) => attempt.id,
  );
  const evidenceRows =
    latestAttemptIds.length === 0
      ? []
      : await database
          .select({
            attemptId: deliveryEvidence.attemptId,
            sequence: deliveryEvidence.sequence,
            state: deliveryEvidence.state,
            recordedAt: deliveryEvidence.recordedAt,
          })
          .from(deliveryEvidence)
          .where(
            and(
              eq(deliveryEvidence.subjectKind, 'attempt'),
              inArray(deliveryEvidence.attemptId, latestAttemptIds),
            ),
          )
          .orderBy(
            asc(deliveryEvidence.attemptId),
            asc(deliveryEvidence.sequence),
          );
  const evidenceByAttempt = new Map<string, typeof evidenceRows>();
  for (const evidence of evidenceRows) {
    if (evidence.attemptId === null) continue;
    const rows = evidenceByAttempt.get(evidence.attemptId) ?? [];
    rows.push(evidence);
    evidenceByAttempt.set(evidence.attemptId, rows);
  }

  const channels = REPORT_CHANNEL_ORDER.flatMap((channel) => {
    const targets = targetRows.filter((target) => target.channel === channel);
    if (targets.length === 0) return [];
    const counts = new Map<AttemptDeliveryTruthState, number>();
    const providerAcceptedTimes: number[] = [];
    for (const target of targets) {
      const attempt = latestAttemptByEndpoint.get(endpointKey(target));
      const evidence =
        attempt === undefined ? [] : (evidenceByAttempt.get(attempt.id) ?? []);
      const latest = evidence.at(-1);
      const reportState = attemptReportState(latest?.state);
      counts.set(reportState, (counts.get(reportState) ?? 0) + 1);
      if (latest === undefined || latest.state === 'attempted') {
        automaticFinalizationReady = false;
      }
      const accepted = evidence.find(
        (item) =>
          item.state === 'provider-accepted' || item.state === 'delivered',
      );
      if (accepted !== undefined) {
        providerAcceptedTimes.push(new Date(accepted.recordedAt).getTime());
      }
    }
    const allProviderAccepted = providerAcceptedTimes.length === targets.length;
    const completedAtMs = allProviderAccepted
      ? Math.max(...providerAcceptedTimes)
      : null;
    const latency =
      completedAtMs === null
        ? null
        : Math.trunc(completedAtMs - new Date(run.startedAt).getTime());
    if (latency !== null && latency < 0) {
      throw conflict('Delivery-test provider evidence predates activation.');
    }
    return [
      assembleDeliveryTestChannelReport({
        channel,
        endpointCount: targets.length,
        activationToProviderAcceptMs: latency,
        latestStateCounts: Object.fromEntries(counts),
        completedAt:
          completedAtMs === null ? null : new Date(completedAtMs).toISOString(),
      }),
    ];
  });
  if (
    channels.length < 2 ||
    !channels.some((channel) => channel.channel === 'push') ||
    !channels.some((channel) => channel.channel === 'email')
  ) {
    throw conflict('The delivery-test target channels are incomplete.');
  }

  const states = channels.flatMap((channel) => channel.latestStateCounts);
  const failed = states.some(
    (row) =>
      row.count > 0 && (row.state === 'failed' || row.state === 'expired'),
  );
  const uncertain = states.some(
    (row) => row.count > 0 && row.state === 'unknown',
  );
  const status = failed ? 'failed' : uncertain ? 'incomplete' : 'succeeded';
  return Object.freeze({
    status,
    channels: Object.freeze(channels),
    reasonCode:
      status === 'failed'
        ? 'DELIVERY_TEST_PROVIDER_FAILURE'
        : status === 'incomplete'
          ? 'PROVIDER_TRUTH_PENDING'
          : null,
    automaticFinalizationReady,
  });
}

function sameTruthProjection(
  report: MonthlyDeliveryTestReport,
  projection: DerivedReportProjection,
  source: 'worker',
): boolean {
  return (
    report.source === source &&
    report.status === projection.status &&
    report.reasonCode === projection.reasonCode &&
    digestCapabilityValue(report.channels) ===
      digestCapabilityValue(projection.channels)
  );
}

async function loadDeliveryTestReportById(
  database: DeliveryTestQueryDatabase,
  reportId: string,
): Promise<MonthlyDeliveryTestReport | null> {
  const [row] = await database
    .select()
    .from(deliveryTestReports)
    .where(eq(deliveryTestReports.id, reportId))
    .limit(1);
  return row === undefined ? null : reportFromRow(row);
}

async function finalizeDeliveryTestReport(
  database: DeliveryTestQueryDatabase,
  input: CapabilityInput<'finalize-delivery-test-report'>,
  invocation: TrustedCapabilityInvocation,
  readCurrentTime: () => Promise<Date>,
): Promise<MonthlyDeliveryTestReport> {
  if (invocation.actor.kind !== 'system' || invocation.source !== 'worker') {
    throw forbidden('Delivery-test reports are finalized by a worker only.');
  }
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`delivery-test-report:${input.runId}`}, 31))`,
  );
  const loaded = await loadDeliveryTestRun(database, input.runId);
  if (loaded === null) {
    throw conflict('The delivery-test run is unavailable.');
  }
  const projection = await deriveReportProjection(database, loaded);
  const [latestRow] = await database
    .select()
    .from(deliveryTestReports)
    .where(eq(deliveryTestReports.runId, input.runId))
    .orderBy(desc(deliveryTestReports.sequence))
    .for('update')
    .limit(1);
  const latest = latestRow === undefined ? null : reportFromRow(latestRow);
  if (
    latest !== null &&
    sameTruthProjection(latest, projection, invocation.source)
  ) {
    return latest;
  }
  // Projection reads can wait behind evidence writers. Capture the canonical
  // report time only after those reads so completedAt can never race ahead of
  // generatedAt.
  const now = await readCurrentTime();
  const report = assembleMonthlyDeliveryTestReport({
    id: randomUUID(),
    run: {
      id: loaded.run.id,
      activationPreviewId: loaded.run.activationPreviewId,
      eventId: loaded.run.eventId,
      notificationIntentId: loaded.run.notificationIntentId,
      targetSet: {
        id: loaded.run.targetSetVersionId,
        version: loaded.run.targetSetVersion,
      },
      endpointReferenceDigest: loaded.run.endpointReferenceDigest,
      consequenceDigest: loaded.run.consequenceDigest,
      confirmationId: loaded.run.confirmationId,
      startedByUserId: loaded.run.startedByUserId,
      startedWithSessionId: loaded.run.startedWithSessionId,
      startedAt: dateIso(loaded.run.startedAt),
    },
    sequence: (latest?.sequence ?? 0) + 1,
    supersedesReportId: latest?.id ?? null,
    status: projection.status,
    channels: projection.channels,
    generatedAt: now.toISOString(),
    finalizedByServiceId: invocation.actor.serviceId,
    source: invocation.source,
    reasonCode: projection.reasonCode,
  });
  await database.insert(deliveryTestReports).values({
    id: report.id,
    runId: report.runId,
    runStartedAt: loaded.run.startedAt,
    sequence: report.sequence,
    supersedesReportId: report.supersedesReportId,
    status: report.status,
    channels: report.channels,
    generatedAt: new Date(report.generatedAt),
    finalizedBy: report.finalizedBy,
    source: report.source,
    reasonCode: report.reasonCode,
  });
  return report;
}

interface ReportResultReference {
  readonly id: string;
  readonly digest: string;
}

function reportResultReference(output: MonthlyDeliveryTestReport): string {
  return Buffer.from(
    JSON.stringify({ id: output.id, digest: digestCapabilityValue(output) }),
    'utf8',
  ).toString('base64url');
}

function parseReportResultReference(value: string): ReportResultReference {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Readonly<Record<string, unknown>>;
    const id = UuidSchema.parse(parsed.id);
    if (
      typeof parsed.digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.digest)
    ) {
      throw new TypeError();
    }
    return { id, digest: parsed.digest };
  } catch {
    throw conflict('The report idempotency result is invalid.');
  }
}

async function reportFacilityId(
  database: DeliveryTestQueryDatabase,
  reportId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ facilityId: deliveryTestTargetSetVersions.facilityId })
    .from(deliveryTestReports)
    .innerJoin(
      deliveryTestRuns,
      eq(deliveryTestReports.runId, deliveryTestRuns.id),
    )
    .innerJoin(
      deliveryTestTargetSetVersions,
      and(
        eq(
          deliveryTestRuns.targetSetVersionId,
          deliveryTestTargetSetVersions.id,
        ),
        eq(
          deliveryTestRuns.targetSetVersion,
          deliveryTestTargetSetVersions.version,
        ),
      ),
    )
    .where(eq(deliveryTestReports.id, reportId))
    .limit(1);
  return row?.facilityId ?? null;
}

export const finalizeDeliveryTestReportRegistration: ServerCapabilityRegistration<
  'finalize-delivery-test-report',
  DeliveryTestCapabilityTransaction
> = {
  id: 'finalize-delivery-test-report',
  async resolveFacilityId(input, context) {
    const run = await loadDeliveryTestRun(
      context.transaction.database,
      input.runId,
    );
    return run?.facilityId ?? null;
  },
  async handler(input, context) {
    return finalizeDeliveryTestReport(
      context.transaction.database,
      input,
      context.invocation,
      () => readCapabilityTime(context),
    );
  },
  resultReference: reportResultReference,
  async loadReplay(reference, context) {
    const parsed = parseReportResultReference(reference);
    const report = await loadDeliveryTestReportById(
      context.transaction.database,
      parsed.id,
    );
    const facilityId = await reportFacilityId(
      context.transaction.database,
      parsed.id,
    );
    if (
      report === null ||
      facilityId === null ||
      !scopeAllowsFacility(context.invocation.scope, facilityId) ||
      digestCapabilityValue(report) !== parsed.digest
    ) {
      throw conflict('The original delivery-test report is unavailable.');
    }
    return report;
  },
  resolveReplayFacilityId(reference) {
    parseReportResultReference(reference);
    // The strict destination-free report contract intentionally has no
    // facility field. loadReplay rechecks the persisted facility scope before
    // returning; null keeps the engine's output/facility consistency exact.
    return null;
  },
  replayFacilityId: () => null,
};

/**
 * Resolves a run only when its exact pinned endpoint projection is terminal.
 * The worker may call this after every committed fact, but report writes occur
 * only at bounded aggregate terminal boundaries. Explicit worker finalization
 * by run ID may retain an incomplete/unknown snapshot when needed.
 */
export async function resolveReadyDeliveryTestReportRunIdByIntent(
  databaseValue: unknown,
  intentId: string,
): Promise<string | null> {
  const database = queryDatabase(databaseValue);
  const loaded = await resolveDeliveryTestRunByIntent(database, intentId);
  if (loaded === null) return null;
  const projection = await deriveReportProjection(database, loaded);
  if (!projection.automaticFinalizationReady) return null;
  const [latestRow] = await database
    .select()
    .from(deliveryTestReports)
    .where(eq(deliveryTestReports.runId, loaded.run.id))
    .orderBy(desc(deliveryTestReports.sequence))
    .limit(1);
  return latestRow !== undefined &&
    sameTruthProjection(reportFromRow(latestRow), projection, 'worker')
    ? null
    : loaded.run.id;
}

/** Runtime shared by agent report reads and system report finalization. */
export interface DeliveryTestReportRuntime {
  readonly store: DeliveryTestCapabilityStore;
  execute(
    input: unknown,
    invocation: TrustedCapabilityInvocation,
    authenticated?: AuthenticatedAgentApiKey | AuthenticatedSession,
  ): Promise<CapabilityOutput<'list-delivery-test-reports'>>;
  finalize(
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<'finalize-delivery-test-report'>>;
  finalizeByIntent(
    intentId: string,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<'finalize-delivery-test-report'> | null>;
  close(): Promise<void>;
}

export interface CreateDeliveryTestTargetSetVersionExecution {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'create-delivery-test-target-set-version'>;
  readonly metadata: AdminMutationMetadata;
  readonly store?: AdminCapabilityStore;
}

export interface RecordDeliveryTestCanaryEligibilityExecution {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'record-delivery-test-canary-eligibility'>;
  readonly metadata: AdminMutationMetadata;
  readonly store?: AdminCapabilityStore;
}

export interface ListDeliveryTestReportsExecution {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'list-delivery-test-reports'>;
  readonly metadata?: AdminQueryMetadata;
  readonly runtime?: DeliveryTestReportRuntime;
}

export function executeCreateDeliveryTestTargetSetVersion(
  input: CreateDeliveryTestTargetSetVersionExecution,
): Promise<CapabilityOutput<'create-delivery-test-target-set-version'>> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  return executeAdminMutationCapability(
    createDeliveryTestTargetSetVersionRegistration,
    input.command,
    input.authenticated,
    store,
    input.metadata,
  );
}

export function executeRecordDeliveryTestCanaryEligibility(
  input: RecordDeliveryTestCanaryEligibilityExecution,
): Promise<CapabilityOutput<'record-delivery-test-canary-eligibility'>> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  return executeAdminMutationCapability(
    recordDeliveryTestCanaryEligibilityRegistration,
    input.command,
    input.authenticated,
    store,
    input.metadata,
  );
}

export function executeListDeliveryTestReports(
  input: ListDeliveryTestReportsExecution,
): Promise<CapabilityOutput<'list-delivery-test-reports'>> {
  const invocation = resolveHumanCapabilityInvocation(input.authenticated, {
    requestId: input.metadata?.requestId ?? randomUUID(),
    mutation: null,
    ...(input.metadata?.now === undefined
      ? {}
      : { serverTime: input.metadata.now }),
  });
  const runtime = input.runtime ?? getDefaultDeliveryTestReportRuntime();
  return runtime.execute(input.command, invocation, input.authenticated);
}

export function assertAuthenticatedDeliveryTestReportInvocation(
  invocation: TrustedCapabilityInvocation,
  authenticated: AuthenticatedAgentApiKey | AuthenticatedSession | undefined,
): void {
  if (invocation.actor.kind === 'agent') {
    const authenticatedAgent =
      authenticated !== undefined && 'capabilityIds' in authenticated
        ? authenticated
        : undefined;
    if (
      authenticatedAgent === undefined ||
      authenticatedAgent.actor.agentId !== invocation.actor.agentId ||
      authenticatedAgent.actor.apiKeyId !== invocation.actor.apiKeyId ||
      !sameScope(authenticatedAgent.scope, invocation.scope) ||
      !authenticatedAgent.capabilityIds.includes(
        'list-delivery-test-reports',
      ) ||
      (invocation.source !== 'agent-rest' && invocation.source !== 'mcp')
    ) {
      throw forbidden('The agent report invocation is not authenticated.');
    }
    return;
  }
  if (invocation.actor.kind === 'human') {
    const authenticatedHuman =
      authenticated !== undefined && 'source' in authenticated
        ? authenticated
        : undefined;
    if (
      authenticatedHuman === undefined ||
      authenticatedHuman.actor.userId !== invocation.actor.userId ||
      authenticatedHuman.actor.sessionId !== invocation.actor.sessionId ||
      authenticatedHuman.source !== invocation.source ||
      !sameScope(authenticatedHuman.scope, invocation.scope)
    ) {
      throw forbidden('The human report invocation is not authenticated.');
    }
    return;
  }
  throw forbidden('Delivery-test reports require a human or agent reader.');
}

export function executeFinalizeDeliveryTestReport(
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  storeOrRuntime: DeliveryTestCapabilityStore | DeliveryTestReportRuntime,
): Promise<CapabilityOutput<'finalize-delivery-test-report'>> {
  const store =
    'store' in storeOrRuntime ? storeOrRuntime.store : storeOrRuntime;
  return executeCapability(
    finalizeDeliveryTestReportRegistration,
    input,
    invocation,
    store,
  );
}

/** Builds the destination-free report runtime around one managed connection. */
export function createDeliveryTestReportRuntime(
  connection: DatabaseConnection,
): DeliveryTestReportRuntime {
  const store = createDrizzleDeliveryTestCapabilityStore(connection.db);
  return Object.freeze({
    store,
    execute(
      input: unknown,
      invocation: TrustedCapabilityInvocation,
      authenticated?: AuthenticatedAgentApiKey | AuthenticatedSession,
    ) {
      assertAuthenticatedDeliveryTestReportInvocation(
        invocation,
        authenticated,
      );
      return executeCapability(
        listDeliveryTestReportsRegistration,
        input,
        invocation,
        store,
      );
    },
    finalize: (input: unknown, invocation: TrustedCapabilityInvocation) =>
      executeFinalizeDeliveryTestReport(input, invocation, store),
    async finalizeByIntent(
      intentId: string,
      invocation: TrustedCapabilityInvocation,
    ) {
      const parsedIntentId = UuidSchema.parse(intentId);
      const runId = await resolveReadyDeliveryTestReportRunIdByIntent(
        connection.db,
        parsedIntentId,
      );
      return runId === null
        ? null
        : executeFinalizeDeliveryTestReport({ runId }, invocation, store);
    },
    close: () => connection.close(),
  });
}

let defaultDeliveryTestReportRuntime: DeliveryTestReportRuntime | undefined;

export function getDefaultDeliveryTestReportRuntime(): DeliveryTestReportRuntime {
  defaultDeliveryTestReportRuntime ??= createDeliveryTestReportRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultDeliveryTestReportRuntime;
}

export async function closeDefaultDeliveryTestReportRuntime(): Promise<void> {
  const runtime = defaultDeliveryTestReportRuntime;
  defaultDeliveryTestReportRuntime = undefined;
  await runtime?.close();
}
