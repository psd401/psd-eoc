import { handlePushEndpointEligibility } from '../../_lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handlePushEndpointEligibility(request);
}
