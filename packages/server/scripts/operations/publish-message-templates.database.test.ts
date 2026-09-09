import { MessageTemplateCatalogSchema } from '@psd-eoc/contracts';
import { randomUUID } from 'node:crypto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  eventTypes,
  eventTypeTemplates,
  eventTypeVersions,
  groupMembers,
  groupSources,
  users,
} from '../../db/schema';
import { seedReferenceData } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import { loadMessageTemplateSet } from '../../lib/capabilities/notification-wording';
import {
  defaultMessageTemplateCatalog,
  templateCatalogWording,
} from '../../lib/notify/default-templates';
import { requireSyntheticTestDatabaseUrl } from '../../lib/testing/database';
import {
  executeOperationWithCleanup,
  executeOwnedDatabaseCreation,
} from '../../lib/testing/owned-database-lifecycle';
import { publishDefaultMessageTemplates } from './publish-message-templates';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

interface TestDatabaseContext {
  readonly baseDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly marker: string;
}

interface MarkerRow extends Record<string, unknown> {
  readonly marker: string | null;
}

const DATABASE_NAME_PATTERN = /^psd_eoc_templates_[a-f0-9]{32}_test$/u;
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000901';
const STAFF_USER_ID = '00000000-0000-4000-8000-000000000902';
const ADMIN_GROUP_SOURCE_ID = '00000000-0000-4000-8000-000000000903';
const ADMIN_EMAIL = 'templates.admin@example.invalid';

let context: TestDatabaseContext | undefined;
let connection: PostgresDatabaseConnection | undefined;
let databaseCreated = false;

function buildContext(baseUrl: string): TestDatabaseContext {
  const runId = randomUUID();
  const databaseName = `psd_eoc_templates_${runId.replaceAll('-', '')}_test`;
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The disposable template database name is invalid.');
  }
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Object.freeze({
    baseDatabaseUrl: baseUrl,
    databaseName,
    databaseUrl: databaseUrl.toString(),
    marker: `psd-eoc:message-templates-test:${runId}`,
  });
}

function openConnection(
  url: string,
  maxConnections: number,
): PostgresDatabaseConnection {
  const opened = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (opened.driver !== 'postgres') {
    throw new Error('Template publication tests require PostgreSQL.');
  }
  return opened;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readMarker(
  admin: PostgresDatabaseConnection,
  databaseName: string,
): Promise<string | null | undefined> {
  const rows = databaseExecuteRows<MarkerRow>(
    await admin.db.execute<MarkerRow>(sql`
      select shobj_description(oid, 'pg_database') as marker
      from pg_database
      where datname = ${databaseName}
    `),
  );
  if (rows.length > 1) {
    throw new Error('The disposable template database is ambiguous.');
  }
  return rows[0]?.marker;
}

async function dropOwnedDatabase(target: TestDatabaseContext): Promise<void> {
  const admin = openConnection(target.baseDatabaseUrl, 1);
  await executeOperationWithCleanup({
    operation: async () => {
      const marker = await readMarker(admin, target.databaseName);
      if (marker !== undefined && marker !== target.marker) {
        throw new Error(
          'Refusing to drop a template database without its exact ownership marker.',
        );
      }
      if (marker === target.marker) {
        await admin.db.execute(
          sql.raw(`drop database "${target.databaseName}" with (force)`),
        );
        expect(await readMarker(admin, target.databaseName)).toBeUndefined();
      }
    },
    cleanup: () => admin.close(),
    failureMessage:
      'Template database cleanup and connection close both failed.',
  });
}

async function createOwnedDatabase(target: TestDatabaseContext): Promise<void> {
  const admin = openConnection(target.baseDatabaseUrl, 1);
  await executeOwnedDatabaseCreation({
    createAndVerify: async (recordCreated) => {
      await admin.db.execute(
        sql.raw(`create database "${target.databaseName}"`),
      );
      recordCreated();
      await admin.db.execute(
        sql.raw(
          `comment on database "${target.databaseName}" is ${quotedLiteral(target.marker)}`,
        ),
      );
      expect(await readMarker(admin, target.databaseName)).toBe(target.marker);
    },
    closeCreator: () => admin.close(),
    rollbackWithFreshMarkerProof: () => dropOwnedDatabase(target),
    failureMessage:
      'Template database creation, verification, or cleanup failed.',
  });
}

async function cleanup(): Promise<void> {
  const errors: unknown[] = [];
  if (connection !== undefined) {
    try {
      await connection.close();
    } catch (error) {
      errors.push(error);
    } finally {
      connection = undefined;
    }
  }
  if (databaseCreated && context !== undefined) {
    try {
      await dropOwnedDatabase(context);
      databaseCreated = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Template database cleanup failed.');
  }
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The template database is not open.');
  }
  return connection;
}

describeWithDatabase('default message template publication', () => {
  beforeEach(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for integration tests.');
    }
    context = buildContext(baseTestDatabaseUrl);
    try {
      await createOwnedDatabase(context);
      databaseCreated = true;
      connection = openConnection(context.databaseUrl, 3);
      await migrateDatabase(connection);
      await seedReferenceData(connection.db);
      await connection.db.insert(users).values([
        {
          id: ADMIN_USER_ID,
          googleSubject: 'synthetic-templates-admin-subject',
          email: ADMIN_EMAIL,
          displayName: 'Synthetic Templates Administrator',
          facilityScopeKind: 'district',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          disabledAt: null,
        },
        {
          id: STAFF_USER_ID,
          googleSubject: 'synthetic-templates-staff-subject',
          email: 'templates.staff@example.invalid',
          displayName: 'Synthetic Templates Staff',
          facilityScopeKind: 'district',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          disabledAt: null,
        },
      ]);
      // Roles are never stored: the administrator is a member of an
      // active sign-in group that grants the admin role, the way every
      // request reads it. The staff user belongs to no such group.
      await connection.db.insert(groupSources).values({
        id: ADMIN_GROUP_SOURCE_ID,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Synthetic templates administrators',
        grantedRole: 'admin',
        active: true,
        googleGroupId: 'synthetic_templates_admins',
        email: 'templates-admins@example.invalid',
        fixtureKey: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      await connection.db.insert(groupMembers).values({
        groupSourceId: ADMIN_GROUP_SOURCE_ID,
        email: ADMIN_EMAIL,
        capturedAt: new Date('2026-09-01T00:00:00.000Z'),
      });
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Template publication setup and cleanup both failed.',
        );
      }
      throw error;
    }
  });

  afterEach(async () => cleanup());

  test('supersedes only the versions whose wording differs, keeps their state, and then has nothing to do', async () => {
    const database = databaseConnection().db;
    // The seed carries the default wording, so a fresh database needs nothing.
    const fresh = await publishDefaultMessageTemplates(database, {
      approvedByUserId: ADMIN_USER_ID,
      now: new Date('2026-09-09T20:00:00.000Z'),
    });
    expect(fresh.published).toEqual([]);
    expect(fresh.unchanged.length).toBeGreaterThan(0);

    // Two response types get a current version that still carries the
    // wording that shipped before: one enabled, one disabled, so both the
    // copy and the state are exercised. Template rows are immutable, so the
    // legacy wording arrives as a superseding version, the way any change
    // does.
    const legacy = async (key: string, enabled: boolean) => {
      const [current] = await database
        .select({
          id: eventTypeVersions.id,
          eventTypeId: eventTypeVersions.eventTypeId,
          version: eventTypeVersions.version,
          templateMode: eventTypeVersions.templateMode,
          name: eventTypeVersions.name,
          description: eventTypeVersions.description,
        })
        .from(eventTypeVersions)
        .innerJoin(eventTypes, eq(eventTypes.id, eventTypeVersions.eventTypeId))
        .where(eq(eventTypes.key, key));
      if (current === undefined) throw new Error(`${key} is not seeded.`);
      const id = randomUUID();
      const marker: 'INCIDENT' | 'DRILL' =
        current.templateMode === 'real' ? 'INCIDENT' : 'DRILL';
      await database.insert(eventTypeVersions).values({
        id,
        eventTypeId: current.eventTypeId,
        version: current.version + 1,
        templateMode: current.templateMode,
        name: current.name,
        description: current.description,
        enabled,
        supersedesVersionId: current.id,
        createdBy: { kind: 'system', serviceId: 'test-legacy' },
        publicationAuthorization: {
          kind: 'repository-seed',
          approvalReference: 'test-legacy',
        },
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      const lead =
        current.templateMode === 'real'
          ? 'REAL INCIDENT'
          : 'DRILL — TRAINING ONLY';
      await database.insert(eventTypeTemplates).values(
        (['activation', 'all-clear', 'reactivation'] as const).flatMap(
          (purpose) => [
            {
              eventTypeVersionId: id,
              templateMode: current.templateMode,
              purpose,
              channel: 'push' as const,
              classificationMarker: marker,
              title: `${lead} ${purpose.toUpperCase()}: ${current.name}`,
              subject: null,
              body: `${lead} ${purpose.toUpperCase()} at {{site}}. Started {{startTime}} by {{initiator}}.`,
              textBody: null,
            },
            {
              eventTypeVersionId: id,
              templateMode: current.templateMode,
              purpose,
              channel: 'email' as const,
              classificationMarker: marker,
              title: null,
              subject: `${lead} ${purpose.toUpperCase()}: ${current.name} at {{site}}`,
              body: null,
              textBody: `${lead} ${purpose.toUpperCase()}\n\nSite: {{site}}`,
            },
            {
              eventTypeVersionId: id,
              templateMode: current.templateMode,
              purpose,
              channel: 'sms' as const,
              classificationMarker: marker,
              title: null,
              subject: null,
              body: `${lead} ${purpose.toUpperCase()}: {{eventType}} at {{site}}.`,
              textBody: null,
            },
          ],
        ),
      );
      return { id, eventTypeId: current.eventTypeId };
    };
    const lockdownDrill = await legacy('lockdown-drill', true);
    const other = await legacy('other', false);

    const now = new Date('2026-09-09T20:05:00.000Z');
    // Only an enabled administrator on record may publish in their name.
    await expect(
      publishDefaultMessageTemplates(database, {
        approvedByUserId: STAFF_USER_ID,
        now,
      }),
    ).rejects.toThrow('enabled administrator');
    const summary = await publishDefaultMessageTemplates(database, {
      approvedByUserId: ADMIN_USER_ID,
      approvalReference: 'test-approval',
      now,
    });
    expect(summary.published).toEqual([
      { key: 'lockdown-drill', fromVersion: 2, toVersion: 3, enabled: true },
      { key: 'other', fromVersion: 2, toVersion: 3, enabled: false },
    ]);
    expect(summary.unchanged).not.toContain('lockdown-drill');
    expect(summary.unchanged).not.toContain('other');

    const successors = await database
      .select()
      .from(eventTypeVersions)
      .where(eq(eventTypeVersions.version, 3))
      .orderBy(asc(eventTypeVersions.name));
    expect(successors).toHaveLength(2);
    for (const successor of successors) {
      expect([lockdownDrill.id, other.id] as string[]).toContain(
        successor.supersedesVersionId ?? '',
      );
      expect(successor.createdAt.toISOString()).toBe(now.toISOString());
      expect(successor.createdBy).toEqual({
        kind: 'human',
        userId: ADMIN_USER_ID,
        sessionId: summary.runSessionId,
      });
      expect(successor.publicationAuthorization).toEqual({
        kind: 'human-admin',
        approvedByUserId: ADMIN_USER_ID,
        approvalReference: 'test-approval',
      });
      const loaded = await loadMessageTemplateSet(
        database,
        successor.id,
        'activation',
        successor.templateMode,
      );
      expect(loaded?.templates.sms.body).toBe(
        defaultMessageTemplateCatalog(successor.templateMode).activation.sms
          .body,
      );
    }
    const [otherSuccessor] = successors.filter(
      (row) => row.supersedesVersionId === other.id,
    );
    expect(otherSuccessor?.enabled).toBe(false);
    const [lockdownSuccessor] = successors.filter(
      (row) => row.supersedesVersionId === lockdownDrill.id,
    );
    expect(lockdownSuccessor?.enabled).toBe(true);
    expect(lockdownSuccessor?.eventTypeId).toBe(lockdownDrill.eventTypeId);

    // Every current version now carries the default wording.
    for (const successor of successors) {
      const sets = await Promise.all(
        (['activation', 'all-clear', 'reactivation'] as const).map((purpose) =>
          loadMessageTemplateSet(
            database,
            successor.id,
            purpose,
            successor.templateMode,
          ),
        ),
      );
      const catalog = MessageTemplateCatalogSchema.parse({
        activation: sets[0]?.templates,
        'all-clear': sets[1]?.templates,
        reactivation: sets[2]?.templates,
      });
      expect(templateCatalogWording(catalog)).toBe(
        templateCatalogWording(
          defaultMessageTemplateCatalog(successor.templateMode),
        ),
      );
    }

    // A second run has nothing left to publish.
    const again = await publishDefaultMessageTemplates(database, {
      approvedByUserId: ADMIN_USER_ID,
      now,
    });
    expect(again.published).toEqual([]);
  });
});
