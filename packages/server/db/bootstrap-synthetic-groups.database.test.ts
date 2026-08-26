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
} from './client';
import { migrateDatabase } from '../drizzle/migrate';
import { resolveEventRecipients } from '../lib/notify/event-recipients';
import { bootstrapSyntheticGroups } from './bootstrap-synthetic-groups';
import { facilities, groupMembers, groupSources } from './schema';
import { createDisposableDatabase } from '../lib/testing/database';
import { executeOperationWithCleanup } from '../lib/testing/owned-database-lifecycle';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const SCHOOL = randomUUID();
const STAFF_GROUP = randomUUID();
const SEEDED_AT = new Date('2026-08-22T09:00:00.000Z');

const environment = {
  PSD_EOC_SYNTHETIC_GROUPS: JSON.stringify([
    { facilityCode: 'SYNSEED', members: ['canary@example.invalid'] },
    // A facility the district does not have. Skipped, not fatal.
    { facilityCode: 'GONE', members: ['ghost@example.invalid'] },
  ]),
};

let connection: PostgresDatabaseConnection | undefined;
let disposable:
  | Awaited<ReturnType<typeof createDisposableDatabase>>
  | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

describeWithDatabase('synthetic group bootstrap', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    disposable = await createDisposableDatabase('psd_eoc_synseed', baseUrl);
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('postgres required');
    connection = opened;
    await migrateDatabase(opened);

    await opened.db
      .insert(facilities)
      .values({ id: SCHOOL, code: 'SYNSEED', name: 'Synthetic Seed School' });
    // A real staff group at the same school, so the isolation is meaningful.
    await opened.db.insert(groupSources).values({
      id: STAFF_GROUP,
      kind: 'google-group',
      purpose: 'building',
      facilityId: SCHOOL,
      displayName: 'Synthetic Seed School staff',
      active: true,
      grantedRole: null,
      membersCapturedAt: SEEDED_AT,
      googleGroupId: 'provider_synseed',
      email: 'staff-synseed@example.invalid',
      fixtureKey: null,
    });
    await opened.db.insert(groupMembers).values({
      groupSourceId: STAFF_GROUP,
      email: 'realstaff@example.invalid',
    });
  });

  afterAll(async () => {
    await executeOperationWithCleanup({
      operation: async () => {
        await connection?.close();
        connection = undefined;
      },
      cleanup: async () => {
        await disposable?.drop();
        disposable = undefined;
      },
      failureMessage:
        'Synthetic group bootstrap database close and cleanup both failed.',
    });
  });

  test('creates the group and its members, and skips an unknown facility', async () => {
    const outcome = await bootstrapSyntheticGroups(
      database(),
      environment,
      () => SEEDED_AT,
    );

    expect(outcome.configured).toBe(2);
    expect(outcome.created).toEqual(['SYNSEED']);

    const [source] = await database()
      .select()
      .from(groupSources)
      .where(eq(groupSources.fixtureKey, 'synthetic-synseed'));
    expect(source?.kind).toBe('synthetic');
    expect(source?.purpose).toBe('building');
    expect(source?.facilityId).toBe(SCHOOL);
    expect(source?.grantedRole).toBeNull();
    expect(source?.googleGroupId).toBeNull();
    // Stamped, because a null read time means "never read" and this membership
    // is as current as it will ever be.
    expect(source?.membersCapturedAt).not.toBeNull();
  });

  test('the seeded group is what a synthetic activation resolves to', async () => {
    const synthetic = await resolveEventRecipients(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'synthetic',
    });

    expect(synthetic.emails).toEqual(['canary@example.invalid']);
    // The whole point: this cannot reach the real staff group at the same
    // school, so the health check exercising it cannot notify a person.
    expect(synthetic.emails).not.toContain('realstaff@example.invalid');
  });

  test('a staff activation at the same school is unaffected', async () => {
    const staff = await resolveEventRecipients(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(staff.emails).toEqual(['realstaff@example.invalid']);
    expect(staff.emails).not.toContain('canary@example.invalid');
  });

  test('running it again changes nothing', async () => {
    // Bootstrap runs on every deploy. A second pass must not duplicate the
    // group, and must not overwrite membership an operator has since edited.
    await database()
      .insert(groupMembers)
      .values({
        groupSourceId: (
          await database()
            .select({ id: groupSources.id })
            .from(groupSources)
            .where(eq(groupSources.fixtureKey, 'synthetic-synseed'))
        )[0]!.id,
        email: 'added-later@example.invalid',
      });

    const outcome = await bootstrapSyntheticGroups(
      database(),
      environment,
      () => SEEDED_AT,
    );
    expect(outcome.created).toEqual([]);
    expect(outcome.existing).toEqual(['synthetic-synseed']);

    const sources = await database()
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(eq(groupSources.fixtureKey, 'synthetic-synseed'));
    expect(sources).toHaveLength(1);

    const synthetic = await resolveEventRecipients(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'synthetic',
    });
    expect(synthetic.emails).toEqual([
      'added-later@example.invalid',
      'canary@example.invalid',
    ]);
  });

  test('no configuration creates nothing', async () => {
    const outcome = await bootstrapSyntheticGroups(
      database(),
      {},
      () => SEEDED_AT,
    );
    expect(outcome).toEqual({ configured: 0, created: [], existing: [] });
  });
});
