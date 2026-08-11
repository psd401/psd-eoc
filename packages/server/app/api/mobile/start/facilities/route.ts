import type { NextRequest } from 'next/server';

import { handleListMobileStartFacilities } from '../_lib/http';

export async function GET(request: NextRequest) {
  return handleListMobileStartFacilities(request);
}
