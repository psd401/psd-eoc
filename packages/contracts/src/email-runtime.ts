import { z } from 'zod';

import { ChannelAttemptSchema, DispatchBatchSchema } from './notification';
import { ProviderSendOutcomeSchema } from './push-runtime';
import { EndpointSchema } from './roster';
import { TimestampSchema, UuidSchema } from './shared';

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Exact deploy-time evidence reference shared by the email worker and server. */
export const SesVerificationReferenceSchema = z
  .string()
  .min(16)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/u);

/** Exact email endpoint attempt released by the trusted server resolver. */
export const EmailWorkerAttemptWorkItemSchema = z
  .object({
    batch: DispatchBatchSchema,
    attempt: ChannelAttemptSchema,
    endpoint: EndpointSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.batch.channel !== 'email' ||
      item.attempt.channel !== 'email' ||
      item.endpoint.channel !== 'email' ||
      item.batch.id !== item.attempt.batchId ||
      item.batch.intentId !== item.attempt.intentId ||
      item.batch.eventId !== item.attempt.eventId ||
      item.batch.rosterSnapshotId !== item.attempt.rosterSnapshotId ||
      item.batch.rosterPopulation !== item.attempt.rosterPopulation ||
      item.attempt.recipientId.length === 0 ||
      item.attempt.endpointId !== item.endpoint.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Email worker attempt identities must match exactly.',
      });
    }
  })
  .readonly();

export type EmailWorkerAttemptWorkItem = z.infer<
  typeof EmailWorkerAttemptWorkItemSchema
>;

/** Destination-free reference for one server-authorized retry attempt. */
export const EmailAttemptReferenceMessageSchema = z
  .object({
    kind: z.literal('ses-email-attempt-reference'),
    sourceAttemptId: UuidSchema,
  })
  .strict()
  .readonly();

export type EmailAttemptReferenceMessage = z.infer<
  typeof EmailAttemptReferenceMessageSchema
>;

export const SesSendLedgerClaimSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('acquired'), leaseToken: UuidSchema }).strict(),
  z.object({ kind: z.literal('denied') }).strict(),
  z.object({ kind: z.literal('in-progress') }).strict(),
  z.object({ kind: z.literal('conflict') }).strict(),
  z
    .object({
      kind: z.literal('completed'),
      outcome: ProviderSendOutcomeSchema,
    })
    .strict(),
]);

export const EmailBatchResolutionPageSchema = z
  .object({
    items: z.array(EmailWorkerAttemptWorkItemSchema).max(100),
    nextCursor: z.number().int().nonnegative().max(12_000).nullable(),
    suppressedCount: z.number().int().nonnegative().max(12_000),
  })
  .strict()
  .readonly();

export const EmailRetryResolutionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ready'),
      workItem: EmailWorkerAttemptWorkItemSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('not-before'),
      retryAt: TimestampSchema,
    })
    .strict(),
  z.object({ kind: z.literal('expired') }).strict(),
  z.object({ kind: z.literal('ineligible') }).strict(),
]);

/** Small authenticated state API used only by the isolated email worker. */
export const EmailRuntimeRequestSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        operation: z.literal('claim-provider-io'),
        verificationReference: SesVerificationReferenceSchema,
        attemptId: UuidSchema,
        requestFingerprint: DigestSchema,
        workItem: EmailWorkerAttemptWorkItemSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('complete-provider-io'),
        verificationReference: SesVerificationReferenceSchema,
        attemptId: UuidSchema,
        requestFingerprint: DigestSchema,
        leaseToken: UuidSchema,
        outcome: ProviderSendOutcomeSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('resolve-batch'),
        verificationReference: SesVerificationReferenceSchema,
        batch: DispatchBatchSchema,
        enqueuedAt: TimestampSchema,
        cursor: z.number().int().nonnegative().max(12_000),
      })
      .strict(),
    z
      .object({
        operation: z.literal('resolve-retry'),
        verificationReference: SesVerificationReferenceSchema,
        sourceAttemptId: UuidSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal('authorize-provider-send'),
        verificationReference: SesVerificationReferenceSchema,
        workItem: EmailWorkerAttemptWorkItemSchema,
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (
      request.operation === 'claim-provider-io' &&
      request.attemptId !== request.workItem.attempt.id
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The provider claim must identify its exact work item.',
        path: ['attemptId'],
      });
    }
  });

export type EmailRuntimeRequest = z.infer<typeof EmailRuntimeRequestSchema>;
