import {
  AccessGroupSourceRefSchema,
  UuidSchema,
  RoleSchema,
  type Role,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notExists,
  sql,
} from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  userRoleChanges,
  userRoles,
  userFacilityScopes,
  users,
} from '../../db/schema';

/** Minimal common query surface shared by PostgreSQL and Aurora Data API. */
export type RoleStateDatabase = Pick<Database, 'select' | 'selectDistinctOn'>;

/** Serializes every mutation that can change effective administrator reachability. */
export const ADMIN_AVAILABILITY_LOCK_SQL = sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-admin-availability', 0))`;

/**
 * One certified access-configuration generation. `null` means the latest
 * complete snapshot is absent, malformed, partial, duplicated, or does not
 * exactly match the current nonempty active Google access-source ID set.
 */
export interface AccessConfigurationSnapshotState {
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly activeAccessGroupSourceIds: readonly string[];
}

/** Optional prospective filter for the effective-administrator projection. */
export interface EffectiveAdministratorQueryOptions {
  /** A state already loaded under the caller's administrator-availability lock. */
  readonly accessState?: AccessConfigurationSnapshotState;
  /**
   * Existing active IDs that will remain eligible after a proposed mutation.
   * New, inactive, duplicated, malformed, or otherwise uncertified IDs fail
   * closed and yield no reachable administrators.
   */
  readonly eligibleAccessGroupSourceIds?: readonly string[];
}

/** One ordered append-only role decision used by the effective-state fold. */
export interface RoleChangeFact {
  readonly sequence: number;
  readonly role: Role;
  readonly granted: boolean;
}

const ROLE_ORDER: Readonly<Record<Role, number>> = Object.freeze({
  staff: 0,
  admin: 1,
});

/**
 * Projects immutable base grants through ordered append-only grant/revoke
 * facts. A role's latest fact wins; roles without a fact retain their base
 * grant. The result is deterministic and canonical for every auth loader.
 */
export function projectEffectiveRoles(
  baseRoles: readonly Role[],
  changes: readonly RoleChangeFact[],
): readonly Role[] {
  const effective = new Set(baseRoles.map((role) => RoleSchema.parse(role)));
  const orderedChanges = [...changes].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const change of orderedChanges) {
    const role = RoleSchema.parse(change.role);
    if (change.granted) effective.add(role);
    else effective.delete(role);
  }
  return Object.freeze(
    [...effective].sort((left, right) => ROLE_ORDER[left] - ROLE_ORDER[right]),
  );
}

/** Loads the one canonical effective-role projection for a persisted user. */
export async function loadEffectiveRoles(
  database: RoleStateDatabase,
  userId: string,
): Promise<readonly Role[]> {
  const baseGrants = database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .as('role_base_grants');
  const latestChanges = database
    .selectDistinctOn([userRoleChanges.role], {
      sequence: userRoleChanges.sequence,
      role: userRoleChanges.role,
      granted: userRoleChanges.granted,
    })
    .from(userRoleChanges)
    .where(eq(userRoleChanges.userId, userId))
    .orderBy(asc(userRoleChanges.role), desc(userRoleChanges.sequence))
    .as('latest_role_changes');

  // One selected-row statement gives both transports one coherent snapshot
  // and never overlaps work on an Aurora Data API transaction ID.
  const rows = await database
    .select({
      role: sql<Role>`coalesce(${latestChanges.role}, ${baseGrants.role})`,
      granted: sql<boolean>`coalesce(${latestChanges.granted}, true)`,
    })
    .from(baseGrants)
    .fullJoin(latestChanges, eq(latestChanges.role, baseGrants.role))
    .orderBy(sql`coalesce(${latestChanges.role}, ${baseGrants.role})`);
  return Object.freeze(
    rows
      .filter(({ granted }) => granted)
      .map(({ role }) => RoleSchema.parse(role))
      .sort((left, right) => ROLE_ORDER[left] - ROLE_ORDER[right]),
  );
}

function canonicalAccessGroupIds(
  rows: readonly Readonly<{
    id: string;
    kind: 'google-group' | 'synthetic';
    purpose: 'access' | 'building' | 'others';
  }>[],
): readonly string[] | null {
  const parsedIds: string[] = [];
  for (const row of rows) {
    const parsed = AccessGroupSourceRefSchema.safeParse({
      id: row.id,
      kind: row.kind,
      purpose: row.purpose,
      facilityId: null,
    });
    if (
      !parsed.success ||
      parsed.data.kind !== 'google-group' ||
      parsed.data.purpose !== 'access' ||
      parsed.data.facilityId !== null
    ) {
      return null;
    }
    parsedIds.push(parsed.data.id);
  }
  if (parsedIds.length === 0 || new Set(parsedIds).size !== parsedIds.length) {
    return null;
  }
  return Object.freeze(parsedIds.sort());
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function validateAccessState(
  state: AccessConfigurationSnapshotState,
): AccessConfigurationSnapshotState | null {
  if (
    !UuidSchema.safeParse(state.snapshotId).success ||
    !Number.isSafeInteger(state.snapshotVersion) ||
    state.snapshotVersion < 1
  ) {
    return null;
  }
  const ids = state.activeAccessGroupSourceIds.map((id) =>
    UuidSchema.safeParse(id),
  );
  if (
    ids.length === 0 ||
    ids.some((id) => !id.success) ||
    new Set(state.activeAccessGroupSourceIds).size !==
      state.activeAccessGroupSourceIds.length
  ) {
    return null;
  }
  return Object.freeze({
    snapshotId: state.snapshotId,
    snapshotVersion: state.snapshotVersion,
    activeAccessGroupSourceIds: Object.freeze(
      [...state.activeAccessGroupSourceIds].sort(),
    ),
  });
}

/**
 * Loads the latest complete access snapshot only when its expected and
 * completed source sets are both strict, duplicate-free, and exactly equal to
 * the current nonempty active Google access-source set.
 */
export async function loadAccessConfigurationSnapshotState(
  database: RoleStateDatabase,
): Promise<AccessConfigurationSnapshotState | null> {
  const activeRows = await database
    .select({
      id: groupSources.id,
      kind: groupSources.kind,
      purpose: groupSources.purpose,
    })
    .from(groupSources)
    .where(
      and(eq(groupSources.active, true), eq(groupSources.purpose, 'access')),
    )
    .orderBy(asc(groupSources.id));
  const activeIds = canonicalAccessGroupIds(activeRows);
  if (activeIds === null) return null;

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
  if (snapshot === undefined) return null;

  const snapshotRows = await database
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
  const expectedIds = canonicalAccessGroupIds(
    snapshotRows.filter(({ completionKind }) => completionKind === 'expected'),
  );
  const completedIds = canonicalAccessGroupIds(
    snapshotRows.filter(({ completionKind }) => completionKind === 'completed'),
  );
  if (
    expectedIds === null ||
    completedIds === null ||
    snapshotRows.length !== expectedIds.length + completedIds.length ||
    !sameIds(activeIds, expectedIds) ||
    !sameIds(expectedIds, completedIds)
  ) {
    return null;
  }

  return Object.freeze({
    snapshotId: snapshot.id,
    snapshotVersion: snapshot.version,
    activeAccessGroupSourceIds: activeIds,
  });
}

/**
 * Loads district administrators who remain eligible through the newest
 * complete access snapshot. A role-bearing user who can no longer pass the
 * membership boundary is not a safe backup for the final-admin guard.
 */
export async function loadEffectiveAdministratorUserIds(
  database: RoleStateDatabase,
  options: EffectiveAdministratorQueryOptions = {},
): Promise<readonly string[]> {
  const loadedAccessState =
    options.accessState ??
    (await loadAccessConfigurationSnapshotState(database));
  if (loadedAccessState === null) return Object.freeze([]);
  const accessState = validateAccessState(loadedAccessState);
  if (accessState === null) return Object.freeze([]);

  const eligibleIds =
    options.eligibleAccessGroupSourceIds === undefined
      ? accessState.activeAccessGroupSourceIds
      : [...options.eligibleAccessGroupSourceIds].sort();
  if (
    eligibleIds.length === 0 ||
    new Set(eligibleIds).size !== eligibleIds.length ||
    eligibleIds.some(
      (id) =>
        !UuidSchema.safeParse(id).success ||
        !accessState.activeAccessGroupSourceIds.includes(id),
    )
  ) {
    return Object.freeze([]);
  }

  const baseAdmins = database
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.role, 'admin'))
    .as('base_admin_grants');
  const latestAdminChanges = database
    .selectDistinctOn([userRoleChanges.userId], {
      userId: userRoleChanges.userId,
      granted: userRoleChanges.granted,
    })
    .from(userRoleChanges)
    .where(eq(userRoleChanges.role, 'admin'))
    .orderBy(asc(userRoleChanges.userId), desc(userRoleChanges.sequence))
    .as('latest_admin_changes');
  const effectiveAdmins = database
    .select({
      userId:
        sql<string>`coalesce(${latestAdminChanges.userId}, ${baseAdmins.userId})`.as(
          'effective_admin_user_id',
        ),
      granted: sql<boolean>`coalesce(${latestAdminChanges.granted}, true)`.as(
        'effective_admin_granted',
      ),
    })
    .from(baseAdmins)
    .fullJoin(
      latestAdminChanges,
      eq(latestAdminChanges.userId, baseAdmins.userId),
    )
    .as('effective_admin_roles');
  const rows = await database
    .selectDistinctOn([effectiveAdmins.userId], {
      userId: effectiveAdmins.userId,
    })
    .from(effectiveAdmins)
    .innerJoin(users, eq(users.id, effectiveAdmins.userId))
    .innerJoin(
      accessMembershipMembers,
      and(
        eq(accessMembershipMembers.snapshotId, accessState.snapshotId),
        eq(accessMembershipMembers.userId, effectiveAdmins.userId),
        eq(accessMembershipMembers.googleSubject, users.googleSubject),
        eq(accessMembershipMembers.facilityScopeKind, 'district'),
      ),
    )
    .innerJoin(
      accessMembershipMemberGroups,
      and(
        eq(accessMembershipMemberGroups.snapshotId, accessState.snapshotId),
        eq(accessMembershipMemberGroups.userId, effectiveAdmins.userId),
      ),
    )
    .innerJoin(
      groupSources,
      and(
        eq(groupSources.id, accessMembershipMemberGroups.groupSourceId),
        eq(groupSources.kind, accessMembershipMemberGroups.groupSourceKind),
        eq(groupSources.purpose, accessMembershipMemberGroups.groupPurpose),
      ),
    )
    .where(
      and(
        eq(effectiveAdmins.granted, true),
        eq(users.facilityScopeKind, 'district'),
        isNull(users.disabledAt),
        notExists(
          database
            .select({ userId: userFacilityScopes.userId })
            .from(userFacilityScopes)
            .where(eq(userFacilityScopes.userId, effectiveAdmins.userId)),
        ),
        notExists(
          database
            .select({ userId: accessMembershipMemberFacilities.userId })
            .from(accessMembershipMemberFacilities)
            .where(
              and(
                eq(
                  accessMembershipMemberFacilities.snapshotId,
                  accessState.snapshotId,
                ),
                eq(
                  accessMembershipMemberFacilities.userId,
                  effectiveAdmins.userId,
                ),
              ),
            ),
        ),
        notExists(
          database
            .select({ userId: accessMembershipMemberGroups.userId })
            .from(accessMembershipMemberGroups)
            .where(
              and(
                eq(
                  accessMembershipMemberGroups.snapshotId,
                  accessState.snapshotId,
                ),
                eq(accessMembershipMemberGroups.userId, effectiveAdmins.userId),
                notExists(
                  database
                    .select({ id: groupSources.id })
                    .from(groupSources)
                    .where(
                      and(
                        eq(
                          groupSources.id,
                          accessMembershipMemberGroups.groupSourceId,
                        ),
                        eq(
                          groupSources.kind,
                          accessMembershipMemberGroups.groupSourceKind,
                        ),
                        eq(
                          groupSources.purpose,
                          accessMembershipMemberGroups.groupPurpose,
                        ),
                        eq(groupSources.active, true),
                        eq(groupSources.kind, 'google-group'),
                        eq(groupSources.purpose, 'access'),
                        inArray(groupSources.id, [...eligibleIds]),
                      ),
                    ),
                ),
              ),
            ),
        ),
        eq(groupSources.active, true),
        eq(groupSources.kind, 'google-group'),
        eq(groupSources.purpose, 'access'),
        inArray(groupSources.id, eligibleIds),
      ),
    )
    .orderBy(asc(effectiveAdmins.userId));
  return Object.freeze(rows.map(({ userId }) => userId));
}
