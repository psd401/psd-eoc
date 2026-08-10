import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
} from '../../../lib/auth/sessions';
import { executeListGroupSourcesCapability } from '../facilities/capabilities';
import { AdminCapabilityError } from '../facilities/admin-core';
import { AccessAdminView, NON_ADMIN_ACCESS_VIEW } from './access-admin-view';
import { executeListUsersCapability } from './capabilities';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATUS_MESSAGES = Object.freeze({
  'access-group-created': 'The Google access group was added.',
  'access-group-updated': 'The Google access group was updated.',
  'roles-updated': 'The staff role assignment was updated.',
} as const);

function statusMessage(value: string | undefined): string | null {
  return value !== undefined && value in STATUS_MESSAGES
    ? STATUS_MESSAGES[value as keyof typeof STATUS_MESSAGES]
    : null;
}

export default async function AccessPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<
    Readonly<{
      accessGroupCursor?: string;
      userCursor?: string;
      status?: string;
    }>
  >;
}>) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined) {
    redirect('/login?reason=session-required');
  }
  let authenticated;
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
    const [accessGroups, users] = await Promise.all([
      executeListGroupSourcesCapability({
        authenticated,
        query: {
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          active: null,
          cursor: parameters.accessGroupCursor ?? null,
          limit: 100,
        },
      }),
      executeListUsersCapability({
        authenticated,
        query: {
          facilityId: null,
          includeDisabled: true,
          cursor: parameters.userCursor ?? null,
          limit: 100,
        },
      }),
    ]);
    return (
      <AccessAdminView
        csrfToken={csrfToken}
        statusMessage={statusMessage(parameters.status)}
        view={{ kind: 'authorized', accessGroups, users }}
      />
    );
  } catch (error) {
    if (error instanceof AdminCapabilityError && error.status === 403) {
      return <AccessAdminView view={NON_ADMIN_ACCESS_VIEW} />;
    }
    throw error;
  }
}
