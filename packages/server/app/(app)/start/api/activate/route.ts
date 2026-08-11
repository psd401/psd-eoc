import type { NextRequest } from 'next/server';

import { handleActivateEvent } from '../../_lib/http';

export async function POST(request: NextRequest) {
  return handleActivateEvent(request);
}
