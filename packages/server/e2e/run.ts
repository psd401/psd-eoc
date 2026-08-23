import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  IdempotencyPrincipalSchema,
  UserSchema,
  type Role,
} from '@psd-eoc/contracts';
import { eq, inArray } from 'drizzle-orm';

import {
  createDrizzleStartFlowCapabilityStore,
  executeStartFlowCapability,
} from '../app/(app)/start/_lib/capabilities';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../db/client';
import { seedDatabase } from '../db/seed';
import {
  channelConfigurations,
  groupMembers,
  groupSources,
  userFacilityScopes,
  users,
} from '../db/schema';
import { migrateDatabase } from '../drizzle/migrate';
import { createCsrfToken } from '../lib/auth/middleware';
import {
  createDrizzleInitialWebSessionStore,
  digestWebSessionCredential,
} from '../lib/auth/session-cookie';
import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
} from '../lib/auth/sessions';
import { authorizeSignIn } from '../lib/auth/sign-in-authorization';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '../lib/capabilities/events';
import type { TrustedCapabilityInvocation } from '../lib/capabilities/engine';
import { createDisposableDatabase } from '../lib/testing/database';

const SERVER_ROOT = resolve(import.meta.dir, '..');
const REPOSITORY_ROOT = resolve(SERVER_ROOT, '../..');
const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const INHERITED_RUNTIME_ENVIRONMENT_KEYS = [
  'BUN_INSTALL',
  'CI',
  'FORCE_COLOR',
  'HOME',
  'PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
] as const;

/** Keeps provider configuration and ambient credentials out of the test app. */
function inheritedRuntimeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    INHERITED_RUNTIME_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

interface IssuedIdentity {
  readonly userId: string;
  readonly actor: Extract<
    TrustedCapabilityInvocation['actor'],
    { kind: 'human' }
  >;
  readonly connectivityEpochId: string;
}

function accessGroup(
  id: string,
  role: Role,
  capturedAt: Date,
): typeof groupSources.$inferInsert {
  return {
    id,
    kind: 'google-group',
    purpose: 'access',
    facilityId: null,
    displayName: `Synthetic ${role} browser group`,
    active: true,
    grantedRole: role,
    membersCapturedAt: capturedAt,
    googleGroupId: `synthetic-browser-${role}-${id}`,
    email: `synthetic-browser-${role}-${id}@example.invalid`,
    fixtureKey: null,
    createdAt: capturedAt,
  };
}

async function issueIdentity(
  connection: PostgresDatabaseConnection,
  input: Readonly<{
    email: string;
    displayName: string;
    groupSourceId: string;
    facilityIds: readonly string[] | null;
    now: Date;
    statePath: string;
  }>,
): Promise<IssuedIdentity> {
  const googleSubject = `synthetic-browser-${input.email}`;
  const authorization = await authorizeSignIn(connection.db, {
    googleSubject,
    email: input.email,
    displayName: input.displayName,
    checkedAt: input.now,
  });
  if (!authorization.authorized) {
    throw new Error(`Synthetic sign-in was refused: ${authorization.refusal}`);
  }

  const facilityScope =
    input.facilityIds === null
      ? ({ kind: 'district' } as const)
      : ({ kind: 'facilities', facilityIds: input.facilityIds } as const);
  if (input.facilityIds !== null) {
    await connection.db
      .update(users)
      .set({ facilityScopeKind: 'facilities' })
      .where(eq(users.id, authorization.user.id));
    await connection.db.insert(userFacilityScopes).values(
      input.facilityIds.map((facilityId) => ({
        userId: authorization.user.id,
        facilityId,
      })),
    );
  }

  const user = UserSchema.parse({
    ...authorization.user,
    facilityScope,
  });
  const credential = randomBytes(48).toString('base64url');
  const responseDigest = digestWebSessionCredential(randomUUID());
  const principal = IdempotencyPrincipalSchema.parse({
    kind: 'oidc-callback',
    subjectDigest: digestWebSessionCredential(googleSubject),
    responseDigest,
  });
  const result = await createDrizzleInitialWebSessionStore(
    connection.db,
  ).persist({
    user,
    membership: {
      groupSourceIds: [input.groupSourceId],
      capturedAt: input.now,
    },
    device: {
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `synthetic-browser-${randomUUID()}`,
    },
    credentialDigest: digestWebSessionCredential(credential),
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + 90 * DAY_MILLISECONDS),
    membershipValidUntil: new Date(input.now.getTime() + DAY_MILLISECONDS),
    membershipGraceUntil: new Date(input.now.getTime() + 3 * DAY_MILLISECONDS),
    requestId: randomUUID(),
    idempotency: {
      key: `oidc:${responseDigest}`,
      principal,
      principalDigest: digestWebSessionCredential(JSON.stringify(principal)),
      requestDigest: digestWebSessionCredential(
        `synthetic-browser:${randomUUID()}`,
      ),
    },
  });
  const expires = Math.floor(Date.parse(result.session.expiresAt) / 1_000);
  await writeFile(
    input.statePath,
    JSON.stringify({
      cookies: [
        {
          name: WEB_SESSION_COOKIE_NAME,
          value: credential,
          domain: 'localhost',
          path: '/',
          expires,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: WEB_CSRF_COOKIE_NAME,
          value: createCsrfToken(),
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
  return {
    userId: result.user.id,
    actor: {
      kind: 'human',
      userId: result.user.id,
      sessionId: result.session.id,
    },
    connectivityEpochId: result.connectivityEpoch.id,
  };
}

function invocation(
  identity: IssuedIdentity,
  mutation: TrustedCapabilityInvocation['mutation'],
): TrustedCapabilityInvocation {
  return {
    actor: identity.actor,
    source: 'web',
    scope: { facilityScope: { kind: 'district' } },
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: identity.connectivityEpochId,
    mutation,
  };
}

async function createSyntheticDrill(
  connection: PostgresDatabaseConnection,
  identity: IssuedIdentity,
): Promise<string> {
  await connection.db
    .update(channelConfigurations)
    .set({ enabled: true, changedAt: new Date() })
    .where(
      inArray(channelConfigurations.integrationId, ['expo-push', 'ses-email']),
    );
  const preview = await executeStartFlowCapability(
    'create-activation-preview',
    {
      facilityId: SYNTHETIC_FACILITY_ID,
      kind: 'drill',
      templateMode: 'drill',
      eventTypeVersion: {
        id: SYNTHETIC_DRILL_VERSION_ID,
        templateMode: 'drill',
      },
      rosterPopulation: 'synthetic',
    },
    invocation(identity, null),
    createDrizzleStartFlowCapabilityStore(connection.db),
  );
  if (
    preview.sendReadiness !== 'ready' ||
    preview.channels.some(
      ({ integrationStatus }) => integrationStatus.label !== 'mocked',
    )
  ) {
    throw new Error(
      `Synthetic drill preview was not safely ready: ${preview.blockingReasonCodes.join(', ')}`,
    );
  }
  const result = await executeEventCapability(
    'start-event',
    {
      source: 'activation-preview',
      activationPreviewId: preview.id,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: preview.activeEventIds,
      },
    },
    invocation(identity, {
      idempotencyKey: `synthetic-browser-start-${randomUUID()}`,
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId: null,
    }),
    createDrizzleEventCapabilityStore(connection.db),
  );
  if (
    result.event.kind !== 'drill' ||
    result.event.rosterPopulation !== 'synthetic' ||
    result.event.status !== 'active'
  ) {
    throw new Error('Synthetic setup created an unsafe or inactive event.');
  }
  return result.event.id;
}

async function main(): Promise<void> {
  const disposable = await createDisposableDatabase('issue_340');
  let stateDirectory: string | undefined;
  let connection: PostgresDatabaseConnection | undefined;
  try {
    const createdStateDirectory = await mkdtemp(join(tmpdir(), 'psd-eoc-340-'));
    stateDirectory = createdStateDirectory;
    const committedEvidenceDirectory = join(
      REPOSITORY_ROOT,
      '.verification',
      'issue-340',
    );
    const evidenceDirectory =
      process.env.PSD_EOC_E2E_UPDATE_EVIDENCE === 'true'
        ? committedEvidenceDirectory
        : join(createdStateDirectory, 'evidence');
    const artifactDirectory = join(
      committedEvidenceDirectory,
      'playwright-artifacts',
    );
    await mkdir(committedEvidenceDirectory, { recursive: true });
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 6,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('Issue 340 browser acceptance requires PostgreSQL.');
    }
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);

    const now = new Date();
    const adminGroupId = randomUUID();
    const staffGroupId = randomUUID();
    await opened.db
      .insert(groupSources)
      .values([
        accessGroup(adminGroupId, 'admin', now),
        accessGroup(staffGroupId, 'staff', now),
      ]);
    const identities = [
      {
        email: 'district-admin@example.invalid',
        displayName: 'Synthetic District Administrator',
        groupSourceId: adminGroupId,
        facilityIds: null,
        stateName: 'district-admin.json',
      },
      {
        email: 'facility-admin@example.invalid',
        displayName: 'Synthetic Facility Administrator',
        groupSourceId: adminGroupId,
        facilityIds: [SYNTHETIC_FACILITY_ID],
        stateName: 'facility-admin.json',
      },
      {
        email: 'facility-staff@example.invalid',
        displayName: 'Synthetic Facility Staff',
        groupSourceId: staffGroupId,
        facilityIds: [SYNTHETIC_FACILITY_ID],
        stateName: 'facility-staff.json',
      },
    ] as const;
    await opened.db.insert(groupMembers).values(
      identities.map(({ email, groupSourceId }) => ({
        groupSourceId,
        email,
        capturedAt: now,
      })),
    );
    const issued: IssuedIdentity[] = [];
    // Session issuance appends to the global security journal. Keep setup
    // serial so the harness never creates an artificial audit-chain race.
    for (const identity of identities) {
      issued.push(
        await issueIdentity(opened, {
          ...identity,
          now,
          statePath: join(createdStateDirectory, identity.stateName),
        }),
      );
    }
    const districtAdministrator = issued[0];
    if (districtAdministrator === undefined) {
      throw new Error('The synthetic district administrator was not issued.');
    }
    const eventId = await createSyntheticDrill(opened, districtAdministrator);
    await writeFile(
      join(createdStateDirectory, 'fixture.json'),
      JSON.stringify({
        eventId,
        districtAdministratorUserId: districtAdministrator.userId,
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    await opened.close();
    connection = undefined;

    const port =
      20_000 + (Number.parseInt(randomUUID().slice(0, 4), 16) % 20_000);
    const child = Bun.spawn(
      [
        'bunx',
        'playwright',
        'test',
        '--config',
        join(import.meta.dir, 'playwright.config.ts'),
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...inheritedRuntimeEnvironment(),
          AWS_CONFIG_FILE: join(createdStateDirectory, 'no-aws-config'),
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_SHARED_CREDENTIALS_FILE: join(
            createdStateDirectory,
            'no-aws-credentials',
          ),
          DATABASE_DRIVER: 'postgres',
          DATABASE_URL: disposable.url,
          TEST_DATABASE_URL: disposable.url,
          PSD_EOC_E2E_APP_PORT: String(port),
          PSD_EOC_E2E_ARTIFACT_DIR: artifactDirectory,
          PSD_EOC_E2E_STATE_DIR: createdStateDirectory,
          PSD_EOC_E2E_EVIDENCE_DIR: evidenceDirectory,
          PSD_EOC_ORGANIZATION_NAME: 'Synthetic Example School District',
          PSD_EOC_PRODUCT_OWNER_USER_ID: districtAdministrator.userId,
          GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
        },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exitCode = exitCode;
    else await rm(artifactDirectory, { recursive: true, force: true });
  } finally {
    try {
      await connection?.close();
    } finally {
      try {
        await disposable.drop();
      } finally {
        if (stateDirectory !== undefined) {
          await rm(stateDirectory, { recursive: true, force: true });
        }
      }
    }
  }
}

await main();
