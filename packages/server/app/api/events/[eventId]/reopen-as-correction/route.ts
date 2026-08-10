import type { NextRequest } from 'next/server';

import { handleReopenAsCorrection } from '../../_lib/http';

interface EventRouteContext {
  readonly params: Promise<Readonly<{ eventId: string }>>;
}

export async function POST(request: NextRequest, context: EventRouteContext) {
  const { eventId } = await context.params;
  return handleReopenAsCorrection(request, eventId);
}
