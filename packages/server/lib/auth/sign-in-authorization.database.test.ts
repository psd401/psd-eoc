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
import { groupMembers, groupSources, userRoles, users } from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import { authorizeSignIn } from './sign-in-authorization';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const NOW = new Date('2026-08-19T12:00:00.000Z');
const ADMIN_GROUP = randomUUID();
const STAFF_GROUP = randomUUID();

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

async function rolesOf(userId: string): Promise<readonly string[]> {
  const rows = await database()
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .orderBy(asc(userRoles.role));
  return rows.map(({ role }) => role);
}

describeWithDatabase('sign-in authorization', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    disposable = await createDisposableDatabase('psd_eoc_signin', baseUrl);
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('postgres required');
    connection = opened;
    await migrateDatabase(opened);

    const fresh = new Date(NOW.getTime() - 60_000);
    for (const [id, role] of [
      [ADMIN_GROUP, 'admin'],
      [STAFF_GROUP, 'staff'],
    ] as const) {
      await opened.db.insert(groupSources).values({
        id,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: `Group ${role}`,
        active: true,
        grantedRole: role,
        membersCapturedAt: fresh,
        googleGroupId: `provider-${id}`,
        email: `group-${id}@example.invalid`,
        fixtureKey: null,
      });
    }
    await opened.db.insert(groupMembers).values([
      {
        groupSourceId: ADMIN_GROUP,
        email: 'newcomer@example.invalid',
        capturedAt: fresh,
      },
      {
        groupSourceId: STAFF_GROUP,
        email: 'demoted@example.invalid',
        capturedAt: fresh,
      },
      {
        groupSourceId: ADMIN_GROUP,
        email: 'demoted@example.invalid',
        capturedAt: fresh,
      },
      {
        groupSourceId: STAFF_GROUP,
        email: 'disabled@example.invalid',
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

  test('creates a first-time signer with the roles their groups grant', async () => {
    // No bootstrap admin, no approved subject, no synthetic fixture. The first
    // person to arrive is an administrator because their group says so.
    const result = await authorizeSignIn(database(), {
      googleSubject: 'subject-newcomer',
      email: 'Newcomer@example.invalid',
      displayName: 'New Comer',
      checkedAt: NOW,
    });
    expect(result).toMatchObject({ authorized: true, created: true });
    if (!result.authorized) throw new Error('expected authorization');
    expect(result.user.roles).toEqual(['admin']);
    expect(result.user.email).toBe('newcomer@example.invalid');
    // Nothing was written to the legacy role tables: authority comes from the
    // group, so there is no stored grant to go stale.
    expect(await rolesOf(result.user.id)).toEqual([]);
  });

  test('revoking a group membership revokes the role it granted', async () => {
    const first = await authorizeSignIn(database(), {
      googleSubject: 'subject-demoted',
      email: 'demoted@example.invalid',
      displayName: 'De Moted',
      checkedAt: NOW,
    });
    if (!first.authorized) throw new Error('expected authorization');
    expect(first.user.roles).toEqual(['admin', 'staff']);

    // Removed from the administrator group at the provider.
    await database()
      .delete(groupMembers)
      .where(eq(groupMembers.groupSourceId, ADMIN_GROUP));

    const second = await authorizeSignIn(database(), {
      googleSubject: 'subject-demoted',
      email: 'demoted@example.invalid',
      displayName: 'De Moted',
      checkedAt: NOW,
    });
    if (!second.authorized) throw new Error('expected authorization');
    // The stored role is reconciled, not merely ignored. Leaving it behind is
    // how an administrator who was removed from the group stays one.
    expect(second.user.roles).toEqual(['staff']);
    expect(await rolesOf(second.user.id)).toEqual([]);
    expect(second.created).toBe(false);
  });

  test('a person in no trusted group is refused and no account is created', async () => {
    const before = await database().select({ id: users.id }).from(users);
    const result = await authorizeSignIn(database(), {
      googleSubject: 'subject-stranger',
      email: 'stranger@example.invalid',
      displayName: 'Stran Ger',
      checkedAt: NOW,
    });
    expect(result).toMatchObject({
      authorized: false,
      refusal: 'NOT_IN_A_TRUSTED_GROUP',
    });
    expect(await database().select({ id: users.id }).from(users)).toHaveLength(
      before.length,
    );
  });

  test('a disabled account is refused even while its groups would grant access', async () => {
    const created = await authorizeSignIn(database(), {
      googleSubject: 'subject-disabled',
      email: 'disabled@example.invalid',
      displayName: 'Dis Abled',
      checkedAt: NOW,
    });
    if (!created.authorized) throw new Error('expected authorization');
    await database()
      .update(users)
      .set({ disabledAt: NOW })
      .where(eq(users.googleSubject, 'subject-disabled'));
    expect(
      await authorizeSignIn(database(), {
        googleSubject: 'subject-disabled',
        email: 'disabled@example.invalid',
        displayName: 'Dis Abled',
        checkedAt: NOW,
      }),
    ).toMatchObject({ authorized: false, refusal: 'ACCOUNT_DISABLED' });
  });
  test('a person Google confirms at sign-in is authorized without waiting for the sync', async () => {
    // Not on record at all: added to the staff group in Google a moment ago.
    // The live read writes them down, and the decision that follows reads it.
    const result = await authorizeSignIn(
      database(),
      {
        googleSubject: 'subject-arrival',
        email: 'arrival@example.invalid',
        displayName: 'Just Arrived',
        checkedAt: NOW,
      },
      {
        liveMembership: {
          reconcile: async (db, input) => {
            await db.insert(groupMembers).values({
              groupSourceId: STAFF_GROUP,
              email: input.email,
              capturedAt: input.checkedAt,
            });
            return 'reconciled';
          },
        },
      },
    );
    expect(result).toMatchObject({ authorized: true, created: true });
    if (!result.authorized) throw new Error('expected authorization');
    expect(result.user.roles).toEqual(['staff']);
  });

  test('when Google cannot be asked, someone not on record is still refused', async () => {
    const result = await authorizeSignIn(
      database(),
      {
        googleSubject: 'subject-stranger',
        email: 'stranger@example.invalid',
        displayName: 'Stranger',
        checkedAt: NOW,
      },
      { liveMembership: { reconcile: async () => 'unavailable' } },
    );
    expect(result).toMatchObject({
      authorized: false,
      refusal: 'NOT_IN_A_TRUSTED_GROUP',
    });
  });
});
