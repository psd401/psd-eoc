import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';

import { RoleSchema, type Role } from '@psd-eoc/contracts';

import type { Database } from '../../db/client';
import { admittedAccounts, groupMembers, groupSources } from '../../db/schema';

/**
 * How stale a group's membership may be and still authorize a sign-in.
 *
 * The provider is read on a schedule, so some staleness is normal. What this
 * bounds is how long a deployment keeps honouring a membership list after the
 * reads stop — if the sync has been broken for a day, access should fail
 * closed rather than run indefinitely on the last good answer.
 *
 * A day, against a sync that runs every two hours. The first value tried here
 * was six hours, which locked everyone out the same evening: the sync was
 * dispatch-only at the time, so membership was read once by hand and then aged
 * out with nothing to refresh it. A bound this much wider than the sync
 * interval means a single failed run, or several, never denies anyone — while
 * a sync that has been broken for a full day still fails closed.
 */
export const MEMBERSHIP_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

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
      /** The admission that granted this sign-in without a group, if any. */
      admittedAccountId: string | null;
      /**
       * The schools this person may act at when the only thing admitting
       * them is their school's own staff group, or null when a sign-in
       * group or an admission grants them the district. A school group
       * admits its members as staff at that school and nowhere else.
       */
      schoolFacilityIds: readonly string[] | null;
      /**
       * When the granting membership was last read from the provider — the
       * freshest capture among the groups that granted it. Callers that need
       * to say how old their evidence is report this rather than the instant
       * they asked, which is never in the future and never pretends a stale
       * read is current.
       */
      capturedAt: Date;
    }>
  | Readonly<{ granted: false; refusal: AccessRefusal }>;

/**
 * Decides whether one person may sign in, and with what roles.
 *
 * The whole rule: they are in at least one active access group whose
 * membership was read recently enough, and they receive the roles those groups
 * grant; or an administrator admitted their address directly, which grants
 * staff; or they are in a school's own connected Google staff group (a
 * building roster source), which grants staff at that school only. The
 * people a school's alerts reach are the people who must be able to sign in
 * and opt in to text alerts, so the group that names one names the other. Membership in one trusted group is sufficient — requiring membership
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
  const email = input.email.toLowerCase();

  // An admission is the one way in that is not a group: an administrator
  // wrote this address down on the Access page. It is read from this
  // database, so it is current by definition and needs no freshness bound,
  // and it grants staff only.
  const [admission] = await database
    .select({ id: admittedAccounts.id })
    .from(admittedAccounts)
    .where(
      and(
        eq(admittedAccounts.email, email),
        isNull(admittedAccounts.revokedAt),
      ),
    )
    .limit(1);
  const admittedAccountId = admission?.id ?? null;

  const active = await database
    .select({
      id: groupSources.id,
      purpose: groupSources.purpose,
      facilityId: groupSources.facilityId,
      grantedRole: groupSources.grantedRole,
      membersCapturedAt: groupSources.membersCapturedAt,
    })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.active, true),
        or(
          eq(groupSources.purpose, 'access'),
          // A school's staff group admits only once Google holds it: a
          // waiting group names nobody, and a manual list is an address
          // book for alerts, not a sign-in authority.
          and(
            eq(groupSources.purpose, 'building'),
            eq(groupSources.kind, 'google-group'),
            isNotNull(groupSources.googleGroupId),
            isNotNull(groupSources.facilityId),
          ),
        ),
      ),
    );
  if (active.length === 0 && admittedAccountId === null) {
    return Object.freeze({
      granted: false,
      refusal: 'NO_TRUSTED_GROUPS_CONFIGURED' as const,
    });
  }

  const memberships =
    active.length === 0
      ? []
      : await database
          .select({
            groupSourceId: groupMembers.groupSourceId,
            capturedAt: groupMembers.capturedAt,
          })
          .from(groupMembers)
          .where(
            and(
              eq(groupMembers.email, email),
              inArray(
                groupMembers.groupSourceId,
                active.map(({ id }) => id),
              ),
            ),
          );
  if (memberships.length === 0 && admittedAccountId === null) {
    return Object.freeze({
      granted: false,
      refusal: 'NOT_IN_A_TRUSTED_GROUP' as const,
    });
  }

  // Only the groups this person is actually in need to be fresh. A neglected
  // group they do not belong to says nothing about their access, and letting
  // it deny them is the same mistake as requiring membership in every group.
  //
  // The evidence for one person is the fresher of two reads: the scheduled
  // sync's read of the whole group, stamped on the group, and a live read of
  // this one membership at their last sign-in, stamped on the row. A person
  // confirmed by Google minutes ago is not stale because the group's bulk
  // read is a day old.
  const held = new Map(
    memberships.map(({ groupSourceId, capturedAt }) => [
      groupSourceId,
      capturedAt,
    ]),
  );
  const usable = active.flatMap((group) => {
    const rowCapturedAt = held.get(group.id);
    if (rowCapturedAt === undefined) return [];
    const capturedAt = new Date(
      Math.max(
        rowCapturedAt.getTime(),
        group.membersCapturedAt?.getTime() ?? 0,
      ),
    );
    if (
      input.checkedAt.getTime() - capturedAt.getTime() >
      MEMBERSHIP_FRESHNESS_MS
    ) {
      return [];
    }
    return [
      {
        id: group.id,
        purpose: group.purpose,
        facilityId: group.facilityId,
        grantedRole: group.grantedRole,
        capturedAt,
      },
    ];
  });
  if (usable.length === 0 && admittedAccountId === null) {
    return Object.freeze({
      granted: false,
      refusal: 'MEMBERSHIP_STALE' as const,
    });
  }

  const roles = new Set(
    usable.map((group) =>
      group.purpose === 'building'
        ? ('staff' as const)
        : RoleSchema.parse(group.grantedRole),
    ),
  );
  if (admittedAccountId !== null) roles.add('staff');
  const districtWide =
    admittedAccountId !== null ||
    usable.some((group) => group.purpose === 'access');
  const schoolFacilityIds = districtWide
    ? null
    : Object.freeze(
        [
          ...new Set(
            usable.flatMap(({ facilityId }) =>
              facilityId === null ? [] : [facilityId],
            ),
          ),
        ].sort(),
      );
  const capturedAt = new Date(
    Math.max(
      ...usable.map((group) => group.capturedAt.getTime()),
      ...(admittedAccountId === null ? [] : [input.checkedAt.getTime()]),
    ),
  );
  return Object.freeze({
    granted: true,
    roles: Object.freeze([...roles].sort()),
    groupSourceIds: Object.freeze(usable.map(({ id }) => id).sort()),
    admittedAccountId,
    schoolFacilityIds,
    capturedAt,
  });
}
