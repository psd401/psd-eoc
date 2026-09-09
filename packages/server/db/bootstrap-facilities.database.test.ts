import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import {
  FacilityConfigurationError,
  bootstrapFacilities,
  describeFacilityOutcome,
  readFacilityConfiguration,
  readNeighborhoodConfiguration,
} from './bootstrap-facilities';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from './client';
import { facilities } from './schema';
import { migrateDatabase } from '../drizzle/migrate';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

/** Codes unique to this run, so the suite never collides with seeded rows. */
function uniqueCodes(count: number): string[] {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  return Array.from({ length: count }, (_, index) => `TEST-${suffix}-${index}`);
}

/** Non-optional accessor; the helper always returns the requested length. */
function codeAt(codes: readonly string[], index: number): string {
  const value = codes[index];
  if (value === undefined) throw new Error('missing generated code');
  return value;
}

describe('facility configuration parsing', () => {
  test('an absent or empty value configures nothing, which is allowed', () => {
    expect(readFacilityConfiguration({})).toEqual([]);
    expect(readFacilityConfiguration({ PSD_EOC_FACILITIES: '   ' })).toEqual(
      [],
    );
  });

  test('reads a list and defaults active to true', () => {
    const parsed = readFacilityConfiguration({
      PSD_EOC_FACILITIES: JSON.stringify([
        { code: 'AES', name: 'Artondale Elementary' },
        { code: 'CLOSED-1', name: 'Former Site', active: false },
      ]),
    });
    expect(parsed).toEqual([
      {
        active: true,
        code: 'AES',
        name: 'Artondale Elementary',
        isolated: false,
      },
      { active: false, code: 'CLOSED-1', name: 'Former Site', isolated: false },
    ]);
  });

  test('refuses malformed configuration rather than seeding nothing quietly', () => {
    for (const value of [
      'not json',
      '{"code":"AES"}',
      JSON.stringify([{ code: 'lower-case', name: 'Bad Code' }]),
      JSON.stringify([{ code: 'AES', name: '' }]),
      JSON.stringify([{ code: 'AES', name: 'A', extra: 'unexpected' }]),
      // A duplicate code would violate the table's unique index at insert; it
      // is refused here so the message names the problem.
      JSON.stringify([
        { code: 'AES', name: 'One' },
        { code: 'AES', name: 'Two' },
      ]),
    ]) {
      expect(() =>
        readFacilityConfiguration({ PSD_EOC_FACILITIES: value }),
      ).toThrow(FacilityConfigurationError);
    }
  });
});

describe('neighborhood configuration parsing', () => {
  test('refuses the same facility listed twice in one neighborhood', () => {
    // The membership rows are keyed on (neighborhood, version, facility), so a
    // repeat is a duplicate-key violation from the driver rather than a named
    // configuration error.
    expect(() =>
      readNeighborhoodConfiguration({
        PSD_EOC_NEIGHBORHOODS: JSON.stringify([
          { name: 'North', facilityCodes: ['AES', 'AES'] },
        ]),
      }),
    ).toThrow(FacilityConfigurationError);
    expect(
      readNeighborhoodConfiguration({
        PSD_EOC_NEIGHBORHOODS: JSON.stringify([
          { name: 'North', facilityCodes: ['AES', 'DES'] },
        ]),
      }),
    ).toHaveLength(1);
  });
});

describeWithDatabase('bootstrapping facilities from configuration', () => {
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

  test('creates the configured facilities a fresh deployment lacks', async () => {
    const generated = uniqueCodes(2);
    const first = codeAt(generated, 0);
    const second = codeAt(generated, 1);
    const environment = {
      PSD_EOC_FACILITIES: JSON.stringify([
        { code: first, name: 'First School' },
        { code: second, name: 'Second School', active: false, isolated: true },
      ]),
    };

    const outcome = await bootstrapFacilities(connection!.db, environment);
    expect(outcome.configured).toBe(2);
    expect([...outcome.created].sort()).toEqual([first, second].sort());

    const rows = await connection!.db
      .select()
      .from(facilities)
      .where(inArray(facilities.code, [first, second]));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.code === second)?.active).toBe(false);
    expect(rows.find((row) => row.code === second)?.isolated).toBe(true);
    expect(rows.find((row) => row.code === first)?.isolated).toBe(false);
    expect(rows.find((row) => row.code === first)?.name).toBe('First School');
  });

  test('running it again creates nothing, so every deploy can run it', async () => {
    const code = codeAt(uniqueCodes(1), 0);
    const environment = {
      PSD_EOC_FACILITIES: JSON.stringify([{ code, name: 'Repeatable' }]),
    };

    const first = await bootstrapFacilities(connection!.db, environment);
    expect(first.created).toEqual([code]);

    const second = await bootstrapFacilities(connection!.db, environment);
    expect(second.created).toEqual([]);
    expect(second.existing).toEqual([code]);

    const rows = await connection!.db
      .select()
      .from(facilities)
      .where(eq(facilities.code, code));
    expect(rows).toHaveLength(1);
  });

  test('leaves an operator’s edits alone rather than reasserting configuration', async () => {
    const code = codeAt(uniqueCodes(1), 0);
    await bootstrapFacilities(connection!.db, {
      PSD_EOC_FACILITIES: JSON.stringify([{ code, name: 'Original Name' }]),
    });
    // Somebody renames the school and closes it through the admin UI.
    await connection!.db
      .update(facilities)
      .set({ active: false, name: 'Renamed By An Administrator' })
      .where(eq(facilities.code, code));

    await bootstrapFacilities(connection!.db, {
      PSD_EOC_FACILITIES: JSON.stringify([{ code, name: 'Original Name' }]),
    });

    const [row] = await connection!.db
      .select()
      .from(facilities)
      .where(eq(facilities.code, code));
    expect(row?.name).toBe('Renamed By An Administrator');
    expect(row?.active).toBe(false);
  });

  test('adds only what is missing when configuration grows', async () => {
    const growing = uniqueCodes(2);
    const existing = codeAt(growing, 0);
    const added = codeAt(growing, 1);
    await bootstrapFacilities(connection!.db, {
      PSD_EOC_FACILITIES: JSON.stringify([
        { code: existing, name: 'Existing' },
      ]),
    });

    const outcome = await bootstrapFacilities(connection!.db, {
      PSD_EOC_FACILITIES: JSON.stringify([
        { code: existing, name: 'Existing' },
        { code: added, name: 'Newly Opened' },
      ]),
    });
    expect(outcome.created).toEqual([added]);
    expect(outcome.existing).toEqual([existing]);
  });

  test('describes the outcome without naming anything sensitive', () => {
    expect(
      describeFacilityOutcome({ configured: 0, created: [], existing: [] }),
    ).toContain('No facilities are configured');
    expect(
      describeFacilityOutcome({
        configured: 2,
        created: [],
        existing: ['A', 'B'],
      }),
    ).toContain('already exist');
    expect(
      describeFacilityOutcome({
        configured: 2,
        created: ['B'],
        existing: ['A'],
      }),
    ).toContain('Created 1 of 2');
  });
});
