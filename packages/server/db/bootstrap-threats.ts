import { ThreatKeySchema } from '@psd-eoc/contracts';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from './client';
import { threats } from './schema';

/**
 * The district's threats, supplied as configuration.
 *
 * A threat is what an operator names first when starting an event, before the
 * response. The list is the district's own vocabulary — one district names
 * wildlife, another names flooding — so like facilities it is declared in CDK
 * context and restored on every deploy, rather than typed into an admin page
 * and lost with a rebuilt database. Anything specific to a district is
 * configuration, never a literal and never a row only a human can make.
 */
export class ThreatConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ThreatConfigurationError';
  }
}

const THREATS_ENV = 'PSD_EOC_THREATS';

/**
 * One threat, in the shape the table already constrains.
 *
 * The key is the district's own identifier and is what makes this idempotent;
 * ids are generated, so they cannot be the thing configuration matches on.
 * `requiresDetail` marks an entry such as "Other" that an operator cannot
 * choose without typing what the threat is.
 */
const ThreatConfigurationSchema = z
  .object({
    key: ThreatKeySchema,
    name: z.string().trim().min(1).max(160),
    requiresDetail: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict();

const ThreatListSchema = z
  .array(ThreatConfigurationSchema)
  .max(500)
  .superRefine((list, context) => {
    const seen = new Set<string>();
    for (const [index, threat] of list.entries()) {
      if (seen.has(threat.key)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate threat key ${threat.key}.`,
          path: [index, 'key'],
        });
      }
      seen.add(threat.key);
    }
  });

export type ThreatConfiguration = z.infer<typeof ThreatConfigurationSchema>;

/**
 * Reads the configured threats, or an empty list when none are supplied.
 *
 * Absent configuration is not an error — a deployment that has not yet
 * declared its threats is legitimate and the start flow reports that nothing
 * is selectable. Malformed configuration is an error, because silently
 * seeding nothing is how a district discovers at the worst moment that its
 * operators cannot start an event.
 */
export function readThreatConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly ThreatConfiguration[] {
  const raw = environment[THREATS_ENV]?.trim();
  if (raw === undefined || raw.length === 0) {
    return Object.freeze([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ThreatConfigurationError(`${THREATS_ENV} is not valid JSON.`);
  }
  const result = ThreatListSchema.safeParse(parsed);
  if (!result.success) {
    throw new ThreatConfigurationError(
      `${THREATS_ENV} does not describe a list of threats.`,
    );
  }
  return Object.freeze(result.data);
}

export type BootstrapThreatsOutcome = Readonly<{
  configured: number;
  created: readonly string[];
  existing: readonly string[];
}>;

/**
 * Creates any configured threat the database does not already have.
 *
 * Matched on key, and existing rows are left exactly as they are, including
 * their recorded position: the declared order is written once, when a row is
 * created. Operators see the list alphabetically (the one needing a
 * description last), so the position is a record of how the vocabulary was
 * declared, not what anyone reads. The point is that a rebuild does not lose
 * the vocabulary, not that configuration outranks what is already there.
 */
export async function bootstrapThreats(
  database: Database,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BootstrapThreatsOutcome> {
  const configured = readThreatConfiguration(environment);
  if (configured.length === 0) {
    return Object.freeze({
      configured: 0,
      created: Object.freeze([]),
      existing: Object.freeze([]),
    });
  }

  const keys = configured.map((threat) => threat.key);
  const present = await database
    .select({ key: threats.key })
    .from(threats)
    .where(inArray(threats.key, keys));
  const have = new Set(present.map((row) => row.key));
  const missing = configured.flatMap((threat, sortOrder) =>
    have.has(threat.key) ? [] : [{ ...threat, sortOrder }],
  );

  if (missing.length > 0) {
    await database.insert(threats).values(
      missing.map((threat) => ({
        active: threat.active,
        key: threat.key,
        name: threat.name,
        requiresDetail: threat.requiresDetail,
        sortOrder: threat.sortOrder,
      })),
    );
  }

  return Object.freeze({
    configured: configured.length,
    created: Object.freeze(missing.map((threat) => threat.key)),
    existing: Object.freeze([...have].sort()),
  });
}

/** A one-line summary for the migration log; names no person and no address. */
export function describeThreatOutcome(
  outcome: BootstrapThreatsOutcome,
): string {
  if (outcome.configured === 0) {
    return 'No threats are configured; none were created.';
  }
  if (outcome.created.length === 0) {
    return `All ${String(outcome.configured)} configured threats already exist.`;
  }
  return `Created ${String(outcome.created.length)} of ${String(outcome.configured)} configured threats: ${outcome.created.join(', ')}.`;
}
