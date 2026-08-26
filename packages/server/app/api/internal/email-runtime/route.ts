import { handleEmailRuntimePost } from './runtime';

export const dynamic = 'force-dynamic';

/** Worker-only SES persistence and endpoint-resolution boundary. */
export function POST(request: Request): Promise<Response> {
  return handleEmailRuntimePost(request);
}
