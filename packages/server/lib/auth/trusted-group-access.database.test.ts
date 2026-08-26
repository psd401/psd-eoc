import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { groupMembers, groupSources } from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { decideAccess, MEMBERSHIP_FRESHNESS_MS } from './trusted-group-access';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const NOW = new Date('2026-08-19T12:00:00.000Z');
const ADMIN_GROUP = randomUUID();
const STAFF_GROUP = randomUUID();
const RETIRED_GROUP = randomUUID();

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
});
