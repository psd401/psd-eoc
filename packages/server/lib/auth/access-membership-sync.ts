import { createHash, randomUUID } from 'node:crypto';

import {
  ActorSchema,
  IdempotencyKeySchema,
  RoleSchema,
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
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { staffRosterEmail } from '../config/staff-email';
import type { Database } from '../../db/client';
import {
  groupMembers,
  accessMembershipSnapshots,
  groupSources,
  idempotencyRecords,
} from '../../db/schema';

import {
  DesignatedAccessGroupSchema,
  type DesignatedAccessGroup,
  type EvaluatedAccessMembershipSet,
  type GoogleAccessMembershipEvaluator,
} from './google-access-membership';
import { ADMIN_AVAILABILITY_LOCK_SQL } from './role-state';

const MAX_EVALUATED_MEMBERS = 1_200;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const IDEMPOTENCY_IN_PROGRESS_MAX_AGE_MILLISECONDS = 15 * 60 * 1_000;
const ACCESS_SNAPSHOT_REFERENCE_PREFIX = 'access-membership-snapshot:';
const FINALIZATION_AUDIT_REFERENCE_SEPARATOR = ':audit:';
const InitialMobileTransitionEmailDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u);

const EvaluatedAccessGroupSchema = z
  .object({
    groupSourceId: z.string().uuid(),
    groupEmail: StaffRosterEmailSchema,
    // Null only for a waiting building group Google does not hold yet; the
    // publish step refuses null for a group whose ID is already recorded.
    googleGroupId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .nullable(),
    // Null for a building group: it says who is at a school, not what they
    // may do. `group_sources_access_role_present` is the authority on which
    // purposes may carry a role.
    grantedRole: RoleSchema.nullable(),
    memberEmails: z
      .array(StaffRosterEmailSchema)
      .max(MAX_EVALUATED_MEMBERS)
      .readonly(),
  })
  .strict()
  .readonly();

const EvaluatedAccessMembershipSetSchema = z
  .object({
    groups: z.array(EvaluatedAccessGroupSchema).min(1).max(100).readonly(),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    providerGroupIdDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    syncStartedAt: TimestampSchema,
    capturedAt: TimestampSchema,
  })
  .strict()
  .superRefine((evaluation, context) => {
    for (const [index, group] of evaluation.groups.entries()) {
      const emails = group.memberEmails;
      if (
        new Set(emails).size !== emails.length ||
        emails.some(
          (email, position) =>
            position > 0 &&
            email.localeCompare(emails[position - 1] ?? '') <= 0,
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Evaluated access-member emails must be sorted and unique.',
          path: ['groups', index, 'memberEmails'],
        });
      }
    }
    const sourceIds = evaluation.groups.map(
      ({ groupSourceId }) => groupSourceId,
    );
    if (
      new Set(sourceIds).size !== sourceIds.length ||
      sourceIds.some(
        (id, index) =>
          index > 0 && id.localeCompare(sourceIds[index - 1] ?? '') <= 0,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluated access groups must be distinct and ordered by id.',
        path: ['groups'],
      });
    }
    const distinct = new Set(
      evaluation.groups.flatMap(({ memberEmails }) => [...memberEmails]),
    );
    // Nobody at all is refused, so an empty sign-in evaluation can never
    // lock the deployment out. A roster whose only Google groups are still
    // waiting for Google is empty for a reason, and is allowed.
    const waiting = evaluation.groups.some(
      ({ googleGroupId }) => googleGroupId === null,
    );
    if (
      (distinct.size === 0 && !waiting) ||
      distinct.size > MAX_EVALUATED_MEMBERS
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The configured access groups have no members, or too many.',
        path: ['groups'],
      });
    }
    if (
      Date.parse(evaluation.capturedAt) < Date.parse(evaluation.syncStartedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluation capture must not precede its start.',
        path: ['capturedAt'],
      });
    }
  });

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
  /** Which groups this run covers; a replay reconstructs the same scope. */
  readonly scope?: AccessMembershipSyncScope;
}

export type AccessMembershipSyncReservation =
  | Readonly<{ kind: 'reserved'; id: string }>
  | Readonly<{
      kind: 'replay';
      result: AccessMembershipPublicationResult;
    }>;

/**
 * Which groups one sync run reads and publishes.
 *
 * `access` is the groups that gate sign-in. `roster` is the building and
 * others groups whose membership feeds notification audiences. They are run
 * separately because a failure must stay where it belongs: a district-wide
 * roster group with one non-staff member, one nested group, or too many
 * people would otherwise abort the run that refreshes access membership, and
 * after a day of that everyone is refused at sign-in for a group that has
 * nothing to do with who may sign in.
 */
export type AccessMembershipSyncScope = 'access' | 'roster';

/** The group purposes a scope covers. */
export function scopePurposes(
  scope: AccessMembershipSyncScope,
): readonly ('access' | 'building' | 'others')[] {
  return scope === 'access' ? ['access'] : ['building', 'others'];
}

/**
 * One idempotency key per scope, derived from the run's, so the two runs of
 * one scheduled tick reserve and replay independently.
 */
export function scopedIdempotencyKey(
  idempotencyKey: string,
  scope: AccessMembershipSyncScope,
): string {
  return scope === 'access' ? idempotencyKey : `${idempotencyKey}:roster`;
}

export interface AccessMembershipSyncStore {
  reserve(
    request: AccessMembershipSyncReservationRequest,
  ): Promise<AccessMembershipSyncReservation>;
  /** The active Google sources a deployment has configured for one scope. */
  readConfiguredAccessGroups(
    scope?: AccessMembershipSyncScope,
  ): Promise<readonly DesignatedAccessGroup[]>;
  publish(
    reservationId: string,
    evaluation: EvaluatedAccessMembershipSet,
    scope?: AccessMembershipSyncScope,
  ): Promise<AccessMembershipPublicationResult>;
  failReservation(
    reservationId: string,
    errorCode: string,
    completedAt: string,
  ): Promise<void>;
}

export interface AccessMembershipSyncDependencies {
  readonly evaluator?: GoogleAccessMembershipEvaluator;
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

/** Parses the protected selector without retaining or reflecting its value. */
/**
 * Re-derives both digests from the evidence rather than trusting them.
 *
 * The evaluator computes them and this module publishes on their basis, so it
 * recomputes both and refuses evidence whose digest does not describe the
 * membership it arrived with.
 */
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
      digest(
        evaluation.groups.flatMap((group) => [
          group.groupSourceId,
          group.groupEmail,
          group.googleGroupId,
          group.grantedRole,
          ...group.memberEmails,
        ]),
      ) ||
    evaluation.providerGroupIdDigest !==
      digest(evaluation.groups.map(({ googleGroupId }) => googleGroupId))
  ) {
    throw new AccessMembershipSyncError(
      'ACCESS_EVALUATION_DIGEST_INVALID',
      'The evaluated access-membership digest was invalid.',
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
  scope: AccessMembershipSyncScope = 'access',
): Promise<AccessMembershipPublicationResult> {
  const input = SyncAccessMembershipInputSchema.parse(inputValue);
  const invocation = validateContext(context);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = timestamp(now);
  const reservation = await dependencies.store.reserve({
    actor: invocation.actor,
    idempotencyKey: scopedIdempotencyKey(invocation.idempotencyKey, scope),
    // The scope lives in the key, so the digest stays what earlier runs
    // recorded and a redelivery that straddles a deploy still replays.
    requestDigest: digest(input),
    startedAt,
    scope,
  });
  if (reservation.kind === 'replay') {
    return SyncAccessMembershipResultSchema.parse({
      ...reservation.result,
      publication: 'already-current',
    });
  }

  try {
    if (dependencies.evaluator === undefined) {
      throw new AccessMembershipSyncError(
        'ACCESS_EVALUATOR_UNAVAILABLE',
        'The protected provider evaluator is unavailable.',
      );
    }
    // The groups to evaluate come from the database, never from the command.
    // A caller cannot ask for a group the deployment has not activated.
    const configured =
      await dependencies.store.readConfiguredAccessGroups(scope);
    if (configured.length === 0) {
      throw new AccessMembershipSyncError(
        'NO_CONFIGURED_ACCESS_GROUPS',
        'No active Google group is configured for this scope, so there is nothing to read.',
      );
    }
    // A roster scope whose groups are all empty fails here too, on its own
    // run: that is a site still being set up, and the failure is reported
    // without touching the run that refreshes sign-in.
    const evaluation = validateEvaluation(
      await dependencies.evaluator.evaluate(configured),
    );
    // The evaluation must describe exactly the set that was asked for. A
    // provider result covering a different set would publish a baseline that
    // does not match the active configuration, which denies everyone.
    const requested = configured
      .map(({ groupSourceId }) => groupSourceId)
      .sort();
    const returned = evaluation.groups.map(
      ({ groupSourceId }) => groupSourceId,
    );
    if (
      requested.length !== returned.length ||
      requested.some((id, index) => id !== returned[index])
    ) {
      throw new AccessMembershipSyncError(
        'ACCESS_EVALUATION_SET_MISMATCH',
        'The provider evaluation did not cover the groups this run was asked to read.',
      );
    }
    return SyncAccessMembershipResultSchema.parse(
      await dependencies.store.publish(reservation.id, evaluation, scope),
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
  scope: AccessMembershipSyncScope = 'access',
): Readonly<
  RegisteredCapabilityHandler<
    'sync-access-membership',
    AccessMembershipSyncCapabilityContext
  >
> {
  return registerCapabilityHandler('sync-access-membership', (input, context) =>
    syncAccessMembership(input, context, dependencies, scope),
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

function snapshotReference(
  snapshotId: string,
  auditEntryHash: string | null,
): string {
  const base = `${ACCESS_SNAPSHOT_REFERENCE_PREFIX}${UuidSchema.parse(snapshotId)}`;
  return auditEntryHash === null
    ? base
    : `${base}${FINALIZATION_AUDIT_REFERENCE_SEPARATOR}${InitialMobileTransitionEmailDigestSchema.parse(auditEntryHash)}`;
}

function proofFromReference(reference: string | null): Readonly<{
  snapshotId: string;
  auditEntryHash: string | null;
}> {
  if (
    reference === null ||
    !reference.startsWith(ACCESS_SNAPSHOT_REFERENCE_PREFIX)
  ) {
    throw new AccessMembershipSyncError(
      'IDEMPOTENCY_RESULT_INVALID',
      'The access-sync idempotency result reference was invalid.',
    );
  }
  const value = reference.slice(ACCESS_SNAPSHOT_REFERENCE_PREFIX.length);
  const separatorIndex = value.indexOf(FINALIZATION_AUDIT_REFERENCE_SEPARATOR);
  if (separatorIndex < 0) {
    return Object.freeze({
      snapshotId: UuidSchema.parse(value),
      auditEntryHash: null,
    });
  }
  if (
    value.indexOf(
      FINALIZATION_AUDIT_REFERENCE_SEPARATOR,
      separatorIndex + FINALIZATION_AUDIT_REFERENCE_SEPARATOR.length,
    ) >= 0
  ) {
    throw new AccessMembershipSyncError(
      'IDEMPOTENCY_RESULT_INVALID',
      'The access-sync idempotency result reference was invalid.',
    );
  }
  return Object.freeze({
    snapshotId: UuidSchema.parse(value.slice(0, separatorIndex)),
    auditEntryHash: InitialMobileTransitionEmailDigestSchema.parse(
      value.slice(
        separatorIndex + FINALIZATION_AUDIT_REFERENCE_SEPARATOR.length,
      ),
    ),
  });
}

function publicationResult(
  evaluation: EvaluatedAccessMembershipSet,
  snapshotId: string,
  snapshotVersion: number,
  activeAccessGroupCount: number,
  publication: 'created' | 'already-current' = 'created',
): AccessMembershipPublicationResult {
  return SyncAccessMembershipResultSchema.parse({
    snapshotId,
    snapshotVersion,
    capturedAt: evaluation.capturedAt,
    activeAccessGroupCount,
    // Distinct people, not rows: someone in two configured groups is one
    // person with access, and reporting them twice would misdescribe reach.
    evaluatedMembershipCount: new Set(
      evaluation.groups.flatMap(({ memberEmails }) => [...memberEmails]),
    ).size,
    membershipDigest: evaluation.membershipDigest,
    providerGroupIdDigest: evaluation.providerGroupIdDigest,
    publication,
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
  /**
   * Rebuilds the result of a publication that already happened.
   *
   * A replayed idempotency key must return what the first call returned, so
   * this reads the snapshot back and re-derives the same aggregate. It refuses
   * if that snapshot is no longer the newest run of its own scope, because
   * reporting a superseded publication as current would tell the caller the
   * configuration is live when something else replaced it. The sign-in run and
   * the roster run of one scheduled tick share the version sequence, so the
   * check is per scope: a roster run never supersedes a sign-in run.
   */
  async function loadReplay(
    proof: Readonly<{
      snapshotId: string;
      auditEntryHash: string | null;
    }>,
    scope: AccessMembershipSyncScope,
  ): Promise<AccessMembershipPublicationResult> {
    const [latestRun] = await database
      .select({ id: accessMembershipSnapshots.id })
      .from(accessMembershipSnapshots)
      .where(
        and(
          eq(accessMembershipSnapshots.complete, true),
          eq(accessMembershipSnapshots.scope, scope),
        ),
      )
      .orderBy(desc(accessMembershipSnapshots.version))
      .limit(1);
    if (latestRun === undefined || latestRun.id !== proof.snapshotId) {
      throw new AccessMembershipSyncError(
        'IDEMPOTENCY_RESULT_SUPERSEDED',
        'A later run of the same scope replaced the one this result described.',
      );
    }
    const [snapshot] = await database
      .select({
        id: accessMembershipSnapshots.id,
        version: accessMembershipSnapshots.version,
        capturedAt: accessMembershipSnapshots.capturedAt,
      })
      .from(accessMembershipSnapshots)
      .where(eq(accessMembershipSnapshots.id, proof.snapshotId))
      .limit(1);
    if (snapshot === undefined) {
      throw new AccessMembershipSyncError(
        'IDEMPOTENCY_RESULT_INVALID',
        'The prior access-sync publication could not be read back.',
      );
    }
    const sourceRows = await database
      .select({
        id: groupSources.id,
        email: groupSources.email,
        grantedRole: groupSources.grantedRole,
        googleGroupId: groupSources.googleGroupId,
      })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.kind, 'google-group'),
          // The same scope the run read, so a replay describes the set the
          // first call actually published rather than only the access groups.
          inArray(groupSources.purpose, scopePurposes(scope)),
          eq(groupSources.active, true),
        ),
      )
      .orderBy(asc(groupSources.id));
    // Reconstructed from the membership the run actually wrote, which is the
    // membership that is live. The evaluated-member rows this used to read were
    // a second copy of the same emails, kept only so a snapshot generation
    // could be replayed against itself.
    const memberRows = await database
      .select({
        email: groupMembers.email,
        groupSourceId: groupMembers.groupSourceId,
      })
      .from(groupMembers)
      .where(
        inArray(
          groupMembers.groupSourceId,
          sourceRows.map(({ id }) => id),
        ),
      )
      .orderBy(asc(groupMembers.email));

    const groups = sourceRows.map((source) => ({
      groupSourceId: source.id,
      groupEmail: source.email?.toLowerCase() ?? '',
      googleGroupId: source.googleGroupId ?? '',
      grantedRole: source.grantedRole,
      memberEmails: Object.freeze(
        memberRows
          .filter(({ groupSourceId }) => groupSourceId === source.id)
          .map(({ email }) => staffRosterEmail().parse(email))
          .sort(),
      ),
    }));
    const capturedAt = snapshot.capturedAt.toISOString();
    const evaluation = validateEvaluation({
      groups: Object.freeze(groups),
      membershipDigest: digest(
        groups.flatMap((group) => [
          group.groupSourceId,
          group.groupEmail,
          group.googleGroupId,
          group.grantedRole,
          ...group.memberEmails,
        ]),
      ),
      providerGroupIdDigest: digest(
        groups.map(({ googleGroupId }) => googleGroupId),
      ),
      syncStartedAt: capturedAt,
      capturedAt,
    } as EvaluatedAccessMembershipSet);
    return publicationResult(
      evaluation,
      snapshot.id,
      snapshot.version,
      sourceRows.length,
    );
  }

  async function completeReservation(
    transaction: AccessMembershipTransaction,
    reservationId: string,
    snapshotId: string,
    auditEntryHash: string | null,
    completedAt: Date,
  ): Promise<void> {
    const rows = await transaction
      .update(idempotencyRecords)
      .set({
        status: 'completed',
        completedAt,
        resultReference: snapshotReference(snapshotId, auditEntryHash),
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
          proofFromReference(existing.resultReference),
          request.scope ?? 'access',
        ),
      });
    },

    async readConfiguredAccessGroups(
      scope: AccessMembershipSyncScope = 'access',
    ): Promise<readonly DesignatedAccessGroup[]> {
      const rows = await database
        .select({
          groupSourceId: groupSources.id,
          email: groupSources.email,
          grantedRole: groupSources.grantedRole,
          purpose: groupSources.purpose,
          googleGroupId: groupSources.googleGroupId,
        })
        .from(groupSources)
        .where(
          and(
            inArray(groupSources.purpose, scopePurposes(scope)),
            eq(groupSources.active, true),
            eq(groupSources.kind, 'google-group'),
          ),
        )
        .orderBy(asc(groupSources.id));
      return Object.freeze(
        rows.map((row) => {
          // No purpose/role check here on purpose. The database already
          // refuses any other combination, in the `group_sources_access_role_present`
          // constraint: an access group must grant a role, and nothing else may.
          // Restating it in application code would give the invariant two homes
          // and one of them would eventually be wrong.
          const parsed = DesignatedAccessGroupSchema.safeParse({
            groupSourceId: row.groupSourceId,
            email: row.email?.toLowerCase(),
            grantedRole: row.grantedRole,
            // A building source registered before Google held its group has
            // no ID yet; the database allows that for building sources only.
            // Only a building source may wait for its group. The database
            // refuses a null ID on any other purpose; the purpose is checked
            // here as well so the anti-lockout guards never see a waiting
            // sign-in group even if that rule were ever loosened.
            waiting: row.purpose === 'building' && row.googleGroupId === null,
          });
          if (!parsed.success) {
            throw new AccessMembershipSyncError(
              'CONFIGURED_ACCESS_GROUP_INVALID',
              'An active access group is missing the address or role it needs.',
            );
          }
          return parsed.data;
        }),
      );
    },

    /**
     * Publishes one snapshot describing the currently active access groups.
     *
     * Everything happens in one transaction under the administrator
     * availability lock, so the active set cannot change underneath the
     * snapshot being written for it. The transaction is refused outright if it
     * would leave no reachable administrator, which is the guard that makes
     * changing the configuration safe: a deployment can add or remove groups
     * freely, but not in a way that locks itself out.
     */
    async publish(
      reservationIdValue: string,
      evaluationValue: EvaluatedAccessMembershipSet,
      scope: AccessMembershipSyncScope = 'access',
    ): Promise<AccessMembershipPublicationResult> {
      const reservationId = UuidSchema.parse(reservationIdValue);
      const evaluation = validateEvaluation(evaluationValue);
      return database.transaction(async (transaction) => {
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

        // Re-read the active set inside the lock. The evaluation was produced
        // outside it, so a group activated or retired in between must not be
        // published as though it had been evaluated.
        const activeSources = await transaction
          .select({
            id: groupSources.id,
            email: groupSources.email,
            grantedRole: groupSources.grantedRole,
            googleGroupId: groupSources.googleGroupId,
          })
          .from(groupSources)
          .where(
            and(
              inArray(groupSources.purpose, scopePurposes(scope)),
              eq(groupSources.active, true),
              eq(groupSources.kind, 'google-group'),
            ),
          )
          .orderBy(asc(groupSources.id))
          .for('update');
        const activeIds = activeSources.map(({ id }) => id);
        const evaluatedIds = evaluation.groups.map(
          ({ groupSourceId }) => groupSourceId,
        );
        if (
          activeIds.length === 0 ||
          activeIds.length !== evaluatedIds.length ||
          activeIds.some((id, index) => id !== evaluatedIds[index]) ||
          evaluation.groups.some((group) => {
            const source = activeSources.find(
              ({ id }) => id === group.groupSourceId,
            );
            return (
              source === undefined ||
              // A recorded ID must be the one Google answered with. A waiting
              // source (no ID recorded) accepts either "still not held" or
              // the ID Google now holds, which is recorded below.
              (source.googleGroupId !== null &&
                source.googleGroupId !== group.googleGroupId) ||
              source.email?.toLowerCase() !== group.groupEmail ||
              source.grantedRole !== group.grantedRole
            );
          })
        ) {
          throw new AccessMembershipSyncError(
            'ACCESS_CONFIGURATION_CHANGED',
            'The active access configuration changed during evaluation.',
          );
        }
        // A waiting source that Google now holds stops waiting: its ID is
        // recorded once, and from here on it syncs like any other group.
        // Unless that ID already backs another active roster source: then
        // the address is an alias of a group already registered (or one
        // registered twice), and recording it would collide with the
        // one-source-per-group rule on this and every later run. The source
        // stays waiting and names nobody, which an administrator sees on the
        // Schools page; the members Google returned for it are not written.
        const recordedRosterIds = new Set(
          activeSources.flatMap(({ googleGroupId }) =>
            googleGroupId === null ? [] : [googleGroupId],
          ),
        );
        const leftWaiting = new Set<string>();
        for (const group of evaluation.groups) {
          const source = activeSources.find(
            ({ id }) => id === group.groupSourceId,
          );
          if (source?.googleGroupId !== null || group.googleGroupId === null) {
            continue;
          }
          if (recordedRosterIds.has(group.googleGroupId)) {
            leftWaiting.add(group.groupSourceId);
            continue;
          }
          await transaction
            .update(groupSources)
            .set({ googleGroupId: group.googleGroupId })
            .where(eq(groupSources.id, group.groupSourceId));
          recordedRosterIds.add(group.googleGroupId);
        }

        const [latestSnapshot] = await transaction
          .select({
            id: accessMembershipSnapshots.id,
            version: accessMembershipSnapshots.version,
          })
          .from(accessMembershipSnapshots)
          .orderBy(desc(accessMembershipSnapshots.version))
          .limit(1);
        const snapshotVersion = (latestSnapshot?.version ?? 0) + 1;
        if (
          !Number.isSafeInteger(snapshotVersion) ||
          snapshotVersion > MAX_POSTGRES_INTEGER
        ) {
          throw new AccessMembershipSyncError(
            'ACCESS_SNAPSHOT_VERSION_EXHAUSTED',
            'The access-membership snapshot version space is exhausted.',
          );
        }
        // A record of this sync run, not an authorization generation. Nothing
        // reads it to decide access any more; it remains so an operator can see
        // when membership was last read and by which run.
        const snapshotId = randomUUID();
        await transaction.insert(accessMembershipSnapshots).values({
          id: snapshotId,
          version: snapshotVersion,
          complete: true,
          scope,
          syncStartedAt: new Date(evaluation.syncStartedAt),
          capturedAt: new Date(evaluation.capturedAt),
        });

        // Replace each group's membership wholesale and stamp when it was
        // read. Sign-in asks whether a person is in an active trusted group
        // whose membership is recent; there is no generation to publish, no
        // version to agree on, and nothing for a later configuration change to
        // contradict.
        const capturedAt = new Date(evaluation.capturedAt);
        for (const group of evaluation.groups) {
          await transaction
            .delete(groupMembers)
            .where(eq(groupMembers.groupSourceId, group.groupSourceId));
          if (leftWaiting.has(group.groupSourceId)) continue;
          await insertInBatches(
            group.memberEmails.map((email) => ({
              groupSourceId: group.groupSourceId,
              email,
              capturedAt,
            })),
            (batch) => transaction.insert(groupMembers).values([...batch]),
          );
          await transaction
            .update(groupSources)
            .set({ membersCapturedAt: capturedAt })
            .where(eq(groupSources.id, group.groupSourceId));
        }

        // The guard that makes reconfiguration safe. At least one person who
        // holds the administrator role must still be reachable through a group
        // that grants it, or the whole transaction is refused and the previous
        // membership stands. A roster run replaces only roster groups'
        // members and cannot change who holds the administrator role, so it
        // is not asked; asking would refuse a fresh deployment's first roster
        // run for a condition it did not create and cannot affect.
        if (scope === 'access') {
          const administratorEmails = await transaction
            .select({ email: groupMembers.email })
            .from(groupMembers)
            .innerJoin(
              groupSources,
              eq(groupSources.id, groupMembers.groupSourceId),
            )
            .where(
              and(
                eq(groupSources.purpose, 'access'),
                eq(groupSources.active, true),
                eq(groupSources.grantedRole, 'admin'),
              ),
            );
          if (administratorEmails.length === 0) {
            throw new AccessMembershipSyncError(
              'ACCESS_PUBLICATION_LEAVES_NO_ADMINISTRATOR',
              'Publishing this membership would leave no reachable administrator.',
            );
          }
        }

        await completeReservation(
          transaction,
          reservationId,
          snapshotId,
          null,
          capturedAt,
        );
        return publicationResult(
          evaluation,
          snapshotId,
          snapshotVersion,
          activeIds.length,
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
