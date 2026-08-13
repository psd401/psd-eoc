import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ActivationAuthorizationSchema,
  ActorSchema,
  FanoutControlEffectiveStateSchema,
  FanoutControlRecordSchema,
  IdempotencyPrincipalSchema,
  type Actor,
  type SessionEstablishmentResult,
  type StartEventResult,
} from '@psd-eoc/contracts';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  activationPreviews,
  audienceConfigurations,
  audienceTargets,
  channelConfigurations,
  events,
  groupSources,
  journalEntries,
  notificationIntents,
  outbox,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  userRoles,
  users,
} from '../../../../db/schema';
import { createCsrfToken } from '../../../../lib/auth/middleware';
import {
  createDrizzleInitialWebSessionStore,
  digestWebSessionCredential,
} from '../../../../lib/auth/session-cookie';
import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
} from '../../../../lib/auth/sessions';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '../../../../lib/capabilities/events';
import type { TrustedCapabilityInvocation } from '../../../../lib/capabilities/engine';
import {
  appendFanoutControlRecord,
  assertCurrentNotificationFanoutEnabled,
  readFanoutControlEffectiveState,
} from '../../../../lib/notify/fanout-control';
import {
  createDrizzleStartFlowCapabilityStore,
  executeStartFlowCapability,
} from '../_lib/capabilities';
import {
  PLAYWRIGHT_IDS,
  StartFlowPlaywrightFixtureSchema,
  type StartFlowPlaywrightFixture,
} from './playwright.fixtures';
import {
  dropStartFlowPlaywrightDatabase,
  recreateStartFlowPlaywrightDatabase,
} from './playwright-database';
import {
  assertStartFlowPlaywrightArtifactsOwned,
  removeStartFlowPlaywrightArtifacts,
  requireStartFlowPlaywrightRunId,
  startFlowPlaywrightPaths,
} from './playwright-run';

export const START_FLOW_STAFF_ROSTER_VERSION = 2_000_000_015;
export const START_FLOW_STAFF_AUDIENCE_ID =
  '00000000-0000-4000-8000-000000000020';
export const START_FLOW_STAFF_AUDIENCE_VERSION = 2;

const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_SOUTH_FACILITY_ID = '00000000-0000-4000-8000-000000000002';
const SYNTHETIC_NEIGHBORHOOD_ID = '00000000-0000-4000-8000-000000000010';
const SYNTHETIC_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const ACCESS_GROUP_ID = '15000000-0000-4000-8000-000000000110';
const MEMBER_USER_ID = PLAYWRIGHT_IDS.user;
const MEMBER_SUBJECT = 'mock-google-subject-member';
const FIXTURE_TIME = new Date('2026-08-10T18:00:00.000Z');
const REQUIRED_SYNTHETIC_CHANNELS = ['expo-push', 'ses-email'] as const;
const SYNTHETIC_FANOUT_REASON =
  'Synthetic Playwright fixture only; no live provider sends.';
const SYNTHETIC_FANOUT_PRODUCT_OWNER_REFERENCE =
  'synthetic-playwright-po-reference-not-live';
const DAY_MS = 24 * 60 * 60 * 1_000;
const runFile = promisify(execFile);
const serverRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

interface AccessFixture {
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly syncStartedAt: Date;
  readonly capturedAt: Date;
  readonly userCreatedAt: Date;
}

interface BrowserIdentity {
  readonly actor: Extract<Actor, { kind: 'human' }>;
  readonly connectivityEpochId: string;
}

interface FanoutEnabledBrowserIdentity extends BrowserIdentity {
  readonly fanoutControlChangedAt: Date;
  readonly fanoutControlEpochId: string;
  readonly fanoutControlRecordId: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const first = [...left].sort();
  const second = [...right].sort();
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

async function prepareDatabase(databaseUrl: string): Promise<void> {
  const environment = {
    ...process.env,
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: databaseUrl,
  };
  await runFile('bun', ['drizzle/migrate.ts'], {
    cwd: serverRoot,
    env: environment,
  });
  await runFile('bun', ['db/seed.ts'], {
    cwd: serverRoot,
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
        displayName: 'Synthetic Start-flow Playwright Access',
        active: true,
        googleGroupId: 'synthetic-start-flow-playwright-access',
        email: 'synthetic-start-flow-playwright@psd401.net',
        fixtureKey: null,
        createdAt: now,
      })
      .onConflictDoNothing();
    await transaction
      .insert(users)
      .values({
        id: MEMBER_USER_ID,
        googleSubject: MEMBER_SUBJECT,
        email: 'member@psd401.net',
        displayName: 'Synthetic Start-flow Operator',
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
      throw new Error('The synthetic start-flow user was not retained.');
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

async function issueSyntheticStaffSession(
  connection: PostgresDatabaseConnection,
  fixture: AccessFixture,
  storageStatePath: string,
): Promise<BrowserIdentity> {
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
  const result: SessionEstablishmentResult =
    await createDrizzleInitialWebSessionStore(connection.db).persist({
      user: {
        id: MEMBER_USER_ID,
        googleSubject: MEMBER_SUBJECT,
        email: 'member@psd401.net',
        displayName: 'Synthetic Start-flow Operator',
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
        installationId: `synthetic-start-flow-${randomUUID()}`,
      },
      credentialDigest: digestWebSessionCredential(credential),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 90 * DAY_MS),
      membershipValidUntil: new Date(fixture.capturedAt.getTime() + DAY_MS),
      membershipGraceUntil: new Date(fixture.capturedAt.getTime() + 3 * DAY_MS),
      grantBootstrapAdmin: false,
      requestId: randomUUID(),
      idempotency: {
        key: `oidc:${responseDigest}`,
        principal,
        principalDigest: digest(JSON.stringify(principal)),
        requestDigest: digest(`synthetic-start-flow:${randomUUID()}`),
      },
    });
  if (
    !result.user.roles.includes('staff') ||
    result.user.roles.includes('admin')
  ) {
    throw new Error('The synthetic start-flow session is not staff-only.');
  }
  const expires = Math.floor(Date.parse(result.session.expiresAt) / 1_000);
  await writeFile(
    storageStatePath,
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
    actor: {
      kind: 'human',
      userId: result.user.id,
      sessionId: result.session.id,
    },
    connectivityEpochId: result.connectivityEpoch.id,
  };
}

async function enableSyntheticNotificationFanout(
  connection: PostgresDatabaseConnection,
  identity: BrowserIdentity,
): Promise<FanoutEnabledBrowserIdentity> {
  const database = connection.db;
  const initialState = FanoutControlEffectiveStateSchema.parse(
    await readFanoutControlEffectiveState(database),
  );
  if (initialState.kind !== 'missing') {
    throw new Error(
      'The isolated start-flow database unexpectedly has fan-out control history.',
    );
  }
  if (
    initialState.effectiveMode !== 'emergency-disabled' ||
    initialState.currentEpochId !== null ||
    initialState.currentRecord !== null ||
    initialState.reasonCode !== 'CONTROL_STATE_MISSING'
  ) {
    throw new Error('Missing fan-out control did not fail closed.');
  }

  const requestId = randomUUID();
  const changedAt = new Date();
  const appendedRecord = FanoutControlRecordSchema.parse(
    await database.transaction((transaction) =>
      appendFanoutControlRecord({
        database: transaction,
        actor: identity.actor,
        requestId,
        expectedCurrentRecordId: null,
        desiredMode: 'enabled',
        reason: SYNTHETIC_FANOUT_REASON,
        productOwnerApprovalReference: SYNTHETIC_FANOUT_PRODUCT_OWNER_REFERENCE,
        changedAt,
      }),
    ),
  );
  if (appendedRecord.enableEpochId === null) {
    throw new Error('Synthetic fan-out enablement omitted its epoch.');
  }

  const effectiveState = FanoutControlEffectiveStateSchema.parse(
    await readFanoutControlEffectiveState(database),
  );
  const enabledRecord = await database.transaction((transaction) =>
    assertCurrentNotificationFanoutEnabled(transaction),
  );
  if (
    appendedRecord.revision !== 1 ||
    appendedRecord.previousRecordId !== null ||
    appendedRecord.mode !== 'enabled' ||
    appendedRecord.reason !== SYNTHETIC_FANOUT_REASON ||
    appendedRecord.productOwnerApprovalReference !==
      SYNTHETIC_FANOUT_PRODUCT_OWNER_REFERENCE ||
    appendedRecord.changedByUserId !== identity.actor.userId ||
    appendedRecord.changedWithSessionId !== identity.actor.sessionId ||
    appendedRecord.requestId !== requestId ||
    appendedRecord.changedAt !== changedAt.toISOString() ||
    effectiveState.kind !== 'current' ||
    effectiveState.effectiveMode !== 'enabled' ||
    effectiveState.currentEpochId !== appendedRecord.enableEpochId ||
    JSON.stringify(effectiveState.currentRecord) !==
      JSON.stringify(appendedRecord) ||
    enabledRecord.id !== appendedRecord.id ||
    enabledRecord.enableEpochId !== appendedRecord.enableEpochId
  ) {
    throw new Error(
      'Synthetic fan-out control append did not survive exact enabled readback.',
    );
  }

  return {
    ...identity,
    fanoutControlChangedAt: changedAt,
    fanoutControlEpochId: appendedRecord.enableEpochId,
    fanoutControlRecordId: appendedRecord.id,
  };
}

async function prepareStaffRosterEvidence(
  connection: PostgresDatabaseConnection,
): Promise<void> {
  const database = connection.db;
  const staffGroups = [
    {
      id: PLAYWRIGHT_IDS.staffBuildingGroup,
      kind: 'google-group' as const,
      purpose: 'building' as const,
      facilityId: SYNTHETIC_FACILITY_ID,
      displayName: 'Synthetic Browser North Staff',
      googleGroupId: 'synthetic-browser-north',
      email: 'synthetic-browser-north@example.invalid',
    },
    {
      id: PLAYWRIGHT_IDS.staffSouthBuildingGroup,
      kind: 'google-group' as const,
      purpose: 'building' as const,
      facilityId: SYNTHETIC_SOUTH_FACILITY_ID,
      displayName: 'Synthetic Browser South Staff',
      googleGroupId: 'synthetic-browser-south',
      email: 'synthetic-browser-south@example.invalid',
    },
    {
      id: PLAYWRIGHT_IDS.staffOthersGroup,
      kind: 'google-group' as const,
      purpose: 'others' as const,
      facilityId: null,
      displayName: 'Synthetic Browser District Staff',
      googleGroupId: 'synthetic-browser-others',
      email: 'synthetic-browser-others@example.invalid',
    },
  ] as const;

  await database.transaction(async (transaction) => {
    await transaction
      .insert(groupSources)
      .values(
        staffGroups.map((group) => ({
          ...group,
          active: true,
          fixtureKey: null,
          createdAt: FIXTURE_TIME,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurations)
      .values({
        id: PLAYWRIGHT_IDS.staffRosterConfiguration,
        version: 1,
        population: 'staff',
        createdAt: FIXTURE_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationFacilities)
      .values([
        {
          configurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
          configurationVersion: 1,
          facilityId: SYNTHETIC_FACILITY_ID,
        },
        {
          configurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
          configurationVersion: 1,
          facilityId: SYNTHETIC_SOUTH_FACILITY_ID,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationGroups)
      .values(
        staffGroups.map((group) => ({
          configurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
          configurationVersion: 1,
          population: 'staff' as const,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(audienceConfigurations)
      .values({
        id: START_FLOW_STAFF_AUDIENCE_ID,
        facilityId: SYNTHETIC_FACILITY_ID,
        version: START_FLOW_STAFF_AUDIENCE_VERSION,
        createdAt: FIXTURE_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(audienceTargets)
      .values([
        {
          audienceConfigId: START_FLOW_STAFF_AUDIENCE_ID,
          audienceConfigVersion: START_FLOW_STAFF_AUDIENCE_VERSION,
          ordinal: 1,
          targetKind: 'building',
          targetFacilityId: SYNTHETIC_FACILITY_ID,
          neighborhoodId: null,
          neighborhoodVersion: null,
          groupSourceId: null,
        },
        {
          audienceConfigId: START_FLOW_STAFF_AUDIENCE_ID,
          audienceConfigVersion: START_FLOW_STAFF_AUDIENCE_VERSION,
          ordinal: 2,
          targetKind: 'neighborhood',
          targetFacilityId: null,
          neighborhoodId: SYNTHETIC_NEIGHBORHOOD_ID,
          neighborhoodVersion: 1,
          groupSourceId: null,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshots)
      .values({
        id: PLAYWRIGHT_IDS.staffRosterSnapshot,
        version: START_FLOW_STAFF_ROSTER_VERSION,
        population: 'staff',
        complete: true,
        sourceConfigurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
        sourceConfigurationVersion: 1,
        syncStartedAt: FIXTURE_TIME,
        capturedAt: FIXTURE_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotFacilities)
      .values([
        {
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          facilityId: SYNTHETIC_FACILITY_ID,
        },
        {
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          facilityId: SYNTHETIC_SOUTH_FACILITY_ID,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotSources)
      .values(
        staffGroups.flatMap((group) =>
          (['expected', 'completed'] as const).map((completionKind) => ({
            rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
            population: 'staff' as const,
            groupSourceId: group.id,
            groupSourceKind: group.kind,
            groupPurpose: group.purpose,
            completionKind,
          })),
        ),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterRecipients)
      .values([
        {
          id: PLAYWRIGHT_IDS.staffRecipientNorth,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          population: 'staff',
          googleSubject: 'synthetic-browser-staff-north',
          displayName: 'Synthetic Browser North-only Staff',
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientSouth,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          population: 'staff',
          googleSubject: 'synthetic-browser-staff-south',
          displayName: 'Synthetic Browser South-only Staff',
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientOthers,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          population: 'staff',
          googleSubject: 'synthetic-browser-staff-others',
          displayName: 'Synthetic Browser Others-only Staff',
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterRecipientGroupSources)
      .values([
        {
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientNorth,
          population: 'staff',
          groupSourceId: PLAYWRIGHT_IDS.staffBuildingGroup,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        },
        {
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientSouth,
          population: 'staff',
          groupSourceId: PLAYWRIGHT_IDS.staffSouthBuildingGroup,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        },
        {
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientOthers,
          population: 'staff',
          groupSourceId: PLAYWRIGHT_IDS.staffOthersGroup,
          groupSourceKind: 'google-group',
          groupPurpose: 'others',
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterEndpoints)
      .values([
        {
          id: PLAYWRIGHT_IDS.staffRecipientNorthPush,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientNorth,
          population: 'staff',
          channel: 'push',
          status: 'active',
          capturedAt: FIXTURE_TIME,
          platform: 'ios',
          token: 'synthetic-unroutable:browser-staff-north',
          email: null,
          phoneNumber: null,
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientSouthEmail,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientSouth,
          population: 'staff',
          channel: 'email',
          status: 'active',
          capturedAt: FIXTURE_TIME,
          platform: null,
          token: null,
          email: 'synthetic-browser-staff-south@example.invalid',
          phoneNumber: null,
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientOthersPush,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientOthers,
          population: 'staff',
          channel: 'push',
          status: 'active',
          capturedAt: FIXTURE_TIME,
          platform: 'android',
          token: 'synthetic-unroutable:browser-staff-others',
          email: null,
          phoneNumber: null,
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientOthersEmail,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientOthers,
          population: 'staff',
          channel: 'email',
          status: 'active',
          capturedAt: FIXTURE_TIME,
          platform: null,
          token: null,
          email: 'synthetic-browser-staff-others@example.invalid',
          phoneNumber: null,
        },
      ])
      .onConflictDoNothing();
  });
}

function capabilityInvocation(
  identity: FanoutEnabledBrowserIdentity,
  requestId: string,
  mutation: TrustedCapabilityInvocation['mutation'],
): TrustedCapabilityInvocation {
  return {
    actor: identity.actor,
    source: 'web',
    scope: { facilityScope: { kind: 'district' } },
    requestId,
    serverTime: new Date(
      Math.max(Date.now(), identity.fanoutControlChangedAt.getTime() + 1),
    ),
    connectivityEpochId: identity.connectivityEpochId,
    mutation,
  };
}

async function persistedActiveEventEvidence(
  connection: PostgresDatabaseConnection,
  input: Readonly<{
    previewId: string;
    requestId: string;
    result: StartEventResult;
  }>,
): Promise<StartFlowPlaywrightFixture['activeEvents'][number]> {
  const intent = input.result.notificationIntent;
  const activatedAt = input.result.event.activatedAt;
  const authorization = input.result.event.activationAuthorization;
  if (
    intent === null ||
    activatedAt === null ||
    authorization?.kind !== 'synthetic-training' ||
    authorization.activationPreviewId !== input.previewId ||
    authorization.requestId !== input.requestId ||
    input.result.transition.requestId !== input.requestId ||
    intent.requestId !== input.requestId
  ) {
    throw new Error('Canonical synthetic activation provenance is incomplete.');
  }

  const database = connection.db;
  const [previewRow] = await database
    .select({ id: activationPreviews.id })
    .from(activationPreviews)
    .where(eq(activationPreviews.id, input.previewId))
    .limit(1);
  const [eventRow] = await database
    .select({
      id: events.id,
      createdBy: events.createdBy,
      activationAuthorization: events.activationAuthorization,
    })
    .from(events)
    .where(eq(events.id, input.result.event.id))
    .limit(1);
  const persistedJournals = await database
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(eq(journalEntries.eventId, input.result.event.id))
    .orderBy(asc(journalEntries.sequence));
  const persistedIntents = await database
    .select({
      id: notificationIntents.id,
      requestId: notificationIntents.requestId,
    })
    .from(notificationIntents)
    .where(eq(notificationIntents.eventId, input.result.event.id));
  const persistedOutbox = await database
    .select({
      id: outbox.id,
      intentId: outbox.intentId,
      requestId: outbox.requestId,
      status: outbox.status,
      publishedAt: outbox.publishedAt,
    })
    .from(outbox)
    .where(eq(outbox.eventId, input.result.event.id));
  const journalEntryIds = input.result.journalEntries.map((entry) => entry.id);
  const persistedActor = ActorSchema.safeParse(eventRow?.createdBy);
  const persistedAuthorization = ActivationAuthorizationSchema.safeParse(
    eventRow?.activationAuthorization,
  );
  const resultActor = input.result.event.createdBy;
  const failures = [
    previewRow?.id === input.previewId ? null : 'preview',
    eventRow?.id === input.result.event.id ? null : 'event',
    persistedActor.success &&
    persistedActor.data.kind === 'human' &&
    resultActor.kind === 'human' &&
    persistedActor.data.userId === resultActor.userId &&
    persistedActor.data.sessionId === resultActor.sessionId
      ? null
      : 'actor',
    persistedAuthorization.success &&
    persistedAuthorization.data.kind === 'synthetic-training' &&
    persistedAuthorization.data.activationPreviewId === input.previewId &&
    persistedAuthorization.data.consequenceDigest ===
      authorization.consequenceDigest &&
    persistedAuthorization.data.requestId === input.requestId
      ? null
      : 'authorization',
    sameStrings(
      persistedJournals.map((entry) => entry.id),
      journalEntryIds,
    )
      ? null
      : 'journals',
    persistedIntents.length === 1 &&
    persistedIntents[0]?.id === intent.id &&
    persistedIntents[0]?.requestId === input.requestId
      ? null
      : 'intent',
    persistedOutbox.length === 1 &&
    persistedOutbox[0]?.intentId === intent.id &&
    persistedOutbox[0]?.requestId === input.requestId &&
    persistedOutbox[0]?.status === 'pending' &&
    persistedOutbox[0]?.publishedAt === null
      ? null
      : 'outbox',
  ].filter((failure): failure is string => failure !== null);
  const [persistedOutboxRecord] = persistedOutbox;
  if (failures.length > 0 || persistedOutboxRecord === undefined) {
    throw new Error(
      `Canonical synthetic activation was not atomically grounded: ${failures.join(',')}.`,
    );
  }

  return {
    id: input.result.event.id,
    activatedAt,
    previewId: input.previewId,
    requestId: input.requestId,
    journalEntryIds,
    notificationIntentId: intent.id,
    outboxId: persistedOutboxRecord.id,
  };
}

async function prepareCanonicalActiveEvents(
  connection: PostgresDatabaseConnection,
  identity: FanoutEnabledBrowserIdentity,
): Promise<StartFlowPlaywrightFixture['activeEvents']> {
  const database = connection.db;
  const originalConfigurations = await database
    .select({
      integrationId: channelConfigurations.integrationId,
      enabled: channelConfigurations.enabled,
      changedAt: channelConfigurations.changedAt,
    })
    .from(channelConfigurations)
    .where(
      inArray(channelConfigurations.integrationId, REQUIRED_SYNTHETIC_CHANNELS),
    );
  if (originalConfigurations.length !== REQUIRED_SYNTHETIC_CHANNELS.length) {
    throw new Error(
      'Synthetic push/email channel configuration is incomplete.',
    );
  }
  await database
    .update(channelConfigurations)
    .set({ enabled: true, changedAt: new Date() })
    .where(
      inArray(channelConfigurations.integrationId, REQUIRED_SYNTHETIC_CHANNELS),
    );

  const previewStore = createDrizzleStartFlowCapabilityStore(database);
  const eventStore = createDrizzleEventCapabilityStore(database);
  const activeEvents: Array<
    StartFlowPlaywrightFixture['activeEvents'][number]
  > = [];
  try {
    for (let index = 0; index < 2; index += 1) {
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
        capabilityInvocation(identity, randomUUID(), null),
        previewStore,
      );
      if (
        preview.sendReadiness !== 'ready' ||
        preview.channels.some(
          (channel) => channel.integrationStatus.label !== 'mocked',
        ) ||
        !sameStrings(
          preview.activeEventIds,
          activeEvents.map((event) => event.id),
        )
      ) {
        throw new Error(
          'Synthetic activation preview is not current, mocked, and ready.',
        );
      }
      const requestId = randomUUID();
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
        capabilityInvocation(identity, requestId, {
          idempotencyKey: `synthetic-start-flow-${randomUUID()}`,
          transport: {
            kind: 'web-interactive',
            method: 'POST',
            interaction: 'explicit-user-submit',
            csrfVerified: true,
          },
          humanConfirmationId: null,
        }),
        eventStore,
      );
      activeEvents.push(
        await persistedActiveEventEvidence(connection, {
          previewId: preview.id,
          requestId,
          result,
        }),
      );
    }
  } finally {
    await database.transaction(async (transaction) => {
      for (const configuration of originalConfigurations) {
        await transaction
          .update(channelConfigurations)
          .set({
            enabled: configuration.enabled,
            changedAt: configuration.changedAt,
          })
          .where(
            eq(
              channelConfigurations.integrationId,
              configuration.integrationId,
            ),
          );
      }
    });
  }

  if (
    activeEvents.length !== 2 ||
    new Set(
      activeEvents.flatMap((event) => [
        event.id,
        event.previewId,
        event.requestId,
        ...event.journalEntryIds,
        event.notificationIntentId,
        event.outboxId,
      ]),
    ).size !== 16
  ) {
    throw new Error('Canonical active-event provenance is not distinct.');
  }
  const [first, second] = activeEvents;
  if (first === undefined || second === undefined) {
    throw new Error('Canonical active-event evidence is incomplete.');
  }
  return [first, second];
}

export default async function prepareStartFlowBrowserSession(): Promise<void> {
  const runId = requireStartFlowPlaywrightRunId();
  const paths = startFlowPlaywrightPaths(runId);
  const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
  let databaseMayExist = false;
  let connection: ReturnType<typeof createDatabaseClient> | null = null;

  try {
    await assertStartFlowPlaywrightArtifactsOwned(runId);
    databaseMayExist = true;
    const databaseUrl = await recreateStartFlowPlaywrightDatabase(
      baseDatabaseUrl,
      runId,
    );
    await prepareDatabase(databaseUrl);
    const created = createDatabaseClient({
      driver: 'postgres',
      url: databaseUrl,
      maxConnections: 2,
    });
    connection = created;
    if (created.driver !== 'postgres') {
      throw new Error('Start-flow Playwright requires PostgreSQL.');
    }
    const accessFixture = await prepareAccessEvidence(created);
    const authenticatedIdentity = await issueSyntheticStaffSession(
      created,
      accessFixture,
      paths.storageState,
    );
    const identity = await enableSyntheticNotificationFanout(
      created,
      authenticatedIdentity,
    );
    await prepareStaffRosterEvidence(created);
    const activeEvents = await prepareCanonicalActiveEvents(created, identity);
    const fixture = StartFlowPlaywrightFixtureSchema.parse({
      runId,
      actor: identity.actor,
      connectivityEpochId: identity.connectivityEpochId,
      activeEvents,
    });
    await writeFile(paths.fixture, JSON.stringify(fixture), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await created.close();
    connection = null;
  } catch (error) {
    const failures: unknown[] = [error];
    if (connection !== null) {
      try {
        await connection.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (databaseMayExist) {
      try {
        await dropStartFlowPlaywrightDatabase(baseDatabaseUrl, runId);
      } catch (dropError) {
        failures.push(dropError);
      }
    }
    try {
      await removeStartFlowPlaywrightArtifacts(runId);
    } catch (artifactError) {
      failures.push(artifactError);
    }
    if (failures.length === 1) {
      throw error;
    }
    throw new AggregateError(
      failures,
      'Start-flow Playwright setup and exact-run cleanup both failed.',
    );
  }
}
