import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { rosterSourceConfigurations } from '../../../db/schema';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { getDefaultAdminDatabase } from '../../../lib/capabilities/admin';
import {
  createDrizzleRosterSyncStore,
  createStructuredRosterSyncAlertSink,
  syncRoster,
  type AdministratorRosterSyncContext,
} from '../../../lib/roster/groups-sync';

/**
 * Names the exact roster source configuration a publication reads.
 *
 * Asking an administrator to copy an identifier out of the page would be a way
 * to get it wrong, so the current staff configuration is resolved here. Null
 * means no building source is configured yet.
 */
export async function currentStaffRosterConfiguration(): Promise<Readonly<{
  id: string;
  version: number;
}> | null> {
  const [latest] = await getDefaultAdminDatabase()
    .select({
      id: rosterSourceConfigurations.id,
      version: rosterSourceConfigurations.version,
    })
    .from(rosterSourceConfigurations)
    .where(eq(rosterSourceConfigurations.population, 'staff'))
    .orderBy(desc(rosterSourceConfigurations.version))
    .limit(1);
  return latest === undefined
    ? null
    : Object.freeze({ id: latest.id, version: latest.version });
}

/**
 * Publishes a roster snapshot because an administrator asked for one.
 *
 * A curated roster changes when a person edits it, so there is no provider
 * schedule that would notice. Without this, saving who a site notifies would
 * store a list that never reached an activation.
 *
 * This deliberately calls `syncRoster` directly rather than through the
 * capability engine. The publication opens its own transaction and sets an
 * isolation level, so it cannot nest inside an administration transaction, and
 * it carries its own reservation, idempotency, and append-only result record
 * naming the administrator who asked for it. Publishing notifies nobody; it
 * changes who a later activation would reach.
 */
export async function publishRosterSnapshot(
  input: Readonly<{
    authenticated: AuthenticatedSession;
    sourceConfiguration: Readonly<{ id: string; version: number }>;
    idempotencyKey: string;
    requestId?: string;
  }>,
) {
  const actor = input.authenticated.actor;
  if (actor.kind !== 'human') {
    throw new Error('A roster publication requires an administrator session.');
  }
  const context: AdministratorRosterSyncContext = Object.freeze({
    actor,
    source: 'administrator',
    transport: 'authenticated-session',
    requestId: input.requestId ?? randomUUID(),
    idempotencyKey: input.idempotencyKey,
  });
  const database = getDefaultAdminDatabase();
  return syncRoster(
    { sourceConfiguration: input.sourceConfiguration },
    context,
    {
      store: createDrizzleRosterSyncStore(database),
      alerts: createStructuredRosterSyncAlertSink(),
    },
  );
}
