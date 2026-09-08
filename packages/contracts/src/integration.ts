import { z } from 'zod';

import { TimestampSchema } from './shared';

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
 * Owns an administrative channel enablement request. Provider credentials
 * never enter caller input. Enablement is the whole switch: whether a provider
 * works is discovered by sending, not by a hand-maintained label.
 */
export const SetChannelEnabledInputSchema = z
  .object({
    integrationId: IntegrationIdSchema,
    enabled: z.boolean(),
  })
  .strict()
  .readonly();

/** Channel enablement input inferred from its schema. */
export type SetChannelEnabledInput = z.infer<
  typeof SetChannelEnabledInputSchema
>;

/** Owns the non-secret channel configuration: one enabled flag per channel. */
export const ChannelConfigurationSchema = z
  .object({
    integrationId: IntegrationIdSchema,
    enabled: z.boolean(),
    changedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Non-secret channel configuration inferred from its schema. */
export type ChannelConfiguration = z.infer<typeof ChannelConfigurationSchema>;

/** Owns the bounded list of every channel configuration. */
export const IntegrationHealthSchema = z
  .object({
    channels: z.array(ChannelConfigurationSchema).max(100).readonly(),
    observedAt: TimestampSchema,
  })
  .strict()
  .superRefine((list, context) => {
    if (
      new Set(list.channels.map((channel) => channel.integrationId)).size !==
      list.channels.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Channel configurations must be unique.',
        path: ['channels'],
      });
    }
  })
  .readonly();

/** Channel configuration list inferred from its schema. */
export type IntegrationHealth = z.infer<typeof IntegrationHealthSchema>;

/** Owns a bounded channel-configuration read filter. */
export const GetIntegrationHealthInputSchema = z
  .object({
    integrationId: IntegrationIdSchema.nullable(),
  })
  .strict()
  .readonly();

/** Channel configuration read input inferred from its schema. */
export type GetIntegrationHealthInput = z.infer<
  typeof GetIntegrationHealthInputSchema
>;
