import { createHash } from 'node:crypto';

import {
  ActorSchema,
  IdempotencyKeySchema,
  TimestampSchema,
  UuidSchema,
  type Actor,
} from '@psd-eoc/contracts';
import { z } from 'zod';

import {
  DESIGNATED_ACCESS_GROUP_EMAIL,
  type EvaluatedAccessMembershipSet,
  type GoogleAccessMembershipEvaluator,
} from './google-access-membership';

const SyncAccessMembershipInputSchema = z
  .object({
    designatedGroupEmail: z.literal(DESIGNATED_ACCESS_GROUP_EMAIL),
  })
  .strict()
  .readonly();

const AccessMembershipPublicationResultSchema = z
  .object({
    snapshotId: UuidSchema,
    snapshotVersion: z.number().int().min(1),
    capturedAt: TimestampSchema,
    designatedSourceId: UuidSchema,
    activeAccessGroupCount: z.number().int().min(1).max(100),
    evaluatedMembershipCount: z.number().int().min(1).max(1_200),
    membershipDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    providerGroupIdDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    publication: z.enum(['created', 'already-current']),
  })
  .strict()
  .readonly();

export type SyncAccessMembershipInput = z.infer<
  typeof SyncAccessMembershipInputSchema
>;
export type AccessMembershipPublicationResult = z.infer<
  typeof AccessMembershipPublicationResultSchema
>;

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
    this.code = z.string().regex(/^[A-Z0-9_]+$/u).max(100).parse(code);
  }
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
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
    return AccessMembershipPublicationResultSchema.parse({
      ...reservation.result,
      publication: 'already-current',
    });
  }

  try {
    const evaluation = await dependencies.evaluator.evaluate();
    if (evaluation.groupEmail !== input.designatedGroupEmail) {
      throw new AccessMembershipSyncError(
        'DESIGNATED_GROUP_MISMATCH',
        'The provider evaluation did not match the designated access group.',
      );
    }
    return AccessMembershipPublicationResultSchema.parse(
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
