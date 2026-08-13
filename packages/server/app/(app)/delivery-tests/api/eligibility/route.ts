import type { NextRequest } from 'next/server';

import { handleRecordDeliveryTestCanaryEligibility } from '../../http';

export async function POST(request: NextRequest) {
  return handleRecordDeliveryTestCanaryEligibility(request);
}
