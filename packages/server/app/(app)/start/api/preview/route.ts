import type { NextRequest } from 'next/server';

import { handleCreateActivationPreview } from '../../_lib/http';

export async function POST(request: NextRequest) {
  return handleCreateActivationPreview(request);
}
