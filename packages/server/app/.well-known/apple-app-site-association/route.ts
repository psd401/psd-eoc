import { appleAppSiteAssociation } from '../../../lib/config/app-association';

/**
 * Apple's app association document.
 *
 * iOS fetches this over HTTPS from the relying party's own hostname and will
 * only let an app ask for a passkey on that hostname when the document names
 * the team and bundle identifier the app was signed with. It is public by
 * design — anyone may read which app belongs to this deployment — and it
 * grants nothing: it states who may ask, and the partner admission still
 * decides who is let in.
 *
 * Apple requires the document at exactly this path, with no redirect and a
 * JSON content type, and it is fetched by Apple's own CDN rather than by the
 * device. A deployment that ships no signed iOS app serves nothing here.
 *
 * Issue #647.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const association = appleAppSiteAssociation();
  if (association === null) {
    return new Response('Not found.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(association), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Apple's CDN caches this itself; an hour is short enough that a
      // corrected document reaches it the same day and long enough that the
      // service is not fetched on every install.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
