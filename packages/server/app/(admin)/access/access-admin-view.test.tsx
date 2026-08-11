import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  GroupSourcePageSchema,
  UserPageSchema,
  type GroupSourcePage,
  type UserPage,
} from '@psd-eoc/contracts';

import {
  AccessAdminView,
  NON_ADMIN_ACCESS_VIEW,
  type AccessAdminViewModel,
} from './access-admin-view';

const IDS = {
  accessGroup: '10000000-0000-4000-8000-000000000001',
  buildingGroup: '10000000-0000-4000-8000-000000000002',
  user: '10000000-0000-4000-8000-000000000003',
  disabledUser: '10000000-0000-4000-8000-000000000004',
  facility: '10000000-0000-4000-8000-000000000005',
} as const;

const CREATED_AT = '2026-08-08T17:00:00.000Z';
const CSRF_TOKEN = 'synthetic-csrf-token';

function renderAuthorized(
  view: AccessAdminViewModel = authorizedView(),
): string {
  return renderToStaticMarkup(
    <AccessAdminView csrfToken={CSRF_TOKEN} view={view} />,
  );
}

function accessGroups(includeUnexpected = false): GroupSourcePage {
  return GroupSourcePageSchema.parse({
    items: [
      {
        id: IDS.accessGroup,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'PSD EOC Staff Access',
        active: true,
        googleGroupId: '01-access-group',
        email: 'eoc-access@psd401.net',
        createdAt: CREATED_AT,
      },
      ...(includeUnexpected
        ? [
            {
              id: IDS.buildingGroup,
              kind: 'synthetic' as const,
              purpose: 'building' as const,
              facilityId: IDS.facility,
              displayName: 'Must Not Render',
              active: true,
              fixtureKey: 'must-not-render',
              createdAt: CREATED_AT,
            },
          ]
        : []),
    ],
    pageInfo: {
      hasMore: true,
      nextCursor: 'access-cursor-safe',
    },
  });
}

function users(): UserPage {
  return UserPageSchema.parse({
    items: [
      {
        id: IDS.user,
        googleSubject: 'synthetic-google-subject-one',
        email: 'alex.staff@psd401.net',
        displayName: 'Alex Staff',
        roles: ['staff', 'admin'],
        facilityScope: { kind: 'district' },
        createdAt: CREATED_AT,
        disabledAt: null,
      },
      {
        id: IDS.disabledUser,
        googleSubject: 'synthetic-google-subject-two',
        email: 'casey.staff@psd401.net',
        displayName: 'Casey Staff',
        roles: ['staff'],
        facilityScope: {
          kind: 'facilities',
          facilityIds: [IDS.facility],
        },
        createdAt: CREATED_AT,
        disabledAt: '2026-08-09T17:00:00.000Z',
      },
    ],
    pageInfo: {
      hasMore: true,
      nextCursor: 'user-cursor-safe',
    },
  });
}

function authorizedView(
  groupPage: GroupSourcePage = accessGroups(),
): AccessAdminViewModel {
  return Object.freeze({
    kind: 'authorized' as const,
    accessGroups: groupPage,
    users: users(),
    cursors: Object.freeze({
      accessGroupCursor: 'current-access-cursor',
      userCursor: 'current-user-cursor',
    }),
  });
}

describe('AccessAdminView authorization boundary', () => {
  test('uses an immutable forbidden shape that cannot carry admin data', () => {
    expect(Object.isFrozen(NON_ADMIN_ACCESS_VIEW)).toBe(true);
    expect(NON_ADMIN_ACCESS_VIEW).toEqual({ kind: 'forbidden' });

    const html = renderToStaticMarkup(
      <AccessAdminView view={NON_ADMIN_ACCESS_VIEW} />,
    );
    expect(html).toContain('Administrator access required');
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      'No access group or staff-account configuration was displayed.',
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('@psd401.net');
  });

  test('fails closed when a non-access group reaches the view', () => {
    const html = renderAuthorized(authorizedView(accessGroups(true)));
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      'Some group data was not displayed because it was not Google access configuration.',
    );
    expect(html).not.toContain('Must Not Render');
    expect(html).not.toContain('must-not-render');
  });
});

describe('AccessAdminView semantics', () => {
  test('renders bounded Google access configuration with native POST forms', () => {
    const html = renderAuthorized();

    expect(html).toContain('id="main-content"');
    expect(html).toContain('Access groups and administrator roles');
    expect(html).toContain(
      '<caption>Designated Google Groups that permit staff sign-in</caption>',
    );
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('PSD EOC Staff Access');
    expect(html).toContain('01-access-group');
    expect(html).toContain('eoc-access@psd401.net');
    expect(html).toContain('<summary>Edit PSD EOC Staff Access</summary>');
    expect(html).toContain(
      'Changing only the display name or status retains this source&#x27;s internal ID.',
    );
    expect(html).toContain(
      'Correcting a provider locator creates a new source ID while the proven source and its replacement remain active until a new access snapshot proves the replacement and the old source can be retired.',
    );
    expect(html).toContain(
      'A locator replacement must be submitted as Active.',
    );
    expect(html).toContain(
      'An email correction also requires a distinct Google Group ID.',
    );
    expect(html).toContain('<legend>Add a Google access group</legend>');
    expect(html).toMatch(
      /<input[^>]*name="intent"[^>]*value="create-access-group"/u,
    );
    expect(html).toMatch(
      /<input[^>]*name="intent"[^>]*value="update-access-group"/u,
    );
    expect(
      html.match(/<form action="\/access\/api" method="post">/gu),
    ).toHaveLength(4);
    expect(html.match(/name="csrfToken"/gu)).toHaveLength(4);
    expect(html.match(/value="synthetic-csrf-token"/gu)).toHaveLength(4);
    expect(html.match(/name="idempotencyKey"/gu)).toHaveLength(4);
    expect(html).not.toContain('method="get"');
    expect(html).not.toContain('fixtureKey');
    expect(html).not.toContain('name="kind"');
    expect(html).not.toContain('name="purpose"');
  });

  test('renders keyboard-native role controls without exposing Google subjects', () => {
    const html = renderAuthorized();

    expect(html).toContain(
      '<caption>Minimized staff accounts and role assignments</caption>',
    );
    expect(html).toContain('<legend>Roles for Alex Staff</legend>');
    expect(html).toContain(
      'id="user-10000000-0000-4000-8000-000000000003-staff"',
    );
    expect(html).toMatch(
      /<input[^>]*id="user-10000000-0000-4000-8000-000000000003-admin"[^>]*checked=""[^>]*value="admin"/u,
    );
    expect(html).toContain('Save roles for Alex Staff');
    expect(html).toContain(
      'Changes append grant or revocation facts; prior history remains immutable.',
    );
    expect(html).toContain('>Administrator</label>');
    expect(html).not.toMatch(/name="roles" type="hidden"/u);
    expect(html).not.toMatch(/id="user-[^"]+-admin"[^>]*disabled/u);
    expect(html).toContain('District-wide');
    expect(html).toContain('1 facility');
    expect(html).toContain(
      'This account is disabled; roles cannot be changed.',
    );
    expect(html).toContain('<fieldset disabled="">');
    expect(html).not.toContain('synthetic-google-subject-one');
    expect(html).not.toContain('synthetic-google-subject-two');
    expect(html).not.toMatch(/<(?:button|input|select)[^>]*tabindex=/u);
  });

  test('renders independent opaque pagination links for both tables', () => {
    const html = renderAuthorized();
    expect(html).toContain(
      'href="/access?accessGroupCursor=access-cursor-safe&amp;userCursor=current-user-cursor"',
    );
    expect(html).toContain('Next page of access groups');
    expect(html).toContain(
      'href="/access?accessGroupCursor=current-access-cursor&amp;userCursor=user-cursor-safe"',
    );
    expect(html).toContain('Next page of staff accounts');
  });
});
