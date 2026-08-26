import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../packages/server/db/client';
import { seedDatabase } from '../../../packages/server/db/seed';
import { events } from '../../../packages/server/db/schema';
import { migrateDatabase } from '../../../packages/server/drizzle/migrate';
import { createDisposableDatabase } from '../../../packages/server/lib/testing/database';
import { executeOperationWithCleanup } from '../../../packages/server/lib/testing/owned-database-lifecycle';
import { POST } from './drill-session-route';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

let connection: PostgresDatabaseConnection | undefined;
let disposable:
  | Awaited<ReturnType<typeof createDisposableDatabase>>
  | undefined;
let previousDatabaseUrl: string | undefined;
let previousDatabaseDriver: string | undefined;
let applicationLogin: string | undefined;

const DRILL_ENVIRONMENT = {
  GOOGLE_OIDC_APPLICATION_ORIGIN:
    'https://synthetic.us-west-2.awsapprunner.com',
  GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
  PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS: 'non-production',
  PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN: 'synthetic-operator-token',
  PSD_EOC_FAILURE_DRILL_PROVIDER_MODE: 'mocked',
  PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION: 'synthetic',
  PSD_EOC_FAILURE_DRILL_RUN_ID: 'issue-31-integration',
} as const;
const previousDrillEnvironment = new Map<string, string | undefined>();

describeWithDatabase('deployed synthetic session fixture', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    disposable = await createDisposableDatabase(
      'psd_eoc_drill_session',
      baseUrl,
    );
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('postgres required');
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);
    if (opened.nativeClient === undefined)
      throw new Error('native client required');
    applicationLogin = `issue31_session_${randomUUID().replaceAll('-', '')}`;
    const applicationPassword = `synthetic-${randomUUID()}`;
    await opened.nativeClient.unsafe(
      `create role "${applicationLogin}" login password '${applicationPassword}' in role "psd_eoc_app"`,
    );
    const applicationUrl = new URL(disposable.url);
    applicationUrl.username = applicationLogin;
    applicationUrl.password = applicationPassword;
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousDatabaseDriver = process.env.DATABASE_DRIVER;
    process.env.DATABASE_URL = applicationUrl.toString();
    process.env.DATABASE_DRIVER = 'postgres';
    for (const [name, value] of Object.entries(DRILL_ENVIRONMENT)) {
      previousDrillEnvironment.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousDatabaseDriver === undefined)
      delete process.env.DATABASE_DRIVER;
    else process.env.DATABASE_DRIVER = previousDatabaseDriver;
    for (const name of Object.keys(DRILL_ENVIRONMENT)) {
      const value = previousDrillEnvironment.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previousDrillEnvironment.clear();
    await executeOperationWithCleanup({
      operation: async () => {
        if (
          connection?.nativeClient !== undefined &&
          applicationLogin !== undefined
        ) {
          await connection.nativeClient.unsafe(
            `drop role if exists "${applicationLogin}"`,
          );
          applicationLogin = undefined;
        }
        await connection?.close();
        connection = undefined;
      },
      cleanup: async () => {
        await disposable?.drop();
        disposable = undefined;
      },
      failureMessage:
        'Synthetic drill session database close and cleanup both failed.',
    });
  });

  test('issues a session and starts an event from seeded mocked channels', async () => {
    if (connection === undefined) throw new Error('database required');
    const response = await POST(
      new Request('http://169.254.172.2:3000/api/failure-drills/session', {
        headers: {
          Authorization: `Bearer ${DRILL_ENVIRONMENT.PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN}`,
          Origin: DRILL_ENVIRONMENT.GOOGLE_OIDC_APPLICATION_ORIGIN,
        },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      applicationOrigin: DRILL_ENVIRONMENT.GOOGLE_OIDC_APPLICATION_ORIGIN,
    });
    const eventPath = (body as { eventPath?: unknown }).eventPath;
    expect(eventPath).toMatch(/^\/events\/[0-9a-f-]{36}$/u);
    const eventId = String(eventPath).slice('/events/'.length);

    const [event] = await connection.db
      .select({
        id: events.id,
        kind: events.kind,
        rosterPopulation: events.rosterPopulation,
        status: events.status,
        templateMode: events.templateMode,
      })
      .from(events)
      .where(eq(events.id, eventId));
    expect(event).toEqual({
      id: eventId,
      kind: 'drill',
      rosterPopulation: 'synthetic',
      status: 'active',
      templateMode: 'drill',
    });
  });
});
