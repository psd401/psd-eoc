import { RoleSchema, type Role } from '@psd-eoc/contracts';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { userRoleChanges, userRoles, users } from '../../db/schema';

/** Minimal common query surface shared by PostgreSQL and Aurora Data API. */
export type RoleStateDatabase = Pick<Database, 'select' | 'selectDistinctOn'>;

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

/** Loads active district administrators from the same canonical role fold. */
export async function loadEffectiveAdministratorUserIds(
  database: RoleStateDatabase,
): Promise<readonly string[]> {
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
          'user_id',
        ),
      granted: sql<boolean>`coalesce(${latestAdminChanges.granted}, true)`.as(
        'granted',
      ),
    })
    .from(baseAdmins)
    .fullJoin(
      latestAdminChanges,
      eq(latestAdminChanges.userId, baseAdmins.userId),
    )
    .as('effective_admin_roles');

  const rows = await database
    .select({ userId: effectiveAdmins.userId })
    .from(effectiveAdmins)
    .innerJoin(users, eq(users.id, effectiveAdmins.userId))
    .where(
      and(
        eq(effectiveAdmins.granted, true),
        eq(users.facilityScopeKind, 'district'),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(effectiveAdmins.userId));
  return Object.freeze(rows.map(({ userId }) => userId));
}
