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
    activeAccessGroupCount: z.number().int().min(1).max(100),
    evaluatedMembershipCount: z.number().int().min(1).max(1_200),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    providerGroupIdDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    proofKind: z.enum(['initial-selector-match', 'durable-ios-session']),
    auditEntryHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
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
): z.infer<typeof AccessMembershipSyncEnvironmentSchema> {
  const parsed = AccessMembershipSyncEnvironmentSchema.safeParse({
    phase: environment.ACCESS_SYNC_PHASE,
    requestId: environment.ACCESS_SYNC_REQUEST_ID,
    idempotencyKey: environment.ACCESS_SYNC_IDEMPOTENCY_KEY,
    sourceSha: environment.SOURCE_SHA,
    initialMobileTransitionEmailDigest:
      environment.PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256,
    mobileSessionId: environment.ACCESS_SYNC_MOBILE_SESSION_ID,
    membershipSnapshotId: environment.ACCESS_SYNC_MEMBERSHIP_SNAPSHOT_ID,
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
  try {
    const result = await executeCapability(
      createSyncAccessMembershipHandler({
        evaluator: createGoogleAccessMembershipEvaluator(
          readGoogleCloudIdentityRosterConfiguration(),
        ),
        store: createDrizzleAccessMembershipSyncStore(connection.db),
      }),
      {},
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
  } catch (error) {
    // Emit the failure's identity. Codes and messages on this path are
    // authored, bounded strings; provider payloads, credentials, and member
    // identities never reach them. Discarding this made every failure look
    // identical and forced out-of-band reproduction to diagnose.
    const code = Reflect.get(Object(error), 'code');
    const message = Reflect.get(Object(error), 'message');
    console.error(
      'Protected access-membership synchronization failed closed.' +
        (typeof code === 'string' ? ` code=${code}` : '') +
        (typeof message === 'string'
          ? ` message=${message.slice(0, 300)}`
          : ''),
    );
    process.exitCode = 1;
  }
}
