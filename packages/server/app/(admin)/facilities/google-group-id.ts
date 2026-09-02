import {
  AccessMembershipEvaluationError,
  createGoogleGroupResolver,
  type GoogleGroupResolver,
} from '../../../lib/auth/google-access-membership';
import {
  GoogleRosterConfigurationError,
  readGoogleCloudIdentityRosterConfiguration,
} from '../../../lib/auth/google-roster-config';
import { AdminFormError } from './admin-request';

/** Resolves a Google Group address to the ID the server stores for it. */
export type GoogleGroupIdResolver = (email: string) => Promise<string>;

function defaultResolver(): GoogleGroupResolver {
  return createGoogleGroupResolver(
    readGoogleCloudIdentityRosterConfiguration(),
  );
}

function explain(email: string, code: string): string {
  switch (code) {
    case 'DESIGNATED_GROUP_IDENTITY_INVALID':
      return `Google did not resolve ${email} as an exact Google Group. Check the address, and that it names a real group rather than a dynamic one.`;
    case 'GOOGLE_REQUEST_REJECTED':
      return `Google refused the lookup of ${email}. The group may not exist, or the roster-reader credential may not be allowed to read it.`;
    case 'GOOGLE_CONFIGURATION_INVALID':
      return 'The Google Groups credential on this server is invalid, so no group can be looked up.';
    default:
      return `Google was unavailable while looking up ${email}. Nothing was saved; try again.`;
  }
}

/**
 * Turns the address an administrator typed into the Google Group ID the
 * server records, or into a form error that says why it could not.
 *
 * The ID is Google's to say. It is the same identity the scheduled sync later
 * checks the stored row against, so a form that asked a person to type it
 * could register a group the sync would then refuse. Resolving it here means
 * a group that Google cannot resolve is refused before anything is saved.
 */
export async function resolveGoogleGroupIdForForm(
  email: string,
  resolver: () => GoogleGroupResolver = defaultResolver,
): Promise<string> {
  let client: GoogleGroupResolver;
  try {
    client = resolver();
  } catch (error) {
    if (error instanceof GoogleRosterConfigurationError) {
      throw new AdminFormError(
        'This server has no Google Groups credential configured, so a Google Group cannot be looked up. A manual source needs no Google Group.',
      );
    }
    throw error;
  }
  try {
    return (await client.resolve(email)).googleGroupId;
  } catch (error) {
    if (error instanceof AccessMembershipEvaluationError) {
      throw new AdminFormError(explain(email, error.code));
    }
    throw error;
  }
}
