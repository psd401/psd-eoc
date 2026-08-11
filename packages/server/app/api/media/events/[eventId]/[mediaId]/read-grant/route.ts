import type { NextRequest } from 'next/server';

import { handleGetMediaReadGrant } from '../../../../_lib/http';

interface MediaReadGrantRouteContext {
  readonly params: Promise<{ eventId: string; mediaId: string }>;
}

export async function GET(
  request: NextRequest,
  context: MediaReadGrantRouteContext,
) {
  const { eventId, mediaId } = await context.params;
  return handleGetMediaReadGrant(request, eventId, mediaId);
}
