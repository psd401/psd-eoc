import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { WEB_SESSION_COOKIE_NAME } from '../../../lib/auth/sessions';
import { authenticateWebSession } from '../../../lib/auth/request-session';
import { AdminCapabilityError } from '../../../lib/capabilities/admin';
import {
  AdminReadinessView,
  ForbiddenAdminReadiness,
} from './admin-readiness-view';
import { executeGetAdminReadinessCapability } from './capabilities';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AdminReadinessPage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined) {
    redirect('/login?reason=session-required');
  }
  let authenticated;
  try {
    authenticated = await authenticateWebSession(sessionToken);
  } catch {
    redirect('/login?reason=session-expired');
  }

  try {
    const readiness = await executeGetAdminReadinessCapability({
      authenticated,
    });
    return <AdminReadinessView readiness={readiness} />;
  } catch (error) {
    if (error instanceof AdminCapabilityError && error.status === 403) {
      return <ForbiddenAdminReadiness />;
    }
    throw error;
  }
}
