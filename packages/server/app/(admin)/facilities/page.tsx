import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import { AdminCapabilityError } from './admin-core';
import { executeFacilitiesAdminProjection } from './capabilities';
import {
  FacilitiesAdminView,
  NON_ADMIN_FACILITIES_VIEW,
} from './facilities-admin-view';
import {
  facilitiesAdminStatusMessage,
  normalizeFacilitiesAdminCursorState,
  redirectInvalidFacilitiesAdminQuery,
  type FacilitiesAdminSearchParameters,
} from './facilities-page-state';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function FacilitiesPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<FacilitiesAdminSearchParameters>;
}>) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined) {
    redirect('/login?reason=session-required');
  }
  let authenticated: AuthenticatedSession;
  try {
    authenticated = await getDefaultSessionService().authenticate(
      sessionToken,
      'web',
    );
  } catch {
    redirect('/login?reason=session-expired');
  }
  const csrfToken = cookieStore.get(WEB_CSRF_COOKIE_NAME)?.value;
  if (csrfToken === undefined) {
    redirect('/login?reason=session-required');
  }
  const parameters = await searchParams;
  try {
    const currentCursors = normalizeFacilitiesAdminCursorState(parameters);
    const projection = await executeFacilitiesAdminProjection({
      authenticated,
      queries: {
        facilities: {
          includeInactive: true,
          cursor: currentCursors.facilityCursor,
          limit: 200,
        },
        neighborhoods: {
          cursor: currentCursors.neighborhoodCursor,
          limit: 200,
        },
        buildingGroups: {
          kind: null,
          purpose: 'building',
          facilityId: null,
          active: null,
          cursor: currentCursors.buildingGroupCursor,
          limit: 500,
        },
        othersGroups: {
          kind: null,
          purpose: 'others',
          facilityId: null,
          active: null,
          cursor: currentCursors.othersGroupCursor,
          limit: 500,
        },
      },
    });
    return (
      <FacilitiesAdminView
        csrfToken={csrfToken}
        statusMessage={facilitiesAdminStatusMessage(parameters.status)}
        view={{
          kind: 'authorized',
          ...projection,
          currentCursors,
        }}
      />
    );
  } catch (error) {
    if (error instanceof AdminCapabilityError && error.status === 403) {
      return <FacilitiesAdminView view={NON_ADMIN_FACILITIES_VIEW} />;
    }
    redirectInvalidFacilitiesAdminQuery(error);
    throw error;
  }
}
