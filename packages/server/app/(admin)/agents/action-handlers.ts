import {
  IdempotencyKeySchema,
  IssueAgentApiKeyInputSchema,
  RevokeAgentApiKeyInputSchema,
} from '@psd-eoc/contracts';

import {
  AgentApiKeyAdministrationCommitError,
  type AgentApiKeyAdministration,
  type AgentApiKeyAdministrationAccess,
} from '../../../lib/agents/admin-capabilities';
import {
  AgentApiKeyError,
  AgentApiKeyIssuanceReplayError,
} from '../../../lib/agents/keys';
import type {
  AgentAdminIssueState,
  AgentAdminRevokeState,
} from './agent-admin';

export interface AgentAdminActionHandlerDependencies {
  readonly access: AgentApiKeyAdministrationAccess;
  readonly administration: Pick<AgentApiKeyAdministration, 'issue' | 'revoke'>;
  createIdempotencyKey(): string;
  revalidateAgents(): boolean;
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function texts(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === 'string');
}

function revalidateAgents(
  dependencies: AgentAdminActionHandlerDependencies,
): boolean {
  try {
    return dependencies.revalidateAgents();
  } catch {
    return false;
  }
}

/** Deterministic issue-form handling; the server action supplies trusted access. */
export async function handleIssueAgentApiKeyAction(
  previousState: AgentAdminIssueState,
  formData: FormData,
  dependencies: AgentAdminActionHandlerDependencies,
): Promise<AgentAdminIssueState> {
  let retainedIdempotencyKey =
    IdempotencyKeySchema.safeParse(previousState.idempotencyKey).data ??
    dependencies.createIdempotencyKey();
  try {
    const idempotencyKey = IdempotencyKeySchema.parse(
      text(formData, 'idempotencyKey'),
    );
    const nextIdempotencyKey = dependencies.createIdempotencyKey();
    retainedIdempotencyKey = idempotencyKey;
    const scopeKind = text(formData, 'facilityScopeKind');
    const expiration = text(formData, 'expiresInSeconds');
    const agentId = text(formData, 'agentId');
    const value = IssueAgentApiKeyInputSchema.parse({
      agentId: agentId.length === 0 ? null : agentId,
      displayName: text(formData, 'displayName'),
      facilityScope:
        scopeKind === 'district'
          ? { kind: 'district' }
          : {
              kind: 'facilities',
              facilityIds: texts(formData, 'facilityIds'),
            },
      capabilityIds: texts(formData, 'capabilityIds'),
      expiresInSeconds: expiration.length === 0 ? null : Number(expiration),
    });
    const issuance = await dependencies.administration.issue({
      access: dependencies.access,
      value,
      idempotencyKey,
      // Next Server Actions accept same-origin POST submissions and reject
      // cross-origin invocation before the authenticated action runs.
      csrfVerified: true,
    });
    const revalidated = revalidateAgents(dependencies);
    return {
      issuedKey: issuance,
      idempotencyKey: nextIdempotencyKey,
      notice: {
        kind: 'success',
        message: revalidated
          ? 'The scoped key was issued. Store the one-time credential before leaving this page.'
          : 'The scoped key was issued. Store the one-time credential now, then refresh to update the retained-key list.',
      },
    };
  } catch (error) {
    if (error instanceof AgentApiKeyIssuanceReplayError) {
      revalidateAgents(dependencies);
      return {
        issuedKey: null,
        idempotencyKey: retainedIdempotencyKey,
        notice: {
          kind: 'error',
          message: `This issuance already committed for key prefix ${error.key.keyPrefix}, so its one-time credential cannot be shown again. Refresh, revoke that key, and issue a replacement.`,
        },
      };
    }
    if (
      error instanceof AgentApiKeyAdministrationCommitError &&
      error.committed.kind === 'issued'
    ) {
      revalidateAgents(dependencies);
      return {
        issuedKey: null,
        idempotencyKey: retainedIdempotencyKey,
        notice: {
          kind: 'error',
          message: `Key prefix ${error.committed.key.keyPrefix} was issued, but audit confirmation failed. Its credential was withheld and cannot be recovered. Refresh, revoke that key, and issue a replacement.`,
        },
      };
    }
    return {
      issuedKey: null,
      idempotencyKey: retainedIdempotencyKey,
      notice: {
        kind: 'error',
        message:
          'The key was not issued. Check the requested scope or ask a district administrator to review access.',
      },
    };
  }
}

/** Deterministic revoke-form handling; no credential is accepted or returned. */
export async function handleRevokeAgentApiKeyAction(
  previousState: AgentAdminRevokeState,
  formData: FormData,
  dependencies: AgentAdminActionHandlerDependencies,
): Promise<AgentAdminRevokeState> {
  void previousState;
  if (text(formData, 'confirmRevocation') !== 'confirmed') {
    return {
      notice: {
        kind: 'error',
        message: 'Confirm revocation before submitting this action.',
      },
    };
  }
  try {
    const value = RevokeAgentApiKeyInputSchema.parse({
      apiKeyId: text(formData, 'apiKeyId'),
      reasonCode: text(formData, 'reasonCode'),
    });
    const idempotencyKey = IdempotencyKeySchema.parse(
      text(formData, 'idempotencyKey'),
    );
    await dependencies.administration.revoke({
      access: dependencies.access,
      value,
      idempotencyKey,
      csrfVerified: true,
    });
    const revalidated = revalidateAgents(dependencies);
    return {
      notice: {
        kind: 'success',
        message: revalidated
          ? 'The key was revoked and can no longer authenticate.'
          : 'The key was revoked and can no longer authenticate. Refresh to update the retained-key list.',
      },
    };
  } catch (error) {
    if (
      error instanceof AgentApiKeyAdministrationCommitError &&
      error.committed.kind === 'revoked'
    ) {
      revalidateAgents(dependencies);
      return {
        notice: {
          kind: 'info',
          message:
            'The key was revoked and can no longer authenticate, but audit confirmation failed. Refresh before taking another action.',
        },
      };
    }
    if (
      error instanceof AgentApiKeyError &&
      error.code === 'KEY_ALREADY_REVOKED'
    ) {
      revalidateAgents(dependencies);
      return {
        notice: {
          kind: 'info',
          message:
            'The key is already revoked and cannot authenticate. Refresh to update the retained-key list.',
        },
      };
    }
    return {
      notice: {
        kind: 'error',
        message:
          'The key was not revoked. Refresh the page or ask a district administrator to review it.',
      },
    };
  }
}
