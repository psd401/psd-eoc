import type { NextRequest } from 'next/server';

import { handleJoinEvent } from '../../_lib/http';

interface EventRouteContext {
  readonly params: Promise<Readonly<{ eventId: string }>>;
}

export async function POST(request: NextRequest, context: EventRouteContext) {
  const { eventId } = await context.params;
  return handleJoinEvent(request, eventId);
}
