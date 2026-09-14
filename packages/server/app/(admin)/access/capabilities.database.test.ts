import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  deviceEnrollments,
  facilities,
  groupMembers,
  groupSources,
  securityAuditEntries,
  sessions,
  userFacilityScopes,
  users,
} from '../../../db/schema';
import { seedDatabase } from '../../../db/seed';
import { migrateDatabase } from '../../../drizzle/migrate';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
} from '../../../lib/capabilities/admin';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../../../lib/testing/database';
import {
  executeAdmitAccountCapability,
  executeListAdmittedAccountsCapability,
  executeListUsersCapability,
  executeRevokeAdmittedAccountCapability,
  executeSetUserFacilityScopeCapability,
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

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) {
    throw new Error('The user scope test connection is not open.');
  }
  return connection.db;
}

function session(roles: readonly ('admin' | 'staff')[]): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: randomUUID(), sessionId: randomUUID() },
    source: 'web',
    roles,
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: randomUUID() } },
  } as unknown as AuthenticatedSession;
}

/** The audit chain names the acting session, so it must exist. */
async function persistSession(authenticated: AuthenticatedSession) {
  if (authenticated.actor.kind !== 'human') throw new Error('human only');
  const suffix = authenticated.actor.userId.slice(0, 8);
  const now = new Date();
  const deviceId = randomUUID();
  await database()
    .insert(users)
    .values({
      id: authenticated.actor.userId,
      googleSubject: `scope-actor-${suffix}`,
      email: `scope-actor-${suffix}@example.invalid`,
      displayName: `Scope actor ${suffix}`,
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
      installationId: `scope-actor-device-${suffix}`,
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

/** A person to be scoped: a plain user row, as the first sign-in leaves it. */
async function persistPerson(): Promise<string> {
  const id = randomUUID();
  await database()
    .insert(users)
    .values({
      id,
      googleSubject: `scope-person-${id.slice(0, 8)}`,
      email: `scope-person-${id.slice(0, 8)}@example.invalid`,
      displayName: `Scope person ${id.slice(0, 8)}`,
      facilityScopeKind: 'district',
    });
  return id;
}

async function scopeRows(userId: string): Promise<string[]> {
  const rows = await database()
    .select({ facilityId: userFacilityScopes.facilityId })
    .from(userFacilityScopes)
    .where(eq(userFacilityScopes.userId, userId));
  return rows.map((row) => row.facilityId).sort();
}

async function scopeKind(userId: string): Promise<string> {
  const [row] = await database()
    .select({ kind: users.facilityScopeKind })
    .from(users)
    .where(eq(users.id, userId));
  if (row === undefined) throw new Error('The person vanished.');
  return row.kind;
}

function setScope(
  authenticated: AuthenticatedSession,
  userId: string,
  facilityScope:
    | { kind: 'district' }
    | { kind: 'facilities'; facilityIds: readonly string[] },
) {
  return executeSetUserFacilityScopeCapability({
    authenticated,
    store: createDrizzleAdminCapabilityStore(database(), authenticated),
    command: { userId, facilityScope },
    metadata: {
      idempotencyKey: `user-scope-${randomUUID()}`,
      requestId: randomUUID(),
      now: new Date(),
    },
  });
}

async function expectRefusal(
  operation: Promise<unknown>,
  status: number,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AdminCapabilityError);
    expect((error as AdminCapabilityError).status).toBe(status);
    expect((error as AdminCapabilityError).message).toBe(message);
    return;
  }
  throw new Error(`Expected a ${status} refusal: ${message}`);
}

describeWithDatabase('set-user-facility-scope', () => {
  let admin: AuthenticatedSession;
  let activeFacilityId = '';
  let otherActiveFacilityId = '';
  let inactiveFacilityId = '';

  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required for this test.');
    }
    const owned = await createDisposableDatabase(
      'psd_eoc_user_scope',
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
      .where(eq(facilities.active, true))
      .limit(2);
    if (first === undefined || second === undefined) {
      throw new Error('Two seeded active facilities are required.');
    }
    activeFacilityId = first.id;
    otherActiveFacilityId = second.id;
    inactiveFacilityId = randomUUID();
    await opened.db.insert(facilities).values({
      id: inactiveFacilityId,
      code: 'CLOSED-SCOPE',
      name: 'Closed site',
      active: false,
      isolated: false,
    });
    admin = session(['staff', 'admin']);
    await persistSession(admin);
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

  test('limits a person to facilities, then returns them to district-wide', async () => {
    const personId = await persistPerson();

    const limited = await setScope(admin, personId, {
      kind: 'facilities',
      facilityIds: [otherActiveFacilityId, activeFacilityId],
    });
    expect(limited.id).toBe(personId);
    expect(limited.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: [activeFacilityId, otherActiveFacilityId].sort(),
    });
    expect(await scopeKind(personId)).toBe('facilities');
    expect(await scopeRows(personId)).toEqual(
      [activeFacilityId, otherActiveFacilityId].sort(),
    );

    // Narrowing replaces the set rather than adding to it.
    const narrowed = await setScope(admin, personId, {
      kind: 'facilities',
      facilityIds: [activeFacilityId],
    });
    expect(narrowed.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: [activeFacilityId],
    });
    expect(await scopeRows(personId)).toEqual([activeFacilityId]);

    const restored = await setScope(admin, personId, { kind: 'district' });
    expect(restored.facilityScope).toEqual({ kind: 'district' });
    expect(await scopeKind(personId)).toBe('district');
    expect(await scopeRows(personId)).toEqual([]);
  });

  test('refuses a facility that does not exist or is inactive, changing nothing', async () => {
    const personId = await persistPerson();
    await setScope(admin, personId, {
      kind: 'facilities',
      facilityIds: [activeFacilityId],
    });

    await expectRefusal(
      setScope(admin, personId, {
        kind: 'facilities',
        facilityIds: [activeFacilityId, randomUUID()],
      }),
      400,
      'A selected facility does not exist.',
    );
    await expectRefusal(
      setScope(admin, personId, {
        kind: 'facilities',
        facilityIds: [inactiveFacilityId],
      }),
      400,
      'A selected facility is inactive.',
    );
    // The refused writes rolled back: the earlier limit still stands.
    expect(await scopeKind(personId)).toBe('facilities');
    expect(await scopeRows(personId)).toEqual([activeFacilityId]);
  });

  test('refuses to limit an administrator, who could not undo it', async () => {
    const personId = await persistPerson();
    const [person] = await database()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, personId));
    if (person === undefined) throw new Error('The person vanished.');
    // Administrator is a fact of group membership, not a stored role.
    const groupId = randomUUID();
    await database()
      .insert(groupSources)
      .values({
        id: groupId,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Scope test administrators',
        grantedRole: 'admin',
        active: true,
        googleGroupId: `scope-admins-${groupId.slice(0, 8)}`,
        email: `scope-admins-${groupId.slice(0, 8)}@example.invalid`,
        fixtureKey: null,
      });
    await database().insert(groupMembers).values({
      groupSourceId: groupId,
      email: person.email,
      capturedAt: new Date(),
    });

    await expectRefusal(
      setScope(admin, personId, {
        kind: 'facilities',
        facilityIds: [activeFacilityId],
      }),
      409,
      'An administrator is district-wide. Move them out of the administrator group before limiting where they act.',
    );
    expect(await scopeKind(personId)).toBe('district');
    expect(await scopeRows(personId)).toEqual([]);
    // Saying district-wide again is harmless.
    const unchanged = await setScope(admin, personId, { kind: 'district' });
    expect(unchanged.facilityScope).toEqual({ kind: 'district' });
  });

  test('refuses an unknown person and a non-administrator', async () => {
    await expectRefusal(
      setScope(admin, randomUUID(), { kind: 'district' }),
      404,
      'The person was not found.',
    );

    const staff = session(['staff']);
    await persistSession(staff);
    const personId = await persistPerson();
    await expectRefusal(
      setScope(staff, personId, {
        kind: 'facilities',
        facilityIds: [activeFacilityId],
      }),
      403,
      'District administrator access is required.',
    );
    expect(await scopeKind(personId)).toBe('district');
    expect(await scopeRows(personId)).toEqual([]);
  });

  test('admits an address once, lists it, and revokes it, keeping the record', async () => {
    const store = createDrizzleAdminCapabilityStore(database(), admin);
    const email = `Reviewer-${randomUUID().slice(0, 8)}@Example.invalid`;
    const admitted = await executeAdmitAccountCapability({
      authenticated: admin,
      store,
      command: { email, note: 'App store review' },
      metadata: metadata(),
    });
    if (admin.actor.kind !== 'human') throw new Error('human only');
    expect(admitted).toMatchObject({
      email: email.toLowerCase(),
      note: 'App store review',
      admittedByUserId: admin.actor.userId,
      revokedAt: null,
      revokedByUserId: null,
    });

    // One active admission per address, however it is capitalized.
    await expectRefusal(
      executeAdmitAccountCapability({
        authenticated: admin,
        store,
        command: { email: email.toUpperCase() },
        metadata: metadata(),
      }),
      409,
      'That address is already admitted.',
    );

    const listed = await executeListAdmittedAccountsCapability({
      authenticated: admin,
      store,
      query: { includeRevoked: false },
    });
    expect(listed.items.map(({ id }) => id)).toContain(admitted.id);

    const revoked = await executeRevokeAdmittedAccountCapability({
      authenticated: admin,
      store,
      command: { admittedAccountId: admitted.id },
      metadata: metadata(),
    });
    expect(revoked.id).toBe(admitted.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedByUserId).toBe(admin.actor.userId);

    // The record stays; it is simply no longer current.
    const current = await executeListAdmittedAccountsCapability({
      authenticated: admin,
      store,
      query: { includeRevoked: false },
    });
    expect(current.items.map(({ id }) => id)).not.toContain(admitted.id);
    const all = await executeListAdmittedAccountsCapability({
      authenticated: admin,
      store,
      query: { includeRevoked: true },
    });
    expect(all.items.map(({ id }) => id)).toContain(admitted.id);

    await expectRefusal(
      executeRevokeAdmittedAccountCapability({
        authenticated: admin,
        store,
        command: { admittedAccountId: admitted.id },
        metadata: metadata(),
      }),
      409,
      'That admission was already revoked.',
    );
    await expectRefusal(
      executeRevokeAdmittedAccountCapability({
        authenticated: admin,
        store,
        command: { admittedAccountId: randomUUID() },
        metadata: metadata(),
      }),
      404,
      'The admission was not found.',
    );
    // Revoked, the address may be admitted again as a new record.
    const again = await executeAdmitAccountCapability({
      authenticated: admin,
      store,
      command: { email },
      metadata: metadata(),
    });
    expect(again.id).not.toBe(admitted.id);
    expect(again.note).toBe('');
  });

  test('the production application role can admit and revoke', async () => {
    // Deployed code runs as psd_eoc_app, not the migration owner. Migration
    // 0053 granted INSERT on the columns the capability sets, but the query
    // builder names every column and writes DEFAULT for the rest, and
    // PostgreSQL wants INSERT on every named column: production refused the
    // first admission with 42501. This runs the same statements as that role.
    if (ownedDatabase === undefined) throw new Error('no owned database');
    const roleConnection = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 1,
    });
    if (roleConnection.driver !== 'postgres') throw new Error('postgres');
    try {
      await roleConnection.db.execute(sql`set role psd_eoc_app`);
      const store = createDrizzleAdminCapabilityStore(roleConnection.db, admin);
      const email = `role-${randomUUID().slice(0, 8)}@example.invalid`;
      const admitted = await executeAdmitAccountCapability({
        authenticated: admin,
        store,
        command: { email, note: 'Admitted as the application role' },
        metadata: metadata(),
      });
      expect(admitted.email).toBe(email);
      const revoked = await executeRevokeAdmittedAccountCapability({
        authenticated: admin,
        store,
        command: { admittedAccountId: admitted.id },
        metadata: metadata(),
      });
      expect(revoked.revokedAt).not.toBeNull();
      const listed = await executeListAdmittedAccountsCapability({
        authenticated: admin,
        store,
        query: { includeRevoked: true },
      });
      expect(listed.items.map(({ id }) => id)).toContain(admitted.id);
    } finally {
      await roleConnection.close();
    }
  });

  test('only a district administrator on the web may admit or revoke', async () => {
    const staff = session(['staff']);
    await persistSession(staff);
    const store = createDrizzleAdminCapabilityStore(database(), staff);
    await expectRefusal(
      executeAdmitAccountCapability({
        authenticated: staff,
        store,
        command: { email: 'someone@example.invalid' },
        metadata: metadata(),
      }),
      403,
      'District administrator access is required.',
    );
    await expectRefusal(
      executeListAdmittedAccountsCapability({
        authenticated: staff,
        store,
        query: { includeRevoked: true },
      }),
      403,
      'District administrator access is required.',
    );
  });

  test('the staff list shows who a group admits and who was admitted directly', async () => {
    const store = createDrizzleAdminCapabilityStore(database(), admin);
    const groupPerson = await persistPerson();
    const admittedPerson = await persistPerson();
    const nobody = await persistPerson();
    const stalePerson = await persistPerson();
    const [groupRow] = await database()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, groupPerson));
    const [admittedRow] = await database()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, admittedPerson));
    if (groupRow === undefined || admittedRow === undefined) {
      throw new Error('The people vanished.');
    }
    const groupId = randomUUID();
    await database()
      .insert(groupSources)
      .values({
        id: groupId,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Listing test administrators',
        grantedRole: 'admin',
        active: true,
        googleGroupId: `listing-admins-${groupId.slice(0, 8)}`,
        email: `listing-admins-${groupId.slice(0, 8)}@example.invalid`,
        fixtureKey: null,
      });
    const [staleRow] = await database()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, stalePerson));
    if (staleRow === undefined) throw new Error('The person vanished.');
    await database()
      .insert(groupMembers)
      .values([
        {
          groupSourceId: groupId,
          email: groupRow.email,
          capturedAt: new Date(),
        },
        // Read two days ago and never since: sign-in would refuse this
        // person as stale, so the page does not show them as an admin.
        {
          groupSourceId: groupId,
          email: staleRow.email,
          capturedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
        },
      ]);
    const admitted = await executeAdmitAccountCapability({
      authenticated: admin,
      store,
      command: { email: admittedRow.email },
      metadata: metadata(),
    });
    // The hash-chained audit names the admission row.
    const [auditRow] = await database()
      .select({
        targetKind: securityAuditEntries.targetKind,
        targetId: securityAuditEntries.targetId,
      })
      .from(securityAuditEntries)
      .where(eq(securityAuditEntries.targetId, admitted.id));
    expect(auditRow).toEqual({
      targetKind: 'configuration',
      targetId: admitted.id,
    });

    const page = await executeListUsersCapability({
      authenticated: admin,
      store,
      query: {
        facilityId: null,
        includeDisabled: true,
        cursor: null,
        limit: 100,
      },
    });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    // Roles on the page are what admits the person, not a stored grant:
    // nothing stores roles any more, and a list of stored grants was empty.
    expect(byId.get(groupPerson)?.roles).toEqual(['admin']);
    expect(byId.get(admittedPerson)?.roles).toEqual(['staff']);
    expect(byId.has(nobody)).toBe(false);
    expect(byId.has(stalePerson)).toBe(false);
  });
});

function metadata() {
  return {
    idempotencyKey: `admission-${randomUUID()}`,
    requestId: randomUUID(),
    now: new Date(),
  };
}
