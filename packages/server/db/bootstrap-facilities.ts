import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from './client';
import {
  facilities,
  neighborhoodFacilities,
  neighborhoodVersions,
} from './schema';

/**
 * The district's facilities, supplied as configuration.
 *
 * Facilities were only ever creatable through the admin UI, so they existed as
 * rows and nowhere else. Nothing in this repository could produce them, which
 * meant a rebuilt deployment came up with none, and the twenty schools someone
 * had typed in were simply gone. `seedReferenceData` deliberately does not
 * create them, so nothing else filled the gap.
 *
 * That also broke the rule this repository is supposed to hold to: anything
 * specific to a district is configuration, never a literal and never a row only
 * a human can make. A district's schools are exactly that.
 *
 * So they are named in the environment, fed from CDK context, the same way the
 * first access group and the staff domain are. A district edits a list; a
 * rebuild restores what the district declared.
 */
export class FacilityConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FacilityConfigurationError';
  }
}

const FACILITIES_ENV = 'PSD_EOC_FACILITIES';

/**
 * One facility, in the shape the table already constrains.
 *
 * The code is the district's own identifier for the site and is what makes this
 * idempotent — ids are generated, so they cannot be the thing configuration
 * matches on.
 */
const FacilityConfigurationSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(
        /^[A-Z0-9-]+$/u,
        'A facility code is upper-case letters, digits, and hyphens.',
      ),
    name: z.string().trim().min(1).max(160),
    active: z.boolean().default(true),
  })
  .strict();

const FacilityListSchema = z
  .array(FacilityConfigurationSchema)
  .max(2_000)
  .superRefine((list, context) => {
    const seen = new Set<string>();
    for (const [index, facility] of list.entries()) {
      if (seen.has(facility.code)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate facility code ${facility.code}.`,
          path: [index, 'code'],
        });
      }
      seen.add(facility.code);
    }
  });

export type FacilityConfiguration = z.infer<typeof FacilityConfigurationSchema>;

/**
 * Reads the configured facilities, or an empty list when none are supplied.
 *
 * Absent configuration is not an error — a deployment that manages its
 * facilities through the admin UI is legitimate. Malformed configuration is an
 * error, because silently seeding nothing is how a district discovers at the
 * worst moment that it has no schools.
 */
export function readFacilityConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly FacilityConfiguration[] {
  const raw = environment[FACILITIES_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    return Object.freeze([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FacilityConfigurationError(
      `${FACILITIES_ENV} is not valid JSON.`,
    );
  }
  const result = FacilityListSchema.safeParse(parsed);
  if (!result.success) {
    throw new FacilityConfigurationError(
      `${FACILITIES_ENV} does not describe a list of facilities.`,
    );
  }
  return Object.freeze(result.data);
}

export type BootstrapFacilitiesOutcome = Readonly<{
  configured: number;
  created: readonly string[];
  existing: readonly string[];
}>;

/**
 * Creates any configured facility the database does not already have.
 *
 * Matched on code, and existing rows are left exactly as they are. Someone may
 * have renamed a school or deactivated it through the admin UI, and
 * configuration arriving later must not quietly undo that; the point here is
 * that a rebuild does not lose sites, not that configuration outranks an
 * operator.
 */
export async function bootstrapFacilities(
  database: Database,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BootstrapFacilitiesOutcome> {
  const configured = readFacilityConfiguration(environment);
  if (configured.length === 0) {
    return Object.freeze({
      configured: 0,
      created: Object.freeze([]),
      existing: Object.freeze([]),
    });
  }

  const codes = configured.map((facility) => facility.code);
  const present = await database
    .select({ code: facilities.code })
    .from(facilities)
    .where(inArray(facilities.code, codes));
  const have = new Set(present.map((row) => row.code));
  const missing = configured.filter((facility) => !have.has(facility.code));

  if (missing.length > 0) {
    await database.insert(facilities).values(
      missing.map((facility) => ({
        active: facility.active,
        code: facility.code,
        name: facility.name,
      })),
    );
  }

  return Object.freeze({
    configured: configured.length,
    created: Object.freeze(missing.map((facility) => facility.code)),
    existing: Object.freeze([...have].sort()),
  });
}

/** A one-line summary for the migration log; names no person and no address. */
export function describeFacilityOutcome(
  outcome: BootstrapFacilitiesOutcome,
): string {
  if (outcome.configured === 0) {
    return 'No facilities are configured; none were created.';
  }
  if (outcome.created.length === 0) {
    return `All ${String(outcome.configured)} configured facilities already exist.`;
  }
  return `Created ${String(outcome.created.length)} of ${String(outcome.configured)} configured facilities: ${outcome.created.join(', ')}.`;
}

const NEIGHBOURHOODS_ENV = 'PSD_EOC_NEIGHBORHOODS';

/**
 * A neighborhood: the district's name for a group of sites that are notified
 * together, and the facilities in it.
 *
 * Referenced by facility code rather than id for the same reason facilities are
 * — ids are generated, so a fresh cluster mints different ones, and only the
 * code survives a rebuild.
 */
const NeighborhoodConfigurationSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    facilityCodes: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z0-9-]{1,32}$/u),
      )
      .min(1)
      .max(2_000),
  })
  .strict();

const NeighborhoodListSchema = z
  .array(NeighborhoodConfigurationSchema)
  .max(500)
  .superRefine((list, context) => {
    const seen = new Set<string>();
    for (const [index, neighborhood] of list.entries()) {
      if (seen.has(neighborhood.name)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate neighborhood ${neighborhood.name}.`,
          path: [index, 'name'],
        });
      }
      seen.add(neighborhood.name);
    }
  });

export type NeighborhoodConfiguration = z.infer<
  typeof NeighborhoodConfigurationSchema
>;

export function readNeighborhoodConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly NeighborhoodConfiguration[] {
  const raw = environment[NEIGHBOURHOODS_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    return Object.freeze([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FacilityConfigurationError(
      `${NEIGHBOURHOODS_ENV} is not valid JSON.`,
    );
  }
  const result = NeighborhoodListSchema.safeParse(parsed);
  if (!result.success) {
    throw new FacilityConfigurationError(
      `${NEIGHBOURHOODS_ENV} does not describe a list of neighborhoods.`,
    );
  }
  return Object.freeze(result.data);
}

export type BootstrapNeighborhoodsOutcome = Readonly<{
  configured: number;
  created: readonly string[];
}>;

/**
 * Creates any configured neighborhood the database does not already have.
 *
 * Matched on name at version 1, and an existing neighborhood is left alone —
 * later versions are an administrator's work and configuration must not
 * silently roll them back. A facility code naming nothing is refused rather
 * than skipped, because a campus quietly missing a school is the kind of error
 * that only shows up when it matters.
 */
export async function bootstrapNeighborhoods(
  database: Database,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BootstrapNeighborhoodsOutcome> {
  const configured = readNeighborhoodConfiguration(environment);
  if (configured.length === 0) {
    return Object.freeze({ configured: 0, created: Object.freeze([]) });
  }

  const known = await database
    .select({ code: facilities.code, id: facilities.id })
    .from(facilities);
  const idByCode = new Map(known.map((row) => [row.code, row.id]));

  const created: string[] = [];
  for (const neighborhood of configured) {
    const [existing] = await database
      .select({ id: neighborhoodVersions.id })
      .from(neighborhoodVersions)
      .where(eq(neighborhoodVersions.name, neighborhood.name))
      .limit(1);
    if (existing !== undefined) {
      continue;
    }
    const missing = neighborhood.facilityCodes.filter(
      (code) => !idByCode.has(code),
    );
    if (missing.length > 0) {
      throw new FacilityConfigurationError(
        `Neighborhood ${neighborhood.name} names unknown facilities: ${missing.join(', ')}.`,
      );
    }
    const id = randomUUID();
    // One transaction, because a published version is immutable: the trigger
    // on neighborhood_facilities admits rows only while the parent version is
    // still being created, comparing xmin against the current transaction.
    // Inserting the version and its members separately is refused, and rightly
    // — otherwise a campus could gain a school after the fact with no new
    // version recording that it happened.
    await database.transaction(async (transaction) => {
      await transaction
        .insert(neighborhoodVersions)
        .values({ id, name: neighborhood.name, version: 1 });
      await transaction.insert(neighborhoodFacilities).values(
        neighborhood.facilityCodes.map((code) => ({
          facilityId: idByCode.get(code) as string,
          neighborhoodId: id,
          neighborhoodVersion: 1,
        })),
      );
    });
    created.push(neighborhood.name);
  }

  return Object.freeze({
    configured: configured.length,
    created: Object.freeze(created),
  });
}

/** A one-line summary for the migration log. */
export function describeNeighborhoodOutcome(
  outcome: BootstrapNeighborhoodsOutcome,
): string {
  if (outcome.configured === 0) {
    return 'No neighborhoods are configured; none were created.';
  }
  if (outcome.created.length === 0) {
    return `All ${String(outcome.configured)} configured neighborhoods already exist.`;
  }
  return `Created ${String(outcome.created.length)} of ${String(outcome.configured)} configured neighborhoods.`;
}
