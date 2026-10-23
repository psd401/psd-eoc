import {
  PartnerAccessListSchema,
  type CapabilityInput,
  type PartnerAccessList,
  type PartnerAccessRecord,
  type PartnerAdmission,
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
import type { ServerCapabilityRegistration } from '../../../lib/capabilities/engine';
import { staffHostedDomain } from '../../../lib/config/deployment';
import {
  disablePartner,
  invitePartner,
  listPartnerAccess,
  loadPartnerAdmission,
  PartnerAccessError,
  projectPartnerAccess,
  reconcilePartnerAccess,
} from '../../../lib/partners/access';
import {
  partnerMessageContext,
  type PartnerMessageContext,
} from '../../../lib/partners/messages';
import {
  PartnerProviderError,
  requirePartnerProviders,
  type PartnerProviders,
} from '../../../lib/partners/providers';

interface PartnerMutationExecution<Input> {
  readonly authenticated: AuthenticatedSession;
  readonly store?: AdminCapabilityStore;
  readonly command: Input;
  readonly metadata: AdminMutationMetadata;
}

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

function humanActor(
  context: Readonly<{
    invocation: {
      actor: Parameters<typeof requireAdminCapabilityAuthorization>[0];
    };
  }>,
) {
  const actor = context.invocation.actor;
  if (actor.kind !== 'human') {
    throw new AdminCapabilityError(
      'FORBIDDEN',
      'District administrator access is required.',
      403,
    );
  }
  return actor;
}

/** Restates a partner refusal as the admin-surface error the page renders. */
function adminError(error: unknown): unknown {
  if (error instanceof PartnerAccessError) {
    return new AdminCapabilityError(
      error.code,
      error.message,
      error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'VALIDATION_ERROR'
          ? 400
          : 409,
    );
  }
  if (error instanceof PartnerProviderError) {
    return new AdminCapabilityError(
      'CONFLICT',
      error.code === 'PARTNER_ACCESS_UNCONFIGURED'
        ? error.message
        : `${error.message} The change is recorded as pending; retry it from the partner list.`,
      409,
    );
  }
  return error;
}

async function mapped<Output>(operation: () => Promise<Output>) {
  try {
    return await operation();
  } catch (error) {
    throw adminError(error);
  }
}

function staffDomainOrNull(): string | null {
  try {
    return staffHostedDomain();
  } catch {
    return null;
  }
}

async function admissionReplay(
  reference: string,
  context: Readonly<{ transaction: AdminCapabilityTransaction }>,
): Promise<PartnerAdmission> {
  const admission = await loadPartnerAdmission(
    context.transaction.database,
    reference,
  );
  if (admission === null) {
    throw new AdminCapabilityError(
      'CONFLICT',
      'The admission is unavailable.',
      409,
    );
  }
  return admission;
}

export const listPartnersRegistration: ServerCapabilityRegistration<
  'list-partners',
  AdminCapabilityTransaction
> = {
  id: 'list-partners',
  resolveFacilityId: (_input, context) => guard(context),
  handler: async (input, context) =>
    PartnerAccessListSchema.parse({
      items: await listPartnerAccess(
        context.transaction.database,
        input,
        context.invocation.serverTime,
      ),
    }),
};

export function executeListPartnersCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: CapabilityInput<'list-partners'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<PartnerAccessList> {
  return executeAdminQueryCapability(
    listPartnersRegistration,
    input.query,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
}

export const invitePartnerRegistration: ServerCapabilityRegistration<
  'invite-partner',
  AdminCapabilityTransaction
> = {
  id: 'invite-partner',
  resolveFacilityId: (_input, context) => guard(context),
  async handler(input, context) {
    const output = await mapped(() =>
      invitePartner(
        context.transaction.database,
        input,
        humanActor(context).userId,
        context.invocation.serverTime,
        staffDomainOrNull(),
      ),
    );
    // The audit names the admission row, never the address.
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: (output) => output.id,
  loadReplay: admissionReplay,
  resolveReplayFacilityId: () => Promise.resolve(null),
  replayFacilityId: () => null,
};

export const disablePartnerRegistration: ServerCapabilityRegistration<
  'disable-partner',
  AdminCapabilityTransaction
> = {
  id: 'disable-partner',
  resolveFacilityId: (_input, context) => guard(context),
  async handler(input, context) {
    const output = await mapped(() =>
      disablePartner(
        context.transaction.database,
        input.partnerAdmissionId,
        humanActor(context),
        context.invocation.serverTime,
      ),
    );
    context.transaction.setAuditTarget({
      kind: 'configuration',
      id: output.id,
    });
    return output;
  },
  resultReference: (output) => output.id,
  loadReplay: admissionReplay,
  resolveReplayFacilityId: () => Promise.resolve(null),
  replayFacilityId: () => null,
};

/**
 * Built per call so tests and the browser harness supply providers; the
 * deployment's own come from its configuration.
 */
export function reconcilePartnerAccessRegistration(
  providers: () => PartnerProviders,
  messageContext: () => PartnerMessageContext,
): ServerCapabilityRegistration<
  'reconcile-partner-access',
  AdminCapabilityTransaction
> {
  return {
    id: 'reconcile-partner-access',
    resolveFacilityId: (_input, context) => guard(context),
    async handler(input, context) {
      const output = await mapped(() =>
        reconcilePartnerAccess(
          context.transaction.database,
          input,
          humanActor(context).userId,
          providers(),
          messageContext(),
          context.invocation.serverTime,
        ),
      );
      context.transaction.setAuditTarget({
        kind: 'configuration',
        id: output.admission.id,
      });
      return output;
    },
    resultReference: (output) => output.admission.id,
    async loadReplay(reference, context): Promise<PartnerAccessRecord> {
      const admission = await admissionReplay(reference, context);
      const [record] = await projectPartnerAccess(
        context.transaction.database,
        [admission],
        context.invocation.serverTime,
      );
      if (record === undefined) {
        throw new AdminCapabilityError(
          'CONFLICT',
          'The admission is unavailable.',
          409,
        );
      }
      return record;
    },
    resolveReplayFacilityId: () => Promise.resolve(null),
    replayFacilityId: () => null,
  };
}

export const executeInvitePartnerCapability = (
  input: PartnerMutationExecution<CapabilityInput<'invite-partner'>>,
) =>
  executeAdminMutationCapability(
    invitePartnerRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeDisablePartnerCapability = (
  input: PartnerMutationExecution<CapabilityInput<'disable-partner'>>,
) =>
  executeAdminMutationCapability(
    disablePartnerRegistration,
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );

export const executeReconcilePartnerAccessCapability = (
  input: PartnerMutationExecution<CapabilityInput<'reconcile-partner-access'>> &
    Readonly<{
      providers?: PartnerProviders;
      messageContext?: PartnerMessageContext;
    }>,
) =>
  executeAdminMutationCapability(
    reconcilePartnerAccessRegistration(
      () => input.providers ?? requirePartnerProviders(),
      () => input.messageContext ?? partnerMessageContext(),
    ),
    input.command,
    input.authenticated,
    executionStore(input.authenticated, input.store),
    input.metadata,
  );
