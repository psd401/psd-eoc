import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { IdempotencyPrincipalSchema } from '@psd-eoc/contracts';
import { and, desc, eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  groupSources,
  userRoles,
  users,
} from '../../../db/schema';
import {
  createDrizzleInitialWebSessionStore,
  digestWebSessionCredential,
} from '../../../lib/auth/session-cookie';
import { createOwnedAdminPlaywrightDatabase } from './playwright-database';
import {
  requireInheritedAdminPlaywrightRunContext,
  type AdminPlaywrightRunContext,
} from './playwright-run';

const ACCESS_GROUP_ID = '26000000-0000-4000-8000-000000000110';
const MEMBER_USER_ID = '26000000-0000-4000-8000-000000000120';
const MEMBER_SUBJECT = 'mock-google-subject-issue26-admin';
const runFile = promisify(execFile);

interface AccessFixture {
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly syncStartedAt: Date;
  readonly capturedAt: Date;
  readonly userCreatedAt: Date;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function prepareDatabase(
  context: AdminPlaywrightRunContext,
): Promise<void> {
  const environment = {
    ...process.env,
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: context.databaseUrl,
  };
  await runFile('bun', ['drizzle/migrate.ts'], {
    cwd: context.serverDirectory,
    env: environment,
  });
  await runFile('bun', ['db/seed.ts'], {
    cwd: context.serverDirectory,
    env: environment,
  });
}

async function prepareAccessEvidence(
  connection: PostgresDatabaseConnection,
): Promise<AccessFixture> {
  const database = connection.db;
  const [latestVersionSnapshot] = await database
    .select({ version: accessMembershipSnapshots.version })
    .from(accessMembershipSnapshots)
    .orderBy(desc(accessMembershipSnapshots.version))
    .limit(1);
  const [latestCapturedSnapshot] = await database
    .select({ capturedAt: accessMembershipSnapshots.capturedAt })
    .from(accessMembershipSnapshots)
    .orderBy(desc(accessMembershipSnapshots.capturedAt))
    .limit(1);
  const now = new Date(
    Math.max(
      Date.now(),
      (latestCapturedSnapshot?.capturedAt.getTime() ?? 0) + 3_000,
    ),
  );
  const syncStartedAt = new Date(now.getTime() - 2_000);
  const capturedAt = new Date(now.getTime() - 1_000);
  const snapshotId = randomUUID();
  const version = (latestVersionSnapshot?.version ?? 0) + 1;

  return database.transaction(async (transaction) => {
    await transaction
      .insert(groupSources)
      .values({
        id: ACCESS_GROUP_ID,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Synthetic Issue 26 Playwright Access',
        active: true,
        googleGroupId: 'synthetic-issue26-playwright-access',
        email: 'synthetic-issue26-playwright-access@psd401.net',
        fixtureKey: null,
        createdAt: now,
      })
      .onConflictDoNothing();
    await transaction
      .insert(users)
      .values({
        id: MEMBER_USER_ID,
        googleSubject: MEMBER_SUBJECT,
        email: 'synthetic-issue26-playwright-admin@psd401.net',
        displayName: 'Synthetic Issue 26 Administrator',
        facilityScopeKind: 'district',
        createdAt: now,
        disabledAt: null,
      })
      .onConflictDoNothing();
    await transaction
      .insert(userRoles)
      .values({ userId: MEMBER_USER_ID, role: 'staff' })
      .onConflictDoNothing();
    await transaction.insert(accessMembershipSnapshots).values({
      id: snapshotId,
      version,
      complete: true,
      syncStartedAt,
      capturedAt,
    });
    const activeAccessGroups = await transaction
      .select({ id: groupSources.id })
      .from(groupSources)
      .where(
        and(
          eq(groupSources.active, true),
          eq(groupSources.kind, 'google-group'),
          eq(groupSources.purpose, 'access'),
        ),
      );
    await transaction.insert(accessMembershipSnapshotGroups).values(
      activeAccessGroups.flatMap(({ id }) => [
        {
          snapshotId,
          groupSourceId: id,
          groupSourceKind: 'google-group' as const,
          groupPurpose: 'access' as const,
          completionKind: 'expected' as const,
        },
        {
          snapshotId,
          groupSourceId: id,
          groupSourceKind: 'google-group' as const,
          groupPurpose: 'access' as const,
          completionKind: 'completed' as const,
        },
      ]),
    );
    await transaction.insert(accessMembershipMembers).values({
      snapshotId,
      userId: MEMBER_USER_ID,
      googleSubject: MEMBER_SUBJECT,
      facilityScopeKind: 'district',
    });
    await transaction.insert(accessMembershipMemberGroups).values({
      snapshotId,
      userId: MEMBER_USER_ID,
      groupSourceId: ACCESS_GROUP_ID,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    });
    const [persistedUser] = await transaction
      .select({ createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, MEMBER_USER_ID))
      .limit(1);
    if (persistedUser === undefined) {
      throw new Error('The synthetic administrator was not retained.');
    }
    return {
      snapshotId,
      snapshotVersion: version,
      syncStartedAt,
      capturedAt,
      userCreatedAt: persistedUser.createdAt,
    };
  });
}

async function issueSyntheticAdministratorSession(
  connection: PostgresDatabaseConnection,
  fixture: AccessFixture,
  storageStatePath: string,
): Promise<void> {
  const now = new Date(
    Math.max(Date.now(), fixture.capturedAt.getTime() + 1_000),
  );
  const credential = randomBytes(48).toString('base64url');
  const responseDigest = digest(randomUUID());
  const principal = IdempotencyPrincipalSchema.parse({
    kind: 'oidc-callback',
    subjectDigest: digest(MEMBER_SUBJECT),
    responseDigest,
  });
  const result = await createDrizzleInitialWebSessionStore(
    connection.db,
  ).persist({
    user: {
      id: MEMBER_USER_ID,
      googleSubject: MEMBER_SUBJECT,
      email: 'synthetic-issue26-playwright-admin@psd401.net',
      displayName: 'Synthetic Issue 26 Administrator',
      roles: ['staff'],
      facilityScope: { kind: 'district' },
      createdAt: fixture.userCreatedAt.toISOString(),
      disabledAt: null,
    },
    membershipSnapshot: {
      id: fixture.snapshotId,
      version: fixture.snapshotVersion,
      complete: true,
      syncStartedAt: fixture.syncStartedAt.toISOString(),
      capturedAt: fixture.capturedAt.toISOString(),
    },
    membershipMember: {
      userId: MEMBER_USER_ID,
      googleSubject: MEMBER_SUBJECT,
      accessGroupSourceRefs: [
        {
          id: ACCESS_GROUP_ID,
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
        },
      ],
      facilityScope: { kind: 'district' },
    },
    device: {
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `synthetic-issue26-playwright-${randomUUID()}`,
    },
    credentialDigest: digestWebSessionCredential(credential),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000),
    membershipValidUntil: new Date(
      fixture.capturedAt.getTime() + 24 * 60 * 60 * 1_000,
    ),
    membershipGraceUntil: new Date(
      fixture.capturedAt.getTime() + 72 * 60 * 60 * 1_000,
    ),
    grantBootstrapAdmin: true,
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digest(JSON.stringify(principal)),
      requestDigest: digest(`synthetic-issue26-playwright:${randomUUID()}`),
    },
  });
  if (!result.user.roles.includes('admin')) {
    throw new Error(
      'The synthetic Playwright session is not an administrator.',
    );
  }
  const expires = Math.floor(
    new Date(result.session.expiresAt).getTime() / 1_000,
  );
  await mkdir(dirname(storageStatePath), { mode: 0o700, recursive: true });
  await writeFile(
    storageStatePath,
    JSON.stringify({
      cookies: [
        {
          name: '__Host-psd-eoc-session',
          value: credential,
          domain: 'localhost',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: '__Host-psd-eoc-csrf',
          value: randomBytes(32).toString('base64url'),
          domain: 'localhost',
          path: '/',
          expires,
          httpOnly: false,
          secure: true,
          sameSite: 'Strict',
        },
      ],
      origins: [],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

export default async function globalSetup(): Promise<void> {
  const context = requireInheritedAdminPlaywrightRunContext();
  await createOwnedAdminPlaywrightDatabase(context);
  await prepareDatabase(context);
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: context.databaseUrl,
    maxConnections: 2,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('Administration Playwright requires PostgreSQL.');
  }
  try {
    const fixture = await prepareAccessEvidence(connection);
    await issueSyntheticAdministratorSession(
      connection,
      fixture,
      context.storageStatePath,
    );
  } finally {
    await connection.close();
  }
}
