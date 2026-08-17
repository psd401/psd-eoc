import { createHash, randomUUID } from 'node:crypto';

import {
  ActorSchema,
  DESIGNATED_ACCESS_GROUP_EMAIL,
  IdempotencyKeySchema,
  registerCapabilityHandler,
  SecurityAuditEntrySchema,
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
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../../db/client';
import {
  accessMembershipEvaluatedMembers,
  accessMembershipMemberFacilities,
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  connectivityEpochInvalidations,
  connectivityEpochs,
  deviceEnrollments,
  groupSources,
  idempotencyRecords,
  securityAuditChainAnchors,
  securityAuditEntries,
  sessionRevocations,
  sessions,
  sessionTokenIssuances,
  sessionTokenReplays,
  sessionTokenRotations,
  userFacilityScopes,
  userRoleChanges,
  users,
} from '../../db/schema';

import {
  calculateSecurityAuditHash,
  securityAuditHashPayload,
} from '../audit/canonical';
import {
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  toSecurityAuditInsertValues,
} from '../audit/drizzle-repository';
import { buildSecurityAuditEntry } from '../audit/entry';

import {
  type EvaluatedAccessMembershipSet,
  type GoogleAccessMembershipEvaluator,
} from './google-access-membership';
import {
  ADMIN_AVAILABILITY_LOCK_SQL,
  loadAccessConfigurationSnapshotState,
  loadEffectiveAdministratorUserIds,
} from './role-state';

const DESIGNATED_ACCESS_GROUP_DISPLAY_NAME =
  'TSD Engineering administrators' as const;
const MAX_ACCESS_GROUPS = 100;
const MAX_EVALUATED_MEMBERS = 1_200;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const IDEMPOTENCY_IN_PROGRESS_MAX_AGE_MILLISECONDS = 15 * 60 * 1_000;
const ACCESS_SNAPSHOT_REFERENCE_PREFIX = 'access-membership-snapshot:';
const FINALIZATION_AUDIT_REFERENCE_SEPARATOR = ':audit:';
const InitialMobileTransitionEmailDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u);

const EvaluatedAccessMembershipSetSchema = z
  .object({
    groupEmail: z.literal(DESIGNATED_ACCESS_GROUP_EMAIL),
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
  stage(
    reservationId: string,
    evaluation: EvaluatedAccessMembershipSet,
  ): Promise<AccessMembershipPublicationResult>;
  finalize(
    reservationId: string,
    proof: Readonly<{
      mobileSessionId: string;
      membershipSnapshotId: string;
      requestId: string;
      completedAt: string;
    }>,
  ): Promise<AccessMembershipPublicationResult>;
  failReservation(
    reservationId: string,
    errorCode: string,
    completedAt: string,
  ): Promise<void>;
}

export interface AccessMembershipSyncDependencies {
  readonly evaluator?: GoogleAccessMembershipEvaluator;
  /** Independently trusted selector; never accepted from capability input. */
  readonly initialMobileTransitionEmailDigest: string;
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

function digestEmail(email: string): string {
  return createHash('sha256').update(email, 'utf8').digest('hex');
}

/** Parses the protected selector without retaining or reflecting its value. */
export function parseInitialMobileTransitionEmailDigest(
  value: string | undefined,
): string {
  const parsed = InitialMobileTransitionEmailDigestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AccessMembershipSyncError(
      'INITIAL_TRANSITION_SELECTOR_INVALID',
      'The protected initial mobile transition selector is invalid.',
    );
  }
  return parsed.data;
}

function validateEvaluation(
  value: EvaluatedAccessMembershipSet,
  initialMobileTransitionEmailDigest: string,
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
  const selectorMatches = evaluation.memberEmails.filter(
    (email) =>
      digestEmail(email) ===
      InitialMobileTransitionEmailDigestSchema.parse(
        initialMobileTransitionEmailDigest,
      ),
  );
  if (selectorMatches.length !== 1) {
    throw new AccessMembershipSyncError(
      'INITIAL_TRANSITION_SELECTOR_NOT_DIRECT_MEMBER',
      'The protected initial mobile transition selector did not match exactly one current direct member of the designated access group.',
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
    if (input.transition.phase === 'finalize') {
      return SyncAccessMembershipResultSchema.parse(
        await dependencies.store.finalize(reservation.id, {
          mobileSessionId: input.transition.mobileSessionId,
          membershipSnapshotId: input.transition.membershipSnapshotId,
          requestId: context.requestId,
          completedAt: timestamp(now),
        }),
      );
    }
    if (dependencies.evaluator === undefined) {
      throw new AccessMembershipSyncError(
        'ACCESS_EVALUATOR_UNAVAILABLE',
        'The protected provider evaluator is unavailable.',
      );
    }
    const evaluated = await dependencies.evaluator.evaluate();
    if (evaluated.groupEmail !== input.designatedGroupEmail) {
      throw new AccessMembershipSyncError(
        'DESIGNATED_GROUP_MISMATCH',
        'The provider evaluation did not match the designated access group.',
      );
    }
    const evaluation = validateEvaluation(
      evaluated,
      parseInitialMobileTransitionEmailDigest(
        dependencies.initialMobileTransitionEmailDigest,
      ),
    );
    return SyncAccessMembershipResultSchema.parse(
      await dependencies.store.stage(reservation.id, evaluation),
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
  designatedSourceId: string,
  activeAccessGroupCount: number,
  auditEntryHash: string | null,
  publication: 'created' | 'already-current' = 'created',
): AccessMembershipPublicationResult {
  const phase = auditEntryHash === null ? 'stage' : 'finalize';
  return SyncAccessMembershipResultSchema.parse({
    phase,
    snapshotId,
    snapshotVersion,
    capturedAt: evaluation.capturedAt,
    designatedSourceId,
    activeAccessGroupCount,
    evaluatedMembershipCount: evaluation.memberEmails.length,
    membershipDigest: evaluation.membershipDigest,
    providerGroupIdDigest: evaluation.providerGroupIdDigest,
    proofKind:
      phase === 'stage' ? 'initial-selector-match' : 'durable-ios-session',
    auditEntryHash,
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
  configuration: Readonly<{
    initialMobileTransitionEmailDigest: string;
  }>,
): AccessMembershipSyncStore {
  const initialMobileTransitionEmailDigest =
    parseInitialMobileTransitionEmailDigest(
      configuration.initialMobileTransitionEmailDigest,
    );
  async function loadReplay(
    proof: Readonly<{
      snapshotId: string;
      auditEntryHash: string | null;
    }>,
  ): Promise<AccessMembershipPublicationResult> {
    const accessState = await loadAccessConfigurationSnapshotState(database);
    if (accessState === null || accessState.snapshotId !== proof.snapshotId) {
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
      .where(eq(accessMembershipSnapshots.id, proof.snapshotId))
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
            DESIGNATED_ACCESS_GROUP_EMAIL,
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
      source.email?.toLowerCase() !== DESIGNATED_ACCESS_GROUP_EMAIL ||
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
          eq(accessMembershipEvaluatedMembers.snapshotId, proof.snapshotId),
          eq(accessMembershipEvaluatedMembers.groupSourceId, source.id),
          eq(accessMembershipEvaluatedMembers.groupSourceKind, 'google-group'),
          eq(accessMembershipEvaluatedMembers.groupPurpose, 'access'),
        ),
      )
      .orderBy(asc(accessMembershipEvaluatedMembers.email));
    const memberEmails = memberRows.map(({ email }) =>
      StaffRosterEmailSchema.parse(email),
    );
    const evaluation = validateEvaluation(
      {
        groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
        googleGroupId: source.googleGroupId,
        memberEmails,
        membershipDigest: digest([
          DESIGNATED_ACCESS_GROUP_EMAIL,
          source.googleGroupId,
          ...memberEmails,
        ]),
        providerGroupIdDigest: digest([source.googleGroupId]),
        syncStartedAt: snapshot.capturedAt.toISOString(),
        capturedAt: snapshot.capturedAt.toISOString(),
      },
      initialMobileTransitionEmailDigest,
    );
    if (
      (proof.auditEntryHash === null &&
        accessState.activeAccessGroupSourceIds.length !== 2) ||
      (proof.auditEntryHash !== null &&
        accessState.activeAccessGroupSourceIds.length !== 1)
    ) {
      throw new AccessMembershipSyncError(
        'IDEMPOTENCY_RESULT_INVALID',
        'The prior access-sync transition phase could not be verified.',
      );
    }
    if (proof.auditEntryHash !== null) {
      const auditRows = await database
        .select({ entryHash: securityAuditEntries.entryHash })
        .from(securityAuditEntries)
        .where(
          and(
            eq(securityAuditEntries.entryHash, proof.auditEntryHash),
            eq(securityAuditEntries.action, 'sync-access-membership'),
            eq(securityAuditEntries.outcome, 'success'),
            eq(securityAuditEntries.source, 'scheduled-job'),
            eq(securityAuditEntries.targetKind, 'configuration'),
            eq(securityAuditEntries.targetId, proof.snapshotId),
          ),
        );
      if (auditRows.length !== 1) {
        throw new AccessMembershipSyncError(
          'IDEMPOTENCY_RESULT_INVALID',
          'The prior access-sync finalization audit could not be verified.',
        );
      }
    }
    return publicationResult(
      evaluation,
      snapshot.id,
      snapshot.version,
      source.id,
      accessState.activeAccessGroupSourceIds.length,
      proof.auditEntryHash,
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

  async function reuseCurrentTransition(
    transaction: AccessMembershipTransaction,
    reservationId: string,
    baseline: Readonly<{
      snapshotId: string;
      snapshotVersion: number;
      activeAccessGroupSourceIds: readonly string[];
    }>,
    evaluation: EvaluatedAccessMembershipSet,
  ): Promise<AccessMembershipPublicationResult | null> {
    if (baseline.activeAccessGroupSourceIds.length !== 2) {
      return null;
    }
    const [snapshot] = await transaction
      .select()
      .from(accessMembershipSnapshots)
      .where(eq(accessMembershipSnapshots.id, baseline.snapshotId))
      .limit(1)
      .for('share');
    const sources = await transaction
      .select()
      .from(groupSources)
      .where(inArray(groupSources.id, [...baseline.activeAccessGroupSourceIds]))
      .orderBy(asc(groupSources.id))
      .for('update');
    const designatedSources = sources.filter(
      ({ email }) => email?.toLowerCase() === evaluation.groupEmail,
    );
    const designatedSource = designatedSources[0];
    const recoverySources = sources.filter(
      ({ id }) => id !== designatedSource?.id,
    );
    const recoverySource = recoverySources[0];
    if (
      snapshot === undefined ||
      snapshot.version !== baseline.snapshotVersion ||
      sources.length !== 2 ||
      designatedSources.length !== 1 ||
      recoverySources.length !== 1 ||
      designatedSource === undefined ||
      recoverySource === undefined ||
      designatedSource.kind !== 'google-group' ||
      designatedSource.purpose !== 'access' ||
      designatedSource.facilityId !== null ||
      designatedSource.active !== true ||
      designatedSource.googleGroupId !== evaluation.googleGroupId ||
      designatedSource.fixtureKey !== null ||
      recoverySource.kind !== 'google-group' ||
      recoverySource.purpose !== 'access' ||
      recoverySource.facilityId !== null ||
      recoverySource.active !== true ||
      recoverySource.googleGroupId === null ||
      recoverySource.email === null ||
      recoverySource.fixtureKey !== null
    ) {
      throw new AccessMembershipSyncError(
        'RECOVERY_TRANSITION_CURRENT_INVALID',
        'The current two-source transition is ambiguous.',
      );
    }

    const snapshotGroups = await transaction
      .select()
      .from(accessMembershipSnapshotGroups)
      .where(eq(accessMembershipSnapshotGroups.snapshotId, snapshot.id))
      .for('share');
    const expectedSourceIds = snapshotGroups
      .filter(({ completionKind }) => completionKind === 'expected')
      .map(({ groupSourceId }) => groupSourceId)
      .sort();
    const completedSourceIds = snapshotGroups
      .filter(({ completionKind }) => completionKind === 'completed')
      .map(({ groupSourceId }) => groupSourceId)
      .sort();
    const activeSourceIds = sources.map(({ id }) => id).sort();
    const evaluatedRows = await transaction
      .select()
      .from(accessMembershipEvaluatedMembers)
      .where(eq(accessMembershipEvaluatedMembers.snapshotId, snapshot.id))
      .orderBy(asc(accessMembershipEvaluatedMembers.email))
      .for('share');
    const evaluatedEmails = evaluatedRows.map(({ email }) =>
      StaffRosterEmailSchema.parse(email),
    );
    const members = await transaction
      .select()
      .from(accessMembershipMembers)
      .where(eq(accessMembershipMembers.snapshotId, snapshot.id))
      .orderBy(asc(accessMembershipMembers.userId))
      .for('share');
    const memberGroups = await transaction
      .select()
      .from(accessMembershipMemberGroups)
      .where(eq(accessMembershipMemberGroups.snapshotId, snapshot.id))
      .orderBy(
        asc(accessMembershipMemberGroups.userId),
        asc(accessMembershipMemberGroups.groupSourceId),
      )
      .for('share');
    const memberFacilities = await transaction
      .select()
      .from(accessMembershipMemberFacilities)
      .where(eq(accessMembershipMemberFacilities.snapshotId, snapshot.id))
      .for('share');
    const memberIds = members.map(({ userId }) => userId);
    const persistedUsers =
      memberIds.length === 0
        ? []
        : await transaction
            .select()
            .from(users)
            .where(inArray(users.id, memberIds))
            .orderBy(asc(users.id))
            .for('share');
    const persistedFacilityRows =
      memberIds.length === 0
        ? []
        : await transaction
            .select()
            .from(userFacilityScopes)
            .where(inArray(userFacilityScopes.userId, memberIds))
            .for('share');
    const recoveryMemberGroups = memberGroups.filter(
      ({ groupSourceId }) => groupSourceId === recoverySource.id,
    );
    const designatedMemberGroups = memberGroups.filter(
      ({ groupSourceId }) => groupSourceId === designatedSource.id,
    );
    const recoveryMember = members.find(
      ({ userId }) => userId === recoveryMemberGroups[0]?.userId,
    );
    const designatedMember = members.find(
      ({ userId }) => userId === designatedMemberGroups[0]?.userId,
    );
    const recoveryAdministratorIds = await loadEffectiveAdministratorUserIds(
      transaction,
      {
        accessState: baseline,
        eligibleAccessGroupSourceIds: [recoverySource.id],
      },
    );
    const designatedAdministratorIds =
      designatedMember === undefined
        ? []
        : await loadEffectiveAdministratorUserIds(transaction, {
            accessState: baseline,
            eligibleAccessGroupSourceIds: [designatedSource.id],
          });
    const sourceGraphValid =
      snapshotGroups.length === 4 &&
      expectedSourceIds.length === 2 &&
      completedSourceIds.length === 2 &&
      expectedSourceIds.every((id, index) => id === activeSourceIds[index]) &&
      completedSourceIds.every((id, index) => id === activeSourceIds[index]) &&
      evaluatedRows.length === evaluation.memberEmails.length &&
      evaluatedRows.every(
        ({ email, groupSourceId, groupSourceKind, groupPurpose }, index) =>
          email === evaluation.memberEmails[index] &&
          groupSourceId === designatedSource.id &&
          groupSourceKind === 'google-group' &&
          groupPurpose === 'access',
      ) &&
      members.length >= 1 &&
      members.length <= 2 &&
      memberGroups.length === members.length &&
      memberFacilities.length === 0 &&
      persistedFacilityRows.length === 0 &&
      persistedUsers.length === members.length &&
      persistedUsers.every((user) => {
        const member = members.find(({ userId }) => userId === user.id);
        return (
          member !== undefined &&
          member.googleSubject === user.googleSubject &&
          member.facilityScopeKind === 'district' &&
          user.facilityScopeKind === 'district' &&
          user.disabledAt === null
        );
      }) &&
      recoveryMemberGroups.length === 1 &&
      recoveryMember !== undefined &&
      recoveryAdministratorIds.length === 1 &&
      recoveryAdministratorIds[0] === recoveryMember.userId &&
      ((members.length === 1 &&
        designatedMemberGroups.length === 0 &&
        designatedMember === undefined) ||
        (members.length === 2 &&
          designatedMemberGroups.length === 1 &&
          designatedMember !== undefined &&
          designatedMember.userId !== recoveryMember.userId &&
          designatedMember.googleSubject !== recoveryMember.googleSubject &&
          designatedAdministratorIds.length === 1 &&
          designatedAdministratorIds[0] === designatedMember.userId &&
          persistedUsers.some(
            (user) =>
              user.id === designatedMember.userId &&
              digestEmail(user.email) === initialMobileTransitionEmailDigest &&
              evaluatedEmails.includes(
                StaffRosterEmailSchema.parse(user.email),
              ),
          ))) &&
      memberGroups.every(
        ({ groupSourceKind, groupPurpose }) =>
          groupSourceKind === 'google-group' && groupPurpose === 'access',
      );
    if (!sourceGraphValid) {
      throw new AccessMembershipSyncError(
        'RECOVERY_TRANSITION_CURRENT_INVALID',
        'The current two-source transition is ambiguous.',
      );
    }

    const storedEvaluation = validateEvaluation(
      {
        groupEmail: evaluation.groupEmail,
        googleGroupId: evaluation.googleGroupId,
        memberEmails: evaluatedEmails,
        membershipDigest: evaluation.membershipDigest,
        providerGroupIdDigest: evaluation.providerGroupIdDigest,
        syncStartedAt: snapshot.syncStartedAt.toISOString(),
        capturedAt: snapshot.capturedAt.toISOString(),
      },
      initialMobileTransitionEmailDigest,
    );
    await completeReservation(
      transaction,
      reservationId,
      snapshot.id,
      null,
      new Date(evaluation.capturedAt),
    );
    return publicationResult(
      storedEvaluation,
      snapshot.id,
      snapshot.version,
      designatedSource.id,
      2,
      null,
      'already-current',
    );
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
        result: await loadReplay(proofFromReference(existing.resultReference)),
      });
    },

    async stage(
      reservationIdValue: string,
      rawEvaluation: EvaluatedAccessMembershipSet,
    ): Promise<AccessMembershipPublicationResult> {
      const reservationId = UuidSchema.parse(reservationIdValue);
      const evaluation = validateEvaluation(
        rawEvaluation,
        initialMobileTransitionEmailDigest,
      );
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
        const currentTransition = await reuseCurrentTransition(
          transaction,
          reservationId,
          baseline,
          evaluation,
        );
        if (currentTransition !== null) {
          return currentTransition;
        }
        if (baseline.activeAccessGroupSourceIds.length !== 1) {
          throw new AccessMembershipSyncError(
            'RECOVERY_TRANSITION_BASELINE_INVALID',
            'The access baseline does not contain exactly one certified recovery source.',
          );
        }
        const recoverySourceId = baseline.activeAccessGroupSourceIds[0];
        if (recoverySourceId === undefined) {
          throw new AccessMembershipSyncError(
            'RECOVERY_TRANSITION_BASELINE_INVALID',
            'The certified recovery source is unavailable.',
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
          designatedSource.googleGroupId !== evaluation.googleGroupId ||
          designatedSource.email?.toLowerCase() !== evaluation.groupEmail ||
          designatedSource.fixtureKey !== null
        ) {
          throw new AccessMembershipSyncError(
            'DESIGNATED_SOURCE_CONFLICT',
            'The designated access source conflicts with retained provider identity.',
          );
        }
        if (designatedSource.id === recoverySourceId) {
          throw new AccessMembershipSyncError(
            'RECOVERY_TRANSITION_BASELINE_INVALID',
            'The recovery source and designated source must remain distinct until mobile proof.',
          );
        }
        if (!designatedSource.active) {
          const [activatedSource] = await transaction
            .update(groupSources)
            .set({ active: true })
            .where(
              and(
                eq(groupSources.id, designatedSource.id),
                eq(groupSources.active, false),
              ),
            )
            .returning();
          if (activatedSource === undefined) {
            throw new AccessMembershipSyncError(
              'DESIGNATED_SOURCE_ACTIVATION_FAILED',
              'The proven designated access source could not be activated.',
            );
          }
          designatedSource = activatedSource;
        }

        const accessSources = await transaction
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
          .where(eq(groupSources.purpose, 'access'))
          .orderBy(asc(groupSources.id));
        const activeSources = accessSources.filter(({ active }) => active);
        if (
          accessSources.length < 1 ||
          accessSources.length > MAX_ACCESS_GROUPS ||
          accessSources.some(
            (source) =>
              source.kind !== 'google-group' ||
              source.purpose !== 'access' ||
              source.facilityId !== null ||
              source.googleGroupId === null ||
              source.email === null,
          ) ||
          activeSources.length !== 2 ||
          new Set(activeSources.map(({ id }) => id)).size !== 2 ||
          !activeSources.some(({ id }) => id === recoverySourceId) ||
          !activeSources.some(({ id }) => id === designatedSource.id)
        ) {
          throw new AccessMembershipSyncError(
            'ACTIVE_ACCESS_SOURCES_INVALID',
            'The active access-source set was invalid.',
          );
        }
        const memberRows = await transaction
          .select({
            userId: accessMembershipMembers.userId,
            googleSubject: accessMembershipMembers.googleSubject,
            facilityScopeKind: accessMembershipMembers.facilityScopeKind,
            persistedGoogleSubject: users.googleSubject,
            email: users.email,
            disabledAt: users.disabledAt,
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
        const recoveryMember = memberRows[0];
        const recoveryGroup = memberGroupRows[0];
        if (
          memberRows.length !== 1 ||
          recoveryMember === undefined ||
          recoveryMember.googleSubject !==
            recoveryMember.persistedGoogleSubject ||
          recoveryMember.disabledAt !== null ||
          recoveryMember.facilityScopeKind !== 'district' ||
          !StaffRosterEmailSchema.safeParse(recoveryMember.email).success ||
          memberGroupRows.length !== 1 ||
          recoveryGroup === undefined ||
          recoveryGroup.userId !== recoveryMember.userId ||
          recoveryGroup.groupSourceId !== recoverySourceId ||
          recoveryGroup.groupSourceKind !== 'google-group' ||
          recoveryGroup.groupPurpose !== 'access' ||
          memberFacilityRows.length !== 0
        ) {
          throw new AccessMembershipSyncError(
            'RECOVERY_TRANSITION_BINDING_INVALID',
            'The access baseline does not contain one strict district recovery binding.',
          );
        }

        const recoveryAdministratorIds =
          await loadEffectiveAdministratorUserIds(transaction, {
            accessState: baseline,
            eligibleAccessGroupSourceIds: [recoverySourceId],
          });
        if (
          recoveryAdministratorIds.length !== 1 ||
          recoveryAdministratorIds[0] !== recoveryMember.userId
        ) {
          throw new AccessMembershipSyncError(
            'RECOVERY_TRANSITION_ADMIN_INVALID',
            'The access baseline does not contain one reachable recovery administrator.',
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
        await transaction.insert(accessMembershipMembers).values({
          snapshotId,
          userId: recoveryMember.userId,
          googleSubject: recoveryMember.googleSubject,
          facilityScopeKind: 'district',
        });
        await transaction.insert(accessMembershipMemberGroups).values({
          snapshotId,
          userId: recoveryMember.userId,
          groupSourceId: recoverySourceId,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        });
        const evaluatedRows = evaluation.memberEmails.map((email) => ({
          snapshotId,
          email,
          groupSourceId: designatedSource.id,
          groupSourceKind: 'google-group' as const,
          groupPurpose: 'access' as const,
        }));
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
          .select({
            email: accessMembershipEvaluatedMembers.email,
            groupSourceId: accessMembershipEvaluatedMembers.groupSourceId,
          })
          .from(accessMembershipEvaluatedMembers)
          .where(eq(accessMembershipEvaluatedMembers.snapshotId, snapshotId))
          .orderBy(asc(accessMembershipEvaluatedMembers.email));
        const readbackMembers = await transaction
          .select()
          .from(accessMembershipMembers)
          .where(eq(accessMembershipMembers.snapshotId, snapshotId));
        const readbackMemberGroups = await transaction
          .select()
          .from(accessMembershipMemberGroups)
          .where(eq(accessMembershipMemberGroups.snapshotId, snapshotId));
        const readbackMemberFacilities = await transaction
          .select()
          .from(accessMembershipMemberFacilities)
          .where(eq(accessMembershipMemberFacilities.snapshotId, snapshotId));
        const readbackAdministratorIds =
          readbackState === null
            ? []
            : await loadEffectiveAdministratorUserIds(transaction, {
                accessState: readbackState,
              });
        const expectedActiveSourceIds = [
          recoverySourceId,
          designatedSource.id,
        ].sort();
        if (
          readbackState?.snapshotId !== snapshotId ||
          readbackState.snapshotVersion !== snapshotVersion ||
          readbackState.activeAccessGroupSourceIds.length !== 2 ||
          !readbackState.activeAccessGroupSourceIds.every(
            (id, index) => id === expectedActiveSourceIds[index],
          ) ||
          readbackRows.length !== evaluation.memberEmails.length ||
          readbackRows.some(
            ({ email, groupSourceId }, index) =>
              email !== evaluation.memberEmails[index] ||
              groupSourceId !== designatedSource.id,
          ) ||
          readbackMembers.length !== 1 ||
          readbackMembers[0]?.userId !== recoveryMember.userId ||
          readbackMembers[0]?.googleSubject !== recoveryMember.googleSubject ||
          readbackMembers[0]?.facilityScopeKind !== 'district' ||
          readbackMemberGroups.length !== 1 ||
          readbackMemberGroups[0]?.userId !== recoveryMember.userId ||
          readbackMemberGroups[0]?.groupSourceId !== recoverySourceId ||
          readbackMemberFacilities.length !== 0 ||
          readbackAdministratorIds.length !== 1 ||
          readbackAdministratorIds[0] !== recoveryMember.userId
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
          null,
          new Date(evaluation.capturedAt),
        );
        return publicationResult(
          evaluation,
          snapshotId,
          snapshotVersion,
          designatedSource.id,
          activeSources.length,
          null,
        );
      });
    },

    async finalize(
      reservationIdValue: string,
      proofValue: Readonly<{
        mobileSessionId: string;
        membershipSnapshotId: string;
        requestId: string;
        completedAt: string;
      }>,
    ): Promise<AccessMembershipPublicationResult> {
      const reservationId = UuidSchema.parse(reservationIdValue);
      const mobileSessionId = UuidSchema.parse(proofValue.mobileSessionId);
      const membershipSnapshotId = UuidSchema.parse(
        proofValue.membershipSnapshotId,
      );
      const requestId = UuidSchema.parse(proofValue.requestId);
      const completedAt = new Date(
        TimestampSchema.parse(proofValue.completedAt),
      );

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
        const [sourceSnapshot] = await transaction
          .select()
          .from(accessMembershipSnapshots)
          .where(eq(accessMembershipSnapshots.id, membershipSnapshotId))
          .limit(1)
          .for('share');
        const [latestSnapshot] = await transaction
          .select({
            id: accessMembershipSnapshots.id,
            version: accessMembershipSnapshots.version,
          })
          .from(accessMembershipSnapshots)
          .orderBy(desc(accessMembershipSnapshots.version))
          .limit(1)
          .for('share');
        if (
          baseline === null ||
          sourceSnapshot === undefined ||
          latestSnapshot === undefined ||
          baseline.snapshotId !== membershipSnapshotId ||
          sourceSnapshot.id !== baseline.snapshotId ||
          sourceSnapshot.version !== baseline.snapshotVersion ||
          latestSnapshot.id !== sourceSnapshot.id ||
          latestSnapshot.version !== sourceSnapshot.version ||
          sourceSnapshot.version >= MAX_POSTGRES_INTEGER ||
          baseline.activeAccessGroupSourceIds.length !== 2
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_BASELINE_INVALID',
            'The protected finalization baseline is not the latest strict two-source generation.',
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
            fixtureKey: groupSources.fixtureKey,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.active, true),
              eq(groupSources.purpose, 'access'),
            ),
          )
          .orderBy(asc(groupSources.id))
          .for('update');
        const designatedSources = activeSources.filter(
          ({ email }) => email?.toLowerCase() === DESIGNATED_ACCESS_GROUP_EMAIL,
        );
        const designatedSource = designatedSources[0];
        const recoverySources = activeSources.filter(
          ({ id }) => id !== designatedSource?.id,
        );
        const recoverySource = recoverySources[0];
        const expectedActiveSourceIds = activeSources
          .map(({ id }) => id)
          .sort();
        if (
          activeSources.length !== 2 ||
          designatedSources.length !== 1 ||
          recoverySources.length !== 1 ||
          designatedSource === undefined ||
          recoverySource === undefined ||
          designatedSource.kind !== 'google-group' ||
          designatedSource.purpose !== 'access' ||
          designatedSource.facilityId !== null ||
          designatedSource.googleGroupId === null ||
          designatedSource.fixtureKey !== null ||
          recoverySource.kind !== 'google-group' ||
          recoverySource.purpose !== 'access' ||
          recoverySource.facilityId !== null ||
          recoverySource.googleGroupId === null ||
          recoverySource.email === null ||
          recoverySource.fixtureKey !== null ||
          !baseline.activeAccessGroupSourceIds.every(
            (id, index) => id === expectedActiveSourceIds[index],
          )
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_SOURCE_SET_INVALID',
            'The protected finalization source set is ambiguous.',
          );
        }

        const sourceGroupRows = await transaction
          .select()
          .from(accessMembershipSnapshotGroups)
          .where(
            eq(accessMembershipSnapshotGroups.snapshotId, sourceSnapshot.id),
          )
          .orderBy(
            asc(accessMembershipSnapshotGroups.groupSourceId),
            asc(accessMembershipSnapshotGroups.completionKind),
          )
          .for('share');
        const expectedIds = sourceGroupRows
          .filter(({ completionKind }) => completionKind === 'expected')
          .map(({ groupSourceId }) => groupSourceId)
          .sort();
        const completedIds = sourceGroupRows
          .filter(({ completionKind }) => completionKind === 'completed')
          .map(({ groupSourceId }) => groupSourceId)
          .sort();
        if (
          sourceGroupRows.length !== 4 ||
          expectedIds.length !== 2 ||
          completedIds.length !== 2 ||
          !expectedIds.every(
            (id, index) => id === expectedActiveSourceIds[index],
          ) ||
          !completedIds.every(
            (id, index) => id === expectedActiveSourceIds[index],
          ) ||
          sourceGroupRows.some(
            ({ groupSourceKind, groupPurpose }) =>
              groupSourceKind !== 'google-group' || groupPurpose !== 'access',
          )
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_SNAPSHOT_INCOMPLETE',
            'The protected finalization snapshot is incomplete.',
          );
        }

        const evaluatedRows = await transaction
          .select()
          .from(accessMembershipEvaluatedMembers)
          .where(
            eq(accessMembershipEvaluatedMembers.snapshotId, sourceSnapshot.id),
          )
          .orderBy(asc(accessMembershipEvaluatedMembers.email))
          .for('share');
        const evaluation = validateEvaluation(
          {
            groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
            googleGroupId: designatedSource.googleGroupId,
            memberEmails: evaluatedRows.map(({ email }) =>
              StaffRosterEmailSchema.parse(email),
            ),
            membershipDigest: digest([
              DESIGNATED_ACCESS_GROUP_EMAIL,
              designatedSource.googleGroupId,
              ...evaluatedRows.map(({ email }) => email),
            ]),
            providerGroupIdDigest: digest([designatedSource.googleGroupId]),
            syncStartedAt: sourceSnapshot.syncStartedAt.toISOString(),
            capturedAt: sourceSnapshot.capturedAt.toISOString(),
          },
          initialMobileTransitionEmailDigest,
        );
        if (
          evaluatedRows.length !== evaluation.memberEmails.length ||
          evaluatedRows.some(
            ({ groupSourceId, groupSourceKind, groupPurpose }) =>
              groupSourceId !== designatedSource.id ||
              groupSourceKind !== 'google-group' ||
              groupPurpose !== 'access',
          )
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_EVALUATION_INVALID',
            'The protected finalization evaluation is ambiguous.',
          );
        }

        const sourceMembers = await transaction
          .select()
          .from(accessMembershipMembers)
          .where(eq(accessMembershipMembers.snapshotId, sourceSnapshot.id))
          .orderBy(asc(accessMembershipMembers.userId))
          .for('share');
        const sourceMemberGroups = await transaction
          .select()
          .from(accessMembershipMemberGroups)
          .where(eq(accessMembershipMemberGroups.snapshotId, sourceSnapshot.id))
          .orderBy(
            asc(accessMembershipMemberGroups.userId),
            asc(accessMembershipMemberGroups.groupSourceId),
          )
          .for('share');
        const sourceMemberFacilities = await transaction
          .select()
          .from(accessMembershipMemberFacilities)
          .where(
            eq(accessMembershipMemberFacilities.snapshotId, sourceSnapshot.id),
          )
          .for('share');
        const designatedMemberGroup = sourceMemberGroups.find(
          ({ groupSourceId }) => groupSourceId === designatedSource.id,
        );
        const recoveryMemberGroup = sourceMemberGroups.find(
          ({ groupSourceId }) => groupSourceId === recoverySource.id,
        );
        const designatedMember = sourceMembers.find(
          ({ userId }) => userId === designatedMemberGroup?.userId,
        );
        const recoveryMember = sourceMembers.find(
          ({ userId }) => userId === recoveryMemberGroup?.userId,
        );
        if (
          sourceMembers.length !== 2 ||
          sourceMemberGroups.length !== 2 ||
          sourceMemberFacilities.length !== 0 ||
          designatedMember === undefined ||
          recoveryMember === undefined ||
          designatedMemberGroup === undefined ||
          recoveryMemberGroup === undefined ||
          designatedMember.userId === recoveryMember.userId ||
          designatedMember.facilityScopeKind !== 'district' ||
          recoveryMember.facilityScopeKind !== 'district' ||
          designatedMemberGroup.groupSourceKind !== 'google-group' ||
          designatedMemberGroup.groupPurpose !== 'access' ||
          recoveryMemberGroup.groupSourceKind !== 'google-group' ||
          recoveryMemberGroup.groupPurpose !== 'access'
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_MEMBER_SET_INVALID',
            'The protected finalization member set is ambiguous.',
          );
        }

        const [mobileSession] = await transaction
          .select()
          .from(sessions)
          .where(eq(sessions.id, mobileSessionId))
          .limit(1)
          .for('update');
        const [designatedUser] = await transaction
          .select()
          .from(users)
          .where(eq(users.id, designatedMember.userId))
          .limit(1)
          .for('share');
        const [mobileDevice] =
          mobileSession === undefined
            ? []
            : await transaction
                .select()
                .from(deviceEnrollments)
                .where(
                  eq(deviceEnrollments.id, mobileSession.deviceEnrollmentId),
                )
                .limit(1)
                .for('share');
        const designatedFacilityRows = await transaction
          .select({ facilityId: userFacilityScopes.facilityId })
          .from(userFacilityScopes)
          .where(eq(userFacilityScopes.userId, designatedMember.userId))
          .for('share');
        if (
          mobileSession === undefined ||
          designatedUser === undefined ||
          mobileDevice === undefined ||
          mobileSession.userId !== designatedMember.userId ||
          mobileSession.membershipSnapshotId !== sourceSnapshot.id ||
          mobileSession.revokedAt !== null ||
          completedAt.getTime() < mobileSession.createdAt.getTime() ||
          completedAt.getTime() > mobileSession.expiresAt.getTime() ||
          completedAt.getTime() >
            mobileSession.membershipGraceUntil.getTime() ||
          mobileDevice.userId !== designatedMember.userId ||
          mobileDevice.platform !== 'ios' ||
          mobileDevice.unlockMethod !== 'biometric' ||
          mobileDevice.revokedAt !== null ||
          mobileDevice.enrolledAt.getTime() >
            mobileSession.createdAt.getTime() ||
          designatedUser.googleSubject !== designatedMember.googleSubject ||
          designatedUser.disabledAt !== null ||
          designatedUser.facilityScopeKind !== 'district' ||
          designatedFacilityRows.length !== 0 ||
          digestEmail(designatedUser.email) !==
            initialMobileTransitionEmailDigest ||
          !evaluation.memberEmails.includes(
            StaffRosterEmailSchema.parse(designatedUser.email),
          )
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_MOBILE_SESSION_INVALID',
            'The protected durable iOS session proof is invalid.',
          );
        }

        const tokenIssuances = await transaction
          .select()
          .from(sessionTokenIssuances)
          .where(eq(sessionTokenIssuances.sessionId, mobileSession.id))
          .for('share');
        const tokenRotations = await transaction
          .select()
          .from(sessionTokenRotations)
          .where(eq(sessionTokenRotations.sessionId, mobileSession.id))
          .orderBy(
            asc(sessionTokenRotations.rotatedAt),
            asc(sessionTokenRotations.id),
          )
          .for('share');
        const tokenReplays = await transaction
          .select({ id: sessionTokenReplays.id })
          .from(sessionTokenReplays)
          .where(eq(sessionTokenReplays.sessionId, mobileSession.id))
          .for('share');
        const revocations = await transaction
          .select({ id: sessionRevocations.id })
          .from(sessionRevocations)
          .where(eq(sessionRevocations.sessionId, mobileSession.id))
          .for('share');
        let currentTokenDigest = tokenIssuances[0]?.tokenDigest;
        let previousTokenTime = tokenIssuances[0]?.issuedAt.getTime();
        const tokenChainValid =
          tokenIssuances.length === 1 &&
          currentTokenDigest !== undefined &&
          /^[a-f0-9]{64}$/u.test(currentTokenDigest) &&
          previousTokenTime !== undefined &&
          previousTokenTime === mobileSession.createdAt.getTime() &&
          previousTokenTime <= completedAt.getTime() &&
          tokenRotations.every((rotation) => {
            const valid =
              rotation.previousTokenDigest === currentTokenDigest &&
              /^[a-f0-9]{64}$/u.test(rotation.previousTokenDigest) &&
              /^[a-f0-9]{64}$/u.test(rotation.nextTokenDigest) &&
              rotation.rotatedAt.getTime() >= (previousTokenTime ?? 0) &&
              rotation.rotatedAt.getTime() <= completedAt.getTime();
            currentTokenDigest = rotation.nextTokenDigest;
            previousTokenTime = rotation.rotatedAt.getTime();
            return valid;
          });
        if (
          !tokenChainValid ||
          tokenReplays.length !== 0 ||
          revocations.length !== 0
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_TOKEN_PROOF_INVALID',
            'The protected mobile token proof is invalid.',
          );
        }

        const epochs = await transaction
          .select()
          .from(connectivityEpochs)
          .where(eq(connectivityEpochs.sessionId, mobileSession.id))
          .orderBy(
            desc(connectivityEpochs.establishedAt),
            desc(connectivityEpochs.id),
          )
          .for('share');
        const currentEpoch = epochs[0];
        const currentEpochInvalidations =
          currentEpoch === undefined
            ? []
            : await transaction
                .select({ id: connectivityEpochInvalidations.id })
                .from(connectivityEpochInvalidations)
                .where(
                  eq(
                    connectivityEpochInvalidations.connectivityEpochId,
                    currentEpoch.id,
                  ),
                )
                .for('share');
        if (
          currentEpoch === undefined ||
          currentEpoch.establishedAt.getTime() !==
            mobileSession.createdAt.getTime() ||
          currentEpoch.establishedAt.getTime() > completedAt.getTime() ||
          currentEpochInvalidations.length !== 0
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_CONNECTIVITY_PROOF_INVALID',
            'The protected mobile connectivity proof is invalid.',
          );
        }

        const signInAuditRows = await transaction
          .select()
          .from(securityAuditEntries)
          .where(
            and(
              eq(securityAuditEntries.action, 'complete-oidc-sign-in'),
              eq(securityAuditEntries.outcome, 'success'),
              eq(securityAuditEntries.source, 'mobile'),
              eq(securityAuditEntries.targetKind, 'session'),
              eq(securityAuditEntries.targetId, mobileSession.id),
            ),
          )
          .orderBy(asc(securityAuditEntries.sequence))
          .for('share');
        const signInAuditRow = signInAuditRows[0];
        const signInAudit =
          signInAuditRow === undefined
            ? null
            : SecurityAuditEntrySchema.safeParse({
                id: signInAuditRow.id,
                sequence: signInAuditRow.sequence,
                previousHash: signInAuditRow.previousHash,
                entryHash: signInAuditRow.entryHash,
                category: signInAuditRow.category,
                action: signInAuditRow.action,
                actionIds: signInAuditRow.actionIds,
                confirmationId: signInAuditRow.confirmationId,
                outcome: signInAuditRow.outcome,
                principal: signInAuditRow.principal,
                source: signInAuditRow.source,
                facilityId: signInAuditRow.facilityId,
                target: {
                  kind: signInAuditRow.targetKind,
                  id: signInAuditRow.targetId,
                },
                requestId: signInAuditRow.requestId,
                reasonCode: signInAuditRow.reasonCode,
                occurredAt: signInAuditRow.occurredAt.toISOString(),
              });
        const [signInAuditAnchor] =
          signInAuditRow === undefined
            ? []
            : await transaction
                .select()
                .from(securityAuditChainAnchors)
                .where(
                  eq(
                    securityAuditChainAnchors.sequence,
                    signInAuditRow.sequence,
                  ),
                )
                .limit(1)
                .for('share');
        const roleChanges = await transaction
          .select()
          .from(userRoleChanges)
          .where(
            and(
              eq(userRoleChanges.userId, designatedMember.userId),
              eq(userRoleChanges.role, 'admin'),
            ),
          )
          .orderBy(desc(userRoleChanges.sequence))
          .for('share');
        const latestAdminChange = roleChanges[0];
        if (
          signInAuditRows.length !== 1 ||
          !signInAudit?.success ||
          signInAudit.data.principal.kind !== 'human' ||
          signInAudit.data.principal.userId !== designatedMember.userId ||
          signInAudit.data.principal.sessionId !== mobileSession.id ||
          Date.parse(signInAudit.data.occurredAt) !==
            mobileSession.createdAt.getTime() ||
          Date.parse(signInAudit.data.occurredAt) > completedAt.getTime() ||
          calculateSecurityAuditHash(
            securityAuditHashPayload(signInAudit.data),
          ) !== signInAudit.data.entryHash ||
          signInAuditAnchor?.entryHash !== signInAudit.data.entryHash ||
          latestAdminChange === undefined ||
          roleChanges.length !== 1 ||
          latestAdminChange.granted !== true ||
          latestAdminChange.changedByUserId !== designatedMember.userId ||
          latestAdminChange.changedWithSessionId !== mobileSession.id ||
          latestAdminChange.requestId !== signInAudit.data.requestId ||
          latestAdminChange.occurredAt.getTime() !==
            mobileSession.createdAt.getTime()
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_AUDIT_PROOF_INVALID',
            'The protected mobile sign-in and administrator audit proof is invalid.',
          );
        }

        const recoveryAdministratorIds =
          await loadEffectiveAdministratorUserIds(transaction, {
            accessState: baseline,
            eligibleAccessGroupSourceIds: [recoverySource.id],
          });
        const designatedAdministratorIds =
          await loadEffectiveAdministratorUserIds(transaction, {
            accessState: baseline,
            eligibleAccessGroupSourceIds: [designatedSource.id],
          });
        if (
          recoveryAdministratorIds.length !== 1 ||
          recoveryAdministratorIds[0] !== recoveryMember.userId ||
          designatedAdministratorIds.length !== 1 ||
          designatedAdministratorIds[0] !== designatedMember.userId
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_ADMIN_PROOF_INVALID',
            'The protected transition administrator proof is invalid.',
          );
        }

        const [deactivatedRecoverySource] = await transaction
          .update(groupSources)
          .set({ active: false })
          .where(
            and(
              eq(groupSources.id, recoverySource.id),
              eq(groupSources.active, true),
            ),
          )
          .returning();
        if (deactivatedRecoverySource?.id !== recoverySource.id) {
          throw new AccessMembershipSyncError(
            'RECOVERY_SOURCE_DEACTIVATION_FAILED',
            'The protected recovery source could not be deactivated.',
          );
        }

        const successorSnapshotId = randomUUID();
        const successorSnapshotVersion = sourceSnapshot.version + 1;
        await transaction.insert(accessMembershipSnapshots).values({
          id: successorSnapshotId,
          version: successorSnapshotVersion,
          complete: true,
          syncStartedAt: sourceSnapshot.syncStartedAt,
          capturedAt: sourceSnapshot.capturedAt,
        });
        await transaction.insert(accessMembershipSnapshotGroups).values([
          {
            snapshotId: successorSnapshotId,
            groupSourceId: designatedSource.id,
            groupSourceKind: 'google-group',
            groupPurpose: 'access',
            completionKind: 'expected',
          },
          {
            snapshotId: successorSnapshotId,
            groupSourceId: designatedSource.id,
            groupSourceKind: 'google-group',
            groupPurpose: 'access',
            completionKind: 'completed',
          },
        ]);
        await insertInBatches(
          evaluatedRows.map((row) => ({
            ...row,
            snapshotId: successorSnapshotId,
          })),
          async (batch) =>
            transaction
              .insert(accessMembershipEvaluatedMembers)
              .values([...batch]),
        );
        await transaction.insert(accessMembershipMembers).values({
          snapshotId: successorSnapshotId,
          userId: designatedMember.userId,
          googleSubject: designatedMember.googleSubject,
          facilityScopeKind: 'district',
        });
        await transaction.insert(accessMembershipMemberGroups).values({
          snapshotId: successorSnapshotId,
          userId: designatedMember.userId,
          groupSourceId: designatedSource.id,
          groupSourceKind: 'google-group',
          groupPurpose: 'access',
        });

        const readbackState =
          await loadAccessConfigurationSnapshotState(transaction);
        const readbackAdministratorIds =
          readbackState === null
            ? []
            : await loadEffectiveAdministratorUserIds(transaction, {
                accessState: readbackState,
              });
        const readbackMembers = await transaction
          .select()
          .from(accessMembershipMembers)
          .where(eq(accessMembershipMembers.snapshotId, successorSnapshotId));
        if (
          readbackState?.snapshotId !== successorSnapshotId ||
          readbackState.snapshotVersion !== successorSnapshotVersion ||
          readbackState.activeAccessGroupSourceIds.length !== 1 ||
          readbackState.activeAccessGroupSourceIds[0] !== designatedSource.id ||
          readbackMembers.length !== 1 ||
          readbackMembers[0]?.userId !== designatedMember.userId ||
          readbackAdministratorIds.length !== 1 ||
          readbackAdministratorIds[0] !== designatedMember.userId
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_READBACK_FAILED',
            'The protected finalization did not pass transactional readback.',
          );
        }

        await transaction.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
        const [auditAnchor] = await transaction
          .select()
          .from(securityAuditChainAnchors)
          .orderBy(desc(securityAuditChainAnchors.sequence))
          .limit(1)
          .for('share');
        const [auditHead] = await transaction
          .select({
            sequence: securityAuditEntries.sequence,
            entryHash: securityAuditEntries.entryHash,
          })
          .from(securityAuditEntries)
          .orderBy(desc(securityAuditEntries.sequence))
          .limit(1)
          .for('share');
        const [existingAuditRequest] = await transaction
          .select({ id: securityAuditEntries.id })
          .from(securityAuditEntries)
          .where(eq(securityAuditEntries.requestId, requestId))
          .limit(1)
          .for('share');
        if (
          (auditAnchor === undefined) !== (auditHead === undefined) ||
          auditAnchor?.sequence !== auditHead?.sequence ||
          auditAnchor?.entryHash !== auditHead?.entryHash ||
          existingAuditRequest !== undefined
        ) {
          throw new AccessMembershipSyncError(
            'FINALIZATION_AUDIT_CHAIN_INVALID',
            'The protected finalization audit chain is unavailable.',
          );
        }
        const finalizationAuditEntry = buildSecurityAuditEntry(
          {
            category: 'admin-change',
            action: 'sync-access-membership',
            actionIds: [],
            confirmationId: null,
            outcome: 'success',
            principal: {
              kind: 'system',
              serviceId: 'access-membership-sync',
            },
            source: 'scheduled-job',
            facilityId: null,
            target: {
              kind: 'configuration',
              id: successorSnapshotId,
            },
            requestId,
            reasonCode: null,
            occurredAt: completedAt.toISOString(),
          },
          auditAnchor ?? null,
        );
        await transaction
          .insert(securityAuditEntries)
          .values(toSecurityAuditInsertValues(finalizationAuditEntry));

        await completeReservation(
          transaction,
          reservationId,
          successorSnapshotId,
          finalizationAuditEntry.entryHash,
          completedAt,
        );
        return publicationResult(
          evaluation,
          successorSnapshotId,
          successorSnapshotVersion,
          designatedSource.id,
          1,
          finalizationAuditEntry.entryHash,
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
