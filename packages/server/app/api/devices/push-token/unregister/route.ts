import type { NextRequest } from 'next/server';

import { handleUnregisterPushToken } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return handleUnregisterPushToken(request);
}
