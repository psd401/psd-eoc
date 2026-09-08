import {
  ChannelConfigurationSchema,
  IntegrationHealthSchema,
  IntegrationIdSchema,
  type CapabilityInput,
  type ChannelConfiguration,
  type IntegrationHealth,
} from '@psd-eoc/contracts';
import { asc, eq } from 'drizzle-orm';

import { channelConfigurations } from '../../../db/schema';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  digestCapabilityValue,
  readCapabilityTime,
  type ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  createRepeatableReadAdminQueryStoreFromStore,
  executeAdminMutationCapability,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminMutationMetadata,
  type AdminQueryDatabase,
  type AdminQueryMetadata,
} from '../../../lib/capabilities/admin';

export const SMS_INTEGRATION_ID = 'aws-eum-sms' as const;
export const MOBILE_PUSH_INTEGRATION_ID = 'mobile-push' as const;

function channelResultReference(configuration: ChannelConfiguration): string {
  return Buffer.from(
    JSON.stringify({
      integrationId: configuration.integrationId,
      outputDigest: digestCapabilityValue(configuration),
    }),
    'utf8',
  ).toString('base64url');
}

function parseChannelResultReference(value: string): Readonly<{
  integrationId: string;
  outputDigest: string;
}> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) throw new TypeError();
    const outputDigest = Reflect.get(parsed, 'outputDigest');
    if (
      typeof outputDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(outputDigest)
    ) {
      throw new TypeError();
    }
    return Object.freeze({
      integrationId: IntegrationIdSchema.parse(
        Reflect.get(parsed, 'integrationId'),
      ),
      outputDigest,
    });
  } catch {
    throw new AdminCapabilityError(
      'CONFLICT',
      'The channel replay reference is invalid.',
      409,
    );
  }
}

function configurationFromRow(
  row: typeof channelConfigurations.$inferSelect,
): ChannelConfiguration {
  return ChannelConfigurationSchema.parse({
    integrationId: row.integrationId,
    enabled: row.enabled,
    changedAt: row.changedAt.toISOString(),
  });
}

async function channelConfigurationProjection(
  database: AdminQueryDatabase,
): Promise<readonly ChannelConfiguration[]> {
  const rows = await database
    .select()
    .from(channelConfigurations)
    .orderBy(asc(channelConfigurations.integrationId))
    .limit(100);
  return Object.freeze(rows.map(configurationFromRow));
}

interface IntegrationHealthProjection {
  readonly health: IntegrationHealth;
  readonly channels: readonly ChannelConfiguration[];
}

function getIntegrationHealthRegistration(
  captureProjection: (channels: readonly ChannelConfiguration[]) => void,
): ServerCapabilityRegistration<
  'get-integration-health',
  AdminCapabilityTransaction
> {
  return {
    id: 'get-integration-health',
    async resolveFacilityId(_input, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      return null;
    },
    async handler(input, context) {
      const channels = (
        await channelConfigurationProjection(context.transaction.database)
      ).filter(
        (channel) =>
          input.integrationId === null ||
          channel.integrationId === input.integrationId,
      );
      const observedAt = await readCapabilityTime(context);
      captureProjection(channels);
      return IntegrationHealthSchema.parse({
        channels,
        observedAt: observedAt.toISOString(),
      });
    },
  };
}

async function loadChannelConfiguration(
  transaction: AdminCapabilityTransaction,
  integrationId: string,
): Promise<ChannelConfiguration | null> {
  const [row] = await transaction.database
    .select()
    .from(channelConfigurations)
    .where(eq(channelConfigurations.integrationId, integrationId))
    .limit(1);
  return row === undefined ? null : configurationFromRow(row);
}

/**
 * A district administrator turns a notification channel on or off. Enablement
 * is the whole switch: whether a provider works is discovered by sending, and
 * the audit trail records who flipped it and when.
 */
export function createSetChannelEnabledRegistration(): ServerCapabilityRegistration<
  'set-channel-enabled',
  AdminCapabilityTransaction
> {
  return {
    id: 'set-channel-enabled',
    async resolveFacilityId(_input, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      return null;
    },
    async handler(input, context) {
      if (context.invocation.actor.kind !== 'human') {
        throw new AdminCapabilityError(
          'FORBIDDEN',
          'A human district administrator must change a notification channel.',
          403,
        );
      }
      const changedAt = await readCapabilityTime(context);
      await context.transaction.database
        .insert(channelConfigurations)
        .values({
          integrationId: input.integrationId,
          enabled: input.enabled,
          changedAt,
        })
        .onConflictDoUpdate({
          target: channelConfigurations.integrationId,
          set: { enabled: input.enabled, changedAt },
        });
      const result = await loadChannelConfiguration(
        context.transaction,
        input.integrationId,
      );
      if (result === null) {
        throw new AdminCapabilityError(
          'INTERNAL_ERROR',
          'The channel configuration could not be reloaded.',
          500,
        );
      }
      return result;
    },
    resultReference: channelResultReference,
    async loadReplay(resultReference, context) {
      const parsed = parseChannelResultReference(resultReference);
      const result = await loadChannelConfiguration(
        context.transaction,
        parsed.integrationId,
      );
      if (result === null) {
        throw new AdminCapabilityError(
          'NOT_FOUND',
          'The previous channel configuration is unavailable.',
          404,
        );
      }
      if (digestCapabilityValue(result) !== parsed.outputDigest) {
        throw new AdminCapabilityError(
          'CONFLICT',
          'The original channel result is no longer reconstructable; replay was refused rather than returning changed data.',
          409,
        );
      }
      return result;
    },
    resolveReplayFacilityId(resultReference, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      parseChannelResultReference(resultReference);
      return null;
    },
    replayFacilityId: () => null,
  };
}

export const setChannelEnabledRegistration =
  createSetChannelEnabledRegistration();

/** Executes the canonical health query and captures its typed channel projection. */
export async function executeIntegrationHealthProjection(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: CapabilityInput<'get-integration-health'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<IntegrationHealthProjection> {
  let channels: readonly ChannelConfiguration[] | null = null;
  const injectedStore =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  const snapshotStore =
    createRepeatableReadAdminQueryStoreFromStore(injectedStore);
  const health = await executeAdminQueryCapability(
    getIntegrationHealthRegistration((value) => {
      channels = value;
    }),
    input.query,
    input.authenticated,
    snapshotStore,
    input.metadata,
  );
  if (channels === null) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'The channel-health projection was not produced.',
      500,
    );
  }
  return Object.freeze({ health, channels });
}

/** Executes audited channel enablement through the canonical capability engine. */
export function executeSetChannelEnabledCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'set-channel-enabled'>;
  readonly metadata: AdminMutationMetadata;
  readonly store?: AdminCapabilityStore;
}): Promise<ChannelConfiguration> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  return executeAdminMutationCapability(
    setChannelEnabledRegistration,
    input.command,
    input.authenticated,
    store,
    input.metadata,
  );
}
