import { and, asc, eq, isNotNull } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { groupMembers, groupSources } from '../../db/schema';
import {
  createGoogleMembershipChecker,
  type GoogleGroupReference,
  type GoogleMembershipChecker,
} from './google-access-membership';
import { readGoogleCloudIdentityRosterConfiguration } from './google-roster-config';
import { ADMIN_AVAILABILITY_LOCK_SQL } from './role-state';

/**
 * What a live read did. `unavailable` covers every way the present could not
 * be established or recorded: no credential, a provider failure, a group
 * that no longer resolves to its recorded ID, a removal that would leave no
 * reachable administrator, or a database failure. The stored membership then
 * stands, bounded by its own freshness, exactly as before this existed.
 */
export type LiveMembershipOutcome = 'reconciled' | 'unavailable' | 'no-groups';

export interface LiveMembershipReconciler {
  reconcile(
    database: Database,
    input: Readonly<{ email: string; checkedAt: Date }>,
  ): Promise<LiveMembershipOutcome>;
}

class LastAdministratorError extends Error {
  public constructor() {
    super('Removing this membership would leave no reachable administrator.');
    this.name = 'LastAdministratorError';
  }
}

/**
 * Brings one person's stored membership in every active sign-in group up to
 * what Google says right now, so the access decision that follows reads the
 * present rather than the last scheduled sync.
 *
 * A membership Google confirms is written with this instant as its capture
 * time; one Google denies is removed. Nothing else in the table is touched:
 * the scheduled sync still owns everyone else's rows and the group-level
 * capture stamp. The write takes the same lock every mutation of
 * administrator reachability takes, and honours the same rule: it never
 * removes the last reachable administrator. A failure to ask Google, or to
 * record the answer, changes nothing and is not an error here, because
 * refusing sign-in whenever Google or the database hiccups would be a worse
 * outage than a bounded delay.
 */
export function createLiveMembershipReconciler(
  checker: () => GoogleMembershipChecker,
): LiveMembershipReconciler {
  return Object.freeze({
    async reconcile(
      database: Database,
      input: Readonly<{ email: string; checkedAt: Date }>,
    ): Promise<LiveMembershipOutcome> {
      const email = input.email.trim().toLowerCase();
      const groups: GoogleGroupReference[] = (
        await database
          .select({
            groupSourceId: groupSources.id,
            email: groupSources.email,
            googleGroupId: groupSources.googleGroupId,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.purpose, 'access'),
              eq(groupSources.active, true),
              eq(groupSources.kind, 'google-group'),
              isNotNull(groupSources.googleGroupId),
              isNotNull(groupSources.email),
            ),
          )
          // The order the scheduled sync writes in, so the two never take
          // the same rows in opposite orders.
          .orderBy(asc(groupSources.id))
      ).flatMap(({ groupSourceId, email: groupEmail, googleGroupId }) =>
        googleGroupId === null || groupEmail === null
          ? []
          : [{ groupSourceId, email: groupEmail, googleGroupId }],
      );
      if (groups.length === 0) return 'no-groups';

      let answers: ReadonlyMap<string, boolean>;
      try {
        answers = await checker().check(email, groups);
      } catch {
        return 'unavailable';
      }

      try {
        await database.transaction(async (transaction) => {
          await transaction.execute(ADMIN_AVAILABILITY_LOCK_SQL);
          let removed = false;
          for (const group of groups) {
            if (answers.get(group.groupSourceId) === true) {
              await transaction
                .insert(groupMembers)
                .values({
                  groupSourceId: group.groupSourceId,
                  email,
                  capturedAt: input.checkedAt,
                })
                .onConflictDoUpdate({
                  target: [groupMembers.groupSourceId, groupMembers.email],
                  set: { capturedAt: input.checkedAt },
                });
            } else {
              const gone = await transaction
                .delete(groupMembers)
                .where(
                  and(
                    eq(groupMembers.groupSourceId, group.groupSourceId),
                    eq(groupMembers.email, email),
                  ),
                )
                .returning();
              removed ||= gone.length > 0;
            }
          }
          // The guard the scheduled sync applies to every publication. A
          // removal is honoured immediately, except the one that would leave
          // nobody able to administer the deployment: that one is refused
          // and the stored membership stands until the sync, which resolves
          // the group afresh, says the same.
          if (removed) {
            const administrators = await transaction
              .select({ email: groupMembers.email })
              .from(groupMembers)
              .innerJoin(
                groupSources,
                eq(groupSources.id, groupMembers.groupSourceId),
              )
              .where(
                and(
                  eq(groupSources.purpose, 'access'),
                  eq(groupSources.active, true),
                  eq(groupSources.grantedRole, 'admin'),
                ),
              )
              .limit(1);
            if (administrators.length === 0) {
              throw new LastAdministratorError();
            }
          }
        });
      } catch {
        return 'unavailable';
      }
      return 'reconciled';
    },
  });
}

/** The reconciler the sign-in paths use: Google, with the server's credential. */
export function defaultLiveMembershipReconciler(): LiveMembershipReconciler {
  return createLiveMembershipReconciler(() =>
    createGoogleMembershipChecker(readGoogleCloudIdentityRosterConfiguration()),
  );
}
