import type { NextRequest } from 'next/server';

import { handleCreateDeliveryTestPreview } from '../../http';

export async function POST(request: NextRequest) {
  return handleCreateDeliveryTestPreview(request);
}
