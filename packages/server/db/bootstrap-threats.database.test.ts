import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';

import {
  ThreatConfigurationError,
  bootstrapThreats,
  describeThreatOutcome,
  readThreatConfiguration,
} from './bootstrap-threats';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from './client';
import { threats } from './schema';
import { migrateDatabase } from '../drizzle/migrate';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

/** Keys unique to this run, so the suite never collides with seeded rows. */
function uniqueKeys(count: number): string[] {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toLowerCase();
  return Array.from(
    { length: count },
    (_, index) => `test-${suffix}-${String(index)}`,
  );
}

/** Non-optional accessor; the helper always returns the requested length. */
function keyAt(keys: readonly string[], index: number): string {
  const value = keys[index];
  if (value === undefined) throw new Error('missing generated key');
  return value;
}

describe('threat configuration parsing', () => {
  test('an absent or empty value configures nothing, which is allowed', () => {
    expect(readThreatConfiguration({})).toEqual([]);
    expect(readThreatConfiguration({ PSD_EOC_THREATS: '   ' })).toEqual([]);
  });

  test('reads a list and defaults requiresDetail to false and active to true', () => {
    const parsed = readThreatConfiguration({
      PSD_EOC_THREATS: JSON.stringify([
        { key: 'fire', name: 'Fire' },
        { key: 'other', name: 'Other', requiresDetail: true },
        { key: 'retired', name: 'Retired', active: false },
      ]),
    });
    expect(parsed).toEqual([
      { key: 'fire', name: 'Fire', requiresDetail: false, active: true },
      { key: 'other', name: 'Other', requiresDetail: true, active: true },
      { key: 'retired', name: 'Retired', requiresDetail: false, active: false },
    ]);
  });

  test('refuses malformed configuration rather than seeding nothing quietly', () => {
    expect(() =>
      readThreatConfiguration({ PSD_EOC_THREATS: '{not json' }),
    ).toThrow(ThreatConfigurationError);
    expect(() =>
      readThreatConfiguration({
        PSD_EOC_THREATS: JSON.stringify([{ key: 'Fire', name: 'Fire' }]),
      }),
    ).toThrow(ThreatConfigurationError);
    expect(() =>
      readThreatConfiguration({
        PSD_EOC_THREATS: JSON.stringify([{ key: 'fire', name: '  ' }]),
      }),
    ).toThrow(ThreatConfigurationError);
    expect(() =>
      readThreatConfiguration({
        PSD_EOC_THREATS: JSON.stringify([
          { key: 'fire', name: 'Fire', unexpected: true },
        ]),
      }),
    ).toThrow(ThreatConfigurationError);
    expect(() =>
      readThreatConfiguration({
        PSD_EOC_THREATS: JSON.stringify({ key: 'fire', name: 'Fire' }),
      }),
    ).toThrow(ThreatConfigurationError);
  });

  test('refuses the same threat listed twice', () => {
    expect(() =>
      readThreatConfiguration({
        PSD_EOC_THREATS: JSON.stringify([
          { key: 'intruder', name: 'Intruder' },
          { key: 'intruder', name: 'Intruder' },
        ]),
      }),
    ).toThrow(ThreatConfigurationError);
  });
});

describeWithDatabase('threat bootstrap', () => {
  let connection: PostgresDatabaseConnection | undefined;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for this test.');
    }
    const created = createDatabaseClient({
      driver: 'postgres',
      maxConnections: 4,
      url: testDatabaseUrl,
    });
    if (created.driver !== 'postgres') {
      throw new Error('This test requires direct PostgreSQL.');
    }
    connection = created;
    await migrateDatabase(created);
  });

  afterAll(async () => {
    await connection?.close();
  });

  test('creates the configured threats a fresh deployment lacks, in declared order', async () => {
    const generated = uniqueKeys(3);
    const first = keyAt(generated, 0);
    const second = keyAt(generated, 1);
    const third = keyAt(generated, 2);
    const environment = {
      PSD_EOC_THREATS: JSON.stringify([
        { key: first, name: 'First Threat' },
        { key: second, name: 'Second Threat', requiresDetail: true },
        { key: third, name: 'Retired Threat', active: false },
      ]),
    };

    const outcome = await bootstrapThreats(connection!.db, environment);
    expect(outcome.configured).toBe(3);
    expect(outcome.created).toEqual([first, second, third]);

    const rows = await connection!.db
      .select()
      .from(threats)
      .where(inArray(threats.key, [first, second, third]));
    expect(rows).toHaveLength(3);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get(first)).toMatchObject({
      name: 'First Threat',
      sortOrder: 0,
      requiresDetail: false,
      active: true,
    });
    expect(byKey.get(second)).toMatchObject({
      sortOrder: 1,
      requiresDetail: true,
    });
    expect(byKey.get(third)).toMatchObject({ sortOrder: 2, active: false });
  });

  test('running it again creates nothing, so every deploy can run it', async () => {
    const key = keyAt(uniqueKeys(1), 0);
    const environment = {
      PSD_EOC_THREATS: JSON.stringify([{ key, name: 'Repeatable' }]),
    };

    const first = await bootstrapThreats(connection!.db, environment);
    expect(first.created).toEqual([key]);

    const second = await bootstrapThreats(connection!.db, environment);
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual([key]);

    const rows = await connection!.db
      .select()
      .from(threats)
      .where(eq(threats.key, key));
    expect(rows).toHaveLength(1);
  });

  test('leaves an existing row alone rather than reasserting configuration', async () => {
    const key = keyAt(uniqueKeys(1), 0);
    await bootstrapThreats(connection!.db, {
      PSD_EOC_THREATS: JSON.stringify([{ key, name: 'Original Name' }]),
    });
    await connection!.db
      .update(threats)
      .set({ active: false, name: 'Renamed Later', sortOrder: 40 })
      .where(eq(threats.key, key));

    await bootstrapThreats(connection!.db, {
      PSD_EOC_THREATS: JSON.stringify([
        { key: keyAt(uniqueKeys(1), 0), name: 'Now Listed First' },
        { key, name: 'Original Name' },
      ]),
    });

    const [row] = await connection!.db
      .select()
      .from(threats)
      .where(eq(threats.key, key));
    expect(row?.name).toBe('Renamed Later');
    expect(row?.active).toBe(false);
    expect(row?.sortOrder).toBe(40);
  });

  test('adds only what is missing when configuration grows', async () => {
    const growing = uniqueKeys(2);
    const existing = keyAt(growing, 0);
    const added = keyAt(growing, 1);
    await bootstrapThreats(connection!.db, {
      PSD_EOC_THREATS: JSON.stringify([{ key: existing, name: 'Existing' }]),
    });

    const outcome = await bootstrapThreats(connection!.db, {
      PSD_EOC_THREATS: JSON.stringify([
        { key: existing, name: 'Existing' },
        { key: added, name: 'Newly Declared' },
      ]),
    });
    expect(outcome.created).toEqual([added]);
    expect(outcome.existing).toEqual([existing]);

    const [row] = await connection!.db
      .select()
      .from(threats)
      .where(eq(threats.key, added));
    expect(row?.sortOrder).toBe(1);
  });

  test('the table refuses a key the contract would refuse', async () => {
    await expect(
      connection!.db
        .insert(threats)
        .values({
          key: 'Not-A-Key',
          name: 'Bad Key',
          sortOrder: 0,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      connection!.db
        .insert(threats)
        .values({
          key: keyAt(uniqueKeys(1), 0),
          name: '   ',
          sortOrder: 0,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      connection!.db
        .insert(threats)
        .values({
          key: keyAt(uniqueKeys(1), 0),
          name: 'Negative Order',
          sortOrder: -1,
        })
        .execute(),
    ).rejects.toThrow();
  });

  test('the application role can read threats and never write them', async () => {
    const [privileges] = await connection!.db.execute<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(sql`
      select
        has_table_privilege('psd_eoc_app', 'public.threats', 'SELECT') as can_select,
        has_table_privilege('psd_eoc_app', 'public.threats', 'INSERT') as can_insert,
        has_table_privilege('psd_eoc_app', 'public.threats', 'UPDATE') as can_update,
        has_table_privilege('psd_eoc_app', 'public.threats', 'DELETE') as can_delete
    `);
    expect(privileges).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    });
  });

  test('describes the outcome without naming anything sensitive', () => {
    expect(
      describeThreatOutcome({ configured: 0, created: [], existing: [] }),
    ).toContain('No threats are configured');
    expect(
      describeThreatOutcome({
        configured: 2,
        created: [],
        existing: ['fire', 'other'],
      }),
    ).toContain('already exist');
    expect(
      describeThreatOutcome({
        configured: 2,
        created: ['fire'],
        existing: ['other'],
      }),
    ).toBe('Created 1 of 2 configured threats: fire.');
  });
});
