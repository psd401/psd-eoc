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
} from '../../../db/client';
import { facilities, groupSources } from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import {
  AccessMembershipEvaluationError,
  type GoogleGroupResolver,
} from '../../../lib/auth/google-access-membership';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../../../lib/testing/database';
import { AdminFormError } from './admin-request';
import { checkWaitingGroups } from './waiting-groups-check';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

// Only the roles are read; the database and resolver are injected.
const ADMIN = { roles: ['admin'] } as unknown as AuthenticatedSession;
const STAFF = { roles: ['staff'] } as unknown as AuthenticatedSession;
const HELD = 'aes-eoc@example.invalid';
const NOT_HELD = 'des-eoc@example.invalid';

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) {
    throw new Error('The waiting-groups check test connection is not open.');
  }
  return connection.db;
}

/** Google that holds exactly one of the addresses; records what it was asked. */
function google(): (() => GoogleGroupResolver) & { readonly asked: string[] } {
  const asked: string[] = [];
  const factory = (): GoogleGroupResolver => ({
    resolve: async () => {
      throw new Error('The check must never use the strict resolver.');
    },
    resolveIfHeld: async (email) => {
      asked.push(email);
      return email === HELD
        ? { name: 'groups/held', googleGroupId: 'held' }
        : null;
    },
  });
  return Object.assign(factory, { asked });
}

describeWithDatabase('waiting roster groups check', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for this test.');
    }
    const owned = await createDisposableDatabase(
      'psd_eoc_waiting_check',
      baseTestDatabaseUrl,
    );
    ownedDatabase = owned;
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: owned.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('This test requires PostgreSQL.');
    }
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);
    const [first, second] = await opened.db
      .select({ id: facilities.id })
      .from(facilities)
      .limit(2);
    if (first === undefined || second === undefined) {
      throw new Error('Two seeded facilities are required.');
    }
    await opened.db.insert(groupSources).values([
      {
        id: randomUUID(),
        kind: 'google-group',
        purpose: 'building',
        facilityId: first.id,
        displayName: 'Alderwood staff (waiting)',
        grantedRole: null,
        active: true,
        googleGroupId: null,
        email: HELD.toUpperCase(),
        fixtureKey: null,
      },
      {
        id: randomUUID(),
        kind: 'google-group',
        purpose: 'building',
        facilityId: second.id,
        displayName: 'Discovery staff (waiting)',
        grantedRole: null,
        active: true,
        googleGroupId: null,
        email: NOT_HELD,
        fixtureKey: null,
      },
      {
        id: randomUUID(),
        kind: 'google-group',
        purpose: 'others',
        facilityId: null,
        displayName: 'District responders (connected)',
        grantedRole: null,
        active: true,
        googleGroupId: 'district-connected',
        email: 'responders@example.invalid',
        fixtureKey: null,
      },
    ]);
  });

  afterAll(async () => {
    if (ownedDatabase !== undefined) {
      const opened = connection;
      await closeAndDropDisposableDatabase(
        () => opened?.close() ?? Promise.resolve(),
        ownedDatabase,
      );
    }
  });

  test('asks Google only about waiting sources and reports which it holds now', async () => {
    const resolver = google();
    await expect(
      checkWaitingGroups({
        authenticated: ADMIN,
        database: database(),
        resolver,
      }),
    ).resolves.toEqual({ held: [HELD], stillWaiting: [NOT_HELD] });
    // Addresses are normalised, and a connected source is never asked about.
    expect(resolver.asked).toEqual([HELD, NOT_HELD]);
  });

  test('changes nothing: the waiting sources still carry no ID afterwards', async () => {
    await checkWaitingGroups({
      authenticated: ADMIN,
      database: database(),
      resolver: google(),
    });
    const rows = await database()
      .select({
        email: groupSources.email,
        googleGroupId: groupSources.googleGroupId,
      })
      .from(groupSources);
    expect(
      rows.filter(
        ({ email }) => email === HELD.toUpperCase() || email === NOT_HELD,
      ),
    ).toEqual([
      { email: HELD.toUpperCase(), googleGroupId: null },
      { email: NOT_HELD, googleGroupId: null },
    ]);
  });

  test('refuses a non-administrator and reports a refused lookup by code', async () => {
    await expect(
      checkWaitingGroups({
        authenticated: STAFF,
        database: database(),
        resolver: google(),
      }),
    ).rejects.toThrow('Access is denied.');
    await expect(
      checkWaitingGroups({
        authenticated: ADMIN,
        database: database(),
        resolver: () => ({
          resolve: async () => {
            throw new Error('unused');
          },
          resolveIfHeld: async () => {
            throw new AccessMembershipEvaluationError(
              'GOOGLE_REQUEST_REJECTED',
              'provider detail that must not reach the form',
            );
          },
        }),
      }),
    ).rejects.toBeInstanceOf(AdminFormError);
  });
});
