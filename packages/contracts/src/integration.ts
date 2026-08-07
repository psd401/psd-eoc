import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './shared';

/**
 * Owns the binding integration-truth vocabulary used in documentation,
 * configuration, admin surfaces, and worker health. A successful mock never
 * upgrades an integration to a live claim.
 */
export const IntegrationTruthLabelSchema = z.enum([
  'mocked',
  'configured-unverified',
  'live-verified',
  'blocked',
]);

/** Binding integration-truth label inferred from its schema. */
export type IntegrationTruthLabel = z.infer<typeof IntegrationTruthLabelSchema>;

/**
 * Owns a stable kebab-case external-integration identifier shared by adapters,
 * configuration, and health queries without constraining future providers.
 */
export const IntegrationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** Stable external-integration identifier inferred from its schema. */
export type IntegrationId = z.infer<typeof IntegrationIdSchema>;

/**
 * Owns one truthful integration-status record. Verification timestamps exist
 * only for live-verified integrations; blocked integrations carry a bounded
 * safe reason code rather than raw provider output or credentials.
 */
export const IntegrationStatusSchema = z
  .object({
    integrationId: IntegrationIdSchema,
    label: IntegrationTruthLabelSchema,
    verifiedAt: TimestampSchema.nullable(),
    verifiedByUserId: UuidSchema.nullable(),
    authorizationReference: z.string().trim().min(1).max(255).nullable(),
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
    observedAt: TimestampSchema,
  })
  .strict()
  .superRefine((status, context) => {
    const verificationFieldCount = [
      status.verifiedAt,
      status.verifiedByUserId,
      status.authorizationReference,
    ].filter((value) => value !== null).length;
    if (
      (status.label === 'live-verified' && verificationFieldCount !== 3) ||
      (status.label !== 'live-verified' && verificationFieldCount !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Live verification requires complete provenance; every other label forbids verification claims.',
        path: ['verifiedAt'],
      });
    }
    if ((status.label === 'blocked') !== (status.reasonCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only blocked integrations require a safe reason code.',
        path: ['reasonCode'],
      });
    }
    if (
      status.verifiedAt &&
      Date.parse(status.verifiedAt) > Date.parse(status.observedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Verification time cannot follow status observation.',
        path: ['verifiedAt'],
      });
    }
  })
  .readonly();

/** Truthful external-integration status inferred from its schema. */
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

/** Owns a bounded integration-health read filter. */
export const GetIntegrationHealthInputSchema = z
  .object({
    integrationId: IntegrationIdSchema.nullable(),
  })
  .strict()
  .readonly();

/** Integration-health read input inferred from its schema. */
export type GetIntegrationHealthInput = z.infer<
  typeof GetIntegrationHealthInputSchema
>;

/** Owns a truthful integration-health snapshot without provider payloads. */
export const IntegrationHealthSchema = z
  .object({
    statuses: z.array(IntegrationStatusSchema).max(100).readonly(),
    observedAt: TimestampSchema,
  })
  .strict()
  .superRefine((health, context) => {
    if (
      new Set(health.statuses.map((status) => status.integrationId)).size !==
      health.statuses.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Integration health rows must be unique.',
        path: ['statuses'],
      });
    }
    health.statuses.forEach((status, index) => {
      if (status.observedAt !== health.observedAt) {
        context.addIssue({
          code: 'custom',
          message: 'Integration health rows must share one observation time.',
          path: ['statuses', index, 'observedAt'],
        });
      }
    });
  })
  .readonly();

/** Truthful integration-health snapshot inferred from its schema. */
export type IntegrationHealth = z.infer<typeof IntegrationHealthSchema>;

/**
 * Owns an administrative channel enablement request. Provider credentials,
 * verification claims, and authorizer identity never enter caller input. A
 * non-secret product-owner approval reference is mandatory for every live
 * provider configuration change and is verified server-side fail-closed.
 */
export const SetChannelEnabledInputSchema = z
  .object({
    integrationId: IntegrationIdSchema,
    enabled: z.boolean(),
    productOwnerApprovalReference: z.string().trim().min(1).max(255),
  })
  .strict()
  .readonly();

/** Channel enablement input inferred from its schema. */
export type SetChannelEnabledInput = z.infer<
  typeof SetChannelEnabledInputSchema
>;

/**
 * Owns the non-secret channel configuration returned after an authorized
 * administrative change. Truth status is repeated so enabled never implies
 * live-verified by itself.
 */
export const ChannelConfigurationSchema = z
  .object({
    integrationId: IntegrationIdSchema,
    enabled: z.boolean(),
    status: IntegrationStatusSchema,
    changedAt: TimestampSchema,
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.integrationId !== configuration.status.integrationId) {
      context.addIssue({
        code: 'custom',
        message: 'Channel configuration and truth status must agree.',
        path: ['status', 'integrationId'],
      });
    }
    if (configuration.enabled && configuration.status.label === 'blocked') {
      context.addIssue({
        code: 'custom',
        message: 'A blocked integration cannot be enabled.',
        path: ['enabled'],
      });
    }
  })
  .readonly();

/** Non-secret channel configuration inferred from its schema. */
export type ChannelConfiguration = z.infer<typeof ChannelConfigurationSchema>;
