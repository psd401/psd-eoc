import { sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { facilityRows } from '../../db/seed';

type SeedTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Writes the seed's facilities with the columns a schema held before
 * `0052_facility_isolated_and_user_scope` has: everything but the isolated
 * flag. Drizzle emits every column of a table it inserts into, so the seed's
 * own insert fails against such a database the moment it names `isolated`.
 * The rows take the column's default (`false`) when the fixture upgrades; the
 * fixtures that hold a database back assert migration behavior, never which
 * facilities are isolated.
 */
export async function insertFacilitiesBeforeIsolated(
  transaction: SeedTransaction,
): Promise<void> {
  for (const facility of facilityRows) {
    await transaction.execute(sql`
      insert into facilities (id, code, name, active, created_at)
      values (
        ${facility.id}, ${facility.code}, ${facility.name}, ${facility.active},
        ${facility.createdAt}
      )
      on conflict do nothing
    `);
  }
}
