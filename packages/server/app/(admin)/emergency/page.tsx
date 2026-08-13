import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
} from '../../../lib/auth/sessions';
import { AdminCapabilityError } from '../facilities/admin-core';
import { executeGetFanoutControlCapability } from './capabilities';
import {
  EmergencyAdminView,
  NON_ADMIN_EMERGENCY_VIEW,
} from './emergency-admin-view';
import { emergencyControlStatusMessage } from './request';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function EmergencyControlPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Readonly<{ status?: string | string[] }>>;
}>) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined) redirect('/login?reason=session-required');
  let authenticated;
  try {
    authenticated = await getDefaultSessionService().authenticate(
      sessionToken,
      'web',
    );
  } catch {
    redirect('/login?reason=session-expired');
  }
  if (
    !authenticated.roles.includes('admin') ||
    authenticated.scope.facilityScope.kind !== 'district'
  ) {
    return <EmergencyAdminView view={NON_ADMIN_EMERGENCY_VIEW} />;
  }
  const csrfToken = cookieStore.get(WEB_CSRF_COOKIE_NAME)?.value;
  if (csrfToken === undefined) redirect('/login?reason=session-required');
  try {
    const state = await executeGetFanoutControlCapability({ authenticated });
    const parameters = await searchParams;
    return (
      <EmergencyAdminView
        csrfToken={csrfToken}
        statusMessage={emergencyControlStatusMessage(parameters.status)}
        view={{ kind: 'authorized', state }}
      />
    );
  } catch (error) {
    if (error instanceof AdminCapabilityError && error.status === 403) {
      return <EmergencyAdminView view={NON_ADMIN_EMERGENCY_VIEW} />;
    }
    throw error;
  }
}
