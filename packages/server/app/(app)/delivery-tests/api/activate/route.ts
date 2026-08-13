import type { NextRequest } from 'next/server';

import { handleActivateEvent } from '../../../start/_lib/http';

/** Reuses the exact web-only, fresh-confirmation start-event transport. */
export async function POST(request: NextRequest) {
  return handleActivateEvent(request);
}
