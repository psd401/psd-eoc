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

/**
 * Stands in for Google. The ID it answers with is derived from the address so
 * a test can tell a resolved ID from anything a form might have carried.
 */
function googleThatResolves() {
  const asked: string[] = [];
  return {
    asked,
    resolve: async (email: string) => {
      asked.push(email);
      return `resolved:${email}`;
    },
  };
}

function googleThatIsNeverAsked() {
  return async (email: string): Promise<string> => {
    throw new Error(
      `No Google lookup was expected, but one asked for ${email}.`,
    );
  };
}

describe('facilities administration form parsing', () => {
  test('parses facility create and update through canonical contracts', async () => {
    const created = await parseFacilitiesAdminMutation(
      adminForm('create-facility', [
        ['code', 'NEW-SITE'],
        ['name', 'New Site'],
      ]),
      googleThatIsNeverAsked(),
    );
    expect(created).toEqual({
      intent: 'create-facility',
      command: { code: 'NEW-SITE', name: 'New Site' },
      status: 'facility-created',
    });
    expect(Object.isFrozen(created.command)).toBe(true);

    const updated = await parseFacilitiesAdminMutation(
      adminForm('update-facility', [
        ['facilityId', IDS.facilityA],
        ['code', 'SITE-A'],
        ['name', 'Site A'],
        ['active', 'false'],
      ]),
      googleThatIsNeverAsked(),
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

  test('server-fixes every building and others source kind and purpose', async () => {
    const google = googleThatResolves();
    const googleBuilding = await parseFacilitiesAdminMutation(
      adminForm('create-google-building-group', [
        ['facilityId', IDS.facilityA],
        ['displayName', 'Site A staff'],
        ['email', 'site-a@example.invalid'],
      ]),
      google.resolve,
    );
    expect(googleBuilding).toMatchObject({
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: IDS.facilityA,
        active: true,
        googleGroupId: 'resolved:site-a@example.invalid',
        email: 'site-a@example.invalid',
      },
      status: 'building-group-created',
    });

    const syntheticBuilding = await parseFacilitiesAdminMutation(
      adminForm('create-synthetic-building-group', [
        ['facilityId', IDS.facilityA],
        ['displayName', 'Site A test staff'],
        ['fixtureKey', 'site-a-test-staff'],
      ]),
      google.resolve,
    );
    expect(syntheticBuilding).toMatchObject({
      command: {
        kind: 'synthetic',
        purpose: 'building',
        facilityId: IDS.facilityA,
        active: true,
      },
    });

    const googleOthers = await parseFacilitiesAdminMutation(
      adminForm('create-google-others-group', [
        ['displayName', 'District response staff'],
        ['email', 'response@example.invalid'],
      ]),
      google.resolve,
    );
    expect(googleOthers).toMatchObject({
      command: {
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        googleGroupId: 'resolved:response@example.invalid',
      },
      status: 'others-group-created',
    });

    // A manual others source names no facility and no provider: it is the
    // district-level list curated in the application.
    const manualOthers = await parseFacilitiesAdminMutation(
      adminForm('create-manual-others-group', [
        ['displayName', 'District responders'],
      ]),
      google.resolve,
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
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('create-manual-others-group', [
          ['displayName', 'District responders'],
          ['facilityId', '00000000-0000-4000-8000-000000000001'],
        ]),
        google.resolve,
      ),
    ).rejects.toThrow();

    const syntheticOthers = await parseFacilitiesAdminMutation(
      adminForm('create-synthetic-others-group', [
        ['displayName', 'District test response staff'],
        ['fixtureKey', 'district-test-response'],
      ]),
      google.resolve,
    );
    expect(syntheticOthers).toMatchObject({
      command: {
        kind: 'synthetic',
        purpose: 'others',
        facilityId: null,
      },
    });
    // Only the two Google sources consulted Google; the synthetic and manual
    // sources have no Google Group to resolve.
    expect(google.asked).toEqual([
      'site-a@example.invalid',
      'response@example.invalid',
    ]);
  });

  test('registers a building source as waiting when Google does not hold its group, and never an others source', async () => {
    const asked: string[] = [];
    const resolvers = {
      resolve: googleThatIsNeverAsked(),
      resolveOrWaiting: async (email: string) => {
        asked.push(email);
        return null;
      },
    };
    const waiting = await parseFacilitiesAdminMutation(
      adminForm('create-google-building-group', [
        ['facilityId', IDS.facilityA],
        ['displayName', 'Site A staff'],
        ['email', 'SITE-A-EOC@example.invalid'],
      ]),
      resolvers,
    );
    expect(waiting).toMatchObject({
      command: {
        kind: 'google-group',
        purpose: 'building',
        facilityId: IDS.facilityA,
        googleGroupId: null,
        email: 'site-a-eoc@example.invalid',
      },
      status: 'building-group-created',
    });
    expect(asked).toEqual(['site-a-eoc@example.invalid']);

    // An others source is the district-wide list; it must exist to be
    // registered, so it resolves strictly and a lone function resolver
    // never lets anything wait.
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('create-google-others-group', [
          ['displayName', 'District responders'],
          ['email', 'responders@example.invalid'],
        ]),
        {
          resolve: async () => {
            throw new AdminFormError('Google refused the lookup.');
          },
          resolveOrWaiting: async () => null,
        },
      ),
    ).rejects.toThrow('Google refused the lookup.');
  });

  test('parses the convention registration and sync-now intents with no fields beyond the common ones', async () => {
    const convention = await parseFacilitiesAdminMutation(
      adminForm('register-building-groups-by-convention', []),
      googleThatIsNeverAsked(),
    );
    expect(convention).toEqual({
      intent: 'register-building-groups-by-convention',
      command: null,
      status: 'building-groups-registered',
    });
    const syncNow = await parseFacilitiesAdminMutation(
      adminForm('check-waiting-groups', []),
      googleThatIsNeverAsked(),
    );
    expect(syncNow).toEqual({
      intent: 'check-waiting-groups',
      command: null,
      status: 'waiting-groups-checked',
    });
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('check-waiting-groups', [['facilityId', IDS.facilityA]]),
        googleThatIsNeverAsked(),
      ),
    ).rejects.toBeInstanceOf(AdminFormError);
  });

  test('takes the Google Group ID from Google, never from the form', async () => {
    // A form that carries an ID of its own is refused outright: the field is
    // not on the allowed list, so nothing a person types can become the
    // stored ID that the scheduled sync later checks the row against.
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('create-google-others-group', [
          ['displayName', 'District response staff'],
          ['googleGroupId', 'typed-by-hand'],
          ['email', 'response@example.invalid'],
        ]),
        googleThatIsNeverAsked(),
      ),
    ).rejects.toThrow(AdminFormError);

    // A group Google will not resolve is refused as a form error before any
    // command exists, with the resolver's own explanation.
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('create-google-others-group', [
          ['displayName', 'District response staff'],
          ['email', 'nobody@example.invalid'],
        ]),
        async () => {
          throw new AdminFormError(
            'Google did not resolve nobody@example.invalid as an exact Google Group.',
          );
        },
      ),
    ).rejects.toThrow(/did not resolve nobody@example\.invalid/u);
  });

  test('parses immutable building and others replacements through the canonical update contract', async () => {
    const google = googleThatResolves();
    const building = await parseFacilitiesAdminMutation(
      adminForm('replace-google-building-group', [
        ['sourceId', IDS.buildingSource],
        ['facilityId', IDS.facilityA],
        ['displayName', 'Site A staff replacement'],
        ['email', 'site-a-v2@example.invalid'],
      ]),
      google.resolve,
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
        googleGroupId: 'resolved:site-a-v2@example.invalid',
        email: 'site-a-v2@example.invalid',
      },
      status: 'building-group-replaced',
    });

    const others = await parseFacilitiesAdminMutation(
      adminForm('replace-synthetic-others-group', [
        ['sourceId', IDS.syntheticOthers],
        ['displayName', 'District test response replacement'],
        ['fixtureKey', 'district-test-response-v2'],
      ]),
      google.resolve,
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
    expect(google.asked).toEqual(['site-a-v2@example.invalid']);
  });

  test('parses new and superseding neighborhood versions with repeated facility fields', async () => {
    const created = await parseFacilitiesAdminMutation(
      adminForm('create-neighborhood-version', [
        ['name', 'Harbor neighborhood'],
        ['facilityIds', IDS.facilityA],
        ['facilityIds', IDS.facilityB],
      ]),
      googleThatIsNeverAsked(),
    );
    expect(created).toMatchObject({
      intent: 'create-neighborhood-version',
      command: {
        neighborhoodId: null,
        name: 'Harbor neighborhood',
        facilityIds: [IDS.facilityA, IDS.facilityB],
      },
    });

    const versioned = await parseFacilitiesAdminMutation(
      adminForm('create-neighborhood-version', [
        ['neighborhoodId', IDS.neighborhood],
        ['name', 'Harbor neighborhood'],
        ['facilityIds', IDS.facilityA],
      ]),
      googleThatIsNeverAsked(),
    );
    expect(versioned).toMatchObject({
      command: {
        neighborhoodId: IDS.neighborhood,
        facilityIds: [IDS.facilityA],
      },
      status: 'neighborhood-version-created',
    });
  });

  test('rejects unlisted fields and exposes no in-place building or others update intent', async () => {
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('create-google-building-group', [
          ['facilityId', IDS.facilityA],
          ['displayName', 'Site A staff'],
          ['email', 'site-a@example.invalid'],
          ['fixtureKey', 'smuggled-field'],
        ]),
        googleThatIsNeverAsked(),
      ),
    ).rejects.toThrow(AdminFormError);
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('update-building-group', [['facilityId', IDS.facilityA]]),
        googleThatIsNeverAsked(),
      ),
    ).rejects.toThrow(AdminFormError);
    await expect(
      parseFacilitiesAdminMutation(
        adminForm('replace-google-others-group', [
          ['sourceId', IDS.googleOthers],
          ['facilityId', IDS.facilityA],
          ['displayName', 'Smuggled facility binding'],
          ['email', 'other-v2@example.invalid'],
        ]),
        googleThatIsNeverAsked(),
      ),
    ).rejects.toThrow(AdminFormError);
  });
});
