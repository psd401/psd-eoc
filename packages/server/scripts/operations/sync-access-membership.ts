import {
  invokeAuthorizedCapabilityHandler,
  IdempotencyKeySchema,
  SyncAccessMembershipResultSchema,
  UuidSchema,
  type SyncAccessMembershipResult,
} from '@psd-eoc/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { createDatabaseClient, readDatabaseConfig } from '../../db/client';
import {
  createDrizzleAccessMembershipSyncStore,
  createScheduledAccessMembershipSyncAuthorizer,
  createSyncAccessMembershipHandler,
  type AccessMembershipSyncCapabilityContext,
  type AccessMembershipSyncScope,
} from '../../lib/auth/access-membership-sync';
import { createGoogleAccessMembershipEvaluator } from '../../lib/auth/google-access-membership';
import { readGoogleCloudIdentityRosterConfiguration } from '../../lib/auth/google-roster-config';
import {
  describeFailure,
  invalidConfigurationFields,
  withReducedDriverErrors,
} from './failure-diagnostics';

const SourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const AccessMembershipSyncEnvironmentSchema = z
  .object({
    requestId: UuidSchema,
    idempotencyKey: IdempotencyKeySchema,
    sourceSha: SourceShaSchema,
  })
  .strict()
  .readonly();

/**
 * How often the schedule refreshes membership, and therefore how wide one
 * idempotency bucket is. EventBridge delivers at least once, so two runs of the
 * *same* occurrence must collapse into one publication while consecutive
 * occurrences must not.
 */
export const SCHEDULED_SYNC_INTERVAL_MS = 2 * 60 * 60 * 1_000;

const SCHEDULED_IDEMPOTENCY_PREFIX = 'access-sync:scheduled:';

/**
 * A key that is stable across a redelivered occurrence and distinct across
 * consecutive ones. Truncating the clock to the schedule interval is what gives
 * both properties without the scheduler having to template a value in.
 */
export function scheduledIdempotencyKey(now: Date): string {
  const bucket = new Date(
    Math.floor(now.getTime() / SCHEDULED_SYNC_INTERVAL_MS) *
      SCHEDULED_SYNC_INTERVAL_MS,
  );
  return IdempotencyKeySchema.parse(
    `${SCHEDULED_IDEMPOTENCY_PREFIX}${bucket.toISOString()}`,
  );
}

export const AccessMembershipSyncSummarySchema = z
  .object({
    event: z.literal('access-membership-sync-complete'),
    /** Which groups the run covered: sign-in groups, or roster groups. */
    scope: z.enum(['access', 'roster']),
    sourceSha: SourceShaSchema,
    snapshotId: UuidSchema,
    snapshotVersion: z.number().int().positive(),
    capturedAt: z.string().datetime({ offset: true }),
    activeAccessGroupCount: z.number().int().min(1).max(100),
    evaluatedMembershipCount: z.number().int().min(1).max(1_200),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    providerGroupIdDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    publication: z.enum(['created', 'already-current']),
  })
  .strict()
  .readonly();

export type AccessMembershipSyncSummary = z.infer<
  typeof AccessMembershipSyncSummarySchema
>;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads only nonsecret run identity; provider and database secrets stay owned by
 * their existing readers.
 *
 * The run identity is optional because the scheduler cannot invent one. An
 * operator invoking this by hand may still pin both values, and a caller that
 * supplies a malformed one is refused rather than quietly given a generated
 * substitute.
 */
export function readAccessMembershipSyncEnvironment(
  environment: Environment = process.env,
  now: () => Date = () => new Date(),
  newRequestId: () => string = randomUUID,
): z.infer<typeof AccessMembershipSyncEnvironmentSchema> {
  const parsed = AccessMembershipSyncEnvironmentSchema.safeParse({
    requestId: environment.ACCESS_SYNC_REQUEST_ID ?? newRequestId(),
    idempotencyKey:
      environment.ACCESS_SYNC_IDEMPOTENCY_KEY ?? scheduledIdempotencyKey(now()),
    sourceSha: environment.SOURCE_SHA,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid protected access-sync run identity: ${invalidConfigurationFields(
        parsed.error,
      ).join(', ')}.`,
    );
  }
  return parsed.data;
}

/** Converts a capability result to the only aggregate shape permitted in task logs. */
export function accessMembershipSyncSummary(
  sourceSha: string,
  resultValue: SyncAccessMembershipResult,
  scope: AccessMembershipSyncScope = 'access',
): AccessMembershipSyncSummary {
  const result = SyncAccessMembershipResultSchema.parse(resultValue);
  return AccessMembershipSyncSummarySchema.parse({
    event: 'access-membership-sync-complete',
    scope,
    sourceSha: SourceShaSchema.parse(sourceSha),
    snapshotId: result.snapshotId,
    snapshotVersion: result.snapshotVersion,
    capturedAt: result.capturedAt,
    activeAccessGroupCount: result.activeAccessGroupCount,
    evaluatedMembershipCount: result.evaluatedMembershipCount,
    membershipDigest: result.membershipDigest,
    providerGroupIdDigest: result.providerGroupIdDigest,
    publication: result.publication,
  });
}

async function runFromCommandLine(): Promise<void> {
  const run = readAccessMembershipSyncEnvironment();
  const connection = createDatabaseClient(readDatabaseConfig());
  if (connection.driver !== 'postgres') {
    throw new Error('Protected access sync requires native PostgreSQL.');
  }
  const context: AccessMembershipSyncCapabilityContext = Object.freeze({
    actor: Object.freeze({
      kind: 'system' as const,
      serviceId: 'access-membership-sync',
    }),
    source: 'scheduled-job',
    transport: 'scheduled-execution',
    schedulerAuthenticated: true,
    requestId: run.requestId,
    idempotencyKey: run.idempotencyKey,
  });
  const dependencies = {
    evaluator: createGoogleAccessMembershipEvaluator(
      readGoogleCloudIdentityRosterConfiguration(),
    ),
    store: createDrizzleAccessMembershipSyncStore(connection.db),
  };
  const invocation = {
    context,
    humanActionResolutionContext: null,
    safetyResolver: null,
    authorizer: createScheduledAccessMembershipSyncAuthorizer(),
  };
  try {
    // Sign-in groups first, on their own. This run is what keeps everyone's
    // membership fresh, and it fails the job as it always has.
    const result = await withReducedDriverErrors('access-membership sync', () =>
      invokeAuthorizedCapabilityHandler(
        createSyncAccessMembershipHandler(dependencies, 'access'),
        {},
        invocation,
      ),
    );
    console.info(
      JSON.stringify(accessMembershipSyncSummary(run.sourceSha, result)),
    );

    // Roster groups second, and separately. A building or district list with
    // one non-staff member, one nested group, or too many people must not
    // take down the run that refreshes sign-in, so its failure is reported
    // and the job still exits clean. Skipped when none is configured, which
    // is the ordinary state until a district list exists.
    const rosterGroups =
      await dependencies.store.readConfiguredAccessGroups('roster');
    if (rosterGroups.length > 0) {
      try {
        const rosterResult = await withReducedDriverErrors(
          'roster-membership sync',
          () =>
            invokeAuthorizedCapabilityHandler(
              createSyncAccessMembershipHandler(dependencies, 'roster'),
              {},
              invocation,
            ),
        );
        console.info(
          JSON.stringify(
            accessMembershipSyncSummary(run.sourceSha, rosterResult, 'roster'),
          ),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'roster-membership-sync-failed',
            scope: 'roster',
            sourceSha: run.sourceSha,
            failure: describeFailure('roster-membership sync', error),
          }),
        );
      }
    }
  } finally {
    await connection.close();
  }
}

export const ACCESS_SYNC_FAILURE_PREFIX =
  'Protected access-membership synchronization failed closed.';

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch (error) {
    console.error(describeFailure(ACCESS_SYNC_FAILURE_PREFIX, error));
    process.exitCode = 1;
  }
}
