import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  EventTypeCapabilityError,
  executeListEventTypesCapability,
  type EventTypeStore,
} from '../../../lib/capabilities/event-types';

const FORBIDDEN_DOCUMENT = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Administrator access required | PSD EOC</title></head>
  <body><main><h1>Administrator access required</h1><p role="alert">Your PSD EOC session is active, but only administrators can manage responses and message templates.</p><p>No event was started and no notification was sent.</p></main></body>
</html>`;

/** Capability-backed landing response, separated from the Next route exports. */
export async function eventTypeLandingResponse(
  requestUrl: string,
  authenticated: AuthenticatedSession,
  store: EventTypeStore,
): Promise<Response> {
  try {
    await executeListEventTypesCapability({
      store,
      authenticated,
      query: {
        templateMode: null,
        enabled: null,
        cursor: null,
        limit: 1,
      },
    });
    return Response.redirect(new URL('/event-types/manage', requestUrl), 303);
  } catch (error) {
    if (
      error instanceof EventTypeCapabilityError &&
      error.code === 'FORBIDDEN'
    ) {
      return new Response(FORBIDDEN_DOCUMENT, {
        status: 403,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    throw error;
  }
}
