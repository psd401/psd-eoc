import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  SessionAccessError,
} from '../../../../lib/auth/sessions';
import {
  EventTypeCapabilityError,
  executeListEventTypesCapability,
  getDefaultEventTypeStore,
} from '../../../../lib/capabilities/event-types';
import { EventTypeAdmin } from './event-type-admin';
import { authenticateWebSession } from '../../../../lib/auth/request-session';

export const dynamic = 'force-dynamic';

export default async function EventTypesAdminPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Readonly<{ mode?: string }>>;
}>) {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required');
  }
  let authenticated;
  try {
    authenticated = await authenticateWebSession(token);
  } catch (error) {
    if (error instanceof SessionAccessError) {
      redirect('/login?reason=session-expired');
    }
    throw error;
  }

  const parameters = await searchParams;
  const templateMode =
    parameters.mode === 'real' || parameters.mode === 'drill'
      ? parameters.mode
      : null;
  let eventTypePage;
  try {
    eventTypePage = await executeListEventTypesCapability({
      store: getDefaultEventTypeStore(),
      authenticated,
      query: {
        templateMode,
        enabled: null,
        cursor: null,
        limit: 200,
      },
    });
  } catch (error) {
    if (
      error instanceof EventTypeCapabilityError &&
      error.code === 'FORBIDDEN'
    ) {
      redirect('/event-types');
    }
    throw error;
  }

  return (
    <main id="main-content" tabIndex={-1}>
      <header className="page-heading">
        <div>
          <h1>Event types and message templates</h1>
          <p className="lede">
            Draft and preview push, SMS, and email wording. Publishing creates a
            new immutable version; events that used an older version keep
            resolving that exact historical wording.
          </p>
        </div>
      </header>
      <EventTypeAdmin
        csrfCookieName={WEB_CSRF_COOKIE_NAME}
        items={eventTypePage.items}
        sessionId={authenticated.result.session.id}
      />
    </main>
  );
}
