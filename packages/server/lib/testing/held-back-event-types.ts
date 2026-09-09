import { sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { eventTypeRows } from '../../db/seed';

type SeedTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Writes the seed's event types with the columns a schema held before
 * `0047_threat_on_activation` actually has.
 *
 * Drizzle emits every column of a table it inserts into, so the seed's own
 * insert fails against such a database the moment it names `requires_detail`.
 * The rows land without that rule and pick up its default (`false`) when the
 * fixture upgrades; the fixtures that hold a database back assert migration
 * and removal behavior, never the operator detail rule.
 */
export async function insertEventTypesBeforeDetailRule(
  transaction: SeedTransaction,
): Promise<void> {
  for (const row of eventTypeRows) {
    await transaction.execute(sql`
      insert into event_types (id, key, family_key, template_mode, created_at)
      values (
        ${row.id}, ${row.key}, ${row.familyKey}, ${row.templateMode}, ${row.createdAt}
      )
      on conflict do nothing
    `);
  }
}

/**
 * Writes the seed's event types with the columns a schema held before
 * `0051_response_display_order` has: everything but the display order. The
 * rows take the column's default when the fixture upgrades; the fixtures
 * that hold a database back assert migration behavior, never list order.
 */
export async function insertEventTypesBeforeDisplayOrder(
  transaction: SeedTransaction,
): Promise<void> {
  for (const row of eventTypeRows) {
    await transaction.execute(sql`
      insert into event_types (
        id, key, family_key, template_mode, requires_detail, created_at
      )
      values (
        ${row.id}, ${row.key}, ${row.familyKey}, ${row.templateMode},
        ${row.requiresDetail}, ${row.createdAt}
      )
      on conflict do nothing
    `);
  }
}
