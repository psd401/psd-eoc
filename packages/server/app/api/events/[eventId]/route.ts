import type { NextRequest } from 'next/server';

import { handleGetEvent } from '../_lib/http';

interface EventRouteContext {
  readonly params: Promise<Readonly<{ eventId: string }>>;
}

export async function GET(request: NextRequest, context: EventRouteContext) {
  const { eventId } = await context.params;
  return handleGetEvent(request, eventId);
}
