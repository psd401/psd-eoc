import type { GroupSourcePage } from '@psd-eoc/contracts';
import { z } from 'zod';

import {
  AccessMembershipEvaluationError,
  createGoogleGroupResolver,
  type GoogleGroupResolver,
} from '../../../lib/auth/google-access-membership';
import {
  GoogleRosterConfigurationError,
  readGoogleCloudIdentityRosterConfiguration,
} from '../../../lib/auth/google-roster-config';
import {
  SessionAccessError,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import { AdminFormError } from './admin-request';
import { executeListGroupSourcesCapability } from './capabilities';

/** Resolves a Google Group address to the ID the server stores for it. */
export type GoogleGroupIdResolver = (email: string) => Promise<string>;
/**
 * Resolves an address to its Google Group ID, or to null when Google does not
 * hold a group at that address yet. Only building sources may wait; the form
 * parser decides which intents use this resolver.
 */
export type WaitingGoogleGroupIdResolver = (
  email: string,
) => Promise<string | null>;

/** The part of a session these helpers decide on. */
export type AdminSession = Pick<AuthenticatedSession, 'roles'>;

/** The one form of a group address the record carries and compares. */
export function normalizeGroupAddress(value: string): string {
  return value.trim().toLowerCase();
}

const GroupAddressShape = z.string().email().max(320);

/**
 * Asked before any provider call. A lookup answers whether a group exists in
 * the Workspace, which is not a question a staff session gets to ask. The
 * capability engine enforces the same role when the command runs; this is
 * the same rule, applied before Google is contacted rather than after.
 */
function requireAdministrator(authenticated: AdminSession): void {
  if (!authenticated.roles.includes('admin')) {
    throw new SessionAccessError('FORBIDDEN', 'Access is denied.');
  }
}

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
  authenticated: AdminSession,
  email: string,
  resolver: () => GoogleGroupResolver = defaultResolver,
): Promise<string> {
  requireAdministrator(authenticated);
  const address = normalizeGroupAddress(email);
  // A typo is answered here, in the form's own words, rather than sent to
  // Google and reported back as a group Google could not resolve.
  if (!GroupAddressShape.safeParse(address).success) {
    throw new AdminFormError(
      `${address || 'The Google Group address'} is not a valid email address.`,
    );
  }
  let client: GoogleGroupResolver;
  try {
    client = resolver();
  } catch (error) {
    if (error instanceof GoogleRosterConfigurationError) {
      // Missing and malformed arrive under one code; both mean the lookup
      // cannot happen on this server, and nothing was saved either way.
      throw new AdminFormError(
        "This server's Google Groups credential is missing or invalid, so a Google Group cannot be looked up. Nothing was saved.",
      );
    }
    throw error;
  }
  try {
    return (await client.resolve(address)).googleGroupId;
  } catch (error) {
    if (error instanceof AccessMembershipEvaluationError) {
      throw new AdminFormError(explain(address, error.code));
    }
    throw error;
  }
}
/** The resolver the administration forms use unless a test injects one. */
export function defaultGoogleGroupResolver(): GoogleGroupResolver {
  return defaultResolver();
}

/** Google could not be asked at all; nothing about the address is known. */
const UNASKED_CODES: ReadonlySet<string> = new Set([
  'GOOGLE_CONFIGURATION_INVALID',
  'GOOGLE_UNAVAILABLE',
]);

/**
 * Like `resolveGoogleGroupIdForForm`, but answers null when Google has not
 * confirmed the group, so a building source can be registered as waiting:
 * it names nobody until Google holds the group, and the scheduled sync
 * records the ID the first time Google resolves the address. Google has not
 * confirmed a group it does not hold yet, and one it could not be asked
 * about: a missing or invalid credential on this server, or Google being
 * unavailable, must not stop a school from being registered, and the next
 * check or sync asks again. A refusal is different: Google answered, and
 * said the address is not an exact group or may not be read. That is still
 * an error before anything is saved, so waiting never hides a permission
 * problem or a typo Google could see.
 */
export async function resolveGoogleGroupIdOrWaitingForForm(
  authenticated: AdminSession,
  email: string,
  resolver: () => GoogleGroupResolver = defaultResolver,
): Promise<string | null> {
  requireAdministrator(authenticated);
  const address = normalizeGroupAddress(email);
  if (!GroupAddressShape.safeParse(address).success) {
    throw new AdminFormError(
      `${address || 'The Google Group address'} is not a valid email address.`,
    );
  }
  let client: GoogleGroupResolver;
  try {
    client = resolver();
  } catch (error) {
    if (error instanceof GoogleRosterConfigurationError) return null;
    throw error;
  }
  try {
    const held = await client.resolveIfHeld(address);
    return held === null ? null : held.googleGroupId;
  } catch (error) {
    if (error instanceof AccessMembershipEvaluationError) {
      if (UNASKED_CODES.has(error.code)) return null;
      throw new AdminFormError(explain(address, error.code));
    }
    throw error;
  }
}

/** What an existing access group is known by: its address and the ID Google gave it. */
export interface StoredAccessGroupLocator {
  readonly id: string;
  readonly email: string | null;
  readonly googleGroupId: string | null;
}

export type AccessGroupLocatorLookup = (
  authenticated: AuthenticatedSession,
  id: string,
) => Promise<StoredAccessGroupLocator | null>;

const ACCESS_GROUP_PAGE_LIMIT = 100;
const ACCESS_GROUP_PAGE_CAP = 10;

async function listedAccessGroupLocator(
  authenticated: AuthenticatedSession,
  id: string,
): Promise<StoredAccessGroupLocator | null> {
  let cursor: string | null = null;
  for (let page = 0; page < ACCESS_GROUP_PAGE_CAP; page += 1) {
    const result: GroupSourcePage = await executeListGroupSourcesCapability({
      authenticated,
      query: {
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        active: null,
        cursor,
        limit: ACCESS_GROUP_PAGE_LIMIT,
      },
    });
    const found = result.items.find((item) => item.id === id);
    if (found !== undefined) {
      // The query asks for Google sources only; anything else has no
      // address to compare, and the capability will refuse the edit.
      return found.kind === 'google-group'
        ? Object.freeze({
            id: found.id,
            email: found.email,
            googleGroupId: found.googleGroupId,
          })
        : null;
    }
    cursor = result.pageInfo.nextCursor;
    if (cursor === null) break;
  }
  return null;
}

/**
 * The ID an access-group edit should carry. An edit that keeps the address
 * keeps the ID Google already gave it and never contacts Google, so a
 * display-name change or a deactivation goes through while Google is down
 * or the credential is being rotated. Only a changed address is resolved.
 */
export async function googleGroupIdForAccessGroupUpdate(
  authenticated: AuthenticatedSession,
  input: Readonly<{ id: string; email: string }>,
  dependencies: Readonly<{
    lookup?: AccessGroupLocatorLookup;
    resolver?: () => GoogleGroupResolver;
  }> = {},
): Promise<string> {
  requireAdministrator(authenticated);
  const current = await (dependencies.lookup ?? listedAccessGroupLocator)(
    authenticated,
    input.id,
  );
  if (
    current !== null &&
    current.email !== null &&
    current.googleGroupId !== null &&
    normalizeGroupAddress(current.email) === normalizeGroupAddress(input.email)
  ) {
    return current.googleGroupId;
  }
  return resolveGoogleGroupIdForForm(
    authenticated,
    input.email,
    dependencies.resolver,
  );
}
