import type { NextRequest } from 'next/server';

import { handleListEvents } from './_lib/http';

export async function GET(request: NextRequest) {
  return handleListEvents(request);
}
