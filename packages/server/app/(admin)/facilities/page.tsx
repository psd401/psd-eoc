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

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATUS_MESSAGES = Object.freeze({
  'audience-version-created': 'The facility audience version was saved.',
  'building-group-created': 'The immutable building source was added.',
  'building-group-replaced':
    'The building source was replaced with a new immutable source and roster configuration version.',
  'facility-created': 'The facility was added.',
  'facility-updated': 'The facility settings were updated.',
  'neighborhood-version-created': 'The neighborhood version was saved.',
  'others-group-created': 'The immutable others source was added.',
  'others-group-replaced':
    'The others source was replaced with a new immutable source and roster configuration version.',
} as const);

export function statusMessage(value: string | undefined): string | null {
  return value !== undefined && Object.hasOwn(STATUS_MESSAGES, value)
    ? STATUS_MESSAGES[value as keyof typeof STATUS_MESSAGES]
    : null;
}

export default async function FacilitiesPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<
    Readonly<{
      buildingGroupCursor?: string;
      facilityCursor?: string;
      neighborhoodCursor?: string;
      othersGroupCursor?: string;
      status?: string;
    }>
  >;
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
  const currentCursors = Object.freeze({
    buildingGroupCursor: parameters.buildingGroupCursor ?? null,
    facilityCursor: parameters.facilityCursor ?? null,
    neighborhoodCursor: parameters.neighborhoodCursor ?? null,
    othersGroupCursor: parameters.othersGroupCursor ?? null,
  });
  try {
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
        statusMessage={statusMessage(parameters.status)}
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
    throw error;
  }
}
