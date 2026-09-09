import { describe, expect, test } from 'bun:test';
import {
  FacilityPageSchema,
  GroupSourcePageSchema,
  NeighborhoodPageSchema,
} from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FacilitiesAdminView,
  NON_ADMIN_FACILITIES_VIEW,
  type FacilitiesAdminViewModel,
} from './facilities-admin-view';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const AT = '2026-08-10T18:00:00.000Z';
const IDS = Object.freeze({
  buildingGoogle: uuid(2651),
  buildingSuperseded: uuid(2658),
  buildingSynthetic: uuid(2652),
  facilityA: uuid(2653),
  facilityB: uuid(2654),
  facilityC: uuid(2659),
  neighborhood: uuid(2655),
  othersGoogle: uuid(2656),
  othersInactiveUnselected: uuid(2660),
  othersManual: uuid(2661),
  othersSynthetic: uuid(2657),
});

const AUTHORIZED_VIEW_BASE = Object.freeze({
  kind: 'authorized' as const,
  facilities: FacilityPageSchema.parse({
    items: [
      {
        id: IDS.facilityA,
        code: 'HARBOR',
        name: 'Harbor Elementary',
        active: true,
        createdAt: AT,
      },
      {
        id: IDS.facilityB,
        code: 'RIDGE',
        name: 'Ridge Middle School',
        active: false,
        createdAt: AT,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }),
  neighborhoods: NeighborhoodPageSchema.parse({
    items: [
      {
        id: IDS.neighborhood,
        name: 'Harbor campus corrected',
        facilityIds: [IDS.facilityA, IDS.facilityB],
        version: 3,
        createdAt: AT,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }),
  buildingGroups: GroupSourcePageSchema.parse({
    items: [
      {
        id: IDS.buildingGoogle,
        kind: 'google-group',
        purpose: 'building',
        facilityId: IDS.facilityA,
        grantedRole: null,
        displayName: 'Harbor staff',
        active: true,
        membersCapturedAt: AT,
        googleGroupId: 'google-harbor-staff',
        email: 'harbor-staff@example.invalid',
        createdAt: AT,
      },
      {
        id: IDS.buildingSynthetic,
        kind: 'synthetic',
        purpose: 'building',
        facilityId: IDS.facilityB,
        grantedRole: null,
        displayName: 'Ridge test staff',
        active: true,
        membersCapturedAt: null,
        fixtureKey: 'ridge-test-staff',
        createdAt: AT,
      },
      {
        id: IDS.buildingSuperseded,
        kind: 'google-group',
        purpose: 'building',
        facilityId: IDS.facilityA,
        grantedRole: null,
        displayName: 'Harbor staff historical source',
        active: false,
        membersCapturedAt: AT,
        googleGroupId: 'google-harbor-staff-old',
        email: 'harbor-staff-old@example.invalid',
        createdAt: AT,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }),
  othersGroups: GroupSourcePageSchema.parse({
    items: [
      {
        id: IDS.othersGoogle,
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        grantedRole: null,
        displayName: 'District response staff',
        active: true,
        membersCapturedAt: AT,
        googleGroupId: 'google-district-response',
        email: 'district-response@example.invalid',
        createdAt: AT,
      },
      {
        id: IDS.othersSynthetic,
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
        grantedRole: null,
        displayName: 'District test response staff',
        active: true,
        membersCapturedAt: null,
        fixtureKey: 'district-test-response',
        createdAt: AT,
      },
      {
        id: IDS.othersManual,
        kind: 'manual',
        purpose: 'others',
        facilityId: null,
        grantedRole: null,
        displayName: 'District responders',
        active: true,
        membersCapturedAt: null,
        googleGroupId: null,
        email: null,
        fixtureKey: null,
        createdAt: AT,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }),
});

const AUTHORIZED_VIEW = Object.freeze({
  ...AUTHORIZED_VIEW_BASE,
  facilityOptions: AUTHORIZED_VIEW_BASE.facilities.items,
  neighborhoodOptions: AUTHORIZED_VIEW_BASE.neighborhoods.items,
  buildingGroupOptions: AUTHORIZED_VIEW_BASE.buildingGroups.items,
  othersGroupOptions: AUTHORIZED_VIEW_BASE.othersGroups.items,
  currentCursors: Object.freeze({
    buildingGroupCursor: null,
    facilityCursor: null,
    neighborhoodCursor: null,
    othersGroupCursor: null,
  }),
}) satisfies FacilitiesAdminViewModel;

function renderAuthorized(): string {
  return renderToStaticMarkup(
    <FacilitiesAdminView
      csrfToken="csrf-token-for-view-test"
      statusMessage="The facility was added."
      view={AUTHORIZED_VIEW}
    />,
  );
}

describe('facilities administration view', () => {
  test('renders the complete native-form setup workflow with semantic landmarks', () => {
    const markup = renderAuthorized();

    expect(markup).toContain(
      '<main aria-labelledby="facilities-admin-heading" id="main-content" tabindex="-1">',
    );
    expect(markup).not.toContain('<nav');
    expect(markup).toContain(
      '<h1 id="facilities-admin-heading">Facilities, neighborhoods, and group sources</h1>',
    );
    expect(markup).toContain('<fieldset>');
    expect(markup).toContain('<legend>Add a facility</legend>');
    expect(markup).toContain('class="table-region" role="region" tabindex="0"');
    expect(markup).toContain('type="hidden" name="csrfToken"');
    expect(markup).toContain('type="hidden" name="idempotencyKey"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain('action="/facilities/api"');
    for (const intent of [
      'create-facility',
      'update-facility',
      'create-google-building-group',
      'create-google-others-group',
      'create-manual-others-group',
      'replace-google-building-group',
      'replace-google-others-group',
      'create-neighborhood-version',
    ]) {
      expect(markup).toContain(`value="${intent}"`);
    }
    // The district-level list has an add form and, once it exists, a member
    // editor: a manual others source is curated in the application.
    expect(markup).toContain('<legend>Add a manual others source</legend>');
    expect(markup).toContain('People notified by District responders');
    for (const intent of [
      'create-synthetic-building-group',
      'create-synthetic-others-group',
      'replace-synthetic-building-group',
      'replace-synthetic-others-group',
    ]) {
      expect(markup).not.toContain(`value="${intent}"`);
    }
    expect(markup).not.toContain('name="fixtureKey"');
    expect(markup).toContain('Ridge test staff');
    expect(markup).toContain('District test response staff');
  });

  test('makes append-only and server-owned source behavior explicit', () => {
    const markup = renderAuthorized();

    expect(markup).toContain(
      'Building and others group sources are immutable.',
    );
    expect(markup).toContain(
      'Replacing one creates a new source and appends a roster configuration version',
    );
    expect(markup).not.toContain('update-building-group');
    expect(markup).not.toContain('update-others-group');
    expect(markup).toContain('A stale replacement is refused.');
    expect(markup).toContain(`name="sourceId" value="${IDS.buildingGoogle}"`);
    expect(markup).toContain(`name="sourceId" value="${IDS.othersGoogle}"`);
    expect(markup).not.toContain(`value="${IDS.buildingSuperseded}"`);
  });

  test('shows a waiting Google building source and offers the convention and sync-now actions', () => {
    const [waitingSource, ...otherBuildingSources] =
      AUTHORIZED_VIEW.buildingGroups.items;
    if (waitingSource?.kind !== 'google-group') {
      throw new Error('The fixture must lead with a Google building source.');
    }
    const view = {
      ...AUTHORIZED_VIEW,
      buildingGroups: GroupSourcePageSchema.parse({
        ...AUTHORIZED_VIEW.buildingGroups,
        items: [
          { ...waitingSource, googleGroupId: null },
          ...otherBuildingSources,
        ],
      }),
    } satisfies FacilitiesAdminViewModel;
    const markup = renderToStaticMarkup(
      <FacilitiesAdminView
        csrfToken="csrf-token-for-view-test"
        statusMessage={null}
        view={view}
      />,
    );

    // A source registered before Google held its group says so, instead of
    // showing an ID it does not have.
    expect(markup).toContain(`Waiting for Google Group ${waitingSource.email}`);
    expect(markup).not.toContain('null (');
    expect(markup).toContain('value="register-building-groups-by-convention"');
    expect(markup).toContain('Register building groups by naming convention');
    expect(markup).toContain('value="check-waiting-groups"');
    expect(markup).toContain('Check waiting groups with Google');
  });

  test('keeps complete form selections while all four displays paginate independently', () => {
    const facilityA = AUTHORIZED_VIEW.facilities.items[0]!;
    const facilityB = AUTHORIZED_VIEW.facilities.items[1]!;
    const facilityC = FacilityPageSchema.parse({
      items: [
        {
          id: IDS.facilityC,
          code: 'COVE',
          name: 'Cove Elementary',
          active: true,
          createdAt: AT,
        },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    }).items[0]!;
    const selectedInactiveOthers = Object.freeze({
      ...AUTHORIZED_VIEW.othersGroups.items[0]!,
      active: false,
    });
    const unselectedInactiveOthers = GroupSourcePageSchema.parse({
      items: [
        {
          id: IDS.othersInactiveUnselected,
          kind: 'synthetic',
          purpose: 'others',
          facilityId: null,
          grantedRole: null,
          displayName: 'Retired test responders',
          active: false,
          membersCapturedAt: null,
          fixtureKey: 'retired-test-responders',
          createdAt: AT,
        },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    }).items[0]!;
    const edgeView = Object.freeze({
      ...AUTHORIZED_VIEW,
      facilities: FacilityPageSchema.parse({
        items: [facilityA],
        pageInfo: { hasMore: true, nextCursor: 'facility-next' },
      }),
      neighborhoods: NeighborhoodPageSchema.parse({
        items: AUTHORIZED_VIEW.neighborhoods.items,
        pageInfo: { hasMore: true, nextCursor: 'neighborhood-next' },
      }),
      buildingGroups: GroupSourcePageSchema.parse({
        items: [AUTHORIZED_VIEW.buildingGroups.items[0]],
        pageInfo: { hasMore: true, nextCursor: 'building-next' },
      }),
      othersGroups: GroupSourcePageSchema.parse({
        items: [AUTHORIZED_VIEW.othersGroups.items[1]],
        pageInfo: { hasMore: true, nextCursor: 'others-next' },
      }),
      facilityOptions: [facilityA, facilityB, facilityC],
      neighborhoodOptions: AUTHORIZED_VIEW.neighborhoodOptions,
      buildingGroupOptions: AUTHORIZED_VIEW.buildingGroupOptions,
      othersGroupOptions: [
        selectedInactiveOthers,
        AUTHORIZED_VIEW.othersGroups.items[1]!,
        unselectedInactiveOthers,
      ],
      currentCursors: Object.freeze({
        buildingGroupCursor: 'building-current',
        facilityCursor: 'facility-current',
        neighborhoodCursor: 'neighborhood-current',
        othersGroupCursor: 'others-current',
      }),
    }) satisfies FacilitiesAdminViewModel;

    const markup = renderToStaticMarkup(
      <FacilitiesAdminView
        csrfToken="csrf-token-for-view-test"
        view={edgeView}
      />,
    );

    const offPageMemberInput = markup.match(
      new RegExp(
        `<input[^>]*id="neighborhood-${IDS.neighborhood}-facility-${IDS.facilityB}"[^>]*>`,
      ),
    )?.[0];
    expect(offPageMemberInput).toContain('checked=""');
    expect(markup).toContain(
      `<option value="${IDS.facilityC}">COVE — Cove Elementary</option>`,
    );
    expect(markup).not.toContain('<summary>Edit Cove Elementary</summary>');

    expect(markup).toContain(
      'href="/facilities?facilityCursor=facility-next&amp;neighborhoodCursor=neighborhood-current&amp;buildingGroupCursor=building-current&amp;othersGroupCursor=others-current"',
    );
    expect(markup).toContain(
      'href="/facilities?facilityCursor=facility-current&amp;neighborhoodCursor=neighborhood-next&amp;buildingGroupCursor=building-current&amp;othersGroupCursor=others-current"',
    );
    expect(markup).toContain(
      'href="/facilities?facilityCursor=facility-current&amp;neighborhoodCursor=neighborhood-current&amp;buildingGroupCursor=building-next&amp;othersGroupCursor=others-current"',
    );
    expect(markup).toContain(
      'href="/facilities?facilityCursor=facility-current&amp;neighborhoodCursor=neighborhood-current&amp;buildingGroupCursor=building-current&amp;othersGroupCursor=others-next"',
    );
  });

  test('forbidden rendering carries no configuration, forms, navigation, or CSRF data', () => {
    const markup = renderToStaticMarkup(
      <FacilitiesAdminView view={NON_ADMIN_FACILITIES_VIEW} />,
    );

    expect(markup).toContain('Administrator access required');
    expect(markup).toContain('No facility configuration was displayed.');
    expect(markup).not.toContain('Harbor Elementary');
    expect(markup).not.toContain('harbor-staff@example.invalid');
    expect(markup).not.toContain(IDS.facilityA);
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<nav');
    expect(markup).not.toContain('csrfToken');
  });
});
