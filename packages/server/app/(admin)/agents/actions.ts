'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { WEB_SESSION_COOKIE_NAME } from '../../../lib/auth/sessions';
import { agentApiKeyAdministrationAccessFromSession } from '../../../lib/agents/admin-capabilities';
import { getDefaultAgentApiKeyAdministration } from '../../../lib/agents/runtime';
import {
  handleIssueAgentApiKeyAction,
  handleRevokeAgentApiKeyAction,
} from './action-handlers';
import type {
  AgentAdminIssueState,
  AgentAdminRevokeState,
} from './agent-admin';
import { authenticateWebSession } from '../../../lib/auth/request-session';

async function authenticateAdministrationSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required');
  }
  try {
    return await authenticateWebSession(token);
  } catch {
    redirect('/login?reason=session-expired');
  }
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
  return handleIssueAgentApiKeyAction(previousState, formData, {
    access: agentApiKeyAdministrationAccessFromSession(authenticated),
    administration: getDefaultAgentApiKeyAdministration(),
    createIdempotencyKey: randomUUID,
    revalidateAgents: bestEffortRevalidateAgents,
  });
}

/** POST-backed append-only key revocation. No credential is accepted or returned. */
export async function revokeAgentApiKeyAction(
  previousState: AgentAdminRevokeState,
  formData: FormData,
): Promise<AgentAdminRevokeState> {
  const authenticated = await authenticateAdministrationSession();
  return handleRevokeAgentApiKeyAction(previousState, formData, {
    access: agentApiKeyAdministrationAccessFromSession(authenticated),
    administration: getDefaultAgentApiKeyAdministration(),
    createIdempotencyKey: randomUUID,
    revalidateAgents: bestEffortRevalidateAgents,
  });
}
