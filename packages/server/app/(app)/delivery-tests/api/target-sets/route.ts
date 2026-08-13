import type { NextRequest } from 'next/server';

import { handleCreateDeliveryTestTargetSetVersion } from '../../http';

export async function POST(request: NextRequest) {
  return handleCreateDeliveryTestTargetSetVersion(request);
}
