import { handleRosterSyncPost } from './runtime';

export const dynamic = 'force-dynamic';

/** Authenticated EventBridge entry point. No other HTTP method can mutate. */
export function POST(request: Request): Promise<Response> {
  return handleRosterSyncPost(request);
}
