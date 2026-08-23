import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { StaffRosterEmailSchema } from '@psd-eoc/contracts';

import type { Database } from './client';
import { groupSources } from './schema';

/**
 * The first trusted group, supplied as configuration.
 *
 * A fresh deployment has no access groups, so nobody may sign in; and the page
 * that configures access groups is behind sign-in. Without something to break
 * that circle, standing this software up for a new district means running a
 * bespoke script against the production database — which is exactly how this
 * deployment locked every administrator out of itself once already.
 *
 * So the first group is named in the environment, the same place the Google
 * OIDC client and the database URL are named. Nothing about any district is
 * written here.
 */
export interface InitialAccessGroupConfiguration {
  /** The provider's identifier for the group, e.g. a Cloud Identity group id. */
  readonly googleGroupId: string;
  /** The group's address. Membership in it grants administrator. */
  readonly email: string;
  /** What to call it in the admin UI until somebody renames it. */
  readonly displayName: string;
}

export class InitialAccessGroupConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InitialAccessGroupConfigurationError';
  }
}

const GROUP_ID_ENV = 'PSD_EOC_INITIAL_ACCESS_GROUP_ID';
const GROUP_EMAIL_ENV = 'PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL';
const GROUP_NAME_ENV = 'PSD_EOC_INITIAL_ACCESS_GROUP_NAME';

function trimmed(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Reads the initial-group configuration, or `null` when none is supplied.
 *
 * Absent configuration is not an error: an already-configured deployment does
 * not need it, and a first-run deployment can also add its group by hand
 * against the database. What is an error is supplying half of it, because that
 * silently produces a deployment nobody can sign in to.
 */
export function readInitialAccessGroupConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InitialAccessGroupConfiguration | null {
  const googleGroupId = trimmed(environment, GROUP_ID_ENV);
  const email = trimmed(environment, GROUP_EMAIL_ENV);
  const displayName = trimmed(environment, GROUP_NAME_ENV);

  if (googleGroupId === undefined && email === undefined) {
    if (displayName !== undefined) {
      throw new InitialAccessGroupConfigurationError(
        `${GROUP_NAME_ENV} was set without ${GROUP_ID_ENV} and ${GROUP_EMAIL_ENV}.`,
      );
    }
    return null;
  }
  if (googleGroupId === undefined || email === undefined) {
    throw new InitialAccessGroupConfigurationError(
      `${GROUP_ID_ENV} and ${GROUP_EMAIL_ENV} must be set together.`,
    );
  }
  // Cloud Identity names a group "groups/<id>", and that is the form its API
  // returns and the form an administrator copies out of the console. Everything
  // downstream stores and compares the bare <id>: the membership reader slices
  // the prefix off before it ever reaches the database, and the evaluated-group
  // schema refuses anything outside [A-Za-z0-9_-], so a stored "groups/..."
  // can never equal a resolved id.
  //
  // Accepting the prefixed form verbatim produced a deployment that looked
  // correctly configured and could never sync: every run failed closed with
  // ACCESS_CONFIGURATION_CHANGED, and because roles are derived from
  // membership, nobody could sign in. Normalise it here instead, where the
  // value enters the system.
  const normalisedGroupId = googleGroupId.replace(/^groups\//u, '');
  if (normalisedGroupId.length > 255 || normalisedGroupId.length === 0) {
    throw new InitialAccessGroupConfigurationError(
      `${GROUP_ID_ENV} must be between 1 and 255 characters.`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(normalisedGroupId)) {
    throw new InitialAccessGroupConfigurationError(
      `${GROUP_ID_ENV} must be a Cloud Identity group id, optionally prefixed with "groups/".`,
    );
  }
  // The same schema the sync parses this row back with, not a looser regex of
  // our own. An ad hoc pattern admits addresses the roster schema refuses —
  // a doubled dot, a leading or trailing dot, a leading hyphen in the domain —
  // and the consequence is not a rejected row, it is a deployment nobody can
  // sign in to. readConfiguredAccessGroups parses *every* active access group
  // through StaffRosterEmailSchema and throws CONFIGURED_ACCESS_GROUP_INVALID
  // if any one of them fails, so a single malformed address stops the sync for
  // the whole district. And `email` is immutable for an access-purpose row, so
  // the row cannot be corrected in place.
  //
  // This is exactly the mismatch that made googleGroupId unusable above. It is
  // the same mistake, one field over.
  if (!StaffRosterEmailSchema.safeParse(email).success) {
    throw new InitialAccessGroupConfigurationError(
      `${GROUP_EMAIL_ENV} must be a group email address the roster schema accepts.`,
    );
  }
  if (displayName !== undefined && displayName.length > 160) {
    throw new InitialAccessGroupConfigurationError(
      `${GROUP_NAME_ENV} must be at most 160 characters.`,
    );
  }
  if (displayName !== undefined && /[\0\r\n]/u.test(displayName)) {
    throw new InitialAccessGroupConfigurationError(
      `${GROUP_NAME_ENV} must be a single-line display name.`,
    );
  }
  return Object.freeze({
    googleGroupId: normalisedGroupId,
    email: email.toLowerCase(),
    displayName: displayName ?? 'Administrators',
  });
}

export type BootstrapAccessOutcome =
  /** No configuration was supplied. */
  | Readonly<{ kind: 'not-configured' }>
  /** Access groups already exist; the configuration was ignored. */
  | Readonly<{ kind: 'already-configured'; activeGroupCount: number }>
  /** The configured group was created and grants administrator. */
  | Readonly<{ kind: 'created'; groupSourceId: string; email: string }>;

/**
 * Creates the first trusted group when a deployment has none.
 *
 * Deliberately conservative. It acts only when *no* access group exists at
 * all — not "none active", not "none matching" — so it can never revoke or
 * replace a configuration a district has already made, and running it on every
 * deploy is safe. Once an administrator can sign in, every further change to
 * who may sign in happens in the app.
 *
 * It creates the group, not the membership: the scheduled sync reads the
 * provider and fills that in. Whoever is in the group at that point becomes an
 * administrator.
 */
export async function bootstrapAccessConfiguration(
  database: Database,
  configuration: InitialAccessGroupConfiguration | null = readInitialAccessGroupConfiguration(),
): Promise<BootstrapAccessOutcome> {
  if (configuration === null) {
    return Object.freeze({ kind: 'not-configured' as const });
  }

  // Any access group at all counts as configured, active or not.
  //
  // This briefly considered only *active* groups. The reasoning was that
  // group_sources was append-only by trigger, so a malformed row could never
  // be removed and would block seeding forever — which is how the rebuilt
  // stack ended up with an access group the sync could not match and no
  // supported way to replace it.
  //
  // Migration 0029 removed that blanket DELETE ban, so the premise is gone: a
  // bad row can now simply be deleted and re-seeded. And keying off "none
  // active" is dangerous in a way the original is not. The supported workflow
  // now passes explicit empty parameter values when configuration is omitted,
  // but this database guard remains the authoritative protection: a district
  // that deactivates its access groups on purpose, say while investigating a
  // compromise, must not have a routine deploy reopen sign-in regardless of
  // the configuration it receives.
  const existing = await database
    .select({ id: groupSources.id })
    .from(groupSources)
    .where(eq(groupSources.purpose, 'access'));
  if (existing.length > 0) {
    const active = await database
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        and(eq(groupSources.purpose, 'access'), eq(groupSources.active, true)),
      );
    return Object.freeze({
      kind: 'already-configured' as const,
      activeGroupCount: active.length,
    });
  }

  const [created] = await database
    .insert(groupSources)
    .values({
      id: randomUUID(),
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: configuration.displayName,
      active: true,
      grantedRole: 'admin',
      // Normalised again at the point the row is written, not only where the
      // environment is read. A caller can hand this function a configuration
      // object it built itself — the tests do — and a locator with the
      // "groups/" prefix still on it is one the membership sync can never
      // match, which is the failure this whole path exists to prevent.
      googleGroupId: configuration.googleGroupId.replace(/^groups\//u, ''),
      email: configuration.email,
      fixtureKey: null,
    })
    .returning();
  if (created === undefined) {
    throw new InitialAccessGroupConfigurationError(
      'The initial access group could not be created.',
    );
  }
  return Object.freeze({
    kind: 'created' as const,
    groupSourceId: created.id,
    email: configuration.email,
  });
}

/** One line an operator can read in deploy logs. */
export function describeBootstrapOutcome(
  outcome: BootstrapAccessOutcome,
): string {
  switch (outcome.kind) {
    case 'not-configured':
      return `No initial access group configured (${GROUP_ID_ENV} and ${GROUP_EMAIL_ENV} are unset). Sign-in stays closed until an access group exists.`;
    case 'already-configured':
      return `Access groups already configured; ${String(outcome.activeGroupCount)} active. The initial-group configuration was ignored.`;
    case 'created':
      return 'Created the configured initial access group, granting administrator. Members can sign in after the next membership sync.';
  }
}
