import { IdempotencyKeySchema } from '@psd-eoc/contracts';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { RosterSyncResult } from '@psd-eoc/contracts';

import type { Database } from '../../db/client';
import { rosterSourceConfigurations } from '../../db/schema';
import {
  createDrizzleRosterSyncStore,
  createStructuredRosterSyncAlertSink,
  syncRoster,
  type ScheduledRosterSyncContext,
} from './groups-sync';

/** Matches the deployed membership schedule this publication rides on. */
const SCHEDULED_PUBLISH_INTERVAL_MS = 2 * 60 * 60 * 1_000;

const SCHEDULED_PUBLISH_PREFIX = 'roster-publish:scheduled:';

/**
 * Names the exact roster source configuration a publication reads.
 *
 * Lives here rather than beside the administration form because the scheduled
 * run needs the same answer and must not import an application route to get
 * it. Null means no building source is configured yet.
 */
export async function currentStaffRosterConfiguration(
  database: Database,
): Promise<Readonly<{ id: string; version: number }> | null> {
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
 * A key that is stable across a redelivered occurrence and distinct across
 * consecutive ones.
 *
 * Truncating the clock to the schedule interval gives both properties without
 * the scheduler templating a value in, exactly as the membership run does. A
 * constant key would be worse than no key: every run after the first would
 * replay the first run's result, answer success, and publish nothing, while
 * looking healthy indefinitely.
 */
export function scheduledRosterPublishIdempotencyKey(now: Date): string {
  const bucket = new Date(
    Math.floor(now.getTime() / SCHEDULED_PUBLISH_INTERVAL_MS) *
      SCHEDULED_PUBLISH_INTERVAL_MS,
  );
  return IdempotencyKeySchema.parse(
    `${SCHEDULED_PUBLISH_PREFIX}${bucket.toISOString()}`,
  );
}

/** What the scheduled run reports about a publication it attempted. */
export type ScheduledRosterPublishOutcome =
  | Readonly<{ kind: 'published'; snapshotId: string; completedAt: string }>
  | Readonly<{
      kind: 'refused';
      outcome: string;
      errorCodes: readonly string[];
    }>
  | Readonly<{ kind: 'skipped'; reason: 'no-source-configuration' }>;

/**
 * Publishes a roster snapshot because the scheduled membership run just
 * refreshed who the sources name.
 *
 * Google building and district membership is refreshed on a schedule into
 * `group_members`, but an activation reads a published snapshot, so until this
 * ran the refreshed membership reached nobody. Someone added to a Google group
 * stayed unreachable, on every channel, until a human happened to press
 * "Publish the roster" -- which is how staff came to be missing from an
 * activation more than once. Editing a manual source already publishes on
 * save; this closes the same gap for the sources a person never touches.
 *
 * A refusal is an outcome, not an exception. The completeness guards exist to
 * stop a bad read publishing a roster that reaches nobody, and they are
 * correct here too: the previous complete snapshot stays authoritative and the
 * caller reports why. The publication opens its own transaction and takes a
 * per-population advisory lock, so it must never be called from inside another
 * transaction; the scheduled run owns its connection and holds none.
 */
export async function publishScheduledRosterSnapshot(
  database: Database,
  options: Readonly<{ now?: Date; requestId?: string }> = {},
): Promise<ScheduledRosterPublishOutcome> {
  const configuration = await currentStaffRosterConfiguration(database);
  if (configuration === null) {
    return Object.freeze({
      kind: 'skipped' as const,
      reason: 'no-source-configuration' as const,
    });
  }
  const context: ScheduledRosterSyncContext = Object.freeze({
    actor: Object.freeze({
      kind: 'system' as const,
      serviceId: 'roster-sync-job' as const,
    }),
    source: 'scheduled-job' as const,
    transport: 'scheduled-execution' as const,
    schedulerAuthenticated: true as const,
    requestId: options.requestId ?? randomUUID(),
    idempotencyKey: scheduledRosterPublishIdempotencyKey(
      options.now ?? new Date(),
    ),
  });
  const result: RosterSyncResult = await syncRoster(
    { sourceConfiguration: configuration },
    context,
    {
      store: createDrizzleRosterSyncStore(database),
      alerts: createStructuredRosterSyncAlertSink(),
    },
  );
  if (result.outcome === 'complete' && result.publishedSnapshotId !== null) {
    return Object.freeze({
      kind: 'published' as const,
      snapshotId: result.publishedSnapshotId,
      completedAt: result.completedAt,
    });
  }
  return Object.freeze({
    kind: 'refused' as const,
    outcome: result.outcome,
    errorCodes: Object.freeze(
      [
        ...new Set(
          result.groupFailures.map(
            (failure: RosterSyncResult['groupFailures'][number]) =>
              failure.errorCode,
          ),
        ),
      ].sort(),
    ),
  });
}
