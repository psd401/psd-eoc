import type { NextRequest } from 'next/server';

import { handleListMyDevices } from './_lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return handleListMyDevices(request);
}
