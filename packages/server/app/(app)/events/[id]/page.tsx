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
import { getDefaultEventRoomCapabilityRuntime } from '../../../../lib/capabilities/event-room';
import { getDefaultJournalCapabilityRuntime } from '../../../../lib/capabilities/journal';
import { EventRoom } from './event-room';
import { eventRoomSignInUrl } from './return-to';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function authenticateEventRoom(
  eventId: string,
): Promise<AuthenticatedSession> {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect(eventRoomSignInUrl(eventId, 'session-required'));
  }
  try {
    return await getDefaultSessionService().authenticate(token, 'web');
  } catch (error) {
    if (error instanceof SessionAccessError) {
      redirect(eventRoomSignInUrl(eventId, 'session-expired'));
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
  const authenticated = await authenticateEventRoom(eventId);
  const serverTime = new Date();
  const queryInvocation = () =>
    resolveHumanCapabilityInvocation(authenticated, {
      requestId: randomUUID(),
      serverTime,
      mutation: null,
    });
  const eventRoomRuntime = getDefaultEventRoomCapabilityRuntime();
  const journalRuntime = getDefaultJournalCapabilityRuntime();

  try {
    const initialSync = await eventRoomRuntime.execute(
      { eventId, cursor: null, limit: 100 },
      queryInvocation(),
    );
    const event = initialSync.event;
    if (event === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'PERSISTENCE_CONFLICT',
        'The initial event-room synchronization omitted its event projection.',
        500,
      );
    }
    const [facility, eventTypeVersion] = await Promise.all([
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

    return (
      <EventRoom
        apiUrl={`/events/${encodeURIComponent(event.id)}/api`}
        authorDisplayName={authenticated.result.user.displayName}
        csrfCookieName={WEB_CSRF_COOKIE_NAME}
        event={event}
        eventTypeLabel={eventTypeVersion.name}
        facilityLabel={facility.name}
        initialCursor={initialSync.cursor}
        initialEntries={initialSync.entries}
        initialHasMore={initialSync.hasMore}
        initialSnapshotSequence={initialSync.snapshotSequence}
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
