import type { NextRequest } from 'next/server';

import { handleListMobileStartThreats } from '../_lib/http';

export async function GET(request: NextRequest) {
  return handleListMobileStartThreats(request);
}
