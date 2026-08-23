import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { createDisposableDatabase } from '../lib/testing/database';
import { migrateDatabase } from '../drizzle/migrate';
import { decideAccess } from '../lib/auth/trusted-group-access';
import {
  InitialAccessGroupConfigurationError,
  bootstrapAccessConfiguration,
  describeBootstrapOutcome,
  readInitialAccessGroupConfiguration,
} from './bootstrap-access';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from './client';
import { groupMembers, groupSources } from './schema';

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
      googleGroupId: 'one',
      email: 'admins@example.invalid',
      displayName: 'Administrators',
    });
  });

  test('strips the Cloud Identity "groups/" prefix, which nothing downstream stores', () => {
    // The membership reader slices the prefix off before anything reaches the
    // database, and the evaluated-group schema refuses a slash outright. A
    // stored "groups/<id>" can therefore never equal a resolved id, and the
    // sync fails closed forever while looking correctly configured.
    for (const supplied of ['groups/03jtnz0s3nmkpvk', '03jtnz0s3nmkpvk']) {
      expect(
        readInitialAccessGroupConfiguration({
          PSD_EOC_INITIAL_ACCESS_GROUP_ID: supplied,
          PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: 'admins@example.invalid',
        })?.googleGroupId,
      ).toBe('03jtnz0s3nmkpvk');
    }
  });

  test('refuses an address the roster schema could never match', () => {
    // The looser regex this replaced admitted every one of these. Each would
    // have been written to group_sources and then made readConfiguredAccessGroups
    // throw CONFIGURED_ACCESS_GROUP_INVALID for the whole district, with the
    // row immutable and sign-in closed.
    for (const value of [
      'admin..group@example.invalid',
      '.admin@example.invalid',
      'admin.@example.invalid',
      'admin@example.invalid.',
      'admin@example..invalid',
      'admin@-example.invalid',
    ]) {
      expect(() =>
        readInitialAccessGroupConfiguration({
          PSD_EOC_INITIAL_ACCESS_GROUP_ID: '03jtnz0s3nmkpvk',
          PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: value,
        }),
      ).toThrow(InitialAccessGroupConfigurationError);
    }
  });

  test('refuses a group id the evaluated-group schema could never match', () => {
    for (const value of ['groups/', 'has space', 'nested/path/id', 'has.dot']) {
      expect(() =>
        readInitialAccessGroupConfiguration({
          PSD_EOC_INITIAL_ACCESS_GROUP_ID: value,
          PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: 'admins@example.invalid',
        }),
      ).toThrow(InitialAccessGroupConfigurationError);
    }
  });

  test('refuses an address that is not one', () => {
    expect(() =>
      readInitialAccessGroupConfiguration({
        PSD_EOC_INITIAL_ACCESS_GROUP_ID: 'groups/one',
        PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: 'not-an-address',
      }),
    ).toThrow(InitialAccessGroupConfigurationError);
  });

  test('refuses a multiline display name and never logs a created email', () => {
    expect(() =>
      readInitialAccessGroupConfiguration({
        PSD_EOC_INITIAL_ACCESS_GROUP_ID: 'groups/one',
        PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: 'admins@example.invalid',
        PSD_EOC_INITIAL_ACCESS_GROUP_NAME: 'Administrators\nspoofed log line',
      }),
    ).toThrow('single-line display name');

    const email = 'never-log-this@example.invalid';
    const description = describeBootstrapOutcome({
      kind: 'created',
      groupSourceId: randomUUID(),
      email,
    });
    expect(description).not.toContain(email);
    expect(description).toContain(
      'Created the configured initial access group',
    );
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
        googleGroupId: 'synthetic-initial-administrators',
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
      await database().insert(groupMembers).values({
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

    test('reruns never rewrite an existing group or its membership', async () => {
      const groupsBefore = await database().select().from(groupSources);
      const membersBefore = await database().select().from(groupMembers);
      const firstOutcome = await bootstrapAccessConfiguration(database(), {
        googleGroupId: `groups/${randomUUID()}`,
        email: 'someone-elses-idea@example.invalid',
        displayName: 'Should not appear',
      });
      const secondOutcome = await bootstrapAccessConfiguration(
        database(),
        CONFIGURATION,
      );
      expect(firstOutcome).toEqual({
        kind: 'already-configured',
        activeGroupCount: 1,
      });
      expect(secondOutcome).toEqual(firstOutcome);
      expect(await database().select().from(groupSources)).toEqual(
        groupsBefore,
      );
      expect(await database().select().from(groupMembers)).toEqual(
        membersBefore,
      );
    });

    test('never reopens access after the existing group is deactivated', async () => {
      await database()
        .update(groupSources)
        .set({ active: false })
        .where(eq(groupSources.purpose, 'access'));
      const groupsBefore = await database().select().from(groupSources);
      const membersBefore = await database().select().from(groupMembers);

      expect(
        await bootstrapAccessConfiguration(database(), {
          googleGroupId: `groups/${randomUUID()}`,
          email: 'replacement@example.invalid',
          displayName: 'Must not appear',
        }),
      ).toEqual({ kind: 'already-configured', activeGroupCount: 0 });
      expect(await database().select().from(groupSources)).toEqual(
        groupsBefore,
      );
      expect(await database().select().from(groupMembers)).toEqual(
        membersBefore,
      );
    });

    test('does nothing at all when no configuration is supplied', async () => {
      expect(await bootstrapAccessConfiguration(database(), null)).toEqual({
        kind: 'not-configured',
      });
    });
  },
);
