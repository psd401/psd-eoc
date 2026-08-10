import { describe, expect, test } from 'bun:test';
import {
  AudienceConfigSchema,
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
  audience: uuid(2650),
  buildingGoogle: uuid(2651),
  buildingSynthetic: uuid(2652),
  facilityA: uuid(2653),
  facilityB: uuid(2654),
  neighborhood: uuid(2655),
  othersGoogle: uuid(2656),
  othersSynthetic: uuid(2657),
});

const AUTHORIZED_VIEW = Object.freeze({
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
        name: 'Harbor campus',
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
        displayName: 'Harbor staff',
        active: true,
        googleGroupId: 'google-harbor-staff',
        email: 'harbor-staff@example.invalid',
        createdAt: AT,
      },
      {
        id: IDS.buildingSynthetic,
        kind: 'synthetic',
        purpose: 'building',
        facilityId: IDS.facilityB,
        displayName: 'Ridge test staff',
        active: true,
        fixtureKey: 'ridge-test-staff',
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
        displayName: 'District response staff',
        active: true,
        googleGroupId: 'google-district-response',
        email: 'district-response@example.invalid',
        createdAt: AT,
      },
      {
        id: IDS.othersSynthetic,
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
        displayName: 'District test response staff',
        active: true,
        fixtureKey: 'district-test-response',
        createdAt: AT,
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  }),
  audienceConfigs: [
    AudienceConfigSchema.parse({
      id: IDS.audience,
      facilityId: IDS.facilityA,
      version: 2,
      targets: [
        { kind: 'building', facilityId: IDS.facilityA },
        {
          kind: 'neighborhood',
          neighborhood: { id: IDS.neighborhood, version: 2 },
        },
        {
          kind: 'others',
          groupSourceRef: {
            id: IDS.othersGoogle,
            kind: 'google-group',
            purpose: 'others',
            facilityId: null,
          },
        },
      ],
      createdAt: AT,
    }),
  ],
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
    expect(markup).toContain('<nav aria-label="Administration"');
    expect(markup).toContain(
      '<h1 id="facilities-admin-heading">Facilities, neighborhoods, and audiences</h1>',
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
      'create-synthetic-building-group',
      'create-google-others-group',
      'create-synthetic-others-group',
      'create-neighborhood-version',
      'create-audience-version',
    ]) {
      expect(markup).toContain(`value="${intent}"`);
    }
  });

  test('makes append-only and server-owned audience behavior explicit', () => {
    const markup = renderAuthorized();

    expect(markup).toContain(
      'Building and others group sources are immutable.',
    );
    expect(markup).toContain(
      'create a new source and then append a new audience version',
    );
    expect(markup).not.toContain('update-building-group');
    expect(markup).not.toContain('update-others-group');
    expect(markup).toContain('Building target (always included):');
    expect(markup).toContain(
      'The server always includes this facility&#x27;s building target',
    );
    expect(markup).not.toContain('name="buildingTarget"');
    expect(markup).toContain('Latest neighborhood version (optional)');
    expect(markup).toContain(`value="${IDS.neighborhood}:3" selected=""`);
    expect(markup).toContain('name="googleOthersGroupSourceId"');
    expect(markup).toContain('name="syntheticOthersGroupSourceId"');
    expect(markup).toContain('Do not mix both kinds in one audience version');
    expect(markup).toContain('Current immutable audience version:');
    expect(markup).toContain('Neighborhood Harbor campus');
  });

  test('forbidden rendering carries no configuration, forms, navigation, or CSRF data', () => {
    const markup = renderToStaticMarkup(
      <FacilitiesAdminView view={NON_ADMIN_FACILITIES_VIEW} />,
    );

    expect(markup).toContain('Administrator access required');
    expect(markup).toContain(
      'No facility or audience configuration was displayed.',
    );
    expect(markup).not.toContain('Harbor Elementary');
    expect(markup).not.toContain('harbor-staff@example.invalid');
    expect(markup).not.toContain(IDS.facilityA);
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('<nav');
    expect(markup).not.toContain('csrfToken');
  });
});
