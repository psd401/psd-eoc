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
import {
  facilities,
  groupMembers,
  groupSources,
  userFacilityScopes,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { authorizeSignIn } from './sign-in-authorization';
import { decideAccess, MEMBERSHIP_FRESHNESS_MS } from './trusted-group-access';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const NOW = new Date('2026-09-29T18:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - MEMBERSHIP_FRESHNESS_MS - 60_000);

const NORTH = randomUUID();
const SOUTH = randomUUID();
const DISTRICT_GROUP = randomUUID();
const NORTH_GROUP = randomUUID();
const SOUTH_GROUP = randomUUID();
const WAITING_GROUP = randomUUID();
const MANUAL_NORTH = randomUUID();
const STALE_GROUP = randomUUID();

const liveMembership = { reconcile: async () => 'reconciled' as const };

let connection: PostgresDatabaseConnection | undefined;
let databaseName = '';

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

function buildingGroup(
  id: string,
  facilityId: string,
  googleGroupId: string | null,
  capturedAt: Date | null,
) {
  return {
    id,
    kind: 'google-group' as const,
    purpose: 'building' as const,
    facilityId,
    displayName: `School group ${id.slice(0, 8)}`,
    active: true,
    grantedRole: null,
    membersCapturedAt: capturedAt,
    googleGroupId,
    email: `school-${id}@example.invalid`,
    fixtureKey: null,
  };
}

async function signIn(email: string) {
  return authorizeSignIn(
    database(),
    {
      googleSubject: `subject-${email}`,
      email,
      displayName: email,
      checkedAt: NOW,
    },
    { liveMembership },
  );
}

async function storedScope(email: string) {
  const [user] = await database()
    .select({ id: users.id, kind: users.facilityScopeKind })
    .from(users)
    .where(eq(users.email, email));
  if (user === undefined) return null;
  const rows = await database()
    .select({ facilityId: userFacilityScopes.facilityId })
    .from(userFacilityScopes)
    .where(eq(userFacilityScopes.userId, user.id));
  return {
    kind: user.kind,
    facilityIds: rows.map(({ facilityId }) => facilityId).sort(),
  };
}

describeWithDatabase('a school staff group admits its members', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    databaseName = `psd_eoc_school_${randomUUID().replaceAll('-', '')}_test`;
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

    await opened.db.insert(facilities).values([
      { id: NORTH, code: 'NTH', name: 'North School' },
      { id: SOUTH, code: 'STH', name: 'South School' },
    ]);
    await opened.db.insert(groupSources).values([
      {
        id: DISTRICT_GROUP,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'District staff',
        active: true,
        grantedRole: 'staff',
        membersCapturedAt: FRESH,
        googleGroupId: `provider-${DISTRICT_GROUP}`,
        email: `district-${DISTRICT_GROUP}@example.invalid`,
        fixtureKey: null,
      },
      buildingGroup(NORTH_GROUP, NORTH, `provider-${NORTH_GROUP}`, FRESH),
      buildingGroup(SOUTH_GROUP, SOUTH, `provider-${SOUTH_GROUP}`, FRESH),
      // Registered by naming convention before Google holds the group.
      buildingGroup(WAITING_GROUP, SOUTH, null, null),
      buildingGroup(STALE_GROUP, SOUTH, `provider-${STALE_GROUP}`, STALE),
      {
        id: MANUAL_NORTH,
        kind: 'manual',
        purpose: 'building',
        facilityId: NORTH,
        displayName: 'North manual list',
        active: true,
        grantedRole: null,
        membersCapturedAt: FRESH,
        googleGroupId: null,
        email: null,
        fixtureKey: null,
      },
    ]);
    await opened.db.insert(groupMembers).values(
      [
        { groupSourceId: NORTH_GROUP, email: 'teacher@example.invalid' },
        { groupSourceId: NORTH_GROUP, email: 'both@example.invalid' },
        { groupSourceId: SOUTH_GROUP, email: 'both@example.invalid' },
        { groupSourceId: NORTH_GROUP, email: 'district@example.invalid' },
        { groupSourceId: DISTRICT_GROUP, email: 'district@example.invalid' },
        { groupSourceId: WAITING_GROUP, email: 'waiting@example.invalid' },
        { groupSourceId: MANUAL_NORTH, email: 'manual@example.invalid' },
        { groupSourceId: STALE_GROUP, email: 'stale@example.invalid' },
        { groupSourceId: NORTH_GROUP, email: 'mover@example.invalid' },
      ].map((row) => ({ ...row, capturedAt: STALE })),
    );
  });

  afterAll(async () => {
    await connection?.close();
    if (baseUrl === undefined || databaseName.length === 0) return;
    const admin = createDatabaseClient({
      driver: 'postgres',
      url: baseUrl,
      maxConnections: 1,
    });
    if (admin.driver !== 'postgres') return;
    await admin.db.execute(
      `drop database if exists "${databaseName}" with (force)` as never,
    );
    await admin.close();
  });

  test('grants staff at that school only', async () => {
    const decision = await decideAccess(database(), {
      email: 'teacher@example.invalid',
      checkedAt: NOW,
    });
    expect(decision).toMatchObject({
      granted: true,
      roles: ['staff'],
      groupSourceIds: [NORTH_GROUP],
      admittedAccountId: null,
      schoolFacilityIds: [NORTH],
    });
  });

  test('a first sign-in is limited to the school the group belongs to', async () => {
    const result = await signIn('teacher@example.invalid');
    expect(result).toMatchObject({
      authorized: true,
      created: true,
      groupSourceIds: [NORTH_GROUP],
    });
    if (!result.authorized) throw new Error('expected a sign-in');
    expect(result.user.roles).toEqual(['staff']);
    expect(result.user.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: [NORTH],
    });
    expect(await storedScope('teacher@example.invalid')).toEqual({
      kind: 'facilities',
      facilityIds: [NORTH],
    });
  });

  test('someone in two schools groups acts at both', async () => {
    const result = await signIn('both@example.invalid');
    if (!result.authorized) throw new Error('expected a sign-in');
    expect(result.user.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: [NORTH, SOUTH].sort(),
    });
  });

  test('the limit follows the group when someone moves schools', async () => {
    const first = await signIn('mover@example.invalid');
    if (!first.authorized) throw new Error('expected a sign-in');
    expect(first.user.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: [NORTH],
    });

    await database()
      .delete(groupMembers)
      .where(eq(groupMembers.email, 'mover@example.invalid'));
    await database().insert(groupMembers).values({
      groupSourceId: SOUTH_GROUP,
      email: 'mover@example.invalid',
      capturedAt: FRESH,
    });

    const second = await signIn('mover@example.invalid');
    if (!second.authorized) throw new Error('expected a sign-in');
    expect(second.created).toBe(false);
    expect(second.user.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: [SOUTH],
    });
    expect(await storedScope('mover@example.invalid')).toEqual({
      kind: 'facilities',
      facilityIds: [SOUTH],
    });
  });

  test('a sign-in group keeps the district and its stored limit untouched', async () => {
    const decision = await decideAccess(database(), {
      email: 'district@example.invalid',
      checkedAt: NOW,
    });
    expect(decision).toMatchObject({
      granted: true,
      roles: ['staff'],
      schoolFacilityIds: null,
    });
    const result = await signIn('district@example.invalid');
    if (!result.authorized) throw new Error('expected a sign-in');
    expect(result.user.facilityScope).toEqual({ kind: 'district' });
    expect(await storedScope('district@example.invalid')).toEqual({
      kind: 'district',
      facilityIds: [],
    });
  });

  test('a waiting group, a manual list, and a stale group admit nobody', async () => {
    expect(
      await decideAccess(database(), {
        email: 'waiting@example.invalid',
        checkedAt: NOW,
      }),
    ).toEqual({ granted: false, refusal: 'NOT_IN_A_TRUSTED_GROUP' });
    expect(
      await decideAccess(database(), {
        email: 'manual@example.invalid',
        checkedAt: NOW,
      }),
    ).toEqual({ granted: false, refusal: 'NOT_IN_A_TRUSTED_GROUP' });
    expect(
      await decideAccess(database(), {
        email: 'stale@example.invalid',
        checkedAt: NOW,
      }),
    ).toEqual({ granted: false, refusal: 'MEMBERSHIP_STALE' });
  });
});
