import {
  SessionAccessError,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import { applicationUrlForRequest } from '../../../lib/auth/application-origin';
import { authenticateSessionRequest } from '../../../lib/auth/middleware';
import { getDefaultEventTypeStore } from '../../../lib/capabilities/event-types';
import { eventTypeLandingResponse } from './landing';

export async function GET(request: Request): Promise<Response> {
  let authenticated: AuthenticatedSession;
  try {
    authenticated = await authenticateSessionRequest(
      request,
      getDefaultSessionService(),
      { mutation: false },
    );
  } catch (error) {
    if (error instanceof SessionAccessError) {
      return Response.redirect(
        applicationUrlForRequest(request.url, '/login?reason=session-required'),
        303,
      );
    }
    throw error;
  }
  return eventTypeLandingResponse(
    applicationUrlForRequest(request.url, '/event-types').toString(),
    authenticated,
    getDefaultEventTypeStore(),
  );
}
