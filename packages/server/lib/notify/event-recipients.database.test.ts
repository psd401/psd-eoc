import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  facilities,
  groupMembers,
  groupSources,
  neighborhoodFacilities,
  neighborhoodVersions,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import { resolveEventRecipients } from './event-recipients';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const NOW = new Date('2026-08-21T12:00:00.000Z');
const READ_RECENTLY = new Date(NOW.getTime() - 60_000);
const READ_LONG_AGO = new Date(NOW.getTime() - 30 * 60 * 60 * 1_000);

// Two schools share a neighborhood; a third is in none. A fourth has staff but
// its group is switched off, and a fifth has no group at all.
const HIGH_SCHOOL = randomUUID();
const MIDDLE_SCHOOL = randomUUID();
const LONE_SCHOOL = randomUUID();
const RETIRED_SCHOOL = randomUUID();
const UNCONFIGURED_SCHOOL = randomUUID();

const HIGH_GROUP = randomUUID();
const HIGH_SYNTHETIC_GROUP = randomUUID();
const MIDDLE_GROUP = randomUUID();
const LONE_GROUP = randomUUID();
const RETIRED_GROUP = randomUUID();
const ACCESS_GROUP = randomUUID();

const NEIGHBOURHOOD = randomUUID();

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

function buildingGroup(
  id: string,
  facilityId: string,
  active: boolean,
  capturedAt: Date | null,
) {
  return {
    id,
    kind: 'google-group' as const,
    purpose: 'building' as const,
    facilityId,
    displayName: `Staff ${id.slice(0, 8)}`,
    active,
    grantedRole: null,
    membersCapturedAt: capturedAt,
    googleGroupId: `provider-${id}`,
    email: `staff-${id}@example.invalid`,
    fixtureKey: null,
  };
}

describeWithDatabase('event recipient resolution from the domain', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    disposable = await createDisposableDatabase('psd_eoc_recipients', baseUrl);
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('postgres required');
    connection = opened;
    await migrateDatabase(opened);

    await opened.db.insert(facilities).values([
      { id: HIGH_SCHOOL, code: 'HIGH', name: 'High School' },
      { id: MIDDLE_SCHOOL, code: 'MIDDLE', name: 'Middle School' },
      { id: LONE_SCHOOL, code: 'LONE', name: 'Lone School' },
      { id: RETIRED_SCHOOL, code: 'RETIRED', name: 'Retired School' },
      { id: UNCONFIGURED_SCHOOL, code: 'NOGROUP', name: 'Unconfigured School' },
    ]);

    // Version 1 grouped the lone school in; version 2 is current and does not.
    //
    // Each version and its facilities go in together:
    // `psd_eoc_guard_admin_version_child_insert` requires the parent version
    // row to have been created in the same transaction, so a published version
    // can never gain a school afterwards.
    for (const [version, facilityIds] of [
      [1, [HIGH_SCHOOL, LONE_SCHOOL]],
      [2, [HIGH_SCHOOL, MIDDLE_SCHOOL]],
    ] as const) {
      await opened.db.transaction(async (transaction) => {
        await transaction
          .insert(neighborhoodVersions)
          .values({ id: NEIGHBOURHOOD, version, name: 'North' });
        await transaction.insert(neighborhoodFacilities).values(
          facilityIds.map((facilityId) => ({
            neighborhoodId: NEIGHBOURHOOD,
            neighborhoodVersion: version,
            facilityId,
          })),
        );
      });
    }

    await opened.db.insert(groupSources).values([
      buildingGroup(HIGH_GROUP, HIGH_SCHOOL, true, READ_RECENTLY),
      // A synthetic population for the same school. This is what the health
      // check and integrations test mode address, and it must be invisible to
      // a staff activation.
      {
        id: HIGH_SYNTHETIC_GROUP,
        kind: 'synthetic' as const,
        purpose: 'building' as const,
        facilityId: HIGH_SCHOOL,
        displayName: 'High School synthetic',
        active: true,
        grantedRole: null,
        membersCapturedAt: READ_RECENTLY,
        googleGroupId: null,
        email: null,
        fixtureKey: 'high-school-synthetic',
      },
      buildingGroup(MIDDLE_GROUP, MIDDLE_SCHOOL, true, READ_LONG_AGO),
      buildingGroup(LONE_GROUP, LONE_SCHOOL, true, null),
      buildingGroup(RETIRED_GROUP, RETIRED_SCHOOL, false, READ_RECENTLY),
      {
        id: ACCESS_GROUP,
        kind: 'google-group' as const,
        purpose: 'access' as const,
        facilityId: null,
        displayName: 'Administrators',
        active: true,
        grantedRole: 'admin' as const,
        membersCapturedAt: READ_RECENTLY,
        googleGroupId: `provider-${ACCESS_GROUP}`,
        email: 'admins@example.invalid',
        fixtureKey: null,
      },
    ]);

    await opened.db.insert(groupMembers).values([
      // Stored with capitals, deliberately: the provider returns whatever the
      // directory holds, and two schools can disagree about the same person's
      // capitalisation. Resolution has to fold them together.
      { groupSourceId: HIGH_GROUP, email: 'Principal@Example.invalid' },
      { groupSourceId: HIGH_GROUP, email: 'teacher@example.invalid' },
      // Also at the middle school, in a different case, so a neighborhood
      // event must fold rather than double them.
      { groupSourceId: MIDDLE_GROUP, email: 'TEACHER@example.invalid' },
      { groupSourceId: MIDDLE_GROUP, email: 'counselor@example.invalid' },
      { groupSourceId: LONE_GROUP, email: 'lonestaff@example.invalid' },
      { groupSourceId: RETIRED_GROUP, email: 'formerstaff@example.invalid' },
      { groupSourceId: HIGH_SYNTHETIC_GROUP, email: 'canary@example.invalid' },
      // An administrator who is in no building group at all.
      { groupSourceId: ACCESS_GROUP, email: 'superintendent@example.invalid' },
    ]);
  });

  afterAll(async () => {
    const opened = connection;
    const ownedDatabase = disposable;
    connection = undefined;
    disposable = undefined;
    await closeAndDropDisposableDatabase(
      opened === undefined ? undefined : () => opened.close(),
      ownedDatabase,
    );
  });

  test('a building event reaches only that school', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: HIGH_SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(result.emails).toEqual([
      'principal@example.invalid',
      'teacher@example.invalid',
    ]);
    expect(result.facilities.map(({ facilityId }) => facilityId)).toEqual([
      HIGH_SCHOOL,
    ]);
  });

  test('a neighborhood event reaches the current version, not a superseded one', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: HIGH_SCHOOL,
      reach: 'neighborhood',
      population: 'staff',
    });

    // Version 2 is current and holds high + middle. The lone school was in
    // version 1 and must not be reached — somebody decided it no longer
    // belongs, and notifying it would undo that decision.
    expect(
      result.facilities.map(({ facilityId }) => facilityId).sort(),
    ).toEqual([HIGH_SCHOOL, MIDDLE_SCHOOL].sort());
    expect(result.emails).not.toContain('lonestaff@example.invalid');
  });

  test('a person at two reached schools is notified once, whatever the case', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: HIGH_SCHOOL,
      reach: 'neighborhood',
      population: 'staff',
    });

    expect(result.emails).toEqual([
      'counselor@example.invalid',
      'principal@example.invalid',
      'teacher@example.invalid',
    ]);
    expect(
      result.emails.filter((email) => email === 'teacher@example.invalid'),
    ).toHaveLength(1);
  });

  test('never reaches an access group, even though membership shares a table', async () => {
    // The safety property that lets one table serve both purposes: purpose is
    // applied to the sources before any member row is read.
    for (const reach of ['building', 'neighborhood'] as const) {
      const result = await resolveEventRecipients(database(), {
        facilityId: HIGH_SCHOOL,
        reach,
        population: 'staff',
      });
      expect(result.emails).not.toContain('superintendent@example.invalid');
      expect(
        result.facilities.map(({ groupSourceId }) => groupSourceId),
      ).not.toContain(ACCESS_GROUP);
    }
  });

  test('an inactive staff group reaches nobody and is reported unconfigured', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: RETIRED_SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(result.emails).toEqual([]);
    expect(result.facilities).toEqual([]);
    expect(result.unconfiguredFacilityIds).toEqual([RETIRED_SCHOOL]);
  });

  test('a school with no staff group at all is reported, not silently empty', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: UNCONFIGURED_SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(result.emails).toEqual([]);
    expect(result.unconfiguredFacilityIds).toEqual([UNCONFIGURED_SCHOOL]);
    expect(result.oldestCapturedAt).toBeNull();
  });

  test('reports the oldest read so the preview can show it', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: HIGH_SCHOOL,
      reach: 'neighborhood',
      population: 'staff',
    });

    // High was read a minute ago, middle 30 hours ago. The person confirming
    // is entitled to see the worse of the two, not the better.
    expect(result.oldestCapturedAt?.toISOString()).toBe(
      READ_LONG_AGO.toISOString(),
    );
  });

  test('stale membership still resolves recipients rather than refusing', async () => {
    // Deliberately unlike decideAccess. Notifying from a roster read 30 hours
    // ago beats notifying nobody during an incident; the staleness is
    // surfaced, not enforced.
    const result = await resolveEventRecipients(database(), {
      facilityId: MIDDLE_SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(result.emails).toEqual([
      'counselor@example.invalid',
      'teacher@example.invalid',
    ]);
    expect(result.oldestCapturedAt?.toISOString()).toBe(
      READ_LONG_AGO.toISOString(),
    );
  });

  test('a never-read group withholds an age rather than implying freshness', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: LONE_SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    // Members exist because a fixture wrote them, but the group has never been
    // read. Reporting any age here would claim a provenance there is none of.
    expect(result.unreadFacilityIds).toEqual([LONE_SCHOOL]);
    expect(result.oldestCapturedAt).toBeNull();
  });

  test('an event at a school in no neighborhood still reaches that school', async () => {
    const result = await resolveEventRecipients(database(), {
      facilityId: LONE_SCHOOL,
      reach: 'neighborhood',
      population: 'staff',
    });

    expect(result.facilities.map(({ facilityId }) => facilityId)).toEqual([
      LONE_SCHOOL,
    ]);
    expect(result.emails).toEqual(['lonestaff@example.invalid']);
  });

  test('a staff activation cannot see a synthetic member', async () => {
    // The binding `EventTargetingSchema` makes in the contract, enforced by the
    // query rather than downstream: a staff event never reads a synthetic
    // source, so a synthetic address cannot appear in a real consequence
    // preview even by mistake.
    const result = await resolveEventRecipients(database(), {
      facilityId: HIGH_SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(result.emails).not.toContain('canary@example.invalid');
    expect(result.facilities.map(({ groupSourceId }) => groupSourceId)).toEqual(
      [HIGH_GROUP],
    );
  });

  test('a synthetic activation cannot see a real staff member', async () => {
    // The half that actually protects people: the health check exercises this
    // path continuously, and it must not be able to reach a real address.
    const result = await resolveEventRecipients(database(), {
      facilityId: HIGH_SCHOOL,
      reach: 'building',
      population: 'synthetic',
    });

    expect(result.emails).toEqual(['canary@example.invalid']);
    expect(result.emails).not.toContain('principal@example.invalid');
    expect(result.emails).not.toContain('teacher@example.invalid');
    expect(result.facilities.map(({ groupSourceId }) => groupSourceId)).toEqual(
      [HIGH_SYNTHETIC_GROUP],
    );
  });

  test('a school with no synthetic group resolves to nobody, not to its staff', async () => {
    // Failing open here would point the health check at real staff.
    const result = await resolveEventRecipients(database(), {
      facilityId: MIDDLE_SCHOOL,
      reach: 'building',
      population: 'synthetic',
    });

    expect(result.emails).toEqual([]);
    expect(result.unconfiguredFacilityIds).toEqual([MIDDLE_SCHOOL]);
  });
});
