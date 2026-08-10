import type { NextRequest } from 'next/server';

import { handleCreateMediaUploadIntent } from '../_lib/http';

export async function POST(request: NextRequest) {
  return handleCreateMediaUploadIntent(request);
}
