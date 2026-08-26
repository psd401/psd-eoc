import { handleExpoPushRuntimePost } from './runtime';

export const dynamic = 'force-dynamic';

/** Worker-only persistence and endpoint-resolution boundary. */
export function POST(request: Request): Promise<Response> {
  return handleExpoPushRuntimePost(request);
}
