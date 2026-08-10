import type { NextRequest } from 'next/server';

import { handleJoinExistingEvent } from '../../_lib/http';

export async function POST(request: NextRequest) {
  return handleJoinExistingEvent(request);
}
