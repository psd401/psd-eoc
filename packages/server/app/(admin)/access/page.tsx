import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
} from '../../../lib/auth/sessions';
import { authenticateWebSession } from '../../../lib/auth/request-session';
import {
  executeListFacilitiesCapability,
  executeListGroupSourcesCapability,
} from '../facilities/capabilities';
import { AdminCapabilityError } from '../../../lib/capabilities/admin';
import { AccessAdminView, NON_ADMIN_ACCESS_VIEW } from './access-admin-view';
import {
  accessAdminStatusMessage,
  isInvalidAccessAdminQueryError,
  normalizeAccessAdminCursorState,
  type AccessAdminSearchParameters,
} from './access-page-state';
import { executeListUsersCapability } from './capabilities';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AccessPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<AccessAdminSearchParameters>;
}>) {
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
  const csrfToken = cookieStore.get(WEB_CSRF_COOKIE_NAME)?.value;
  if (csrfToken === undefined) {
    redirect('/login?reason=session-required');
  }
  const parameters = await searchParams;
  try {
    const cursors = normalizeAccessAdminCursorState(parameters);
    const [accessGroups, users, facilities] = await Promise.all([
      executeListGroupSourcesCapability({
        authenticated,
        query: {
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          active: null,
          cursor: cursors.accessGroupCursor,
          limit: 100,
        },
      }),
      executeListUsersCapability({
        authenticated,
        query: {
          facilityId: null,
          includeDisabled: true,
          cursor: cursors.userCursor,
          limit: 100,
        },
      }),
      executeListFacilitiesCapability({
        authenticated,
        query: { includeInactive: false, cursor: null, limit: 200 },
      }),
    ]);
    return (
      <AccessAdminView
        csrfToken={csrfToken}
        statusMessage={accessAdminStatusMessage(parameters.status)}
        view={{
          kind: 'authorized',
          accessGroups,
          users,
          facilities: facilities.items,
          cursors,
        }}
      />
    );
  } catch (error) {
    if (error instanceof AdminCapabilityError && error.status === 403) {
      return <AccessAdminView view={NON_ADMIN_ACCESS_VIEW} />;
    }
    if (isInvalidAccessAdminQueryError(error)) {
      redirect('/access');
    }
    throw error;
  }
}
