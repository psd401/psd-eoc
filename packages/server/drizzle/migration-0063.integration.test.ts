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
  DispatchBatchSchema,
  NotificationIntentSchema,
  NotificationOutboxMessageSchema,
} from '@psd-eoc/contracts';
import { eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../db/client';
import { seedDatabase } from '../db/seed';
import {
  channelAttempts,
  deviceEnrollments,
  devicePushTokenRegistrations,
  dispatchBatches,
  endpointStatusRecords,
  events,
  groupSources,
  notificationIntents,
  outbox,
  partnerAdmissions,
  partnerEndpoints,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshotSources,
  rosterSnapshots,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  staffSmsConsents,
  users,
} from '../db/schema';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../lib/testing/database';
import { migrateDatabase } from './migrate';

/**
 * Proofs for `0063_partner_notification_population`: `partner` is a
 * notification population that rides beside the staff intent of a live
 * incident, binds only partner endpoints, and never reaches a drill, a test,
 * an event, or the roster. Every claim runs against a freshly migrated and
 * seeded database, which is also the fresh-database proof of the migration.
 */
setDefaultTimeout(120_000);

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

const GOOGLE = 'https://accounts.google.com';
const PARTNER_ISSUER = 'https://cognito-idp.example.invalid/synthetic-pool';
const FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const REAL_EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000202';
const DRILL_EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const CREATED_AT = new Date(Date.now() - 60_000);
const CAPTURED_AT = new Date(Date.now() - 300_000);
const PARTNER_EMAIL = 'responder@agency.example.invalid';

const ids = Object.freeze({
  staffUser: randomUUID(),
  partnerUser: randomUUID(),
  session: randomUUID(),
  groupSource: randomUUID(),
  rosterConfiguration: randomUUID(),
  snapshot: randomUUID(),
  recipient: randomUUID(),
  staffEmailEndpoint: randomUUID(),
  admission: randomUUID(),
  event: randomUUID(),
  drillEvent: randomUUID(),
  request: randomUUID(),
  staffIntent: randomUUID(),
  partnerIntent: randomUUID(),
  staffOutbox: randomUUID(),
  partnerOutbox: randomUUID(),
  staffBatch: randomUUID(),
  partnerBatch: randomUUID(),
  partnerEmailEndpoint: randomUUID(),
});

const humanActor = Object.freeze({
  kind: 'human' as const,
  userId: ids.staffUser,
  sessionId: ids.session,
});

function activationAuthorization(requestId: string) {
  return Object.freeze({
    kind: 'human-confirmed' as const,
    activationPreviewId: randomUUID(),
    preparedActivationId: null,
    confirmationId: randomUUID(),
    consequenceDigest: 'd'.repeat(64),
    requestId,
  });
}

const authorization = activationAuthorization(ids.request);

function renderedMessage(channel: 'push' | 'email') {
  return channel === 'push'
    ? {
        eventKind: 'incident' as const,
        templateMode: 'real' as const,
        purpose: 'activation' as const,
        classificationMarker: 'INCIDENT' as const,
        channel: 'push' as const,
        title: '[INCIDENT] Synthetic partner population test',
        body: '[INCIDENT] Synthetic test only.',
      }
    : {
        eventKind: 'incident' as const,
        templateMode: 'real' as const,
        purpose: 'activation' as const,
        classificationMarker: 'INCIDENT' as const,
        channel: 'email' as const,
        subject: '[INCIDENT] Synthetic partner population test',
        textBody: '[INCIDENT] Synthetic test only.',
      };
}

const channelPlan = Object.freeze([
  {
    channel: 'push' as const,
    endpointCount: 1,
    renderedMessage: renderedMessage('push'),
    integrationId: 'expo-push',
  },
  {
    channel: 'email' as const,
    endpointCount: 1,
    renderedMessage: renderedMessage('email'),
    integrationId: 'ses-email',
  },
]);

/** The database refusal's code and constraint, wherever the driver nests it. */
function refusal(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    const code = Reflect.get(Object(current), 'code');
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)) {
      const constraint = Reflect.get(Object(current), 'constraint_name');
      return {
        code,
        ...(typeof constraint === 'string' ? { constraint } : {}),
      };
    }
    current = Reflect.get(Object(current), 'cause');
  }
  return {};
}

async function expectRefused(
  operation: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(refusal(caught)).toMatchObject(expected);
}

describeWithDatabase(
  'migration 0063: the partner notification population',
  () => {
    let owned: DisposableDatabase | undefined;
    let connection: PostgresDatabaseConnection | undefined;

    const db = () => {
      if (connection === undefined) throw new Error('not connected');
      return connection.db;
    };

    function intentValues(
      input: Readonly<{
        id: string;
        eventId?: string;
        eventKind?: 'incident' | 'drill';
        templateMode?: 'real' | 'drill';
        eventTypeVersionId?: string;
        rosterPopulation: 'staff' | 'partner';
        requestId?: string;
        authorization?: unknown;
        createdBy?: unknown;
        source?: 'web' | 'agent-rest';
      }>,
    ) {
      return {
        id: input.id,
        eventId: input.eventId ?? ids.event,
        eventKind: input.eventKind ?? ('incident' as const),
        templateMode: input.templateMode ?? ('real' as const),
        purpose: 'activation' as const,
        eventTypeVersionId:
          input.eventTypeVersionId ?? REAL_EVENT_TYPE_VERSION_ID,
        rosterSnapshotId: ids.snapshot,
        rosterPopulation: input.rosterPopulation,
        createdBy: input.createdBy ?? humanActor,
        source: input.source ?? ('web' as const),
        requestId: input.requestId ?? ids.request,
        authorization: input.authorization ?? authorization,
        createdAt: CREATED_AT,
      };
    }

    async function insertSlice(
      population: 'staff' | 'partner',
      intentId: string,
      outboxId: string,
      batchId: string,
    ): Promise<void> {
      const message = NotificationOutboxMessageSchema.parse({
        version: 2,
        facilityId: FACILITY_ID,
        outboxId,
        intentId,
        eventId: ids.event,
        eventKind: 'incident',
        templateMode: 'real',
        purpose: 'activation',
        eventTypeVersion: {
          id: REAL_EVENT_TYPE_VERSION_ID,
          templateMode: 'real',
        },
        rosterSnapshotId: ids.snapshot,
        rosterPopulation: population,
        requestId: ids.request,
        authorization,
        channels: channelPlan,
        createdAt: CREATED_AT.toISOString(),
      });
      await db()
        .insert(notificationIntents)
        .values(intentValues({ id: intentId, rosterPopulation: population }));
      await db().insert(outbox).values({
        id: outboxId,
        messageVersion: 2,
        intentId,
        eventId: ids.event,
        eventKind: 'incident',
        templateMode: 'real',
        purpose: 'activation',
        eventTypeVersionId: REAL_EVENT_TYPE_VERSION_ID,
        rosterSnapshotId: ids.snapshot,
        rosterPopulation: population,
        requestId: ids.request,
        authorization,
        channels: channelPlan,
        message,
        status: 'published',
        attempts: 1,
        availableAt: CREATED_AT,
        lockedUntil: null,
        publishedAt: CREATED_AT,
        failedAt: null,
        lastErrorCode: null,
        createdAt: CREATED_AT,
      });
      await db()
        .insert(dispatchBatches)
        .values({
          id: batchId,
          outboxId,
          intentId,
          eventId: ids.event,
          eventKind: 'incident',
          templateMode: 'real',
          purpose: 'activation',
          eventTypeVersionId: REAL_EVENT_TYPE_VERSION_ID,
          rosterSnapshotId: ids.snapshot,
          rosterPopulation: population,
          requestId: ids.request,
          authorization,
          channel: 'email',
          renderedMessage: renderedMessage('email'),
          integrationId: 'ses-email',
          sequence: 2,
          endpointCount: 1,
          createdAt: CREATED_AT,
        });
    }

    function attemptValues(
      input: Readonly<{
        batchId: string;
        intentId: string;
        population: 'staff' | 'partner';
        recipientId: string;
        endpointId: string;
        attemptNumber?: number;
      }>,
    ) {
      return {
        id: randomUUID(),
        batchId: input.batchId,
        intentId: input.intentId,
        eventId: ids.event,
        eventKind: 'incident' as const,
        templateMode: 'real' as const,
        purpose: 'activation' as const,
        eventTypeVersionId: REAL_EVENT_TYPE_VERSION_ID,
        rosterSnapshotId: ids.snapshot,
        rosterPopulation: input.population,
        recipientId: input.recipientId,
        endpointId: input.endpointId,
        channel: 'email' as const,
        attemptNumber: input.attemptNumber ?? 1,
        attemptedAt: CREATED_AT,
      };
    }

    async function insertPushRegistration(userId: string): Promise<string> {
      const enrollmentId = randomUUID();
      const registrationId = randomUUID();
      await db()
        .insert(deviceEnrollments)
        .values({
          id: enrollmentId,
          userId,
          platform: 'ios',
          unlockMethod: 'biometric',
          installationId: `synthetic-installation-${enrollmentId}`,
          enrolledAt: CAPTURED_AT,
          lastSeenAt: CAPTURED_AT,
        });
      await db()
        .insert(devicePushTokenRegistrations)
        .values({
          id: registrationId,
          deviceEnrollmentId: enrollmentId,
          platform: 'ios',
          token: `ExponentPushToken[synthetic-${registrationId}]`,
          registeredAt: CAPTURED_AT,
        });
      return registrationId;
    }

    async function insertSmsConsent(userId: string): Promise<string> {
      const id = randomUUID();
      await db().insert(staffSmsConsents).values({
        id,
        userId,
        phoneNumber: '+15555550123',
        disclosureVersion: '2026-01-01',
        source: 'web',
        consentedAt: CAPTURED_AT,
      });
      return id;
    }

    beforeAll(async () => {
      if (baseTestDatabaseUrl === undefined) {
        throw new Error('TEST_DATABASE_URL is required.');
      }
      owned = await createDisposableDatabase(
        'psd_eoc_m0063',
        baseTestDatabaseUrl,
      );
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

      await db()
        .insert(users)
        .values([
          {
            id: ids.staffUser,
            googleSubject: `google-${ids.staffUser}`,
            identityIssuer: GOOGLE,
            identitySubject: `google-${ids.staffUser}`,
            email: 'administrator@district.example.invalid',
            displayName: 'Synthetic administrator',
            facilityScopeKind: 'district',
            createdAt: CAPTURED_AT,
          },
          {
            id: ids.partnerUser,
            googleSubject: null,
            identityIssuer: PARTNER_ISSUER,
            identitySubject: `partner-${ids.partnerUser}`,
            email: PARTNER_EMAIL,
            displayName: 'Synthetic responder',
            facilityScopeKind: 'district',
            createdAt: CAPTURED_AT,
          },
        ]);
      await db().insert(partnerAdmissions).values({
        id: ids.admission,
        email: PARTNER_EMAIL,
        displayName: 'Synthetic responder',
        agency: 'Synthetic Fire District',
        invitedByUserId: ids.staffUser,
        admittedAt: CAPTURED_AT,
      });
      await db()
        .insert(groupSources)
        .values({
          id: ids.groupSource,
          kind: 'google-group',
          purpose: 'building',
          facilityId: FACILITY_ID,
          displayName: 'Synthetic partner population staff',
          active: true,
          grantedRole: null,
          membersCapturedAt: CAPTURED_AT,
          googleGroupId: `synthetic-${ids.groupSource}`,
          email: `group-${ids.groupSource}@example.invalid`,
          fixtureKey: null,
          createdAt: CAPTURED_AT,
        });
      await db().transaction(async (transaction) => {
        await transaction.insert(rosterSourceConfigurations).values({
          id: ids.rosterConfiguration,
          version: 1,
          population: 'staff',
          createdAt: CAPTURED_AT,
        });
        await transaction.insert(rosterSourceConfigurationFacilities).values({
          configurationId: ids.rosterConfiguration,
          configurationVersion: 1,
          facilityId: FACILITY_ID,
        });
        await transaction.insert(rosterSourceConfigurationGroups).values({
          configurationId: ids.rosterConfiguration,
          configurationVersion: 1,
          population: 'staff',
          groupSourceId: ids.groupSource,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        });
      });
      // A snapshot is published whole, in one transaction, like a sync does.
      await db().transaction(async (transaction) => {
        await transaction.insert(rosterSnapshots).values({
          id: ids.snapshot,
          version: 1,
          population: 'staff',
          complete: true,
          sourceConfigurationId: ids.rosterConfiguration,
          sourceConfigurationVersion: 1,
          syncStartedAt: CAPTURED_AT,
          capturedAt: CAPTURED_AT,
        });
        await transaction.insert(rosterSnapshotFacilities).values({
          rosterSnapshotId: ids.snapshot,
          facilityId: FACILITY_ID,
        });
        await transaction.insert(rosterSnapshotSources).values(
          (['expected', 'completed'] as const).map((completionKind) => ({
            rosterSnapshotId: ids.snapshot,
            population: 'staff' as const,
            groupSourceId: ids.groupSource,
            groupSourceKind: 'google-group' as const,
            groupPurpose: 'building' as const,
            completionKind,
          })),
        );
        await transaction.insert(rosterRecipients).values({
          id: ids.recipient,
          rosterSnapshotId: ids.snapshot,
          population: 'staff',
          googleSubject: `google-recipient-${ids.recipient}`,
          staffEmail: 'teacher@district.example.invalid',
          displayName: 'Synthetic teacher',
        });
        await transaction.insert(rosterRecipientGroupSources).values({
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipient,
          population: 'staff',
          groupSourceId: ids.groupSource,
          groupSourceKind: 'google-group',
          groupPurpose: 'building',
        });
        await transaction.insert(rosterEndpoints).values({
          id: ids.staffEmailEndpoint,
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.recipient,
          population: 'staff',
          channel: 'email',
          status: 'active',
          capturedAt: CAPTURED_AT,
          platform: null,
          token: null,
          email: 'teacher@district.example.invalid',
          phoneNumber: null,
        });
      });
      for (const [id, kind, templateMode, versionId] of [
        [ids.event, 'incident', 'real', REAL_EVENT_TYPE_VERSION_ID],
        [ids.drillEvent, 'drill', 'drill', DRILL_EVENT_TYPE_VERSION_ID],
      ] as const) {
        await db()
          .insert(events)
          .values({
            id,
            facilityId: FACILITY_ID,
            kind,
            templateMode,
            eventTypeVersionId: versionId,
            status: 'active',
            rosterSnapshotId: ids.snapshot,
            rosterPopulation: 'staff',
            createdBy: humanActor,
            createdAt: CREATED_AT,
            activatedAt: CREATED_AT,
            allClearAt: null,
            reactivatedAt: null,
            closedAt: null,
            correctionOfEventId: null,
            correctionReason: null,
            activationAuthorization: activationAuthorization(randomUUID()),
          });
      }
      await db().insert(partnerEndpoints).values({
        id: ids.partnerEmailEndpoint,
        partnerAdmissionId: ids.admission,
        channel: 'email',
      });
    });

    afterAll(async () => {
      const opened = connection;
      connection = undefined;
      await closeAndDropDisposableDatabase(
        opened === undefined ? undefined : () => opened.close(),
        owned,
      );
      owned = undefined;
    });

    test('a live incident records a partner slice beside its staff intent in one request', async () => {
      await insertSlice(
        'staff',
        ids.staffIntent,
        ids.staffOutbox,
        ids.staffBatch,
      );
      await insertSlice(
        'partner',
        ids.partnerIntent,
        ids.partnerOutbox,
        ids.partnerBatch,
      );
      const rows = databaseExecuteRows<{
        roster_population: string;
        event_roster_population: string;
      }>(
        await db().execute(sql`select roster_population, event_roster_population
        from notification_intents
        where request_id = ${ids.request}
        order by roster_population`),
      );
      // Both belong to the staff event and its staff snapshot.
      expect(rows).toEqual([
        { roster_population: 'staff', event_roster_population: 'staff' },
        { roster_population: 'partner', event_roster_population: 'staff' },
      ]);
      // The contract reads the stored partner slice back.
      const [stored] = await db()
        .select()
        .from(notificationIntents)
        .where(eq(notificationIntents.id, ids.partnerIntent));
      expect(
        NotificationIntentSchema.safeParse({
          id: stored!.id,
          eventId: stored!.eventId,
          eventKind: stored!.eventKind,
          templateMode: stored!.templateMode,
          purpose: stored!.purpose,
          eventTypeVersion: {
            id: stored!.eventTypeVersionId,
            templateMode: stored!.templateMode,
          },
          rosterSnapshotId: stored!.rosterSnapshotId,
          rosterPopulation: stored!.rosterPopulation,
          createdBy: stored!.createdBy,
          source: stored!.source,
          requestId: stored!.requestId,
          authorization: stored!.authorization,
          channels: channelPlan,
          createdAt: stored!.createdAt.toISOString(),
        }).success,
      ).toBe(true);
      expect(
        DispatchBatchSchema.safeParse({
          id: ids.partnerBatch,
          intentId: ids.partnerIntent,
          eventId: ids.event,
          facilityId: FACILITY_ID,
          eventKind: 'incident',
          templateMode: 'real',
          purpose: 'activation',
          eventTypeVersion: {
            id: REAL_EVENT_TYPE_VERSION_ID,
            templateMode: 'real',
          },
          rosterSnapshotId: ids.snapshot,
          rosterPopulation: 'partner',
          requestId: ids.request,
          authorization,
          channel: 'email',
          renderedMessage: renderedMessage('email'),
          integrationId: 'ses-email',
          sequence: 2,
          endpointCount: 1,
          createdAt: CREATED_AT.toISOString(),
        }).success,
      ).toBe(true);
    });

    test('one request still holds only one intent per population', async () => {
      await expectRefused(
        db()
          .insert(notificationIntents)
          .values(
            intentValues({ id: randomUUID(), rosterPopulation: 'staff' }),
          ),
        {
          code: '23505',
          constraint: 'notification_intents_request_population_uq',
        },
      );
      await expectRefused(
        db()
          .insert(notificationIntents)
          .values(
            intentValues({ id: randomUUID(), rosterPopulation: 'partner' }),
          ),
        {
          code: '23505',
          constraint: 'notification_intents_request_population_uq',
        },
      );
    });

    test('a drill never reaches partners', async () => {
      const requestId = randomUUID();
      await expectRefused(
        db()
          .insert(notificationIntents)
          .values(
            intentValues({
              id: randomUUID(),
              eventId: ids.drillEvent,
              eventKind: 'drill',
              templateMode: 'drill',
              eventTypeVersionId: DRILL_EVENT_TYPE_VERSION_ID,
              rosterPopulation: 'partner',
              requestId,
              authorization: activationAuthorization(requestId),
            }),
          ),
        { code: '23514', constraint: 'notification_intents_classification' },
      );
    });

    test('a partner slice requires the same human authorization as staff', async () => {
      const requestId = randomUUID();
      await expectRefused(
        db()
          .insert(notificationIntents)
          .values(
            intentValues({
              id: randomUUID(),
              rosterPopulation: 'partner',
              requestId,
              authorization: {
                kind: 'synthetic-training',
                activationPreviewId: randomUUID(),
                consequenceDigest: 'd'.repeat(64),
                requestId,
              },
            }),
          ),
        {
          code: '23514',
          constraint: 'notification_intents_authorization_truth',
        },
      );
      await expectRefused(
        db()
          .insert(notificationIntents)
          .values(
            intentValues({
              id: randomUUID(),
              rosterPopulation: 'partner',
              requestId,
              authorization: activationAuthorization(requestId),
              createdBy: {
                kind: 'agent',
                agentId: randomUUID(),
                keyId: randomUUID(),
              },
              source: 'agent-rest',
            }),
          ),
        {
          code: '23514',
          constraint: 'notification_intents_authorization_truth',
        },
      );
    });

    test('a partner attempt binds only a partner endpoint of its admission', async () => {
      const [attempt] = await db()
        .insert(channelAttempts)
        .values(
          attemptValues({
            batchId: ids.partnerBatch,
            intentId: ids.partnerIntent,
            population: 'partner',
            recipientId: ids.admission,
            endpointId: ids.partnerEmailEndpoint,
          }),
        )
        .returning();
      expect(attempt).toMatchObject({
        partnerEndpointId: ids.partnerEmailEndpoint,
        publishedEndpointId: null,
        fannedOutRegistrationId: null,
      });

      // A staff roster endpoint is not a partner endpoint.
      await expectRefused(
        db()
          .insert(channelAttempts)
          .values(
            attemptValues({
              batchId: ids.partnerBatch,
              intentId: ids.partnerIntent,
              population: 'partner',
              recipientId: ids.recipient,
              endpointId: ids.staffEmailEndpoint,
            }),
          ),
        { code: '23503', constraint: 'channel_attempts_endpoint_binding' },
      );
      // Nor is a partner endpoint claimed under somebody else.
      await expectRefused(
        db()
          .insert(channelAttempts)
          .values(
            attemptValues({
              batchId: ids.partnerBatch,
              intentId: ids.partnerIntent,
              population: 'partner',
              recipientId: ids.recipient,
              endpointId: ids.partnerEmailEndpoint,
            }),
          ),
        { code: '23503', constraint: 'channel_attempts_endpoint_binding' },
      );
    });

    test('a staff attempt still binds its published endpoint and never a partner one', async () => {
      const [attempt] = await db()
        .insert(channelAttempts)
        .values(
          attemptValues({
            batchId: ids.staffBatch,
            intentId: ids.staffIntent,
            population: 'staff',
            recipientId: ids.recipient,
            endpointId: ids.staffEmailEndpoint,
          }),
        )
        .returning();
      expect(attempt).toMatchObject({
        publishedEndpointId: ids.staffEmailEndpoint,
        fannedOutRegistrationId: null,
        partnerEndpointId: null,
      });
      await expectRefused(
        db()
          .insert(channelAttempts)
          .values(
            attemptValues({
              batchId: ids.staffBatch,
              intentId: ids.staffIntent,
              population: 'staff',
              recipientId: ids.admission,
              endpointId: ids.partnerEmailEndpoint,
            }),
          ),
        { code: '23503', constraint: 'channel_attempts_endpoint_binding' },
      );
    });

    test('a partner endpoint status record binds the partner endpoint', async () => {
      const [record] = await db()
        .insert(endpointStatusRecords)
        .values({
          rosterSnapshotId: ids.snapshot,
          recipientId: ids.admission,
          endpointId: ids.partnerEmailEndpoint,
          population: 'partner',
          channel: 'email',
          status: 'invalid',
          reasonCode: 'SES_PERMANENT_BOUNCE',
        })
        .returning();
      expect(record).toMatchObject({
        partnerEndpointId: ids.partnerEmailEndpoint,
        publishedEndpointId: null,
        fannedOutRegistrationId: null,
      });
    });

    test("a partner push or SMS endpoint must be the admitted partner's own", async () => {
      const ownRegistration = await insertPushRegistration(ids.partnerUser);
      const staffRegistration = await insertPushRegistration(ids.staffUser);
      const ownConsent = await insertSmsConsent(ids.partnerUser);
      const staffConsent = await insertSmsConsent(ids.staffUser);

      await db()
        .insert(partnerEndpoints)
        .values([
          {
            partnerAdmissionId: ids.admission,
            channel: 'push',
            pushRegistrationId: ownRegistration,
          },
          {
            partnerAdmissionId: ids.admission,
            channel: 'sms',
            smsConsentId: ownConsent,
          },
        ]);
      await expectRefused(
        db().insert(partnerEndpoints).values({
          partnerAdmissionId: ids.admission,
          channel: 'push',
          pushRegistrationId: staffRegistration,
        }),
        { code: '23514', constraint: 'partner_endpoints_owner' },
      );
      await expectRefused(
        db().insert(partnerEndpoints).values({
          partnerAdmissionId: ids.admission,
          channel: 'sms',
          smsConsentId: staffConsent,
        }),
        { code: '23514', constraint: 'partner_endpoints_owner' },
      );
      // The channel names exactly one source.
      await expectRefused(
        db().insert(partnerEndpoints).values({
          partnerAdmissionId: ids.admission,
          channel: 'email',
          smsConsentId: ownConsent,
        }),
        { code: '23514', constraint: 'partner_endpoints_channel_source' },
      );
      // One email endpoint per admission: it is the admission's address.
      await expectRefused(
        db().insert(partnerEndpoints).values({
          partnerAdmissionId: ids.admission,
          channel: 'email',
        }),
        { code: '23505', constraint: 'partner_endpoints_email_uq' },
      );
    });

    test('partner endpoints are append-only', async () => {
      for (const statement of [
        sql`update partner_endpoints set created_at = now() where id = ${ids.partnerEmailEndpoint}`,
        sql`delete from partner_endpoints where id = ${ids.partnerEmailEndpoint}`,
      ]) {
        await expectRefused(db().execute(statement), { code: '55000' });
      }
    });

    test('partner never enters the roster or an event', async () => {
      await expectRefused(
        db().execute(
          sql`insert into roster_source_configurations (id, version, population)
          values (${randomUUID()}, 1, 'partner')`,
        ),
        {
          code: '23514',
          constraint: 'roster_source_configurations_rostered_population',
        },
      );
      // A drill is the one event kind whose targeting rule names no
      // population, so it is the sharpest probe: its authorization rule still
      // admits only staff and synthetic.
      await expectRefused(
        db()
          .insert(events)
          .values({
            id: randomUUID(),
            facilityId: FACILITY_ID,
            kind: 'drill',
            templateMode: 'drill',
            eventTypeVersionId: DRILL_EVENT_TYPE_VERSION_ID,
            status: 'active',
            rosterSnapshotId: ids.snapshot,
            rosterPopulation: sql`'partner'::roster_population`,
            createdBy: humanActor,
            createdAt: CREATED_AT,
            activatedAt: CREATED_AT,
            allClearAt: null,
            reactivatedAt: null,
            closedAt: null,
            correctionOfEventId: null,
            correctionReason: null,
            activationAuthorization: activationAuthorization(randomUUID()),
          }),
        { code: '23514' },
      );
    });

    test('the production application role can read and append partner endpoints', async () => {
      if (owned === undefined) throw new Error('not migrated');
      const roleConnection = createDatabaseClient({
        driver: 'postgres',
        url: owned.url,
        maxConnections: 1,
      });
      if (roleConnection.driver !== 'postgres') throw new Error('postgres');
      try {
        // The device is enrolled by the owner connection; only the partner
        // endpoint is written as the application role.
        const registration = await insertPushRegistration(ids.partnerUser);
        await roleConnection.db.execute(sql`set role psd_eoc_app`);
        const [inserted] = await roleConnection.db
          .insert(partnerEndpoints)
          .values({
            partnerAdmissionId: ids.admission,
            channel: 'push',
            pushRegistrationId: registration,
          })
          .returning();
        expect(inserted?.partnerAdmissionId).toBe(ids.admission);
        const visible = await roleConnection.db
          .select({ id: partnerEndpoints.id })
          .from(partnerEndpoints)
          .where(eq(partnerEndpoints.partnerAdmissionId, ids.admission));
        expect(visible.map((row) => row.id)).toContain(inserted!.id);
      } finally {
        await roleConnection.close();
      }
    });
  },
);
