import { z } from 'zod';

import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  DeliveryProofSchema,
  DispatchBatchSchema,
} from './notification';
import { EndpointSchema } from './roster';
import { TimestampSchema, UuidSchema } from './shared';

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SafeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_]+$/u);
const SafeReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u);

/** Exact endpoint attempt handed from the trusted resolver to a worker. */
export const PushWorkerAttemptWorkItemSchema = z
  .object({
    batch: DispatchBatchSchema,
    attempt: ChannelAttemptSchema,
    endpoint: EndpointSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.batch.channel !== 'push' ||
      item.attempt.channel !== 'push' ||
      item.endpoint.channel !== 'push' ||
      item.batch.id !== item.attempt.batchId ||
      item.batch.intentId !== item.attempt.intentId ||
      item.batch.eventId !== item.attempt.eventId ||
      item.batch.rosterSnapshotId !== item.attempt.rosterSnapshotId ||
      item.batch.rosterPopulation !== item.attempt.rosterPopulation ||
      item.attempt.endpointId !== item.endpoint.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Push worker attempt identities must match exactly.',
      });
    }
  })
  .readonly();

export type PushWorkerAttemptWorkItem = z.infer<
  typeof PushWorkerAttemptWorkItemSchema
>;

export const ProviderSendOutcomeSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        state: z.literal('provider-accepted'),
        provider: z.string().trim().min(1).max(100),
        providerReference: SafeReferenceSchema,
        proof: z.null(),
        reasonCode: z.null(),
        diagnosticDigest: z.null(),
      })
      .strict(),
    z
      .object({
        state: z.literal('delivered'),
        provider: z.string().trim().min(1).max(100),
        providerReference: SafeReferenceSchema,
        proof: DeliveryProofSchema,
        reasonCode: z.null(),
        diagnosticDigest: z.null(),
      })
      .strict(),
    z
      .object({
        state: z.enum(['failed', 'expired', 'unknown']),
        provider: z.string().trim().min(1).max(100).nullable(),
        providerReference: SafeReferenceSchema.nullable(),
        proof: z.null(),
        reasonCode: SafeCodeSchema,
        diagnosticDigest: DigestSchema.nullable(),
      })
      .strict(),
  ])
  .readonly();

/** Durable outer attempt completion shared by worker and server HTTP clients. */
export const AttemptExecutionCompletionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('final'),
        outcome: ProviderSendOutcomeSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('retry'),
        outcome: ProviderSendOutcomeSchema,
        delayMilliseconds: z.number().int().nonnegative().max(86_400_000),
        nextAttemptNumber: z.number().int().positive().max(1_000),
        reasonCode: SafeCodeSchema,
      })
      .strict(),
  ])
  .readonly();

export const ExpoSendLedgerCompletionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('outcome'),
        outcome: ProviderSendOutcomeSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('failure'),
        failure: z
          .object({
            code: SafeCodeSchema,
            disposition: z.enum([
              'safe-to-retry',
              'terminal-failure',
              'ambiguous',
            ]),
            diagnosticDigest: DigestSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
  ])
  .readonly();

export const PersistedExpoReceiptTargetSchema = z
  .object({
    attempt: ChannelAttemptSchema,
    receiptId: SafeReferenceSchema,
    providerAcceptedEvidence: DeliveryEvidenceSchema,
    batchCreatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    fingerprint: DigestSchema,
  })
  .strict()
  .superRefine((target, context) => {
    if (
      target.attempt.channel !== 'push' ||
      target.providerAcceptedEvidence.state !== 'provider-accepted' ||
      target.providerAcceptedEvidence.subject.kind !== 'attempt' ||
      target.providerAcceptedEvidence.subject.attemptId !== target.attempt.id ||
      target.providerAcceptedEvidence.providerReference !== target.receiptId ||
      Date.parse(target.expiresAt) <= Date.parse(target.batchCreatedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Persisted Expo receipt target is inconsistent.',
      });
    }
  })
  .readonly();

export type PersistedExpoReceiptTargetContract = z.infer<
  typeof PersistedExpoReceiptTargetSchema
>;

const ExpoReceiptRescheduleReasonSchema = z.enum([
  'EXPO_HTTP_CLIENT_ERROR',
  'EXPO_HTTP_RATE_LIMITED',
  'EXPO_HTTP_SERVER_ERROR',
  'EXPO_INVALID_CREDENTIALS',
  'EXPO_LIVE_TRANSPORT_DISABLED',
  'EXPO_NETWORK_OUTCOME_AMBIGUOUS',
  'EXPO_RECEIPT_ERROR_UNKNOWN',
  'EXPO_RECEIPT_MISSING',
  'EXPO_RECEIPT_RESPONSE_INVALID',
  'EXPO_RESPONSE_TOO_LARGE',
]);

export const ExpoReceiptPendingActionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('terminal-failure'),
        state: z.literal('failed'),
        reasonCode: z.enum([
          'EXPO_DEVICE_NOT_REGISTERED',
          'EXPO_MESSAGE_TOO_BIG',
          'EXPO_MISMATCH_SENDER_ID',
          'EXPO_INVALID_CREDENTIALS',
          'PROVIDER_RETRY_EXHAUSTED',
        ]),
        invalidatesEndpoint: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('terminal-expiry'),
        state: z.literal('expired'),
        reasonCode: z.literal('EXPO_NOTIFICATION_EXPIRED'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('terminal-unknown'),
        state: z.literal('unknown'),
        reasonCode: z.union([
          ExpoReceiptRescheduleReasonSchema,
          z.enum([
            'EXPO_RECEIPT_HORIZON_EXPIRED',
            'EXPO_RECEIPT_REFERENCE_CONFLICT',
          ]),
        ]),
      })
      .strict(),
    z
      .object({
        kind: z.literal('resend'),
        state: z.literal('failed'),
        reasonCode: z.literal('EXPO_MESSAGE_RATE_EXCEEDED'),
        nextAttemptNumber: z.number().int().min(2).max(10),
        delayMilliseconds: z.number().int().positive().max(3_600_000),
        retryAt: TimestampSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
  ])
  .readonly();

export const ExpoReceiptDurableDecisionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('known-outcome-pending'),
        decidedAt: TimestampSchema,
        action: ExpoReceiptPendingActionSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('reschedule'),
        decidedAt: TimestampSchema,
        nextPollAt: TimestampSchema,
        nextPollAttemptNumber: z.number().int().min(2).max(10_000),
        reasonCode: ExpoReceiptRescheduleReasonSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('complete'),
        decidedAt: TimestampSchema,
        state: z.literal('provider-accepted'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('resend-scheduled'),
        decidedAt: TimestampSchema,
        state: z.literal('failed'),
        reasonCode: z.literal('EXPO_MESSAGE_RATE_EXCEEDED'),
        nextAttemptNumber: z.number().int().min(2).max(10),
        delayMilliseconds: z.number().int().positive().max(3_600_000),
        retryAt: TimestampSchema,
        expiresAt: TimestampSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('terminal-dlq'),
        decidedAt: TimestampSchema,
        state: z.enum(['failed', 'expired', 'unknown']),
        reasonCode: SafeCodeSchema,
      })
      .strict(),
  ])
  .readonly();

export const ExpoPushRuntimeRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('lookup-provider-io'),
      attemptId: UuidSchema,
      workFingerprint: DigestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('claim-provider-io'),
      attemptId: UuidSchema,
      workFingerprint: DigestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('complete-provider-io'),
      attemptId: UuidSchema,
      workFingerprint: DigestSchema,
      claimToken: UuidSchema,
      completion: ExpoSendLedgerCompletionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('schedule-receipt'),
      target: PersistedExpoReceiptTargetSchema,
      firstPollAt: TimestampSchema,
      horizonAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('claim-due-receipts'),
      now: TimestampSchema,
      limit: z.number().int().positive().max(1_000),
      leaseMilliseconds: z.number().int().min(1_000).max(900_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('decide-receipt'),
      attemptId: UuidSchema,
      fingerprint: DigestSchema,
      leaseToken: UuidSchema,
      decision: ExpoReceiptDurableDecisionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('schedule-retry'),
      sourceAttempt: ChannelAttemptSchema,
      sourceFingerprint: DigestSchema,
      receiptId: SafeReferenceSchema.nullable(),
      nextAttemptNumber: z.number().int().min(2).max(10),
      delayMilliseconds: z.number().int().positive().max(3_600_000),
      retryAt: TimestampSchema,
      expiresAt: TimestampSchema,
      reasonCode: SafeCodeSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('resolve-batch'),
      batch: DispatchBatchSchema,
      enqueuedAt: TimestampSchema,
      cursor: z.number().int().nonnegative().max(12_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('resolve-retry'),
      attemptId: UuidSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('read-stuck-outbox-count'),
    })
    .strict(),
]);

export type ExpoPushRuntimeRequest = z.infer<
  typeof ExpoPushRuntimeRequestSchema
>;

/** Destination-free SQS body for a retry retained by the server. */
export const ExpoPushAttemptReferenceMessageSchema = z
  .object({
    kind: z.literal('expo-push-attempt-reference'),
    attemptId: UuidSchema,
  })
  .strict()
  .readonly();

export type ExpoPushAttemptReferenceMessage = z.infer<
  typeof ExpoPushAttemptReferenceMessageSchema
>;
