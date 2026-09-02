import { IdempotencyKeySchema } from '@psd-eoc/contracts';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { rosterSourceConfigurations } from '../../../db/schema';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { getDefaultAdminDatabase } from '../../../lib/capabilities/admin';
import {
  RosterSyncError,
  createDrizzleRosterSyncStore,
  createStructuredRosterSyncAlertSink,
  syncRoster,
  type AdministratorRosterSyncContext,
} from '../../../lib/roster/groups-sync';
import { AdminFormError } from './admin-request';

type AdminDatabase = ReturnType<typeof getDefaultAdminDatabase>;

/** The ceiling `IdempotencyKeySchema` enforces; the derived key must fit it. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const PUBLISH_KEY_SUFFIX = '.publish';

/**
 * The publication's idempotency key, derived from the save's so a replayed
 * form replays the same publication. Parsed through the contract so a drift
 * between this ceiling and the schema fails loudly rather than truncating.
 */
function publishKeyFor(saveKey: string): string {
  return IdempotencyKeySchema.parse(
    `${saveKey.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH - PUBLISH_KEY_SUFFIX.length)}${PUBLISH_KEY_SUFFIX}`,
  );
}

/**
 * Names the exact roster source configuration a publication reads.
 *
 * Asking an administrator to copy an identifier out of the page would be a way
 * to get it wrong, so the current staff configuration is resolved here. Null
 * means no building source is configured yet.
 */
export async function currentStaffRosterConfiguration(
  database: AdminDatabase = getDefaultAdminDatabase(),
): Promise<Readonly<{
  id: string;
  version: number;
}> | null> {
  const [latest] = await database
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
    database?: AdminDatabase;
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
  const database = input.database ?? getDefaultAdminDatabase();
  return syncRoster(
    { sourceConfiguration: input.sourceConfiguration },
    context,
    {
      store: createDrizzleRosterSyncStore(database),
      alerts: createStructuredRosterSyncAlertSink(),
    },
  );
}

/**
 * Turns a publication that did not publish into the error the administrator
 * sees. A sync that refuses -- an empty building source, say -- returns a
 * failed or partial-rejected result rather than throwing, and the previous
 * button handler redirected as though it had succeeded.
 */
function assertPublished(
  result: Awaited<ReturnType<typeof publishRosterSnapshot>>,
  saved: string,
): void {
  if (result.outcome === 'complete') return;
  const codes = [
    ...new Set(result.groupFailures.map((failure) => failure.errorCode)),
  ].sort();
  throw new AdminFormError(
    `${saved}Publishing the roster was refused (${result.outcome}${
      codes.length > 0 ? `: ${codes.join(', ')}` : ''
    }). Nothing changes who is reached until a publish succeeds. Fix the cause and use "Publish the roster".`,
  );
}

/**
 * Publishes the roster because someone just changed who a manual source
 * reaches.
 *
 * A separate publish step is a step someone forgets, and a list that was
 * saved and never published reaches nobody while looking finished. Saving is
 * therefore the publish. The publish runs after the save has committed, in
 * its own transaction as every publication does, so a refused publication
 * leaves the saved list in place and says so: the administrator is told the
 * people were saved, why the roster did not publish, and that nothing
 * changes who is reached until it does.
 *
 * The publish's idempotency key is derived from the save's, so a replayed
 * form replays the same publication rather than minting a second one.
 */
export async function publishAfterManualMembersSave(
  input: Readonly<{
    authenticated: AuthenticatedSession;
    idempotencyKey: string;
    requestId?: string;
    database?: AdminDatabase;
  }>,
) {
  const saved = 'The people were saved. ';
  const database = input.database ?? getDefaultAdminDatabase();
  const sourceConfiguration = await currentStaffRosterConfiguration(database);
  if (sourceConfiguration === null) {
    throw new AdminFormError(
      `${saved}The roster was not published because no building source is configured yet. Add one, then use "Publish the roster".`,
    );
  }
  let result: Awaited<ReturnType<typeof publishRosterSnapshot>>;
  try {
    result = await publishRosterSnapshot({
      authenticated: input.authenticated,
      sourceConfiguration,
      idempotencyKey: publishKeyFor(input.idempotencyKey),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      database,
    });
  } catch (error) {
    const code =
      error instanceof RosterSyncError ? error.code : 'PUBLISH_FAILED';
    throw new AdminFormError(
      `${saved}Publishing the roster failed (${code}). Nothing changes who is reached until a publish succeeds. Fix the cause and use "Publish the roster".`,
    );
  }
  assertPublished(result, saved);
  return result;
}

/** The button handler's publication, held to the same standard. */
export async function publishRosterSnapshotOrExplain(
  input: Parameters<typeof publishRosterSnapshot>[0],
) {
  const result = await publishRosterSnapshot(input);
  assertPublished(result, '');
  return result;
}
