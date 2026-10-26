'use client';

import { useState } from 'react';

/** The double-submit token, read from the cookie the server wrote for it. */
function readCsrfToken(cookieName: string): string | null {
  for (const segment of document.cookie.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    if (segment.slice(0, separator).trim() !== cookieName) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Ends the current web session.
 *
 * The revoke endpoint clears the browser session cookies itself, so this only
 * needs to issue the request and then leave the authenticated area. A full
 * navigation is used rather than a client-side route change so no authenticated
 * server component state survives the sign-out.
 *
 * The request carries the double-submit CSRF token every browser mutation
 * carries. Without it the revoke endpoint refused the POST, which left the
 * only sign-out control in the application failing for everyone — staff and
 * partner alike — with "Sign out failed. Try again."
 */
export function SignOutButton({
  sessionId,
  csrfCookieName,
}: Readonly<{
  sessionId: string;
  csrfCookieName: string;
}>): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut(): Promise<void> {
    setPending(true);
    setFailed(false);
    try {
      const csrfToken = readCsrfToken(csrfCookieName);
      if (csrfToken === null) {
        setPending(false);
        setFailed(true);
        return;
      }
      const response = await fetch('/api/auth/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-psd-eoc-csrf': csrfToken,
        },
        body: JSON.stringify({ sessionId, reasonCode: 'USER_SIGNED_OUT' }),
      });
      if (!response.ok) {
        setPending(false);
        setFailed(true);
        return;
      }
      window.location.assign('/login?reason=signed-out');
    } catch {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <>
      <button
        className="primary-nav__sign-out"
        disabled={pending}
        onClick={() => {
          void signOut();
        }}
        type="button"
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      {failed ? (
        <p className="primary-nav__sign-out-error" role="alert">
          Sign out failed. Try again.
        </p>
      ) : null}
    </>
  );
}
