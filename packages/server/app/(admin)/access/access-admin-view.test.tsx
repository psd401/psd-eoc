import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  GroupSourcePageSchema,
  UserPageSchema,
  type Facility,
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
  reviewFacility: '10000000-0000-4000-8000-000000000006',
} as const;

const CREATED_AT = '2026-08-08T17:00:00.000Z';
const CSRF_TOKEN = 'synthetic-csrf-token';
const FACILITIES: readonly Facility[] = Object.freeze([
  {
    id: IDS.facility,
    code: 'AES',
    name: 'Artondale Elementary',
    active: true,
    isolated: false,
    createdAt: CREATED_AT,
  },
  {
    id: IDS.reviewFacility,
    code: 'RVW',
    name: 'App Review',
    active: true,
    isolated: true,
    createdAt: CREATED_AT,
  },
]);

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
        grantedRole: 'staff',
        displayName: 'PSD EOC Staff Access',
        active: true,
        membersCapturedAt: CREATED_AT,
        googleGroupId: '01-access-group',
        email: 'eoc-access@example.invalid',
        createdAt: CREATED_AT,
      },
      ...(includeUnexpected
        ? [
            {
              id: IDS.buildingGroup,
              kind: 'synthetic' as const,
              purpose: 'building' as const,
              facilityId: IDS.facility,
              grantedRole: null,
              displayName: 'Must Not Render',
              active: true,
              membersCapturedAt: null,
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
        email: 'alex.staff@example.invalid',
        displayName: 'Alex Staff',
        roles: ['staff', 'admin'],
        facilityScope: { kind: 'district' },
        createdAt: CREATED_AT,
        disabledAt: null,
      },
      {
        id: IDS.disabledUser,
        googleSubject: 'synthetic-google-subject-two',
        email: 'casey.staff@example.invalid',
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
    facilities: FACILITIES,
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
    expect(html).not.toContain('@example.invalid');
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
    expect(html).toContain('Access groups and the roles they grant');
    expect(html).toContain(
      '<caption>Designated Google Groups that permit staff sign-in</caption>',
    );
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('PSD EOC Staff Access');
    expect(html).toContain('01-access-group');
    expect(html).toContain('eoc-access@example.invalid');
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
      'An email correction is looked up from Google when you save and takes the Google Group ID Google holds for the new address.',
    );
    expect(html).toContain('<legend>Add a Google access group</legend>');
    // The Google Group ID is Google's to say. Neither form asks for it; the
    // editor shows the one Google resolved, and the create form says the
    // lookup happens on save.
    expect(html).not.toContain('name="googleGroupId"');
    expect(html).toContain(
      'its Google Group ID is looked up from Google when you save.',
    );
    expect(html).toContain('<code>01-access-group</code>, as Google');
    // The role is what an access group grants; without a field for it the
    // form could never satisfy the contract, so no second group could ever be
    // added. Both the create form and the editor carry it, staff first.
    expect(html.match(/name="grantedRole"/gu)).toHaveLength(2);
    expect(html).toMatch(/<option value="staff"[^>]*>Staff<\/option>/u);
    expect(html).toMatch(/<option value="admin"[^>]*>Administrator<\/option>/u);
    // A new group defaults to staff; only an explicit choice grants admin.
    expect(html).toMatch(
      /value="create-access-group"[\s\S]*?<option value="staff" selected=""/u,
    );
    expect(html).toContain(
      'Only designated Google Groups can grant PSD EOC access.',
    );
    expect(html).not.toContain('synthetic groups cannot be access groups');
    expect(html).toMatch(
      /<input[^>]*name="intent"[^>]*value="create-access-group"/u,
    );
    expect(html).toMatch(
      /<input[^>]*name="intent"[^>]*value="update-access-group"/u,
    );
    // Two access-group forms, plus one facility-limit form per person.
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

  test('lists the roles the groups grant without a control that writes them', () => {
    const html = renderAuthorized();

    expect(html).toContain(
      '<caption>Minimized staff accounts and the roles their groups grant</caption>',
    );
    expect(html).toContain('<th scope="col">Roles</th>');
    expect(html).toContain('<td>admin, staff</td>');
    expect(html).toContain('<td>staff</td>');
    expect(html).toContain('District-wide');
    expect(html).toContain('1 facility');
    // There is no role editor. Roles come from trusted-group membership on
    // every request, so a control here would write a grant nothing reads.
    expect(html).not.toContain('set-user-roles');
    expect(html).not.toContain('<legend>Roles for Alex Staff</legend>');
    expect(html).not.toMatch(/name="roles"/u);
    expect(html).not.toContain('synthetic-google-subject-one');
    expect(html).not.toContain('synthetic-google-subject-two');
    expect(html).not.toMatch(/<(?:button|input|select)[^>]*tabindex=/u);
  });

  test('offers a facility limit per person that posts through the capability route', () => {
    const html = renderAuthorized();

    // One form per person, each naming the person and every active facility.
    expect(html.match(/value="set-user-facility-scope"/gu)).toHaveLength(2);
    expect(html).toContain(`name="userId" value="${IDS.user}"`);
    expect(html).toContain(`name="userId" value="${IDS.disabledUser}"`);
    expect(html).toContain('<legend>Where Alex Staff may act</legend>');
    expect(html).toContain('<legend>Where Casey Staff may act</legend>');
    expect(html).toContain('AES — Artondale Elementary');
    expect(html).toContain('RVW — App Review (isolated)');
    expect(html.match(/type="checkbox" name="facilityIds"/gu)).toHaveLength(4);
    // The current scope is pre-selected: Alex is district-wide, Casey is
    // limited to Artondale.
    expect(
      html.match(
        /<input type="checkbox" name="facilityIds" checked="" value="[^"]+"/gu,
      ),
    ).toEqual([
      `<input type="checkbox" name="facilityIds" checked="" value="${IDS.facility}"`,
    ]);
    expect(
      html.match(
        /<input type="radio" name="scopeKind" checked="" value="[^"]+"/gu,
      ),
    ).toEqual([
      '<input type="radio" name="scopeKind" checked="" value="district"',
      '<input type="radio" name="scopeKind" checked="" value="facilities"',
    ]);
    expect(html).toContain('Save facility scope');
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
