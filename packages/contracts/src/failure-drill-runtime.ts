import { z } from 'zod';

import { EventIdSchema } from './event';
import {
  NotificationChannelSchema,
  NotificationPurposeSchema,
} from './event-type';
import {
  ChannelAttemptIdSchema,
  DeliveryEvidenceIdSchema,
  DeliveryEvidenceSchema,
  DeliveryTruthTransitionSchema,
  DispatchBatchIdSchema,
  NotificationIntentIdSchema,
} from './notification';
import { EndpointIdSchema } from './roster';
import { isAtOrAfter, TimestampSchema, UuidSchema } from './shared';

const MAX_BATCHES_PER_RUN = 10_000;
const MAX_LOGICAL_WORK_PER_RUN = 120_000;
const MAX_ATTEMPTS_PER_RUN = 500_000;
const MAX_SAFE_REFERENCE_LENGTH = 500;

const SafeReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SAFE_REFERENCE_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);

const MockProviderReferenceSchema = z.string().trim().min(1).max(500);

const failureDrillClassificationShape = {
  eventKind: z.literal('test'),
  templateMode: z.literal('drill'),
  classificationMarker: z.literal('DRILL'),
  rosterPopulation: z.literal('synthetic'),
  providerMode: z.literal('mocked'),
} as const;

const failureDrillRunLineageShape = {
  runId: UuidSchema,
  eventId: EventIdSchema,
  ...failureDrillClassificationShape,
} as const;

const failureDrillIntentLineageShape = {
  ...failureDrillRunLineageShape,
  intentId: NotificationIntentIdSchema,
  purpose: NotificationPurposeSchema,
} as const;

const failureDrillBatchLineageShape = {
  ...failureDrillIntentLineageShape,
  batchId: DispatchBatchIdSchema,
  channel: NotificationChannelSchema,
} as const;

const failureDrillWorkLineageShape = {
  ...failureDrillBatchLineageShape,
  endpointId: EndpointIdSchema,
} as const;

const failureDrillAttemptReferenceShape = {
  ...failureDrillWorkLineageShape,
  attemptId: ChannelAttemptIdSchema,
  attemptNumber: z.number().int().positive(),
} as const;

function stableKey(parts: readonly (number | string)[]): string {
  return JSON.stringify(parts);
}

function batchMemberKey(value: {
  readonly runId: string;
  readonly eventId: string;
  readonly intentId: string;
  readonly purpose: string;
  readonly channel: string;
}): string {
  return stableKey([
    value.runId,
    value.eventId,
    value.intentId,
    value.purpose,
    value.channel,
  ]);
}

function workKey(value: {
  readonly runId: string;
  readonly batchId: string;
  readonly endpointId: string;
}): string {
  return stableKey([value.runId, value.batchId, value.endpointId]);
}

function workIdentityKey(value: {
  readonly runId: string;
  readonly eventId: string;
  readonly intentId: string;
  readonly purpose: string;
  readonly batchId: string;
  readonly channel: string;
  readonly endpointId: string;
}): string {
  return stableKey([
    value.runId,
    value.eventId,
    value.intentId,
    value.purpose,
    value.batchId,
    value.channel,
    value.endpointId,
  ]);
}

function attemptReferenceIdentityKey(value: {
  readonly runId: string;
  readonly eventId: string;
  readonly intentId: string;
  readonly purpose: string;
  readonly batchId: string;
  readonly channel: string;
  readonly endpointId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
}): string {
  return stableKey([
    workIdentityKey(value),
    value.attemptId,
    value.attemptNumber,
  ]);
}

function attemptKey(value: { readonly attemptId: string }): string {
  return value.attemptId;
}

function evidenceKey(value: { readonly evidenceId: string }): string {
  return value.evidenceId;
}

function providerEffectKey(value: {
  readonly attemptId: string;
  readonly providerReference: string;
  readonly provider: string;
  readonly eventId: string;
  readonly purpose: string;
  readonly channel: string;
  readonly endpointId: string;
}): string {
  return stableKey([
    value.attemptId,
    value.providerReference,
    value.provider,
    value.eventId,
    value.purpose,
    value.channel,
    value.endpointId,
  ]);
}

function logicalSendKey(value: {
  readonly eventId: string;
  readonly purpose: string;
  readonly channel: string;
  readonly endpointId: string;
}): string {
  return stableKey([
    value.eventId,
    value.purpose,
    value.channel,
    value.endpointId,
  ]);
}

function addDuplicateKeyIssues<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  context: z.RefinementCtx,
  message: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = keyOf(value);
    if (seen.has(key)) {
      context.addIssue({ code: 'custom', message, path: [index] });
    }
    seen.add(key);
  });
}

function stringSet<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Set<string> {
  return new Set(values.map(keyOf));
}

function setDifference(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((key) => !right.has(key)));
}

function setIntersection(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((key) => right.has(key)));
}

function setUnion(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left, ...right]);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function addExactSetIssue(
  actual: Set<string>,
  expected: Set<string>,
  context: z.RefinementCtx,
  path: string,
  message: string,
): void {
  if (!setsEqual(actual, expected)) {
    context.addIssue({ code: 'custom', message, path: [path] });
  }
}

/** Stable identity for one isolated, mock-only failure-drill run. */
export const FailureDrillRunIdSchema = UuidSchema;

/** Failure-drill run identity inferred from its schema. */
export type FailureDrillRunId = z.infer<typeof FailureDrillRunIdSchema>;

/**
 * Owns the only runtime admission shape accepted by failure-drill workers.
 * Every safety dimension is a literal, so production, live-provider, staff,
 * real-event, or ambiguous input has no valid representation.
 */
export const FailureDrillSafeRunAdmissionSchema = z
  .object({
    ...failureDrillRunLineageShape,
    runtimeEnvironment: z.literal('test'),
    stackClassification: z.literal('non-production'),
    provider: z.literal('mock-provider'),
    authorizationReference: SafeReferenceSchema,
    authorizedByUserId: UuidSchema,
    authorizedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Fail-closed runtime admission inferred from its schema. */
export type FailureDrillSafeRunAdmission = z.infer<
  typeof FailureDrillSafeRunAdmissionSchema
>;

/** One immutable planned-channel/batch identity for a safe run. */
export const FailureDrillExpectedBatchSchema = z
  .object({
    ...failureDrillBatchLineageShape,
    sequence: z.number().int().positive(),
    endpointCount: z.number().int().positive().max(12_000),
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Expected batch inferred from its schema. */
export type FailureDrillExpectedBatch = z.infer<
  typeof FailureDrillExpectedBatchSchema
>;

/** One immutable expected channel/endpoint identity written before enqueue. */
export const FailureDrillExpectedWorkSchema = z
  .object({
    ...failureDrillWorkLineageShape,
    createdAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Expected logical work inferred from its schema. */
export type FailureDrillExpectedWork = z.infer<
  typeof FailureDrillExpectedWorkSchema
>;

/**
 * Owns the complete pre-enqueue target seal. It binds every batch to one
 * planned intent/channel and to an exact, non-empty endpoint identity set.
 */
export const FailureDrillExpectedWorkPlanSchema = z
  .object({
    admission: FailureDrillSafeRunAdmissionSchema,
    batches: z
      .array(FailureDrillExpectedBatchSchema)
      .min(1)
      .max(MAX_BATCHES_PER_RUN)
      .readonly(),
    expectedWork: z
      .array(FailureDrillExpectedWorkSchema)
      .min(1)
      .max(MAX_LOGICAL_WORK_PER_RUN)
      .readonly(),
    expectedWorkCount: z
      .number()
      .int()
      .positive()
      .max(MAX_LOGICAL_WORK_PER_RUN),
    sealedAt: TimestampSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    addDuplicateKeyIssues(
      plan.batches,
      (batch) => batch.batchId,
      context,
      'A dispatch batch identity may appear only once in a sealed plan.',
    );
    addDuplicateKeyIssues(
      plan.batches,
      batchMemberKey,
      context,
      'One intent/channel may have only one dispatch batch.',
    );
    addDuplicateKeyIssues(
      plan.expectedWork,
      workKey,
      context,
      'Expected work must be unique by run, batch, and endpoint.',
    );

    if (plan.expectedWorkCount !== plan.expectedWork.length) {
      context.addIssue({
        code: 'custom',
        message: 'Expected-work count must equal the sealed identity set.',
        path: ['expectedWorkCount'],
      });
    }
    if (!isAtOrAfter(plan.sealedAt, plan.admission.authorizedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'A target plan cannot be sealed before run authorization.',
        path: ['sealedAt'],
      });
    }

    const batchesById = new Map(
      plan.batches.map((batch) => [batch.batchId, batch]),
    );
    const workCounts = new Map<string, number>();

    for (const [index, batch] of plan.batches.entries()) {
      if (
        batch.runId !== plan.admission.runId ||
        batch.eventId !== plan.admission.eventId
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Every batch must retain the admitted run and event.',
          path: ['batches', index],
        });
      }
      if (!isAtOrAfter(plan.sealedAt, batch.createdAt)) {
        context.addIssue({
          code: 'custom',
          message: 'A batch cannot be created after its target plan is sealed.',
          path: ['batches', index, 'createdAt'],
        });
      }
    }

    for (const [index, work] of plan.expectedWork.entries()) {
      const batch = batchesById.get(work.batchId);
      if (!batch) {
        context.addIssue({
          code: 'custom',
          message: 'Expected work must reference a batch in the same plan.',
          path: ['expectedWork', index, 'batchId'],
        });
        continue;
      }
      const lineageMatches =
        work.runId === batch.runId &&
        work.eventId === batch.eventId &&
        work.intentId === batch.intentId &&
        work.purpose === batch.purpose &&
        work.channel === batch.channel &&
        work.eventKind === batch.eventKind &&
        work.templateMode === batch.templateMode &&
        work.classificationMarker === batch.classificationMarker &&
        work.rosterPopulation === batch.rosterPopulation &&
        work.providerMode === batch.providerMode;
      if (!lineageMatches) {
        context.addIssue({
          code: 'custom',
          message:
            'Expected work must exactly preserve its batch classification lineage.',
          path: ['expectedWork', index],
        });
      }
      if (!isAtOrAfter(plan.sealedAt, work.createdAt)) {
        context.addIssue({
          code: 'custom',
          message: 'Expected work cannot be created after its plan is sealed.',
          path: ['expectedWork', index, 'createdAt'],
        });
      }
      workCounts.set(work.batchId, (workCounts.get(work.batchId) ?? 0) + 1);
    }

    for (const [index, batch] of plan.batches.entries()) {
      if ((workCounts.get(batch.batchId) ?? 0) !== batch.endpointCount) {
        context.addIssue({
          code: 'custom',
          message:
            'Batch endpoint count must equal its complete expected-work identity set.',
          path: ['batches', index, 'endpointCount'],
        });
      }
    }
  })
  .readonly();

/** Complete immutable pre-enqueue target seal inferred from its schema. */
export type FailureDrillExpectedWorkPlan = z.infer<
  typeof FailureDrillExpectedWorkPlanSchema
>;

/**
 * Owns one stable attempt identity. Attempts after the first must bind both
 * their exact predecessor and the durable retry obligation that created them.
 */
export const FailureDrillAttemptSchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    predecessorAttemptId: ChannelAttemptIdSchema.nullable(),
    retryObligationId: UuidSchema.nullable(),
    scheduledAt: TimestampSchema,
  })
  .strict()
  .superRefine((attempt, context) => {
    const isFirst = attempt.attemptNumber === 1;
    if (isFirst !== (attempt.predecessorAttemptId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only attempt one may omit its predecessor.',
        path: ['predecessorAttemptId'],
      });
    }
    if (isFirst !== (attempt.retryObligationId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only attempt one may omit its retry obligation.',
        path: ['retryObligationId'],
      });
    }
    if (attempt.predecessorAttemptId === attempt.attemptId) {
      context.addIssue({
        code: 'custom',
        message: 'An attempt cannot be its own predecessor.',
        path: ['predecessorAttemptId'],
      });
    }
  })
  .readonly();

/** Stable failure-drill attempt inferred from its schema. */
export type FailureDrillAttempt = z.infer<typeof FailureDrillAttemptSchema>;

/**
 * Owns a complete attempt collection. Numbering is contiguous from one per
 * logical work item, each predecessor is exact, and one retry obligation can
 * create at most one successor.
 */
export const FailureDrillAttemptSetSchema = z
  .array(FailureDrillAttemptSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((attempts, context) => {
    addDuplicateKeyIssues(
      attempts,
      attemptKey,
      context,
      'Attempt identities must be globally unique.',
    );
    addDuplicateKeyIssues(
      attempts,
      (attempt) => stableKey([workKey(attempt), attempt.attemptNumber]),
      context,
      'A logical work item may have only one attempt at each number.',
    );
    addDuplicateKeyIssues(
      attempts.filter(
        (attempt): attempt is typeof attempt & { retryObligationId: string } =>
          attempt.retryObligationId !== null,
      ),
      (attempt) => attempt.retryObligationId,
      context,
      'A retry obligation may create only one successor attempt.',
    );

    const byWork = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const key = workKey(attempt);
      const existing = byWork.get(key) ?? [];
      byWork.set(key, [...existing, attempt]);
    }
    for (const group of byWork.values()) {
      const ordered = [...group].sort(
        (left, right) => left.attemptNumber - right.attemptNumber,
      );
      ordered.forEach((attempt, index) => {
        const expectedNumber = index + 1;
        if (attempt.attemptNumber !== expectedNumber) {
          context.addIssue({
            code: 'custom',
            message: 'Attempt numbers must be contiguous from one.',
            path: [attempts.indexOf(attempt), 'attemptNumber'],
          });
        }
        if (
          index > 0 &&
          attempt.predecessorAttemptId !== ordered[index - 1]?.attemptId
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'A successor must reference the immediately prior attempt.',
            path: [attempts.indexOf(attempt), 'predecessorAttemptId'],
          });
        }
        if (
          index > 0 &&
          workIdentityKey(attempt) !== workIdentityKey(ordered[0]!)
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Every attempt for one logical work key must preserve complete immutable lineage.',
            path: [attempts.indexOf(attempt)],
          });
        }
      });
    }
  })
  .readonly();

/** Complete stable attempt collection inferred from its schema. */
export type FailureDrillAttemptSet = z.infer<
  typeof FailureDrillAttemptSetSchema
>;

/** One append-only delivery fact bound to exact safe-run attempt lineage. */
export const FailureDrillAttemptEvidenceFactSchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    evidence: DeliveryEvidenceSchema,
  })
  .strict()
  .superRefine((fact, context) => {
    if (
      fact.evidence.subject.kind !== 'attempt' ||
      fact.evidence.subject.attemptId !== fact.attemptId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery evidence must reference the exact drill attempt.',
        path: ['evidence', 'subject'],
      });
    }
    if (
      fact.evidence.provider !== null &&
      fact.evidence.provider !== 'mock-provider'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Failure-drill evidence may name only the mock provider.',
        path: ['evidence', 'provider'],
      });
    }
  })
  .readonly();

/** Safe-run delivery fact inferred from its schema. */
export type FailureDrillAttemptEvidenceFact = z.infer<
  typeof FailureDrillAttemptEvidenceFactSchema
>;

/**
 * Owns complete append-only evidence chains and invokes the canonical delivery
 * transition schema for every adjacent state pair.
 */
export const FailureDrillAttemptEvidenceSetSchema = z
  .array(FailureDrillAttemptEvidenceFactSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((facts, context) => {
    addDuplicateKeyIssues(
      facts,
      (fact) => fact.evidence.id,
      context,
      'Delivery evidence identities must be unique.',
    );
    addDuplicateKeyIssues(
      facts,
      (fact) => stableKey([fact.attemptId, fact.evidence.sequence]),
      context,
      'An attempt may have only one delivery fact at each sequence.',
    );

    const byAttempt = new Map<string, typeof facts>();
    for (const fact of facts) {
      const existing = byAttempt.get(fact.attemptId) ?? [];
      byAttempt.set(fact.attemptId, [...existing, fact]);
    }
    for (const group of byAttempt.values()) {
      const ordered = [...group].sort(
        (left, right) => left.evidence.sequence - right.evidence.sequence,
      );
      ordered.forEach((fact, index) => {
        const expectedSequence = index + 1;
        const previous = ordered[index - 1];
        if (fact.evidence.sequence !== expectedSequence) {
          context.addIssue({
            code: 'custom',
            message: 'Evidence sequences must be contiguous from one.',
            path: [facts.indexOf(fact), 'evidence', 'sequence'],
          });
        }
        if (
          index > 0 &&
          attemptReferenceIdentityKey(fact) !==
            attemptReferenceIdentityKey(ordered[0]!)
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Every evidence fact for an attempt must preserve complete immutable lineage.',
            path: [facts.indexOf(fact)],
          });
        }
        if (index === 0) {
          if (
            fact.evidence.state !== 'attempted' ||
            fact.evidence.previousEvidenceId !== null
          ) {
            context.addIssue({
              code: 'custom',
              message:
                'The first fact must be attempted with no predecessor evidence.',
              path: [facts.indexOf(fact), 'evidence'],
            });
          }
          return;
        }
        if (fact.evidence.previousEvidenceId !== previous?.evidence.id) {
          context.addIssue({
            code: 'custom',
            message: 'Evidence must reference the immediately prior fact.',
            path: [facts.indexOf(fact), 'evidence', 'previousEvidenceId'],
          });
        }
        if (
          previous &&
          !DeliveryTruthTransitionSchema.safeParse({
            subjectKind: 'attempt',
            from: previous.evidence.state,
            to: fact.evidence.state,
          }).success
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Adjacent evidence violates canonical delivery truth.',
            path: [facts.indexOf(fact), 'evidence', 'state'],
          });
        }
      });
    }
  })
  .readonly();

/** Complete canonical delivery-evidence chains inferred from their schema. */
export type FailureDrillAttemptEvidenceSet = z.infer<
  typeof FailureDrillAttemptEvidenceSetSchema
>;

/** One append-only execution schedule/lease fact for an exact attempt. */
export const FailureDrillExecutionFactSchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    factId: UuidSchema,
    sequence: z.number().int().positive(),
    previousFactId: UuidSchema.nullable(),
    state: z.enum(['scheduled', 'leased', 'lease-expired', 'completed']),
    leaseId: UuidSchema.nullable(),
    leaseExpiresAt: TimestampSchema.nullable(),
    recordedAt: TimestampSchema,
  })
  .strict()
  .superRefine((fact, context) => {
    if ((fact.sequence === 1) !== (fact.previousFactId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only the first execution fact may omit its predecessor.',
        path: ['previousFactId'],
      });
    }
    if (fact.sequence === 1 && fact.state !== 'scheduled') {
      context.addIssue({
        code: 'custom',
        message: 'An execution chain must start in scheduled state.',
        path: ['state'],
      });
    }
    const hasLease = fact.leaseId !== null && fact.leaseExpiresAt !== null;
    if ((fact.state !== 'scheduled') !== hasLease) {
      context.addIssue({
        code: 'custom',
        message:
          'Leased, expired, and completed facts require exact lease identity and expiry; scheduled facts forbid both.',
        path: ['leaseId'],
      });
    }
    if (
      fact.state === 'leased' &&
      fact.leaseExpiresAt !== null &&
      !isAtOrAfter(fact.leaseExpiresAt, fact.recordedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A new lease must expire at or after its recorded time.',
        path: ['leaseExpiresAt'],
      });
    }
    if (
      fact.state === 'lease-expired' &&
      fact.leaseExpiresAt !== null &&
      !isAtOrAfter(fact.recordedAt, fact.leaseExpiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Lease expiration cannot be recorded before its expiry.',
        path: ['recordedAt'],
      });
    }
  })
  .readonly();

/** Append-only attempt execution fact inferred from its schema. */
export type FailureDrillExecutionFact = z.infer<
  typeof FailureDrillExecutionFactSchema
>;

const allowedExecutionTransitions = new Set([
  'scheduled:leased',
  'leased:completed',
  'leased:lease-expired',
  'lease-expired:leased',
]);

/** Complete append-only execution chains inferred from their schema. */
export const FailureDrillExecutionFactSetSchema = z
  .array(FailureDrillExecutionFactSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((facts, context) => {
    addDuplicateKeyIssues(
      facts,
      (fact) => fact.factId,
      context,
      'Execution fact identities must be unique.',
    );
    addDuplicateKeyIssues(
      facts,
      (fact) => stableKey([fact.attemptId, fact.sequence]),
      context,
      'An attempt may have only one execution fact per sequence.',
    );

    const byAttempt = new Map<string, typeof facts>();
    for (const fact of facts) {
      const existing = byAttempt.get(fact.attemptId) ?? [];
      byAttempt.set(fact.attemptId, [...existing, fact]);
    }
    for (const group of byAttempt.values()) {
      const ordered = [...group].sort(
        (left, right) => left.sequence - right.sequence,
      );
      ordered.forEach((fact, index) => {
        const previous = ordered[index - 1];
        if (fact.sequence !== index + 1) {
          context.addIssue({
            code: 'custom',
            message: 'Execution facts must be contiguous from sequence one.',
            path: [facts.indexOf(fact), 'sequence'],
          });
        }
        if (
          index > 0 &&
          attemptReferenceIdentityKey(fact) !==
            attemptReferenceIdentityKey(ordered[0]!)
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Every execution fact for an attempt must preserve complete immutable lineage.',
            path: [facts.indexOf(fact)],
          });
        }
        if (index > 0 && fact.previousFactId !== previous?.factId) {
          context.addIssue({
            code: 'custom',
            message:
              'Execution facts must reference the immediate predecessor.',
            path: [facts.indexOf(fact), 'previousFactId'],
          });
        }
        if (
          previous &&
          !allowedExecutionTransitions.has(`${previous.state}:${fact.state}`)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Execution fact transition is not allowed.',
            path: [facts.indexOf(fact), 'state'],
          });
        }
      });
    }
  })
  .readonly();

/** Complete append-only execution chains inferred from their schema. */
export type FailureDrillExecutionFactSet = z.infer<
  typeof FailureDrillExecutionFactSetSchema
>;

/** Stable identity for one durable retry obligation. */
export const FailureDrillRetryObligationIdSchema = UuidSchema;

/** Durable retry-obligation identity inferred from its schema. */
export type FailureDrillRetryObligationId = z.infer<
  typeof FailureDrillRetryObligationIdSchema
>;

/**
 * Owns the obligation created atomically with a retryable failed attempt.
 * The successor number is fixed before any later schedule or DLQ fulfillment.
 */
export const FailureDrillRetryObligationSchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    obligationId: FailureDrillRetryObligationIdSchema,
    failedEvidenceId: DeliveryEvidenceIdSchema,
    successorAttemptNumber: z.number().int().positive(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((obligation, context) => {
    if (obligation.successorAttemptNumber !== obligation.attemptNumber + 1) {
      context.addIssue({
        code: 'custom',
        message: 'A retry obligation must name the next contiguous attempt.',
        path: ['successorAttemptNumber'],
      });
    }
  })
  .readonly();

/** Durable retry obligation inferred from its schema. */
export type FailureDrillRetryObligation = z.infer<
  typeof FailureDrillRetryObligationSchema
>;

/** A unique immutable set of retry obligations. */
export const FailureDrillRetryObligationSetSchema = z
  .array(FailureDrillRetryObligationSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((obligations, context) => {
    addDuplicateKeyIssues(
      obligations,
      (obligation) => obligation.obligationId,
      context,
      'Retry-obligation identities must be unique.',
    );
    addDuplicateKeyIssues(
      obligations,
      (obligation) => obligation.failedEvidenceId,
      context,
      'One failed evidence fact may create only one retry obligation.',
    );
    addDuplicateKeyIssues(
      obligations,
      attemptKey,
      context,
      'One failed attempt may create only one retry obligation.',
    );
  })
  .readonly();

/** Unique retry-obligation set inferred from its schema. */
export type FailureDrillRetryObligationSet = z.infer<
  typeof FailureDrillRetryObligationSetSchema
>;

/** Stable identity for one exact run-specific DLQ entry. */
export const FailureDrillDlqEntryIdSchema = UuidSchema;

/** Run-specific DLQ entry identity inferred from its schema. */
export type FailureDrillDlqEntryId = z.infer<
  typeof FailureDrillDlqEntryIdSchema
>;

const retryFulfillmentBaseShape = {
  ...failureDrillAttemptReferenceShape,
  fulfillmentId: UuidSchema,
  obligationId: FailureDrillRetryObligationIdSchema,
  fulfilledAt: TimestampSchema,
} as const;

/**
 * Owns the only two ways a retry obligation can be fulfilled: an exact
 * contiguous successor attempt or an exact current run-specific DLQ entry.
 */
export const FailureDrillRetryFulfillmentSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...retryFulfillmentBaseShape,
        kind: z.literal('successor-attempt'),
        successorAttemptId: ChannelAttemptIdSchema,
        successorAttemptNumber: z.number().int().positive(),
      })
      .strict()
      .superRefine((fulfillment, context) => {
        if (
          fulfillment.successorAttemptNumber !==
          fulfillment.attemptNumber + 1
        ) {
          context.addIssue({
            code: 'custom',
            message: 'A retry successor must be the next contiguous attempt.',
            path: ['successorAttemptNumber'],
          });
        }
        if (fulfillment.successorAttemptId === fulfillment.attemptId) {
          context.addIssue({
            code: 'custom',
            message: 'A retry successor cannot reuse its predecessor identity.',
            path: ['successorAttemptId'],
          });
        }
      }),
    z
      .object({
        ...retryFulfillmentBaseShape,
        kind: z.literal('retained-dlq'),
        dlqEntryId: FailureDrillDlqEntryIdSchema,
      })
      .strict(),
  ])
  .readonly();

/** Retry-obligation fulfillment inferred from its schema. */
export type FailureDrillRetryFulfillment = z.infer<
  typeof FailureDrillRetryFulfillmentSchema
>;

/** A unique append-only set of retry-obligation fulfillments. */
export const FailureDrillRetryFulfillmentSetSchema = z
  .array(FailureDrillRetryFulfillmentSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((fulfillments, context) => {
    addDuplicateKeyIssues(
      fulfillments,
      (fulfillment) => fulfillment.fulfillmentId,
      context,
      'Retry-fulfillment identities must be unique.',
    );
    addDuplicateKeyIssues(
      fulfillments,
      (fulfillment) => fulfillment.obligationId,
      context,
      'A retry obligation may have only one fulfillment.',
    );
  })
  .readonly();

/** Unique retry-fulfillment set inferred from its schema. */
export type FailureDrillRetryFulfillmentSet = z.infer<
  typeof FailureDrillRetryFulfillmentSetSchema
>;

/**
 * Owns one retryable-failure append. The failed evidence and durable successor
 * obligation are inseparable, so a failed attempt alone cannot parse as a
 * retryable disposition.
 */
export const FailureDrillRetryableFailureSchema = z
  .object({
    attempt: FailureDrillAttemptSchema,
    failedEvidence: FailureDrillAttemptEvidenceFactSchema,
    obligation: FailureDrillRetryObligationSchema,
  })
  .strict()
  .superRefine((failure, context) => {
    const attempt = failure.attempt;
    const evidence = failure.failedEvidence;
    const obligation = failure.obligation;
    if (
      attempt.attemptId !== evidence.attemptId ||
      attempt.attemptId !== obligation.attemptId ||
      workKey(attempt) !== workKey(evidence) ||
      workKey(attempt) !== workKey(obligation)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Retryable failure evidence and obligation must retain exact attempt lineage.',
        path: ['obligation'],
      });
    }
    if (evidence.evidence.state !== 'failed') {
      context.addIssue({
        code: 'custom',
        message: 'A retryable failure must reference failed delivery evidence.',
        path: ['failedEvidence', 'evidence', 'state'],
      });
    }
    if (obligation.failedEvidenceId !== evidence.evidence.id) {
      context.addIssue({
        code: 'custom',
        message: 'The retry obligation must bind the exact failed evidence.',
        path: ['obligation', 'failedEvidenceId'],
      });
    }
  })
  .readonly();

/** Retryable failure with an inseparable obligation inferred from its schema. */
export type FailureDrillRetryableFailure = z.infer<
  typeof FailureDrillRetryableFailureSchema
>;

/** Terminal outcome vocabulary that cannot represent provider acceptance. */
export const FailureDrillTerminalOutcomeSchema = z
  .discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('delivered'), state: z.literal('delivered') })
      .strict(),
    z
      .object({ kind: z.literal('expired'), state: z.literal('expired') })
      .strict(),
    z
      .object({ kind: z.literal('unknown'), state: z.literal('unknown') })
      .strict(),
    z
      .object({
        kind: z.literal('failed-non-retryable'),
        state: z.literal('failed'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('failed-retry-exhausted'),
        state: z.literal('failed'),
      })
      .strict(),
  ])
  .readonly();

/** Evidence-honest terminal outcome inferred from its schema. */
export type FailureDrillTerminalOutcome = z.infer<
  typeof FailureDrillTerminalOutcomeSchema
>;

/** One append-only terminal disposition bound to exact latest evidence. */
export const FailureDrillTerminalDispositionSchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    dispositionId: UuidSchema,
    evidenceId: DeliveryEvidenceIdSchema,
    outcome: FailureDrillTerminalOutcomeSchema,
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
    recordedAt: TimestampSchema,
  })
  .strict()
  .superRefine((disposition, context) => {
    const needsReason = disposition.outcome.kind !== 'delivered';
    if (needsReason !== (disposition.reasonCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Every non-delivered terminal outcome requires a safe reason.',
        path: ['reasonCode'],
      });
    }
  })
  .readonly();

/** Append-only terminal disposition inferred from its schema. */
export type FailureDrillTerminalDisposition = z.infer<
  typeof FailureDrillTerminalDispositionSchema
>;

/** A unique append-only set of terminal dispositions. */
export const FailureDrillTerminalDispositionSetSchema = z
  .array(FailureDrillTerminalDispositionSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((dispositions, context) => {
    addDuplicateKeyIssues(
      dispositions,
      (disposition) => disposition.dispositionId,
      context,
      'Terminal-disposition identities must be unique.',
    );
    addDuplicateKeyIssues(
      dispositions,
      attemptKey,
      context,
      'An attempt may have only one terminal disposition.',
    );
  })
  .readonly();

/** Unique terminal-disposition set inferred from its schema. */
export type FailureDrillTerminalDispositionSet = z.infer<
  typeof FailureDrillTerminalDispositionSetSchema
>;

/**
 * Owns one append-only state fact for an exact run-specific DLQ entry. A
 * retained entry can only advance to redriven or moved; history is never
 * rewritten or deleted.
 */
export const FailureDrillDlqFactSchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    factId: UuidSchema,
    dlqEntryId: FailureDrillDlqEntryIdSchema,
    sequence: z.number().int().positive(),
    previousFactId: UuidSchema.nullable(),
    state: z.enum(['retained', 'redriven', 'moved']),
    recordedAt: TimestampSchema,
  })
  .strict()
  .superRefine((fact, context) => {
    if ((fact.sequence === 1) !== (fact.previousFactId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only the first DLQ fact may omit its predecessor.',
        path: ['previousFactId'],
      });
    }
    if (fact.sequence === 1 && fact.state !== 'retained') {
      context.addIssue({
        code: 'custom',
        message: 'A DLQ chain must begin in retained state.',
        path: ['state'],
      });
    }
  })
  .readonly();

/** Append-only run-specific DLQ fact inferred from its schema. */
export type FailureDrillDlqFact = z.infer<typeof FailureDrillDlqFactSchema>;

/** Complete append-only run-specific DLQ chains inferred from their schema. */
export const FailureDrillDlqFactSetSchema = z
  .array(FailureDrillDlqFactSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((facts, context) => {
    addDuplicateKeyIssues(
      facts,
      (fact) => fact.factId,
      context,
      'DLQ fact identities must be unique.',
    );
    addDuplicateKeyIssues(
      facts,
      (fact) => stableKey([fact.dlqEntryId, fact.sequence]),
      context,
      'A DLQ entry may have only one fact per sequence.',
    );

    const byEntry = new Map<string, typeof facts>();
    for (const fact of facts) {
      const existing = byEntry.get(fact.dlqEntryId) ?? [];
      byEntry.set(fact.dlqEntryId, [...existing, fact]);
    }
    for (const group of byEntry.values()) {
      const ordered = [...group].sort(
        (left, right) => left.sequence - right.sequence,
      );
      ordered.forEach((fact, index) => {
        const previous = ordered[index - 1];
        if (fact.sequence !== index + 1) {
          context.addIssue({
            code: 'custom',
            message: 'DLQ facts must be contiguous from sequence one.',
            path: [facts.indexOf(fact), 'sequence'],
          });
        }
        if (
          index > 0 &&
          attemptReferenceIdentityKey(fact) !==
            attemptReferenceIdentityKey(ordered[0]!)
        ) {
          context.addIssue({
            code: 'custom',
            message:
              'Every fact for one DLQ entry must preserve complete immutable lineage.',
            path: [facts.indexOf(fact)],
          });
        }
        if (index > 0 && fact.previousFactId !== previous?.factId) {
          context.addIssue({
            code: 'custom',
            message: 'DLQ facts must reference the immediate predecessor.',
            path: [facts.indexOf(fact), 'previousFactId'],
          });
        }
        if (previous && previous.state !== 'retained') {
          context.addIssue({
            code: 'custom',
            message: 'A completed DLQ chain cannot advance again.',
            path: [facts.indexOf(fact), 'state'],
          });
        }
        if (previous && fact.state === 'retained') {
          context.addIssue({
            code: 'custom',
            message:
              'A retained DLQ entry cannot append another retained fact.',
            path: [facts.indexOf(fact), 'state'],
          });
        }
      });
    }
  })
  .readonly();

/** Complete append-only run-specific DLQ chains inferred from their schema. */
export type FailureDrillDlqFactSet = z.infer<
  typeof FailureDrillDlqFactSetSchema
>;

/**
 * Owns the exact provider/effect tuple used by reconciliation. Provider is a
 * literal mock and destinations are intentionally absent.
 */
export const FailureDrillProviderEffectIdentitySchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    provider: z.literal('mock-provider'),
    providerReference: MockProviderReferenceSchema,
  })
  .strict()
  .readonly();

/** Exact provider/effect identity inferred from its schema. */
export type FailureDrillProviderEffectIdentity = z.infer<
  typeof FailureDrillProviderEffectIdentitySchema
>;

/** One append-only observation of an actual mock-provider side effect. */
export const FailureDrillMockSideEffectObservationSchema = z
  .object({
    observationId: UuidSchema,
    effect: FailureDrillProviderEffectIdentitySchema,
    observedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Mock-provider side-effect observation inferred from its schema. */
export type FailureDrillMockSideEffectObservation = z.infer<
  typeof FailureDrillMockSideEffectObservationSchema
>;

/** A unique set of exact provider/effect tuples. */
export const FailureDrillProviderEffectIdentitySetSchema = z
  .array(FailureDrillProviderEffectIdentitySchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((effects, context) => {
    addDuplicateKeyIssues(
      effects,
      providerEffectKey,
      context,
      'An exact provider/effect identity may appear only once.',
    );
  })
  .readonly();

/** Unique provider/effect identity set inferred from its schema. */
export type FailureDrillProviderEffectIdentitySet = z.infer<
  typeof FailureDrillProviderEffectIdentitySetSchema
>;

/** A unique append-only set of mock-provider observations. */
export const FailureDrillMockSideEffectObservationSetSchema = z
  .array(FailureDrillMockSideEffectObservationSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((observations, context) => {
    addDuplicateKeyIssues(
      observations,
      (observation) => observation.observationId,
      context,
      'Mock observation identities must be unique.',
    );
    addDuplicateKeyIssues(
      observations,
      (observation) => providerEffectKey(observation.effect),
      context,
      'One actual mock side effect may have only one observer row.',
    );
  })
  .readonly();

/** Unique append-only mock observation set inferred from its schema. */
export type FailureDrillMockSideEffectObservationSet = z.infer<
  typeof FailureDrillMockSideEffectObservationSetSchema
>;

/** One expected/actual batch-set member keyed exactly by intent and channel. */
export const FailureDrillBatchSetMemberSchema = z
  .object({
    ...failureDrillIntentLineageShape,
    channel: NotificationChannelSchema,
  })
  .strict()
  .readonly();

/** Batch-set member inferred from its schema. */
export type FailureDrillBatchSetMember = z.infer<
  typeof FailureDrillBatchSetMemberSchema
>;

/** One logical-work-set member keyed exactly by batch and endpoint. */
export const FailureDrillLogicalWorkIdentitySchema = z
  .object(failureDrillWorkLineageShape)
  .strict()
  .readonly();

/** Logical-work identity inferred from its schema. */
export type FailureDrillLogicalWorkIdentity = z.infer<
  typeof FailureDrillLogicalWorkIdentitySchema
>;

/** One attempt-set member with complete immutable logical lineage. */
export const FailureDrillAttemptReferenceSchema = z
  .object(failureDrillAttemptReferenceShape)
  .strict()
  .readonly();

/** Attempt-set reference inferred from its schema. */
export type FailureDrillAttemptReference = z.infer<
  typeof FailureDrillAttemptReferenceSchema
>;

/** One evidence-chain divergence member with complete attempt lineage. */
export const FailureDrillEvidenceReferenceSchema = z
  .object({
    ...failureDrillAttemptReferenceShape,
    evidenceId: DeliveryEvidenceIdSchema,
  })
  .strict()
  .readonly();

/** Evidence-chain reference inferred from its schema. */
export type FailureDrillEvidenceReference = z.infer<
  typeof FailureDrillEvidenceReferenceSchema
>;

/** A mathematical set of planned/actual intent-channel identities. */
export const FailureDrillBatchIdentitySetSchema = z
  .array(FailureDrillBatchSetMemberSchema)
  .max(MAX_BATCHES_PER_RUN)
  .superRefine((values, context) => {
    addDuplicateKeyIssues(
      values,
      batchMemberKey,
      context,
      'Batch-set members must be unique by intent and channel.',
    );
  })
  .readonly();

/** Intent-channel identity set inferred from its schema. */
export type FailureDrillBatchIdentitySet = z.infer<
  typeof FailureDrillBatchIdentitySetSchema
>;

/** A mathematical set of exact logical-work identities. */
export const FailureDrillLogicalWorkIdentitySetSchema = z
  .array(FailureDrillLogicalWorkIdentitySchema)
  .max(MAX_LOGICAL_WORK_PER_RUN)
  .superRefine((values, context) => {
    addDuplicateKeyIssues(
      values,
      workKey,
      context,
      'Logical-work set members must be unique by run, batch, and endpoint.',
    );
  })
  .readonly();

/** Logical-work identity set inferred from its schema. */
export type FailureDrillLogicalWorkIdentitySet = z.infer<
  typeof FailureDrillLogicalWorkIdentitySetSchema
>;

/** A mathematical set of exact attempt references. */
export const FailureDrillAttemptReferenceSetSchema = z
  .array(FailureDrillAttemptReferenceSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((values, context) => {
    addDuplicateKeyIssues(
      values,
      attemptKey,
      context,
      'Attempt-set members must have unique attempt identities.',
    );
  })
  .readonly();

/** Attempt-reference set inferred from its schema. */
export type FailureDrillAttemptReferenceSet = z.infer<
  typeof FailureDrillAttemptReferenceSetSchema
>;

/** A mathematical set of exact evidence references. */
export const FailureDrillEvidenceReferenceSetSchema = z
  .array(FailureDrillEvidenceReferenceSchema)
  .max(MAX_ATTEMPTS_PER_RUN)
  .superRefine((values, context) => {
    addDuplicateKeyIssues(
      values,
      evidenceKey,
      context,
      'Evidence-set members must have unique evidence identities.',
    );
  })
  .readonly();

/** Evidence-reference set inferred from its schema. */
export type FailureDrillEvidenceReferenceSet = z.infer<
  typeof FailureDrillEvidenceReferenceSetSchema
>;

/**
 * Owns the complete reconciliation output named by the failure-drill runbook.
 * Difference/intersection sets and counts are recomputed during parsing, so a
 * caller cannot claim an empty divergence set by omitting known identities.
 */
export const FailureDrillReconciliationResultSchema = z
  .object({
    ...failureDrillRunLineageShape,
    expectedBatchSet: FailureDrillBatchIdentitySetSchema,
    actualBatchSet: FailureDrillBatchIdentitySetSchema,
    missingBatchSet: FailureDrillBatchIdentitySetSchema,
    unexpectedBatchSet: FailureDrillBatchIdentitySetSchema,
    expectedLogicalWorkSet: FailureDrillLogicalWorkIdentitySetSchema,
    attemptedLogicalWorkSet: FailureDrillLogicalWorkIdentitySetSchema,
    terminalOrUnknownSet: FailureDrillLogicalWorkIdentitySetSchema,
    retainedDlqLogicalWorkSet: FailureDrillLogicalWorkIdentitySetSchema,
    retryableFailedAttemptSet: FailureDrillAttemptReferenceSetSchema,
    fulfilledRetryObligationSet: FailureDrillAttemptReferenceSetSchema,
    orphanedRetryObligationSet: FailureDrillAttemptReferenceSetSchema,
    pendingRetryLogicalWorkSet: FailureDrillLogicalWorkIdentitySetSchema,
    nonfinalHighestAttemptSet: FailureDrillLogicalWorkIdentitySetSchema,
    retryDlqOverlapSet: FailureDrillLogicalWorkIdentitySetSchema,
    invalidAttemptLineageSet: FailureDrillAttemptReferenceSetSchema,
    invalidEvidenceChainSet: FailureDrillEvidenceReferenceSetSchema,
    providerClaimSet: FailureDrillProviderEffectIdentitySetSchema,
    mockSideEffectSet: FailureDrillProviderEffectIdentitySetSchema,
    missingMockSideEffectSet: FailureDrillProviderEffectIdentitySetSchema,
    unexpectedMockSideEffectSet: FailureDrillProviderEffectIdentitySetSchema,
    mockSideEffectWithoutWorkSet: FailureDrillProviderEffectIdentitySetSchema,
    mockSideEffectIdentityMismatchSet:
      FailureDrillProviderEffectIdentitySetSchema,
    missingAttemptSet: FailureDrillLogicalWorkIdentitySetSchema,
    unexpectedAttemptSet: FailureDrillLogicalWorkIdentitySetSchema,
    unaccountedWorkSet: FailureDrillLogicalWorkIdentitySetSchema,
    unexpectedAccountingSet: FailureDrillLogicalWorkIdentitySetSchema,
    terminalDlqOverlapSet: FailureDrillLogicalWorkIdentitySetSchema,
    expectedLogicalWorkCount: z.number().int().nonnegative(),
    terminalOrUnknownCount: z.number().int().nonnegative(),
    retainedDlqLogicalWorkCount: z.number().int().nonnegative(),
    mockLogicalSendCount: z.number().int().nonnegative(),
    duplicateMockSendCount: z.number().int().nonnegative(),
    status: z.enum(['reconciled', 'diverged']),
    reconciledAt: TimestampSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const allLineageValues = [
      ...result.expectedBatchSet,
      ...result.actualBatchSet,
      ...result.missingBatchSet,
      ...result.unexpectedBatchSet,
      ...result.expectedLogicalWorkSet,
      ...result.attemptedLogicalWorkSet,
      ...result.terminalOrUnknownSet,
      ...result.retainedDlqLogicalWorkSet,
      ...result.retryableFailedAttemptSet,
      ...result.fulfilledRetryObligationSet,
      ...result.orphanedRetryObligationSet,
      ...result.pendingRetryLogicalWorkSet,
      ...result.nonfinalHighestAttemptSet,
      ...result.retryDlqOverlapSet,
      ...result.invalidAttemptLineageSet,
      ...result.invalidEvidenceChainSet,
      ...result.providerClaimSet,
      ...result.mockSideEffectSet,
      ...result.missingMockSideEffectSet,
      ...result.unexpectedMockSideEffectSet,
      ...result.mockSideEffectWithoutWorkSet,
      ...result.mockSideEffectIdentityMismatchSet,
      ...result.missingAttemptSet,
      ...result.unexpectedAttemptSet,
      ...result.unaccountedWorkSet,
      ...result.unexpectedAccountingSet,
      ...result.terminalDlqOverlapSet,
    ];
    for (const value of allLineageValues) {
      if (value.runId !== result.runId || value.eventId !== result.eventId) {
        context.addIssue({
          code: 'custom',
          message:
            'Every reconciliation member must retain the exact run and event.',
          path: ['runId'],
        });
        break;
      }
    }

    const expectedBatch = stringSet(result.expectedBatchSet, batchMemberKey);
    const actualBatch = stringSet(result.actualBatchSet, batchMemberKey);
    addExactSetIssue(
      stringSet(result.missingBatchSet, batchMemberKey),
      setDifference(expectedBatch, actualBatch),
      context,
      'missingBatchSet',
      'Missing-batch set must equal expected minus actual batches.',
    );
    addExactSetIssue(
      stringSet(result.unexpectedBatchSet, batchMemberKey),
      setDifference(actualBatch, expectedBatch),
      context,
      'unexpectedBatchSet',
      'Unexpected-batch set must equal actual minus expected batches.',
    );

    const expectedWork = stringSet(
      result.expectedLogicalWorkSet,
      workIdentityKey,
    );
    const attemptedWork = stringSet(
      result.attemptedLogicalWorkSet,
      workIdentityKey,
    );
    const terminalWork = stringSet(
      result.terminalOrUnknownSet,
      workIdentityKey,
    );
    const retainedDlqWork = stringSet(
      result.retainedDlqLogicalWorkSet,
      workIdentityKey,
    );
    const accountedWork = setUnion(terminalWork, retainedDlqWork);
    addExactSetIssue(
      stringSet(result.missingAttemptSet, workIdentityKey),
      setDifference(expectedWork, attemptedWork),
      context,
      'missingAttemptSet',
      'Missing-attempt set must equal expected minus attempted work.',
    );
    addExactSetIssue(
      stringSet(result.unexpectedAttemptSet, workIdentityKey),
      setDifference(attemptedWork, expectedWork),
      context,
      'unexpectedAttemptSet',
      'Unexpected-attempt set must equal attempted minus expected work.',
    );
    addExactSetIssue(
      stringSet(result.unaccountedWorkSet, workIdentityKey),
      setDifference(expectedWork, accountedWork),
      context,
      'unaccountedWorkSet',
      'Unaccounted-work set must equal expected minus terminal-or-DLQ work.',
    );
    addExactSetIssue(
      stringSet(result.unexpectedAccountingSet, workIdentityKey),
      setDifference(accountedWork, expectedWork),
      context,
      'unexpectedAccountingSet',
      'Unexpected-accounting set must equal accounted minus expected work.',
    );
    addExactSetIssue(
      stringSet(result.terminalDlqOverlapSet, workIdentityKey),
      setIntersection(terminalWork, retainedDlqWork),
      context,
      'terminalDlqOverlapSet',
      'Terminal/DLQ overlap set must equal the exact set intersection.',
    );

    const retryableAttempts = stringSet(
      result.retryableFailedAttemptSet,
      attemptKey,
    );
    const fulfilledAttempts = stringSet(
      result.fulfilledRetryObligationSet,
      attemptKey,
    );
    if (
      [...fulfilledAttempts].some(
        (attemptId) => !retryableAttempts.has(attemptId),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Only retryable failed attempts can have fulfilled obligations.',
        path: ['fulfilledRetryObligationSet'],
      });
    }
    addExactSetIssue(
      stringSet(result.orphanedRetryObligationSet, attemptKey),
      setDifference(retryableAttempts, fulfilledAttempts),
      context,
      'orphanedRetryObligationSet',
      'Orphaned obligations must equal retryable failures minus fulfillments.',
    );

    const outstandingRetryWork = setUnion(
      stringSet(result.pendingRetryLogicalWorkSet, workIdentityKey),
      stringSet(result.nonfinalHighestAttemptSet, workIdentityKey),
    );
    addExactSetIssue(
      stringSet(result.retryDlqOverlapSet, workIdentityKey),
      setIntersection(outstandingRetryWork, retainedDlqWork),
      context,
      'retryDlqOverlapSet',
      'Retry/DLQ overlap must equal outstanding retry work intersected with retained DLQ work.',
    );

    const providerClaims = stringSet(
      result.providerClaimSet,
      providerEffectKey,
    );
    const mockEffects = stringSet(result.mockSideEffectSet, providerEffectKey);
    addExactSetIssue(
      stringSet(result.missingMockSideEffectSet, providerEffectKey),
      setDifference(providerClaims, mockEffects),
      context,
      'missingMockSideEffectSet',
      'Missing mock effects must equal provider claims minus observed effects.',
    );
    addExactSetIssue(
      stringSet(result.unexpectedMockSideEffectSet, providerEffectKey),
      setDifference(mockEffects, providerClaims),
      context,
      'unexpectedMockSideEffectSet',
      'Unexpected mock effects must equal observed effects minus provider claims.',
    );

    if (
      result.expectedLogicalWorkCount !== result.expectedLogicalWorkSet.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected-work total must equal its identity-set cardinality.',
        path: ['expectedLogicalWorkCount'],
      });
    }
    if (result.terminalOrUnknownCount !== result.terminalOrUnknownSet.length) {
      context.addIssue({
        code: 'custom',
        message:
          'Terminal-or-unknown total must equal its identity-set cardinality.',
        path: ['terminalOrUnknownCount'],
      });
    }
    if (
      result.retainedDlqLogicalWorkCount !==
      result.retainedDlqLogicalWorkSet.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Retained-DLQ total must equal its identity-set cardinality.',
        path: ['retainedDlqLogicalWorkCount'],
      });
    }

    const logicalMockSendCount = new Set(
      result.mockSideEffectSet.map(logicalSendKey),
    ).size;
    const duplicateMockSendCount =
      result.mockSideEffectSet.length - logicalMockSendCount;
    if (result.mockLogicalSendCount !== logicalMockSendCount) {
      context.addIssue({
        code: 'custom',
        message:
          'Mock logical-send count must be derived from immutable identity.',
        path: ['mockLogicalSendCount'],
      });
    }
    if (result.duplicateMockSendCount !== duplicateMockSendCount) {
      context.addIssue({
        code: 'custom',
        message:
          'Duplicate mock-send count must include side effects beyond one per logical identity.',
        path: ['duplicateMockSendCount'],
      });
    }

    const divergenceCollections = [
      result.missingBatchSet,
      result.unexpectedBatchSet,
      result.orphanedRetryObligationSet,
      result.pendingRetryLogicalWorkSet,
      result.nonfinalHighestAttemptSet,
      result.retryDlqOverlapSet,
      result.invalidAttemptLineageSet,
      result.invalidEvidenceChainSet,
      result.missingMockSideEffectSet,
      result.unexpectedMockSideEffectSet,
      result.mockSideEffectWithoutWorkSet,
      result.mockSideEffectIdentityMismatchSet,
      result.missingAttemptSet,
      result.unexpectedAttemptSet,
      result.unaccountedWorkSet,
      result.unexpectedAccountingSet,
      result.terminalDlqOverlapSet,
    ];
    const hasDivergence =
      divergenceCollections.some((values) => values.length > 0) ||
      result.expectedLogicalWorkCount !==
        result.terminalOrUnknownCount + result.retainedDlqLogicalWorkCount ||
      result.duplicateMockSendCount !== 0;
    if ((result.status === 'diverged') !== hasDivergence) {
      context.addIssue({
        code: 'custom',
        message:
          'Reconciliation status must exactly reflect identity, accounting, retry, evidence, and send divergences.',
        path: ['status'],
      });
    }
  })
  .readonly();

/** Exact evidence-honest reconciliation result inferred from its schema. */
export type FailureDrillReconciliationResult = z.infer<
  typeof FailureDrillReconciliationResultSchema
>;
