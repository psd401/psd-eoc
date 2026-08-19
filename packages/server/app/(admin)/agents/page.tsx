import { randomUUID } from 'node:crypto';

import { AGENT_GRANTABLE_CAPABILITY_IDS } from '@psd-eoc/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { WEB_SESSION_COOKIE_NAME } from '../../../lib/auth/sessions';
import { getDefaultAgentAdministrationPageLoader } from '../../../lib/agents/runtime';
import { isAgentDeployedCapabilityId } from '../../../lib/agents/availability';
import { AgentAdmin, type AgentAdminAgent } from './agent-admin';
import { issueAgentApiKeyAction, revokeAgentApiKeyAction } from './actions';
import { authenticateWebSession } from '../../../lib/auth/request-session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function capabilityLabel(capabilityId: string): string {
  return capabilityId
    .split('-')
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export default async function AgentsAdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required');
  }

  let authenticated;
  try {
    authenticated = await authenticateWebSession(token);
  } catch {
    redirect('/login?reason=session-expired');
  }

  if (
    !authenticated.roles.includes('admin') ||
    authenticated.scope.facilityScope.kind !== 'district'
  ) {
    return (
      <main id="main-content" tabIndex={-1}>
        <h1>District administrator access required</h1>
        <p role="alert">
          Your PSD EOC session is active, but only a district-scoped
          administrator can manage agent API keys.
        </p>
      </main>
    );
  }

  const data =
    await getDefaultAgentAdministrationPageLoader().load(authenticated);
  const agents: AgentAdminAgent[] = data.agents.map((agent) => ({
    id: agent.id,
    displayName: agent.displayName,
    keys: agent.keys,
    auditRecords: agent.auditRecords.flatMap((record) =>
      record.principal.kind === 'agent'
        ? [
            {
              id: record.id,
              sequence: record.sequence,
              action: record.action,
              outcome: record.outcome,
              principal: record.principal,
              source: record.source,
              facilityId: record.facilityId,
              reasonCode: record.reasonCode,
              occurredAt: record.occurredAt,
            },
          ]
        : [],
    ),
  }));

  return (
    <AgentAdmin
      agents={agents}
      facilities={data.facilities.map((facility) => ({
        id: facility.id,
        code: facility.code,
        name: facility.name,
        active: facility.active,
      }))}
      grantOptions={AGENT_GRANTABLE_CAPABILITY_IDS.filter(
        isAgentDeployedCapabilityId,
      ).map((capabilityId) => ({
        id: capabilityId,
        label: capabilityLabel(capabilityId),
        description:
          'The server applies the selected facility scope and all real-versus-drill and human-only safety rules.',
      }))}
      issueIdempotencyKey={randomUUID()}
      issuedKey={null}
      issueKeyAction={issueAgentApiKeyAction}
      notice={null}
      renderedAt={new Date().toISOString()}
      revokeKeyAction={revokeAgentApiKeyAction}
    />
  );
}
