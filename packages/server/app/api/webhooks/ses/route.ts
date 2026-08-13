import { handleSesWebhookPost } from './runtime';

export const dynamic = 'force-dynamic';

/** Signed SNS entry point; it cannot reach an event-lifecycle capability. */
export function POST(request: Request): Promise<Response> {
  return handleSesWebhookPost(request);
}
