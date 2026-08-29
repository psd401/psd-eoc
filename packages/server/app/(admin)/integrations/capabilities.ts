import { randomUUID } from 'node:crypto';

import {
  ChannelConfigurationSchema,
  IntegrationIdSchema,
  IntegrationHealthSchema,
  IntegrationVerificationReferenceSchema,
  SesVerificationReferenceSchema,
  type CapabilityInput,
  type ChannelConfiguration,
  type IntegrationChannelChangeAuthorization,
  type IntegrationStatus,
  type SetChannelEnabledInput,
  type IntegrationHealth,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

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
/** Names the mechanism on truth an administrator recorded by enabling directly. */
export const ADMINISTRATOR_ENABLEMENT_REFERENCE =
  'administrator-channel-enablement' as const;
export const DIRECT_PUSH_VERIFICATION_REFERENCE_ENV =
  'PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE' as const;

/** Reads the exact non-secret deployment reference that authorizes activation. */
export function readDirectPushVerificationReference(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const value = environment[DIRECT_PUSH_VERIFICATION_REFERENCE_ENV];
  return value !== undefined &&
    value !== 'UNVERIFIED' &&
    IntegrationVerificationReferenceSchema.safeParse(value).success
    ? value
    : null;
}

/** Refuses caller-supplied proof that is not bound to this deployment. */
export function assertExactDirectPushVerificationReference(
  supplied: string,
  expected: string | null,
): void {
  if (expected === null || supplied !== expected) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'Direct push verification does not match the protected deployment reference.',
      409,
    );
  }
}
export const SES_VERIFICATION_REFERENCE_ENV =
  'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE' as const;
export const EMAIL_WORKER_ENABLED_ENV = 'PSD_EOC_EMAIL_WORKER_ENABLED' as const;

export interface SmsWorkerReadiness {
  readonly ready: boolean;
  readonly registrationVerificationReference: string | null;
}

function isSmsRegistrationVerificationReference(
  value: string | null,
): value is string {
  return (
    value !== null &&
    value !== 'UNVERIFIED' &&
    value !== 'UNCONFIGURED' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value)
  );
}

export function readSmsWorkerReadiness(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SmsWorkerReadiness {
  const reference =
    environment.PSD_EOC_SMS_REGISTRATION_VERIFICATION_REFERENCE ?? null;
  const validReference = isSmsRegistrationVerificationReference(reference);
  return Object.freeze({
    ready: environment.PSD_EOC_SMS_WORKER_READY === 'true' && validReference,
    registrationVerificationReference: validReference ? reference : null,
  });
}

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
 * A district administrator turns a notification channel on or off directly.
 *
 * The only refusal is a `blocked` integration, whose prerequisite is external
 * to this application (for example SMS carrier registration) and cannot be
 * satisfied by an administrator here. Enabling appends an observation naming
 * the administrator and the time, so who turned a channel on stays answerable
 * without a separate pre-issued authorization artifact.
 */
export function assertChannelChangeAllowed(
  input: SetChannelEnabledInput,
  status: IntegrationStatus,
): void {
  if (input.enabled && status.label === 'blocked') {
    throw new AdminCapabilityError(
      'CONFLICT',
      'A blocked integration cannot be enabled until its external prerequisite is resolved.',
      409,
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
      await lockIntegrationChange(context.transaction, input.integrationId);
      await lockChannelConfigurationState(
        context.transaction,
        input.integrationId,
      );
      let status = await latestStatusForChange(
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
      if (input.enabled && status.label !== 'live-verified') {
        if (context.invocation.actor.kind !== 'human') {
          throw new AdminCapabilityError(
            'FORBIDDEN',
            'A human district administrator must enable a notification channel.',
            403,
          );
        }
        const [enabledStatus] = await context.transaction.database
          .insert(integrationStatuses)
          .values({
            id: randomUUID(),
            integrationId: input.integrationId,
            label: 'live-verified',
            verifiedAt: changedAt,
            verifiedByUserId: context.invocation.actor.userId,
            authorizationReference:
              deploymentVerificationReference(input.integrationId) ??
              ADMINISTRATOR_ENABLEMENT_REFERENCE,
            reasonCode: null,
            observedAt: changedAt,
          })
          .returning({
            id: integrationStatuses.id,
            integrationId: integrationStatuses.integrationId,
            label: integrationStatuses.label,
            verifiedAt: integrationStatuses.verifiedAt,
            verifiedByUserId: integrationStatuses.verifiedByUserId,
            authorizationReference: integrationStatuses.authorizationReference,
            reasonCode: integrationStatuses.reasonCode,
            observedAt: integrationStatuses.observedAt,
          });
        if (enabledStatus === undefined) {
          throw new AdminCapabilityError(
            'INTERNAL_ERROR',
            'The channel enablement observation could not be recorded.',
            500,
          );
        }
        status = enabledStatus;
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
}

export const setChannelEnabledRegistration =
  createSetChannelEnabledRegistration();

/**
 * The verification reference this deployment already holds for an integration.
 *
 * A send is refused unless the status the batch pinned names the same
 * verification the deployment was configured with -- `resolveBatch` compares
 * them, and the email worker cannot send through credentials nobody verified.
 *
 * Enabling a channel used to record `ADMINISTRATOR_ENABLEMENT_REFERENCE`
 * regardless, which is a different string, so every email queued after an
 * administrator enabled the channel was refused as
 * `deployment-authorization-moved-on`. Adopting the deployment's own reference
 * keeps enablement working without inventing a verification that did not
 * happen: the SES credentials were verified out of band and recorded as this
 * value. Where a deployment holds no reference, the enablement reference
 * remains the honest answer.
 */
function deploymentVerificationReference(integrationId: string): string | null {
  return integrationId === 'ses-email' ? readSesVerificationReference() : null;
}

function readSesVerificationReference(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (environment[EMAIL_WORKER_ENABLED_ENV] !== 'true') return null;
  const parsed = SesVerificationReferenceSchema.safeParse(
    environment[SES_VERIFICATION_REFERENCE_ENV],
  );
  return parsed.success ? parsed.data : null;
}

function verifyEmailIntegrationRegistration(
  verificationReference: string | null,
): ServerCapabilityRegistration<
  'verify-email-integration',
  AdminCapabilityTransaction
> {
  return {
    id: 'verify-email-integration',
    canonicalizeIdempotencyInput: (input) => ({
      ...input,
      verificationReference,
    }),
    async resolveFacilityId(_input, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      return null;
    },
    async handler(input, context) {
      if (
        input.integrationId !== 'ses-email' ||
        verificationReference === null ||
        context.invocation.actor.kind !== 'human'
      ) {
        throw new AdminCapabilityError(
          'FORBIDDEN',
          'SES verification evidence is unavailable to this human session.',
          403,
        );
      }
      await lockIntegrationChange(context.transaction, input.integrationId);
      const previousConfiguration = await lockChannelConfigurationState(
        context.transaction,
        input.integrationId,
      );
      const latest = await latestStatusForChange(
        context.transaction,
        input.integrationId,
      );
      if (latest === null) {
        throw new AdminCapabilityError(
          'NOT_FOUND',
          'The SES integration status was not found.',
          404,
        );
      }
      const changedAt = await readCapabilityTime(context);
      if (latest.label === 'live-verified') {
        if (
          previousConfiguration?.enabled !== true ||
          previousConfiguration.statusId !== latest.id
        ) {
          throw new AdminCapabilityError(
            'CONFLICT',
            'SES verification cannot re-enable a deliberately disabled channel.',
            409,
          );
        }
        if (latest.authorizationReference === verificationReference) {
          const existing = await loadChannelConfiguration(
            context.transaction,
            input.integrationId,
          );
          if (existing === null) {
            throw new AdminCapabilityError(
              'INTERNAL_ERROR',
              'The verified SES channel could not be reloaded.',
              500,
            );
          }
          return existing;
        }
      } else if (latest.label !== 'configured-unverified') {
        throw new AdminCapabilityError(
          'CONFLICT',
          'SES integration truth cannot advance from its current state.',
          409,
        );
      }
      const [inserted] = await context.transaction.database
        .insert(integrationStatuses)
        .values({
          integrationId: input.integrationId,
          label: 'live-verified',
          verifiedAt: changedAt,
          verifiedByUserId: context.invocation.actor.userId,
          authorizationReference: verificationReference,
          reasonCode: null,
          observedAt: changedAt,
        })
        .returning({ id: integrationStatuses.id });
      if (inserted === undefined) {
        throw new AdminCapabilityError(
          'INTERNAL_ERROR',
          'The SES verification observation was not recorded.',
          500,
        );
      }
      const statusId = inserted.id;
      await context.transaction.database
        .insert(channelConfigurations)
        .values({
          integrationId: input.integrationId,
          enabled: true,
          statusId,
          statusLabel: 'live-verified',
          changedAt,
        })
        .onConflictDoUpdate({
          target: channelConfigurations.integrationId,
          set: {
            enabled: true,
            statusId,
            statusLabel: 'live-verified',
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
          'The verified SES channel could not be reloaded.',
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
      if (
        result === null ||
        digestCapabilityValue(result) !== parsed.outputDigest
      ) {
        throw new AdminCapabilityError(
          'CONFLICT',
          'The original SES verification result is no longer reconstructable.',
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
  readonly smsWorkerReadiness?: SmsWorkerReadiness;
  readonly store?: AdminCapabilityStore;
  readonly directPushVerificationReference?: string | null;
}): Promise<ChannelConfiguration> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  const registration = setChannelEnabledRegistration;
  return executeAdminMutationCapability(
    registration,
    input.command,
    input.authenticated,
    store,
    input.metadata,
  );
}

/** Records deploy-time SES evidence and enables the channel in one admin action. */
export function executeVerifyEmailIntegrationCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'verify-email-integration'>;
  readonly metadata: AdminMutationMetadata;
  readonly verificationReference?: string | null;
  readonly emailWorkerEnabled?: boolean;
  readonly store?: AdminCapabilityStore;
}): Promise<ChannelConfiguration> {
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  return executeAdminMutationCapability(
    verifyEmailIntegrationRegistration(
      input.verificationReference === undefined
        ? readSesVerificationReference()
        : input.emailWorkerEnabled === false
          ? null
          : input.verificationReference,
    ),
    input.command,
    input.authenticated,
    store,
    input.metadata,
  );
}
