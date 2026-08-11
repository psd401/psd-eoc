import { randomUUID } from 'node:crypto';

import {
  AudienceConfigSchema,
  CreateAudienceConfigVersionInputSchema,
  CreateFacilityInputSchema,
  CreateGroupSourceInputSchema,
  CreateNeighborhoodVersionInputSchema,
  FacilityPageSchema,
  FacilitySchema,
  GroupSourcePageSchema,
  GroupSourceSchema,
  ListGroupSourcesInputSchema,
  ListNeighborhoodsInputSchema,
  NeighborhoodPageSchema,
  NeighborhoodSchema,
  RosterSourceConfigurationSchema,
  UpdateFacilityInputSchema,
  UpdateGroupSourceInputSchema,
  UuidSchema,
  type Actor,
  type AudienceConfig,
  type CapabilityInput,
  type Facility,
  type FacilityPage,
  type GroupSource,
  type GroupSourcePage,
  type Neighborhood,
  type NeighborhoodPage,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import {
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  audienceConfigurations,
  audienceTargets,
  facilities,
  groupSources,
  neighborhoodFacilities,
  neighborhoodVersions,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  users,
} from '../../../db/schema';
import {
  ADMIN_AVAILABILITY_LOCK_SQL,
  loadAccessConfigurationSnapshotState,
  loadEffectiveAdministratorUserIds,
  loadEffectiveRoles,
  type AccessConfigurationSnapshotState,
} from '../../../lib/auth/role-state';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import type {
  CapabilityHandlerContext,
  ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import { digestCapabilityValue } from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  executeAdminMutationCapability,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminMutationMetadata,
  type AdminQueryDatabase,
  type AdminQueryMetadata,
} from './admin-core';

type AdminContext = CapabilityHandlerContext<AdminCapabilityTransaction>;

function notFound(message: string): AdminCapabilityError {
  return new AdminCapabilityError('NOT_FOUND', message, 404);
}

function conflict(message: string): AdminCapabilityError {
  return new AdminCapabilityError('CONFLICT', message, 409);
}

function invalid(message: string): AdminCapabilityError {
  return new AdminCapabilityError('VALIDATION_ERROR', message, 400);
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

type PaginationCollection =
  | 'facilities'
  | 'group-sources'
  | 'neighborhood-versions'
  | 'neighborhoods';

interface KeysetCursor {
  readonly version: 1;
  readonly collection: PaginationCollection;
  readonly filterDigest: string;
  readonly after: number | string;
}

function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function paginationFilterDigest(
  collection: PaginationCollection,
  filters: unknown,
): string {
  return digestCapabilityValue({ collection, filters });
}

function decodeKeysetCursor(
  cursor: string | null,
  collection: PaginationCollection,
  filterDigest: string,
  afterKind: 'number' | 'uuid',
): number | string | null {
  if (cursor === null) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null) throw new TypeError();
    const keys = Object.keys(parsed).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== 'after' ||
      keys[1] !== 'collection' ||
      keys[2] !== 'filterDigest' ||
      keys[3] !== 'version'
    ) {
      throw new TypeError();
    }
    const candidate = parsed as Readonly<Record<string, unknown>>;
    const after = candidate.after;
    if (
      candidate.version !== 1 ||
      candidate.collection !== collection ||
      candidate.filterDigest !== filterDigest ||
      typeof candidate.filterDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.filterDigest) ||
      (afterKind === 'number'
        ? !Number.isSafeInteger(after) || Number(after) <= 0
        : typeof after !== 'string')
    ) {
      throw new TypeError();
    }
    const canonicalAfter =
      afterKind === 'number' ? Number(after) : UuidSchema.parse(after);
    const canonical: KeysetCursor = {
      version: 1,
      collection,
      filterDigest,
      after: canonicalAfter,
    };
    if (encodeKeysetCursor(canonical) !== cursor) throw new TypeError();
    return canonicalAfter;
  } catch {
    throw invalid('The pagination cursor is invalid for this result set.');
  }
}

function keysetPageInfo(
  collection: PaginationCollection,
  filterDigest: string,
  limit: number,
  count: number,
  lastKey: number | string | undefined,
) {
  const hasMore = count > limit;
  if (hasMore && lastKey === undefined) {
    throw conflict('The pagination continuation key is unavailable.');
  }
  return {
    hasMore,
    nextCursor:
      hasMore && lastKey !== undefined
        ? encodeKeysetCursor({
            version: 1,
            collection,
            filterDigest,
            after: lastKey,
          })
        : null,
  } as const;
}

function guard(
  context: AdminContext,
  facilityId: string | null,
): string | null {
  requireAdminCapabilityAuthorization(
    context.invocation.actor,
    context.transaction,
  );
  return facilityId;
}

function facilityFromRow(row: typeof facilities.$inferSelect): Facility {
  return FacilitySchema.parse({
    ...row,
    createdAt: dateIso(row.createdAt),
  });
}

async function getFacility(
  database: AdminQueryDatabase,
  facilityId: string,
): Promise<Facility | null> {
  const [row] = await database
    .select()
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  return row === undefined ? null : facilityFromRow(row);
}

async function resolveExistingFacilityId(
  context: AdminContext,
  facilityId: string,
): Promise<string | null> {
  guard(context, null);
  const [row] = await context.transaction.database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  return row?.id ?? null;
}

async function lockAdminIdentity(
  database: AdminQueryDatabase,
  identity: string,
): Promise<void> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
  );
}

async function lockRosterConfigurationPopulations(
  database: AdminQueryDatabase,
): Promise<void> {
  // Audience validation spans both staff and synthetic configurations. Hold
  // both serialization keys in one deterministic order until the audience
  // version commits so a concurrent source replacement cannot make a newly
  // inserted audience version stale between validation and persistence.
  await lockAdminIdentity(database, 'psd-eoc-roster-staff');
  await lockAdminIdentity(database, 'psd-eoc-roster-synthetic');
}

interface AccessSetMutationState {
  readonly accessState: AccessConfigurationSnapshotState | null;
  readonly activeAccessGroupSourceIds: readonly string[];
  readonly latestCompleteSnapshot:
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{
        kind: 'strict';
        state: AccessConfigurationSnapshotState;
      }>;
}

function sameSortedIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

async function loadLatestStrictCompleteAccessSnapshot(
  database: AdminQueryDatabase,
): Promise<AccessSetMutationState['latestCompleteSnapshot']> {
  const [snapshot] = await database
    .select({
      id: accessMembershipSnapshots.id,
      version: accessMembershipSnapshots.version,
    })
    .from(accessMembershipSnapshots)
    .where(eq(accessMembershipSnapshots.complete, true))
    .orderBy(
      desc(accessMembershipSnapshots.version),
      desc(accessMembershipSnapshots.capturedAt),
      desc(accessMembershipSnapshots.id),
    )
    .limit(1);
  if (snapshot === undefined) return Object.freeze({ kind: 'none' as const });

  const rows = await database
    .select({
      id: accessMembershipSnapshotGroups.groupSourceId,
      kind: accessMembershipSnapshotGroups.groupSourceKind,
      purpose: accessMembershipSnapshotGroups.groupPurpose,
      completionKind: accessMembershipSnapshotGroups.completionKind,
    })
    .from(accessMembershipSnapshotGroups)
    .where(eq(accessMembershipSnapshotGroups.snapshotId, snapshot.id))
    .orderBy(
      asc(accessMembershipSnapshotGroups.completionKind),
      asc(accessMembershipSnapshotGroups.groupSourceId),
    );
  const expectedIds = rows
    .filter(({ completionKind }) => completionKind === 'expected')
    .map(({ id }) => id)
    .sort();
  const completedIds = rows
    .filter(({ completionKind }) => completionKind === 'completed')
    .map(({ id }) => id)
    .sort();
  if (
    expectedIds.length === 0 ||
    rows.some(
      ({ kind, purpose }) => kind !== 'google-group' || purpose !== 'access',
    ) ||
    rows.length !== expectedIds.length + completedIds.length ||
    new Set(expectedIds).size !== expectedIds.length ||
    new Set(completedIds).size !== completedIds.length ||
    !sameSortedIds(expectedIds, completedIds)
  ) {
    return Object.freeze({ kind: 'invalid' as const });
  }
  return Object.freeze({
    kind: 'strict' as const,
    state: Object.freeze({
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
      activeAccessGroupSourceIds: Object.freeze(expectedIds),
    }),
  });
}

async function loadAccessSetMutationStateAfterLock(
  database: AdminQueryDatabase,
  actor: Actor,
): Promise<AccessSetMutationState> {
  if (actor.kind !== 'human') {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'A human administrator is required to change access groups.',
      403,
    );
  }
  const [actorRow] = await database
    .select({
      disabledAt: users.disabledAt,
      facilityScopeKind: users.facilityScopeKind,
    })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  const actorRoles = await loadEffectiveRoles(database, actor.userId);
  if (
    actorRow === undefined ||
    actorRow.disabledAt !== null ||
    actorRow.facilityScopeKind !== 'district' ||
    !actorRoles.includes('admin')
  ) {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'The current human must still be an enabled district administrator.',
      403,
    );
  }
  const activeRows = await database
    .select({ id: groupSources.id })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.kind, 'google-group'),
        eq(groupSources.purpose, 'access'),
        eq(groupSources.active, true),
      ),
    )
    .orderBy(asc(groupSources.id));
  const activeAccessGroupSourceIds = Object.freeze(
    activeRows.map(({ id }) => id),
  );
  const accessState = await loadAccessConfigurationSnapshotState(database);
  const latestCompleteSnapshot =
    await loadLatestStrictCompleteAccessSnapshot(database);
  if (accessState !== null) {
    const reachableAdministratorIds = await loadEffectiveAdministratorUserIds(
      database,
      { accessState },
    );
    if (!reachableAdministratorIds.includes(actor.userId)) {
      throw new AdminCapabilityError(
        'FORBIDDEN',
        'The current administrator is not reachable through the exact access snapshot.',
        403,
      );
    }
  }
  return Object.freeze({
    accessState,
    activeAccessGroupSourceIds,
    latestCompleteSnapshot,
  });
}

interface AccessRecoveryTransition {
  readonly kind: 'empty-bootstrap' | 'strict-snapshot';
  readonly snapshotState?: AccessConfigurationSnapshotState;
}

function accessRecoveryTransition(
  state: AccessSetMutationState,
  current: Extract<GroupSource, { purpose: 'access' }>,
  input: Extract<CapabilityInput<'update-group-source'>, { purpose: 'access' }>,
): AccessRecoveryTransition {
  const locatorChanged =
    current.googleGroupId !== input.googleGroupId ||
    current.email !== input.email;
  if (
    locatorChanged ||
    current.displayName !== input.displayName ||
    current.active === input.active
  ) {
    throw conflict(
      'While access-group evidence is incomplete, only a status change that restores a previously proven set is allowed.',
    );
  }
  const prospectiveIds = state.activeAccessGroupSourceIds
    .filter((id) => id !== current.id)
    .concat(input.active ? [current.id] : [])
    .sort();
  if (
    state.latestCompleteSnapshot.kind === 'strict' &&
    sameSortedIds(
      prospectiveIds,
      state.latestCompleteSnapshot.state.activeAccessGroupSourceIds,
    )
  ) {
    return Object.freeze({
      kind: 'strict-snapshot' as const,
      snapshotState: state.latestCompleteSnapshot.state,
    });
  }
  if (
    state.latestCompleteSnapshot.kind === 'none' &&
    current.active &&
    !input.active &&
    state.activeAccessGroupSourceIds.length === 1 &&
    state.activeAccessGroupSourceIds[0] === current.id &&
    prospectiveIds.length === 0
  ) {
    return Object.freeze({ kind: 'empty-bootstrap' as const });
  }
  throw conflict(
    'The access-group status change does not restore the newest proven access set.',
  );
}

async function assertReachableAdministratorRemains(
  database: AdminQueryDatabase,
  state: AccessSetMutationState,
  removedSourceId: string,
): Promise<void> {
  if (state.accessState === null) {
    throw conflict('The final active access group cannot be removed.');
  }
  const remainingIds = state.activeAccessGroupSourceIds.filter(
    (id) => id !== removedSourceId,
  );
  const remainingAdministratorIds = await loadEffectiveAdministratorUserIds(
    database,
    {
      accessState: state.accessState,
      eligibleAccessGroupSourceIds: remainingIds,
    },
  );
  if (remainingAdministratorIds.length === 0) {
    throw conflict(
      'Another reachable district administrator must remain through an unchanged active access group.',
    );
  }
}

async function listFacilities(
  database: AdminQueryDatabase,
  input: CapabilityInput<'list-facilities'>,
): Promise<FacilityPage> {
  const filterDigest = paginationFilterDigest('facilities', {
    includeInactive: input.includeInactive,
  });
  const after = decodeKeysetCursor(
    input.cursor,
    'facilities',
    filterDigest,
    'uuid',
  );
  const conditions: SQL[] = [];
  if (!input.includeInactive) conditions.push(eq(facilities.active, true));
  if (after !== null) conditions.push(gt(facilities.id, String(after)));
  const rows = await database
    .select()
    .from(facilities)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(facilities.id))
    .limit(input.limit + 1);
  const items = rows.slice(0, input.limit).map(facilityFromRow);
  return FacilityPageSchema.parse({
    items,
    pageInfo: keysetPageInfo(
      'facilities',
      filterDigest,
      input.limit,
      rows.length,
      items.at(-1)?.id,
    ),
  });
}

async function assertUniqueFacilityCode(
  database: AdminQueryDatabase,
  code: string,
  exceptId: string | null,
): Promise<void> {
  await lockAdminIdentity(database, `admin-facility-code:${code}`);
  const [row] = await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.code, code))
    .limit(1)
    .for('update');
  if (row !== undefined && row.id !== exceptId) {
    throw conflict('Another facility already uses that short code.');
  }
}

async function createFacility(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'create-facility'>,
): Promise<Facility> {
  const input = CreateFacilityInputSchema.parse(inputValue);
  await assertUniqueFacilityCode(database, input.code, null);
  const [row] = await database
    .insert(facilities)
    .values({ code: input.code, name: input.name, active: true })
    .returning();
  if (row === undefined) {
    throw conflict('The facility could not be created.');
  }
  return facilityFromRow(row);
}

async function updateFacility(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'update-facility'>,
): Promise<Facility> {
  const input = UpdateFacilityInputSchema.parse(inputValue);
  await lockRosterConfigurationPopulations(database);
  const [currentRow] = await database
    .select()
    .from(facilities)
    .where(eq(facilities.id, input.facilityId))
    .limit(1)
    .for('update');
  if (currentRow === undefined) {
    throw notFound('The facility was not found.');
  }
  await assertUniqueFacilityCode(database, input.code, input.facilityId);
  const [row] = await database
    .update(facilities)
    .set({ code: input.code, name: input.name, active: input.active })
    .where(eq(facilities.id, input.facilityId))
    .returning();
  if (row === undefined) {
    throw conflict('The facility could not be updated.');
  }
  await refreshRosterSourceConfiguration(database, 'staff');
  await refreshRosterSourceConfiguration(database, 'synthetic');
  return facilityFromRow(row);
}

async function neighborhoodByVersion(
  database: AdminQueryDatabase,
  neighborhoodId: string,
  version: number,
): Promise<Neighborhood | null> {
  const [header] = await database
    .select()
    .from(neighborhoodVersions)
    .where(
      and(
        eq(neighborhoodVersions.id, neighborhoodId),
        eq(neighborhoodVersions.version, version),
      ),
    )
    .limit(1);
  if (header === undefined) return null;
  const members = await database
    .select({ facilityId: neighborhoodFacilities.facilityId })
    .from(neighborhoodFacilities)
    .where(
      and(
        eq(neighborhoodFacilities.neighborhoodId, neighborhoodId),
        eq(neighborhoodFacilities.neighborhoodVersion, version),
      ),
    )
    .orderBy(asc(neighborhoodFacilities.facilityId));
  return NeighborhoodSchema.parse({
    id: header.id,
    name: header.name,
    version: header.version,
    facilityIds: members.map((row) => row.facilityId),
    createdAt: dateIso(header.createdAt),
  });
}

async function latestNeighborhoodsById(
  database: AdminQueryDatabase,
  neighborhoodIds: readonly string[],
): Promise<readonly Neighborhood[]> {
  if (neighborhoodIds.length === 0) return Object.freeze([]);
  const latestHeaders = await database
    .selectDistinctOn([neighborhoodVersions.id], {
      createdAt: neighborhoodVersions.createdAt,
      id: neighborhoodVersions.id,
      name: neighborhoodVersions.name,
      version: neighborhoodVersions.version,
    })
    .from(neighborhoodVersions)
    .where(inArray(neighborhoodVersions.id, neighborhoodIds))
    .orderBy(asc(neighborhoodVersions.id), desc(neighborhoodVersions.version));
  const headerById = new Map(
    latestHeaders.map((header) => [header.id, header]),
  );
  const membersByKey = new Map<string, string[]>();
  for (const headerBatch of chunks(
    latestHeaders,
    DATA_API_NEIGHBORHOOD_HEADER_BATCH_SIZE,
  )) {
    const rows = await database
      .select({
        facilityId: neighborhoodFacilities.facilityId,
        id: neighborhoodFacilities.neighborhoodId,
        version: neighborhoodFacilities.neighborhoodVersion,
      })
      .from(neighborhoodFacilities)
      .where(
        or(
          ...headerBatch.map((header) =>
            and(
              eq(neighborhoodFacilities.neighborhoodId, header.id),
              eq(neighborhoodFacilities.neighborhoodVersion, header.version),
            ),
          ),
        ),
      )
      .orderBy(
        asc(neighborhoodFacilities.neighborhoodId),
        asc(neighborhoodFacilities.neighborhoodVersion),
        asc(neighborhoodFacilities.facilityId),
      );
    for (const row of rows) {
      const key = `${row.id}:${row.version}`;
      const members = membersByKey.get(key) ?? [];
      members.push(row.facilityId);
      membersByKey.set(key, members);
    }
  }
  return Object.freeze(
    neighborhoodIds.map((id) => {
      const header = headerById.get(id);
      if (header === undefined) {
        throw conflict('Neighborhood version history is incomplete.');
      }
      return NeighborhoodSchema.parse({
        id: header.id,
        name: header.name,
        version: header.version,
        facilityIds: membersByKey.get(`${header.id}:${header.version}`) ?? [],
        createdAt: dateIso(header.createdAt),
      });
    }),
  );
}

async function neighborhoodVersionsFromHeaders(
  database: AdminQueryDatabase,
  headers: readonly Readonly<{
    createdAt: Date | string;
    id: string;
    name: string;
    version: number;
  }>[],
): Promise<readonly Neighborhood[]> {
  if (headers.length === 0) return Object.freeze([]);
  const facilitiesByVersion = new Map<number, string[]>();
  for (const headerBatch of chunks(
    headers,
    DATA_API_NEIGHBORHOOD_HEADER_BATCH_SIZE,
  )) {
    const facilityRows = await database
      .select({
        facilityId: neighborhoodFacilities.facilityId,
        version: neighborhoodFacilities.neighborhoodVersion,
      })
      .from(neighborhoodFacilities)
      .where(
        and(
          eq(neighborhoodFacilities.neighborhoodId, headers[0]!.id),
          inArray(
            neighborhoodFacilities.neighborhoodVersion,
            headerBatch.map(({ version }) => version),
          ),
        ),
      )
      .orderBy(
        desc(neighborhoodFacilities.neighborhoodVersion),
        asc(neighborhoodFacilities.facilityId),
      );
    for (const row of facilityRows) {
      const members = facilitiesByVersion.get(row.version) ?? [];
      members.push(row.facilityId);
      facilitiesByVersion.set(row.version, members);
    }
  }
  return Object.freeze(
    headers.map((header) =>
      NeighborhoodSchema.parse({
        ...header,
        facilityIds: facilitiesByVersion.get(header.version) ?? [],
        createdAt: dateIso(header.createdAt),
      }),
    ),
  );
}

async function listNeighborhoods(
  database: AdminQueryDatabase,
  input: CapabilityInput<'list-neighborhoods'>,
): Promise<NeighborhoodPage> {
  const filterDigest = paginationFilterDigest('neighborhoods', {});
  const after = decodeKeysetCursor(
    input.cursor,
    'neighborhoods',
    filterDigest,
    'uuid',
  );
  const headers = await database
    .select({ id: neighborhoodVersions.id })
    .from(neighborhoodVersions)
    .where(
      after === null ? undefined : gt(neighborhoodVersions.id, String(after)),
    )
    .groupBy(neighborhoodVersions.id)
    .orderBy(asc(neighborhoodVersions.id))
    .limit(input.limit + 1);
  const items = await latestNeighborhoodsById(
    database,
    headers.slice(0, input.limit).map(({ id }) => id),
  );
  return NeighborhoodPageSchema.parse({
    items,
    pageInfo: keysetPageInfo(
      'neighborhoods',
      filterDigest,
      input.limit,
      headers.length,
      items.at(-1)?.id,
    ),
  });
}

async function listNeighborhoodVersions(
  database: AdminQueryDatabase,
  input: CapabilityInput<'list-neighborhood-versions'>,
): Promise<NeighborhoodPage> {
  const filterDigest = paginationFilterDigest('neighborhood-versions', {
    neighborhoodId: input.neighborhoodId,
  });
  const after = decodeKeysetCursor(
    input.cursor,
    'neighborhood-versions',
    filterDigest,
    'number',
  );
  const rows = await database
    .select({
      createdAt: neighborhoodVersions.createdAt,
      id: neighborhoodVersions.id,
      name: neighborhoodVersions.name,
      version: neighborhoodVersions.version,
    })
    .from(neighborhoodVersions)
    .where(
      and(
        eq(neighborhoodVersions.id, input.neighborhoodId),
        after === null
          ? undefined
          : lt(neighborhoodVersions.version, Number(after)),
      ),
    )
    .orderBy(desc(neighborhoodVersions.version))
    .limit(input.limit + 1);
  const items = await neighborhoodVersionsFromHeaders(
    database,
    rows.slice(0, input.limit),
  );
  return NeighborhoodPageSchema.parse({
    items,
    pageInfo: keysetPageInfo(
      'neighborhood-versions',
      filterDigest,
      input.limit,
      rows.length,
      items.at(-1)?.version,
    ),
  });
}

async function assertFacilitiesExist(
  database: AdminQueryDatabase,
  facilityIds: readonly string[],
): Promise<void> {
  const rows = await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(inArray(facilities.id, facilityIds))
    .for('share');
  if (rows.length !== facilityIds.length) {
    throw conflict('Every neighborhood facility must already exist.');
  }
}

async function createNeighborhoodVersion(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'create-neighborhood-version'>,
): Promise<Neighborhood> {
  const input = CreateNeighborhoodVersionInputSchema.parse(inputValue);
  await assertFacilitiesExist(database, input.facilityIds);
  const id = input.neighborhoodId ?? randomUUID();
  let version = 1;
  if (input.neighborhoodId !== null) {
    await lockAdminIdentity(
      database,
      `admin-neighborhood-version:${input.neighborhoodId}`,
    );
    const [latest] = await database
      .select({ version: neighborhoodVersions.version })
      .from(neighborhoodVersions)
      .where(eq(neighborhoodVersions.id, input.neighborhoodId))
      .orderBy(desc(neighborhoodVersions.version))
      .limit(1)
      .for('update');
    if (latest === undefined) {
      throw notFound('The neighborhood was not found.');
    }
    version = latest.version + 1;
  }
  const [header] = await database
    .insert(neighborhoodVersions)
    .values({ id, version, name: input.name })
    .returning();
  if (header === undefined) {
    throw conflict('The neighborhood version could not be created.');
  }
  await database.insert(neighborhoodFacilities).values(
    input.facilityIds.map((facilityId) => ({
      neighborhoodId: id,
      neighborhoodVersion: version,
      facilityId,
    })),
  );
  return NeighborhoodSchema.parse({
    id,
    version,
    name: header.name,
    facilityIds: input.facilityIds,
    createdAt: dateIso(header.createdAt),
  });
}

function groupSourceFromRow(
  row: typeof groupSources.$inferSelect,
  effectiveActive: boolean = row.active,
): GroupSource {
  const common = {
    id: row.id,
    kind: row.kind,
    purpose: row.purpose,
    facilityId: row.facilityId,
    displayName: row.displayName,
    active: effectiveActive,
    createdAt: dateIso(row.createdAt),
  };
  return GroupSourceSchema.parse(
    row.kind === 'google-group'
      ? {
          ...common,
          googleGroupId: row.googleGroupId,
          email: row.email,
        }
      : { ...common, fixtureKey: row.fixtureKey },
  );
}

async function getGroupSource(
  database: AdminQueryDatabase,
  id: string,
  lock = false,
): Promise<GroupSource | null> {
  const query = database
    .select()
    .from(groupSources)
    .where(eq(groupSources.id, id))
    .limit(1);
  const [row] = lock ? await query.for('update') : await query;
  return row === undefined ? null : groupSourceFromRow(row);
}

type RosterPopulation = 'staff' | 'synthetic';

interface RosterConfigurationState {
  readonly id: string;
  readonly version: number;
  readonly population: RosterPopulation;
  readonly facilityIds: readonly string[];
  readonly sources: readonly GroupSource[];
}

async function latestRosterConfiguration(
  database: AdminQueryDatabase,
  population: RosterPopulation,
  lock: boolean,
): Promise<RosterConfigurationState | null> {
  const lineages = await database
    .select({ id: rosterSourceConfigurations.id })
    .from(rosterSourceConfigurations)
    .where(eq(rosterSourceConfigurations.population, population))
    .groupBy(rosterSourceConfigurations.id)
    .limit(2);
  if (lineages.length > 1) {
    throw conflict(
      `The ${population} roster source configuration has conflicting lineages.`,
    );
  }
  const latestQuery = database
    .select({
      id: rosterSourceConfigurations.id,
      version: rosterSourceConfigurations.version,
    })
    .from(rosterSourceConfigurations)
    .where(eq(rosterSourceConfigurations.population, population))
    .orderBy(desc(rosterSourceConfigurations.version))
    .limit(1);
  const [latest] = lock ? await latestQuery.for('update') : await latestQuery;
  if (latest === undefined) return null;

  const facilityRows = await database
    .select({ facilityId: rosterSourceConfigurationFacilities.facilityId })
    .from(rosterSourceConfigurationFacilities)
    .where(
      and(
        eq(rosterSourceConfigurationFacilities.configurationId, latest.id),
        eq(
          rosterSourceConfigurationFacilities.configurationVersion,
          latest.version,
        ),
      ),
    )
    .orderBy(asc(rosterSourceConfigurationFacilities.facilityId));
  const sourceRows = await database
    .select({ source: groupSources })
    .from(rosterSourceConfigurationGroups)
    .innerJoin(
      groupSources,
      eq(rosterSourceConfigurationGroups.groupSourceId, groupSources.id),
    )
    .where(
      and(
        eq(rosterSourceConfigurationGroups.configurationId, latest.id),
        eq(
          rosterSourceConfigurationGroups.configurationVersion,
          latest.version,
        ),
        eq(rosterSourceConfigurationGroups.population, population),
      ),
    )
    .orderBy(asc(rosterSourceConfigurationGroups.groupSourceId));

  return {
    id: latest.id,
    version: latest.version,
    population,
    facilityIds: facilityRows.map(({ facilityId }) => facilityId),
    sources: sourceRows.map(({ source }) => groupSourceFromRow(source, true)),
  };
}

async function effectiveRosterSourceIds(
  database: AdminQueryDatabase,
): Promise<ReadonlySet<string>> {
  const staff = await latestRosterConfiguration(database, 'staff', false);
  const synthetic = await latestRosterConfiguration(
    database,
    'synthetic',
    false,
  );
  return new Set(
    [...(staff?.sources ?? []), ...(synthetic?.sources ?? [])].map(
      ({ id }) => id,
    ),
  );
}

async function listGroupSources(
  database: AdminQueryDatabase,
  input: CapabilityInput<'list-group-sources'>,
  knownEffectiveSourceIds?: ReadonlySet<string>,
): Promise<GroupSourcePage> {
  const filterDigest = paginationFilterDigest('group-sources', {
    active: input.active,
    facilityId: input.facilityId,
    kind: input.kind,
    purpose: input.purpose,
  });
  const after = decodeKeysetCursor(
    input.cursor,
    'group-sources',
    filterDigest,
    'uuid',
  );
  const effectiveSourceIds =
    knownEffectiveSourceIds ?? (await effectiveRosterSourceIds(database));
  const conditions: SQL[] = [];
  if (input.kind !== null) conditions.push(eq(groupSources.kind, input.kind));
  if (input.purpose !== null) {
    conditions.push(eq(groupSources.purpose, input.purpose));
  }
  if (input.facilityId !== null) {
    conditions.push(eq(groupSources.facilityId, input.facilityId));
  }
  if (input.active !== null) {
    const effectiveIds = [...effectiveSourceIds];
    const effectiveNonAccess =
      input.active === true
        ? effectiveIds.length === 0
          ? sql`false`
          : inArray(groupSources.id, effectiveIds)
        : effectiveIds.length === 0
          ? sql`true`
          : notInArray(groupSources.id, effectiveIds);
    const activeCondition = or(
      and(
        eq(groupSources.purpose, 'access'),
        eq(groupSources.active, input.active),
      ),
      and(ne(groupSources.purpose, 'access'), effectiveNonAccess),
    );
    if (activeCondition !== undefined) conditions.push(activeCondition);
  }
  if (after !== null) conditions.push(gt(groupSources.id, String(after)));
  const rows = await database
    .select()
    .from(groupSources)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(asc(groupSources.id))
    .limit(input.limit + 1);
  const items = rows
    .slice(0, input.limit)
    .map((row) =>
      groupSourceFromRow(
        row,
        row.purpose === 'access' ? row.active : effectiveSourceIds.has(row.id),
      ),
    );
  return GroupSourcePageSchema.parse({
    items,
    pageInfo: keysetPageInfo(
      'group-sources',
      filterDigest,
      input.limit,
      rows.length,
      items.at(-1)?.id,
    ),
  });
}

async function assertGroupIdentityAvailable(
  database: AdminQueryDatabase,
  source:
    | CapabilityInput<'create-group-source'>
    | CapabilityInput<'update-group-source'>,
  exceptId: string | null,
): Promise<void> {
  const identity =
    source.kind === 'google-group' ? source.googleGroupId : source.fixtureKey;
  await lockAdminIdentity(
    database,
    `admin-group-source:${source.kind}:${identity}`,
  );
  const condition =
    source.kind === 'google-group'
      ? eq(groupSources.googleGroupId, source.googleGroupId)
      : eq(groupSources.fixtureKey, source.fixtureKey);
  const [existing] = await database
    .select({ id: groupSources.id })
    .from(groupSources)
    .where(condition)
    .limit(1)
    .for('update');
  if (existing !== undefined && existing.id !== exceptId) {
    throw conflict('That group source is already configured.');
  }
}

function sourcePopulation(source: GroupSource): RosterPopulation | null {
  if (source.purpose === 'access') return null;
  return source.kind === 'google-group' ? 'staff' : 'synthetic';
}

async function refreshRosterSourceConfiguration(
  database: AdminQueryDatabase,
  population: RosterPopulation,
  options: Readonly<{
    additions?: readonly GroupSource[];
    requiredEffectiveSourceId?: string | null;
    supersededSourceIds?: readonly string[];
  }> = {},
): Promise<void> {
  await lockAdminIdentity(database, `psd-eoc-roster-${population}`);
  const latest = await latestRosterConfiguration(database, population, true);
  if (
    options.requiredEffectiveSourceId !== undefined &&
    options.requiredEffectiveSourceId !== null &&
    (latest === null ||
      !latest.sources.some(
        ({ id }) => id === options.requiredEffectiveSourceId,
      ))
  ) {
    throw conflict(
      'The group source has already been superseded; reload before replacing it.',
    );
  }
  const sourceKind = population === 'staff' ? 'google-group' : 'synthetic';
  let baseSources: readonly GroupSource[];
  if (latest === null) {
    const initialRows = await database
      .select()
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, sourceKind),
          ne(groupSources.purpose, 'access'),
          eq(groupSources.active, true),
        ),
      )
      .orderBy(asc(groupSources.id));
    baseSources = initialRows.map((row) => groupSourceFromRow(row, true));
  } else {
    baseSources = latest.sources;
  }
  const byId = new Map(baseSources.map((source) => [source.id, source]));
  for (const sourceId of options.supersededSourceIds ?? []) {
    byId.delete(sourceId);
  }
  for (const source of options.additions ?? []) {
    if (source.active) byId.set(source.id, source);
  }
  const activeFacilities = await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.active, true));
  const activeFacilityIds = new Set(activeFacilities.map(({ id }) => id));
  const sources = [...byId.values()]
    .filter(
      (source) =>
        source.kind === sourceKind &&
        source.active &&
        source.purpose !== 'access' &&
        (source.purpose === 'others' ||
          activeFacilityIds.has(source.facilityId)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const facilityIds = [
    ...new Set(
      sources.flatMap((source) =>
        source.purpose === 'building' ? [source.facilityId] : [],
      ),
    ),
  ].sort();
  if (facilityIds.length === 0) {
    if (latest !== null) {
      throw conflict(
        `The final active ${population} roster facility cannot be removed without an explicit empty-state contract.`,
      );
    }
    return;
  }
  const configuredSources = sources;
  const unchanged =
    latest !== null &&
    latest.facilityIds.length === facilityIds.length &&
    latest.facilityIds.every(
      (facilityId, index) => facilityId === facilityIds[index],
    ) &&
    latest.sources.length === configuredSources.length &&
    latest.sources.every(
      (source, index) => source.id === configuredSources[index]?.id,
    );
  if (unchanged) return;
  const configuration = RosterSourceConfigurationSchema.parse({
    id: latest?.id ?? randomUUID(),
    version: (latest?.version ?? 0) + 1,
    population,
    facilityIds,
    groupSourceRefs: configuredSources.map((source) => ({
      id: source.id,
      kind: source.kind,
      purpose: source.purpose,
      facilityId: source.facilityId,
    })),
    createdAt: new Date().toISOString(),
  });
  const [header] = await database
    .insert(rosterSourceConfigurations)
    .values({
      id: configuration.id,
      version: configuration.version,
      population: configuration.population,
    })
    .returning({ createdAt: rosterSourceConfigurations.createdAt });
  if (header === undefined) {
    throw conflict('The roster source configuration could not be refreshed.');
  }
  await database.insert(rosterSourceConfigurationFacilities).values(
    configuration.facilityIds.map((facilityId) => ({
      configurationId: configuration.id,
      configurationVersion: configuration.version,
      facilityId,
    })),
  );
  await database.insert(rosterSourceConfigurationGroups).values(
    configuration.groupSourceRefs.map((source) => ({
      configurationId: configuration.id,
      configurationVersion: configuration.version,
      population: configuration.population,
      groupSourceId: source.id,
      groupSourceKind: source.kind,
      groupPurpose: source.purpose,
    })),
  );
}

async function createGroupSource(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'create-group-source'>,
  actor: Actor,
): Promise<GroupSource> {
  const input = CreateGroupSourceInputSchema.parse(inputValue);
  await database.execute(ADMIN_AVAILABILITY_LOCK_SQL);
  if (input.purpose !== 'access') {
    await lockRosterConfigurationPopulations(database);
  } else {
    const state = await loadAccessSetMutationStateAfterLock(database, actor);
    const emptyBootstrap =
      state.activeAccessGroupSourceIds.length === 0 &&
      state.latestCompleteSnapshot.kind === 'none';
    if (state.accessState === null && !emptyBootstrap) {
      throw conflict(
        'New access groups cannot be added until the active set is restored to proven membership evidence.',
      );
    }
  }
  if (input.facilityId !== null) {
    const facility = await getFacility(database, input.facilityId);
    if (facility === null || !facility.active) {
      throw conflict('A building group requires an active facility.');
    }
  }
  await assertGroupIdentityAvailable(database, input, null);
  const [row] = await database
    .insert(groupSources)
    .values({
      kind: input.kind,
      purpose: input.purpose,
      facilityId: input.facilityId,
      displayName: input.displayName,
      active: input.active,
      googleGroupId: input.kind === 'google-group' ? input.googleGroupId : null,
      email: input.kind === 'google-group' ? input.email : null,
      fixtureKey: input.kind === 'synthetic' ? input.fixtureKey : null,
    })
    .returning();
  if (row === undefined) {
    throw conflict('The group source could not be created.');
  }
  const source = groupSourceFromRow(row);
  const population = sourcePopulation(source);
  if (population !== null) {
    await refreshRosterSourceConfiguration(database, population, {
      additions: [source],
    });
  }
  return source;
}

async function updateGroupSource(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'update-group-source'>,
  actor: Actor,
): Promise<GroupSource> {
  const input = UpdateGroupSourceInputSchema.parse(inputValue);
  let accessMutationState: AccessSetMutationState | null = null;
  let accessRecovery: AccessRecoveryTransition | null = null;
  await database.execute(ADMIN_AVAILABILITY_LOCK_SQL);
  if (input.purpose !== 'access') {
    await lockRosterConfigurationPopulations(database);
  } else {
    accessMutationState = await loadAccessSetMutationStateAfterLock(
      database,
      actor,
    );
  }
  const current = await getGroupSource(database, input.id, true);
  if (current === null) {
    throw notFound('The group source was not found.');
  }
  if (
    current.kind !== input.kind ||
    current.purpose !== input.purpose ||
    current.facilityId !== input.facilityId
  ) {
    throw conflict('Group kind, purpose, and facility cannot be changed.');
  }
  if (current.purpose !== 'access') {
    if (!input.active) {
      throw conflict(
        'A building or others correction must create an active replacement source.',
      );
    }
    await assertGroupIdentityAvailable(database, input, null);
    const [row] = await database
      .insert(groupSources)
      .values({
        kind: input.kind,
        purpose: input.purpose,
        facilityId: input.facilityId,
        displayName: input.displayName,
        active: input.active,
        googleGroupId:
          input.kind === 'google-group' ? input.googleGroupId : null,
        email: input.kind === 'google-group' ? input.email : null,
        fixtureKey: input.kind === 'synthetic' ? input.fixtureKey : null,
      })
      .returning();
    if (row === undefined) {
      throw conflict('The replacement group source could not be created.');
    }
    const replacement = groupSourceFromRow(row);
    const population = sourcePopulation(replacement);
    if (population === null) {
      throw conflict('The replacement source population is unavailable.');
    }
    await refreshRosterSourceConfiguration(database, population, {
      additions: [replacement],
      requiredEffectiveSourceId: current.id,
      supersededSourceIds: [current.id],
    });
    return replacement;
  }
  if (accessMutationState === null) {
    throw conflict('The access-group mutation state is unavailable.');
  }
  if (
    input.purpose !== 'access' ||
    input.kind !== 'google-group' ||
    current.kind !== 'google-group'
  ) {
    throw conflict('The access-group variant is invalid.');
  }
  const locatorChanged =
    current.googleGroupId !== input.googleGroupId ||
    current.email !== input.email;
  if (locatorChanged && !current.active) {
    throw conflict(
      'An inactive access group cannot be used as the origin of a locator correction.',
    );
  }
  if (locatorChanged && !input.active) {
    throw conflict(
      'An access locator correction must create an active replacement source until a complete access snapshot proves the rotation.',
    );
  }
  if (accessMutationState.accessState === null) {
    accessRecovery = accessRecoveryTransition(
      accessMutationState,
      current,
      input,
    );
  }
  if (locatorChanged && current.googleGroupId === input.googleGroupId) {
    throw conflict(
      'Correcting an access email requires a new Google Group ID so the replacement has a distinct immutable identity.',
    );
  }
  if (
    accessMutationState.accessState !== null &&
    !locatorChanged &&
    current.active &&
    !input.active
  ) {
    await assertReachableAdministratorRemains(
      database,
      accessMutationState,
      current.id,
    );
  }
  if (locatorChanged) {
    await assertGroupIdentityAvailable(database, input, null);
    const [replacementRow] = await database
      .insert(groupSources)
      .values({
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: input.displayName,
        active: input.active,
        googleGroupId: input.googleGroupId,
        email: input.email,
        fixtureKey: null,
      })
      .returning();
    if (replacementRow === undefined) {
      throw conflict('The replacement access group could not be created.');
    }
    return groupSourceFromRow(replacementRow);
  }
  await assertGroupIdentityAvailable(database, input, input.id);
  const [row] = await database
    .update(groupSources)
    .set({
      displayName: input.displayName,
      active: input.active,
      googleGroupId: input.googleGroupId,
      email: input.email,
      fixtureKey: null,
    })
    .where(eq(groupSources.id, input.id))
    .returning();
  if (row === undefined) {
    throw conflict('The group source could not be updated.');
  }
  if (
    accessRecovery?.kind === 'strict-snapshot' &&
    accessRecovery.snapshotState !== undefined
  ) {
    const reachableAdministratorIds = await loadEffectiveAdministratorUserIds(
      database,
      { accessState: accessRecovery.snapshotState },
    );
    if (
      actor.kind !== 'human' ||
      !reachableAdministratorIds.includes(actor.userId)
    ) {
      throw new AdminCapabilityError(
        'FORBIDDEN',
        'The restored access set must keep the current human administrator reachable.',
        403,
      );
    }
  }
  const source = groupSourceFromRow(row);
  return source;
}

async function audienceByVersion(
  database: AdminQueryDatabase,
  id: string,
  version: number,
): Promise<AudienceConfig | null> {
  const [header] = await database
    .select()
    .from(audienceConfigurations)
    .where(
      and(
        eq(audienceConfigurations.id, id),
        eq(audienceConfigurations.version, version),
      ),
    )
    .limit(1);
  if (header === undefined) return null;
  const rows = await database
    .select()
    .from(audienceTargets)
    .where(
      and(
        eq(audienceTargets.audienceConfigId, id),
        eq(audienceTargets.audienceConfigVersion, version),
      ),
    )
    .orderBy(asc(audienceTargets.ordinal));
  const targets: Array<AudienceConfig['targets'][number]> = [];
  for (const row of rows) {
    switch (row.targetKind) {
      case 'building':
        if (row.targetFacilityId === null) {
          throw conflict('The building audience target is incomplete.');
        }
        targets.push({ kind: 'building', facilityId: row.targetFacilityId });
        break;
      case 'neighborhood':
        if (row.neighborhoodId === null || row.neighborhoodVersion === null) {
          throw conflict('The neighborhood audience target is incomplete.');
        }
        targets.push({
          kind: 'neighborhood',
          neighborhood: {
            id: row.neighborhoodId,
            version: row.neighborhoodVersion,
          },
        });
        break;
      case 'others': {
        if (row.groupSourceId === null) {
          throw conflict('The others audience target is incomplete.');
        }
        const source = await getGroupSource(database, row.groupSourceId);
        if (source === null || source.purpose !== 'others') {
          throw conflict('The others audience source is unavailable.');
        }
        targets.push({
          kind: 'others',
          groupSourceRef: {
            id: source.id,
            kind: source.kind,
            purpose: source.purpose,
            facilityId: source.facilityId,
          },
        });
        break;
      }
    }
  }
  return AudienceConfigSchema.parse({
    id: header.id,
    facilityId: header.facilityId,
    version: header.version,
    targets,
    createdAt: dateIso(header.createdAt),
  });
}

async function latestAudienceConfig(
  database: AdminQueryDatabase,
  facilityId: string,
): Promise<AudienceConfig | null> {
  const lineages = await database
    .select({ id: audienceConfigurations.id })
    .from(audienceConfigurations)
    .where(eq(audienceConfigurations.facilityId, facilityId))
    .groupBy(audienceConfigurations.id)
    .limit(2);
  if (lineages.length > 1) {
    throw conflict('The facility has conflicting audience lineages.');
  }
  const lineage = lineages[0];
  if (lineage === undefined) return null;
  const [header] = await database
    .select({
      id: audienceConfigurations.id,
      version: audienceConfigurations.version,
    })
    .from(audienceConfigurations)
    .where(eq(audienceConfigurations.id, lineage.id))
    .orderBy(desc(audienceConfigurations.version))
    .limit(1);
  return header === undefined
    ? null
    : audienceByVersion(database, header.id, header.version);
}

async function latestAudienceConfigs(
  database: AdminQueryDatabase,
  facilityIds: readonly string[],
): Promise<readonly AudienceConfig[]> {
  if (facilityIds.length === 0) return Object.freeze([]);
  const lineageRows = await database
    .select({
      facilityId: audienceConfigurations.facilityId,
      id: audienceConfigurations.id,
    })
    .from(audienceConfigurations)
    .where(inArray(audienceConfigurations.facilityId, facilityIds))
    .groupBy(audienceConfigurations.facilityId, audienceConfigurations.id)
    .orderBy(
      asc(audienceConfigurations.facilityId),
      asc(audienceConfigurations.id),
    );
  const lineageByFacility = new Map<string, string>();
  for (const row of lineageRows) {
    const existing = lineageByFacility.get(row.facilityId);
    if (existing !== undefined && existing !== row.id) {
      throw conflict('The facility has conflicting audience lineages.');
    }
    lineageByFacility.set(row.facilityId, row.id);
  }
  if (lineageRows.length === 0) return Object.freeze([]);

  const headers = await database
    .selectDistinctOn([audienceConfigurations.facilityId], {
      createdAt: audienceConfigurations.createdAt,
      facilityId: audienceConfigurations.facilityId,
      id: audienceConfigurations.id,
      version: audienceConfigurations.version,
    })
    .from(audienceConfigurations)
    .where(
      inArray(audienceConfigurations.id, [
        ...new Set(lineageRows.map(({ id }) => id)),
      ]),
    )
    .orderBy(
      asc(audienceConfigurations.facilityId),
      desc(audienceConfigurations.version),
    );
  if (headers.length === 0) return Object.freeze([]);

  const targetsByVersion = new Map<
    string,
    Array<AudienceConfig['targets'][number]>
  >();
  for (const headerBatch of chunks(
    headers,
    DATA_API_AUDIENCE_HEADER_BATCH_SIZE,
  )) {
    const targetRows = await database
      .select({
        audienceConfigId: audienceTargets.audienceConfigId,
        audienceConfigVersion: audienceTargets.audienceConfigVersion,
        neighborhoodId: audienceTargets.neighborhoodId,
        neighborhoodVersion: audienceTargets.neighborhoodVersion,
        ordinal: audienceTargets.ordinal,
        sourceFacilityId: groupSources.facilityId,
        sourceId: groupSources.id,
        sourceKind: groupSources.kind,
        sourcePurpose: groupSources.purpose,
        targetFacilityId: audienceTargets.targetFacilityId,
        targetKind: audienceTargets.targetKind,
      })
      .from(audienceTargets)
      .leftJoin(
        groupSources,
        eq(audienceTargets.groupSourceId, groupSources.id),
      )
      .where(
        or(
          ...headerBatch.map((header) =>
            and(
              eq(audienceTargets.audienceConfigId, header.id),
              eq(audienceTargets.audienceConfigVersion, header.version),
            ),
          ),
        ),
      )
      .orderBy(
        asc(audienceTargets.audienceConfigId),
        asc(audienceTargets.audienceConfigVersion),
        asc(audienceTargets.ordinal),
      );
    for (const row of targetRows) {
      const key = `${row.audienceConfigId}:${row.audienceConfigVersion}`;
      const targets = targetsByVersion.get(key) ?? [];
      switch (row.targetKind) {
        case 'building':
          if (row.targetFacilityId === null) {
            throw conflict('The building audience target is incomplete.');
          }
          targets.push({ kind: 'building', facilityId: row.targetFacilityId });
          break;
        case 'neighborhood':
          if (row.neighborhoodId === null || row.neighborhoodVersion === null) {
            throw conflict('The neighborhood audience target is incomplete.');
          }
          targets.push({
            kind: 'neighborhood',
            neighborhood: {
              id: row.neighborhoodId,
              version: row.neighborhoodVersion,
            },
          });
          break;
        case 'others':
          if (
            row.sourceId === null ||
            row.sourceKind === null ||
            row.sourcePurpose !== 'others' ||
            row.sourceFacilityId !== null
          ) {
            throw conflict('The others audience source is unavailable.');
          }
          targets.push({
            kind: 'others',
            groupSourceRef: {
              id: row.sourceId,
              kind: row.sourceKind,
              purpose: 'others',
              facilityId: null,
            },
          });
          break;
      }
      targetsByVersion.set(key, targets);
    }
  }

  return Object.freeze(
    headers.map((header) =>
      AudienceConfigSchema.parse({
        id: header.id,
        facilityId: header.facilityId,
        version: header.version,
        targets: targetsByVersion.get(`${header.id}:${header.version}`) ?? [],
        createdAt: dateIso(header.createdAt),
      }),
    ),
  );
}

async function validateAudienceTargets(
  database: AdminQueryDatabase,
  input: CapabilityInput<'create-audience-config-version'>,
): Promise<void> {
  const owningBuildingTargets = input.targets.filter(
    (target) =>
      target.kind === 'building' && target.facilityId === input.facilityId,
  );
  if (owningBuildingTargets.length !== 1) {
    throw conflict(
      'Every audience version must include exactly one building target for its owning facility.',
    );
  }
  const facility = await getFacility(database, input.facilityId);
  if (facility === null || !facility.active) {
    throw conflict('Audience configuration requires an active facility.');
  }
  const effectiveSourceIds = await effectiveRosterSourceIds(database);
  const targetFacilityIds = new Set([input.facilityId]);
  const othersKinds = new Set<'google-group' | 'synthetic'>();
  for (const target of input.targets) {
    if (target.kind === 'neighborhood') {
      const neighborhood = await neighborhoodByVersion(
        database,
        target.neighborhood.id,
        target.neighborhood.version,
      );
      if (
        neighborhood === null ||
        !neighborhood.facilityIds.includes(input.facilityId)
      ) {
        throw conflict(
          'The selected neighborhood must include the audience facility.',
        );
      }
      neighborhood.facilityIds.forEach((facilityId) =>
        targetFacilityIds.add(facilityId),
      );
    }
    if (target.kind === 'others') {
      const source = await getGroupSource(database, target.groupSourceRef.id);
      if (
        source === null ||
        !effectiveSourceIds.has(source.id) ||
        source.kind !== target.groupSourceRef.kind ||
        source.purpose !== 'others'
      ) {
        throw conflict('The selected others group is unavailable.');
      }
      othersKinds.add(source.kind);
    }
  }
  if (othersKinds.size > 1) {
    throw conflict(
      'One audience version cannot mix staff Google and synthetic TEST others sources.',
    );
  }

  const targetedFacilities = await database
    .select({ id: facilities.id, active: facilities.active })
    .from(facilities)
    .where(inArray(facilities.id, [...targetFacilityIds]));
  if (
    targetedFacilities.length !== targetFacilityIds.size ||
    targetedFacilities.some(({ active }) => !active)
  ) {
    throw conflict('Every audience facility must be active and available.');
  }
  const configuredSourceIds = [...effectiveSourceIds];
  const buildingSources =
    configuredSourceIds.length === 0
      ? []
      : await database
          .select({
            facilityId: groupSources.facilityId,
            kind: groupSources.kind,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.purpose, 'building'),
              inArray(groupSources.id, configuredSourceIds),
              inArray(groupSources.facilityId, [...targetFacilityIds]),
            ),
          );
  const requiredKind = [...othersKinds][0];
  const missingBuildingSource = [...targetFacilityIds].some(
    (facilityId) =>
      !buildingSources.some(
        (source) =>
          source.facilityId === facilityId &&
          (requiredKind === undefined || source.kind === requiredKind),
      ),
  );
  if (missingBuildingSource) {
    throw conflict(
      requiredKind === undefined
        ? 'Configure an active building group for every audience facility before saving.'
        : `Configure an active ${requiredKind} building group for every audience facility before selecting matching others sources.`,
    );
  }
}

async function createAudienceConfigVersion(
  database: AdminQueryDatabase,
  inputValue: CapabilityInput<'create-audience-config-version'>,
): Promise<AudienceConfig> {
  const input = CreateAudienceConfigVersionInputSchema.parse(inputValue);
  // Serialize every facility/roster-dependent administrator mutation before
  // taking row locks. This preserves the replacement-before-audience order
  // without forming a facility-row/advisory-lock cycle.
  await lockRosterConfigurationPopulations(database);
  const [lockedFacility] = await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.id, input.facilityId))
    .limit(1)
    .for('update');
  if (lockedFacility === undefined) {
    throw notFound('The audience facility was not found.');
  }
  await validateAudienceTargets(database, input);
  const id = input.audienceConfigId ?? randomUUID();
  let version = 1;
  if (input.audienceConfigId === null) {
    const [existing] = await database
      .select({ id: audienceConfigurations.id })
      .from(audienceConfigurations)
      .where(eq(audienceConfigurations.facilityId, input.facilityId))
      .limit(1);
    if (existing !== undefined) {
      throw conflict(
        'This facility already has an audience configuration; append a version to its existing identity.',
      );
    }
  } else {
    const [latest] = await database
      .select({
        facilityId: audienceConfigurations.facilityId,
        version: audienceConfigurations.version,
      })
      .from(audienceConfigurations)
      .where(eq(audienceConfigurations.id, input.audienceConfigId))
      .orderBy(desc(audienceConfigurations.version))
      .limit(1)
      .for('update');
    if (latest === undefined) {
      throw notFound('The audience configuration was not found.');
    }
    if (latest.facilityId !== input.facilityId) {
      throw conflict('Audience configuration identity cannot move facilities.');
    }
    version = latest.version + 1;
  }
  const [header] = await database
    .insert(audienceConfigurations)
    .values({ id, facilityId: input.facilityId, version })
    .returning();
  if (header === undefined) {
    throw conflict('The audience configuration could not be created.');
  }
  await database.insert(audienceTargets).values(
    input.targets.map((target, index) => ({
      audienceConfigId: id,
      audienceConfigVersion: version,
      ordinal: index + 1,
      targetKind: target.kind,
      targetFacilityId: target.kind === 'building' ? target.facilityId : null,
      neighborhoodId:
        target.kind === 'neighborhood' ? target.neighborhood.id : null,
      neighborhoodVersion:
        target.kind === 'neighborhood' ? target.neighborhood.version : null,
      groupSourceId: target.kind === 'others' ? target.groupSourceRef.id : null,
    })),
  );
  return AudienceConfigSchema.parse({
    id,
    facilityId: input.facilityId,
    version,
    targets: input.targets,
    createdAt: dateIso(header.createdAt),
  });
}

interface ResultReference {
  readonly id: string;
  readonly version: number | null;
  readonly outputDigest: string | null;
}

function resultReference(
  id: string,
  version: number | null,
  output?: unknown,
): string {
  return Buffer.from(
    JSON.stringify({
      id,
      version,
      outputDigest: output === undefined ? null : digestCapabilityValue(output),
    }),
    'utf8',
  ).toString('base64url');
}

function parseResultReference(value: string): ResultReference {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) {
      throw new TypeError();
    }
    const id = Reflect.get(parsed, 'id');
    const version = Reflect.get(parsed, 'version');
    const outputDigest = Reflect.get(parsed, 'outputDigest');
    return {
      id: UuidSchema.parse(id),
      version:
        version === null
          ? null
          : Number.isSafeInteger(version) && Number(version) > 0
            ? Number(version)
            : (() => {
                throw new TypeError();
              })(),
      outputDigest:
        outputDigest === null ||
        (typeof outputDigest === 'string' &&
          /^[a-f0-9]{64}$/u.test(outputDigest))
          ? outputDigest
          : (() => {
              throw new TypeError();
            })(),
    };
  } catch {
    throw conflict('The idempotency result reference is invalid.');
  }
}

function assertReplayOutput(reference: ResultReference, output: unknown): void {
  if (
    reference.outputDigest !== null &&
    reference.outputDigest !== digestCapabilityValue(output)
  ) {
    throw conflict(
      'The original idempotent result is no longer reconstructable; replay was refused rather than returning changed data.',
    );
  }
}

function requireVersion(reference: ResultReference): number {
  if (reference.version === null) {
    throw conflict('The idempotency result version is unavailable.');
  }
  return reference.version;
}

export const listFacilitiesRegistration: ServerCapabilityRegistration<
  'list-facilities',
  AdminCapabilityTransaction
> = {
  id: 'list-facilities',
  resolveFacilityId: (_input, context) => guard(context, null),
  handler: (input, context) =>
    listFacilities(context.transaction.database, input),
};

export const getFacilityRegistration: ServerCapabilityRegistration<
  'get-facility',
  AdminCapabilityTransaction
> = {
  id: 'get-facility',
  resolveFacilityId: (input, context) =>
    resolveExistingFacilityId(context, input.facilityId),
  async handler(input, context) {
    const facility = await getFacility(
      context.transaction.database,
      input.facilityId,
    );
    if (facility === null) throw notFound('The facility was not found.');
    return facility;
  },
};

export const createFacilityRegistration: ServerCapabilityRegistration<
  'create-facility',
  AdminCapabilityTransaction
> = {
  id: 'create-facility',
  resolveFacilityId: (_input, context) => guard(context, null),
  handler: (input, context) =>
    createFacility(context.transaction.database, input),
  resultReference: (output) => resultReference(output.id, null, output),
  async loadReplay(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await getFacility(context.transaction.database, parsed.id);
    if (output === null) throw conflict('The created facility is unavailable.');
    assertReplayOutput(parsed, output);
    return output;
  },
  async resolveReplayFacilityId(reference, context) {
    const parsed = parseResultReference(reference);
    return resolveExistingFacilityId(context, parsed.id);
  },
  replayFacilityId: (output) => output.id,
};

export const updateFacilityRegistration: ServerCapabilityRegistration<
  'update-facility',
  AdminCapabilityTransaction
> = {
  id: 'update-facility',
  resolveFacilityId: (input, context) =>
    resolveExistingFacilityId(context, input.facilityId),
  handler: (input, context) =>
    updateFacility(context.transaction.database, input),
  resultReference: (output) => resultReference(output.id, null, output),
  async loadReplay(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await getFacility(context.transaction.database, parsed.id);
    if (output === null) throw conflict('The updated facility is unavailable.');
    assertReplayOutput(parsed, output);
    return output;
  },
  async resolveReplayFacilityId(reference, context) {
    const parsed = parseResultReference(reference);
    return resolveExistingFacilityId(context, parsed.id);
  },
  replayFacilityId: (output) => output.id,
};

export const listNeighborhoodsRegistration: ServerCapabilityRegistration<
  'list-neighborhoods',
  AdminCapabilityTransaction
> = {
  id: 'list-neighborhoods',
  resolveFacilityId: (_input, context) => guard(context, null),
  handler: (input, context) =>
    listNeighborhoods(context.transaction.database, input),
};

export const listNeighborhoodVersionsRegistration: ServerCapabilityRegistration<
  'list-neighborhood-versions',
  AdminCapabilityTransaction
> = {
  id: 'list-neighborhood-versions',
  resolveFacilityId: (_input, context) => guard(context, null),
  handler: (input, context) =>
    listNeighborhoodVersions(context.transaction.database, input),
};

export const getNeighborhoodVersionRegistration: ServerCapabilityRegistration<
  'get-neighborhood-version',
  AdminCapabilityTransaction
> = {
  id: 'get-neighborhood-version',
  resolveFacilityId: (_input, context) => guard(context, null),
  async handler(input, context) {
    const output = await neighborhoodByVersion(
      context.transaction.database,
      input.neighborhood.id,
      input.neighborhood.version,
    );
    if (output === null)
      throw notFound('The neighborhood version was not found.');
    return output;
  },
};

export const createNeighborhoodVersionRegistration: ServerCapabilityRegistration<
  'create-neighborhood-version',
  AdminCapabilityTransaction
> = {
  id: 'create-neighborhood-version',
  resolveFacilityId: (_input, context) => guard(context, null),
  handler: (input, context) =>
    createNeighborhoodVersion(context.transaction.database, input),
  resultReference: (output) => resultReference(output.id, output.version),
  async loadReplay(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await neighborhoodByVersion(
      context.transaction.database,
      parsed.id,
      requireVersion(parsed),
    );
    if (output === null)
      throw conflict('The neighborhood version is unavailable.');
    return output;
  },
  resolveReplayFacilityId(reference, context) {
    parseResultReference(reference);
    return guard(context, null);
  },
  replayFacilityId: () => null,
};

export const listGroupSourcesRegistration: ServerCapabilityRegistration<
  'list-group-sources',
  AdminCapabilityTransaction
> = {
  id: 'list-group-sources',
  resolveFacilityId: (input, context) =>
    input.facilityId === null
      ? guard(context, null)
      : resolveExistingFacilityId(context, input.facilityId),
  handler: (input, context) =>
    listGroupSources(context.transaction.database, input),
};

export const createGroupSourceRegistration: ServerCapabilityRegistration<
  'create-group-source',
  AdminCapabilityTransaction
> = {
  id: 'create-group-source',
  resolveFacilityId: (input, context) =>
    input.facilityId === null
      ? guard(context, null)
      : resolveExistingFacilityId(context, input.facilityId),
  async handler(input, context) {
    const output = await createGroupSource(
      context.transaction.database,
      input,
      context.invocation.actor,
    );
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: (output) => resultReference(output.id, null, output),
  async loadReplay(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await getGroupSource(
      context.transaction.database,
      parsed.id,
    );
    if (output === null) throw conflict('The group source is unavailable.');
    assertReplayOutput(parsed, output);
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  async resolveReplayFacilityId(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await getGroupSource(
      context.transaction.database,
      parsed.id,
    );
    if (output === null) throw conflict('The group source is unavailable.');
    return guard(context, output.facilityId);
  },
  replayFacilityId: (output) => output.facilityId,
};

export const updateGroupSourceRegistration: ServerCapabilityRegistration<
  'update-group-source',
  AdminCapabilityTransaction
> = {
  id: 'update-group-source',
  async resolveFacilityId(input, context) {
    guard(context, null);
    const source = await getGroupSource(context.transaction.database, input.id);
    return source?.facilityId ?? null;
  },
  async handler(input, context) {
    const output = await updateGroupSource(
      context.transaction.database,
      input,
      context.invocation.actor,
    );
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: (output) => resultReference(output.id, null, output),
  async loadReplay(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await getGroupSource(
      context.transaction.database,
      parsed.id,
    );
    if (output === null) throw conflict('The group source is unavailable.');
    assertReplayOutput(parsed, output);
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  async resolveReplayFacilityId(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await getGroupSource(
      context.transaction.database,
      parsed.id,
    );
    if (output === null) throw conflict('The group source is unavailable.');
    return guard(context, output.facilityId);
  },
  replayFacilityId: (output) => output.facilityId,
};

export const getAudienceConfigRegistration: ServerCapabilityRegistration<
  'get-audience-config',
  AdminCapabilityTransaction
> = {
  id: 'get-audience-config',
  resolveFacilityId: (input, context) =>
    resolveExistingFacilityId(context, input.facilityId),
  async handler(input, context) {
    const output = await latestAudienceConfig(
      context.transaction.database,
      input.facilityId,
    );
    if (output === null)
      throw notFound('The audience configuration was not found.');
    return output;
  },
};

export const getAudienceConfigVersionRegistration: ServerCapabilityRegistration<
  'get-audience-config-version',
  AdminCapabilityTransaction
> = {
  id: 'get-audience-config-version',
  resolveFacilityId: async (input, context) => {
    guard(context, null);
    const output = await audienceByVersion(
      context.transaction.database,
      input.audienceConfig.id,
      input.audienceConfig.version,
    );
    if (output === null) throw notFound('The audience version was not found.');
    return output.facilityId;
  },
  async handler(input, context) {
    const output = await audienceByVersion(
      context.transaction.database,
      input.audienceConfig.id,
      input.audienceConfig.version,
    );
    if (output === null) throw notFound('The audience version was not found.');
    return output;
  },
};

export const createAudienceConfigVersionRegistration: ServerCapabilityRegistration<
  'create-audience-config-version',
  AdminCapabilityTransaction
> = {
  id: 'create-audience-config-version',
  resolveFacilityId: (input, context) =>
    resolveExistingFacilityId(context, input.facilityId),
  handler: (input, context) =>
    createAudienceConfigVersion(context.transaction.database, input),
  resultReference: (output) => resultReference(output.id, output.version),
  async loadReplay(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await audienceByVersion(
      context.transaction.database,
      parsed.id,
      requireVersion(parsed),
    );
    if (output === null) throw conflict('The audience version is unavailable.');
    return output;
  },
  async resolveReplayFacilityId(reference, context) {
    const parsed = parseResultReference(reference);
    const output = await audienceByVersion(
      context.transaction.database,
      parsed.id,
      requireVersion(parsed),
    );
    if (output === null) throw conflict('The audience version is unavailable.');
    return guard(context, output.facilityId);
  },
  replayFacilityId: (output) => output.facilityId,
};

const ADMIN_FACILITY_CATALOG_LIMIT = 200;
const ADMIN_NEIGHBORHOOD_CATALOG_LIMIT = 200;
const ADMIN_GROUP_CATALOG_LIMIT = 500;
// Aurora Data API rejects a response over 1 MiB. Neighborhoods can contain
// 200 facilities and audiences can contain 500 targets, so fetch only compact
// membership fields in conservative, sequential batches.
const DATA_API_NEIGHBORHOOD_HEADER_BATCH_SIZE = 20;
const DATA_API_AUDIENCE_HEADER_BATCH_SIZE = 2;

function chunks<Item>(
  items: readonly Item[],
  size: number,
): readonly (readonly Item[])[] {
  const result: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

export interface FacilitiesAdminProjection {
  readonly facilities: FacilityPage;
  readonly neighborhoods: NeighborhoodPage;
  readonly buildingGroups: GroupSourcePage;
  readonly othersGroups: GroupSourcePage;
  readonly facilityOptions: readonly Facility[];
  readonly neighborhoodOptions: readonly Neighborhood[];
  readonly buildingGroupOptions: readonly GroupSource[];
  readonly othersGroupOptions: readonly GroupSource[];
  readonly audienceConfigs: readonly AudienceConfig[];
}

function requireCompleteCatalog<Item>(
  page: Readonly<{
    items: readonly Item[];
    pageInfo: Readonly<{ hasMore: boolean }>;
  }>,
  label: string,
): readonly Item[] {
  if (page.pageInfo.hasMore) {
    throw conflict(
      `The complete ${label} option catalog exceeds the safe administrative bound.`,
    );
  }
  return page.items;
}

async function facilitiesAdminProjection(
  database: AdminQueryDatabase,
  queries: Readonly<{
    facilities: CapabilityInput<'list-facilities'>;
    neighborhoods: CapabilityInput<'list-neighborhoods'>;
    buildingGroups: CapabilityInput<'list-group-sources'>;
    othersGroups: CapabilityInput<'list-group-sources'>;
  }>,
): Promise<FacilitiesAdminProjection> {
  if (
    queries.buildingGroups.purpose !== 'building' ||
    queries.othersGroups.purpose !== 'others'
  ) {
    throw invalid('The facilities administration projection is invalid.');
  }
  const effectiveSourceIds = await effectiveRosterSourceIds(database);
  const pagedFacilities = await listFacilities(database, queries.facilities);
  const pagedNeighborhoods = await listNeighborhoods(
    database,
    queries.neighborhoods,
  );
  const pagedBuildingGroups = await listGroupSources(
    database,
    queries.buildingGroups,
    effectiveSourceIds,
  );
  const pagedOthersGroups = await listGroupSources(
    database,
    queries.othersGroups,
    effectiveSourceIds,
  );
  const completeFacilities = await listFacilities(database, {
    includeInactive: true,
    cursor: null,
    limit: ADMIN_FACILITY_CATALOG_LIMIT,
  });
  const completeNeighborhoods = await listNeighborhoods(database, {
    cursor: null,
    limit: ADMIN_NEIGHBORHOOD_CATALOG_LIMIT,
  });
  const completeBuildingGroups = await listGroupSources(
    database,
    {
      kind: null,
      purpose: 'building',
      facilityId: null,
      active: null,
      cursor: null,
      limit: ADMIN_GROUP_CATALOG_LIMIT,
    },
    effectiveSourceIds,
  );
  const completeOthersGroups = await listGroupSources(
    database,
    {
      kind: null,
      purpose: 'others',
      facilityId: null,
      active: null,
      cursor: null,
      limit: ADMIN_GROUP_CATALOG_LIMIT,
    },
    effectiveSourceIds,
  );
  return Object.freeze({
    facilities: pagedFacilities,
    neighborhoods: pagedNeighborhoods,
    buildingGroups: pagedBuildingGroups,
    othersGroups: pagedOthersGroups,
    facilityOptions: requireCompleteCatalog(completeFacilities, 'facility'),
    neighborhoodOptions: requireCompleteCatalog(
      completeNeighborhoods,
      'neighborhood',
    ),
    buildingGroupOptions: requireCompleteCatalog(
      completeBuildingGroups,
      'building-group',
    ),
    othersGroupOptions: requireCompleteCatalog(
      completeOthersGroups,
      'others-group',
    ),
    audienceConfigs: await latestAudienceConfigs(
      database,
      pagedFacilities.items.map(({ id }) => id),
    ),
  });
}

export function createDefaultFacilityAdminStore(
  authenticated: AuthenticatedSession,
): AdminCapabilityStore {
  return createDrizzleAdminCapabilityStore(
    getDefaultAdminDatabase(),
    authenticated,
  );
}

interface QueryExecution<Input> {
  readonly authenticated: AuthenticatedSession;
  readonly store?: AdminCapabilityStore;
  readonly query: Input;
  readonly metadata?: AdminQueryMetadata;
}

interface MutationExecution<Input> {
  readonly authenticated: AuthenticatedSession;
  readonly store?: AdminCapabilityStore;
  readonly command: Input;
  readonly metadata: AdminMutationMetadata;
}

function executionStore(
  authenticated: AuthenticatedSession,
  store: AdminCapabilityStore | undefined,
): AdminCapabilityStore {
  return store ?? createDefaultFacilityAdminStore(authenticated);
}

export async function executeFacilitiesAdminProjection(
  input: Readonly<{
    authenticated: AuthenticatedSession;
    store?: AdminCapabilityStore;
    queries: Readonly<{
      facilities: CapabilityInput<'list-facilities'>;
      neighborhoods: CapabilityInput<'list-neighborhoods'>;
      buildingGroups: CapabilityInput<'list-group-sources'>;
      othersGroups: CapabilityInput<'list-group-sources'>;
    }>;
    metadata?: AdminQueryMetadata;
  }>,
): Promise<FacilitiesAdminProjection> {
  const holder: { projection?: FacilitiesAdminProjection } = {};
  const registration: ServerCapabilityRegistration<
    'list-facilities',
    AdminCapabilityTransaction
  > = {
    ...listFacilitiesRegistration,
    async handler(facilitiesQuery, context) {
      const parsedNeighborhoods = ListNeighborhoodsInputSchema.safeParse(
        input.queries.neighborhoods,
      );
      const parsedBuildingGroups = ListGroupSourcesInputSchema.safeParse(
        input.queries.buildingGroups,
      );
      const parsedOthersGroups = ListGroupSourcesInputSchema.safeParse(
        input.queries.othersGroups,
      );
      if (
        !parsedNeighborhoods.success ||
        !parsedBuildingGroups.success ||
        !parsedOthersGroups.success
      ) {
        throw invalid('The facilities administration query is invalid.');
      }
      const projection = await facilitiesAdminProjection(
        context.transaction.database,
        {
          facilities: facilitiesQuery,
          neighborhoods: parsedNeighborhoods.data,
          buildingGroups: parsedBuildingGroups.data,
          othersGroups: parsedOthersGroups.data,
        },
      );
      holder.projection = projection;
      return projection.facilities;
    },
  };
  await executeAdminQueryCapability(
    registration,
    input.queries.facilities,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
  if (holder.projection === undefined) {
    throw conflict('The facilities administration projection is unavailable.');
  }
  return holder.projection;
}

export const executeListFacilitiesCapability = (
  input: QueryExecution<CapabilityInput<'list-facilities'>>,
) =>
  executeAdminQueryCapability(
    listFacilitiesRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeGetFacilityCapability = (
  input: QueryExecution<CapabilityInput<'get-facility'>>,
) =>
  executeAdminQueryCapability(
    getFacilityRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeCreateFacilityCapability = (
  input: MutationExecution<CapabilityInput<'create-facility'>>,
) =>
  executeAdminMutationCapability(
    createFacilityRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeUpdateFacilityCapability = (
  input: MutationExecution<CapabilityInput<'update-facility'>>,
) =>
  executeAdminMutationCapability(
    updateFacilityRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeListNeighborhoodsCapability = (
  input: QueryExecution<CapabilityInput<'list-neighborhoods'>>,
) =>
  executeAdminQueryCapability(
    listNeighborhoodsRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeListNeighborhoodVersionsCapability = (
  input: QueryExecution<CapabilityInput<'list-neighborhood-versions'>>,
) =>
  executeAdminQueryCapability(
    listNeighborhoodVersionsRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeGetNeighborhoodVersionCapability = (
  input: QueryExecution<CapabilityInput<'get-neighborhood-version'>>,
) =>
  executeAdminQueryCapability(
    getNeighborhoodVersionRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeCreateNeighborhoodVersionCapability = (
  input: MutationExecution<CapabilityInput<'create-neighborhood-version'>>,
) =>
  executeAdminMutationCapability(
    createNeighborhoodVersionRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeListGroupSourcesCapability = (
  input: QueryExecution<CapabilityInput<'list-group-sources'>>,
) =>
  executeAdminQueryCapability(
    listGroupSourcesRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeCreateGroupSourceCapability = (
  input: MutationExecution<CapabilityInput<'create-group-source'>>,
) =>
  executeAdminMutationCapability(
    createGroupSourceRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeUpdateGroupSourceCapability = (
  input: MutationExecution<CapabilityInput<'update-group-source'>>,
) =>
  executeAdminMutationCapability(
    updateGroupSourceRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeGetAudienceConfigCapability = (
  input: QueryExecution<CapabilityInput<'get-audience-config'>>,
) =>
  executeAdminQueryCapability(
    getAudienceConfigRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeGetAudienceConfigVersionCapability = (
  input: QueryExecution<CapabilityInput<'get-audience-config-version'>>,
) =>
  executeAdminQueryCapability(
    getAudienceConfigVersionRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeCreateAudienceConfigVersionCapability = (
  input: MutationExecution<CapabilityInput<'create-audience-config-version'>>,
) =>
  executeAdminMutationCapability(
    createAudienceConfigVersionRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
