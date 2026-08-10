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

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CanonicalAuthorizationUuidSchema = UuidSchema.transform((value) =>
  value.toLowerCase(),
);
const ChannelAuthorizationTimestampSchema = TimestampSchema.refine((value) => {
  const fractionalSeconds = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1];
  return fractionalSeconds === undefined || fractionalSeconds.length <= 3;
}, 'Channel-change authorization timestamps support at most millisecond precision.');

/**
 * Owns the complete, pre-issued product-owner authorization for one live
 * channel configuration change. The canonical digest of this artifact is
 * stored as the live integration status's non-secret authorization reference;
 * the artifact itself therefore cannot be altered or copied to a different
 * integration, desired state, request, consequence, human, or session.
 */
export const IntegrationChannelChangeAuthorizationSchema = z
  .object({
    reference: z.string().trim().min(1).max(255),
    integrationStatusId: CanonicalAuthorizationUuidSchema,
    integrationId: IntegrationIdSchema,
    desiredEnabled: z.boolean(),
    requestDigest: Sha256DigestSchema,
    consequenceDigest: Sha256DigestSchema,
    authorizedByUserId: CanonicalAuthorizationUuidSchema,
    authorizedWithSessionId: CanonicalAuthorizationUuidSchema,
    issuedAt: ChannelAuthorizationTimestampSchema,
    expiresAt: ChannelAuthorizationTimestampSchema,
  })
  .strict()
  .superRefine((authorization, context) => {
    const issuedAt = Date.parse(authorization.issuedAt);
    const expiresAt = Date.parse(authorization.expiresAt);
    if (expiresAt <= issuedAt || expiresAt > issuedAt + 15 * 60 * 1_000) {
      context.addIssue({
        code: 'custom',
        message:
          'Live channel-change authorization must expire within 15 minutes of issuance.',
        path: ['expiresAt'],
      });
    }
  })
  .readonly();

/** Immutable live channel-change authorization inferred from its schema. */
export type IntegrationChannelChangeAuthorization = z.infer<
  typeof IntegrationChannelChangeAuthorizationSchema
>;

/**
 * Owns an administrative channel enablement request. Provider credentials
 * never enter caller input. A pre-issued, non-secret authorization artifact is
 * optional at this outer boundary because mocked changes require none; the
 * capability layer verifies its authorizer and status claims against immutable
 * database evidence and consumes it fail-closed for every live provider change.
 */
export const SetChannelEnabledInputSchema = z
  .object({
    integrationId: IntegrationIdSchema,
    enabled: z.boolean(),
    authorization: IntegrationChannelChangeAuthorizationSchema.nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.authorization !== null &&
      input.authorization.integrationId !== input.integrationId
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Channel-change authorization must name the requested integration.',
        path: ['authorization', 'integrationId'],
      });
    }
    if (
      input.authorization !== null &&
      input.authorization.desiredEnabled !== input.enabled
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Channel-change authorization must name the requested enabled state.',
        path: ['authorization', 'desiredEnabled'],
      });
    }
  })
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
