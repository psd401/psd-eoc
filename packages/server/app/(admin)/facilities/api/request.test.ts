import { describe, expect, test } from 'bun:test';

import { AdminForm, AdminFormError } from '../admin-request';
import { parseFacilitiesAdminMutation } from './request';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  audience: uuid(2601),
  facilityA: uuid(2602),
  facilityB: uuid(2603),
  googleOthers: uuid(2604),
  neighborhood: uuid(2605),
  syntheticOthers: uuid(2606),
});

function adminForm(
  intent: string,
  fields: readonly (readonly [string, string])[],
): AdminForm {
  const parameters = new URLSearchParams();
  parameters.set('csrfToken', 'csrf-token-for-request-test');
  parameters.set('idempotencyKey', 'issue-26-request-test-0001');
  parameters.set('intent', intent);
  fields.forEach(([name, value]) => parameters.append(name, value));
  return new AdminForm(parameters);
}

describe('facilities administration form parsing', () => {
  test('parses facility create and update through canonical contracts', () => {
    const created = parseFacilitiesAdminMutation(
      adminForm('create-facility', [
        ['code', 'NEW-SITE'],
        ['name', 'New Site'],
      ]),
    );
    expect(created).toEqual({
      intent: 'create-facility',
      command: { code: 'NEW-SITE', name: 'New Site' },
      status: 'facility-created',
    });
    expect(Object.isFrozen(created.command)).toBe(true);

    const updated = parseFacilitiesAdminMutation(
      adminForm('update-facility', [
        ['facilityId', IDS.facilityA],
        ['code', 'SITE-A'],
        ['name', 'Site A'],
        ['active', 'false'],
      ]),
    );
    expect(updated).toMatchObject({
      intent: 'update-facility',
      command: {
        facilityId: IDS.facilityA,
        code: 'SITE-A',
        name: 'Site A',
        active: false,
      },
    });
  });

  test('server-fixes every building and others source kind and purpose', () => {
    const googleBuilding = parseFacilitiesAdminMutation(
      adminForm('create-google-building-group', [
        ['facilityId', IDS.facilityA],
        ['displayName', 'Site A staff'],
        ['googleGroupId', 'google-site-a-staff'],
        ['email', 'site-a@example.invalid'],
      ]),
    );
    expect(googleBuilding).toMatchObject({
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: IDS.facilityA,
        active: true,
      },
      status: 'building-group-created',
    });

    const syntheticBuilding = parseFacilitiesAdminMutation(
      adminForm('create-synthetic-building-group', [
        ['facilityId', IDS.facilityA],
        ['displayName', 'Site A test staff'],
        ['fixtureKey', 'site-a-test-staff'],
      ]),
    );
    expect(syntheticBuilding).toMatchObject({
      command: {
        kind: 'synthetic',
        purpose: 'building',
        facilityId: IDS.facilityA,
        active: true,
      },
    });

    const googleOthers = parseFacilitiesAdminMutation(
      adminForm('create-google-others-group', [
        ['displayName', 'District response staff'],
        ['googleGroupId', 'google-district-response'],
        ['email', 'response@example.invalid'],
      ]),
    );
    expect(googleOthers).toMatchObject({
      command: {
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
      },
      status: 'others-group-created',
    });

    const syntheticOthers = parseFacilitiesAdminMutation(
      adminForm('create-synthetic-others-group', [
        ['displayName', 'District test response staff'],
        ['fixtureKey', 'district-test-response'],
      ]),
    );
    expect(syntheticOthers).toMatchObject({
      command: {
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
      },
    });
  });

  test('parses new and superseding neighborhood versions with repeated facility fields', () => {
    const created = parseFacilitiesAdminMutation(
      adminForm('create-neighborhood-version', [
        ['name', 'Harbor neighborhood'],
        ['facilityIds', IDS.facilityA],
        ['facilityIds', IDS.facilityB],
      ]),
    );
    expect(created).toMatchObject({
      intent: 'create-neighborhood-version',
      command: {
        neighborhoodId: null,
        name: 'Harbor neighborhood',
        facilityIds: [IDS.facilityA, IDS.facilityB],
      },
    });

    const versioned = parseFacilitiesAdminMutation(
      adminForm('create-neighborhood-version', [
        ['neighborhoodId', IDS.neighborhood],
        ['name', 'Harbor neighborhood'],
        ['facilityIds', IDS.facilityA],
      ]),
    );
    expect(versioned).toMatchObject({
      command: {
        neighborhoodId: IDS.neighborhood,
        facilityIds: [IDS.facilityA],
      },
      status: 'neighborhood-version-created',
    });
  });

  test('always adds the building target and parses optional latest neighborhood and others refs', () => {
    const parsed = parseFacilitiesAdminMutation(
      adminForm('create-audience-version', [
        ['facilityId', IDS.facilityA],
        ['audienceConfigId', IDS.audience],
        ['neighborhoodReference', `${IDS.neighborhood}:3`],
        ['googleOthersGroupSourceId', IDS.googleOthers],
        ['syntheticOthersGroupSourceId', IDS.syntheticOthers],
      ]),
    );
    expect(parsed).toEqual({
      intent: 'create-audience-version',
      command: {
        audienceConfigId: IDS.audience,
        facilityId: IDS.facilityA,
        targets: [
          { kind: 'building', facilityId: IDS.facilityA },
          {
            kind: 'neighborhood',
            neighborhood: { id: IDS.neighborhood, version: 3 },
          },
          {
            kind: 'others',
            groupSourceRef: {
              id: IDS.googleOthers,
              kind: 'google-group',
              purpose: 'others',
              facilityId: null,
            },
          },
          {
            kind: 'others',
            groupSourceRef: {
              id: IDS.syntheticOthers,
              kind: 'synthetic',
              purpose: 'others',
              facilityId: null,
            },
          },
        ],
      },
      status: 'audience-version-created',
    });

    const buildingOnly = parseFacilitiesAdminMutation(
      adminForm('create-audience-version', [['facilityId', IDS.facilityB]]),
    );
    expect(buildingOnly).toMatchObject({
      command: {
        audienceConfigId: null,
        facilityId: IDS.facilityB,
        targets: [{ kind: 'building', facilityId: IDS.facilityB }],
      },
    });
  });

  test('rejects unlisted fields and exposes no building or others update intent', () => {
    expect(() =>
      parseFacilitiesAdminMutation(
        adminForm('create-google-building-group', [
          ['facilityId', IDS.facilityA],
          ['displayName', 'Site A staff'],
          ['googleGroupId', 'google-site-a-staff'],
          ['email', 'site-a@example.invalid'],
          ['fixtureKey', 'smuggled-field'],
        ]),
      ),
    ).toThrow(AdminFormError);
    expect(() =>
      parseFacilitiesAdminMutation(
        adminForm('create-audience-version', [
          ['facilityId', IDS.facilityA],
          ['targets', 'client-owned-targets'],
        ]),
      ),
    ).toThrow(AdminFormError);
    expect(() =>
      parseFacilitiesAdminMutation(
        adminForm('update-building-group', [['facilityId', IDS.facilityA]]),
      ),
    ).toThrow(AdminFormError);
  });
});
