import { randomUUID } from 'node:crypto';

import {
  isPartnerIssuer,
  UserSchema,
  type PartnerAdmission,
  type User,
} from '@psd-eoc/contracts';
import { and, eq } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { userFacilityScopes, users } from '../../db/schema';
import {
  DeploymentConfigurationError,
  staffHostedDomain,
} from '../config/deployment';
import {
  decidePartnerAccess,
  type PartnerAccessRefusal,
} from './partner-admission';

/**
 * Partner sign-in authorization: the partner counterpart of
 * `authorizeSignIn`.
 *
 * A partner is admitted by an administrator's admission and by nothing else.
 * No Google group can admit one, no group can place one, and there is no
 * bootstrap or self-registration path: an address with no active admission is
 * refused however valid its identity token was. A partner holds the `partner`
 * role and nothing else, every time they sign in, so the role cannot be
 * inherited from a stale stored grant.
 */

export type PartnerSignInRefusal =
  | PartnerAccessRefusal
  | 'STAFF_ADDRESS'
  | 'ACCOUNT_DISABLED'
  | 'IDENTITY_MISMATCH';

export type PartnerSignInAuthorization =
  | Readonly<{
      authorized: true;
      user: User;
      admission: PartnerAdmission;
    }>
  | Readonly<{ authorized: false; refusal: PartnerSignInRefusal }>;

export interface AuthorizePartnerSignInInput {
  /** The partner pool that asserted this identity. */
  readonly issuer: string;
  /** The pool's own stable subject for this person. */
  readonly subject: string;
  readonly email: string;
  readonly checkedAt: Date;
}

export interface AuthorizePartnerSignInDependencies {
  /**
   * The district's staff email domain, or null when the deployment does not
   * name one. Injected so a test can state it without a configured process.
   */
  readonly staffDomain?: string | null;
}

function readStaffDomain(): string | null {
  try {
    return staffHostedDomain();
  } catch (error) {
    if (error instanceof DeploymentConfigurationError) {
      return null;
    }
    throw error;
  }
}

/**
 * Authorizes one partner sign-in and resolves the account behind it.
 *
 * A district address is refused before anything else: staff sign in as staff,
 * and an address is one kind of person only — the same rule the invite path
 * enforces, restated here so a pool account created outside the app cannot
 * use it to become a second account for a staff address.
 */
export async function authorizePartnerSignIn(
  database: Database,
  input: AuthorizePartnerSignInInput,
  dependencies: AuthorizePartnerSignInDependencies = {},
): Promise<PartnerSignInAuthorization> {
  const email = input.email.trim().toLowerCase();
  if (!isPartnerIssuer(input.issuer)) {
    // Only a partner pool reaches this authorization. A Google identity that
    // arrives here is a routing mistake, not a sign-in.
    return Object.freeze({ authorized: false, refusal: 'STAFF_ADDRESS' });
  }
  const staffDomain =
    dependencies.staffDomain === undefined
      ? readStaffDomain()
      : dependencies.staffDomain;
  if (staffDomain !== null && email.endsWith(`@${staffDomain.toLowerCase()}`)) {
    return Object.freeze({ authorized: false, refusal: 'STAFF_ADDRESS' });
  }

  const access = await decidePartnerAccess(database, {
    email,
    checkedAt: input.checkedAt,
  });
  if (!access.granted) {
    return Object.freeze({ authorized: false, refusal: access.refusal });
  }
  const admission = access.admission;

  return database.transaction(async (transaction) => {
    const [byIdentity] = await transaction
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        facilityScopeKind: users.facilityScopeKind,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(
        and(
          eq(users.identityIssuer, input.issuer),
          eq(users.identitySubject, input.subject),
        ),
      )
      .limit(1);

    interface PartnerAccountRow {
      readonly id: string;
      readonly email: string;
      readonly displayName: string;
      readonly facilityScopeKind: 'district' | 'facilities';
      readonly disabledAt: Date | null;
    }
    let account: PartnerAccountRow | undefined = byIdentity;
    let created = false;
    if (account === undefined) {
      // An address is one person. If this address already has an account
      // under another identity, the pool subject behind this sign-in is not
      // the one that account was built for, and signing in would either
      // collide with the unique address or quietly rebind a stored identity.
      // Both are refused; an administrator re-invites instead.
      const [byEmail] = await transaction
        .select({ identityIssuer: users.identityIssuer })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (byEmail !== undefined) {
        return Object.freeze({
          authorized: false as const,
          refusal: isPartnerIssuer(byEmail.identityIssuer)
            ? ('IDENTITY_MISMATCH' as const)
            : ('STAFF_ADDRESS' as const),
        });
      }
      const [inserted] = await transaction
        .insert(users)
        .values({
          id: randomUUID(),
          // A partner has no Google subject. Their identity is the pool's
          // issuer and subject together.
          googleSubject: null,
          identityIssuer: input.issuer,
          identitySubject: input.subject,
          email,
          displayName: admission.displayName,
          facilityScopeKind: 'district',
          createdAt: input.checkedAt,
          disabledAt: null,
        })
        .returning();
      account = inserted;
      created = true;
    }
    if (account === undefined) {
      throw new Error('The signing-in partner could not be resolved.');
    }
    if (account.disabledAt !== null) {
      // A disabled account is refused even while the admission is active, so
      // an administrator can stop one person without ending the admission
      // record that documents their access.
      return Object.freeze({
        authorized: false as const,
        refusal: 'ACCOUNT_DISABLED' as const,
      });
    }
    // The name an administrator entered on the admission is the one the app
    // shows. A re-invite that corrects a name takes effect at the partner's
    // next sign-in rather than leaving the first spelling forever.
    let displayName = account.displayName;
    if (!created && displayName !== admission.displayName) {
      await transaction
        .update(users)
        .set({ displayName: admission.displayName })
        .where(eq(users.id, account.id));
      displayName = admission.displayName;
    }

    // Where a partner acts is the limit an administrator set on them, as
    // stored: no group places a partner, so there is nothing to rewrite here.
    // Session issuance reads the same rows back and refuses a mismatch.
    const facilityScope =
      account.facilityScopeKind === 'district'
        ? ({ kind: 'district' } as const)
        : ({
            kind: 'facilities' as const,
            facilityIds: (
              await transaction
                .select({ facilityId: userFacilityScopes.facilityId })
                .from(userFacilityScopes)
                .where(eq(userFacilityScopes.userId, account.id))
            )
              .map(({ facilityId }) => facilityId)
              .sort(),
          } as const);

    return Object.freeze({
      authorized: true as const,
      user: UserSchema.parse({
        id: account.id,
        googleSubject: null,
        email,
        displayName,
        roles: ['partner'],
        facilityScope,
        createdAt: input.checkedAt.toISOString(),
        disabledAt: null,
      }),
      admission,
    });
  });
}
