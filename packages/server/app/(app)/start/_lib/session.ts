import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  SessionAccessError,
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../../../lib/auth/sessions';
import type { StartFlowReturnPath } from './return-path';

/** Resolves a fresh server-side session without any Google dependency. */
export async function requirePageSession(
  returnTo: '/' | StartFlowReturnPath,
): Promise<AuthenticatedSession> {
  const token = (await cookies()).get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect(
      `/login?reason=session-required&returnTo=${encodeURIComponent(returnTo)}`,
    );
  }

  try {
    return await getDefaultSessionService().authenticate(token, 'web');
  } catch (error) {
    if (error instanceof SessionAccessError) {
      redirect(
        `/login?reason=session-expired&returnTo=${encodeURIComponent(returnTo)}`,
      );
    }
    throw error;
  }
}
