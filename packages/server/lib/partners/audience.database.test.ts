import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  PARTNER_AUDIENCE_MAX_RECIPIENTS,
  type ActivationPreview,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  activationPreviewPartners,
  activationPreviews,
  channelConfigurations,
  connectivityEpochs,
  deviceEnrollments,
  eventTypes,
  eventTypeVersions,
  groupSources,
  humanConfirmationActions,
  humanConfirmationRecords,
  lifecycleConsequencePreviews,
  notificationIntentChannels,
  notificationIntents,
  outbox,
  partnerAdmissionEndings,
  partnerAdmissions,
  partnerAlertSettings,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshotSources,
  rosterSnapshots,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  sessions,
  users,
} from '../../db/schema';
import { facilityRows, seedDatabase } from '../../db/seed';
import { migrateDatabase } from '../../drizzle/migrate';
import type { TrustedCapabilityInvocation } from '../capabilities/engine';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '../capabilities/events';
import {
  createDrizzleJournalCapabilityStore,
  executeJournalCapability,
} from '../capabilities/journal';
import {
  createDrizzleStartFlowCapabilityStore,
  loadActivationPreview,
} from '../capabilities/start';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../testing/database';
import {
  loadEventPartnerAudience,
  resolvePartnerAudience,
  type PartnerAudienceQuery,
} from './audience';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const DAY = 24 * 60 * 60 * 1_000;
const OPERATOR = Object.freeze({
  kind: 'human' as const,
  userId: randomUUID(),
  sessionId: randomUUID(),
});
const CONNECTIVITY_EPOCH_ID = randomUUID();
const DISTRICT_SCOPE = Object.freeze({
  facilityScope: { kind: 'district' as const },
});
const NORTH = facilityRows[0]!.id;
const WILDLIFE_THREAT = '00000000-0000-4000-8000-000000000700';
const EARTHQUAKE_THREAT = '00000000-0000-4000-8000-000000000701';

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
const admissions = { active: '', second: '', expired: '', ended: '' };
const versions = { lockdownReal: '', lockdownDrill: '', evacuationReal: '' };

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

async function versionId(key: string): Promise<string> {
  const [row] = await database()
    .select({ id: eventTypeVersions.id })
    .from(eventTypeVersions)
    .innerJoin(eventTypes, eq(eventTypes.id, eventTypeVersions.eventTypeId))
    .where(eq(eventTypes.key, key))
    .limit(1);
  if (row === undefined) throw new Error(`The seed has no ${key} version.`);
  return row.id;
}

async function admit(email: string, admittedAt: Date): Promise<string> {
  const [row] = await database()
    .insert(partnerAdmissions)
    .values({
      email,
      displayName: 'Synthetic Responder',
      agency: 'Synthetic Fire District',
      invitedByUserId: OPERATOR.userId,
      admittedAt,
    })
    .returning({ id: partnerAdmissions.id });
  if (row === undefined) throw new Error('The admission was not written.');
  return row.id;
}

/** Admits partners and publishes a one-person staff roster at North. */
async function seedFixture(now: Date): Promise<void> {
  const created = new Date(now.getTime() - 60_000);
  const deviceEnrollmentId = randomUUID();
  await database().insert(users).values({
    id: OPERATOR.userId,
    googleSubject: 'partner-audience-operator',
    identityIssuer: 'https://accounts.google.com',
    identitySubject: 'partner-audience-operator',
    email: 'partner-audience-operator@district.example.invalid',
    displayName: 'Synthetic Partner Audience Operator',
    facilityScopeKind: 'district',
    createdAt: created,
  });
  await database().insert(deviceEnrollments).values({
    id: deviceEnrollmentId,
    userId: OPERATOR.userId,
    platform: 'web',
    unlockMethod: 'secure-session-cookie',
    installationId: 'partner-audience-operator-device',
    enrolledAt: created,
    lastSeenAt: now,
  });
  await database()
    .insert(sessions)
    .values({
      id: OPERATOR.sessionId,
      userId: OPERATOR.userId,
      deviceEnrollmentId,
      membershipSnapshotId: null,
      membershipValidUntil: new Date(now.getTime() + 60 * 60_000),
      membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60_000),
      createdAt: created,
      expiresAt: new Date(now.getTime() + DAY),
    });
  await database().insert(connectivityEpochs).values({
    id: CONNECTIVITY_EPOCH_ID,
    sessionId: OPERATOR.sessionId,
    establishedAt: now,
  });

  admissions.active = await admit('first@agency.example.invalid', now);
  admissions.second = await admit('second@agency.example.invalid', now);
  admissions.expired = await admit(
    'expired@agency.example.invalid',
    new Date(now.getTime() - 366 * DAY),
  );
  admissions.ended = await admit('ended@agency.example.invalid', now);
  await database().insert(partnerAdmissionEndings).values({
    partnerAdmissionId: admissions.ended,
    reason: 'disabled',
    endedByUserId: OPERATOR.userId,
    endedAt: now,
  });

  const configurationId = randomUUID();
  const snapshotId = randomUUID();
  const recipientId = randomUUID();
  const sourceId = randomUUID();
  const groupRef = {
    population: 'staff' as const,
    groupSourceId: sourceId,
    groupSourceKind: 'google-group' as const,
    groupPurpose: 'building' as const,
  };
  await database().transaction(async (transaction) => {
    await transaction.insert(groupSources).values({
      id: sourceId,
      kind: 'google-group',
      purpose: 'building',
      facilityId: NORTH,
      displayName: 'Synthetic partner audience staff group',
      active: true,
      googleGroupId: 'synthetic-partner-audience-group',
      email: 'partner-audience-group@example.invalid',
      createdAt: created,
    });
    await transaction.insert(rosterSourceConfigurations).values({
      id: configurationId,
      version: 1,
      population: 'staff',
      createdAt: created,
    });
    await transaction.insert(rosterSourceConfigurationFacilities).values({
      configurationId,
      configurationVersion: 1,
      facilityId: NORTH,
    });
    await transaction.insert(rosterSourceConfigurationGroups).values({
      configurationId,
      configurationVersion: 1,
      ...groupRef,
    });
  });
  await database().transaction(async (transaction) => {
    await transaction.insert(rosterSnapshots).values({
      id: snapshotId,
      version: 1,
      population: 'staff',
      complete: true,
      sourceConfigurationId: configurationId,
      sourceConfigurationVersion: 1,
      syncStartedAt: created,
      capturedAt: created,
    });
    await transaction.insert(rosterSnapshotFacilities).values({
      rosterSnapshotId: snapshotId,
      facilityId: NORTH,
    });
    await transaction.insert(rosterSnapshotSources).values([
      { rosterSnapshotId: snapshotId, ...groupRef, completionKind: 'expected' },
      {
        rosterSnapshotId: snapshotId,
        ...groupRef,
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(rosterRecipients).values({
      id: recipientId,
      rosterSnapshotId: snapshotId,
      population: 'staff',
      googleSubject: 'partner-audience-staff-target',
      displayName: 'Synthetic Staff Target',
    });
    await transaction.insert(rosterRecipientGroupSources).values({
      rosterSnapshotId: snapshotId,
      recipientId,
      ...groupRef,
    });
    await transaction.insert(rosterEndpoints).values([
      {
        id: randomUUID(),
        rosterSnapshotId: snapshotId,
        recipientId,
        population: 'staff',
        channel: 'push',
        status: 'active',
        capturedAt: created,
        platform: 'ios',
        provider: 'expo',
        serviceEnvironment: 'production',
        token: 'synthetic-unroutable:partner-audience',
        email: null,
        phoneNumber: null,
      },
      {
        id: randomUUID(),
        rosterSnapshotId: snapshotId,
        recipientId,
        population: 'staff',
        channel: 'email',
        status: 'active',
        capturedAt: created,
        platform: null,
        token: null,
        email: 'partner-audience-staff@example.invalid',
        phoneNumber: null,
      },
    ]);
  });
  await database()
    .update(channelConfigurations)
    .set({ enabled: true, changedAt: now })
    .where(
      inArray(channelConfigurations.integrationId, [
        'mobile-push',
        'ses-email',
      ]),
    );
}

function query(
  overrides: Partial<PartnerAudienceQuery> = {},
): PartnerAudienceQuery {
  return {
    kind: 'incident',
    templateMode: 'real',
    rosterPopulation: 'staff',
    facilityIsolated: false,
    eventTypeVersionId: versions.lockdownReal,
    threatId: WILDLIFE_THREAT,
    now: new Date(),
    ...overrides,
  };
}

async function saveSettings(
  responseFamilyKeys: readonly string[],
  excludedThreatKeys: readonly string[],
): Promise<void> {
  // Written directly: a stored key can outlive the catalog entry it named,
  // which the settings page itself would refuse to save.
  const [current] = await database()
    .select({
      id: partnerAlertSettings.id,
      version: partnerAlertSettings.version,
    })
    .from(partnerAlertSettings)
    .orderBy(sql`${partnerAlertSettings.version} desc`)
    .limit(1);
  await database()
    .insert(partnerAlertSettings)
    .values({
      version: (current?.version ?? 0) + 1,
      responseFamilyKeys: [...responseFamilyKeys],
      excludedThreatKeys: [...excludedThreatKeys],
      supersedesVersionId: current?.id ?? null,
      createdByUserId: OPERATOR.userId,
      createdAt: new Date(),
    });
}

async function createPreview(
  input: Readonly<{
    templateMode: 'real' | 'drill';
    eventTypeVersionId: string;
  }>,
): Promise<ActivationPreview> {
  return createDrizzleStartFlowCapabilityStore(database()).transaction(
    (transaction) =>
      transaction.createActivationPreview(
        {
          facilityId: NORTH,
          kind: input.templateMode === 'real' ? 'incident' : 'drill',
          templateMode: input.templateMode,
          eventTypeVersion: {
            id: input.eventTypeVersionId,
            templateMode: input.templateMode,
          },
          rosterPopulation: 'staff',
          threatId: WILDLIFE_THREAT,
          threatDetail: null,
          responseDetail: null,
        },
        OPERATOR,
        new Date(),
      ),
  );
}

async function confirm(
  capabilityId: 'start-event' | 'all-clear-event',
  actionIds: readonly (
    'start-real-incident' | 'send-real-notification' | 'all-clear'
  )[],
  consequenceDigest: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await database()
    .insert(humanConfirmationRecords)
    .values({
      id,
      capabilityId,
      connectivityEpochId: CONNECTIVITY_EPOCH_ID,
      confirmedByUserId: OPERATOR.userId,
      confirmedWithSessionId: OPERATOR.sessionId,
      consequenceDigest,
      issuedAt: new Date(now - 1_000),
      expiresAt: new Date(now + 3 * 60_000),
      status: 'issued',
      consumedAt: null,
      consumedForRequestId: null,
      expiredAt: null,
    });
  await database()
    .insert(humanConfirmationActions)
    .values(actionIds.map((actionId) => ({ confirmationId: id, actionId })));
  return id;
}

function invocation(
  idempotencyKey: string,
  humanConfirmationId: string | null,
): TrustedCapabilityInvocation {
  return {
    actor: OPERATOR,
    source: 'web',
    scope: DISTRICT_SCOPE,
    requestId: randomUUID(),
    serverTime: new Date(),
    connectivityEpochId: CONNECTIVITY_EPOCH_ID,
    mutation: {
      idempotencyKey,
      transport: {
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      },
      humanConfirmationId,
    },
  };
}

async function intentsForRequest(requestId: string) {
  return database()
    .select({
      id: notificationIntents.id,
      purpose: notificationIntents.purpose,
      rosterPopulation: notificationIntents.rosterPopulation,
      authorization: notificationIntents.authorization,
    })
    .from(notificationIntents)
    .where(eq(notificationIntents.requestId, requestId))
    .orderBy(asc(notificationIntents.rosterPopulation));
}

async function expectRefused(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    expect(cause?.code ?? (error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected the database to refuse with ${code}.`);
}

describeWithDatabase('partner audience at activation planning (#597)', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) throw new Error('no database');
    ownedDatabase = await createDisposableDatabase(
      'psd_eoc_partner_audience',
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
    versions.lockdownReal = await versionId('lockdown');
    versions.lockdownDrill = await versionId('lockdown-drill');
    versions.evacuationReal = await versionId('evacuation');
    await seedFixture(new Date());
  });

  afterAll(async () => {
    await closeAndDropDisposableDatabase(connection?.close, ownedDatabase);
  });

  test('a live lockdown reaches every admitted, unexpired, unended partner', async () => {
    expect(await resolvePartnerAudience(database(), query())).toEqual(
      [admissions.active, admissions.second].sort(),
    );
  });

  test('drills, tests, isolated sites, and unselected responses reach no partner', async () => {
    for (const overrides of [
      {
        kind: 'drill',
        templateMode: 'drill',
        eventTypeVersionId: versions.lockdownDrill,
      },
      {
        kind: 'test',
        templateMode: 'drill',
        rosterPopulation: 'synthetic',
      },
      { facilityIsolated: true },
      // Evacuation is not a default partner response.
      { eventTypeVersionId: versions.evacuationReal },
    ] as const) {
      expect(
        await resolvePartnerAudience(database(), query(overrides)),
      ).toEqual([]);
    }
  });

  test('a lockdown preview counts its partners, signs the count, and pins who they are', async () => {
    const preview = await createPreview({
      templateMode: 'real',
      eventTypeVersionId: versions.lockdownReal,
    });
    expect(preview.partnerRecipientCount).toBe(2);
    expect(preview.recipientCount).toBe(1);
    const pinned = await database()
      .select({ id: activationPreviewPartners.partnerAdmissionId })
      .from(activationPreviewPartners)
      .where(eq(activationPreviewPartners.activationPreviewId, preview.id))
      .orderBy(asc(activationPreviewPartners.partnerAdmissionId));
    expect(pinned.map((row) => row.id)).toEqual(
      [admissions.active, admissions.second].sort(),
    );
    expect(await loadActivationPreview(database(), preview.id)).toEqual(
      preview,
    );

    const drill = await createPreview({
      templateMode: 'drill',
      eventTypeVersionId: versions.lockdownDrill,
    });
    expect(drill.partnerRecipientCount).toBe(0);
    expect(
      await database()
        .select()
        .from(activationPreviewPartners)
        .where(eq(activationPreviewPartners.activationPreviewId, drill.id)),
    ).toEqual([]);
  });

  test('the confirmed request records the partner slice, and its all-clear reaches exactly that set', async () => {
    const preview = await createPreview({
      templateMode: 'real',
      eventTypeVersionId: versions.lockdownReal,
    });
    const eventStore = createDrizzleEventCapabilityStore(database());
    const startInvocation = invocation(
      `partner-audience-start-${randomUUID()}`,
      await confirm(
        'start-event',
        ['start-real-incident', 'send-real-notification'],
        preview.consequenceDigest,
      ),
    );
    const started = await executeEventCapability(
      'start-event',
      {
        source: 'activation-preview',
        activationPreviewId: preview.id,
        activeEventDecision: {
          decision: 'start-new',
          activeEventIdsSeen: preview.activeEventIds,
        },
      },
      startInvocation,
      eventStore,
    );
    const eventId = started.event.id;

    const activation = await intentsForRequest(startInvocation.requestId);
    expect(
      activation.map(({ purpose, rosterPopulation }) => ({
        purpose,
        rosterPopulation,
      })),
    ).toEqual([
      { purpose: 'activation', rosterPopulation: 'staff' },
      { purpose: 'activation', rosterPopulation: 'partner' },
    ]);
    expect(activation[1]?.authorization).toEqual(activation[0]?.authorization);
    const partnerIntentId = activation[1]!.id;
    const partnerPlan = await database()
      .select({
        channel: notificationIntentChannels.channel,
        endpointCount: notificationIntentChannels.endpointCount,
      })
      .from(notificationIntentChannels)
      .where(eq(notificationIntentChannels.intentId, partnerIntentId))
      .orderBy(asc(notificationIntentChannels.sequence));
    expect(partnerPlan).toEqual([
      { channel: 'push', endpointCount: 0 },
      { channel: 'email', endpointCount: 2 },
    ]);
    const outboxRows = await database()
      .select({
        intentId: outbox.intentId,
        population: outbox.rosterPopulation,
      })
      .from(outbox)
      .where(eq(outbox.requestId, startInvocation.requestId))
      .orderBy(asc(outbox.rosterPopulation));
    expect(outboxRows).toEqual([
      { intentId: activation[0]!.id, population: 'staff' },
      { intentId: partnerIntentId, population: 'partner' },
    ]);
    expect(await loadEventPartnerAudience(database(), eventId)).toEqual(
      [admissions.active, admissions.second].sort(),
    );

    // Ending an admission after activation does not change who the event
    // reached; the all-clear plans the same set (send-time eligibility is a
    // separate boundary).
    await database().insert(partnerAdmissionEndings).values({
      partnerAdmissionId: admissions.second,
      reason: 'disabled',
      endedByUserId: OPERATOR.userId,
      endedAt: new Date(),
    });
    expect(await loadEventPartnerAudience(database(), eventId)).toEqual(
      [admissions.active, admissions.second].sort(),
    );

    const lifecycle = await executeJournalCapability(
      'create-lifecycle-consequence-preview',
      { eventId, purpose: 'all-clear' },
      invocation(`partner-audience-preview-${randomUUID()}`, null),
      createDrizzleJournalCapabilityStore(database()),
    );
    expect(lifecycle.partnerRecipientCount).toBe(2);
    const [storedLifecycle] = await database()
      .select({ count: lifecycleConsequencePreviews.partnerRecipientCount })
      .from(lifecycleConsequencePreviews)
      .where(eq(lifecycleConsequencePreviews.id, lifecycle.id));
    expect(storedLifecycle?.count).toBe(2);

    const allClearInvocation = invocation(
      `partner-audience-all-clear-${randomUUID()}`,
      await confirm(
        'all-clear-event',
        ['all-clear', 'send-real-notification'],
        lifecycle.consequenceDigest,
      ),
    );
    await executeEventCapability(
      'all-clear-event',
      { eventId, lifecyclePreviewId: lifecycle.id },
      allClearInvocation,
      eventStore,
    );
    const allClear = await intentsForRequest(allClearInvocation.requestId);
    expect(
      allClear.map(({ purpose, rosterPopulation }) => ({
        purpose,
        rosterPopulation,
      })),
    ).toEqual([
      { purpose: 'all-clear', rosterPopulation: 'staff' },
      { purpose: 'all-clear', rosterPopulation: 'partner' },
    ]);
    const [allClearPartnerEmail] = await database()
      .select({ endpointCount: notificationIntentChannels.endpointCount })
      .from(notificationIntentChannels)
      .where(
        and(
          eq(notificationIntentChannels.intentId, allClear[1]!.id),
          eq(notificationIntentChannels.channel, 'email'),
        ),
      );
    expect(allClearPartnerEmail?.endpointCount).toBe(2);
  });

  test('an excluded threat, or settings naming only a retired response, reach no partner', async () => {
    await saveSettings(['lockdown'], ['synthetic-wildlife']);
    expect(await resolvePartnerAudience(database(), query())).toEqual([]);
    expect(
      await resolvePartnerAudience(
        database(),
        query({ threatId: EARTHQUAKE_THREAT }),
      ),
    ).toEqual([admissions.active]);

    // A key whose response no longer exists matches nothing.
    await saveSettings(['retired-response'], []);
    expect(await resolvePartnerAudience(database(), query())).toEqual([]);
    const preview = await createPreview({
      templateMode: 'real',
      eventTypeVersionId: versions.lockdownReal,
    });
    expect(preview.partnerRecipientCount).toBe(0);

    await saveSettings(['lockdown', 'modified-lockdown'], []);
  });

  test('the database refuses partners on a drill preview and keeps the pinned set append-only', async () => {
    const drill = await createPreview({
      templateMode: 'drill',
      eventTypeVersionId: versions.lockdownDrill,
    });
    await expectRefused(
      database().insert(activationPreviewPartners).values({
        activationPreviewId: drill.id,
        kind: 'drill',
        templateMode: 'drill',
        rosterPopulation: 'staff',
        partnerAdmissionId: admissions.active,
      }),
      '23514',
    );
    // Claiming live-incident columns for a drill preview fails its anchor.
    await expectRefused(
      database().insert(activationPreviewPartners).values({
        activationPreviewId: drill.id,
        kind: 'incident',
        templateMode: 'real',
        rosterPopulation: 'staff',
        partnerAdmissionId: admissions.active,
      }),
      '23503',
    );
    const [drillRow] = await database()
      .select()
      .from(activationPreviews)
      .where(eq(activationPreviews.id, drill.id));
    await expectRefused(
      database()
        .insert(activationPreviews)
        .values({ ...drillRow!, id: randomUUID(), partnerRecipientCount: 1 }),
      '23514',
    );

    const live = await createPreview({
      templateMode: 'real',
      eventTypeVersionId: versions.lockdownReal,
    });
    await expectRefused(
      database()
        .update(activationPreviewPartners)
        .set({ createdAt: new Date() })
        .where(eq(activationPreviewPartners.activationPreviewId, live.id)),
      '55000',
    );
    await expectRefused(
      database()
        .delete(activationPreviewPartners)
        .where(eq(activationPreviewPartners.activationPreviewId, live.id)),
      '55000',
    );
  });

  test('the production application role can pin and read a preview partner set', async () => {
    if (ownedDatabase === undefined) throw new Error('not migrated');
    const live = await createPreview({
      templateMode: 'real',
      eventTypeVersionId: versions.lockdownReal,
    });
    const extra = await admit('role@agency.example.invalid', new Date());
    const roleConnection = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 1,
    });
    if (roleConnection.driver !== 'postgres') throw new Error('postgres');
    try {
      await roleConnection.db.execute(sql`set role psd_eoc_app`);
      await roleConnection.db.insert(activationPreviewPartners).values({
        activationPreviewId: live.id,
        kind: 'incident',
        templateMode: 'real',
        rosterPopulation: 'staff',
        partnerAdmissionId: extra,
      });
      const visible = await roleConnection.db
        .select({ id: activationPreviewPartners.partnerAdmissionId })
        .from(activationPreviewPartners)
        .where(eq(activationPreviewPartners.activationPreviewId, live.id));
      expect(visible.map((row) => row.id)).toContain(extra);
    } finally {
      await roleConnection.close();
    }
  });

  test('more admitted partners than a preview may pin degrade the partner slice, never the staff activation', async () => {
    const live = await resolvePartnerAudience(database(), query());
    const extra = PARTNER_AUDIENCE_MAX_RECIPIENTS + 1 - live.length;
    await database()
      .insert(partnerAdmissions)
      .values(
        Array.from({ length: extra }, (_, index) => ({
          email: `bulk-${index}@agency.example.invalid`,
          displayName: 'Synthetic Responder',
          agency: 'Synthetic Fire District',
          invitedByUserId: OPERATOR.userId,
          admittedAt: new Date(),
        })),
      );
    const warnings: string[] = [];
    const capped = await resolvePartnerAudience(database(), query(), (line) =>
      warnings.push(line),
    );
    expect(capped).toHaveLength(PARTNER_AUDIENCE_MAX_RECIPIENTS);
    expect([...capped].sort()).toEqual([...capped]);
    expect(warnings.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'partner-audience-truncated', pinned: 1_200 },
    ]);
    // The staff activation is still planned, with the bounded partner slice.
    const preview = await createPreview({
      templateMode: 'real',
      eventTypeVersionId: versions.lockdownReal,
    });
    expect(preview.recipientCount).toBe(1);
    expect(preview.partnerRecipientCount).toBe(PARTNER_AUDIENCE_MAX_RECIPIENTS);
  });
});
