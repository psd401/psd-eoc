import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './shared';

/**
 * Owns the persisted district-wide notification fanout state. There is no
 * implicit enabled state: absent or unreadable persistence is derived as
 * emergency-disabled by {@link FanoutControlEffectiveStateSchema}.
 */
export const FanoutControlModeSchema = z.enum([
  'enabled',
  'emergency-disabled',
]);

/** Persisted fanout-control mode inferred from its schema. */
export type FanoutControlMode = z.infer<typeof FanoutControlModeSchema>;

/** Stable identity for one append-only fanout-control record. */
export const FanoutControlRecordIdSchema = UuidSchema;

/** Append-only fanout-control record identifier inferred from its schema. */
export type FanoutControlRecordId = z.infer<typeof FanoutControlRecordIdSchema>;

/** Stable identity for one server-generated fanout enablement epoch. */
export const FanoutEnableEpochIdSchema = UuidSchema;

/** Fanout enablement-epoch identifier inferred from its schema. */
export type FanoutEnableEpochId = z.infer<typeof FanoutEnableEpochIdSchema>;

/** Bounded operational rationale retained with every control transition. */
export const FanoutControlReasonSchema = z.string().trim().min(1).max(500);

/** Non-secret product-owner approval reference for an enable transition. */
export const FanoutProductOwnerApprovalReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(255);

/**
 * Owns one immutable row in the append-only global fanout-control chain.
 * Enabled rows always carry a new server-generated epoch and product-owner
 * approval provenance. Emergency-disable rows carry neither. Database and
 * capability code enforce chain continuity and epoch uniqueness.
 */
export const FanoutControlRecordSchema = z
  .object({
    id: FanoutControlRecordIdSchema,
    revision: z.number().int().positive(),
    previousRecordId: FanoutControlRecordIdSchema.nullable(),
    mode: FanoutControlModeSchema,
    enableEpochId: FanoutEnableEpochIdSchema.nullable(),
    reason: FanoutControlReasonSchema,
    productOwnerApprovalReference:
      FanoutProductOwnerApprovalReferenceSchema.nullable(),
    changedByUserId: UuidSchema,
    changedWithSessionId: UuidSchema,
    changedAt: TimestampSchema,
    requestId: UuidSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.revision === 1) !== (record.previousRecordId === null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Only the first fanout-control revision omits a previous record.',
        path: ['previousRecordId'],
      });
    }
    if (record.previousRecordId === record.id) {
      context.addIssue({
        code: 'custom',
        message: 'A fanout-control record cannot supersede itself.',
        path: ['previousRecordId'],
      });
    }

    const isEnabled = record.mode === 'enabled';
    if (isEnabled !== (record.enableEpochId !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Enabled fanout-control records require an enablement epoch; emergency-disable records forbid one.',
        path: ['enableEpochId'],
      });
    }
    if (isEnabled !== (record.productOwnerApprovalReference !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Enabled fanout-control records require product-owner approval; emergency-disable records forbid it.',
        path: ['productOwnerApprovalReference'],
      });
    }
  })
  .readonly();

/** Immutable append-only fanout-control record inferred from its schema. */
export type FanoutControlRecord = z.infer<typeof FanoutControlRecordSchema>;

/** Safe reason for deriving a missing or unreadable control as disabled. */
export const FanoutControlFailClosedReasonSchema = z.enum([
  'CONTROL_STATE_MISSING',
  'CONTROL_STATE_UNREADABLE',
]);

/** Fail-closed fanout-control reason inferred from its schema. */
export type FanoutControlFailClosedReason = z.infer<
  typeof FanoutControlFailClosedReasonSchema
>;

const CurrentFanoutControlStateSchema = z
  .object({
    kind: z.literal('current'),
    effectiveMode: FanoutControlModeSchema,
    currentEpochId: FanoutEnableEpochIdSchema.nullable(),
    currentRecord: FanoutControlRecordSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.effectiveMode !== state.currentRecord.mode) {
      context.addIssue({
        code: 'custom',
        message: 'Effective fanout mode must match the current record.',
        path: ['effectiveMode'],
      });
    }
    if (state.currentEpochId !== state.currentRecord.enableEpochId) {
      context.addIssue({
        code: 'custom',
        message: 'Current fanout epoch must match the current record.',
        path: ['currentEpochId'],
      });
    }
  });

const MissingFanoutControlStateSchema = z
  .object({
    kind: z.literal('missing'),
    effectiveMode: z.literal('emergency-disabled'),
    currentEpochId: z.null(),
    currentRecord: z.null(),
    reasonCode: z.literal('CONTROL_STATE_MISSING'),
  })
  .strict();

const UnavailableFanoutControlStateSchema = z
  .object({
    kind: z.literal('unavailable'),
    effectiveMode: z.literal('emergency-disabled'),
    currentEpochId: z.null(),
    currentRecord: z.null(),
    reasonCode: z.literal('CONTROL_STATE_UNREADABLE'),
  })
  .strict();

/**
 * Owns the derived fanout state returned to administration and dispatch code.
 * Missing and unreadable persistence have no permissive representation: both
 * parse only as emergency-disabled with no current epoch.
 */
export const FanoutControlEffectiveStateSchema = z
  .discriminatedUnion('kind', [
    CurrentFanoutControlStateSchema,
    MissingFanoutControlStateSchema,
    UnavailableFanoutControlStateSchema,
  ])
  .readonly();

/** Derived district-wide fanout state inferred from its schema. */
export type FanoutControlEffectiveState = z.infer<
  typeof FanoutControlEffectiveStateSchema
>;

/** Owns the exact input of the human web administration query. */
export const GetFanoutControlInputSchema = z.object({}).strict().readonly();

/** Human web fanout-control query input inferred from its schema. */
export type GetFanoutControlInput = z.infer<typeof GetFanoutControlInputSchema>;

/** Owns the exact fail-closed output of the fanout-control query. */
export const GetFanoutControlResultSchema = FanoutControlEffectiveStateSchema;

/** Human web fanout-control query result inferred from its schema. */
export type GetFanoutControlResult = z.infer<
  typeof GetFanoutControlResultSchema
>;

const EmergencyDisableFanoutInputSchema = z
  .object({
    expectedCurrentRecordId: FanoutControlRecordIdSchema.nullable(),
    desiredMode: z.literal('emergency-disabled'),
    reason: FanoutControlReasonSchema,
  })
  .strict();

const EnableFanoutInputSchema = z
  .object({
    expectedCurrentRecordId: FanoutControlRecordIdSchema.nullable(),
    desiredMode: z.literal('enabled'),
    reason: FanoutControlReasonSchema,
    productOwnerApprovalReference: FanoutProductOwnerApprovalReferenceSchema,
  })
  .strict();

/**
 * Owns compare-and-append input for the human web administration mutation.
 * The caller never supplies an enablement epoch; trusted server code creates a
 * fresh epoch only after validating the product-owner approval reference.
 */
export const SetFanoutControlInputSchema = z
  .discriminatedUnion('desiredMode', [
    EmergencyDisableFanoutInputSchema,
    EnableFanoutInputSchema,
  ])
  .readonly();

/** Human web fanout-control mutation input inferred from its schema. */
export type SetFanoutControlInput = z.infer<typeof SetFanoutControlInputSchema>;

/**
 * Owns the exact append result. It cannot claim an effective state other than
 * the newly appended current record.
 */
export const SetFanoutControlResultSchema = z
  .object({
    appendedRecord: FanoutControlRecordSchema,
    effectiveState: FanoutControlEffectiveStateSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.effectiveState.kind !== 'current' ||
      JSON.stringify(result.effectiveState.currentRecord) !==
        JSON.stringify(result.appendedRecord)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A fanout-control append result must expose the appended record as current.',
        path: ['effectiveState', 'currentRecord'],
      });
    }
  })
  .readonly();

/** Human web fanout-control mutation result inferred from its schema. */
export type SetFanoutControlResult = z.infer<
  typeof SetFanoutControlResultSchema
>;

/**
 * Owns the immutable notification intent a worker proposes to process. Trusted
 * server code resolves the intent's persisted epoch and compares it with the
 * current control state; workers and clients never supply or trust an epoch.
 */
export const FanoutAuthorizationCheckInputSchema = z
  .object({
    intentId: UuidSchema,
  })
  .strict()
  .readonly();

/** Fanout authorization check input inferred from its schema. */
export type FanoutAuthorizationCheckInput = z.infer<
  typeof FanoutAuthorizationCheckInputSchema
>;

/** Closed denial reasons shared by worker and provider-bound checks. */
export const FanoutAuthorizationDenialReasonSchema = z.enum([
  'CONTROL_STATE_MISSING',
  'CONTROL_STATE_UNREADABLE',
  'EMERGENCY_DISABLED',
  'ENABLE_EPOCH_MISMATCH',
]);

/** Fanout authorization denial reason inferred from its schema. */
export type FanoutAuthorizationDenialReason = z.infer<
  typeof FanoutAuthorizationDenialReasonSchema
>;

const AuthorizedFanoutDecisionSchema = z
  .object({
    authorized: z.literal(true),
    currentEpochId: FanoutEnableEpochIdSchema,
  })
  .strict();

const DeniedFanoutDecisionSchema = z
  .object({
    authorized: z.literal(false),
    currentEpochId: FanoutEnableEpochIdSchema.nullable(),
    reasonCode: FanoutAuthorizationDenialReasonSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    const mismatch = decision.reasonCode === 'ENABLE_EPOCH_MISMATCH';
    if (mismatch !== (decision.currentEpochId !== null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Only an enable-epoch mismatch denial exposes the different current epoch.',
        path: ['currentEpochId'],
      });
    }
  });

/**
 * Owns a fail-closed worker/provider authorization decision. A positive result
 * names the still-current epoch; every missing, unreadable, disabled, or stale
 * epoch result is an explicit denial.
 */
export const FanoutAuthorizationDecisionSchema = z
  .discriminatedUnion('authorized', [
    AuthorizedFanoutDecisionSchema,
    DeniedFanoutDecisionSchema,
  ])
  .readonly();

/** Fanout worker/provider authorization decision inferred from its schema. */
export type FanoutAuthorizationDecision = z.infer<
  typeof FanoutAuthorizationDecisionSchema
>;
