import { and, eq, inArray, isNull } from 'drizzle-orm';

import { groupSources } from '../../../db/schema';
import {
  AccessMembershipEvaluationError,
  type GoogleGroupResolver,
} from '../../../lib/auth/google-access-membership';
import { GoogleRosterConfigurationError } from '../../../lib/auth/google-roster-config';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { getDefaultAdminDatabase } from '../../../lib/capabilities/admin';
import { AdminFormError } from './admin-request';
import { defaultGoogleGroupResolver } from './google-group-id';

type AdminDatabase = ReturnType<typeof getDefaultAdminDatabase>;

export interface WaitingGroupsCheck {
  /** Addresses Google holds now; the next scheduled sync connects them. */
  readonly held: readonly string[];
  /** Addresses Google still does not hold. */
  readonly stillWaiting: readonly string[];
}

/**
 * Asks Google, now, whether it holds each waiting roster group. This reads
 * only: connecting a group (recording its ID and reading its members) is
 * the scheduled roster sync's work, under the scheduler's own capability
 * policy, and it happens at the next run for every group Google holds. The
 * answer tells an administrator whether that run has something to connect.
 */
export async function checkWaitingGroups(input: {
  readonly authenticated: AuthenticatedSession;
  readonly database?: AdminDatabase;
  readonly resolver?: () => GoogleGroupResolver;
}): Promise<WaitingGroupsCheck> {
  if (!input.authenticated.roles.includes('admin')) {
    throw new AdminFormError('Access is denied.');
  }
  const database = input.database ?? getDefaultAdminDatabase();
  const waiting = await database
    .select({ email: groupSources.email })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.kind, 'google-group'),
        inArray(groupSources.purpose, ['building', 'others']),
        eq(groupSources.active, true),
        isNull(groupSources.googleGroupId),
      ),
    )
    .orderBy(groupSources.email);
  const addresses = waiting.flatMap(({ email }) =>
    email === null ? [] : [email.trim().toLowerCase()],
  );
  if (addresses.length === 0) {
    return Object.freeze({ held: [], stillWaiting: [] });
  }
  let client: GoogleGroupResolver;
  try {
    client = (input.resolver ?? defaultGoogleGroupResolver)();
  } catch (error) {
    if (error instanceof GoogleRosterConfigurationError) {
      throw new AdminFormError(
        "This server's Google Groups credential is missing or invalid, so a Google Group cannot be looked up. Nothing was changed.",
      );
    }
    throw error;
  }
  const held: string[] = [];
  const stillWaiting: string[] = [];
  for (const address of addresses) {
    try {
      const resolved = await client.resolveIfHeld(address);
      (resolved === null ? stillWaiting : held).push(address);
    } catch (error) {
      if (error instanceof AccessMembershipEvaluationError) {
        throw new AdminFormError(
          `Google refused the lookup of ${address} (${error.code}). Nothing was changed; check the roster-reader credential and try again.`,
        );
      }
      throw error;
    }
  }
  return Object.freeze({ held, stillWaiting });
}
