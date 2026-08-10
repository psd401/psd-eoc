import type { NextRequest } from 'next/server';

import { handleListEvents, handleStartEvent } from './_lib/http';

export async function GET(request: NextRequest) {
  return handleListEvents(request);
}

export async function POST(request: NextRequest) {
  return handleStartEvent(request);
}
