import type { NextRequest } from 'next/server';

import { handleAgentCapability } from '../../_lib/http';

interface AgentCapabilityRouteContext {
  readonly params: Promise<Readonly<{ capabilityId: string }>>;
}

export async function POST(
  request: NextRequest,
  context: AgentCapabilityRouteContext,
) {
  const { capabilityId } = await context.params;
  return handleAgentCapability(request, capabilityId);
}
