import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import {
  ActivationPreviewIdSchema,
  ActivationPreviewSchema,
  DeliveryTestTargetSetRefSchema,
  EventIdSchema,
} from './event';
import {
  EventTypeVersionRefSchema,
  NotificationChannelSchema,
} from './event-type';
import { FacilityIdSchema } from './facility';
import { IntegrationStatusSchema } from './integration';
import {
  DeliveryStateCountSchema,
  NotificationIntentIdSchema,
} from './notification';
import {
  EndpointIdSchema,
  RecipientIdSchema,
  RosterSnapshotIdSchema,
} from './roster';
import {
  isAtOrAfter,
  TimestampSchema,
  UuidSchema,
  VersionSchema,
} from './shared';

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SafeReasonCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_]+$/u);
const DeliveryTestAuthorizationReferenceSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);

/** Stable identity for one immutable monthly delivery-test run. */
export const DeliveryTestRunIdSchema = UuidSchema;

/** Monthly delivery-test run identifier inferred from its schema. */
export type DeliveryTestRunId = z.infer<typeof DeliveryTestRunIdSchema>;

/** Stable identity for one append-only monthly delivery-test report. */
export const MonthlyDeliveryTestReportIdSchema = UuidSchema;

/** Monthly delivery-test report identifier inferred from its schema. */
export type MonthlyDeliveryTestReportId = z.infer<
  typeof MonthlyDeliveryTestReportIdSchema
>;

/** Stable identity for one append-only canary eligibility decision. */
export const DeliveryTestCanaryEligibilityFactIdSchema = UuidSchema;

/** Eligibility decisions are append-only; revocation supersedes approval. */
export const DeliveryTestCanaryEligibilityDecisionSchema = z.enum([
  'approved-synthetic-canary',
  'revoked',
]);

/**
 * Independent product-owner evidence that one opaque roster endpoint is, or
 * is no longer, eligible for controlled-canary delivery tests. Destinations
 * are intentionally absent. A target-set request may reference this fact by
 * ID, but may never assert these facts itself.
 */
export const DeliveryTestCanaryEligibilityFactSchema = z
  .object({
    id: DeliveryTestCanaryEligibilityFactIdSchema,
    supersedesFactId: DeliveryTestCanaryEligibilityFactIdSchema.nullable(),
    facilityId: FacilityIdSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    channel: NotificationChannelSchema,
    decision: DeliveryTestCanaryEligibilityDecisionSchema,
    optedInAt: TimestampSchema,
    decidedAt: TimestampSchema,
    decidedByUserId: UuidSchema,
    decidedWithSessionId: UuidSchema,
    authorizationReference: DeliveryTestAuthorizationReferenceSchema,
  })
  .strict()
  .superRefine((fact, context) => {
    if (!isAtOrAfter(fact.decidedAt, fact.optedInAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Canary eligibility decision cannot precede recorded opt-in.',
        path: ['decidedAt'],
      });
    }
    if (fact.supersedesFactId === fact.id) {
      context.addIssue({
        code: 'custom',
        message: 'A canary eligibility fact cannot supersede itself.',
        path: ['supersedesFactId'],
      });
    }
    if (fact.decision === 'revoked' && fact.supersedesFactId === null) {
      context.addIssue({
        code: 'custom',
        message: 'A canary revocation must supersede an eligibility fact.',
        path: ['supersedesFactId'],
      });
    }
  })
  .readonly();

/** Append-only destination-free canary eligibility fact. */
export type DeliveryTestCanaryEligibilityFact = z.infer<
  typeof DeliveryTestCanaryEligibilityFactSchema
>;

/**
 * Product-owner command that records a new independent eligibility decision.
 * The server owns fact identity, author, authenticated session, and decision
 * time; a target-set request never carries any of these assertions.
 */
export const RecordDeliveryTestCanaryEligibilityInputSchema = z
  .object({
    supersedesFactId: DeliveryTestCanaryEligibilityFactIdSchema.nullable(),
    facilityId: FacilityIdSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    channel: NotificationChannelSchema,
    decision: DeliveryTestCanaryEligibilityDecisionSchema,
    optedInAt: TimestampSchema,
    authorizationReference: DeliveryTestAuthorizationReferenceSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision === 'revoked' && input.supersedesFactId === null) {
      context.addIssue({
        code: 'custom',
        message:
          'A revocation must supersede an approval; an approval may start or advance a chain.',
        path: ['supersedesFactId'],
      });
    }
  })
  .readonly();

/** Product-owner canary eligibility command inferred from its schema. */
export type RecordDeliveryTestCanaryEligibilityInput = z.infer<
  typeof RecordDeliveryTestCanaryEligibilityInputSchema
>;

/**
 * Owns one explicitly opted-in canary endpoint without retaining a contact
 * destination. The attestation is purpose-specific and cannot be parsed as a
 * general staff-recipient approval.
 */
export const DeliveryTestTargetEndpointRefSchema = z
  .object({
    eligibilityFactId: DeliveryTestCanaryEligibilityFactIdSchema,
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    channel: NotificationChannelSchema,
    attestation: z.literal('approved-synthetic-canary'),
    optedInAt: TimestampSchema,
    attestedAt: TimestampSchema,
    attestedByUserId: UuidSchema,
    authorizationReference: DeliveryTestAuthorizationReferenceSchema,
  })
  .strict()
  .superRefine((endpoint, context) => {
    if (!isAtOrAfter(endpoint.attestedAt, endpoint.optedInAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Canary attestation cannot precede recorded opt-in.',
        path: ['attestedAt'],
      });
    }
  })
  .readonly();

/** Destination-free approved canary endpoint inferred from its schema. */
export type DeliveryTestTargetEndpointRef = z.infer<
  typeof DeliveryTestTargetEndpointRefSchema
>;

const DeliveryTestTargetEndpointListSchema = z
  .array(DeliveryTestTargetEndpointRefSchema)
  .min(2)
  .max(12_000)
  .readonly();

function addTargetEndpointSetIssues(
  endpoints: readonly DeliveryTestTargetEndpointRef[],
  context: z.RefinementCtx,
): void {
  const endpointIds = endpoints.map((endpoint) => endpoint.endpointId);
  if (new Set(endpointIds).size !== endpointIds.length) {
    context.addIssue({
      code: 'custom',
      message: 'A canary endpoint may appear only once in a target version.',
      path: ['endpoints'],
    });
  }
  const channels = new Set(endpoints.map((endpoint) => endpoint.channel));
  if (!channels.has('push') || !channels.has('email')) {
    context.addIssue({
      code: 'custom',
      message: 'Canary target versions require push and email endpoints.',
      path: ['endpoints'],
    });
  }
}

/**
 * Owns an immutable, product-owner-approved target-set version. Endpoint
 * values are opaque roster references pinned to one roster snapshot; phone
 * numbers, addresses, and push tokens are structurally absent.
 */
export const DeliveryTestTargetSetVersionSchema = z
  .object({
    id: UuidSchema,
    version: VersionSchema,
    facilityId: FacilityIdSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    supersedesVersionId: UuidSchema.nullable(),
    endpoints: DeliveryTestTargetEndpointListSchema,
    endpointReferenceDigest: DigestSchema,
    approvedByUserId: UuidSchema,
    approvedWithSessionId: UuidSchema,
    approvedAt: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((targetSet, context) => {
    addTargetEndpointSetIssues(targetSet.endpoints, context);
    if (
      (targetSet.version === 1) !==
      (targetSet.supersedesVersionId === null)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Only the first canary target version may omit its superseded version.',
        path: ['supersedesVersionId'],
      });
    }
    if (targetSet.supersedesVersionId === targetSet.id) {
      context.addIssue({
        code: 'custom',
        message: 'A target-set version cannot supersede itself.',
        path: ['supersedesVersionId'],
      });
    }
    if (!isAtOrAfter(targetSet.approvedAt, targetSet.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Target-set approval cannot precede version creation.',
        path: ['approvedAt'],
      });
    }
    targetSet.endpoints.forEach((endpoint, index) => {
      if (!isAtOrAfter(targetSet.approvedAt, endpoint.attestedAt)) {
        context.addIssue({
          code: 'custom',
          message: 'Target-set approval cannot precede endpoint attestation.',
          path: ['endpoints', index, 'attestedAt'],
        });
      }
    });
  })
  .readonly();

/** Immutable delivery-test target-set version inferred from its schema. */
export type DeliveryTestTargetSetVersion = z.infer<
  typeof DeliveryTestTargetSetVersionSchema
>;

/**
 * Owns the human-admin input for a new append-only target version. The
 * authenticated server supplies version identity, approval principal, times,
 * and the digest of the canonical endpoint references.
 */
export const CreateDeliveryTestTargetSetVersionInputSchema = z
  .object({
    previousVersion: DeliveryTestTargetSetRefSchema.nullable(),
    facilityId: FacilityIdSchema,
    rosterSnapshotId: RosterSnapshotIdSchema,
    eligibilityFactIds: z
      .array(DeliveryTestCanaryEligibilityFactIdSchema)
      .min(2)
      .max(12_000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'A canary eligibility fact may be referenced only once.',
      })
      .readonly(),
  })
  .strict()
  .readonly();

/** Delivery-test target-version creation input inferred from its schema. */
export type CreateDeliveryTestTargetSetVersionInput = z.infer<
  typeof CreateDeliveryTestTargetSetVersionInputSchema
>;

/** Owns the exact immutable target and drill template selected for preview. */
export const CreateDeliveryTestPreviewInputSchema = z
  .object({
    targetSet: DeliveryTestTargetSetRefSchema,
    eventTypeVersion: EventTypeVersionRefSchema.refine(
      (version) => version.templateMode === 'drill',
      { message: 'Monthly delivery tests require a drill template.' },
    ),
  })
  .strict()
  .readonly();

/** Delivery-test preview selection inferred from its schema. */
export type CreateDeliveryTestPreviewInput = z.infer<
  typeof CreateDeliveryTestPreviewInputSchema
>;

/** One server-derived credential and endpoint-count row in the live preview. */
export const DeliveryTestPreviewChannelSchema = z
  .object({
    channel: NotificationChannelSchema,
    endpointCount: z.number().int().nonnegative().max(12_000),
    integrationStatus: IntegrationStatusSchema,
    credentialVerified: z.boolean(),
  })
  .strict()
  .superRefine((channel, context) => {
    if (
      channel.credentialVerified &&
      channel.integrationStatus.label !== 'live-verified'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Credentials may be verified only for a live-verified integration.',
        path: ['credentialVerified'],
      });
    }
  })
  .readonly();

/** Delivery-test preview channel inferred from its schema. */
export type DeliveryTestPreviewChannel = z.infer<
  typeof DeliveryTestPreviewChannelSchema
>;

/**
 * Owns the exact consequence preview for a monthly live delivery test. It
 * wraps the ordinary drill/staff activation preview so the actual send still
 * passes through start-event and its fresh human-confirmation boundary.
 */
export const DeliveryTestPreviewSchema = z
  .object({
    purpose: z.literal('monthly-live-delivery-test'),
    activationPreview: ActivationPreviewSchema,
    targetSet: DeliveryTestTargetSetRefSchema,
    endpointReferenceDigest: DigestSchema,
    channels: z
      .array(DeliveryTestPreviewChannelSchema)
      .min(2)
      .max(3)
      .readonly(),
    consequenceDigest: DigestSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    const activation = preview.activationPreview;
    const metadata = activation.deliveryTest;
    if (
      activation.kind !== 'drill' ||
      activation.templateMode !== 'drill' ||
      activation.rosterPopulation !== 'staff' ||
      metadata == null
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Monthly delivery tests require a delivery-test-bound staff drill preview.',
        path: ['activationPreview'],
      });
      return;
    }
    if (
      metadata.targetSet.id !== preview.targetSet.id ||
      metadata.targetSet.version !== preview.targetSet.version ||
      metadata.endpointReferenceDigest !== preview.endpointReferenceDigest
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery-test target provenance must match the activation.',
        path: ['targetSet'],
      });
    }
    if (
      activation.consequenceDigest !== preview.consequenceDigest ||
      activation.createdAt !== preview.createdAt ||
      activation.expiresAt !== preview.expiresAt
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Delivery-test consequence identity and lifetime must match the activation preview.',
        path: ['consequenceDigest'],
      });
    }
    const channelNames = preview.channels.map((channel) => channel.channel);
    if (
      new Set(channelNames).size !== channelNames.length ||
      !channelNames.includes('push') ||
      !channelNames.includes('email')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Delivery-test previews require unique push and email channel rows.',
        path: ['channels'],
      });
    }
    if (preview.channels.length !== activation.channels.length) {
      context.addIssue({
        code: 'custom',
        message:
          'Delivery-test credential rows must cover every activation channel.',
        path: ['channels'],
      });
    }
    preview.channels.forEach((channel, index) => {
      const planned = activation.channels.find(
        (candidate) => candidate.channel === channel.channel,
      );
      if (
        planned === undefined ||
        channel.endpointCount !== planned.endpointCount ||
        JSON.stringify(channel.integrationStatus) !==
          JSON.stringify(planned.integrationStatus)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Delivery-test channel counts and integration truth must match the activation preview.',
          path: ['channels', index],
        });
      }
    });
    if (
      preview.channels.some((channel) => !channel.credentialVerified) &&
      activation.sendReadiness !== 'blocked'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An unverified delivery-test credential must keep activation blocked.',
        path: ['activationPreview', 'sendReadiness'],
      });
    }
  })
  .readonly();

/** Server-issued monthly delivery-test preview inferred from its schema. */
export type DeliveryTestPreview = z.infer<typeof DeliveryTestPreviewSchema>;

/**
 * Owns one immutable live-test run after start-event has atomically consumed
 * the fresh confirmation and recorded its drill notification intent.
 */
export const DeliveryTestRunSchema = z
  .object({
    id: DeliveryTestRunIdSchema,
    activationPreviewId: ActivationPreviewIdSchema,
    eventId: EventIdSchema,
    notificationIntentId: NotificationIntentIdSchema,
    targetSet: DeliveryTestTargetSetRefSchema,
    endpointReferenceDigest: DigestSchema,
    consequenceDigest: DigestSchema,
    confirmationId: UuidSchema,
    startedByUserId: UuidSchema,
    startedWithSessionId: UuidSchema,
    startedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Immutable monthly delivery-test run inferred from its schema. */
export type DeliveryTestRun = z.infer<typeof DeliveryTestRunSchema>;

/** Exact finalization request; all report truth is derived server-side. */
export const FinalizeDeliveryTestReportInputSchema = z
  .object({
    runId: DeliveryTestRunIdSchema,
  })
  .strict()
  .readonly();

/** Delivery-test report finalization input inferred from its schema. */
export type FinalizeDeliveryTestReportInput = z.infer<
  typeof FinalizeDeliveryTestReportInputSchema
>;

/** Evidence-honest per-channel outcome for one monthly live delivery test. */
export const DeliveryTestChannelReportSchema = z
  .object({
    channel: NotificationChannelSchema,
    endpointCount: z.number().int().nonnegative().max(12_000),
    activationToProviderAcceptMs: z.number().int().nonnegative().nullable(),
    latestStateCounts: z.array(DeliveryStateCountSchema).max(6).readonly(),
    completedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((channel, context) => {
    if (
      (channel.activationToProviderAcceptMs === null) !==
      (channel.completedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Provider-accept latency and its completion time must appear together.',
        path: ['completedAt'],
      });
    }
    if (
      new Set(channel.latestStateCounts.map((row) => row.state)).size !==
      channel.latestStateCounts.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery-test state rows must be unique.',
        path: ['latestStateCounts'],
      });
    }
    const countedEndpoints = channel.latestStateCounts.reduce(
      (total, row) => total + row.count,
      0,
    );
    if (countedEndpoints !== channel.endpointCount) {
      context.addIssue({
        code: 'custom',
        message:
          'Delivery-test truth counts must exactly cover planned endpoints; missing evidence is unknown.',
        path: ['latestStateCounts'],
      });
    }
  })
  .readonly();

/** Per-channel monthly delivery-test report inferred from its schema. */
export type DeliveryTestChannelReport = z.infer<
  typeof DeliveryTestChannelReportSchema
>;

/** Owns the terminal projection status of one monthly delivery-test report. */
export const MonthlyDeliveryTestReportStatusSchema = z.enum([
  'succeeded',
  'failed',
  'incomplete',
]);

/** Monthly delivery-test report status inferred from its schema. */
export type MonthlyDeliveryTestReportStatus = z.infer<
  typeof MonthlyDeliveryTestReportStatusSchema
>;

const DeliveryTestFinalizerSchema = z
  .object({
    kind: z.literal('system'),
    serviceId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  })
  .strict()
  .readonly();

/**
 * Owns an append-only, destination-free report snapshot. Later provider truth
 * appends a superseding report instead of rewriting an earlier incomplete or
 * failed projection.
 */
export const MonthlyDeliveryTestReportSchema = z
  .object({
    id: MonthlyDeliveryTestReportIdSchema,
    runId: DeliveryTestRunIdSchema,
    sequence: z.number().int().positive(),
    supersedesReportId: MonthlyDeliveryTestReportIdSchema.nullable(),
    status: MonthlyDeliveryTestReportStatusSchema,
    channels: z.array(DeliveryTestChannelReportSchema).min(2).max(3).readonly(),
    generatedAt: TimestampSchema,
    finalizedBy: DeliveryTestFinalizerSchema,
    source: z.literal('worker'),
    reasonCode: SafeReasonCodeSchema.nullable(),
  })
  .strict()
  .superRefine((report, context) => {
    if ((report.sequence === 1) !== (report.supersedesReportId === null)) {
      context.addIssue({
        code: 'custom',
        message:
          'Only the first delivery-test report may omit a superseded report.',
        path: ['supersedesReportId'],
      });
    }
    if (report.supersedesReportId === report.id) {
      context.addIssue({
        code: 'custom',
        message: 'A delivery-test report cannot supersede itself.',
        path: ['supersedesReportId'],
      });
    }
    const channels = report.channels.map((channel) => channel.channel);
    if (
      new Set(channels).size !== channels.length ||
      !channels.includes('push') ||
      !channels.includes('email')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Delivery-test reports require unique push and email channel rows.',
        path: ['channels'],
      });
    }
    report.channels.forEach((channel, index) => {
      if (
        channel.completedAt !== null &&
        !isAtOrAfter(report.generatedAt, channel.completedAt)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Report generation cannot precede channel completion.',
          path: ['channels', index, 'completedAt'],
        });
      }
    });
    const badStateCount = report.channels.reduce(
      (total, channel) =>
        total +
        channel.latestStateCounts
          .filter((row) => ['failed', 'expired', 'unknown'].includes(row.state))
          .reduce((subtotal, row) => subtotal + row.count, 0),
      0,
    );
    const unknownCount = report.channels.reduce(
      (total, channel) =>
        total +
        (channel.latestStateCounts.find((row) => row.state === 'unknown')
          ?.count ?? 0),
      0,
    );
    const failedOrExpiredCount = report.channels.reduce(
      (total, channel) =>
        total +
        channel.latestStateCounts
          .filter((row) => row.state === 'failed' || row.state === 'expired')
          .reduce((subtotal, row) => subtotal + row.count, 0),
      0,
    );
    if (report.status === 'succeeded') {
      const hasUnacceptedOrUnaccountedOutcome = report.channels.some(
        (channel) => {
          const counted = channel.latestStateCounts.reduce(
            (total, row) => total + row.count,
            0,
          );
          return (
            counted !== channel.endpointCount ||
            channel.latestStateCounts.some(
              (row) =>
                row.count > 0 &&
                row.state !== 'provider-accepted' &&
                row.state !== 'delivered',
            )
          );
        },
      );
      if (
        report.reasonCode !== null ||
        badStateCount > 0 ||
        hasUnacceptedOrUnaccountedOutcome ||
        report.channels.some(
          (channel) => channel.activationToProviderAcceptMs === null,
        )
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Succeeded delivery tests require every endpoint to have provider-accepted or delivered truth.',
          path: ['status'],
        });
      }
    } else if (report.reasonCode === null) {
      context.addIssue({
        code: 'custom',
        message: 'Failed or incomplete reports require a safe reason code.',
        path: ['reasonCode'],
      });
    }
    if (report.status === 'incomplete' && unknownCount === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Incomplete reports must count explicit unknown outcomes.',
        path: ['channels'],
      });
    }
    if (report.status === 'failed' && failedOrExpiredCount === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Failed reports must count a failed or expired outcome.',
        path: ['channels'],
      });
    }
  })
  .readonly();

/** Append-only monthly delivery-test report inferred from its schema. */
export type MonthlyDeliveryTestReport = z.infer<
  typeof MonthlyDeliveryTestReportSchema
>;

/** Owns bounded, facility-authorized monthly report filters. */
export const ListDeliveryTestReportsInputSchema = z
  .object({
    facilityId: FacilityIdSchema.nullable(),
    status: MonthlyDeliveryTestReportStatusSchema.nullable(),
    generatedFrom: TimestampSchema.nullable(),
    generatedThrough: TimestampSchema.nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.generatedFrom !== null &&
      input.generatedThrough !== null &&
      !isAtOrAfter(input.generatedThrough, input.generatedFrom)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery-test report end filter cannot precede its start.',
        path: ['generatedThrough'],
      });
    }
  })
  .readonly();

/** Monthly delivery-test report-list input inferred from its schema. */
export type ListDeliveryTestReportsInput = z.infer<
  typeof ListDeliveryTestReportsInputSchema
>;

/** Owns a bounded page of destination-free monthly delivery-test reports. */
export const MonthlyDeliveryTestReportPageSchema = paginatedSchema(
  MonthlyDeliveryTestReportSchema,
);

/** Monthly delivery-test report page inferred from its schema. */
export type MonthlyDeliveryTestReportPage = z.infer<
  typeof MonthlyDeliveryTestReportPageSchema
>;
