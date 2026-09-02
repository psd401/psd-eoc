import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { asc, eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { groupMembers, groupSources } from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import type { GoogleMembershipChecker } from './google-access-membership';
import { createLiveMembershipReconciler } from './live-membership';
import { decideAccess, MEMBERSHIP_FRESHNESS_MS } from './trusted-group-access';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const NOW = new Date('2026-09-02T12:00:00.000Z');
const STAFF_GROUP = randomUUID();
const ADMIN_GROUP = randomUUID();
const DISTRICT_LIST = randomUUID();

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

interface Asked {
  readonly email: string;
  readonly googleGroupIds: readonly string[];
}

/** Stands in for Google, answering per Google Group ID. */
function googleAnswering(
  answers: Readonly<Record<string, boolean>>,
  asked: Asked[],
): () => GoogleMembershipChecker {
  return () => ({
    check: async (email, groups) => {
      asked.push({
        email,
        googleGroupIds: groups.map(({ googleGroupId }) => googleGroupId).sort(),
      });
      return new Map(
        groups.map((group) => [
          group.groupSourceId,
          answers[group.googleGroupId] ?? false,
        ]),
      );
    },
  });
}

async function rowsFor(
  email: string,
): Promise<readonly { groupSourceId: string; capturedAt: Date }[]> {
  return database()
    .select({
      groupSourceId: groupMembers.groupSourceId,
      capturedAt: groupMembers.capturedAt,
    })
    .from(groupMembers)
    .where(eq(groupMembers.email, email))
    .orderBy(asc(groupMembers.groupSourceId));
}

describeWithDatabase('live membership at sign-in', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    disposable = await createDisposableDatabase('psd_eoc_live', baseUrl);
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('postgres required');
    connection = opened;
    await migrateDatabase(opened);
    const fresh = new Date(NOW.getTime() - 60_000);
    const stale = new Date(NOW.getTime() - MEMBERSHIP_FRESHNESS_MS - 60_000);
    await opened.db.insert(groupSources).values([
      {
        id: STAFF_GROUP,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'District staff',
        active: true,
        grantedRole: 'staff',
        // The scheduled sync last read this group a day ago.
        membersCapturedAt: stale,
        googleGroupId: 'provider-staff',
        email: 'staff@example.invalid',
        fixtureKey: null,
      },
      {
        id: ADMIN_GROUP,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Administrators',
        active: true,
        grantedRole: 'admin',
        membersCapturedAt: fresh,
        googleGroupId: 'provider-admin',
        email: 'admins@example.invalid',
        fixtureKey: null,
      },
      {
        // A roster list, not a sign-in group: never part of the question.
        id: DISTRICT_LIST,
        kind: 'manual',
        purpose: 'others',
        facilityId: null,
        displayName: 'District responders',
        active: true,
        grantedRole: null,
        membersCapturedAt: fresh,
        googleGroupId: null,
        email: null,
        fixtureKey: null,
      },
    ]);
    await opened.db.insert(groupMembers).values([
      {
        groupSourceId: ADMIN_GROUP,
        email: 'leaver@example.invalid',
        capturedAt: fresh,
      },
      {
        groupSourceId: ADMIN_GROUP,
        email: 'holder@example.invalid',
        capturedAt: fresh,
      },
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

  test('a person Google confirms is written down and signs in at once', async () => {
    // Added to the staff group a moment ago; the scheduled sync has not run
    // and its last read of that group is a day old. Google's answer now is
    // the evidence, and it is fresh.
    const asked: Asked[] = [];
    const outcome = await createLiveMembershipReconciler(
      googleAnswering({ 'provider-staff': true }, asked),
    ).reconcile(database(), {
      email: 'Joiner@Example.invalid',
      checkedAt: NOW,
    });
    expect(outcome).toBe('reconciled');
    expect(asked).toEqual([
      {
        email: 'joiner@example.invalid',
        googleGroupIds: ['provider-admin', 'provider-staff'],
      },
    ]);
    expect(await rowsFor('joiner@example.invalid')).toEqual([
      { groupSourceId: STAFF_GROUP, capturedAt: NOW },
    ]);
    expect(
      await decideAccess(database(), {
        email: 'joiner@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: true, roles: ['staff'] });
  });

  test('a confirmed membership is refreshed, not duplicated', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    await createLiveMembershipReconciler(
      googleAnswering({ 'provider-staff': true }, []),
    ).reconcile(database(), {
      email: 'joiner@example.invalid',
      checkedAt: later,
    });
    expect(await rowsFor('joiner@example.invalid')).toEqual([
      { groupSourceId: STAFF_GROUP, capturedAt: later },
    ]);
  });

  test('a person Google denies is removed at once', async () => {
    // Removed from the administrator group in Google; the stored row from
    // the last sync would have kept granting until the next one.
    const outcome = await createLiveMembershipReconciler(
      googleAnswering({}, []),
    ).reconcile(database(), {
      email: 'leaver@example.invalid',
      checkedAt: NOW,
    });
    expect(outcome).toBe('reconciled');
    expect(await rowsFor('leaver@example.invalid')).toEqual([]);
    expect(
      await decideAccess(database(), {
        email: 'leaver@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: false, refusal: 'NOT_IN_A_TRUSTED_GROUP' });
  });

  test('when Google cannot be asked the stored membership stands', async () => {
    const outcome = await createLiveMembershipReconciler(() => ({
      check: async () => {
        throw new Error('Google is unreachable.');
      },
    })).reconcile(database(), {
      email: 'holder@example.invalid',
      checkedAt: NOW,
    });
    expect(outcome).toBe('unavailable');
    expect(await rowsFor('holder@example.invalid')).toHaveLength(1);
    expect(
      await decideAccess(database(), {
        email: 'holder@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: true, roles: ['admin'] });
  });

  test('a credential that cannot be built is the same as Google being away', async () => {
    const outcome = await createLiveMembershipReconciler(() => {
      throw new Error('GOOGLE_ROSTER_CONFIG must be configured.');
    }).reconcile(database(), {
      email: 'holder@example.invalid',
      checkedAt: NOW,
    });
    expect(outcome).toBe('unavailable');
    expect(await rowsFor('holder@example.invalid')).toHaveLength(1);
  });

  test('with no Google sign-in group active, nothing is asked', async () => {
    await database()
      .update(groupSources)
      .set({ active: false })
      .where(eq(groupSources.purpose, 'access'));
    const asked: Asked[] = [];
    const outcome = await createLiveMembershipReconciler(
      googleAnswering({ 'provider-staff': true }, asked),
    ).reconcile(database(), {
      email: 'joiner@example.invalid',
      checkedAt: NOW,
    });
    expect(outcome).toBe('no-groups');
    expect(asked).toEqual([]);
  });
});
