import { randomBytes, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { IdempotencyPrincipalSchema } from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import { groupMembers, groupSources } from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import {
  createDrizzleInitialWebSessionStore,
  digestWebSessionCredential,
} from './session-cookie';
import { DrizzleSessionStore, SessionService } from './sessions';
import { authorizeSignIn } from './sign-in-authorization';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const ADMIN_GROUP = randomUUID();
const STAFF_GROUP = randomUUID();
const ADMIN_EMAIL = 'round-trip-admin@example.invalid';
const STAFF_EMAIL = 'round-trip-staff@example.invalid';

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) {
    throw new Error('The round-trip integration database is not open.');
  }
  return connection.db;
}

function accessGroup(id: string, role: 'staff' | 'admin', capturedAt: Date) {
  return {
    id,
    kind: 'google-group' as const,
    purpose: 'access' as const,
    facilityId: null,
    displayName: `Round-trip ${role} group`,
    active: true,
    grantedRole: role,
    membersCapturedAt: capturedAt,
    googleGroupId: `provider-round-trip-${role}`,
    email: `round-trip-${role}@example.invalid`,
    fixtureKey: null,
  };
}

/**
 * Signs one person in the way the OIDC callback does, and returns the opaque
 * web credential their browser would carry.
 */
async function signIn(
  email: string,
  now: Date,
): Promise<Readonly<{ credential: string; roles: readonly string[] }>> {
  const googleSubject = `round-trip-subject-${email}`;
  const authorization = await authorizeSignIn(database(), {
    googleSubject,
    email,
    displayName: `Round-trip ${email}`,
    checkedAt: now,
  });
  if (!authorization.authorized) {
    throw new Error(`Sign-in was refused: ${authorization.refusal}`);
  }
  const credential = randomBytes(48).toString('base64url');
  const responseDigest = digestWebSessionCredential(randomUUID());
  const principal = IdempotencyPrincipalSchema.parse({
    kind: 'oidc-callback',
    subjectDigest: digestWebSessionCredential(googleSubject),
    responseDigest,
  });
  await createDrizzleInitialWebSessionStore(database()).persist({
    user: authorization.user,
    membership: {
      groupSourceIds: [...authorization.groupSourceIds],
      admittedAccountId: authorization.admittedAccountId,
      capturedAt: now,
    },
    device: {
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `round-trip-${randomUUID()}`,
    },
    credentialDigest: digestWebSessionCredential(credential),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000),
    membershipValidUntil: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    membershipGraceUntil: new Date(now.getTime() + 72 * 60 * 60 * 1_000),
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digestWebSessionCredential(JSON.stringify(principal)),
      requestDigest: digestWebSessionCredential(`round-trip:${randomUUID()}`),
    },
  });
  return Object.freeze({
    credential,
    roles: authorization.user.roles,
  });
}

describeWithDatabase('sign-in to session round trip', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required.');
    }
    disposable = await createDisposableDatabase('psd_eoc_roundtrip', baseUrl);
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 4,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('The direct PostgreSQL driver is required.');
    }
    connection = opened;
    await migrateDatabase(opened);
  });

  afterAll(async () => {
    const opened = connection;
    const ownedDatabase = disposable;
    connection = undefined;
    disposable = undefined;
    await closeAndDropDisposableDatabase(
      opened === undefined ? undefined : () => opened.close(),
      ownedDatabase,
    );
  });

  test('a session keeps the roles the signer’s groups granted', async () => {
    const now = new Date();
    const capturedAt = new Date(now.getTime() - 60_000);
    await database()
      .insert(groupSources)
      .values([
        accessGroup(ADMIN_GROUP, 'admin', capturedAt),
        accessGroup(STAFF_GROUP, 'staff', capturedAt),
      ]);
    await database()
      .insert(groupMembers)
      .values([
        { groupSourceId: ADMIN_GROUP, email: ADMIN_EMAIL, capturedAt },
        { groupSourceId: STAFF_GROUP, email: STAFF_EMAIL, capturedAt },
      ]);

    const signedIn = await signIn(ADMIN_EMAIL, now);
    expect([...signedIn.roles]).toEqual(['admin']);

    const service = new SessionService(new DrizzleSessionStore(database()));
    const authenticated = await service.authenticate(
      signedIn.credential,
      'web',
    );
    // The roles a request sees must be the roles the groups grant. Reading a
    // separate stored grant here is what let a session outlive, or never
    // receive, the authority its groups decided.
    expect([...authenticated.roles]).toEqual(['admin']);
  });

  test('a staff-group signer never receives administrator authority', async () => {
    const now = new Date();
    const signedIn = await signIn(STAFF_EMAIL, now);
    expect([...signedIn.roles]).toEqual(['staff']);

    const service = new SessionService(new DrizzleSessionStore(database()));
    const authenticated = await service.authenticate(
      signedIn.credential,
      'web',
    );
    expect([...authenticated.roles]).toEqual(['staff']);
  });
});
