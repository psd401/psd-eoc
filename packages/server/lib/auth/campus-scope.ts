import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Database } from '../../db/client';
import {
  facilities,
  neighborhoodFacilities,
  neighborhoodVersions,
} from '../../db/schema';

/**
 * The schools that share a campus with any of `facilityIds`, excluding those
 * schools themselves.
 *
 * An event reaches every school on its campus (`lib/roster/resolve.ts`), so a
 * staff member limited to one school is notified of an event next door. This
 * is the same rule read from the viewer's side, so the people an event
 * notifies are the people who can open it and post in it: the current
 * version of each neighborhood, and never an isolated facility in either
 * direction — an isolated facility's events reach its own lists only, and its
 * staff are reached by nobody else's.
 */
export async function campusMateFacilityIds(
  database: Pick<Database, 'select'>,
  facilityIds: readonly string[],
): Promise<readonly string[]> {
  if (facilityIds.length === 0) return Object.freeze([]);
  // One query on every authenticated request: the current-version campus rows
  // of the person's own non-isolated schools, joined back to every
  // non-isolated school on those same campus versions.
  const own = alias(neighborhoodFacilities, 'own_campus');
  const ownFacility = alias(facilities, 'own_facility');
  const mates = await database
    .select({ facilityId: neighborhoodFacilities.facilityId })
    .from(own)
    .innerJoin(ownFacility, eq(ownFacility.id, own.facilityId))
    .innerJoin(
      neighborhoodFacilities,
      and(
        eq(neighborhoodFacilities.neighborhoodId, own.neighborhoodId),
        eq(neighborhoodFacilities.neighborhoodVersion, own.neighborhoodVersion),
      ),
    )
    .innerJoin(facilities, eq(facilities.id, neighborhoodFacilities.facilityId))
    .where(
      and(
        inArray(own.facilityId, [...facilityIds]),
        eq(ownFacility.isolated, false),
        eq(facilities.isolated, false),
        sql`(${own.neighborhoodId}, ${own.neighborhoodVersion}) in (select ${neighborhoodVersions.id}, max(${neighborhoodVersions.version}) from ${neighborhoodVersions} group by ${neighborhoodVersions.id})`,
      ),
    );
  const excluded = new Set(facilityIds);
  return Object.freeze(
    [...new Set(mates.map((row) => row.facilityId))]
      .filter((id) => !excluded.has(id))
      .sort(),
  );
}
