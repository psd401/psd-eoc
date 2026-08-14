import { handleFanoutControlPost } from './runtime';

export const dynamic = 'force-dynamic';

/** Fixed worker-authenticated query; no lifecycle mutation is reachable. */
export function POST(request: Request): Promise<Response> {
  return handleFanoutControlPost(request);
}
