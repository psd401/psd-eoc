import { createHash, randomUUID } from 'node:crypto';

import {
  ActorSchema,
  IdempotencyKeySchema,
  registerCapabilityHandler,
  StaffRosterEmailSchema,
  SyncAccessMembershipInputSchema,
  SyncAccessMembershipResultSchema,
  TimestampSchema,
  UuidSchema,
  type Actor,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityId,
  type SyncAccessMembershipInput,
  type SyncAccessMembershipResult,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../../db/client';
import {
  accessMembershipEvaluatedMembers,
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  idempotencyRecords,
  users,
} from '../../db/schema';

import {
  type EvaluatedAccessMembershipSet,
  type GoogleAccessMembershipEvaluator,
} from './google-access-membership';
import {
  ADMIN_AVAILABILITY_LOCK_SQL,
  loadAccessConfigurationSnapshotState,
} from './role-state';

export const DAILY_ADMIN_EMAIL = 'hagelk@psd401.net' as const;

const DESIGNATED_ACCESS_GROUP_DISPLAY_NAME =
  'TSD Engineering administrators' as const;
const MAX_ACCESS_GROUPS = 100;
const MAX_EVALUATED_MEMBERS = 1_200;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const IDEMPOTENCY_IN_PROGRESS_MAX_AGE_MILLISECONDS = 15 * 60 * 1_000;
const ACCESS_SNAPSHOT_REFERENCE_PREFIX = 'access-membership-snapshot:';

const EvaluatedAccessMembershipSetSchema = z
  .object({
    groupEmail: z.literal('tsd-engineering@psd401.net'),
    googleGroupId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/u),
    memberEmails: z
      .array(StaffRosterEmailSchema)
      .min(1)
      .max(MAX_EVALUATED_MEMBERS)
      .readonly(),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    providerGroupIdDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    syncStartedAt: TimestampSchema,
    capturedAt: TimestampSchema,
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (
      new Set(evaluation.memberEmails).size !==
        evaluation.memberEmails.length ||
      evaluation.memberEmails.some(
        (email, index) =>
          index > 0 &&
          email.localeCompare(evaluation.memberEmails[index - 1] ?? '') <= 0,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluated access-member emails must be sorted and unique.',
        path: ['memberEmails'],
      });
    }
    if (
      Date.parse(evaluation.capturedAt) < Date.parse(evaluation.syncStartedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Access evaluation capture cannot precede its start.',
        path: ['capturedAt'],
      });
    }
  })
  .readonly();

export type AccessMembershipPublicationResult = SyncAccessMembershipResult;

export interface AccessMembershipSyncCapabilityContext {
  readonly actor: Actor;
  readonly source: 'scheduled-job';
  readonly transport: 'scheduled-execution';
  readonly schedulerAuthenticated: true;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface AccessMembershipSyncReservationRequest {
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly startedAt: string;
}

export type AccessMembershipSyncReservation =
  | Readonly<{ kind: 'reserved'; id: string }>
  | Readonly<{
      kind: 'replay';
      result: AccessMembershipPublicationResult;
    }>;

export interface AccessMembershipSyncStore {
  reserve(
    request: AccessMembershipSyncReservationRequest,
  ): Promise<AccessMembershipSyncReservation>;
  publish(
    reservationId: string,
    evaluation: EvaluatedAccessMembershipSet,
  ): Promise<AccessMembershipPublicationResult>;
  failReservation(
    reservationId: string,
    errorCode: string,
    completedAt: string,
  ): Promise<void>;
}

export interface AccessMembershipSyncDependencies {
  readonly evaluator: GoogleAccessMembershipEvaluator;
  readonly store: AccessMembershipSyncStore;
  readonly now?: () => Date;
}

/** Sanitized access-sync failure that never reflects an evaluated identity. */
export class AccessMembershipSyncError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'AccessMembershipSyncError';
    this.code = z
      .string()
      .regex(/^[A-Z0-9_]+$/u)
      .max(100)
      .parse(code);
  }
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function validateEvaluation(
  value: EvaluatedAccessMembershipSet,
): EvaluatedAccessMembershipSet {
  const parsed = EvaluatedAccessMembershipSetSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccessMembershipSyncError(
      'ACCESS_EVALUATION_INVALID',
      'The evaluated access-membership evidence was invalid.',
    );
  }
  const evaluation = parsed.data;
  if (
    evaluation.membershipDigest !==
      digest([
        evaluation.groupEmail,
        evaluation.googleGroupId,
        ...evaluation.memberEmails,
      ]) ||
    evaluation.providerGroupIdDigest !== digest([evaluation.googleGroupId])
  ) {
    throw new AccessMembershipSyncError(
      'ACCESS_EVALUATION_DIGEST_INVALID',
      'The evaluated access-membership digest was invalid.',
    );
  }
  if (!evaluation.memberEmails.includes(DAILY_ADMIN_EMAIL)) {
    throw new AccessMembershipSyncError(
      'DAILY_ADMIN_NOT_DIRECT_MEMBER',
      'The daily administrator is not a current direct member of the designated access group.',
    );
  }
  return evaluation;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AccessMembershipSyncError(
      'ACCESS_SYNC_CLOCK_INVALID',
      'The access-membership sync clock is invalid.',
    );
  }
  return TimestampSchema.parse(value.toISOString());
}

function validateContext(context: AccessMembershipSyncCapabilityContext): {
  readonly actor: Actor;
  readonly idempotencyKey: string;
} {
  const actor = ActorSchema.parse(context.actor);
  if (
    actor.kind !== 'system' ||
    actor.serviceId !== 'access-membership-sync' ||
    context.source !== 'scheduled-job' ||
    context.transport !== 'scheduled-execution' ||
    context.schedulerAuthenticated !== true
  ) {
    throw new AccessMembershipSyncError(
      'ACCESS_SYNC_UNAUTHORIZED',
      'The access-membership sync invocation is not authorized.',
    );
  }
  UuidSchema.parse(context.requestId);
  return {
    actor,
    idempotencyKey: IdempotencyKeySchema.parse(context.idempotencyKey),
  };
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof AccessMembershipSyncError &&
    /^[A-Z0-9_]{1,100}$/u.test(error.code)
  ) {
    return error.code;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,100}$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'ACCESS_SYNC_FAILED';
}

/**
 * Executes provider evaluation and atomic publication behind one system-only
 * capability boundary. The provider is read before the store takes the shared
 * administrator-availability lock; the store revalidates and publishes the
 * complete source/snapshot generation in one transaction.
 */
export async function syncAccessMembership(
  inputValue: SyncAccessMembershipInput,
  context: AccessMembershipSyncCapabilityContext,
  dependencies: AccessMembershipSyncDependencies,
): Promise<AccessMembershipPublicationResult> {
  const input = SyncAccessMembershipInputSchema.parse(inputValue);
  const invocation = validateContext(context);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = timestamp(now);
  const reservation = await dependencies.store.reserve({
    actor: invocation.actor,
    idempotencyKey: invocation.idempotencyKey,
    requestDigest: digest(input),
    startedAt,
  });
  if (reservation.kind === 'replay') {
    return SyncAccessMembershipResultSchema.parse({
      ...reservation.result,
      publication: 'already-current',
    });
  }

  try {
    const evaluated = await dependencies.evaluator.evaluate();
    if (evaluated.groupEmail !== input.designatedGroupEmail) {
      throw new AccessMembershipSyncError(
        'DESIGNATED_GROUP_MISMATCH',
        'The provider evaluation did not match the designated access group.',
      );
    }
    const evaluation = validateEvaluation(evaluated);
    return SyncAccessMembershipResultSchema.parse(
      await dependencies.store.publish(reservation.id, evaluation),
    );
  } catch (error) {
    await dependencies.store
      .failReservation(reservation.id, safeErrorCode(error), timestamp(now))
      .catch(() => undefined);
    throw error instanceof Error
      ? error
      : new AccessMembershipSyncError(
          'ACCESS_SYNC_FAILED',
          'Access-membership synchronization failed safely.',
        );
  }
}

/** Registers the exact access-membership publisher in the canonical catalog. */
export function createSyncAccessMembershipHandler(
  dependencies: AccessMembershipSyncDependencies,
): Readonly<
  RegisteredCapabilityHandler<
    'sync-access-membership',
    AccessMembershipSyncCapabilityContext
  >
> {
  return registerCapabilityHandler('sync-access-membership', (input, context) =>
    syncAccessMembership(input, context, dependencies),
  );
}

/** Deny-by-default authorizer for the protected scheduled execution surface. */
export function createScheduledAccessMembershipSyncAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<AccessMembershipSyncCapabilityContext>
> {
  return Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        AccessMembershipSyncCapabilityContext
      >,
    ): void {
      const context = request.context;
      if (
        request.definition.id !== 'sync-access-membership' ||
        context.actor.kind !== 'system' ||
        context.actor.serviceId !== 'access-membership-sync' ||
        context.source !== 'scheduled-job' ||
        context.transport !== 'scheduled-execution' ||
        context.schedulerAuthenticated !== true ||
        request.humanActionRequirement.actionIds.length !== 0
      ) {
        throw new AccessMembershipSyncError(
          'ACCESS_SYNC_UNAUTHORIZED',
          'The access-membership sync invocation is not authorized.',
        );
      }
      UuidSchema.parse(context.requestId);
      IdempotencyKeySchema.parse(context.idempotencyKey);
    },
  });
}

type AccessMembershipTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0];

function snapshotReference(snapshotId: string): string {
  return `${ACCESS_SNAPSHOT_REFERENCE_PREFIX}${UuidSchema.parse(snapshotId)}`;
}

function snapshotIdFromReference(reference: string | null): string {
  if (
    reference === null ||
    !reference.startsWith(ACCESS_SNAPSHOT_REFERENCE_PREFIX)
  ) {
    throw new AccessMembershipSyncError(
      'IDEMPOTENCY_RESULT_INVALID',
      'The access-sync idempotency result reference was invalid.',
    );
  }
  return UuidSchema.parse(
    reference.slice(ACCESS_SNAPSHOT_REFERENCE_PREFIX.length),
  );
}

function publicationResult(
  evaluation: EvaluatedAccessMembershipSet,
  snapshotId: string,
  snapshotVersion: number,
  designatedSourceId: string,
  activeAccessGroupCount: number,
): AccessMembershipPublicationResult {
  return SyncAccessMembershipResultSchema.parse({
    snapshotId,
    snapshotVersion,
    capturedAt: evaluation.capturedAt,
    designatedSourceId,
    activeAccessGroupCount,
    evaluatedMembershipCount: evaluation.memberEmails.length,
    membershipDigest: evaluation.membershipDigest,
    providerGroupIdDigest: evaluation.providerGroupIdDigest,
    publication: 'created',
  });
}

async function insertInBatches<Row>(
  rows: readonly Row[],
  insert: (batch: readonly Row[]) => Promise<unknown>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 500) {
    await insert(rows.slice(offset, offset + 500));
  }
}

/**
 * Production Drizzle store for one atomic source activation and immutable
 * access-snapshot publication. Provider I/O is complete before this adapter
 * acquires the shared administrator-availability lock.
 */
export function createDrizzleAccessMembershipSyncStore(
  database: Database,
): AccessMembershipSyncStore {
  async function loadReplay(
    snapshotId: string,
  ): Promise<AccessMembershipPublicationResult> {
    const accessState = await loadAccessConfigurationSnapshotState(database);
    if (accessState === null || accessState.snapshotId !== snapshotId) {
      throw new AccessMembershipSyncError(
        'IDEMPOTENCY_RESULT_SUPERSEDED',
        'The prior access-sync publication is no longer the current access generation.',
      );
    }
    const [snapshot] = await database
      .select({
        id: accessMembershipSnapshots.id,
        version: accessMembershipSnapshots.version,
        capturedAt: accessMembershipSnapshots.capturedAt,
      })
      .from(accessMembershipSnapshots)
      .where(eq(accessMembershipSnapshots.id, snapshotId))
      .limit(1);
    const sourceRows = await database
      .select({
        id: groupSources.id,
        kind: groupSources.kind,
        purpose: groupSources.purpose,
        facilityId: groupSources.facilityId,
        active: groupSources.active,
        googleGroupId: groupSources.googleGroupId,
        email: groupSources.email,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
          eq(
            sql<string>`lower(${groupSources.email})`,
            'tsd-engineering@psd401.net',
          ),
        ),
      )
      .orderBy(asc(groupSources.id));
    if (snapshot === undefined || sourceRows.length !== 1) {
      throw new AccessMembershipSyncError(
        'IDEMPOTENCY_RESULT_INVALID',
        'The prior access-sync publication could not be verified.',
      );
    }
    const source = sourceRows[0];
    if (
      source === undefined ||
      source.kind !== 'google-group' ||
      source.purpose !== 'access' ||
      source.facilityId !== null ||
      source.active !== true ||
      source.googleGroupId === null ||
      source.email?.toLowerCase() !== 'tsd-engineering@psd401.net' ||
      !accessState.activeAccessGroupSourceIds.includes(source.id)
    ) {
      throw new AccessMembershipSyncError(
        'IDEMPOTENCY_RESULT_INVALID',
        'The prior access-sync source identity could not be verified.',
      );
    }
    const memberRows = await database
      .select({ email: accessMembershipEvaluatedMembers.email })
      .from(accessMembershipEvaluatedMembers)
      .where(
        and(
          eq(accessMembershipEvaluatedMembers.snapshotId, snapshotId),
          eq(accessMembershipEvaluatedMembers.groupSourceId, source.id),
          eq(accessMembershipEvaluatedMembers.groupSourceKind, 'google-group'),
          eq(accessMembershipEvaluatedMembers.groupPurpose, 'access'),
        ),
      )
      .orderBy(asc(accessMembershipEvaluatedMembers.email));
    const memberEmails = memberRows.map(({ email }) =>
      StaffRosterEmailSchema.parse(email),
    );
    const evaluation = validateEvaluation({
      groupEmail: 'tsd-engineering@psd401.net',
      googleGroupId: source.googleGroupId,
      memberEmails,
      membershipDigest: digest([
        'tsd-engineering@psd401.net',
        source.googleGroupId,
        ...memberEmails,
      ]),
      providerGroupIdDigest: digest([source.googleGroupId]),
      syncStartedAt: snapshot.capturedAt.toISOString(),
      capturedAt: snapshot.capturedAt.toISOString(),
    });
    return publicationResult(
      evaluation,
      snapshot.id,
      snapshot.version,
      source.id,
      accessState.activeAccessGroupSourceIds.length,
    );
  }

  async function completeReservation(
    transaction: AccessMembershipTransaction,
    reservationId: string,
    snapshotId: string,
    completedAt: Date,
  ): Promise<void> {
    const rows = await transaction
      .update(idempotencyRecords)
      .set({
        status: 'completed',
        completedAt,
        resultReference: snapshotReference(snapshotId),
      })
      .where(
        and(
          eq(idempotencyRecords.id, reservationId),
          eq(idempotencyRecords.capabilityId, 'sync-access-membership'),
          eq(idempotencyRecords.status, 'in-progress'),
        ),
      )
      .returning();
    if (rows.length !== 1) {
      throw new AccessMembershipSyncError(
        'IDEMPOTENCY_RESERVATION_LOST',
        'The access-sync idempotency reservation was unavailable.',
      );
    }
  }

  return Object.freeze({
    async reserve(
      request: AccessMembershipSyncReservationRequest,
    ): Promise<AccessMembershipSyncReservation> {
      const key = IdempotencyKeySchema.parse(request.idempotencyKey);
      const principal = ActorSchema.parse(request.actor);
      if (
        principal.kind !== 'system' ||
        principal.serviceId !== 'access-membership-sync'
      ) {
        throw new AccessMembershipSyncError(
          'ACCESS_SYNC_UNAUTHORIZED',
          'The access-membership sync reservation is not authorized.',
        );
      }
      const requestDigest = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(request.requestDigest);
      const principalDigest = digest(principal);
      const startedAt = new Date(TimestampSchema.parse(request.startedAt));
      const [created] = await database
        .insert(idempotencyRecords)
        .values({
          key,
          capabilityId: 'sync-access-membership',
          principal,
          principalDigest,
          requestDigest,
          status: 'in-progress',
          createdAt: startedAt,
        })
        .onConflictDoNothing({
          target: [
            idempotencyRecords.capabilityId,
            idempotencyRecords.principalDigest,
            idempotencyRecords.key,
          ],
        })
        .returning();
      if (created !== undefined) {
        return Object.freeze({ kind: 'reserved' as const, id: created.id });
      }

      let [existing] = await database
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'sync-access-membership'),
            eq(idempotencyRecords.principalDigest, principalDigest),
            eq(idempotencyRecords.key, key),
          ),
        )
        .limit(1);
      if (existing === undefined || existing.requestDigest !== requestDigest) {
        throw new AccessMembershipSyncError(
          'IDEMPOTENCY_CONFLICT',
          'The access-sync idempotency key was reused for another request.',
        );
      }
      if (
        existing.status === 'in-progress' &&
        startedAt.getTime() - existing.createdAt.getTime() >=
          IDEMPOTENCY_IN_PROGRESS_MAX_AGE_MILLISECONDS
      ) {
        await database
          .update(idempotencyRecords)
          .set({
            status: 'failed',
            completedAt: startedAt,
            resultReference: 'error:ACCESS_SYNC_ABANDONED',
          })
          .where(
            and(
              eq(idempotencyRecords.id, existing.id),
              eq(idempotencyRecords.status, 'in-progress'),
            ),
          );
        [existing] = await database
          .select()
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.id, existing.id))
          .limit(1);
      }
      if (existing === undefined || existing.status === 'in-progress') {
        throw new AccessMembershipSyncError(
          'ACCESS_SYNC_IN_PROGRESS',
          'The access-membership sync is already in progress.',
        );
      }
      if (existing.status === 'failed') {
        throw new AccessMembershipSyncError(
          'ACCESS_SYNC_REPLAY_FAILED',
          'The prior access-membership sync failed safely.',
        );
      }
      return Object.freeze({
        kind: 'replay' as const,
        result: await loadReplay(
          snapshotIdFromReference(existing.resultReference),
        ),
      });
    },

    async publish(
      reservationIdValue: string,
      rawEvaluation: EvaluatedAccessMembershipSet,
    ): Promise<AccessMembershipPublicationResult> {
      const reservationId = UuidSchema.parse(reservationIdValue);
      const evaluation = validateEvaluation(rawEvaluation);
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`set transaction isolation level serializable`,
        );
        await transaction.execute(ADMIN_AVAILABILITY_LOCK_SQL);
        const [reservation] = await transaction
          .select({
            id: idempotencyRecords.id,
            status: idempotencyRecords.status,
          })
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.id, reservationId),
              eq(idempotencyRecords.capabilityId, 'sync-access-membership'),
            ),
          )
          .for('update')
          .limit(1);
        if (reservation?.status !== 'in-progress') {
          throw new AccessMembershipSyncError(
            'IDEMPOTENCY_RESERVATION_LOST',
            'The access-sync idempotency reservation was unavailable.',
          );
        }

        const baseline =
          await loadAccessConfigurationSnapshotState(transaction);
        if (baseline === null) {
          throw new AccessMembershipSyncError(
            'ACCESS_BASELINE_INVALID',
            'A strict complete access baseline is required before publication.',
          );
        }
        const [latestSnapshot] = await transaction
          .select({
            id: accessMembershipSnapshots.id,
            version: accessMembershipSnapshots.version,
          })
          .from(accessMembershipSnapshots)
          .orderBy(desc(accessMembershipSnapshots.version))
          .limit(1);
        if (
          latestSnapshot === undefined ||
          latestSnapshot.id !== baseline.snapshotId ||
          latestSnapshot.version !== baseline.snapshotVersion ||
          latestSnapshot.version >= MAX_POSTGRES_INTEGER
        ) {
          throw new AccessMembershipSyncError(
            'ACCESS_BASELINE_CHANGED',
            'The access baseline changed before publication.',
          );
        }

        const matchingSources = await transaction
          .select()
          .from(groupSources)
          .where(
            or(
              eq(groupSources.googleGroupId, evaluation.googleGroupId),
              eq(
                sql<string>`lower(${groupSources.email})`,
                evaluation.groupEmail,
              ),
            ),
          )
          .orderBy(asc(groupSources.id))
          .for('update');
        if (matchingSources.length > 1) {
          throw new AccessMembershipSyncError(
            'DESIGNATED_SOURCE_AMBIGUOUS',
            'The designated access source identity is ambiguous.',
          );
        }
        let designatedSource = matchingSources[0];
        if (designatedSource === undefined) {
          [designatedSource] = await transaction
            .insert(groupSources)
            .values({
              id: randomUUID(),
              kind: 'google-group',
              purpose: 'access',
              facilityId: null,
              displayName: DESIGNATED_ACCESS_GROUP_DISPLAY_NAME,
              active: true,
              googleGroupId: evaluation.googleGroupId,
              email: evaluation.groupEmail,
              fixtureKey: null,
              createdAt: new Date(evaluation.capturedAt),
            })
            .returning();
        }
        if (
          designatedSource === undefined ||
          designatedSource.kind !== 'google-group' ||
          designatedSource.purpose !== 'access' ||
          designatedSource.facilityId !== null ||
          designatedSource.active !== true ||
          designatedSource.googleGroupId !== evaluation.googleGroupId ||
          designatedSource.email?.toLowerCase() !== evaluation.groupEmail ||
          designatedSource.fixtureKey !== null
        ) {
          throw new AccessMembershipSyncError(
            'DESIGNATED_SOURCE_CONFLICT',
            'The designated access source conflicts with retained provider identity.',
          );
        }

        const activeSources = await transaction
          .select({
            id: groupSources.id,
            kind: groupSources.kind,
            purpose: groupSources.purpose,
            facilityId: groupSources.facilityId,
            active: groupSources.active,
            googleGroupId: groupSources.googleGroupId,
            email: groupSources.email,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.active, true),
              eq(groupSources.purpose, 'access'),
            ),
          )
          .orderBy(asc(groupSources.id));
        if (
          activeSources.length < 1 ||
          activeSources.length > MAX_ACCESS_GROUPS ||
          activeSources.some(
            (source) =>
              source.kind !== 'google-group' ||
              source.purpose !== 'access' ||
              source.facilityId !== null ||
              source.active !== true ||
              source.googleGroupId === null ||
              source.email === null,
          ) ||
          !activeSources.some(({ id }) => id === designatedSource?.id)
        ) {
          throw new AccessMembershipSyncError(
            'ACTIVE_ACCESS_SOURCES_INVALID',
            'The active access-source set was invalid.',
          );
        }
        const activeSourceIds = new Set(activeSources.map(({ id }) => id));

        const memberRows = await transaction
          .select({
            userId: accessMembershipMembers.userId,
            googleSubject: accessMembershipMembers.googleSubject,
            facilityScopeKind: accessMembershipMembers.facilityScopeKind,
            persistedGoogleSubject: users.googleSubject,
            email: users.email,
          })
          .from(accessMembershipMembers)
          .innerJoin(users, eq(accessMembershipMembers.userId, users.id))
          .where(eq(accessMembershipMembers.snapshotId, baseline.snapshotId))
          .orderBy(asc(accessMembershipMembers.userId));
        const memberGroupRows = await transaction
          .select({
            userId: accessMembershipMemberGroups.userId,
            groupSourceId: accessMembershipMemberGroups.groupSourceId,
            groupSourceKind: accessMembershipMemberGroups.groupSourceKind,
            groupPurpose: accessMembershipMemberGroups.groupPurpose,
          })
          .from(accessMembershipMemberGroups)
          .where(
            eq(accessMembershipMemberGroups.snapshotId, baseline.snapshotId),
          )
          .orderBy(
            asc(accessMembershipMemberGroups.userId),
            asc(accessMembershipMemberGroups.groupSourceId),
          );
        const memberFacilityRows = await transaction
          .select({
            userId: accessMembershipMemberFacilities.userId,
            facilityId: accessMembershipMemberFacilities.facilityId,
          })
          .from(accessMembershipMemberFacilities)
          .where(
            eq(
              accessMembershipMemberFacilities.snapshotId,
              baseline.snapshotId,
            ),
          )
          .orderBy(
            asc(accessMembershipMemberFacilities.userId),
            asc(accessMembershipMemberFacilities.facilityId),
          );
        const priorEvaluatedRows = await transaction
          .select({
            email: accessMembershipEvaluatedMembers.email,
            groupSourceId: accessMembershipEvaluatedMembers.groupSourceId,
            groupSourceKind: accessMembershipEvaluatedMembers.groupSourceKind,
            groupPurpose: accessMembershipEvaluatedMembers.groupPurpose,
          })
          .from(accessMembershipEvaluatedMembers)
          .where(
            eq(
              accessMembershipEvaluatedMembers.snapshotId,
              baseline.snapshotId,
            ),
          )
          .orderBy(
            asc(accessMembershipEvaluatedMembers.groupSourceId),
            asc(accessMembershipEvaluatedMembers.email),
          );

        const baselineGroupCounts = new Map<string, number>();
        for (const { userId } of memberGroupRows) {
          baselineGroupCounts.set(
            userId,
            (baselineGroupCounts.get(userId) ?? 0) + 1,
          );
        }
        const baselineFacilityCounts = new Map<string, number>();
        for (const { userId } of memberFacilityRows) {
          baselineFacilityCounts.set(
            userId,
            (baselineFacilityCounts.get(userId) ?? 0) + 1,
          );
        }

        if (
          memberRows.length > MAX_EVALUATED_MEMBERS ||
          memberRows.some(
            (member) =>
              member.googleSubject !== member.persistedGoogleSubject ||
              !StaffRosterEmailSchema.safeParse(member.email).success ||
              (baselineGroupCounts.get(member.userId) ?? 0) < 1 ||
              (baselineGroupCounts.get(member.userId) ?? 0) > 50 ||
              (member.facilityScopeKind === 'district'
                ? (baselineFacilityCounts.get(member.userId) ?? 0) !== 0
                : (baselineFacilityCounts.get(member.userId) ?? 0) < 1),
          ) ||
          memberGroupRows.some(
            (row) =>
              row.groupSourceKind !== 'google-group' ||
              row.groupPurpose !== 'access' ||
              !activeSourceIds.has(row.groupSourceId),
          ) ||
          priorEvaluatedRows.some(
            (row) =>
              row.groupSourceKind !== 'google-group' ||
              row.groupPurpose !== 'access' ||
              !activeSourceIds.has(row.groupSourceId) ||
              !StaffRosterEmailSchema.safeParse(row.email).success,
          )
        ) {
          throw new AccessMembershipSyncError(
            'ACCESS_BASELINE_GRAPH_INVALID',
            'The access baseline identity graph was invalid.',
          );
        }

        const currentEmailSet = new Set(evaluation.memberEmails);
        const userEmail = new Map(
          memberRows.map((member) => [
            member.userId,
            StaffRosterEmailSchema.parse(member.email),
          ]),
        );
        const retainedGroups = memberGroupRows.filter(
          (row) =>
            row.groupSourceId !== designatedSource.id ||
            currentEmailSet.has(userEmail.get(row.userId) ?? ''),
        );
        const retainedUserIds = new Set(
          retainedGroups.map(({ userId }) => userId),
        );
        const retainedMembers = memberRows.filter(({ userId }) =>
          retainedUserIds.has(userId),
        );
        if (
          memberGroupRows.some((row) => !userEmail.has(row.userId)) ||
          memberFacilityRows.some((row) => !userEmail.has(row.userId))
        ) {
          throw new AccessMembershipSyncError(
            'ACCESS_BASELINE_GRAPH_INVALID',
            'The access baseline contained orphaned identity evidence.',
          );
        }

        const snapshotId = randomUUID();
        const snapshotVersion = latestSnapshot.version + 1;
        await transaction.insert(accessMembershipSnapshots).values({
          id: snapshotId,
          version: snapshotVersion,
          complete: true,
          syncStartedAt: new Date(evaluation.syncStartedAt),
          capturedAt: new Date(evaluation.capturedAt),
        });
        await transaction.insert(accessMembershipSnapshotGroups).values(
          activeSources.flatMap((source) => [
            {
              snapshotId,
              groupSourceId: source.id,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
              completionKind: 'expected' as const,
            },
            {
              snapshotId,
              groupSourceId: source.id,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
              completionKind: 'completed' as const,
            },
          ]),
        );
        await insertInBatches(retainedMembers, async (batch) =>
          transaction.insert(accessMembershipMembers).values(
            batch.map((member) => ({
              snapshotId,
              userId: member.userId,
              googleSubject: member.googleSubject,
              facilityScopeKind: member.facilityScopeKind,
            })),
          ),
        );
        await insertInBatches(retainedGroups, async (batch) =>
          transaction.insert(accessMembershipMemberGroups).values(
            batch.map((row) => ({
              snapshotId,
              userId: row.userId,
              groupSourceId: row.groupSourceId,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
            })),
          ),
        );
        await insertInBatches(
          memberFacilityRows.filter(({ userId }) =>
            retainedUserIds.has(userId),
          ),
          async (batch) =>
            transaction.insert(accessMembershipMemberFacilities).values(
              batch.map((row) => ({
                snapshotId,
                userId: row.userId,
                facilityId: row.facilityId,
              })),
            ),
        );
        const evaluatedRows = [
          ...priorEvaluatedRows
            .filter((row) => row.groupSourceId !== designatedSource.id)
            .map((row) => ({
              snapshotId,
              email: StaffRosterEmailSchema.parse(row.email),
              groupSourceId: row.groupSourceId,
              groupSourceKind: 'google-group' as const,
              groupPurpose: 'access' as const,
            })),
          ...evaluation.memberEmails.map((email) => ({
            snapshotId,
            email,
            groupSourceId: designatedSource.id,
            groupSourceKind: 'google-group' as const,
            groupPurpose: 'access' as const,
          })),
        ];
        const evaluatedSourceCounts = new Map<string, number>();
        for (const row of evaluatedRows) {
          evaluatedSourceCounts.set(
            row.email,
            (evaluatedSourceCounts.get(row.email) ?? 0) + 1,
          );
        }
        if (
          evaluatedSourceCounts.size > MAX_EVALUATED_MEMBERS ||
          [...evaluatedSourceCounts.values()].some(
            (sourceCount) => sourceCount < 1 || sourceCount > 50,
          )
        ) {
          throw new AccessMembershipSyncError(
            'ACCESS_PUBLICATION_GRAPH_LIMIT_EXCEEDED',
            'The resulting access publication exceeded its bounded identity graph.',
          );
        }
        await insertInBatches(evaluatedRows, async (batch) =>
          transaction
            .insert(accessMembershipEvaluatedMembers)
            .values([...batch]),
        );

        const readbackState =
          await loadAccessConfigurationSnapshotState(transaction);
        const readbackRows = await transaction
          .select({ email: accessMembershipEvaluatedMembers.email })
          .from(accessMembershipEvaluatedMembers)
          .where(
            and(
              eq(accessMembershipEvaluatedMembers.snapshotId, snapshotId),
              eq(
                accessMembershipEvaluatedMembers.groupSourceId,
                designatedSource.id,
              ),
            ),
          )
          .orderBy(asc(accessMembershipEvaluatedMembers.email));
        if (
          readbackState?.snapshotId !== snapshotId ||
          readbackState.snapshotVersion !== snapshotVersion ||
          readbackState.activeAccessGroupSourceIds.length !==
            activeSources.length ||
          readbackRows.length !== evaluation.memberEmails.length ||
          readbackRows.some(
            ({ email }, index) => email !== evaluation.memberEmails[index],
          )
        ) {
          throw new AccessMembershipSyncError(
            'ACCESS_PUBLICATION_READBACK_FAILED',
            'The access publication did not pass its transactional readback.',
          );
        }
        await completeReservation(
          transaction,
          reservationId,
          snapshotId,
          new Date(evaluation.capturedAt),
        );
        return publicationResult(
          evaluation,
          snapshotId,
          snapshotVersion,
          designatedSource.id,
          activeSources.length,
        );
      });
    },

    async failReservation(
      reservationIdValue: string,
      errorCodeValue: string,
      completedAtValue: string,
    ): Promise<void> {
      const reservationId = UuidSchema.parse(reservationIdValue);
      const errorCode = z
        .string()
        .regex(/^[A-Z0-9_]{1,100}$/u)
        .parse(errorCodeValue);
      const completedAt = new Date(TimestampSchema.parse(completedAtValue));
      await database
        .update(idempotencyRecords)
        .set({
          status: 'failed',
          completedAt,
          resultReference: `error:${errorCode}`,
        })
        .where(
          and(
            eq(idempotencyRecords.id, reservationId),
            eq(idempotencyRecords.capabilityId, 'sync-access-membership'),
            eq(idempotencyRecords.status, 'in-progress'),
          ),
        );
    },
  });
}
