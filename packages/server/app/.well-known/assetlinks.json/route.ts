import { androidAssetLinks } from '../../../lib/config/app-association';

/**
 * Google's Digital Asset Links document.
 *
 * Android's credential manager fetches this over HTTPS from the relying
 * party's own hostname and will only let an app ask for a passkey on that
 * hostname when a statement here carries
 * `delegate_permission/common.get_login_creds` for the certificate Play
 * signed that app with. Like Apple's document it is public by design and
 * grants nothing beyond the right to ask.
 *
 * The statement deliberately carries no other relation. Claiming
 * `handle_all_urls` would make this app the handler for every link on the
 * district's domain, which is a separate decision and is not taken here.
 *
 * A deployment that ships no Play app, or whose signing fingerprint is not
 * configured, serves nothing here.
 *
 * Issue #647.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const statements = androidAssetLinks();
  if (statements === null) {
    return new Response('Not found.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(statements), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
