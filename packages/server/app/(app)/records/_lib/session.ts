import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  SessionAccessError,
  WEB_SESSION_COOKIE_NAME,
  type AuthenticatedSession,
} from '../../../../lib/auth/sessions';
import { authenticateWebSession } from '../../../../lib/auth/request-session';

export type RecordsSignInReason = 'session-expired' | 'session-required';

function safeRecordsReturnTo(value: string): string {
  if (
    value.length > 2_048 ||
    (value !== '/records' &&
      !value.startsWith('/records?') &&
      !value.startsWith('/records/'))
  ) {
    return '/records';
  }
  return value;
}

export function recordsSignInUrl(
  returnTo: string,
  reason: RecordsSignInReason,
): string {
  const query = new URLSearchParams({
    reason,
    returnTo: safeRecordsReturnTo(returnTo),
  });
  return `/login?${query.toString()}`;
}

/** Resolves a fresh server-side web session for the records page. */
export async function requireRecordsPageSession(
  returnTo: string,
): Promise<AuthenticatedSession> {
  const token = (await cookies()).get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect(recordsSignInUrl(returnTo, 'session-required'));
  }
  try {
    return await authenticateWebSession(token);
  } catch (error) {
    if (error instanceof SessionAccessError) {
      redirect(recordsSignInUrl(returnTo, 'session-expired'));
    }
    throw error;
  }
}
