'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { DeviceSessionPage } from '@psd-eoc/contracts';

type DeviceSessionItem = DeviceSessionPage['items'][number];

function readableDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function csrfToken(cookieName: string): string {
  const existing = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (existing !== undefined) {
    return decodeURIComponent(existing.slice(existing.indexOf('=') + 1));
  }
  const token = crypto.randomUUID();
  document.cookie = `${cookieName}=${encodeURIComponent(token)}; Path=/; Secure; SameSite=Strict`;
  return token;
}

export function DeviceSessionList({
  items,
  csrfCookieName,
  renderedAt,
}: Readonly<{
  items: readonly DeviceSessionItem[];
  csrfCookieName: string;
  renderedAt: string;
}>) {
  const router = useRouter();
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  async function revokeSession(sessionId: string): Promise<void> {
    setPendingSessionId(sessionId);
    setStatus('Revoking session…');
    try {
      const csrf = csrfToken(csrfCookieName);
      const response = await fetch('/api/auth/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `device-admin-${crypto.randomUUID()}`,
          'X-PSD-EOC-CSRF': csrf,
        },
        body: JSON.stringify({
          sessionId,
          reasonCode: 'ADMIN_DEVICE_REVOKE',
        }),
      });
      if (!response.ok) {
        setStatus(
          'The session could not be revoked. Try again or contact an administrator.',
        );
        return;
      }
      setStatus('Session revoked.');
      router.refresh();
    } catch {
      setStatus(
        'The session could not be revoked. Check your connection and try again.',
      );
    } finally {
      setPendingSessionId(null);
    }
  }

  if (items.length === 0) {
    return <p>No device sessions match this view.</p>;
  }

  return (
    <>
      <p aria-live="polite" role="status">
        {status}
      </p>
      {items.map((item) => (
        <section
          aria-labelledby={`device-${item.deviceEnrollment.id}`}
          key={item.deviceEnrollment.id}
        >
          <h2 id={`device-${item.deviceEnrollment.id}`}>
            {item.deviceEnrollment.platform.toUpperCase()} device
          </h2>
          <dl>
            <dt>User ID</dt>
            <dd>{item.deviceEnrollment.userId}</dd>
            <dt>Last used</dt>
            <dd>{readableDate(item.deviceEnrollment.lastSeenAt)}</dd>
            <dt>Device enrollment</dt>
            <dd>
              {item.deviceEnrollment.revokedAt === null
                ? 'Active'
                : `Revoked ${readableDate(item.deviceEnrollment.revokedAt)}`}
            </dd>
          </dl>
          <table>
            <caption>Sessions for this device</caption>
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Expires</th>
                <th scope="col">Sign-in evidence grace ends</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {item.sessions.map((session) => {
                const revoked = session.revokedAt !== null;
                const renderedAtMs = Date.parse(renderedAt);
                const expired = renderedAtMs >= Date.parse(session.expiresAt);
                const issuanceMembershipExpired =
                  renderedAtMs >=
                  Date.parse(session.authorization.membershipGraceUntil);
                const status = revoked
                  ? 'Revoked'
                  : expired
                    ? 'Expired'
                    : issuanceMembershipExpired
                      ? 'Sign-in evidence expired'
                      : 'Retained';
                return (
                  <tr key={session.id}>
                    <td>{readableDate(session.createdAt)}</td>
                    <td>{readableDate(session.expiresAt)}</td>
                    <td>
                      {readableDate(session.authorization.membershipGraceUntil)}
                    </td>
                    <td>{status}</td>
                    <td>
                      <button
                        disabled={revoked || pendingSessionId === session.id}
                        onClick={() => void revokeSession(session.id)}
                        type="button"
                      >
                        {pendingSessionId === session.id
                          ? 'Revoking…'
                          : 'Revoke session'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
