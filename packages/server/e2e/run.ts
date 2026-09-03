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
} from '../lib/capabilities/start';
import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../db/client';
import { seedDatabase } from '../db/seed';
import {
  channelConfigurations,
  events,
  groupMembers,
  groupSources,
  mediaRecords,
  mediaUploadIntents,
  rosterSnapshots,
  rosterSourceConfigurations,
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
const SYNTHETIC_OTHER_FACILITY_ID = '00000000-0000-4000-8000-000000000002';
const SYNTHETIC_REAL_VERSION_ID = '00000000-0000-4000-8000-000000000200';
const SYNTHETIC_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';
/** The seed's first active threat, `Synthetic wildlife`. */
const SYNTHETIC_THREAT_ID = '00000000-0000-4000-8000-000000000700';
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
      inArray(channelConfigurations.integrationId, [
        'mobile-push',
        'ses-email',
      ]),
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
      threatId: SYNTHETIC_THREAT_ID,
      threatDetail: null,
      responseDetail: null,
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

interface SyntheticRecordsFixture {
  readonly northIncidentId: string;
  readonly northDrillId: string;
  readonly northTestId: string;
  readonly southIncidentId: string;
}

async function seedIssue32ReadyMedia(
  connection: PostgresDatabaseConnection,
  eventId: string,
  now: Date,
): Promise<Readonly<{ mediaId: string; uploadIntentId: string }>> {
  const uploadIntentId = randomUUID();
  const mediaId = randomUUID();
  await connection.db.insert(mediaUploadIntents).values({
    id: uploadIntentId,
    eventId,
    facilityId: SYNTHETIC_FACILITY_ID,
    budgetPrincipalDigest: 'e'.repeat(64),
    budgetPrincipalAttributed: true,
    byteLength: 68,
    contentSha256: 'c'.repeat(64),
    declaredContentType: 'image/png',
    storageKey: `quarantine/${eventId}/${uploadIntentId}`,
    status: 'completed',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
  });
  await connection.db.insert(mediaRecords).values({
    id: mediaId,
    uploadIntentId,
    eventId,
    status: 'ready',
    detectedContentType: 'image/png',
    sanitizedByteLength: 68,
    sanitizedContentSha256: 'd'.repeat(64),
    storageKey: `ready/${eventId}/${mediaId}`,
    malwareScan: 'clean',
    exifStripped: true,
    createdAt: now,
  });
  return Object.freeze({ mediaId, uploadIntentId });
}

/**
 * Seeds retained record fixtures without invoking a real-event capability.
 * The incident row is inert, closed, and exists only inside the disposable
 * PostgreSQL database used by this browser run.
 */
async function seedSyntheticRecords(
  connection: PostgresDatabaseConnection,
  identity: IssuedIdentity,
  now: Date,
): Promise<SyntheticRecordsFixture> {
  const staffRosterConfigurationId = randomUUID();
  const staffRosterSnapshotId = randomUUID();
  await connection.db.insert(rosterSourceConfigurations).values({
    id: staffRosterConfigurationId,
    version: 1,
    population: 'staff',
    createdAt: new Date(now.getTime() - 4 * DAY_MILLISECONDS),
  });
  await connection.db.insert(rosterSnapshots).values({
    id: staffRosterSnapshotId,
    version: 1,
    population: 'staff',
    complete: true,
    sourceConfigurationId: staffRosterConfigurationId,
    sourceConfigurationVersion: 1,
    syncStartedAt: new Date(now.getTime() - 4 * DAY_MILLISECONDS),
    capturedAt: new Date(now.getTime() - 3 * DAY_MILLISECONDS),
  });

  const fixture: SyntheticRecordsFixture = Object.freeze({
    northIncidentId: randomUUID(),
    northDrillId: randomUUID(),
    northTestId: randomUUID(),
    southIncidentId: randomUUID(),
  });
  const actor = identity.actor;
  const activatedAt = (hoursAgo: number) =>
    new Date(now.getTime() - hoursAgo * 60 * 60 * 1_000);
  const closedEvent = (
    id: string,
    facilityId: string,
    kind: 'incident' | 'drill' | 'test',
    hoursAgo: number,
  ) => {
    const activated = activatedAt(hoursAgo);
    const allClear = new Date(activated.getTime() + 12 * 60 * 1_000);
    const templateMode =
      kind === 'incident' ? ('real' as const) : ('drill' as const);
    const authorization =
      kind === 'incident'
        ? {
            kind: 'human-confirmed' as const,
            activationPreviewId: randomUUID(),
            preparedActivationId: null,
            confirmationId: randomUUID(),
            consequenceDigest: 'd'.repeat(64),
            requestId: randomUUID(),
          }
        : {
            kind: 'synthetic-training' as const,
            activationPreviewId: randomUUID(),
            consequenceDigest: 'a'.repeat(64),
            requestId: randomUUID(),
          };
    return {
      id,
      facilityId,
      kind,
      templateMode,
      eventTypeVersionId:
        kind === 'incident'
          ? SYNTHETIC_REAL_VERSION_ID
          : SYNTHETIC_DRILL_VERSION_ID,
      status: 'closed' as const,
      rosterSnapshotId:
        kind === 'incident'
          ? staffRosterSnapshotId
          : '00000000-0000-4000-8000-000000000041',
      rosterPopulation:
        kind === 'incident' ? ('staff' as const) : ('synthetic' as const),
      createdBy: actor,
      createdAt: new Date(activated.getTime() - 60_000),
      activatedAt: activated,
      allClearAt: allClear,
      reactivatedAt: null,
      closedAt: new Date(allClear.getTime() + 60_000),
      correctionOfEventId: null,
      correctionReason: null,
      activationAuthorization: authorization,
    };
  };

  await connection.db
    .insert(events)
    .values([
      closedEvent(
        fixture.northIncidentId,
        SYNTHETIC_FACILITY_ID,
        'incident',
        28,
      ),
      closedEvent(fixture.northDrillId, SYNTHETIC_FACILITY_ID, 'drill', 26),
      closedEvent(fixture.northTestId, SYNTHETIC_FACILITY_ID, 'test', 24),
      closedEvent(
        fixture.southIncidentId,
        SYNTHETIC_OTHER_FACILITY_ID,
        'incident',
        22,
      ),
    ]);
  return fixture;
}

async function main(): Promise<void> {
  const serverMode = process.env.PSD_EOC_E2E_SERVER_MODE ?? 'development';
  if (serverMode !== 'development' && serverMode !== 'production') {
    throw new Error(
      'PSD_EOC_E2E_SERVER_MODE must be development or production.',
    );
  }
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
    const committedIssue32EvidenceDirectory = join(
      REPOSITORY_ROOT,
      '.verification',
      'issue-32',
    );
    const committedIssue277EvidenceDirectory = join(
      REPOSITORY_ROOT,
      '.verification',
      'issue-277',
    );
    const committedIssue341EvidenceDirectory = join(
      REPOSITORY_ROOT,
      '.verification',
      'issue-341',
    );
    const committedIssue344EvidenceDirectory = join(
      REPOSITORY_ROOT,
      '.verification',
      'issue-344',
    );
    const committedIssue279EvidenceDirectory = join(
      REPOSITORY_ROOT,
      '.verification',
      'issue-279',
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
    const issue341EvidenceDirectory =
      process.env.PSD_EOC_E2E_UPDATE_EVIDENCE === 'true'
        ? committedIssue341EvidenceDirectory
        : join(createdStateDirectory, 'evidence-341');
    await mkdir(issue341EvidenceDirectory, { recursive: true });
    const issue277EvidenceDirectory =
      process.env.PSD_EOC_E2E_UPDATE_EVIDENCE === 'true'
        ? committedIssue277EvidenceDirectory
        : join(createdStateDirectory, 'evidence-277');
    await mkdir(issue277EvidenceDirectory, { recursive: true });
    const issue344EvidenceDirectory =
      process.env.PSD_EOC_E2E_UPDATE_EVIDENCE === 'true'
        ? committedIssue344EvidenceDirectory
        : join(createdStateDirectory, 'evidence-344');
    await mkdir(issue344EvidenceDirectory, { recursive: true });
    const issue279EvidenceDirectory =
      process.env.PSD_EOC_E2E_UPDATE_EVIDENCE === 'true'
        ? committedIssue279EvidenceDirectory
        : join(createdStateDirectory, 'evidence-279');
    await mkdir(issue279EvidenceDirectory, { recursive: true });
    const issue32EvidenceDirectory =
      process.env.PSD_EOC_E2E_UPDATE_EVIDENCE === 'true'
        ? committedIssue32EvidenceDirectory
        : join(createdStateDirectory, 'evidence-32');
    await mkdir(issue32EvidenceDirectory, { recursive: true });
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
    const issue344EventId = await createSyntheticDrill(
      opened,
      districtAdministrator,
    );
    const issue32EventId = await createSyntheticDrill(
      opened,
      districtAdministrator,
    );
    const issue32Media = await seedIssue32ReadyMedia(
      opened,
      issue32EventId,
      now,
    );
    const records = await seedSyntheticRecords(
      opened,
      districtAdministrator,
      now,
    );
    await writeFile(
      join(createdStateDirectory, 'fixture.json'),
      JSON.stringify({
        eventId,
        issue344EventId,
        issue32EventId,
        issue32Media,
        districtAdministratorUserId: districtAdministrator.userId,
        records,
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
          PSD_EOC_E2E_ISSUE_277_EVIDENCE_DIR: issue277EvidenceDirectory,
          PSD_EOC_E2E_ISSUE_32_EVIDENCE_DIR: issue32EvidenceDirectory,
          PSD_EOC_E2E_ISSUE_279_EVIDENCE_DIR: issue279EvidenceDirectory,
          PSD_EOC_E2E_ISSUE_341_EVIDENCE_DIR: issue341EvidenceDirectory,
          PSD_EOC_E2E_ISSUE_344_EVIDENCE_DIR: issue344EvidenceDirectory,
          PSD_EOC_E2E_SERVER_MODE: serverMode,
          PSD_EOC_ORGANIZATION_NAME: 'Synthetic Example School District',
          PSD_EOC_PRIVACY_CONTACT_URL:
            'https://www.example.invalid/privacy-contact',
          PSD_EOC_DISPLAY_TIME_ZONE: 'America/New_York',
          PSD_EOC_EMAIL_WORKER_ENABLED: 'true',
          PSD_EOC_PRODUCT_OWNER_USER_ID: districtAdministrator.userId,
          PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE:
            'synthetic-e2e-ses-verification-reference',
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
