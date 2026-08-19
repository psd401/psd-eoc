import { and, eq, inArray } from 'drizzle-orm';

import { RoleSchema, type Role } from '@psd-eoc/contracts';

import type { Database } from '../../db/client';
import { accessGroupMembers, groupSources } from '../../db/schema';

/**
 * How stale a group's membership may be and still authorize a sign-in.
 *
 * The provider is read on a schedule, so some staleness is normal. What this
 * bounds is how long a deployment keeps honouring a membership list after the
 * reads stop — if the sync has been broken for a day, access should fail
 * closed rather than run indefinitely on the last good answer.
 */
export const MEMBERSHIP_FRESHNESS_MS = 6 * 60 * 60 * 1_000;

/** Why a sign-in was refused. Bounded, and safe to persist or log. */
export type AccessRefusal =
  | 'NO_TRUSTED_GROUPS_CONFIGURED'
  | 'NOT_IN_A_TRUSTED_GROUP'
  | 'MEMBERSHIP_STALE';

export type AccessDecision =
  | Readonly<{
      granted: true;
      roles: readonly Role[];
      groupSourceIds: readonly string[];
    }>
  | Readonly<{ granted: false; refusal: AccessRefusal }>;

/**
 * Decides whether one person may sign in, and with what roles.
 *
 * The whole rule: they are in at least one active access group whose
 * membership was read recently enough, and they receive the roles those groups
 * grant. Membership in one trusted group is sufficient — requiring membership
 * in every configured group is what made a second group impossible to add.
 *
 * There is deliberately no snapshot, version, generation, or baseline here.
 * Sign-in asks a question about the present, and a stale answer is refused by
 * its timestamp rather than by a global agreement protocol that every group
 * had to satisfy at once.
 */
export async function decideAccess(
  database: Database,
  input: Readonly<{ email: string; checkedAt: Date }>,
): Promise<AccessDecision> {
  const active = await database
    .select({
      id: groupSources.id,
      grantedRole: groupSources.grantedRole,
      membersCapturedAt: groupSources.membersCapturedAt,
    })
    .from(groupSources)
    .where(
      and(eq(groupSources.purpose, 'access'), eq(groupSources.active, true)),
    );
  if (active.length === 0) {
    return Object.freeze({
      granted: false,
      refusal: 'NO_TRUSTED_GROUPS_CONFIGURED' as const,
    });
  }

  const memberships = await database
    .select({ groupSourceId: accessGroupMembers.groupSourceId })
    .from(accessGroupMembers)
    .where(
      and(
        eq(accessGroupMembers.email, input.email.toLowerCase()),
        inArray(
          accessGroupMembers.groupSourceId,
          active.map(({ id }) => id),
        ),
      ),
    );
  if (memberships.length === 0) {
    return Object.freeze({
      granted: false,
      refusal: 'NOT_IN_A_TRUSTED_GROUP' as const,
    });
  }

  // Only the groups this person is actually in need to be fresh. A neglected
  // group they do not belong to says nothing about their access, and letting
  // it deny them is the same mistake as requiring membership in every group.
  const held = new Set(memberships.map(({ groupSourceId }) => groupSourceId));
  const usable = active.filter(
    (group) =>
      held.has(group.id) &&
      group.membersCapturedAt !== null &&
      input.checkedAt.getTime() - group.membersCapturedAt.getTime() <=
        MEMBERSHIP_FRESHNESS_MS,
  );
  if (usable.length === 0) {
    return Object.freeze({
      granted: false,
      refusal: 'MEMBERSHIP_STALE' as const,
    });
  }

  const roles = [
    ...new Set(usable.map((group) => RoleSchema.parse(group.grantedRole))),
  ].sort();
  return Object.freeze({
    granted: true,
    roles: Object.freeze(roles),
    groupSourceIds: Object.freeze(usable.map(({ id }) => id).sort()),
  });
}
