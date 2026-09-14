import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  admittedAccounts,
  groupMembers,
  groupSources,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { decideAccess, MEMBERSHIP_FRESHNESS_MS } from './trusted-group-access';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const NOW = new Date('2026-08-19T12:00:00.000Z');
const ADMIN_GROUP = randomUUID();
const STAFF_GROUP = randomUUID();
const RETIRED_GROUP = randomUUID();
const ADMITTER = randomUUID();
const ADMISSION = randomUUID();
const REVOKED_ADMISSION = randomUUID();

let connection: PostgresDatabaseConnection | undefined;
let databaseName = '';

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

function group(
  id: string,
  role: 'staff' | 'admin',
  active: boolean,
  capturedAt: Date | null,
) {
  return {
    id,
    kind: 'google-group' as const,
    purpose: 'access' as const,
    facilityId: null,
    displayName: `Group ${id.slice(0, 8)}`,
    active,
    grantedRole: role,
    membersCapturedAt: capturedAt,
    googleGroupId: `provider-${id}`,
    email: `group-${id}@example.invalid`,
    fixtureKey: null,
  };
}

describeWithDatabase('trusted group access', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    databaseName = `psd_eoc_trusted_${randomUUID().replaceAll('-', '')}_test`;
    const admin = createDatabaseClient({
      driver: 'postgres',
      url: baseUrl,
      maxConnections: 1,
    });
    if (admin.driver !== 'postgres') throw new Error('postgres required');
    await admin.db.execute(`create database "${databaseName}"` as never);
    await admin.close();

    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: url.toString(),
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('postgres required');
    connection = opened;
    await migrateDatabase(opened);

    const fresh = new Date(NOW.getTime() - 60_000);
    const stale = new Date(NOW.getTime() - MEMBERSHIP_FRESHNESS_MS - 60_000);
    await opened.db
      .insert(groupSources)
      .values([
        group(ADMIN_GROUP, 'admin', true, fresh),
        group(STAFF_GROUP, 'staff', true, fresh),
        group(RETIRED_GROUP, 'admin', false, fresh),
      ]);
    await opened.db.insert(groupMembers).values([
      {
        groupSourceId: ADMIN_GROUP,
        email: 'boss@example.invalid',
        capturedAt: fresh,
      },
      {
        groupSourceId: STAFF_GROUP,
        email: 'boss@example.invalid',
        capturedAt: fresh,
      },
      {
        groupSourceId: STAFF_GROUP,
        email: 'teacher@example.invalid',
        capturedAt: fresh,
      },
      {
        groupSourceId: RETIRED_GROUP,
        email: 'former@example.invalid',
        capturedAt: fresh,
      },
    ]);
    void stale;

    // Admission: an administrator wrote these addresses down; no group.
    await opened.db.insert(users).values({
      id: ADMITTER,
      googleSubject: 'admitter-subject',
      email: 'admitter@example.invalid',
      displayName: 'Admitting administrator',
      facilityScopeKind: 'district',
    });
    await opened.db.insert(admittedAccounts).values([
      {
        id: ADMISSION,
        email: 'reviewer@example.invalid',
        note: 'App store review',
        admittedAt: fresh,
        admittedByUserId: ADMITTER,
      },
      {
        id: REVOKED_ADMISSION,
        email: 'former.reviewer@example.invalid',
        note: '',
        admittedAt: stale,
        admittedByUserId: ADMITTER,
        revokedAt: fresh,
        revokedByUserId: ADMITTER,
      },
      // Admitted and also in the admin group: both grants apply.
      {
        id: randomUUID(),
        email: 'boss@example.invalid',
        note: '',
        admittedAt: fresh,
        admittedByUserId: ADMITTER,
      },
    ]);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('membership in one trusted group is enough, and roles accumulate', async () => {
    // The case that was refused before: a person in one configured group but
    // not in every configured group.
    expect(
      await decideAccess(database(), {
        email: 'teacher@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: true, roles: ['staff'] });

    // Two groups, two roles, one person.
    expect(
      await decideAccess(database(), {
        email: 'boss@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: true, roles: ['admin', 'staff'] });
  });

  test('a directly admitted address signs in as staff with no group at all', async () => {
    const decision = await decideAccess(database(), {
      email: 'Reviewer@example.invalid',
      checkedAt: NOW,
    });
    expect(decision).toEqual({
      granted: true,
      roles: ['staff'],
      groupSourceIds: [],
      admittedAccountId: ADMISSION,
      // Read from this database now, so the evidence is as fresh as the ask.
      capturedAt: NOW,
    });
  });

  test('admission adds staff to what the groups grant, never administrator', async () => {
    const decision = await decideAccess(database(), {
      email: 'boss@example.invalid',
      checkedAt: NOW,
    });
    expect(decision).toMatchObject({
      granted: true,
      roles: ['admin', 'staff'],
      groupSourceIds: [ADMIN_GROUP, STAFF_GROUP].sort(),
    });
    expect(decision.granted && decision.admittedAccountId).not.toBeNull();
    // A person in only the admin group is an administrator and not staff;
    // admission is the only thing that adds staff here.
    const revokedOnly = await decideAccess(database(), {
      email: 'former.reviewer@example.invalid',
      checkedAt: NOW,
    });
    expect(revokedOnly).toEqual({
      granted: false,
      refusal: 'NOT_IN_A_TRUSTED_GROUP',
    });
  });

  test('an admission is never stale, even when every group read is', async () => {
    const longAfter = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000);
    expect(
      await decideAccess(database(), {
        email: 'reviewer@example.invalid',
        checkedAt: longAfter,
      }),
    ).toMatchObject({ granted: true, roles: ['staff'] });
    expect(
      await decideAccess(database(), {
        email: 'teacher@example.invalid',
        checkedAt: longAfter,
      }),
    ).toMatchObject({ granted: false, refusal: 'MEMBERSHIP_STALE' });
  });

  test('a retired group stops granting access immediately', async () => {
    expect(
      await decideAccess(database(), {
        email: 'former@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: false, refusal: 'NOT_IN_A_TRUSTED_GROUP' });
  });

  test('an unknown person is refused', async () => {
    expect(
      await decideAccess(database(), {
        email: 'nobody@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: false, refusal: 'NOT_IN_A_TRUSTED_GROUP' });
  });

  test('membership that has gone stale stops authorizing', async () => {
    // Well past the freshness bound: the sync has stopped and the last known
    // answer is no longer trusted.
    const late = new Date(NOW.getTime() + MEMBERSHIP_FRESHNESS_MS + 60_000);
    expect(
      await decideAccess(database(), {
        email: 'teacher@example.invalid',
        checkedAt: late,
      }),
    ).toMatchObject({ granted: false, refusal: 'MEMBERSHIP_STALE' });
  });

  test('a stale group a person does not belong to never denies them', async () => {
    // Freshness is asked only of the groups that actually grant this person
    // access. Coupling every group together is the mistake the old baseline
    // made, in a different costume.
    await database()
      .update(groupSources)
      .set({
        membersCapturedAt: new Date(
          NOW.getTime() - MEMBERSHIP_FRESHNESS_MS - 60_000,
        ),
      })
      .where(eq(groupSources.id, ADMIN_GROUP));
    expect(
      await decideAccess(database(), {
        email: 'teacher@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: true, roles: ['staff'] });
  });
  test("a membership confirmed live is fresh while the group's bulk read is stale", async () => {
    // The scheduled sync last read this group a day ago, but this person was
    // confirmed by Google at their sign-in a minute ago. The fresher of the
    // two reads is the evidence for them.
    const staleGroupRead = new Date(
      NOW.getTime() - MEMBERSHIP_FRESHNESS_MS - 60_000,
    );
    const teacherInStaff = and(
      eq(groupMembers.groupSourceId, STAFF_GROUP),
      eq(groupMembers.email, 'teacher@example.invalid'),
    );
    await database()
      .update(groupSources)
      .set({ membersCapturedAt: staleGroupRead })
      .where(eq(groupSources.id, STAFF_GROUP));
    await database()
      .update(groupMembers)
      .set({ capturedAt: new Date(NOW.getTime() - 60_000) })
      .where(teacherInStaff);
    expect(
      await decideAccess(database(), {
        email: 'teacher@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: true, roles: ['staff'] });

    // A row as old as the group's read is as stale as the group.
    await database()
      .update(groupMembers)
      .set({ capturedAt: staleGroupRead })
      .where(teacherInStaff);
    expect(
      await decideAccess(database(), {
        email: 'teacher@example.invalid',
        checkedAt: NOW,
      }),
    ).toMatchObject({ granted: false, refusal: 'MEMBERSHIP_STALE' });
  });
});
