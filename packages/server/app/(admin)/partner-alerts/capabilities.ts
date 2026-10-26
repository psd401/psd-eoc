import type {
  CapabilityInput,
  PartnerAlertSettingsState,
  PartnerAlertSettingsVersion,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
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
} from '../../../lib/capabilities/admin';
import {
  readCapabilityTime,
  type ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import { PartnerAccessError } from '../../../lib/partners/access';
import {
  loadPartnerAlertSettingsState,
  loadPartnerAlertSettingsVersion,
  savePartnerAlertSettings,
} from '../../../lib/partners/alert-settings';

function executionStore(
  authenticated: AuthenticatedSession,
  store: AdminCapabilityStore | undefined,
): AdminCapabilityStore {
  return (
    store ??
    createDrizzleAdminCapabilityStore(getDefaultAdminDatabase(), authenticated)
  );
}

function guard(
  context: Readonly<{
    invocation: {
      actor: Parameters<typeof requireAdminCapabilityAuthorization>[0];
    };
    transaction: AdminCapabilityTransaction;
  }>,
): null {
  requireAdminCapabilityAuthorization(
    context.invocation.actor,
    context.transaction,
  );
  return null;
}

export const getPartnerAlertSettingsRegistration: ServerCapabilityRegistration<
  'get-partner-alert-settings',
  AdminCapabilityTransaction
> = {
  id: 'get-partner-alert-settings',
  resolveFacilityId: (_input, context) => guard(context),
  handler: (_input, context) =>
    loadPartnerAlertSettingsState(context.transaction.database),
};

export const setPartnerAlertSettingsRegistration: ServerCapabilityRegistration<
  'set-partner-alert-settings',
  AdminCapabilityTransaction
> = {
  id: 'set-partner-alert-settings',
  resolveFacilityId: (_input, context) => guard(context),
  async handler(input, context) {
    const actor = context.invocation.actor;
    if (actor.kind !== 'human') {
      throw new AdminCapabilityError(
        'FORBIDDEN',
        'A human district administrator must change partner alert settings.',
        403,
      );
    }
    let output: PartnerAlertSettingsVersion;
    try {
      output = await savePartnerAlertSettings(
        context.transaction.database,
        input,
        actor.userId,
        await readCapabilityTime(context),
      );
    } catch (error) {
      if (error instanceof PartnerAccessError) {
        throw new AdminCapabilityError(
          error.code,
          error.message,
          error.code === 'VALIDATION_ERROR' ? 400 : 409,
        );
      }
      throw error;
    }
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: (output) => output.id,
  async loadReplay(reference, context) {
    const version = await loadPartnerAlertSettingsVersion(
      context.transaction.database,
      reference,
    );
    if (version === null) {
      throw new AdminCapabilityError(
        'CONFLICT',
        'The saved partner alert settings are unavailable.',
        409,
      );
    }
    return version;
  },
  resolveReplayFacilityId: (_reference, context) =>
    Promise.resolve(guard(context)),
  replayFacilityId: () => null,
};

export function executeGetPartnerAlertSettingsCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: CapabilityInput<'get-partner-alert-settings'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<PartnerAlertSettingsState> {
  return executeAdminQueryCapability(
    getPartnerAlertSettingsRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
}

export function executeSetPartnerAlertSettingsCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'set-partner-alert-settings'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata: AdminMutationMetadata;
}): Promise<PartnerAlertSettingsVersion> {
  return executeAdminMutationCapability(
    setPartnerAlertSettingsRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
}
