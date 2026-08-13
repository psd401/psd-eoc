import type { NextRequest } from 'next/server';

import { handleMobileActivateEvent } from '../_lib/http';

export async function POST(request: NextRequest) {
  return handleMobileActivateEvent(request);
}
