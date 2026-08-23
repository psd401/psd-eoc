import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from './client';
import { facilities, groupMembers, groupSources } from './schema';

/**
 * The synthetic population, supplied as configuration.
 *
 * A `test` event is bound by `EventTargetingSchema` to a synthetic population,
 * and `resolveEventRecipients` honours that by reading only group sources whose
 * kind matches. That binding is what lets the health check build a real
 * activation preview every minute, and integrations test mode exercise the same
 * path, without either being able to address a real person.
 *
 * Which means the synthetic population has to exist, and — like the district's
 * schools — it cannot be a row only a human can make. A rebuilt deployment
 * would come up without one, and the health check would have nothing to
 * exercise.
 */
export class SyntheticGroupConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SyntheticGroupConfigurationError';
  }
}

const SYNTHETIC_GROUPS_ENV = 'PSD_EOC_SYNTHETIC_GROUPS';

/**
 * Domains reserved by RFC 2606 and RFC 6761 precisely so they can never
 * resolve.
 *
 * Every synthetic member must be at one of these. This is the property that
 * makes a synthetic activation safe by construction rather than by care: a
 * misconfigured synthetic group cannot contain a real address, so the health
 * check cannot be pointed at a person by editing configuration. Without it,
 * "synthetic" would mean only "in a group somebody labelled synthetic".
 */
const RESERVED_DOMAINS = Object.freeze([
  'invalid',
  'example',
  'test',
  'localhost',
  'example.com',
  'example.net',
  'example.org',
] as const);

function isReserved(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return RESERVED_DOMAINS.some(
    (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
  );
}

const SyntheticMemberSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+$/u, 'A synthetic member must be an address.')
  .refine(isReserved, {
    message:
      'A synthetic member must use a reserved domain that cannot resolve, such as example.invalid.',
  });

/**
 * One synthetic group: the school it stands in for, and the addresses that
 * receive when a test event is started there.
 *
 * Bound to the facility by code rather than id, for the same reason facilities
 * and neighborhoods are — ids are generated, so only the code survives a
 * rebuild.
 */
const SyntheticGroupConfigurationSchema = z
  .object({
    facilityCode: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(
        /^[A-Z0-9-]+$/u,
        'A facility code is upper-case letters, digits, and hyphens.',
      ),
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .default('Synthetic test recipients'),
    members: z.array(SyntheticMemberSchema).min(1).max(50),
  })
  .strict();

export type SyntheticGroupConfiguration = z.infer<
  typeof SyntheticGroupConfigurationSchema
>;

export interface BootstrapSyntheticGroupsOutcome {
  readonly configured: number;
  readonly created: readonly string[];
  readonly existing: readonly string[];
}

/** `group_sources_fixture_key_format` allows lower-case, digits, and hyphens. */
function fixtureKeyFor(facilityCode: string): string {
  return `synthetic-${facilityCode.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')}`;
}

export function readSyntheticGroupConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly SyntheticGroupConfiguration[] {
  const raw = environment[SYNTHETIC_GROUPS_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    return Object.freeze([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyntheticGroupConfigurationError(
      `${SYNTHETIC_GROUPS_ENV} must be a JSON array of synthetic groups.`,
    );
  }
  const result = z
    .array(SyntheticGroupConfigurationSchema)
    .max(200)
    .safeParse(parsed);
  if (!result.success) {
    // The issue text names the rule, never the value — a rejected address is
    // still an address and does not belong in a deploy log.
    const reasons = [
      ...new Set(result.error.issues.map((issue) => issue.message)),
    ].sort();
    throw new SyntheticGroupConfigurationError(
      `${SYNTHETIC_GROUPS_ENV} is invalid: ${reasons.join(' ')}`,
    );
  }
  const codes = result.data.map((group) => group.facilityCode);
  if (new Set(codes).size !== codes.length) {
    throw new SyntheticGroupConfigurationError(
      `${SYNTHETIC_GROUPS_ENV} names the same facility more than once.`,
    );
  }
  return Object.freeze(result.data);
}

/**
 * Creates the configured synthetic groups for facilities that have none.
 *
 * Idempotent and additive, like the facility seeding it follows: a group that
 * already exists is left exactly as it is, including its membership, so an
 * operator who edited one is not overruled by configuration arriving later.
 *
 * A configured facility that does not exist is skipped rather than refused.
 * Facilities are seeded from configuration in the same bootstrap, so the only
 * way to reach that is a synthetic group naming a school the district removed,
 * and failing the whole deploy over it would be worse than leaving the health
 * check without that one target.
 */
export async function bootstrapSyntheticGroups(
  database: Database,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now: () => Date = () => new Date(),
): Promise<BootstrapSyntheticGroupsOutcome> {
  const configured = readSyntheticGroupConfiguration(environment);
  if (configured.length === 0) {
    return Object.freeze({
      configured: 0,
      created: Object.freeze([]),
      existing: Object.freeze([]),
    });
  }

  const codes = configured.map((group) => group.facilityCode);
  const facilityRows = await database
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(inArray(facilities.code, codes));
  const facilityIdByCode = new Map(
    facilityRows.map((row) => [row.code, row.id]),
  );

  const present = await database
    .select({ fixtureKey: groupSources.fixtureKey })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.kind, 'synthetic'),
        eq(groupSources.purpose, 'building'),
        inArray(groupSources.fixtureKey, codes.map(fixtureKeyFor)),
      ),
    );
  const have = new Set(
    present.flatMap(({ fixtureKey }) =>
      fixtureKey === null ? [] : [fixtureKey],
    ),
  );

  const created: string[] = [];
  const capturedAt = now();
  for (const group of configured) {
    const facilityId = facilityIdByCode.get(group.facilityCode);
    const fixtureKey = fixtureKeyFor(group.facilityCode);
    if (facilityId === undefined || have.has(fixtureKey)) {
      continue;
    }
    // Group and membership together: a synthetic group with no members would
    // make a test activation resolve to nobody and read as a broken health
    // check rather than a missing configuration.
    // The id is minted here rather than read back, so the membership insert
    // needs nothing from the group insert and the transaction stays two
    // statements with no round trip between them.
    const groupSourceId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.insert(groupSources).values({
        id: groupSourceId,
        kind: 'synthetic',
        purpose: 'building',
        facilityId,
        displayName: group.displayName,
        active: true,
        grantedRole: null,
        // Synthetic membership comes from configuration, not a provider, and
        // the sync never touches it — it reads only `google-group` sources.
        // Stamped at creation because that is genuinely when this membership
        // was established, and leaving it null would report a population that
        // has never been read.
        membersCapturedAt: capturedAt,
        googleGroupId: null,
        email: null,
        fixtureKey,
      });
      await transaction.insert(groupMembers).values(
        [...new Set(group.members)].map((email) => ({
          groupSourceId,
          email,
          capturedAt,
        })),
      );
    });
    created.push(group.facilityCode);
  }

  return Object.freeze({
    configured: configured.length,
    created: Object.freeze(created),
    existing: Object.freeze([...have].sort()),
  });
}

/** A one-line summary for the migration log; names no address. */
export function describeSyntheticGroupOutcome(
  outcome: BootstrapSyntheticGroupsOutcome,
): string {
  if (outcome.configured === 0) {
    return 'No synthetic groups are configured; none were created.';
  }
  if (outcome.created.length === 0) {
    return `All ${String(outcome.configured)} configured synthetic groups already exist.`;
  }
  return `Created ${String(outcome.created.length)} of ${String(outcome.configured)} configured synthetic groups: ${outcome.created.join(', ')}.`;
}
