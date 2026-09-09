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
} from '../../../db/client';
import {
  deviceEnrollments,
  facilities,
  groupMembers,
  groupSources,
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
import { executeSetUserFacilityScopeCapability } from './capabilities';

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
});
