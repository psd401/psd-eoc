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
} from '../../db/client';
import {
  facilities,
  neighborhoodFacilities,
  neighborhoodVersions,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import { campusMateFacilityIds } from './campus-scope';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const NORTH = randomUUID();
const SOUTH = randomUUID();
const EAST = randomUUID();
const REVIEW = randomUUID();
const ALONE = randomUUID();
const CAMPUS = randomUUID();

let connection: PostgresDatabaseConnection | undefined;
let databaseName = '';

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

describeWithDatabase('campus mates of a facility-limited person', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    databaseName = `psd_eoc_campus_${randomUUID().replaceAll('-', '')}_test`;
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
      { id: EAST, code: 'EST', name: 'East School' },
      { id: REVIEW, code: 'RVW', name: 'Review Site', isolated: true },
      { id: ALONE, code: 'ALN', name: 'Alone School' },
    ]);
    // Version 1 put East on the campus; version 2, the current one, moved it
    // off and added the isolated review site.
    // A version accepts its schools only in the transaction that publishes
    // it.
    const publish = (version: number, members: readonly string[]) =>
      opened.db.transaction(async (transaction) => {
        await transaction
          .insert(neighborhoodVersions)
          .values({ id: CAMPUS, version, name: 'Campus' });
        await transaction.insert(neighborhoodFacilities).values(
          members.map((facilityId) => ({
            neighborhoodId: CAMPUS,
            neighborhoodVersion: version,
            facilityId,
          })),
        );
      });
    await publish(1, [NORTH, SOUTH, EAST]);
    await publish(2, [NORTH, SOUTH, REVIEW]);
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

  test('names the other schools on the current campus', async () => {
    expect(await campusMateFacilityIds(database(), [SOUTH])).toEqual([NORTH]);
    expect(await campusMateFacilityIds(database(), [NORTH])).toEqual([SOUTH]);
  });

  test('never names the schools the person already has', async () => {
    expect(await campusMateFacilityIds(database(), [NORTH, SOUTH])).toEqual([]);
  });

  test('ignores a superseded campus version', async () => {
    expect(await campusMateFacilityIds(database(), [EAST])).toEqual([]);
  });

  test('keeps an isolated facility apart in both directions', async () => {
    expect(await campusMateFacilityIds(database(), [REVIEW])).toEqual([]);
    expect(await campusMateFacilityIds(database(), [SOUTH])).not.toContain(
      REVIEW,
    );
  });

  test('an isolated school beside a campus school adds only the campus', async () => {
    expect(await campusMateFacilityIds(database(), [REVIEW, SOUTH])).toEqual([
      NORTH,
    ]);
  });

  test('names nobody for a school on no campus', async () => {
    expect(await campusMateFacilityIds(database(), [ALONE])).toEqual([]);
  });
});
