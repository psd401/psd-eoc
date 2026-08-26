import { z } from 'zod';

import {
  ChannelAttemptSchema,
  DispatchBatchSchema,
  RecordSmsOptOutInputSchema,
  SmsLifecycleCapabilityContextSchema,
} from './notification';
import { ProviderSendOutcomeSchema } from './push-runtime';
import { RosterPopulationSchema, SmsEndpointSchema } from './roster';
import { TimestampSchema, UuidSchema } from './shared';

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const SafeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_]+$/u);
const ProviderReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,499}$/u);
const PhoneNumberSchema = z.string().regex(/^\+[1-9]\d{7,14}$/u);

/** Maximum total age of an SMS batch, including queue and retry delay. */
export const SMS_TOTAL_LIFETIME_SECONDS = 300;

/** AWS accepts integer SMS retention windows no shorter than five seconds. */
export const SMS_PROVIDER_MINIMUM_TTL_SECONDS = 5;

/** Fresh server authority carried directly to the irreversible provider call. */
export const SmsProviderSendAuthorizationSchema = z
  .discriminatedUnion('authorized', [
    z.object({ authorized: z.literal(false) }).strict(),
    z
      .object({
        authorized: z.literal(true),
        timeToLiveSeconds: z
          .number()
          .int()
          .min(SMS_PROVIDER_MINIMUM_TTL_SECONDS)
          .max(SMS_TOTAL_LIFETIME_SECONDS),
      })
      .strict(),
  ])
  .readonly();

export type SmsProviderSendAuthorization = z.infer<
  typeof SmsProviderSendAuthorizationSchema
>;

/** Exact SMS endpoint attempt released by the trusted server resolver. */
export const SmsWorkerAttemptWorkItemSchema = z
  .object({
    batch: DispatchBatchSchema,
    attempt: ChannelAttemptSchema,
    endpoint: SmsEndpointSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.batch.channel !== 'sms' ||
      item.attempt.channel !== 'sms' ||
      item.endpoint.channel !== 'sms' ||
      item.batch.id !== item.attempt.batchId ||
      item.batch.intentId !== item.attempt.intentId ||
      item.batch.eventId !== item.attempt.eventId ||
      item.batch.rosterSnapshotId !== item.attempt.rosterSnapshotId ||
      item.batch.rosterPopulation !== item.attempt.rosterPopulation ||
      item.attempt.recipientId === '' ||
      item.attempt.endpointId !== item.endpoint.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'SMS worker attempt identities must match exactly.',
      });
    }
  })
  .readonly();

export type SmsWorkerAttemptWorkItem = z.infer<
  typeof SmsWorkerAttemptWorkItemSchema
>;

/** Durable result of the irreversible AWS SendTextMessage boundary. */
export const SmsProviderIoCompletionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('outcome'),
        outcome: ProviderSendOutcomeSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('provider-error'),
        code: SafeCodeSchema,
        disposition: z.enum(['safe-to-retry', 'terminal-failure', 'ambiguous']),
        diagnosticDigest: DigestSchema.nullable(),
      })
      .strict(),
  ])
  .readonly();

export type SmsProviderIoCompletion = z.infer<
  typeof SmsProviderIoCompletionSchema
>;

/** Worker-to-server contract for the complete SMS runtime state boundary. */
export const SmsRuntimeRequestSchema = z.discriminatedUnion('operation', [
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
      completion: SmsProviderIoCompletionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('schedule-retry'),
      sourceAttempt: ChannelAttemptSchema,
      sourceFingerprint: DigestSchema,
      nextAttemptNumber: z.number().int().min(2).max(10),
      delayMilliseconds: z.number().int().positive().max(3_600_000),
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
      operation: z.literal('authorize-provider-send'),
      workItem: SmsWorkerAttemptWorkItemSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('authorize-live-send'),
      context: z
        .object({
          attemptId: UuidSchema,
          batchId: UuidSchema,
          eventId: UuidSchema,
          eventKind: z.enum(['incident', 'drill', 'test']),
          templateMode: z.enum(['real', 'drill']),
          purpose: z.enum(['activation', 'all-clear', 'reactivation']),
          requestId: UuidSchema,
          authorizationKind: z.string().trim().min(1).max(100),
          integrationAuthorizationReference: z.string().trim().min(1).max(255),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('record-sms-opt-out'),
      context: SmsLifecycleCapabilityContextSchema,
      input: RecordSmsOptOutInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('resolve-sms-destination'),
      rosterSnapshotId: UuidSchema,
      phoneNumber: PhoneNumberSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('load-attempt-by-provider-reference'),
      providerReference: ProviderReferenceSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('load-unknown-attempt'),
      attemptId: UuidSchema,
      correlationToken: UuidSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('list-current-roster-snapshots'),
    })
    .strict(),
]);

export type SmsRuntimeRequest = z.infer<typeof SmsRuntimeRequestSchema>;

/** Destination-free SQS body for one persisted SMS retry. */
export const SmsAttemptReferenceMessageSchema = z
  .object({
    kind: z.literal('sms-attempt-reference'),
    attemptId: UuidSchema,
  })
  .strict()
  .readonly();

/** Scheduled, destination-free request to reconcile provider STOP truth. */
export const SmsOptOutReconciliationMessageSchema = z
  .object({
    kind: z.literal('sms-opt-out-reconciliation'),
  })
  .strict()
  .readonly();

export const CurrentRosterSnapshotSchema = z
  .object({
    id: UuidSchema,
    population: RosterPopulationSchema,
  })
  .strict()
  .readonly();

export type CurrentRosterSnapshot = z.infer<typeof CurrentRosterSnapshotSchema>;
