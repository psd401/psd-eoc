import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { createDisposableDatabase } from '../lib/testing/database';
import { migrateDatabase } from '../drizzle/migrate';
import { decideAccess } from '../lib/auth/trusted-group-access';
import {
  InitialAccessGroupConfigurationError,
  bootstrapAccessConfiguration,
  readInitialAccessGroupConfiguration,
} from './bootstrap-access';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from './client';
import { accessGroupMembers, groupSources } from './schema';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

const CONFIGURATION = Object.freeze({
  googleGroupId: 'groups/synthetic-initial-administrators',
  email: 'eoc-administrators@example.invalid',
  displayName: 'Administrators',
});

let connection: PostgresDatabaseConnection | undefined;
let disposable:
  | Awaited<ReturnType<typeof createDisposableDatabase>>
  | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

describe('initial access group configuration', () => {
  test('reads nothing when nothing is configured', () => {
    expect(readInitialAccessGroupConfiguration({})).toBeNull();
  });

  test('refuses half a configuration rather than admitting nobody', () => {
    expect(() =>
      readInitialAccessGroupConfiguration({
        PSD_EOC_INITIAL_ACCESS_GROUP_ID: 'groups/one',
      }),
    ).toThrow(InitialAccessGroupConfigurationError);
    expect(() =>
      readInitialAccessGroupConfiguration({
        PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: 'admins@example.invalid',
      }),
    ).toThrow(InitialAccessGroupConfigurationError);
    expect(() =>
      readInitialAccessGroupConfiguration({
        PSD_EOC_INITIAL_ACCESS_GROUP_NAME: 'Administrators',
      }),
    ).toThrow(InitialAccessGroupConfigurationError);
  });

  test('normalizes the address and defaults the display name', () => {
    expect(
      readInitialAccessGroupConfiguration({
        PSD_EOC_INITIAL_ACCESS_GROUP_ID: 'groups/one',
        PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: 'Admins@Example.Invalid',
      }),
    ).toEqual({
      googleGroupId: 'groups/one',
      email: 'admins@example.invalid',
      displayName: 'Administrators',
    });
  });

  test('refuses an address that is not one', () => {
    expect(() =>
      readInitialAccessGroupConfiguration({
        PSD_EOC_INITIAL_ACCESS_GROUP_ID: 'groups/one',
        PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: 'not-an-address',
      }),
    ).toThrow(InitialAccessGroupConfigurationError);
  });
});

describeWithDatabase(
  'bootstrapping a district that has never signed in',
  () => {
    beforeAll(async () => {
      disposable = await createDisposableDatabase('psd_eoc_bootstrap', baseUrl);
      const opened = createDatabaseClient({
        driver: 'postgres',
        url: disposable.url,
        maxConnections: 2,
      });
      if (opened.driver !== 'postgres') throw new Error('postgres required');
      connection = opened;
      await migrateDatabase(opened);
    });

    afterAll(async () => {
      await connection?.close();
      connection = undefined;
      await disposable?.drop();
      disposable = undefined;
    });

    test('a freshly migrated deployment admits nobody', async () => {
      expect(
        await decideAccess(database(), {
          email: 'somebody@example.invalid',
          checkedAt: new Date(),
        }),
      ).toEqual({ granted: false, refusal: 'NO_TRUSTED_GROUPS_CONFIGURED' });
    });

    test('creates the configured group, granting administrator', async () => {
      const outcome = await bootstrapAccessConfiguration(
        database(),
        CONFIGURATION,
      );
      expect(outcome.kind).toBe('created');

      const [group] = await database()
        .select()
        .from(groupSources)
        .where(eq(groupSources.purpose, 'access'));
      expect(group).toMatchObject({
        kind: 'google-group',
        purpose: 'access',
        active: true,
        grantedRole: 'admin',
        googleGroupId: CONFIGURATION.googleGroupId,
        email: CONFIGURATION.email,
      });
      // The group, not its membership: the scheduled sync reads the provider.
      // Until it has, the group grants nobody anything.
      expect(group?.membersCapturedAt ?? null).toBeNull();
      expect(
        await decideAccess(database(), {
          email: 'somebody@example.invalid',
          checkedAt: new Date(),
        }),
      ).toEqual({ granted: false, refusal: 'NOT_IN_A_TRUSTED_GROUP' });
    });

    test('the first sync makes its members administrators', async () => {
      const [group] = await database()
        .select({ id: groupSources.id })
        .from(groupSources)
        .where(eq(groupSources.purpose, 'access'));
      if (group === undefined)
        throw new Error('the bootstrap group is missing');
      const capturedAt = new Date();
      await database().insert(accessGroupMembers).values({
        groupSourceId: group.id,
        email: 'first.administrator@example.invalid',
        capturedAt,
      });
      await database()
        .update(groupSources)
        .set({ membersCapturedAt: capturedAt })
        .where(eq(groupSources.id, group.id));

      expect(
        await decideAccess(database(), {
          email: 'first.administrator@example.invalid',
          checkedAt: new Date(),
        }),
      ).toMatchObject({ granted: true, roles: ['admin'] });
    });

    test('never disturbs a district that already configured itself', async () => {
      const outcome = await bootstrapAccessConfiguration(database(), {
        googleGroupId: `groups/${randomUUID()}`,
        email: 'someone-elses-idea@example.invalid',
        displayName: 'Should not appear',
      });
      expect(outcome).toEqual({
        kind: 'already-configured',
        activeGroupCount: 1,
      });
      expect(
        await database()
          .select({ email: groupSources.email })
          .from(groupSources)
          .where(eq(groupSources.purpose, 'access')),
      ).toEqual([{ email: CONFIGURATION.email }]);
    });

    test('does nothing at all when no configuration is supplied', async () => {
      expect(await bootstrapAccessConfiguration(database(), null)).toEqual({
        kind: 'not-configured',
      });
    });
  },
);
