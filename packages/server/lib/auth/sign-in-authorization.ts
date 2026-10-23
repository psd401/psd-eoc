import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import {
  GOOGLE_IDENTITY_ISSUER,
  UserSchema,
  type User,
} from '@psd-eoc/contracts';

import type { Database } from '../../db/client';
import { userFacilityScopes, users } from '../../db/schema';
import {
  defaultLiveMembershipReconciler,
  type LiveMembershipReconciler,
} from './live-membership';
import { ADMIN_AVAILABILITY_LOCK_SQL } from './role-state';
import { decideAccess, type AccessRefusal } from './trusted-group-access';

export type SignInAuthorization =
  | Readonly<{
      authorized: true;
      user: User;
      /** The trusted groups that granted this sign-in. */
      groupSourceIds: readonly string[];
      /** The direct admission that granted it, when no group did or as well. */
      admittedAccountId: string | null;
      created: boolean;
    }>
  | Readonly<{
      authorized: false;
      refusal: AccessRefusal | 'ACCOUNT_DISABLED';
    }>;

/**
 * Authorizes one sign-in and resolves the account behind it.
 *
 * Roles come from the groups the person is in, every time they sign in. That
 * is the whole reason groups carry a role: an administrator changes who
 * administers by changing group membership, not by finding a way to write a
 * role row, and there is no longer any such way to find. The stored roles are
 * reconciled to what the groups grant on each sign-in, so removing someone
 * from an administrator group removes their administrator role the next time
 * they arrive rather than leaving it behind indefinitely.
 *
 * A first-time signer is created here. Their roles are whatever their groups
 * grant — there is no bootstrap admin, no approved subject, and no synthetic
 * fixture to seed one.
 *
 * Before the decision, this person's membership in every active sign-in
 * group is read from Google and written down, so being added to a group
 * means signing in now, not after the next scheduled sync. When Google
 * cannot be asked the stored membership decides, bounded by its freshness.
 */
export async function authorizeSignIn(
  database: Database,
  input: Readonly<{
    googleSubject: string;
    email: string;
    displayName: string;
    checkedAt: Date;
  }>,
  dependencies: Readonly<{ liveMembership?: LiveMembershipReconciler }> = {},
): Promise<SignInAuthorization> {
  const email = input.email.toLowerCase();
  await (
    dependencies.liveMembership ?? defaultLiveMembershipReconciler()
  ).reconcile(database, { email, checkedAt: input.checkedAt });
  const decision = await decideAccess(database, {
    email,
    checkedAt: input.checkedAt,
  });
  if (!decision.granted) {
    return Object.freeze({ authorized: false, refusal: decision.refusal });
  }

  return database.transaction(async (transaction) => {
    const [existing] = await transaction
      .select({
        id: users.id,
        googleSubject: users.googleSubject,
        email: users.email,
        displayName: users.displayName,
        facilityScopeKind: users.facilityScopeKind,
        disabledAt: users.disabledAt,
      })
      .from(users)
      // A person is their issuer and subject together. This path only ever
      // completes a Google sign-in, so the issuer is Google's.
      .where(
        and(
          eq(users.identityIssuer, GOOGLE_IDENTITY_ISSUER),
          eq(users.identitySubject, input.googleSubject),
        ),
      )
      .limit(1);

    if (existing !== undefined && existing.disabledAt !== null) {
      // A disabled account is refused even while its groups would grant
      // access, so an administrator can revoke one person without waiting for
      // a provider change they may not control.
      return Object.freeze({
        authorized: false,
        refusal: 'ACCOUNT_DISABLED' as const,
      });
    }

    const user =
      existing ??
      (
        await transaction
          .insert(users)
          .values({
            id: randomUUID(),
            googleSubject: input.googleSubject,
            identityIssuer: GOOGLE_IDENTITY_ISSUER,
            identitySubject: input.googleSubject,
            email,
            displayName: input.displayName,
            facilityScopeKind: 'district',
            createdAt: input.checkedAt,
            disabledAt: null,
          })
          .returning()
      )[0];
    if (user === undefined) {
      throw new Error('The signing-in account could not be resolved.');
    }

    // Where someone acts is what their groups say today, rewritten at every
    // sign-in: a district group grants the district, school groups grant
    // their schools, and moving between groups moves the person. Only an
    // account a direct admission lets in, with no sign-in group, keeps the
    // limit an administrator set on the Access page.
    let facilityScopeKind = user.facilityScopeKind;
    const granted = decision.facilityScope;
    if (granted !== null) {
      // The order every writer of a person's facility limit takes: the
      // administrator-availability lock first, then the rows.
      await transaction.execute(ADMIN_AVAILABILITY_LOCK_SQL);
      await transaction
        .delete(userFacilityScopes)
        .where(eq(userFacilityScopes.userId, user.id));
      if (granted.kind === 'facilities') {
        await transaction.insert(userFacilityScopes).values(
          granted.facilityIds.map((facilityId) => ({
            userId: user.id,
            facilityId,
          })),
        );
      }
      if (facilityScopeKind !== granted.kind) {
        await transaction
          .update(users)
          .set({ facilityScopeKind: granted.kind })
          .where(eq(users.id, user.id));
        facilityScopeKind = granted.kind;
      }
    }

    // The account's own facility limit, as stored. Session issuance reads the
    // same rows back and refuses a mismatch, so claiming district-wide here
    // locked every facility-limited account out of every sign-in path.
    const facilityScope =
      facilityScopeKind === 'district'
        ? ({ kind: 'district' } as const)
        : ({
            kind: 'facilities' as const,
            facilityIds: (
              await transaction
                .select({ facilityId: userFacilityScopes.facilityId })
                .from(userFacilityScopes)
                .where(eq(userFacilityScopes.userId, user.id))
            )
              .map(({ facilityId }) => facilityId)
              .sort(),
          } as const);

    // Roles are not stored. They are what the viewer's groups grant, decided
    // fresh at every sign-in, so removing someone from an administrator group
    // removes their authority the next time they arrive rather than leaving a
    // stale grant behind. The legacy user_roles table is append-only by
    // database rule precisely because a stored role could never be taken back
    // cleanly; deriving instead of storing removes the problem rather than
    // working around it.
    return Object.freeze({
      authorized: true as const,
      // The full domain user, so session issuance receives exactly the shape
      // it persists rather than a narrowed projection.
      user: UserSchema.parse({
        id: user.id,
        googleSubject: user.googleSubject,
        email: user.email,
        displayName: user.displayName,
        roles: decision.roles,
        facilityScope,
        createdAt: input.checkedAt.toISOString(),
        disabledAt: null,
      }),
      groupSourceIds: decision.groupSourceIds,
      admittedAccountId: decision.admittedAccountId,
      created: existing === undefined,
    });
  });
}
