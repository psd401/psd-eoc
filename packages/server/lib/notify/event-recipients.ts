import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  groupMembers,
  groupSources,
  neighborhoodFacilities,
  neighborhoodVersions,
} from '../../db/schema';

/**
 * How far an event at one school reaches.
 *
 * This is the whole vocabulary. An event either notifies the staff at the
 * school it was started at, or the staff at every school in that school's
 * neighborhood. There is no third answer, and no configurable object in
 * between — the event type declares which of these two it is.
 */
export type EventReach = 'building' | 'neighborhood';

/**
 * Which population an event addresses, and therefore which group sources may
 * be read at all.
 *
 * This is the real-versus-drill classification reaching the query. A `test`
 * event is contractually bound to `synthetic` by `EventTargetingSchema`, and
 * that binding is worth nothing unless something refuses to look at staff
 * groups when it is set. So population selects `group_sources.kind`: `staff`
 * reads `google-group` and `manual` sources, `synthetic` reads only
 * `synthetic` ones, and neither population can see the other's members.
 *
 * The health check and integrations test mode exercise the whole activation
 * path continuously. They can only do that safely because a synthetic
 * activation cannot address a real person — not because something downstream
 * declines to send.
 */
export type EventPopulation = 'staff' | 'synthetic';

const SOURCE_KINDS_FOR_POPULATION = Object.freeze({
  staff: ['google-group', 'manual'],
  synthetic: ['synthetic'],
} as const);

/** One school whose staff an event reaches, and when its roster was read. */
export interface ReachedFacility {
  readonly facilityId: string;
  readonly groupSourceId: string;
  /** Null when this school's group has never been read. */
  readonly membersCapturedAt: Date | null;
}

export interface EventRecipients {
  /** Lowercased staff addresses, deduplicated across schools, sorted. */
  readonly emails: readonly string[];
  readonly facilities: readonly ReachedFacility[];
  /**
   * The oldest read among the schools reached, or null if any of them has
   * never been read.
   *
   * The consequence preview shows this. It is deliberately not a refusal:
   * during an incident, notifying from a roster read six hours ago beats
   * notifying nobody, and the person confirming is entitled to know which
   * they are doing. Compare `decideAccess`, which does fail closed on stale
   * membership — letting somebody sign in is reversible, and a notification
   * that was never sent is not.
   */
  readonly oldestCapturedAt: Date | null;
  /** Schools reached whose staff roster has never been read at all. */
  readonly unreadFacilityIds: readonly string[];
  /** Schools reached that have no active staff group configured. */
  readonly unconfiguredFacilityIds: readonly string[];
}

/**
 * The schools an event at `facilityId` reaches.
 *
 * For neighborhood reach this is every school sharing a current neighborhood
 * version with the originating school, plus the originating school itself —
 * which is included even when it belongs to no neighborhood, because an event
 * always reaches where it started.
 */
async function reachedFacilityIds(
  database: Database,
  facilityId: string,
  reach: EventReach,
): Promise<readonly string[]> {
  if (reach === 'building') {
    return Object.freeze([facilityId]);
  }

  // Only the current version of each neighborhood. A superseded version is a
  // record of how schools used to be grouped, and notifying from it would
  // reach the schools somebody has already decided are no longer together.
  const current = await database
    .selectDistinctOn([neighborhoodVersions.id], {
      id: neighborhoodVersions.id,
      version: neighborhoodVersions.version,
    })
    .from(neighborhoodVersions)
    .orderBy(asc(neighborhoodVersions.id), desc(neighborhoodVersions.version));
  if (current.length === 0) {
    return Object.freeze([facilityId]);
  }

  const memberships = await database
    .select({
      neighborhoodId: neighborhoodFacilities.neighborhoodId,
      neighborhoodVersion: neighborhoodFacilities.neighborhoodVersion,
      facilityId: neighborhoodFacilities.facilityId,
    })
    .from(neighborhoodFacilities)
    .where(
      inArray(
        neighborhoodFacilities.neighborhoodId,
        current.map(({ id }) => id),
      ),
    );

  const currentVersionById = new Map(
    current.map(({ id, version }) => [id, version]),
  );
  const inCurrentVersion = memberships.filter(
    (row) =>
      currentVersionById.get(row.neighborhoodId) === row.neighborhoodVersion,
  );
  const originatingNeighborhoods = new Set(
    inCurrentVersion
      .filter((row) => row.facilityId === facilityId)
      .map((row) => row.neighborhoodId),
  );
  const reached = new Set<string>([facilityId]);
  for (const row of inCurrentVersion) {
    if (originatingNeighborhoods.has(row.neighborhoodId)) {
      reached.add(row.facilityId);
    }
  }
  return Object.freeze([...reached].sort());
}

/**
 * Resolves the staff an event notifies, from the domain rather than from a
 * separate configuration object.
 *
 * Staff belong to schools, schools belong to neighborhoods. A school's staff
 * are the members of the Google Group the district designated for it — a
 * `group_sources` row with `purpose = 'building'` and that school's
 * `facility_id`. Nothing else decides who an event reaches.
 *
 * The email address is the membership row itself. Push endpoints are joined
 * separately from `device_enrollments`, which is where they already live; this
 * returns the people, not their devices.
 */
export async function resolveEventRecipients(
  database: Database,
  input: Readonly<{
    facilityId: string;
    reach: EventReach;
    population: EventPopulation;
  }>,
): Promise<EventRecipients> {
  const facilityIds = await reachedFacilityIds(
    database,
    input.facilityId,
    input.reach,
  );

  // Purpose and kind are both applied here, before any member is read. That
  // ordering is what keeps a shared membership table safe: an access group's
  // members can never be reached through this query because its source is
  // never selected, and a staff activation can never reach a synthetic member
  // — nor a synthetic one a real staff member — for the same reason.
  const sources = await database
    .select({
      id: groupSources.id,
      facilityId: groupSources.facilityId,
      membersCapturedAt: groupSources.membersCapturedAt,
    })
    .from(groupSources)
    .where(
      and(
        eq(groupSources.purpose, 'building'),
        inArray(groupSources.kind, [
          ...SOURCE_KINDS_FOR_POPULATION[input.population],
        ]),
        eq(groupSources.active, true),
        inArray(groupSources.facilityId, [...facilityIds]),
      ),
    )
    .orderBy(asc(groupSources.id));

  const configured = new Set(
    sources.flatMap(({ facilityId }) =>
      facilityId === null ? [] : [facilityId],
    ),
  );
  const unconfiguredFacilityIds = facilityIds.filter(
    (id) => !configured.has(id),
  );

  const facilities: ReachedFacility[] = sources.flatMap((source) =>
    source.facilityId === null
      ? []
      : [
          {
            facilityId: source.facilityId,
            groupSourceId: source.id,
            membersCapturedAt: source.membersCapturedAt,
          },
        ],
  );

  const members =
    sources.length === 0
      ? []
      : await database
          .select({ email: groupMembers.email })
          .from(groupMembers)
          .where(
            inArray(
              groupMembers.groupSourceId,
              sources.map(({ id }) => id),
            ),
          );

  const emails = [
    ...new Set(members.map(({ email }) => email.toLowerCase())),
  ].sort();

  const unread = facilities.filter(
    ({ membersCapturedAt }) => membersCapturedAt === null,
  );
  const read = facilities.flatMap(({ membersCapturedAt }) =>
    membersCapturedAt === null ? [] : [membersCapturedAt.getTime()],
  );

  return Object.freeze({
    emails: Object.freeze(emails),
    facilities: Object.freeze(facilities),
    oldestCapturedAt:
      unread.length > 0 || read.length === 0
        ? null
        : new Date(Math.min(...read)),
    unreadFacilityIds: Object.freeze(
      unread.map(({ facilityId }) => facilityId).sort(),
    ),
    unconfiguredFacilityIds: Object.freeze([...unconfiguredFacilityIds].sort()),
  });
}
