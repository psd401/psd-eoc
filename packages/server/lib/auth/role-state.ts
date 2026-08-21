import { RoleSchema, type Role } from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  groupMembers,
  groupSources,
  userRoleChanges,
  userRoles,
  users,
} from '../../db/schema';

/** Minimal common query surface shared by PostgreSQL and Aurora Data API. */
export type RoleStateDatabase = Pick<Database, 'select' | 'selectDistinctOn'>;

/** Serializes every mutation that can change effective administrator reachability. */
export const ADMIN_AVAILABILITY_LOCK_SQL = sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-admin-availability', 0))`;

/** Optional prospective filter for the effective-administrator projection. */
export interface EffectiveAdministratorQueryOptions {
  /**
   * Existing active IDs that will remain eligible after a proposed mutation.
   * New, inactive, or otherwise ineligible IDs yield no reachable
   * administrators, so a caller can ask what would remain before committing.
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

/**
 * Loads the latest complete access snapshot only when its expected and
 * completed source sets are both strict, duplicate-free, and exactly equal to
 * the current nonempty active Google access-source set.
 */
/**
 * Loads district administrators who remain eligible through the newest
 * complete access snapshot. A role-bearing user who can no longer pass the
 * membership boundary is not a safe backup for the final-admin guard.
 */
/**
 * Administrators who can still reach the system.
 *
 * Under the trusted-group model an administrator is simply a person in an
 * active access group that grants `admin`: roles come from groups, and there is
 * no stored grant to consult. This is what the final-administrator guards ask
 * before letting a group be deactivated.
 *
 * It used to project stored role grants through the access-membership
 * generation, which stopped working the moment the sync began writing
 * `access_group_members` instead of snapshot member rows — the projection kept
 * answering from tables nothing populates any more, so every guard saw zero
 * reachable administrators.
 *
 * `eligibleAccessGroupSourceIds` asks the same question about a proposed
 * configuration: given only these groups remaining active, would an
 * administrator still reach the system.
 */
export async function loadEffectiveAdministratorUserIds(
  database: RoleStateDatabase,
  options: EffectiveAdministratorQueryOptions = {},
): Promise<readonly string[]> {
  const activeAdminGroups = await database
    .select({ id: groupSources.id })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.purpose, 'access'),
        eq(groupSources.active, true),
        eq(groupSources.grantedRole, 'admin'),
      ),
    );
  const eligible =
    options.eligibleAccessGroupSourceIds === undefined
      ? activeAdminGroups.map(({ id }) => id)
      : activeAdminGroups
          .map(({ id }) => id)
          .filter((id) => options.eligibleAccessGroupSourceIds?.includes(id));
  if (eligible.length === 0) return Object.freeze([]);

  const rows = await database
    .selectDistinctOn([users.id], { userId: users.id })
    .from(groupMembers)
    .innerJoin(users, eq(users.email, groupMembers.email))
    .where(
      and(
        inArray(groupMembers.groupSourceId, eligible),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(users.id));
  return Object.freeze(rows.map(({ userId }) => userId));
}
