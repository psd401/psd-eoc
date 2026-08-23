import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { DeviceSessionList } from './device-session-list';
import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  executeListDeviceSessionsCapability,
  getDefaultSessionService,
  readSessionPolicy,
} from '../../../lib/auth/sessions';

export const dynamic = 'force-dynamic';

function duration(seconds: number): string {
  if (seconds % (24 * 3_600) === 0) {
    const days = seconds / (24 * 3_600);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export default async function DevicesPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Readonly<{ cursor?: string }>>;
}>) {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required');
  }
  const service = getDefaultSessionService();
  let authenticated;
  try {
    authenticated = await service.authenticate(token, 'web');
  } catch {
    redirect('/login?reason=session-expired');
  }
  if (!authenticated.roles.includes('admin')) {
    return (
      <main id="main-content" tabIndex={-1}>
        <h1>Administrator access required</h1>
        <p role="alert">
          Your PSD EOC session is active, but only administrators can manage
          device sessions.
        </p>
        <p>Contact a PSD EOC administrator if you need device-session help.</p>
      </main>
    );
  }
  const parameters = await searchParams;
  const page = await executeListDeviceSessionsCapability({
    service,
    authenticated,
    query: {
      userId: null,
      includeRevoked: true,
      cursor: parameters.cursor ?? null,
      limit: 200,
    },
  });
  const policy = readSessionPolicy();
  const renderedAt = new Date().toISOString();

  return (
    <main id="main-content" tabIndex={-1}>
      <h1>Device sessions</h1>
      <p>
        Revoke an individual session when a staff device is lost or should no
        longer have access. Revocation is checked by the server on every request
        and does not wait for Google.
      </p>
      <aside aria-labelledby="membership-policy-heading">
        <h2 id="membership-policy-heading">Google outage policy</h2>
        <p>
          Cached group membership is fresh for{' '}
          {duration(policy.membershipTtlSeconds)}, followed by a{' '}
          {duration(policy.membershipGraceSeconds)} outage grace. Existing
          sessions keep their full role and facility scope during the grace
          window. At the exact grace deadline, access stops until fresh
          membership evidence is available. Each newer complete server-side
          snapshot starts a new TTL and grace decision for retained sessions;
          refreshing a credential by itself never does. The table preserves the
          membership evidence pinned when each session was issued.
        </p>
      </aside>
      <DeviceSessionList
        csrfCookieName={WEB_CSRF_COOKIE_NAME}
        items={page.items}
        renderedAt={renderedAt}
      />
      {page.pageInfo.hasMore && page.pageInfo.nextCursor !== null ? (
        <p>
          <Link href={`/devices?cursor=${page.pageInfo.nextCursor}`}>
            Next page
          </Link>
        </p>
      ) : null}
    </main>
  );
}
