import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { asc, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import { seedDatabase } from '../../../db/seed';
import {
  deviceEnrollments,
  partnerAdmissions,
  partnerAlertSettings,
  sessions,
  users,
} from '../../../db/schema';
import { migrateDatabase } from '../../../drizzle/migrate';
import {
  DrizzleSessionStore,
  SessionService,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
} from '../../../lib/capabilities/admin';
import { loadEffectivePartnerAlertSettings } from '../../../lib/partners/alert-settings';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../../../lib/testing/database';
import { issueSyntheticPartnerSession } from '../../../lib/testing/partner-session';
import {
  executeGetPartnerAlertSettingsCapability,
  executeSetPartnerAlertSettingsCapability,
} from './capabilities';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
let admin: AuthenticatedSession;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

function session(roles: readonly string[]): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: randomUUID(), sessionId: randomUUID() },
    source: 'web',
    roles,
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: randomUUID() } },
  } as unknown as AuthenticatedSession;
}

async function persistActor(authenticated: AuthenticatedSession) {
  if (authenticated.actor.kind !== 'human') throw new Error('human only');
  const suffix = authenticated.actor.userId.slice(0, 8);
  const now = new Date();
  const deviceId = randomUUID();
  await database()
    .insert(users)
    .values({
      id: authenticated.actor.userId,
      googleSubject: `alert-admin-${suffix}`,
      identityIssuer: 'https://accounts.google.com',
      identitySubject: `alert-admin-${suffix}`,
      email: `alert-admin-${suffix}@district.example.invalid`,
      displayName: `Alert admin ${suffix}`,
      facilityScopeKind: 'district',
      createdAt: now,
    });
  await database()
    .insert(deviceEnrollments)
    .values({
      id: deviceId,
      userId: authenticated.actor.userId,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `alert-admin-device-${suffix}`,
      enrolledAt: now,
      lastSeenAt: now,
    });
  await database()
    .insert(sessions)
    .values({
      id: authenticated.actor.sessionId,
      userId: authenticated.actor.userId,
      deviceEnrollmentId: deviceId,
      membershipSnapshotId: null,
      membershipValidUntil: new Date(now.getTime() + 60 * 60 * 1_000),
      membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
    });
}

function metadata() {
  return {
    idempotencyKey: `partner-alerts-${randomUUID()}`,
    requestId: randomUUID(),
    now: new Date(),
  };
}

function read(authenticated: AuthenticatedSession = admin) {
  return executeGetPartnerAlertSettingsCapability({
    authenticated,
    store: createDrizzleAdminCapabilityStore(database(), authenticated),
    query: {},
  });
}

function save(
  command: Readonly<{
    responseFamilyKeys: readonly string[];
    excludedThreatKeys: readonly string[];
    baseVersionId: string | null;
  }>,
  options: Readonly<{
    authenticated?: AuthenticatedSession;
    metadata?: ReturnType<typeof metadata>;
  }> = {},
) {
  const authenticated = options.authenticated ?? admin;
  return executeSetPartnerAlertSettingsCapability({
    authenticated,
    store: createDrizzleAdminCapabilityStore(database(), authenticated),
    command,
    metadata: options.metadata ?? metadata(),
  });
}

async function expectAdminRefusal(
  operation: Promise<unknown>,
  status: number,
): Promise<string> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AdminCapabilityError);
    expect((error as AdminCapabilityError).status).toBe(status);
    return (error as AdminCapabilityError).message;
  }
  throw new Error(`Expected a ${status} refusal.`);
}

async function currentVersionId(): Promise<string | null> {
  return (await read()).current?.id ?? null;
}

describeWithDatabase('partner alert settings', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) throw new Error('no database');
    ownedDatabase = await createDisposableDatabase(
      'psd_eoc_partner_alerts',
      baseTestDatabaseUrl,
    );
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('PostgreSQL only.');
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);
    admin = session(['admin', 'staff']);
    await persistActor(admin);
  });

  afterAll(async () => {
    await closeAndDropDisposableDatabase(connection?.close, ownedDatabase);
  });

  test('before any save, partners are alerted for Lockdown and Modified Lockdown only', async () => {
    const state = await read();
    expect(state.current).toBeNull();
    expect(state.effective).toEqual({
      responseFamilyKeys: ['lockdown', 'modified-lockdown'],
      excludedThreatKeys: [],
    });
    expect(await loadEffectivePartnerAlertSettings(database())).toEqual(
      state.effective,
    );
    // Every response family, once, named by its real version, in the
    // operators' order; every threat, retired ones marked.
    expect(state.responseOptions.map(({ familyKey }) => familyKey)).toEqual([
      'investigation',
      'modified-lockdown',
      'lockdown',
      'evacuation',
      'no-evacuation',
      'shelter-in-place',
      'other',
    ]);
    expect(
      state.responseOptions.find(({ familyKey }) => familyKey === 'lockdown')
        ?.name,
    ).toBe('Lockdown');
    expect(state.threatOptions).toEqual([
      { key: 'synthetic-wildlife', name: 'Synthetic wildlife', active: true },
      {
        key: 'synthetic-earthquake',
        name: 'Synthetic earthquake',
        active: true,
      },
      { key: 'synthetic-other', name: 'Synthetic other', active: true },
      {
        key: 'synthetic-retired',
        name: 'Synthetic retired threat',
        active: false,
      },
    ]);
  });

  test('each save is a new version naming its administrator and the version it replaced', async () => {
    if (admin.actor.kind !== 'human') throw new Error('human only');
    const base = await currentVersionId();
    const first = await save({
      responseFamilyKeys: ['modified-lockdown', 'lockdown', 'evacuation'],
      excludedThreatKeys: ['synthetic-wildlife'],
      baseVersionId: base,
    });
    expect(first.supersedesVersionId).toBe(base);
    expect(first.createdByUserId).toBe(admin.actor.userId);
    // Stored sorted, so equal settings always read back the same.
    expect(first.responseFamilyKeys).toEqual([
      'evacuation',
      'lockdown',
      'modified-lockdown',
    ]);

    const second = await save({
      responseFamilyKeys: ['lockdown'],
      excludedThreatKeys: [],
      baseVersionId: first.id,
    });
    expect(second.version).toBe(first.version + 1);
    expect(second.supersedesVersionId).toBe(first.id);

    const state = await read();
    expect(state.current).toEqual(second);
    expect(state.effective).toEqual({
      responseFamilyKeys: ['lockdown'],
      excludedThreatKeys: [],
    });
    // Nothing was edited: both versions remain.
    const rows = await database()
      .select({ id: partnerAlertSettings.id })
      .from(partnerAlertSettings)
      .orderBy(asc(partnerAlertSettings.version));
    expect(rows.map(({ id }) => id).slice(-2)).toEqual([first.id, second.id]);
  });

  test('no responses at all is a saved setting that turns partner alerts off', async () => {
    const off = await save({
      responseFamilyKeys: [],
      excludedThreatKeys: [],
      baseVersionId: await currentVersionId(),
    });
    expect(off.responseFamilyKeys).toEqual([]);
    expect(await loadEffectivePartnerAlertSettings(database())).toEqual({
      responseFamilyKeys: [],
      excludedThreatKeys: [],
    });
  });

  test('a save from a stale page is refused instead of overwriting a newer one', async () => {
    const base = await currentVersionId();
    await save({
      responseFamilyKeys: ['lockdown'],
      excludedThreatKeys: [],
      baseVersionId: base,
    });
    const message = await expectAdminRefusal(
      save({
        responseFamilyKeys: ['evacuation'],
        excludedThreatKeys: [],
        baseVersionId: base,
      }),
      409,
    );
    expect(message).toContain('changed by someone else');
    expect((await read()).effective.responseFamilyKeys).toEqual(['lockdown']);
  });

  test('refuses a response or threat this deployment does not have', async () => {
    const base = await currentVersionId();
    await expectAdminRefusal(
      save({
        responseFamilyKeys: ['not-a-response'],
        excludedThreatKeys: [],
        baseVersionId: base,
      }),
      400,
    );
    await expectAdminRefusal(
      save({
        responseFamilyKeys: ['lockdown'],
        excludedThreatKeys: ['not-a-threat'],
        baseVersionId: base,
      }),
      400,
    );
    expect(await currentVersionId()).toBe(base);
  });

  test('a retried save replays the same version instead of writing another', async () => {
    const replay = metadata();
    const command = {
      responseFamilyKeys: ['lockdown', 'modified-lockdown'],
      excludedThreatKeys: ['synthetic-other'],
      baseVersionId: await currentVersionId(),
    };
    const first = await save(command, { metadata: replay });
    const again = await save(command, {
      metadata: { ...replay, requestId: randomUUID() },
    });
    expect(again).toEqual(first);
    expect(await currentVersionId()).toBe(first.id);
  });

  test('only an administrator may read or change them', async () => {
    const staff = session(['staff']);
    await persistActor(staff);
    await expectAdminRefusal(read(staff), 403);
    await expectAdminRefusal(
      save(
        {
          responseFamilyKeys: [],
          excludedThreatKeys: [],
          baseVersionId: await currentVersionId(),
        },
        { authenticated: staff },
      ),
      403,
    );
  });

  test('a partner session can neither read nor change them', async () => {
    if (admin.actor.kind !== 'human') throw new Error('human only');
    const email = `alerts-${randomUUID().slice(0, 8)}@agency.example.invalid`;
    await database().insert(partnerAdmissions).values({
      email,
      displayName: 'Synthetic Responder',
      agency: 'Synthetic Fire District',
      invitedByUserId: admin.actor.userId,
    });
    const issued = await issueSyntheticPartnerSession(database(), {
      email,
      displayName: 'Synthetic Responder',
      now: new Date(),
    });
    const partner = await new SessionService(
      new DrizzleSessionStore(database()),
    ).authenticate(issued.credential, 'web');
    expect(partner.scope.partner).toBe(true);
    const refusal =
      'This authenticated principal cannot invoke the capability.';
    expect(await expectAdminRefusal(read(partner), 403)).toBe(refusal);
    expect(
      await expectAdminRefusal(
        save(
          {
            responseFamilyKeys: [],
            excludedThreatKeys: [],
            baseVersionId: await currentVersionId(),
          },
          { authenticated: partner },
        ),
        403,
      ),
    ).toBe(refusal);
  });

  test('the application role can append and read versions but never change one', async () => {
    if (ownedDatabase === undefined) throw new Error('no database');
    if (admin.actor.kind !== 'human') throw new Error('human only');
    const roleConnection = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 1,
    });
    if (roleConnection.driver !== 'postgres') throw new Error('postgres');
    try {
      await roleConnection.db.execute(sql`set role psd_eoc_app`);
      const saved = await executeSetPartnerAlertSettingsCapability({
        authenticated: admin,
        store: createDrizzleAdminCapabilityStore(roleConnection.db, admin),
        command: {
          responseFamilyKeys: ['lockdown'],
          excludedThreatKeys: ['synthetic-earthquake'],
          baseVersionId: await currentVersionId(),
        },
        metadata: metadata(),
      });
      const state = await executeGetPartnerAlertSettingsCapability({
        authenticated: admin,
        store: createDrizzleAdminCapabilityStore(roleConnection.db, admin),
        query: {},
      });
      expect(state.current?.id).toBe(saved.id);
      for (const statement of [
        sql`update partner_alert_settings set response_family_keys = '{}' where id = ${saved.id}`,
        sql`delete from partner_alert_settings where id = ${saved.id}`,
      ]) {
        let refused: unknown;
        try {
          await roleConnection.db.execute(statement);
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeDefined();
      }
    } finally {
      await roleConnection.close();
    }
  });

  test('the table owner cannot change or remove a version either', async () => {
    const id = await currentVersionId();
    if (id === null) throw new Error('A version was expected.');
    for (const statement of [
      sql`update partner_alert_settings set response_family_keys = '{}' where id = ${id}`,
      sql`delete from partner_alert_settings where id = ${id}`,
    ]) {
      let refused: unknown;
      try {
        await database().execute(statement);
      } catch (error) {
        refused = error;
      }
      expect(
        String((refused as { cause?: unknown })?.cause ?? refused),
      ).toContain('append-only');
    }
  });

  test('the database bounds the lists and refuses null keys', async () => {
    if (admin.actor.kind !== 'human') throw new Error('human only');
    const base = await read();
    const next = (base.current?.version ?? 0) + 1;
    for (const [responses, threats] of [
      [sql`array[null]::varchar[]`, sql`'{}'::varchar[]`],
      [sql`'{}'::varchar[]`, sql`array[null]::varchar[]`],
      [sql`array_fill('lockdown'::varchar, array[101])`, sql`'{}'::varchar[]`],
    ] as const) {
      let refused: unknown;
      try {
        await database().execute(
          sql`insert into partner_alert_settings (version, response_family_keys, excluded_threat_keys, supersedes_version_id, created_by_user_id) values (${next}, ${responses}, ${threats}, ${base.current?.id ?? null}, ${admin.actor.userId})`,
        );
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeDefined();
    }
  });
});
