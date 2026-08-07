import { NextResponse } from 'next/server';

import {
  beginGoogleOidcSignIn,
  readGoogleOidcConfiguration,
} from '../../../../lib/auth/oidc';

export const dynamic = 'force-dynamic';

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/** Begins the only supported web sign-in flow: Google code + PKCE. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const configuration = readGoogleOidcConfiguration();
    const signIn = await beginGoogleOidcSignIn(configuration);
    const response = NextResponse.redirect(signIn.authorizationUrl, 302);
    response.headers.append('Set-Cookie', signIn.setCookieHeader);
    return noStore(response);
  } catch {
    return noStore(
      NextResponse.redirect(
        new URL('/denied?reason=configuration', request.url),
        303,
      ),
    );
  }
}
