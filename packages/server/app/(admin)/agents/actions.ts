'use server';

import { randomUUID } from 'node:crypto';

import {
  IdempotencyKeySchema,
  IssueAgentApiKeyInputSchema,
  RevokeAgentApiKeyInputSchema,
} from '@psd-eoc/contracts';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
} from '../../../lib/auth/sessions';
import {
  AgentApiKeyAdministrationCommitError,
  agentApiKeyAdministrationAccessFromSession,
} from '../../../lib/agents/admin-capabilities';
import {
  AgentApiKeyError,
  AgentApiKeyIssuanceReplayError,
} from '../../../lib/agents/keys';
import { getDefaultAgentApiKeyAdministration } from '../../../lib/agents/runtime';
import type {
  AgentAdminIssueState,
  AgentAdminRevokeState,
} from './agent-admin';

async function authenticateAdministrationSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required');
  }
  try {
    return await getDefaultSessionService().authenticate(token, 'web');
  } catch {
    redirect('/login?reason=session-expired');
  }
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

function bestEffortRevalidateAgents(): boolean {
  try {
    revalidatePath('/agents');
    return true;
  } catch {
    return false;
  }
}

/** POST-backed issuance/rotation. The plaintext key exists only in this response state. */
export async function issueAgentApiKeyAction(
  previousState: AgentAdminIssueState,
  formData: FormData,
): Promise<AgentAdminIssueState> {
  const authenticated = await authenticateAdministrationSession();
  let retainedIdempotencyKey =
    IdempotencyKeySchema.safeParse(previousState.idempotencyKey).data ??
    randomUUID();
  try {
    const idempotencyKey = IdempotencyKeySchema.parse(
      text(formData, 'idempotencyKey'),
    );
    const nextIdempotencyKey = randomUUID();
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
    const issuance = await getDefaultAgentApiKeyAdministration().issue({
      access: agentApiKeyAdministrationAccessFromSession(authenticated),
      value,
      idempotencyKey,
      // Next Server Actions accept same-origin POST submissions and reject
      // cross-origin invocation before this authenticated action runs.
      csrfVerified: true,
    });
    const revalidated = bestEffortRevalidateAgents();
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
      bestEffortRevalidateAgents();
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
      bestEffortRevalidateAgents();
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

/** POST-backed append-only key revocation. No credential is accepted or returned. */
export async function revokeAgentApiKeyAction(
  previousState: AgentAdminRevokeState,
  formData: FormData,
): Promise<AgentAdminRevokeState> {
  void previousState;
  const authenticated = await authenticateAdministrationSession();
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
    await getDefaultAgentApiKeyAdministration().revoke({
      access: agentApiKeyAdministrationAccessFromSession(authenticated),
      value,
      idempotencyKey,
      csrfVerified: true,
    });
    const revalidated = bestEffortRevalidateAgents();
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
      bestEffortRevalidateAgents();
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
      bestEffortRevalidateAgents();
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
