export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const LIVE_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Process liveness for the App Runner health check: answers without touching
 * the database, SQS, or Secrets Manager.
 *
 * App Runner replaces any instance that fails its health check. While the
 * check was the deep `/api/health` read, one slow dependency failed it on
 * every instance at once, so a database blip became a full outage. Dependency
 * health stays on `/api/health`, which the reachability canary and alarms
 * read.
 */
export function GET(): Response {
  return new Response('{"status":"live"}', {
    headers: LIVE_RESPONSE_HEADERS,
    status: 200,
  });
}
