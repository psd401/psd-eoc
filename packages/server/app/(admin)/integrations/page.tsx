import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
} from '../../../lib/auth/sessions';
import { AdminCapabilityError } from '../facilities/admin-core';
import { executeIntegrationHealthProjection } from './capabilities';
import { IntegrationsAdminView } from './integrations-admin-view';
import { executeRosterHealthProjection } from './roster-health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATUS_MESSAGES = Object.freeze({
  'channel-updated': 'The notification channel configuration was updated.',
} as const);

function statusMessage(value: string | undefined): string | null {
  return value !== undefined && value in STATUS_MESSAGES
    ? STATUS_MESSAGES[value as keyof typeof STATUS_MESSAGES]
    : null;
}

function ForbiddenIntegrations() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section aria-labelledby="integrations-forbidden-heading">
        <h1 id="integrations-forbidden-heading">
          Administrator access required
        </h1>
        <p role="alert">
          Your PSD EOC session is active, but only district administrators can
          review integration and test-mode health.
        </p>
        <p>No integration, channel, roster, or endpoint data was displayed.</p>
      </section>
    </main>
  );
}

export default async function IntegrationsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Readonly<{ status?: string }>>;
}>) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined) {
    redirect('/login?reason=session-required');
  }
  let authenticated;
  try {
    authenticated = await getDefaultSessionService().authenticate(
      sessionToken,
      'web',
    );
  } catch {
    redirect('/login?reason=session-expired');
  }
  const csrfToken = cookieStore.get(WEB_CSRF_COOKIE_NAME)?.value;
  if (csrfToken === undefined) {
    redirect('/login?reason=session-required');
  }
  try {
    const integration = await executeIntegrationHealthProjection({
      authenticated,
      query: { integrationId: null },
    });
    const roster = await executeRosterHealthProjection({
      authenticated,
      query: {
        population: 'staff',
        facilityId: null,
        cursor: null,
        limit: 200,
      },
    });
    const parameters = await searchParams;
    return (
      <IntegrationsAdminView
        channelConfigurations={integration.channels}
        csrfToken={csrfToken}
        integrationHealth={integration.health}
        lastRosterSync={roster.lastSync}
        staleEndpointReport={roster.report}
        statusMessage={statusMessage(parameters.status)}
      />
    );
  } catch (error) {
    if (error instanceof AdminCapabilityError && error.status === 403) {
      return <ForbiddenIntegrations />;
    }
    throw error;
  }
}
