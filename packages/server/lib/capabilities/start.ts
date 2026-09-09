import { randomUUID } from 'node:crypto';

import {
  ActivationPreviewSchema,
  ChannelConfigurationSchema,
  EndpointSchema,
  FacilityPageSchema,
  FacilitySchema,
  RecipientSchema,
  RosterGroupSourceRefSchema,
  RosterSnapshotSchema,
  ThreatPageSchema,
  ThreatSchema,
  type ActivationPreview,
  type ActivationSelection,
  type ActivationThreat,
  type Actor,
  type CapabilityInput,
  type CapabilityOutput,
  type CapabilityScope,
  type ChannelConfiguration,
  type FacilityPage,
  type GroupSourceKind,
  type RegisteredCapabilityId,
  type RosterGroupSourceRef,
  type RosterPopulation,
  type RosterSnapshot,
  type ThreatPage,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../db/client';
import {
  activationPreviews,
  agents,
  channelConfigurations,
  events,
  eventTypes,
  eventTypeVersions,
  facilities,
  groupSources,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshotSources,
  rosterSnapshots,
  securityAuditEntries,
  threats,
  users,
} from '../../db/schema';
import {
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  toSecurityAuditInsertValues,
} from '../audit/drizzle-repository';
import { buildSecurityAuditEntry } from '../audit/entry';
import { parseSecurityAuditFact } from '../audit/model';
import {
  CapabilityEngineError,
  executeAuditedCapabilityTransaction,
  readCapabilityTime,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';
import { DrizzleEventTypeStore, EventTypeCapabilityError } from './event-types';
import { AudienceResolutionError } from '../roster/resolve';
import {
  BoundedDatabaseQueryError,
  START_FLOW_DATABASE_PAGE_SIZE,
  collectBoundedDatabaseRows,
  START_FLOW_ENDPOINT_PAGE_SIZE,
} from './start-bounded-query';
import {
  ActivationPreviewBuildError,
  activationThreatFromColumns,
  buildActivationPreview,
} from './start-preview';

type StartFlowCapabilityId = Extract<
  RegisteredCapabilityId,
  'create-activation-preview' | 'list-facilities' | 'list-threats'
>;

type StartFlowQueryDatabase = DatabaseQuery;

// Defensive query ceilings mirror the canonical roster contract. The Zod
// schemas remain the source of truth and validate every assembled row.
const ROSTER_QUERY_LIMITS = Object.freeze({
  endpoints: 1_200 * 10,
  facilities: 200,
  provenance: 1_200 * 50,
  recipients: 1_200,
  sources: 500 * 2,
});

/** Persistence boundary for the two query capabilities owned by start flow. */
export interface StartFlowCapabilityTransaction
  extends CapabilityEngineTransaction {
  listFacilities(
    input: CapabilityInput<'list-facilities'>,
    scope: CapabilityScope,
  ): Promise<FacilityPage>;
  listThreats(input: CapabilityInput<'list-threats'>): Promise<ThreatPage>;
  createActivationPreview(
    input: CapabilityInput<'create-activation-preview'>,
    actor: Actor,
    now: Date,
  ): Promise<ActivationPreview>;
}

export type StartFlowCapabilityStore =
  CapabilityEngineStore<StartFlowCapabilityTransaction>;

interface RosterSnapshotHydrationCache {
  snapshot: RosterSnapshot | null;
}

function conflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
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

/** A selection the catalog refuses: the client must change what it asked for. */
function invalidSelection(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'VALIDATION_ERROR',
    'CAPABILITY_INPUT_INVALID',
    message,
    400,
  );
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function decodeOffsetCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/u.test(decoded)) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'PERSISTENCE_CONFLICT',
      'The pagination cursor is invalid.',
      400,
    );
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'PERSISTENCE_CONFLICT',
      'The pagination cursor is invalid.',
      400,
    );
  }
  return offset;
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function startFlowQueryDatabase(database: unknown): StartFlowQueryDatabase {
  // Both configured Drizzle transports expose this schema-aware query API;
  // raw execute results are normalized at the consumers that read rows.
  return database as StartFlowQueryDatabase;
}

function eventTypeStoreDatabase(database: StartFlowQueryDatabase): Database {
  // DrizzleEventTypeStore consumes only transport-normalized query builders.
  // Keep it on this transaction while adapting its existing Database input.
  return database as unknown as Database;
}

async function readDatabaseTime(
  database: StartFlowQueryDatabase,
): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw unavailable('The authoritative database clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

async function appendCapabilityAuditEntry(
  database: StartFlowQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  await database.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
  const [previous] = await database
    .select({
      sequence: securityAuditEntries.sequence,
      entryHash: securityAuditEntries.entryHash,
    })
    .from(securityAuditEntries)
    .orderBy(desc(securityAuditEntries.sequence))
    .limit(1);
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
  const entry = buildSecurityAuditEntry(fact, previous ?? null);
  await database
    .insert(securityAuditEntries)
    .values(toSecurityAuditInsertValues(entry));
}

function unsupportedQueryMutationMethod(): never {
  throw new CapabilityEngineError(
    'INTERNAL_ERROR',
    'MUTATION_METADATA_INVALID',
    'A query-only start-flow capability reached mutation persistence.',
    500,
  );
}

function facilityFromRow(row: typeof facilities.$inferSelect) {
  return FacilitySchema.parse({
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    isolated: row.isolated,
    createdAt: dateIso(row.createdAt),
  });
}

async function listFacilitiesFromDatabase(
  database: StartFlowQueryDatabase,
  input: CapabilityInput<'list-facilities'>,
  scope: CapabilityScope,
): Promise<FacilityPage> {
  const offset = decodeOffsetCursor(input.cursor);
  const scopeCondition =
    scope.facilityScope.kind === 'district'
      ? undefined
      : inArray(facilities.id, [...scope.facilityScope.facilityIds]);
  const activityCondition = input.includeInactive
    ? undefined
    : eq(facilities.active, true);
  const rows = await database
    .select()
    .from(facilities)
    .where(
      scopeCondition === undefined
        ? activityCondition
        : activityCondition === undefined
          ? scopeCondition
          : and(scopeCondition, activityCondition),
    )
    .orderBy(asc(facilities.name), asc(facilities.code), asc(facilities.id))
    .offset(offset)
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = hasMore ? rows.slice(0, input.limit) : rows;
  return FacilityPageSchema.parse({
    items: selected.map(facilityFromRow),
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeOffsetCursor(offset + selected.length) : null,
    },
  });
}

function threatFromRow(row: typeof threats.$inferSelect) {
  return ThreatSchema.parse({
    id: row.id,
    key: row.key,
    name: row.name,
    sortOrder: row.sortOrder,
    requiresDetail: row.requiresDetail,
    active: row.active,
    createdAt: dateIso(row.createdAt),
  });
}

/**
 * Threats are district vocabulary rather than facility data, so every
 * authenticated staff member sees the same list, alphabetically.
 */
async function listThreatsFromDatabase(
  database: StartFlowQueryDatabase,
  input: CapabilityInput<'list-threats'>,
): Promise<ThreatPage> {
  const offset = decodeOffsetCursor(input.cursor);
  const rows = await database
    .select()
    .from(threats)
    .where(input.includeInactive ? undefined : eq(threats.active, true))
    // Alphabetical, because that is how a person scans a list under
    // pressure (the district's request of 2026-09-09); the one that needs a
    // description, "Other", comes last as the catch-all. The declared
    // position is still recorded on the row but no longer orders the list.
    .orderBy(
      asc(threats.requiresDetail),
      asc(sql`lower(${threats.name})`),
      asc(threats.id),
    )
    .offset(offset)
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const selected = hasMore ? rows.slice(0, input.limit) : rows;
  return ThreatPageSchema.parse({
    items: selected.map(threatFromRow),
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeOffsetCursor(offset + selected.length) : null,
    },
  });
}

function rosterGroupSourceRef(
  value: Readonly<{
    id: string;
    kind: GroupSourceKind;
    purpose: 'building' | 'others';
    facilityId: string | null;
  }>,
): RosterGroupSourceRef {
  return RosterGroupSourceRefSchema.parse(value);
}

export async function loadRosterSnapshot(
  database: StartFlowQueryDatabase,
  population: RosterPopulation,
  facilityId: string,
  exactSnapshotId?: string,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<RosterSnapshot | null> {
  const [snapshot] = await database
    .select({ snapshot: rosterSnapshots })
    .from(rosterSnapshots)
    .innerJoin(
      rosterSnapshotFacilities,
      eq(rosterSnapshotFacilities.rosterSnapshotId, rosterSnapshots.id),
    )
    .where(
      and(
        eq(rosterSnapshots.population, population),
        eq(rosterSnapshots.complete, true),
        eq(rosterSnapshotFacilities.facilityId, facilityId),
        exactSnapshotId === undefined
          ? undefined
          : eq(rosterSnapshots.id, exactSnapshotId),
      ),
    )
    .orderBy(
      desc(rosterSnapshots.version),
      desc(rosterSnapshots.capturedAt),
      asc(rosterSnapshots.id),
    )
    .limit(1);
  if (snapshot === undefined) {
    return null;
  }
  const snapshotId = snapshot.snapshot.id;
  const cached = hydrationCache?.snapshot;
  if (
    cached !== null &&
    cached !== undefined &&
    cached.id === snapshotId &&
    cached.population === population &&
    cached.facilityIds.includes(facilityId)
  ) {
    return cached;
  }
  const facilityRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select({ facilityId: rosterSnapshotFacilities.facilityId })
        .from(rosterSnapshotFacilities)
        .where(eq(rosterSnapshotFacilities.rosterSnapshotId, snapshotId))
        .orderBy(asc(rosterSnapshotFacilities.facilityId))
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.facilities },
  );
  // Isolation is the facility's own rule, read as it stands now: an isolated
  // facility's events reach its own lists only, whichever snapshot they use.
  const isolatedRows =
    facilityRows.length === 0
      ? []
      : await database
          .select({ facilityId: facilities.id })
          .from(facilities)
          .where(
            and(
              inArray(
                facilities.id,
                facilityRows.map((row) => row.facilityId),
              ),
              eq(facilities.isolated, true),
            ),
          )
          .orderBy(asc(facilities.id));
  const sourceRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select({
          completionKind: rosterSnapshotSources.completionKind,
          id: groupSources.id,
          kind: groupSources.kind,
          purpose: groupSources.purpose,
          facilityId: groupSources.facilityId,
        })
        .from(rosterSnapshotSources)
        .innerJoin(
          groupSources,
          eq(groupSources.id, rosterSnapshotSources.groupSourceId),
        )
        .where(eq(rosterSnapshotSources.rosterSnapshotId, snapshotId))
        .orderBy(
          asc(rosterSnapshotSources.completionKind),
          asc(rosterSnapshotSources.groupSourceId),
        )
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.sources },
  );
  const recipientRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select()
        .from(rosterRecipients)
        .where(eq(rosterRecipients.rosterSnapshotId, snapshotId))
        .orderBy(asc(rosterRecipients.id))
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.recipients },
  );
  const provenanceRows = await collectBoundedDatabaseRows(
    (offset, limit) =>
      database
        .select({
          recipientId: rosterRecipientGroupSources.recipientId,
          id: groupSources.id,
          kind: groupSources.kind,
          purpose: groupSources.purpose,
          facilityId: groupSources.facilityId,
        })
        .from(rosterRecipientGroupSources)
        .innerJoin(
          groupSources,
          eq(groupSources.id, rosterRecipientGroupSources.groupSourceId),
        )
        .where(eq(rosterRecipientGroupSources.rosterSnapshotId, snapshotId))
        .orderBy(
          asc(rosterRecipientGroupSources.recipientId),
          asc(rosterRecipientGroupSources.groupSourceId),
        )
        .offset(offset)
        .limit(limit),
    { maxRows: ROSTER_QUERY_LIMITS.provenance },
  );
  const endpointRows: Array<typeof rosterEndpoints.$inferSelect> = [];
  // Push tokens have a much larger contract ceiling than email addresses or
  // phone numbers. Keep push pages at the conservative Data API bound while
  // reading the two compact channel shapes in normal bounded pages. This
  // preserves the aggregate endpoint ceiling without forcing every compact
  // row through worst-case push-token pagination.
  for (const channel of ['push', 'email', 'sms'] as const) {
    const channelRows = await collectBoundedDatabaseRows(
      (offset, limit) =>
        database
          .select()
          .from(rosterEndpoints)
          .where(
            and(
              eq(rosterEndpoints.rosterSnapshotId, snapshotId),
              eq(rosterEndpoints.channel, channel),
            ),
          )
          .orderBy(asc(rosterEndpoints.recipientId), asc(rosterEndpoints.id))
          .offset(offset)
          .limit(limit),
      {
        maxRows: ROSTER_QUERY_LIMITS.endpoints - endpointRows.length,
        pageSize:
          channel === 'push'
            ? START_FLOW_ENDPOINT_PAGE_SIZE
            : START_FLOW_DATABASE_PAGE_SIZE,
      },
    );
    endpointRows.push(...channelRows);
  }
  endpointRows.sort(
    (left, right) =>
      left.recipientId.localeCompare(right.recipientId) ||
      left.id.localeCompare(right.id),
  );

  const groupRefsForRecipient = new Map<string, RosterGroupSourceRef[]>();
  for (const row of provenanceRows) {
    if (row.purpose === 'access') {
      throw conflict('The roster contains an invalid access-group source.');
    }
    const references = groupRefsForRecipient.get(row.recipientId) ?? [];
    references.push(
      rosterGroupSourceRef({
        id: row.id,
        kind: row.kind,
        purpose: row.purpose,
        facilityId: row.facilityId,
      }),
    );
    groupRefsForRecipient.set(row.recipientId, references);
  }

  const endpointsForRecipient = new Map<
    string,
    Array<ReturnType<typeof EndpointSchema.parse>>
  >();
  for (const row of endpointRows) {
    const common = {
      id: row.id,
      status: row.status,
      capturedAt: dateIso(row.capturedAt),
    };
    const endpoint = EndpointSchema.parse(
      row.channel === 'push'
        ? {
            ...common,
            channel: row.channel,
            platform: row.platform,
            provider: row.provider,
            serviceEnvironment: row.serviceEnvironment,
            token: row.token,
          }
        : row.channel === 'email'
          ? { ...common, channel: row.channel, email: row.email }
          : { ...common, channel: row.channel, phoneNumber: row.phoneNumber },
    );
    const endpoints = endpointsForRecipient.get(row.recipientId) ?? [];
    endpoints.push(endpoint);
    endpointsForRecipient.set(row.recipientId, endpoints);
  }

  const recipients = recipientRows.map((row) =>
    RecipientSchema.parse({
      id: row.id,
      population: row.population,
      googleSubject: row.googleSubject,
      ...(row.staffEmail === null ? {} : { staffEmail: row.staffEmail }),
      displayName: row.displayName,
      groupSourceRefs: groupRefsForRecipient.get(row.id) ?? [],
      endpoints: endpointsForRecipient.get(row.id) ?? [],
    }),
  );
  const parsedSources = sourceRows.map((row) => {
    if (row.purpose === 'access') {
      throw conflict('The roster contains an invalid access-group source.');
    }
    return {
      completionKind: row.completionKind,
      reference: rosterGroupSourceRef({
        id: row.id,
        kind: row.kind,
        purpose: row.purpose,
        facilityId: row.facilityId,
      }),
    };
  });

  const parsed = RosterSnapshotSchema.parse({
    id: snapshot.snapshot.id,
    version: snapshot.snapshot.version,
    population: snapshot.snapshot.population,
    complete: true,
    sourceConfiguration: {
      id: snapshot.snapshot.sourceConfigurationId,
      version: snapshot.snapshot.sourceConfigurationVersion,
    },
    facilityIds: facilityRows.map((row) => row.facilityId),
    isolatedFacilityIds: isolatedRows.map((row) => row.facilityId),
    expectedSourceGroupRefs: parsedSources
      .filter((source) => source.completionKind === 'expected')
      .map((source) => source.reference),
    sourceGroupRefs: parsedSources
      .filter((source) => source.completionKind === 'completed')
      .map((source) => source.reference),
    recipients,
    syncStartedAt: dateIso(snapshot.snapshot.syncStartedAt),
    capturedAt: dateIso(snapshot.snapshot.capturedAt),
  });
  if (hydrationCache !== undefined) {
    hydrationCache.snapshot = parsed;
  }
  return parsed;
}

async function loadChannelConfigurations(
  database: StartFlowQueryDatabase,
): Promise<readonly ChannelConfiguration[]> {
  const rows = await database
    .select()
    .from(channelConfigurations)
    .where(
      inArray(channelConfigurations.integrationId, [
        'mobile-push',
        'ses-email',
        'aws-eum-sms',
      ]),
    )
    .orderBy(asc(channelConfigurations.integrationId));
  return rows.map((configuration) =>
    ChannelConfigurationSchema.parse({
      integrationId: configuration.integrationId,
      enabled: configuration.enabled,
      changedAt: dateIso(configuration.changedAt),
    }),
  );
}

async function loadInitiatorDisplayName(
  database: StartFlowQueryDatabase,
  actor: Actor,
): Promise<string | null> {
  switch (actor.kind) {
    case 'human': {
      const [row] = await database
        .select({ displayName: users.displayName })
        .from(users)
        .where(
          and(eq(users.id, actor.userId), sql`${users.disabledAt} is null`),
        )
        .limit(1);
      return row?.displayName ?? null;
    }
    case 'agent': {
      const [row] = await database
        .select({ displayName: agents.displayName })
        .from(agents)
        .where(eq(agents.id, actor.agentId))
        .limit(1);
      return row?.displayName ?? null;
    }
    case 'system':
      return null;
  }
}

function mapPreviewConstructionError(error: unknown): never {
  if (error instanceof CapabilityEngineError) {
    throw error;
  }
  if (error instanceof EventTypeCapabilityError) {
    if (error.code === 'NOT_FOUND') {
      throw unavailable('The selected event type is unavailable.');
    }
    throw conflict('The selected event type is inconsistent.');
  }
  if (error instanceof BoundedDatabaseQueryError) {
    throw conflict(
      'The activation consequence data exceeds its supported query bounds.',
    );
  }
  if (error instanceof ActivationPreviewBuildError) {
    switch (error.code) {
      case 'FACILITY_UNAVAILABLE':
      case 'EVENT_TYPE_UNAVAILABLE':
      case 'AUDIENCE_UNAVAILABLE':
      case 'CHANNEL_CONFIGURATION_UNAVAILABLE':
      case 'INITIATOR_UNAVAILABLE':
        throw unavailable(error.message);
      case 'PREVIEW_TIME_INVALID':
        throw conflict(error.message);
    }
  }
  if (error instanceof AudienceResolutionError) {
    throw unavailable(error.message);
  }
  throw error;
}

interface ActivationChoice {
  readonly threat: ActivationThreat | null;
  readonly responseDetail: string | null;
}

/**
 * Resolves the operator's threat and detail choices against the catalog
 * before any consequence is computed: an unknown or retired threat is
 * refused, and a description is accepted exactly when the chosen catalog
 * entry requires one. Nothing here is trusted from the client beyond ids and
 * the operator's own words.
 */
async function createActivationPreviewFromDatabase(
  database: StartFlowQueryDatabase,
  input: CapabilityInput<'create-activation-preview'>,
  actor: Actor,
  now: Date,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<ActivationPreview> {
  try {
    const [threatRow] = await database
      .select()
      .from(threats)
      .where(eq(threats.id, input.threatId))
      .limit(1);
    if (threatRow === undefined || !threatRow.active) {
      throw unavailable('The selected threat is unavailable.');
    }
    if (threatRow.requiresDetail !== (input.threatDetail !== null)) {
      throw invalidSelection(
        threatRow.requiresDetail
          ? 'The selected threat requires a short description.'
          : 'The selected threat does not take a description.',
      );
    }
    const [responseIdentity] = await database
      .select({ requiresDetail: eventTypes.requiresDetail })
      .from(eventTypeVersions)
      .innerJoin(eventTypes, eq(eventTypes.id, eventTypeVersions.eventTypeId))
      .where(eq(eventTypeVersions.id, input.eventTypeVersion.id))
      .limit(1);
    if (responseIdentity === undefined) {
      throw unavailable('The selected event type is unavailable.');
    }
    if (responseIdentity.requiresDetail !== (input.responseDetail !== null)) {
      throw invalidSelection(
        responseIdentity.requiresDetail
          ? 'The selected response requires a short description.'
          : 'The selected response does not take a description.',
      );
    }
    const { threatId, threatDetail, responseDetail, ...selection } = input;
    return await createActivationPreviewRecord(
      database,
      selection,
      {
        threat: { id: threatId, name: threatRow.name, detail: threatDetail },
        responseDetail,
      },
      actor,
      now,
      hydrationCache,
    );
  } catch (error) {
    mapPreviewConstructionError(error);
  }
}

async function createActivationPreviewRecord(
  database: StartFlowQueryDatabase,
  selection: ActivationSelection,
  choice: ActivationChoice,
  actor: Actor,
  now: Date,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<ActivationPreview> {
  const input = selection;
  try {
    // The Data API permits only one in-flight statement for a transaction ID.
    // Keep every independent consequence read explicitly sequential.
    const facilityRows = await database
      .select()
      .from(facilities)
      .where(eq(facilities.id, input.facilityId))
      .limit(1);
    const facilityRow = facilityRows[0] ?? null;
    const rosterSnapshot = await loadRosterSnapshot(
      database,
      input.rosterPopulation,
      input.facilityId,
      undefined,
      hydrationCache,
    );
    const channelConfigurationsValue =
      await loadChannelConfigurations(database);
    if (facilityRow === null || !facilityRow.active) {
      throw unavailable('The selected facility is unavailable.');
    }
    if (rosterSnapshot === null) {
      throw unavailable('A complete roster snapshot is unavailable.');
    }
    const eventTypeVersion = await new DrizzleEventTypeStore(
      eventTypeStoreDatabase(database),
    ).getVersion({
      eventTypeVersionId: input.eventTypeVersion.id,
    });
    const initiatorDisplayName = await loadInitiatorDisplayName(
      database,
      actor,
    );
    const activeEventRows = await database
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.facilityId, input.facilityId),
          eq(events.status, 'active'),
        ),
      )
      .orderBy(asc(events.id))
      .limit(101);
    if (initiatorDisplayName === null) {
      throw unavailable('The initiating identity is unavailable.');
    }
    const preview = buildActivationPreview({
      id: randomUUID(),
      selection: input,
      threat: choice.threat,
      responseDetail: choice.responseDetail,
      facility: facilityFromRow(facilityRow),
      eventTypeVersion,
      rosterSnapshot,
      channelConfigurations: channelConfigurationsValue,
      activeEventIds: activeEventRows.map((row) => row.id),
      initiator: actor,
      initiatorDisplayName,
      createdAt: now,
    });
    await database.insert(activationPreviews).values({
      id: preview.id,
      facilityId: preview.facilityId,
      kind: preview.kind,
      templateMode: preview.templateMode,
      eventTypeVersionId: preview.eventTypeVersion.id,
      rosterSnapshotId: preview.rosterSnapshotId,
      rosterPopulation: preview.rosterPopulation,
      threatId: preview.threat?.id ?? null,
      threatName: preview.threat?.name ?? null,
      threatDetail: preview.threat?.detail ?? null,
      responseDetail: preview.responseDetail,
      recipientCount: preview.recipientCount,
      channels: preview.channels,
      sendReadiness: preview.sendReadiness,
      blockingReasonCodes: preview.blockingReasonCodes,
      activeEventIds: preview.activeEventIds,
      consequenceDigest: preview.consequenceDigest,
      createdAt: new Date(preview.createdAt),
      expiresAt: new Date(preview.expiresAt),
    });
    return preview;
  } catch (error) {
    mapPreviewConstructionError(error);
  }
}

export interface ActivationPreviewLoadOptions {
  /** Retains the immutable preview row under a shared transaction lock. */
  readonly lock?: 'share';
}

/**
 * Loads the canonical persisted consequence preview without roster details.
 * The structural database seam accepts either a configured database or the
 * transaction supplied by Drizzle's `database.transaction` callback.
 */
export async function loadActivationPreview(
  databaseValue: unknown,
  previewId: string,
  options: ActivationPreviewLoadOptions = {},
): Promise<ActivationPreview | null> {
  const database = startFlowQueryDatabase(databaseValue);
  const rows =
    options.lock === 'share'
      ? await database
          .select()
          .from(activationPreviews)
          .where(eq(activationPreviews.id, previewId))
          .for('share')
          .limit(1)
      : await database
          .select()
          .from(activationPreviews)
          .where(eq(activationPreviews.id, previewId))
          .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  // A preview prepared before threats became mandatory has no threat and can
  // never satisfy the current contract. Report it as gone rather than throwing
  // a schema error the confirmation boundary cannot classify: the operator is
  // told to start again, which is exactly what they must do.
  if (row.threatId === null && row.threatName === null) {
    return null;
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
    threat: activationThreatFromColumns(row),
    responseDetail: row.responseDetail ?? null,
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

function createDrizzleStartFlowTransaction(
  database: StartFlowQueryDatabase,
  hydrationCache: RosterSnapshotHydrationCache,
): StartFlowCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: () => unsupportedQueryMutationMethod(),
    completeIdempotency: () => unsupportedQueryMutationMethod(),
    getHumanConfirmation: () => unsupportedQueryMutationMethod(),
    consumeHumanConfirmation: () => unsupportedQueryMutationMethod(),
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
    listFacilities: (input, scope) =>
      listFacilitiesFromDatabase(database, input, scope),
    listThreats: (input) => listThreatsFromDatabase(database, input),
    createActivationPreview: (input, actor, now) =>
      createActivationPreviewFromDatabase(
        database,
        input,
        actor,
        now,
        hydrationCache,
      ),
  };
}

/** Production Drizzle store; preview persistence and success audit are atomic. */
export function createDrizzleStartFlowCapabilityStore(
  database: Database,
): StartFlowCapabilityStore {
  const hydrationCache: RosterSnapshotHydrationCache = { snapshot: null };
  return {
    transaction<Result>(
      operation: (
        transaction: StartFlowCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) =>
        operation(
          createDrizzleStartFlowTransaction(
            startFlowQueryDatabase(transaction),
            hydrationCache,
          ),
        ),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction(async (transaction) =>
        appendCapabilityAuditEntry(startFlowQueryDatabase(transaction), event),
      );
    },
  };
}

export const listFacilitiesRegistration: ServerCapabilityRegistration<
  'list-facilities',
  StartFlowCapabilityTransaction
> = {
  id: 'list-facilities',
  resolveFacilityId: () => null,
  async handler(input, context): Promise<FacilityPage> {
    return FacilityPageSchema.parse(
      await context.transaction.listFacilities(input, context.invocation.scope),
    );
  },
};

export const listThreatsRegistration: ServerCapabilityRegistration<
  'list-threats',
  StartFlowCapabilityTransaction
> = {
  id: 'list-threats',
  resolveFacilityId: () => null,
  async handler(input, context): Promise<ThreatPage> {
    return ThreatPageSchema.parse(await context.transaction.listThreats(input));
  },
};

export const createActivationPreviewRegistration: ServerCapabilityRegistration<
  'create-activation-preview',
  StartFlowCapabilityTransaction
> = {
  id: 'create-activation-preview',
  resolveFacilityId: (input) => input.facilityId,
  async handler(input, context): Promise<ActivationPreview> {
    return ActivationPreviewSchema.parse(
      await context.transaction.createActivationPreview(
        input,
        context.invocation.actor,
        await readCapabilityTime(context),
      ),
    );
  },
};

const registrations = Object.freeze({
  'list-facilities': listFacilitiesRegistration,
  'list-threats': listThreatsRegistration,
  'create-activation-preview': createActivationPreviewRegistration,
});

/** Executes one start-flow query through the canonical capability engine. */
export async function executeStartFlowCapability<
  Id extends StartFlowCapabilityId,
>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: StartFlowCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, StartFlowCapabilityTransaction>;
  return executeAuditedCapabilityTransaction(
    registration,
    input,
    invocation,
    store,
  );
}

export interface StartFlowCapabilityRuntime {
  readonly store: StartFlowCapabilityStore;
  execute<Id extends StartFlowCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  close(): Promise<void>;
}

/** Builds a start-flow runtime around an explicitly managed connection. */
export function createStartFlowCapabilityRuntime(
  connection: DatabaseConnection,
): StartFlowCapabilityRuntime {
  const store = createDrizzleStartFlowCapabilityStore(connection.db);
  return {
    store,
    execute: (capabilityId, input, invocation) =>
      executeStartFlowCapability(capabilityId, input, invocation, store),
    close: () => connection.close(),
  };
}

let defaultStartFlowCapabilityRuntime: StartFlowCapabilityRuntime | undefined;

/** Lazily creates the database-backed runtime used by the web start flow. */
export function getDefaultStartFlowCapabilityRuntime(): StartFlowCapabilityRuntime {
  defaultStartFlowCapabilityRuntime ??= createStartFlowCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultStartFlowCapabilityRuntime;
}

/** Lifecycle hook for tests and scripts; Next.js retains the normal pool. */
export async function closeDefaultStartFlowCapabilityRuntime(): Promise<void> {
  const runtime = defaultStartFlowCapabilityRuntime;
  defaultStartFlowCapabilityRuntime = undefined;
  await runtime?.close();
}
