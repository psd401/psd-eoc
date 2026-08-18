'use client';

import { useState } from 'react';

/**
 * Ends the current web session.
 *
 * The revoke endpoint clears the browser session cookies itself, so this only
 * needs to issue the request and then leave the authenticated area. A full
 * navigation is used rather than a client-side route change so no authenticated
 * server component state survives the sign-out.
 */
export function SignOutButton({
  sessionId,
}: Readonly<{ sessionId: string }>): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut(): Promise<void> {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch('/api/auth/revoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
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
