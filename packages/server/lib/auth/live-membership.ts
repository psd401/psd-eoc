import { and, eq, isNotNull } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { groupMembers, groupSources } from '../../db/schema';
import {
  createGoogleMembershipChecker,
  type GoogleGroupReference,
  type GoogleMembershipChecker,
} from './google-access-membership';
import { readGoogleCloudIdentityRosterConfiguration } from './google-roster-config';

/**
 * What a live read did. `unavailable` covers every way Google could not be
 * asked (no credential, a provider failure, a timeout); the stored membership
 * then stands, bounded by its own freshness, exactly as before this existed.
 */
export type LiveMembershipOutcome = 'reconciled' | 'unavailable' | 'no-groups';

export interface LiveMembershipReconciler {
  reconcile(
    database: Database,
    input: Readonly<{ email: string; checkedAt: Date }>,
  ): Promise<LiveMembershipOutcome>;
}

/**
 * Brings one person's stored membership in every active sign-in group up to
 * what Google says right now, so the access decision that follows reads the
 * present rather than the last scheduled sync.
 *
 * A membership Google confirms is written with this instant as its capture
 * time; one Google denies is removed. Nothing else in the table is touched:
 * the scheduled sync still owns everyone else's rows and the group-level
 * capture stamp. A failure to ask Google changes nothing and is not an error
 * here, because refusing sign-in whenever Google hiccups would be a worse
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
            googleGroupId: groupSources.googleGroupId,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.purpose, 'access'),
              eq(groupSources.active, true),
              eq(groupSources.kind, 'google-group'),
              isNotNull(groupSources.googleGroupId),
            ),
          )
      ).flatMap(({ groupSourceId, googleGroupId }) =>
        googleGroupId === null ? [] : [{ groupSourceId, googleGroupId }],
      );
      if (groups.length === 0) return 'no-groups';

      let answers: ReadonlyMap<string, boolean>;
      try {
        answers = await checker().check(email, groups);
      } catch {
        return 'unavailable';
      }

      await database.transaction(async (transaction) => {
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
            await transaction
              .delete(groupMembers)
              .where(
                and(
                  eq(groupMembers.groupSourceId, group.groupSourceId),
                  eq(groupMembers.email, email),
                ),
              );
          }
        }
      });
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
