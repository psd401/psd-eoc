import { randomUUID } from 'node:crypto';

import {
  ActivationPreviewSchema,
  ChannelConfigurationSchema,
  DeliveryTestPreviewSchema,
  DeliveryTestTargetSetVersionSchema,
  EndpointSchema,
  FacilityPageSchema,
  FacilitySchema,
  IntegrationStatusSchema,
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
  type DeliveryTestNotificationMetadata,
  type DeliveryTestPreview,
  type DeliveryTestTargetSetVersion,
  type FacilityPage,
  type GroupSourceKind,
  type NotificationChannel,
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
  deliveryTestCanaryEligibilityFacts,
  deliveryTestTargetEndpoints,
  deliveryTestTargetSetVersions,
  events,
  eventTypes,
  eventTypeVersions,
  facilities,
  groupSources,
  integrationStatuses,
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
import { AudienceResolutionError, resolveAudience } from '../roster/resolve';
import {
  DELIVERY_TEST_TARGET_LOCK_NAMESPACE,
  deliveryTestEndpointReferenceDigest,
  deliveryTestTargetLockIdentity,
  isDeliveryTestEndpointReferenceSubset,
} from '../testing/e2e-delivery';
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
  | 'create-activation-preview'
  | 'create-delivery-test-preview'
  | 'list-facilities'
  | 'list-threats'
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

export const DELIVERY_TEST_CREDENTIAL_VERIFICATION_REFERENCE_ENV =
  Object.freeze({
    push: 'PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE',
    email: 'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE',
    sms: 'PSD_EOC_SMS_REGISTRATION_VERIFICATION_REFERENCE',
  } as const satisfies Readonly<Record<NotificationChannel, string>>);

export type DeliveryTestCredentialVerificationReferences = Readonly<
  Record<NotificationChannel, string | null>
>;

function isDeliveryTestVerificationReference(
  value: string | null | undefined,
): value is string {
  return (
    value !== null &&
    value !== undefined &&
    value !== 'UNVERIFIED' &&
    value !== 'UNCONFIGURED' &&
    value === value.trim() &&
    value.length >= 16 &&
    value.length <= 255 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

/**
 * Loads non-secret, deploy-time provider verification references. Push and
 * email bind the running deployment to the exact append-only integration row;
 * SMS independently binds the deployment to retained carrier-registration
 * evidence.
 */
export function readDeliveryTestCredentialVerificationReferences(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeliveryTestCredentialVerificationReferences {
  const read = (channel: NotificationChannel): string | null => {
    const value =
      environment[DELIVERY_TEST_CREDENTIAL_VERIFICATION_REFERENCE_ENV[channel]];
    return isDeliveryTestVerificationReference(value) ? value : null;
  };
  return Object.freeze({
    push: read('push'),
    email: read('email'),
    sms: read('sms'),
  });
}

export function deliveryTestCredentialIsVerified(
  status: Readonly<{
    label: string;
    verifiedAt: string | null;
    authorizationReference: string | null;
  }>,
  verificationReference: string | null,
  channel: NotificationChannel,
): boolean {
  const verified =
    status.label === 'live-verified' &&
    status.verifiedAt !== null &&
    verificationReference !== null;
  if (!verified) return false;
  if (channel === 'sms') {
    return isDeliveryTestVerificationReference(verificationReference);
  }
  return status.authorizationReference === verificationReference;
}

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
  resolveDeliveryTestFacilityId?(
    input: CapabilityInput<'create-delivery-test-preview'>,
  ): Promise<string | null>;
  createDeliveryTestPreview?(
    input: CapabilityInput<'create-delivery-test-preview'>,
    actor: Actor,
    now: Date,
  ): Promise<DeliveryTestPreview>;
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
 * authenticated staff member sees the same list in the declared order.
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
    .orderBy(asc(threats.sortOrder), asc(threats.name), asc(threats.id))
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
    .select({
      configuration: channelConfigurations,
      status: integrationStatuses,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      eq(channelConfigurations.statusId, integrationStatuses.id),
    )
    .where(
      inArray(channelConfigurations.integrationId, [
        'mobile-push',
        'ses-email',
        'aws-eum-sms',
      ]),
    )
    .orderBy(asc(channelConfigurations.integrationId));
  return rows.map(({ configuration, status }) =>
    ChannelConfigurationSchema.parse({
      integrationId: configuration.integrationId,
      enabled: configuration.enabled,
      status: IntegrationStatusSchema.parse({
        integrationId: status.integrationId,
        label: status.label,
        verifiedAt:
          status.verifiedAt === null ? null : dateIso(status.verifiedAt),
        verifiedByUserId: status.verifiedByUserId,
        authorizationReference: status.authorizationReference,
        reasonCode: status.reasonCode,
        observedAt: dateIso(status.observedAt),
      }),
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

export type DeliveryTestEndpointReference = Readonly<{
  recipientId: string;
  endpointId: string;
  channel: 'push' | 'email' | 'sms';
}>;

interface DeliveryTestPreviewContext {
  readonly targetSet: DeliveryTestTargetSetVersion;
  readonly metadata: DeliveryTestNotificationMetadata;
  readonly credentialVerificationReferences: DeliveryTestCredentialVerificationReferences;
}

const DELIVERY_TEST_CHANNEL_BY_INTEGRATION_ID = Object.freeze({
  'mobile-push': 'push',
  'expo-push': 'push',
  'ses-email': 'email',
  'aws-eum-sms': 'sms',
} as const);

function deliveryTestCredentialBlockingReasonCodes(
  configurations: readonly ChannelConfiguration[],
  targetSet: DeliveryTestTargetSetVersion,
  references: DeliveryTestCredentialVerificationReferences,
): readonly string[] {
  const targetedChannels = new Set(
    targetSet.endpoints.map((endpoint) => endpoint.channel),
  );
  const statusByChannel = new Map(
    configurations.flatMap((configuration) => {
      const channel =
        DELIVERY_TEST_CHANNEL_BY_INTEGRATION_ID[
          configuration.integrationId as keyof typeof DELIVERY_TEST_CHANNEL_BY_INTEGRATION_ID
        ];
      return channel === undefined
        ? []
        : ([[channel, configuration.status]] as const);
    }),
  );
  return Object.freeze(
    [...targetedChannels]
      .filter(
        (channel) =>
          !deliveryTestCredentialIsVerified(
            statusByChannel.get(channel) ?? {
              label: 'configured-unverified',
              verifiedAt: null,
              authorizationReference: null,
            },
            references[channel],
            channel,
          ),
      )
      .map((channel) => `${channel.toUpperCase()}_CREDENTIAL_UNVERIFIED`)
      .sort(),
  );
}

function endpointReferenceKey(
  reference: DeliveryTestEndpointReference,
): string {
  return `${reference.channel}:${reference.recipientId}:${reference.endpointId}`;
}

export async function loadDeliveryTestTargetSet(
  database: StartFlowQueryDatabase,
  reference: Readonly<{ id: string; version: number }>,
): Promise<DeliveryTestTargetSetVersion | null> {
  const [row] = await database
    .select()
    .from(deliveryTestTargetSetVersions)
    .where(
      and(
        eq(deliveryTestTargetSetVersions.id, reference.id),
        eq(deliveryTestTargetSetVersions.version, reference.version),
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
  const endpointReferences = endpoints.map((endpoint) => ({
    eligibilityFactId: endpoint.eligibilityFactId,
    recipientId: endpoint.recipientId,
    endpointId: endpoint.endpointId,
    channel: endpoint.channel,
    attestation: endpoint.attestation,
    optedInAt: dateIso(endpoint.optedInAt),
    attestedAt: dateIso(endpoint.attestedAt),
    attestedByUserId: endpoint.attestedByUserId,
    authorizationReference: endpoint.authorizationReference,
  }));
  const controlledMode =
    endpointReferences.length === 1 &&
    endpointReferences[0]?.channel === 'email'
      ? ('controlled-email-canary' as const)
      : endpointReferences.length === 1 &&
          endpointReferences[0]?.channel === 'push'
        ? ('controlled-push-canary' as const)
        : endpointReferences.length === 1 &&
            endpointReferences[0]?.channel === 'sms'
          ? ('controlled-sms-canary' as const)
          : null;
  return DeliveryTestTargetSetVersionSchema.parse({
    ...(controlledMode === null ? {} : { mode: controlledMode }),
    id: row.id,
    version: row.version,
    facilityId: row.facilityId,
    rosterSnapshotId: row.rosterSnapshotId,
    supersedesVersionId: row.supersedesVersionId,
    endpoints: endpointReferences,
    endpointReferenceDigest: row.endpointReferenceDigest,
    approvedByUserId: row.approvedByUserId,
    approvedWithSessionId: row.approvedWithSessionId,
    approvedAt: dateIso(row.approvedAt),
    createdAt: dateIso(row.createdAt),
  });
}

export async function currentActiveAudienceEndpointReferences(
  database: StartFlowQueryDatabase,
  rosterSnapshot: RosterSnapshot,
  facilityId: string,
): Promise<readonly DeliveryTestEndpointReference[]> {
  const references = allAudienceEndpointReferences(rosterSnapshot, facilityId);
  const endpointIds = references.map((endpoint) => endpoint.endpointId);
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
        eq(rosterEndpoints.rosterSnapshotId, rosterSnapshot.id),
        inArray(rosterEndpoints.id, endpointIds),
      ),
    );
  if (rows.length !== endpointIds.length) {
    throw unavailable('The configured canary audience is unavailable.');
  }
  const referenceKeys = new Set(references.map(endpointReferenceKey));
  if (
    rows.some(
      (row) =>
        !referenceKeys.has(
          endpointReferenceKey({
            endpointId: row.endpointId,
            recipientId: row.recipientId,
            channel: row.channel,
          }),
        ),
    )
  ) {
    throw conflict('The configured canary audience is inconsistent.');
  }
  return Object.freeze(
    rows
      .filter((row) => (row.latestStatus ?? row.baseStatus) === 'active')
      .map((row) =>
        Object.freeze({
          recipientId: row.recipientId,
          endpointId: row.endpointId,
          channel: row.channel,
        }),
      ),
  );
}

/**
 * Revalidates the independently authored, append-only eligibility facts and
 * current active audience for a pinned delivery-test target. Callers hold the
 * facility target-set advisory lock so a concurrent revocation cannot race a
 * preview or event start.
 */
export async function requireCurrentDeliveryTestTargetEligibility(
  database: StartFlowQueryDatabase,
  targetSet: DeliveryTestTargetSetVersion,
  now: Date,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<void> {
  const factIds = targetSet.endpoints.map(
    (endpoint) => endpoint.eligibilityFactId,
  );
  const [facility] = await database
    .select({ active: facilities.active })
    .from(facilities)
    .where(eq(facilities.id, targetSet.facilityId))
    .limit(1);
  const roster = await loadRosterSnapshot(
    database,
    'staff',
    targetSet.facilityId,
    undefined,
    hydrationCache,
  );
  if (
    facility === undefined ||
    !facility.active ||
    roster === null ||
    roster.id !== targetSet.rosterSnapshotId
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'The pinned canary target no longer belongs to the current active staff audience.',
      403,
    );
  }

  const facts = await database
    .select()
    .from(deliveryTestCanaryEligibilityFacts)
    .where(inArray(deliveryTestCanaryEligibilityFacts.id, factIds));
  const successors = await database
    .select({
      supersedesFactId: deliveryTestCanaryEligibilityFacts.supersedesFactId,
    })
    .from(deliveryTestCanaryEligibilityFacts)
    .where(
      inArray(deliveryTestCanaryEligibilityFacts.supersedesFactId, factIds),
    );
  const activeReferences = await currentActiveAudienceEndpointReferences(
    database,
    roster,
    targetSet.facilityId,
  );
  const activeKeys = new Set(activeReferences.map(endpointReferenceKey));
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const valid =
    facts.length === factIds.length &&
    new Set(factIds).size === factIds.length &&
    successors.length === 0 &&
    targetSet.endpoints.every((endpoint) => {
      const fact = factsById.get(endpoint.eligibilityFactId);
      return (
        fact !== undefined &&
        fact.facilityId === targetSet.facilityId &&
        fact.rosterSnapshotId === targetSet.rosterSnapshotId &&
        fact.rosterPopulation === 'staff' &&
        fact.recipientId === endpoint.recipientId &&
        fact.endpointId === endpoint.endpointId &&
        fact.channel === endpoint.channel &&
        fact.decision === 'approved-synthetic-canary' &&
        dateIso(fact.optedInAt) === endpoint.optedInAt &&
        dateIso(fact.decidedAt) === endpoint.attestedAt &&
        fact.decidedAt.getTime() <= now.getTime() &&
        fact.decidedByUserId === endpoint.attestedByUserId &&
        fact.authorizationReference === endpoint.authorizationReference &&
        activeKeys.has(endpointReferenceKey(endpoint))
      );
    });
  if (!valid) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'The pinned canary target no longer has exact current eligibility and active-audience evidence.',
      403,
    );
  }
}

function allAudienceEndpointReferences(
  rosterSnapshot: RosterSnapshot,
  facilityId: string,
): readonly DeliveryTestEndpointReference[] {
  // Resolve audience membership independently from mutable endpoint health;
  // the caller applies the latest status overlay before comparing exact sets.
  const allEndpointsActive = {
    ...rosterSnapshot,
    recipients: rosterSnapshot.recipients.map((recipient) => ({
      ...recipient,
      endpoints: recipient.endpoints.map((endpoint) => ({
        ...endpoint,
        status: 'active' as const,
      })),
    })),
  };
  const resolved = resolveAudience({
    facilityId,
    rosterSnapshot: allEndpointsActive,
  });
  return resolved.recipients.flatMap((recipient) =>
    recipient.endpoints.map((endpoint) => ({
      recipientId: recipient.recipientId,
      endpointId: endpoint.id,
      channel: endpoint.channel,
    })),
  );
}

/** What the operator chose beyond classification and audience. */
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
      undefined,
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
  deliveryTestContext?: DeliveryTestPreviewContext,
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
      deliveryTestContext?.targetSet.rosterSnapshotId,
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
    if (deliveryTestContext !== undefined) {
      const targetReferences = deliveryTestContext.targetSet.endpoints.map(
        (endpoint) => ({
          recipientId: endpoint.recipientId,
          endpointId: endpoint.endpointId,
          channel: endpoint.channel,
        }),
      );
      const activeReferences = await currentActiveAudienceEndpointReferences(
        database,
        rosterSnapshot,
        input.facilityId,
      );
      if (
        targetReferences.length === 0 ||
        !isDeliveryTestEndpointReferenceSubset(
          targetReferences,
          activeReferences,
        ) ||
        deliveryTestEndpointReferenceDigest(targetReferences) !==
          deliveryTestContext.targetSet.endpointReferenceDigest
      ) {
        throw conflict(
          'An approved canary endpoint is no longer active in the configured audience.',
        );
      }
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
      ...(deliveryTestContext === undefined
        ? {}
        : {
            deliveryTest: deliveryTestContext.metadata,
            deliveryTestEndpointReferences:
              deliveryTestContext.targetSet.endpoints,
            additionalBlockingReasonCodes:
              deliveryTestCredentialBlockingReasonCodes(
                channelConfigurationsValue,
                deliveryTestContext.targetSet,
                deliveryTestContext.credentialVerificationReferences,
              ),
          }),
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
      deliveryTestTargetSetId: preview.deliveryTest?.targetSet.id ?? null,
      deliveryTestTargetSetVersion:
        preview.deliveryTest?.targetSet.version ?? null,
      deliveryTestEndpointReferenceDigest:
        preview.deliveryTest?.endpointReferenceDigest ?? null,
      createdAt: new Date(preview.createdAt),
      expiresAt: new Date(preview.expiresAt),
    });
    return preview;
  } catch (error) {
    mapPreviewConstructionError(error);
  }
}

async function createDeliveryTestPreviewFromDatabase(
  database: StartFlowQueryDatabase,
  input: CapabilityInput<'create-delivery-test-preview'>,
  actor: Actor,
  now: Date,
  credentialVerificationReferences: DeliveryTestCredentialVerificationReferences,
  hydrationCache?: RosterSnapshotHydrationCache,
): Promise<DeliveryTestPreview> {
  if (actor.kind !== 'human') {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'A monthly live delivery-test preview requires an authenticated human.',
      403,
    );
  }
  const targetSet = await loadDeliveryTestTargetSet(database, input.targetSet);
  if (targetSet === null) {
    throw unavailable('The approved canary target-set version is unavailable.');
  }
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${deliveryTestTargetLockIdentity(targetSet.facilityId)}, ${DELIVERY_TEST_TARGET_LOCK_NAMESPACE}))`,
  );
  const [successor] = await database
    .select({ id: deliveryTestTargetSetVersions.id })
    .from(deliveryTestTargetSetVersions)
    .where(eq(deliveryTestTargetSetVersions.supersedesVersionId, targetSet.id))
    .limit(1);
  if (successor !== undefined) {
    throw conflict(
      'The approved canary target-set version has been superseded.',
    );
  }
  await requireCurrentDeliveryTestTargetEligibility(
    database,
    targetSet,
    now,
    hydrationCache,
  );
  const metadata: DeliveryTestNotificationMetadata = Object.freeze({
    purpose: 'monthly-live-delivery-test',
    targetSet: input.targetSet,
    endpointReferenceDigest: targetSet.endpointReferenceDigest,
  });
  // A monthly delivery test exercises the channels, not a threat scenario, so
  // it is the one preview that pins no threat and no typed description.
  const activationPreview = await createActivationPreviewRecord(
    database,
    {
      facilityId: targetSet.facilityId,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: input.eventTypeVersion,
      rosterPopulation: 'staff',
    },
    { threat: null, responseDetail: null },
    actor,
    now,
    { targetSet, metadata, credentialVerificationReferences },
    hydrationCache,
  );
  return DeliveryTestPreviewSchema.parse({
    purpose: 'monthly-live-delivery-test',
    activationPreview,
    targetSet: input.targetSet,
    endpointReferenceDigest: targetSet.endpointReferenceDigest,
    channels: activationPreview.channels.map((channel) => ({
      channel: channel.channel,
      endpointCount: channel.endpointCount,
      integrationStatus: channel.integrationStatus,
      credentialVerified: deliveryTestCredentialIsVerified(
        channel.integrationStatus,
        credentialVerificationReferences[channel.channel],
        channel.channel,
      ),
    })),
    consequenceDigest: activationPreview.consequenceDigest,
    createdAt: activationPreview.createdAt,
    expiresAt: activationPreview.expiresAt,
  });
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
    deliveryTest:
      row.deliveryTestTargetSetId === null ||
      row.deliveryTestTargetSetVersion === null ||
      row.deliveryTestEndpointReferenceDigest === null
        ? null
        : {
            purpose: 'monthly-live-delivery-test',
            targetSet: {
              id: row.deliveryTestTargetSetId,
              version: row.deliveryTestTargetSetVersion,
            },
            endpointReferenceDigest: row.deliveryTestEndpointReferenceDigest,
          },
    consequenceDigest: row.consequenceDigest,
    createdAt: dateIso(row.createdAt),
    expiresAt: dateIso(row.expiresAt),
  });
}

function createDrizzleStartFlowTransaction(
  database: StartFlowQueryDatabase,
  credentialVerificationReferences: DeliveryTestCredentialVerificationReferences,
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
    async resolveDeliveryTestFacilityId(input) {
      const [row] = await database
        .select({ facilityId: deliveryTestTargetSetVersions.facilityId })
        .from(deliveryTestTargetSetVersions)
        .where(
          and(
            eq(deliveryTestTargetSetVersions.id, input.targetSet.id),
            eq(deliveryTestTargetSetVersions.version, input.targetSet.version),
          ),
        )
        .limit(1);
      return row?.facilityId ?? null;
    },
    createDeliveryTestPreview: (input, actor, now) =>
      createDeliveryTestPreviewFromDatabase(
        database,
        input,
        actor,
        now,
        credentialVerificationReferences,
        hydrationCache,
      ),
  };
}

/** Production Drizzle store; preview persistence and success audit are atomic. */
export function createDrizzleStartFlowCapabilityStore(
  database: Database,
  options: Readonly<{
    credentialVerificationReferences?: DeliveryTestCredentialVerificationReferences;
  }> = {},
): StartFlowCapabilityStore {
  const credentialVerificationReferences =
    options.credentialVerificationReferences ??
    readDeliveryTestCredentialVerificationReferences();
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
            credentialVerificationReferences,
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

export const createDeliveryTestPreviewRegistration: ServerCapabilityRegistration<
  'create-delivery-test-preview',
  StartFlowCapabilityTransaction
> = {
  id: 'create-delivery-test-preview',
  resolveFacilityId(input, context) {
    const resolveFacilityId = context.transaction.resolveDeliveryTestFacilityId;
    if (resolveFacilityId === undefined) {
      throw unavailable('The monthly delivery-test preview is unavailable.');
    }
    return resolveFacilityId(input);
  },
  async handler(input, context): Promise<DeliveryTestPreview> {
    const createPreview = context.transaction.createDeliveryTestPreview;
    if (createPreview === undefined) {
      throw unavailable('The monthly delivery-test preview is unavailable.');
    }
    return DeliveryTestPreviewSchema.parse(
      await createPreview(
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
  'create-delivery-test-preview': createDeliveryTestPreviewRegistration,
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
