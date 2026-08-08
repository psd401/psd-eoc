import {
  SessionAccessError,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
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
        new URL('/login?reason=session-required', request.url),
        303,
      );
    }
    throw error;
  }
  return eventTypeLandingResponse(
    request.url,
    authenticated,
    getDefaultEventTypeStore(),
  );
}
