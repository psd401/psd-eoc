import {
  CreateGroupSourceInputSchema,
  IdempotencyKeySchema,
  type Facility,
} from '@psd-eoc/contracts';
import { createHash } from 'node:crypto';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { AdminFormError } from './admin-request';
import {
  conventionBuildingGroupAddress,
  executeCreateGroupSourceCapability,
} from './capabilities';
import { resolveGoogleGroupIdOrWaitingForForm } from './google-group-id';

export const CONVENTION_ACTION_LABEL =
  'Register building groups by naming convention';

/** The two steps each school takes; injected so the loop is testable. */
export type ConventionRegistrationSteps = Readonly<{
  /** Asks Google for the group at the address; null when it is not held. */
  resolve: (
    authenticated: AuthenticatedSession,
    email: string,
  ) => Promise<string | null>;
  /** Registers the building source through the capability engine. */
  create: (
    input: Parameters<typeof executeCreateGroupSourceCapability>[0],
  ) => Promise<unknown>;
}>;

const defaultSteps: ConventionRegistrationSteps = Object.freeze({
  resolve: resolveGoogleGroupIdOrWaitingForForm,
  create: executeCreateGroupSourceCapability,
});

/**
 * Registers the naming-convention Google building group for each school:
 * a quick check with Google, and a waiting source when Google does not hold
 * the group yet. One capability call per school under a key derived from the
 * form's, so a replayed form registers nothing twice.
 *
 * Each school is its own committed capability call. When a later school's
 * lookup fails, the earlier ones are registered and stay registered, and the
 * error says so: a bare provider error would read as if nothing had
 * happened. Pressing the action again continues with the schools still
 * without a source, because they are listed from what the database holds.
 */
export async function registerConventionBuildingGroups(
  input: {
    readonly authenticated: AuthenticatedSession;
    readonly facilities: readonly Facility[];
    readonly idempotencyKey: string;
  },
  steps: ConventionRegistrationSteps = defaultSteps,
): Promise<void> {
  let registered = 0;
  for (const facility of input.facilities) {
    const email = conventionBuildingGroupAddress(facility.code);
    let googleGroupId: string | null;
    try {
      googleGroupId = await steps.resolve(input.authenticated, email);
    } catch (error) {
      if (error instanceof AdminFormError && registered > 0) {
        throw new AdminFormError(
          `${registered} ${registered === 1 ? 'school was' : 'schools were'} registered before this stopped at ${facility.code}: ${error.message} Press "${CONVENTION_ACTION_LABEL}" again to continue with the schools still without a source.`,
        );
      }
      throw error;
    }
    await steps.create({
      authenticated: input.authenticated,
      command: CreateGroupSourceInputSchema.parse({
        kind: 'google-group',
        purpose: 'building',
        facilityId: facility.id,
        displayName: `${facility.name} staff`,
        active: true,
        googleGroupId,
        email,
      }),
      metadata: {
        idempotencyKey: IdempotencyKeySchema.parse(
          `${createHash('sha256')
            .update(`${input.idempotencyKey}:${facility.id}`)
            .digest('hex')
            .slice(0, 40)}:convention-building-group`,
        ),
      },
    });
    registered += 1;
  }
}
