import {
  ChannelConfigurationSchema,
  IntegrationIdSchema,
  IntegrationHealthSchema,
  type CapabilityInput,
  type ChannelConfiguration,
  type IntegrationStatus,
  type SetChannelEnabledInput,
  type IntegrationHealth,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';

import { channelConfigurations, integrationStatuses } from '../../../db/schema';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  digestCapabilityValue,
  readCapabilityTime,
  type ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  executeAdminMutationCapability,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminMutationMetadata,
  type AdminQueryMetadata,
} from '../facilities/admin-core';

export const SMS_INTEGRATION_ID = 'aws-eum-sms' as const;

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

/**
 * Enforces the issue #26 channel boundary independently of presentation state.
 * SMS stays dark until the external carrier-registration work is complete, and
 * every change to a live-verified integration must reproduce the exact
 * non-secret product-owner authorization reference stored with verification.
 */
export function assertChannelChangeAllowed(
  input: SetChannelEnabledInput,
  status: IntegrationStatus,
): void {
  if (input.enabled && input.integrationId === SMS_INTEGRATION_ID) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'SMS remains disabled until carrier registration is complete and separately verified.',
      409,
    );
  }
  if (input.enabled && status.label === 'blocked') {
    throw new AdminCapabilityError(
      'CONFLICT',
      'A blocked integration cannot be enabled.',
      409,
    );
  }
  if (input.enabled && status.label === 'configured-unverified') {
    throw new AdminCapabilityError(
      'CONFLICT',
      'An unverified integration cannot be enabled.',
      409,
    );
  }
  if (
    status.label === 'live-verified' &&
    status.authorizationReference !== input.productOwnerApprovalReference
  ) {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'The product-owner approval reference was not verified.',
      403,
    );
  }
}

function statusFromRow(
  row: Readonly<{
    integrationId: string;
    label: 'mocked' | 'configured-unverified' | 'live-verified' | 'blocked';
    verifiedAt: Date | null;
    verifiedByUserId: string | null;
    authorizationReference: string | null;
    reasonCode: string | null;
    observedAt: Date;
  }>,
  observedAt = row.observedAt,
) {
  return {
    integrationId: row.integrationId,
    label: row.label,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifiedByUserId: row.verifiedByUserId,
    authorizationReference: row.authorizationReference,
    reasonCode: row.reasonCode,
    observedAt: observedAt.toISOString(),
  } as const;
}

async function latestStatuses(
  transaction: AdminCapabilityTransaction,
  integrationId: string | null,
) {
  return transaction.database
    .selectDistinctOn([integrationStatuses.integrationId], {
      id: integrationStatuses.id,
      integrationId: integrationStatuses.integrationId,
      label: integrationStatuses.label,
      verifiedAt: integrationStatuses.verifiedAt,
      verifiedByUserId: integrationStatuses.verifiedByUserId,
      authorizationReference: integrationStatuses.authorizationReference,
      reasonCode: integrationStatuses.reasonCode,
      observedAt: integrationStatuses.observedAt,
    })
    .from(integrationStatuses)
    .where(
      integrationId === null
        ? undefined
        : eq(integrationStatuses.integrationId, integrationId),
    )
    .orderBy(
      asc(integrationStatuses.integrationId),
      desc(integrationStatuses.observedAt),
      desc(integrationStatuses.id),
    )
    .limit(100);
}

async function channelConfigurationProjection(
  transaction: AdminCapabilityTransaction,
): Promise<readonly ChannelConfiguration[]> {
  const rows = await transaction.database
    .select({
      integrationId: channelConfigurations.integrationId,
      enabled: channelConfigurations.enabled,
      changedAt: channelConfigurations.changedAt,
      label: integrationStatuses.label,
      verifiedAt: integrationStatuses.verifiedAt,
      verifiedByUserId: integrationStatuses.verifiedByUserId,
      authorizationReference: integrationStatuses.authorizationReference,
      reasonCode: integrationStatuses.reasonCode,
      observedAt: integrationStatuses.observedAt,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      and(
        eq(
          integrationStatuses.integrationId,
          channelConfigurations.integrationId,
        ),
        eq(integrationStatuses.id, channelConfigurations.statusId),
        eq(integrationStatuses.label, channelConfigurations.statusLabel),
      ),
    )
    .orderBy(asc(channelConfigurations.integrationId))
    .limit(100);

  return Object.freeze(
    rows.map((row) =>
      ChannelConfigurationSchema.parse({
        integrationId: row.integrationId,
        enabled: row.enabled,
        status: statusFromRow(row),
        changedAt: row.changedAt.toISOString(),
      }),
    ),
  );
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
      const observedAt = await readCapabilityTime(context);
      const [statuses, channels] = await Promise.all([
        latestStatuses(context.transaction, input.integrationId),
        channelConfigurationProjection(context.transaction),
      ]);
      captureProjection(channels);
      return IntegrationHealthSchema.parse({
        statuses: statuses.map((status) => statusFromRow(status, observedAt)),
        observedAt: observedAt.toISOString(),
      });
    },
  };
}

async function loadChannelConfiguration(
  transaction: AdminCapabilityTransaction,
  integrationId: string,
): Promise<ChannelConfiguration | null> {
  const rows = await transaction.database
    .select({
      integrationId: channelConfigurations.integrationId,
      enabled: channelConfigurations.enabled,
      changedAt: channelConfigurations.changedAt,
      label: integrationStatuses.label,
      verifiedAt: integrationStatuses.verifiedAt,
      verifiedByUserId: integrationStatuses.verifiedByUserId,
      authorizationReference: integrationStatuses.authorizationReference,
      reasonCode: integrationStatuses.reasonCode,
      observedAt: integrationStatuses.observedAt,
    })
    .from(channelConfigurations)
    .innerJoin(
      integrationStatuses,
      and(
        eq(
          integrationStatuses.integrationId,
          channelConfigurations.integrationId,
        ),
        eq(integrationStatuses.id, channelConfigurations.statusId),
        eq(integrationStatuses.label, channelConfigurations.statusLabel),
      ),
    )
    .where(eq(channelConfigurations.integrationId, integrationId))
    .limit(1);
  const row = rows[0];
  return row === undefined
    ? null
    : ChannelConfigurationSchema.parse({
        integrationId: row.integrationId,
        enabled: row.enabled,
        status: statusFromRow(row),
        changedAt: row.changedAt.toISOString(),
      });
}

export const setChannelEnabledRegistration: ServerCapabilityRegistration<
  'set-channel-enabled',
  AdminCapabilityTransaction
> = {
  id: 'set-channel-enabled',
  async resolveFacilityId(_input, context) {
    requireAdminCapabilityAuthorization(
      context.invocation.actor,
      context.transaction,
    );
    return null;
  },
  async handler(input, context) {
    const [status] = await latestStatuses(
      context.transaction,
      input.integrationId,
    );
    if (status === undefined) {
      throw new AdminCapabilityError(
        'NOT_FOUND',
        'The integration status was not found.',
        404,
      );
    }
    assertChannelChangeAllowed(input, statusFromRow(status));

    const changedAt = await readCapabilityTime(context);
    await context.transaction.database
      .insert(channelConfigurations)
      .values({
        integrationId: input.integrationId,
        enabled: input.enabled,
        statusId: status.id,
        statusLabel: status.label,
        changedAt,
      })
      .onConflictDoUpdate({
        target: channelConfigurations.integrationId,
        set: {
          enabled: input.enabled,
          statusId: status.id,
          statusLabel: status.label,
          changedAt,
        },
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

/** Executes the canonical health query and captures its typed channel projection. */
export async function executeIntegrationHealthProjection(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: CapabilityInput<'get-integration-health'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<IntegrationHealthProjection> {
  let channels: readonly ChannelConfiguration[] | null = null;
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  const health = await executeAdminQueryCapability(
    getIntegrationHealthRegistration((value) => {
      channels = value;
    }),
    input.query,
    input.authenticated,
    store,
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
