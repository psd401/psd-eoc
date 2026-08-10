import { randomUUID } from 'node:crypto';

import { EventIdSchema } from '@psd-eoc/contracts';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  SessionAccessError,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../../../lib/auth/sessions';
import {
  CapabilityEngineError,
  resolveHumanCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  getDefaultEventTypeStore,
  executeGetEventTypeVersionCapability,
} from '../../../../lib/capabilities/event-types';
import { getDefaultEventCapabilityRuntime } from '../../../../lib/capabilities/events';
import {
  createJournalCursor,
  getDefaultJournalCapabilityRuntime,
} from '../../../../lib/capabilities/journal';
import { EventRoom } from './event-room';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function authenticateEventRoom(): Promise<AuthenticatedSession> {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required');
  }
  try {
    return await getDefaultSessionService().authenticate(token, 'web');
  } catch (error) {
    if (error instanceof SessionAccessError) {
      redirect('/login?reason=session-expired');
    }
    throw error;
  }
}

export default async function EventRoomPage({
  params,
}: Readonly<{
  params: Promise<Readonly<{ id: string }>>;
}>) {
  const { id } = await params;
  const parsedEventId = EventIdSchema.safeParse(id);
  if (!parsedEventId.success) {
    notFound();
  }
  const eventId = parsedEventId.data;
  const authenticated = await authenticateEventRoom();
  const serverTime = new Date();
  const queryInvocation = () =>
    resolveHumanCapabilityInvocation(authenticated, {
      requestId: randomUUID(),
      serverTime,
      mutation: null,
    });
  const eventRuntime = getDefaultEventCapabilityRuntime();
  const journalRuntime = getDefaultJournalCapabilityRuntime();

  try {
    const event = await eventRuntime.execute(
      'get-event',
      { eventId },
      queryInvocation(),
    );
    const [initialPage, facility, eventTypeVersion] = await Promise.all([
      journalRuntime.execute(
        'list-journal-entries',
        { eventId, cursor: null, limit: 100 },
        queryInvocation(),
      ),
      journalRuntime.execute(
        'get-facility',
        { facilityId: event.facilityId },
        queryInvocation(),
      ),
      executeGetEventTypeVersionCapability({
        store: getDefaultEventTypeStore(),
        authenticated,
        query: { eventTypeVersionId: event.eventTypeVersion.id },
        requestId: randomUUID(),
        now: serverTime,
      }),
    ]);
    const lastSequence = initialPage.items.at(-1)?.sequence ?? 0;
    const initialCursor =
      initialPage.pageInfo.nextCursor ??
      createJournalCursor(event.id, lastSequence);

    return (
      <EventRoom
        apiUrl={`/events/${encodeURIComponent(event.id)}/api`}
        authorDisplayName={authenticated.result.user.displayName}
        csrfCookieName={WEB_CSRF_COOKIE_NAME}
        event={event}
        eventTypeLabel={eventTypeVersion.name}
        facilityLabel={facility.name}
        initialCursor={initialCursor}
        initialEntries={initialPage.items}
        initialHasMore={initialPage.pageInfo.hasMore}
        sessionId={authenticated.result.session.id}
      />
    );
  } catch (error) {
    if (
      error instanceof CapabilityEngineError &&
      (error.status === 403 || error.status === 404)
    ) {
      notFound();
    }
    throw error;
  }
}
