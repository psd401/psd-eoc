import { handleDeliveryStatePost } from './runtime';

export const dynamic = 'force-dynamic';

/** Fixed worker-authenticated entry point; no event mutation is reachable. */
export function POST(request: Request): Promise<Response> {
  return handleDeliveryStatePost(request);
}
