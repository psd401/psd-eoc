import { IdempotencyKeySchema } from '@psd-eoc/contracts';
import { desc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';

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

const PUBLISH_KEY_SUFFIX = '.publish';

/**
 * The publication's idempotency key, derived from the save's so a replayed
 * form replays the same publication and a new save publishes anew.
 *
 * A digest rather than a prefix, so two distinct save keys can never share a
 * publish key whatever their length or shape: the contract allows keys up to
 * two hundred characters, and a caller other than the form could supply two
 * that agree on a long prefix. Forty hex characters plus the suffix is well
 * inside the contract's bounds and charset; it is parsed through the schema
 * so any drift fails loudly rather than truncating.
 */
function publishKeyFor(saveKey: string): string {
  return IdempotencyKeySchema.parse(
    `${createHash('sha256').update(saveKey).digest('hex').slice(0, 40)}${PUBLISH_KEY_SUFFIX}`,
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

const UNTIL_PUBLISHED =
  'Nothing changes who is reached until a publish succeeds. Fix the cause and use "Publish the roster".';

/**
 * Runs a publication and turns every way it can not publish into the error
 * the administrator sees, prefixed with whatever is already true.
 *
 * Two things can go wrong and they surface differently. A sync that refuses
 * -- an empty building source, say -- returns a failed or partial-rejected
 * result rather than throwing, and the previous button handler redirected as
 * though it had succeeded. A sync that cannot run at all throws, with a
 * sanitized code when it is the sync's own refusal and none when it is
 * something underneath it. Either way the administrator gets the same shape
 * of message, never the generic page, and never anything unsanitized: the
 * outcome is a closed enum and the codes are validated at their source.
 */
async function publishOrExplain(
  saved: string,
  run: () => ReturnType<typeof publishRosterSnapshot>,
) {
  let result: Awaited<ReturnType<typeof publishRosterSnapshot>>;
  try {
    result = await run();
  } catch (error) {
    const code =
      error instanceof RosterSyncError ? error.code : 'PUBLISH_FAILED';
    throw new AdminFormError(
      `${saved}Publishing the roster failed (${code}). ${UNTIL_PUBLISHED}`,
    );
  }
  if (result.outcome === 'complete') return result;
  const codes = [
    ...new Set(result.groupFailures.map((failure) => failure.errorCode)),
  ].sort();
  throw new AdminFormError(
    `${saved}Publishing the roster was refused (${result.outcome}${
      codes.length > 0 ? `: ${codes.join(', ')}` : ''
    }). ${UNTIL_PUBLISHED}`,
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
 * changes who is reached until it does. That promise covers everything after
 * the save, including the lookup of which configuration to publish: a
 * transient database error there must not render the page that says nothing
 * was changed.
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
  let sourceConfiguration: Awaited<
    ReturnType<typeof currentStaffRosterConfiguration>
  >;
  try {
    sourceConfiguration = await currentStaffRosterConfiguration(database);
  } catch {
    throw new AdminFormError(
      `${saved}Publishing the roster failed before it could start (PUBLISH_FAILED). ${UNTIL_PUBLISHED}`,
    );
  }
  if (sourceConfiguration === null) {
    throw new AdminFormError(
      `${saved}The roster was not published because no building source is configured yet. Add one, then use "Publish the roster".`,
    );
  }
  const configuration = sourceConfiguration;
  return publishOrExplain(saved, () =>
    publishRosterSnapshot({
      authenticated: input.authenticated,
      sourceConfiguration: configuration,
      idempotencyKey: publishKeyFor(input.idempotencyKey),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      database,
    }),
  );
}

/** The button handler's publication, held to the same standard. */
export async function publishRosterSnapshotOrExplain(
  input: Parameters<typeof publishRosterSnapshot>[0],
) {
  return publishOrExplain('', () => publishRosterSnapshot(input));
}
