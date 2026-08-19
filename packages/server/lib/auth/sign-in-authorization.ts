import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { UserSchema, type User } from '@psd-eoc/contracts';

import type { Database } from '../../db/client';
import { users } from '../../db/schema';
import { decideAccess, type AccessRefusal } from './trusted-group-access';

export type SignInAuthorization =
  | Readonly<{
      authorized: true;
      user: User;
      /** The trusted groups that granted this sign-in. */
      groupSourceIds: readonly string[];
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
 */
export async function authorizeSignIn(
  database: Database,
  input: Readonly<{
    googleSubject: string;
    email: string;
    displayName: string;
    checkedAt: Date;
  }>,
): Promise<SignInAuthorization> {
  const email = input.email.toLowerCase();
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
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.googleSubject, input.googleSubject))
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
        facilityScope: { kind: 'district' },
        createdAt: input.checkedAt.toISOString(),
        disabledAt: null,
      }),
      groupSourceIds: decision.groupSourceIds,
      created: existing === undefined,
    });
  });
}
