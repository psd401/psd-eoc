import { describe, expect, test } from 'bun:test';

import { AdminForm, AdminFormError } from '../admin-request';
import { parseFacilitiesAdminMutation } from './request';

const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const IDS = Object.freeze({
  buildingSource: uuid(2607),
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

    // A manual others source names no facility and no provider: it is the
    // district-level list curated in the application.
    const manualOthers = parseFacilitiesAdminMutation(
      adminForm('create-manual-others-group', [
        ['displayName', 'District responders'],
      ]),
    );
    expect(manualOthers).toMatchObject({
      intent: 'create-manual-others-group',
      command: {
        kind: 'manual',
        purpose: 'others',
        facilityId: null,
        googleGroupId: null,
        email: null,
        fixtureKey: null,
      },
      status: 'others-group-created',
    });
    expect(() =>
      parseFacilitiesAdminMutation(
        adminForm('create-manual-others-group', [
          ['displayName', 'District responders'],
          ['facilityId', '00000000-0000-4000-8000-000000000001'],
        ]),
      ),
    ).toThrow();

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

  test('parses immutable building and others replacements through the canonical update contract', () => {
    const building = parseFacilitiesAdminMutation(
      adminForm('replace-google-building-group', [
        ['sourceId', IDS.buildingSource],
        ['facilityId', IDS.facilityA],
        ['displayName', 'Site A staff replacement'],
        ['googleGroupId', 'google-site-a-staff-v2'],
        ['email', 'site-a-v2@example.invalid'],
      ]),
    );
    expect(building).toEqual({
      intent: 'replace-google-building-group',
      command: {
        id: IDS.buildingSource,
        kind: 'google-group',
        purpose: 'building',
        facilityId: IDS.facilityA,
        displayName: 'Site A staff replacement',
        active: true,
        googleGroupId: 'google-site-a-staff-v2',
        email: 'site-a-v2@example.invalid',
      },
      status: 'building-group-replaced',
    });

    const others = parseFacilitiesAdminMutation(
      adminForm('replace-synthetic-others-group', [
        ['sourceId', IDS.syntheticOthers],
        ['displayName', 'District test response replacement'],
        ['fixtureKey', 'district-test-response-v2'],
      ]),
    );
    expect(others).toEqual({
      intent: 'replace-synthetic-others-group',
      command: {
        id: IDS.syntheticOthers,
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
        displayName: 'District test response replacement',
        active: true,
        fixtureKey: 'district-test-response-v2',
      },
      status: 'others-group-replaced',
    });
    expect(Object.isFrozen(building.command)).toBe(true);
    expect(Object.isFrozen(others.command)).toBe(true);
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

  test('rejects unlisted fields and exposes no in-place building or others update intent', () => {
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
        adminForm('update-building-group', [['facilityId', IDS.facilityA]]),
      ),
    ).toThrow(AdminFormError);
    expect(() =>
      parseFacilitiesAdminMutation(
        adminForm('replace-google-others-group', [
          ['sourceId', IDS.googleOthers],
          ['facilityId', IDS.facilityA],
          ['displayName', 'Smuggled facility binding'],
          ['googleGroupId', 'google-other-v2'],
          ['email', 'other-v2@example.invalid'],
        ]),
      ),
    ).toThrow(AdminFormError);
  });
});
