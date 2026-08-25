import {
  ChannelConfigurationSchema,
  IntegrationChannelChangeAuthorizationSchema,
  IntegrationIdSchema,
  IntegrationHealthSchema,
  type Actor,
  type CapabilityInput,
  type ChannelConfiguration,
  type IntegrationChannelChangeAuthorization,
  type IntegrationStatus,
  type SetChannelEnabledInput,
  type IntegrationHealth,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import {
  channelConfigurations,
  integrationChannelChangeAuthorizations,
  integrationStatuses,
} from '../../../db/schema';
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

interface ChannelConfigurationState {
  readonly enabled: boolean;
  readonly statusId: string;
}

interface LiveStatusRow {
  readonly id: string;
  readonly integrationId: string;
  readonly label:
    | 'mocked'
    | 'configured-unverified'
    | 'live-verified'
    | 'blocked';
  readonly verifiedAt: Date | null;
  readonly verifiedByUserId: string | null;
  readonly authorizationReference: string | null;
  readonly reasonCode: string | null;
  readonly observedAt: Date;
}

/** Canonical pre-issued request commitment for one exact desired state. */
export function liveChannelChangeRequestDigest(
  authorization: Pick<
    IntegrationChannelChangeAuthorization,
    'integrationId' | 'desiredEnabled' | 'reference'
  >,
): string {
  return digestCapabilityValue({
    kind: 'set-channel-enabled-request-v1',
    integrationId: authorization.integrationId,
    desiredEnabled: authorization.desiredEnabled,
    reference: authorization.reference,
  });
}

/** Canonical consequence commitment, including the configuration it replaces. */
export function liveChannelChangeConsequenceDigest(input: {
  readonly integrationId: string;
  readonly previousConfiguration: ChannelConfigurationState | null;
  readonly desiredEnabled: boolean;
  readonly integrationStatusId: string;
}): string {
  return digestCapabilityValue({
    kind: 'live-channel-change-consequence-v1',
    integrationId: input.integrationId,
    previousConfiguration: input.previousConfiguration,
    desiredConfiguration: {
      enabled: input.desiredEnabled,
      statusId: input.integrationStatusId,
    },
  });
}

/** Canonical commitment persisted on the immutable live status issuance row. */
export function liveChannelChangeAuthorizationCommitment(
  authorization: IntegrationChannelChangeAuthorization,
): string {
  return digestCapabilityValue({
    kind: 'live-channel-change-authorization-v1',
    ...authorization,
  });
}

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
 * every live-verified change requires a pre-issued authorization artifact.
 * The handler additionally verifies its status, human, session, state,
 * digests, commitment, expiry, and single-use persistence.
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
  if (status.label === 'live-verified' && input.authorization === null) {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'Fresh product-owner authorization is required for this live channel change.',
      403,
    );
  }
  if (status.label !== 'live-verified' && input.authorization !== null) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'Live authorization evidence cannot be applied to a non-live integration status.',
      409,
    );
  }
}

function invalidLiveAuthorization(): AdminCapabilityError {
  return new AdminCapabilityError(
    'FORBIDDEN',
    'The live channel authorization is missing, expired, already consumed, or does not match this exact request.',
    403,
  );
}

function assertExactLiveAuthorization(input: {
  readonly actor: Actor;
  readonly authorization: IntegrationChannelChangeAuthorization;
  readonly status: LiveStatusRow;
  readonly previousConfiguration: ChannelConfigurationState | null;
  readonly consumedAt: Date;
}): string {
  const authorization = IntegrationChannelChangeAuthorizationSchema.parse(
    input.authorization,
  );
  const status = input.status;
  const issuedAt = new Date(authorization.issuedAt);
  const expiresAt = new Date(authorization.expiresAt);
  if (
    input.actor.kind !== 'human' ||
    status.label !== 'live-verified' ||
    status.verifiedAt === null ||
    status.verifiedByUserId === null ||
    status.authorizationReference === null ||
    authorization.integrationStatusId !== status.id ||
    authorization.integrationId !== status.integrationId ||
    authorization.authorizedByUserId !== status.verifiedByUserId ||
    authorization.authorizedByUserId !== input.actor.userId ||
    authorization.authorizedWithSessionId !== input.actor.sessionId ||
    issuedAt.getTime() !== status.verifiedAt.getTime()
  ) {
    throw invalidLiveAuthorization();
  }

  if (input.consumedAt < issuedAt || input.consumedAt > expiresAt) {
    throw invalidLiveAuthorization();
  }
  const expectedRequestDigest = liveChannelChangeRequestDigest(authorization);
  const expectedConsequenceDigest = liveChannelChangeConsequenceDigest({
    integrationId: authorization.integrationId,
    previousConfiguration: input.previousConfiguration,
    desiredEnabled: authorization.desiredEnabled,
    integrationStatusId: authorization.integrationStatusId,
  });
  const commitment = liveChannelChangeAuthorizationCommitment(authorization);
  if (
    authorization.requestDigest !== expectedRequestDigest ||
    authorization.consequenceDigest !== expectedConsequenceDigest ||
    status.authorizationReference !== commitment
  ) {
    throw invalidLiveAuthorization();
  }
  return commitment;
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
  database: AdminQueryDatabase,
  integrationId: string | null,
) {
  return database
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

async function lockIntegrationChange(
  transaction: AdminCapabilityTransaction,
  integrationId: string,
): Promise<void> {
  // The migration gives status inserts the same key, closing the gap between
  // selecting the latest immutable status and committing the configuration.
  await transaction.database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${integrationId}, 0))`,
  );
}

async function latestStatusForChange(
  transaction: AdminCapabilityTransaction,
  integrationId: string,
): Promise<LiveStatusRow | null> {
  const [status] = await transaction.database
    .select({
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
    .where(eq(integrationStatuses.integrationId, integrationId))
    .orderBy(desc(integrationStatuses.observedAt), desc(integrationStatuses.id))
    .limit(1)
    .for('share');
  return status ?? null;
}

async function lockChannelConfigurationState(
  transaction: AdminCapabilityTransaction,
  integrationId: string,
): Promise<ChannelConfigurationState | null> {
  const [configuration] = await transaction.database
    .select({
      enabled: channelConfigurations.enabled,
      statusId: channelConfigurations.statusId,
    })
    .from(channelConfigurations)
    .where(eq(channelConfigurations.integrationId, integrationId))
    .limit(1)
    .for('update');
  return configuration ?? null;
}

async function channelConfigurationProjection(
  database: AdminQueryDatabase,
): Promise<readonly ChannelConfiguration[]> {
  const rows = await database
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
      // One RDS Data API transaction ID may execute only one statement at a
      // time. Keep both projections and the authoritative clock serial inside
      // the store's one repeatable-read transaction so the returned status and
      // channel evidence cannot come from different database snapshots.
      const statuses = await latestStatuses(
        context.transaction.database,
        input.integrationId,
      );
      const channels = await channelConfigurationProjection(
        context.transaction.database,
      );
      const observedAt = await readCapabilityTime(context);
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
    await lockIntegrationChange(context.transaction, input.integrationId);
    const previousConfiguration = await lockChannelConfigurationState(
      context.transaction,
      input.integrationId,
    );
    const status = await latestStatusForChange(
      context.transaction,
      input.integrationId,
    );
    if (status === null) {
      throw new AdminCapabilityError(
        'NOT_FOUND',
        'The integration status was not found.',
        404,
      );
    }
    assertChannelChangeAllowed(input, statusFromRow(status));

    const changedAt = await readCapabilityTime(context);
    if (status.label === 'live-verified') {
      if (input.authorization === null) throw invalidLiveAuthorization();
      const commitment = assertExactLiveAuthorization({
        actor: context.invocation.actor,
        authorization: input.authorization,
        status,
        previousConfiguration,
        consumedAt: changedAt,
      });
      if (context.invocation.actor.kind !== 'human') {
        throw invalidLiveAuthorization();
      }
      const [consumed] = await context.transaction.database
        .insert(integrationChannelChangeAuthorizations)
        .values({
          reference: input.authorization.reference,
          authorizationCommitment: commitment,
          integrationStatusId: status.id,
          integrationId: input.integrationId,
          statusLabel: 'live-verified',
          desiredEnabled: input.enabled,
          requestDigest: input.authorization.requestDigest,
          consequenceDigest: input.authorization.consequenceDigest,
          authorizedByUserId: input.authorization.authorizedByUserId,
          authorizedWithSessionId: input.authorization.authorizedWithSessionId,
          issuedAt: new Date(input.authorization.issuedAt),
          expiresAt: new Date(input.authorization.expiresAt),
          consumedByUserId: context.invocation.actor.userId,
          consumedWithSessionId: context.invocation.actor.sessionId,
          consumedRequestId: context.invocation.requestId,
          consumedAt: changedAt,
        })
        .onConflictDoNothing()
        .returning({ id: integrationChannelChangeAuthorizations.id });
      if (consumed === undefined) throw invalidLiveAuthorization();
    }
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
