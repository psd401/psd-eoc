import { handleSmsRuntimePost } from './runtime';

export const dynamic = 'force-dynamic';

/** Fixed worker-authenticated entry point; no event lifecycle action exists. */
export function POST(request: Request): Promise<Response> {
  return handleSmsRuntimePost(request);
}
