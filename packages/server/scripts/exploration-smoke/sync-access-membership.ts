import {
  executeCapability,
  IdempotencyKeySchema,
  SyncAccessMembershipResultSchema,
  UuidSchema,
  type SyncAccessMembershipResult,
} from '@psd-eoc/contracts';
import { z } from 'zod';

import { createDatabaseClient, readDatabaseConfig } from '../../db/client';
import {
  createDrizzleAccessMembershipSyncStore,
  createScheduledAccessMembershipSyncAuthorizer,
  createSyncAccessMembershipHandler,
  type AccessMembershipSyncCapabilityContext,
} from '../../lib/auth/access-membership-sync';
import { createGoogleAccessMembershipEvaluator } from '../../lib/auth/google-access-membership';
import { readGoogleCloudIdentityRosterConfiguration } from '../../lib/roster/groups-sync';

const SourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const AccessMembershipSyncEnvironmentSchema = z
  .object({
    requestId: UuidSchema,
    idempotencyKey: IdempotencyKeySchema,
    sourceSha: SourceShaSchema,
  })
  .strict()
  .readonly();

export const AccessMembershipSyncSummarySchema = z
  .object({
    event: z.literal('access-membership-sync-complete'),
    sourceSha: SourceShaSchema,
    snapshotId: UuidSchema,
    snapshotVersion: z.number().int().positive(),
    capturedAt: z.string().datetime({ offset: true }),
    designatedSourceId: UuidSchema,
    activeAccessGroupCount: z.number().int().min(1).max(100),
    evaluatedMembershipCount: z.number().int().min(1).max(1_200),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    providerGroupIdDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    initialTransitionCandidateDirectMember: z.literal(true),
    publication: z.enum(['created', 'already-current']),
  })
  .strict()
  .readonly();

export type AccessMembershipSyncSummary = z.infer<
  typeof AccessMembershipSyncSummarySchema
>;

type Environment = Readonly<Record<string, string | undefined>>;

/** Reads only nonsecret run identity; provider and database secrets stay owned by their existing readers. */
export function readAccessMembershipSyncEnvironment(
  environment: Environment = process.env,
): Readonly<{
  requestId: string;
  idempotencyKey: string;
  sourceSha: string;
}> {
  const parsed = AccessMembershipSyncEnvironmentSchema.safeParse({
    requestId: environment.ACCESS_SYNC_REQUEST_ID,
    idempotencyKey: environment.ACCESS_SYNC_IDEMPOTENCY_KEY,
    sourceSha: environment.SOURCE_SHA,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid protected access-sync run identity: ${[
        ...new Set(parsed.error.issues.map((issue) => issue.path[0])),
      ]
        .filter((field): field is string => typeof field === 'string')
        .sort()
        .join(', ')}.`,
    );
  }
  return parsed.data;
}

/** Converts a capability result to the only aggregate shape permitted in task logs. */
export function accessMembershipSyncSummary(
  sourceSha: string,
  resultValue: SyncAccessMembershipResult,
): AccessMembershipSyncSummary {
  const result = SyncAccessMembershipResultSchema.parse(resultValue);
  return AccessMembershipSyncSummarySchema.parse({
    event: 'access-membership-sync-complete',
    sourceSha: SourceShaSchema.parse(sourceSha),
    snapshotId: result.snapshotId,
    snapshotVersion: result.snapshotVersion,
    capturedAt: result.capturedAt,
    designatedSourceId: result.designatedSourceId,
    activeAccessGroupCount: result.activeAccessGroupCount,
    evaluatedMembershipCount: result.evaluatedMembershipCount,
    membershipDigest: result.membershipDigest,
    providerGroupIdDigest: result.providerGroupIdDigest,
    initialTransitionCandidateDirectMember: true,
    publication: result.publication,
  });
}

async function runFromCommandLine(): Promise<void> {
  const run = readAccessMembershipSyncEnvironment();
  const google = readGoogleCloudIdentityRosterConfiguration();
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
  try {
    const result = await executeCapability(
      createSyncAccessMembershipHandler({
        evaluator: createGoogleAccessMembershipEvaluator(google),
        store: createDrizzleAccessMembershipSyncStore(connection.db),
      }),
      { designatedGroupEmail: 'tsd-engineering@psd401.net' },
      {
        context,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: createScheduledAccessMembershipSyncAuthorizer(),
      },
    );
    console.info(
      JSON.stringify(accessMembershipSyncSummary(run.sourceSha, result)),
    );
  } finally {
    await connection.close();
  }
}

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch {
    console.error('Protected access-membership synchronization failed closed.');
    process.exitCode = 1;
  }
}
