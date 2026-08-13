import type { NextRequest } from 'next/server';

import { handleMobileActivationPreview } from '../_lib/http';

export async function POST(request: NextRequest) {
  return handleMobileActivationPreview(request);
}
