import type { NextRequest } from 'next/server';

import { handleCompleteMediaUpload } from '../../../_lib/http';

interface MediaCompletionRouteContext {
  readonly params: Promise<{ uploadIntentId: string }>;
}

export async function POST(
  request: NextRequest,
  context: MediaCompletionRouteContext,
) {
  const { uploadIntentId } = await context.params;
  return handleCompleteMediaUpload(request, uploadIntentId);
}
