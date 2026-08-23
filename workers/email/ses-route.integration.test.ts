import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';

import {
  ChannelAttemptSchema,
  DeliveryEvidenceSchema,
  RosterHealthQuerySchema,
  executeCapability,
  type CapabilityExecutionAuthorizer,
  type ChannelAttempt,
} from '@psd-eoc/contracts';
import { desc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type Database,
  type PostgresDatabase,
  type PostgresDatabaseConnection,
} from '../../packages/server/db/client';
import { seedDatabase } from '../../packages/server/db/seed';
import {
  endpointStatusRecords,
  idempotencyRecords,
  rosterEndpoints,
  rosterRecipients,
  rosterSnapshots,
  rosterSourceConfigurations,
} from '../../packages/server/db/schema';
import { migrateDatabase } from '../../packages/server/drizzle/migrate';
import { requireSyntheticTestDatabaseUrl } from '../../packages/server/lib/testing/database';
import {
  createDrizzleSesWebhookStore,
  createSesWebhookRouteHandler,
  type SesWebhookStore,
} from '../../packages/server/app/api/webhooks/ses/runtime';
import {
  createDrizzleStaleRosterReportStoreFromTransaction,
  createGetStaleRosterReportHandler,
  type StaleRosterAuthorizationContext,
} from '../../packages/server/lib/roster/stale-report';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;

const TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:psd-eoc-email-events';
const CONFIGURATION_SET = 'psd-eoc-transactional';
const TEST_ROLLBACK = new Error('Issue 13 database test rollback.');
const STALE_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

setDefaultTimeout(60_000);

let connection: PostgresDatabaseConnection | undefined;

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error(
      'The SES integration-test database connection is not open.',
    );
  }
  return connection;
}

async function withinRollbackTransaction(
  operation: (database: PostgresDatabase) => Promise<void>,
): Promise<void> {
  try {
    await databaseConnection().db.transaction(async (transaction) => {
      await operation(transaction as unknown as PostgresDatabase);
      throw TEST_ROLLBACK;
    });
  } catch (error) {
    if (error !== TEST_ROLLBACK) throw error;
  }
}

interface RosterFixture {
  readonly snapshotId: string;
  readonly recipientId: string;
  readonly endpointId: string;
  readonly capturedAt: Date;
  readonly email: string;
}

async function installSingleEmailRoster(
  database: PostgresDatabase,
): Promise<RosterFixture> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('psd-eoc-roster-synthetic', 0))`,
  );
  const [configuration] = await database
    .select({
      id: rosterSourceConfigurations.id,
      version: rosterSourceConfigurations.version,
    })
    .from(rosterSourceConfigurations)
    .where(eq(rosterSourceConfigurations.population, 'synthetic'))
    .orderBy(desc(rosterSourceConfigurations.version))
    .limit(1);
  const [latestSnapshot] = await database
    .select({ version: rosterSnapshots.version })
    .from(rosterSnapshots)
    .where(eq(rosterSnapshots.population, 'synthetic'))
    .orderBy(desc(rosterSnapshots.version))
    .limit(1);
  if (configuration === undefined) {
    throw new Error('The seeded synthetic roster configuration was missing.');
  }

  const snapshotId = randomUUID();
  const recipientId = randomUUID();
  const endpointId = randomUUID();
  const capturedAt = new Date();
  capturedAt.setMilliseconds(0);
  const email = `synthetic-ses-bounce-${endpointId}@example.invalid`;

  await database.insert(rosterSnapshots).values({
    id: snapshotId,
    version: (latestSnapshot?.version ?? 0) + 1,
    population: 'synthetic',
    complete: true,
    sourceConfigurationId: configuration.id,
    sourceConfigurationVersion: configuration.version,
    syncStartedAt: new Date(capturedAt.getTime() - 1_000),
    capturedAt,
  });
  await database.insert(rosterRecipients).values({
    id: recipientId,
    rosterSnapshotId: snapshotId,
    population: 'synthetic',
    googleSubject: null,
    displayName: 'Synthetic SES bounce recipient',
  });
  await database.insert(rosterEndpoints).values({
    id: endpointId,
    rosterSnapshotId: snapshotId,
    recipientId,
    population: 'synthetic',
    channel: 'email',
    status: 'active',
    capturedAt,
    email,
  });

  return Object.freeze({
    snapshotId,
    recipientId,
    endpointId,
    capturedAt,
    email,
  });
}

function attemptFor(fixture: RosterFixture): ChannelAttempt {
  return ChannelAttemptSchema.parse({
    id: randomUUID(),
    batchId: randomUUID(),
    intentId: randomUUID(),
    eventId: randomUUID(),
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'activation',
    eventTypeVersion: { id: randomUUID(), templateMode: 'drill' },
    rosterSnapshotId: fixture.snapshotId,
    rosterPopulation: 'synthetic',
    recipientId: fixture.recipientId,
    endpointId: fixture.endpointId,
    channel: 'email',
    attemptNumber: 1,
    attemptedAt: new Date(fixture.capturedAt.getTime() + 1_000).toISOString(),
  });
}

function bounceRequest(
  fixture: RosterFixture,
  attempt: ChannelAttempt,
): Request {
  const messageId = randomUUID();
  const occurredAt = new Date(
    fixture.capturedAt.getTime() + 2_000,
  ).toISOString();
  const message = JSON.stringify({
    eventType: 'Bounce',
    mail: {
      timestamp: occurredAt,
      messageId: `synthetic-ses-message-${messageId}`,
      source: 'synthetic-sender@alerts.example.invalid',
      sendingAccountId: '000000000000',
      destination: [fixture.email],
      tags: {
        'ses:configuration-set': [CONFIGURATION_SET],
        'psd-eoc-attempt-id': [attempt.id],
        'psd-eoc-endpoint-id': [attempt.endpointId],
        'psd-eoc-roster-snapshot-id': [attempt.rosterSnapshotId],
        'psd-eoc-recipient-id': [attempt.recipientId],
        'psd-eoc-template-mode': [attempt.templateMode],
        'psd-eoc-event-kind': [attempt.eventKind],
      },
    },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      timestamp: occurredAt,
      bouncedRecipients: [{ emailAddress: fixture.email }],
    },
  });
  const envelope = {
    Type: 'Notification',
    MessageId: messageId,
    TopicArn: TOPIC_ARN,
    Message: message,
    Timestamp: occurredAt,
    SignatureVersion: '2',
    Signature: Buffer.from('synthetic-signature', 'utf8').toString('base64'),
    SigningCertURL:
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-00000000000000000000000000000000.pem',
  };
  return new Request('https://app.example.invalid/api/webhooks/ses', {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-amz-sns-message-type': envelope.Type,
      'x-amz-sns-message-id': envelope.MessageId,
      'x-amz-sns-topic-arn': envelope.TopicArn,
    },
    body: JSON.stringify(envelope),
  });
}

function reportAuthorizer(): CapabilityExecutionAuthorizer<StaleRosterAuthorizationContext> {
  const authorizer: CapabilityExecutionAuthorizer<StaleRosterAuthorizationContext> =
    {
      authorize(request): void {
        expect(request.definition.id).toBe('get-stale-roster-report');
        expect(request.definition.operation).toBe('query');
        expect(request.humanActionRequirement.actionIds).toEqual([]);
      },
    };
  return Object.freeze(authorizer);
}

async function staleReport(database: PostgresDatabase, generatedAt: Date) {
  return executeCapability(
    createGetStaleRosterReportHandler({
      store: createDrizzleStaleRosterReportStoreFromTransaction(database),
      clock: () => generatedAt,
      staleThresholdSeconds: STALE_THRESHOLD_SECONDS,
    }),
    RosterHealthQuerySchema.parse({
      population: 'synthetic',
      facilityId: null,
      cursor: null,
      limit: 200,
    }),
    {
      context: { facilityScope: { kind: 'district' } },
      humanActionResolutionContext: null,
      safetyResolver: null,
      authorizer: reportAuthorizer(),
    },
  );
}

function callbackDigest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex');
}

describeWithDatabase('SES callback PostgreSQL integration', () => {
  beforeAll(async () => {
    if (testDatabaseUrl === undefined) {
      throw new Error(
        'TEST_DATABASE_URL is required for database integration tests.',
      );
    }
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: testDatabaseUrl,
      maxConnections: 4,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('SES callback integration tests require PostgreSQL.');
    }
    connection = opened;
    await migrateDatabase(opened);
    await seedDatabase(opened.db);
  });

  afterAll(async () => {
    await connection?.close();
    connection = undefined;
  });

  test('a signed permanent bounce persists invalidation into the stale-roster report', async () => {
    await withinRollbackTransaction(async (database) => {
      const fixture = await installSingleEmailRoster(database);
      const attempt = attemptFor(fixture);
      const productionStore = createDrizzleSesWebhookStore(
        database as unknown as Database,
      );
      let evidenceWrites = 0;
      const store: SesWebhookStore = {
        ...productionStore,
        loadAttempt: (attemptId: string) =>
          Promise.resolve(attemptId === attempt.id ? attempt : null),
        recordAttemptEvidence(_loadedAttempt, input) {
          evidenceWrites += 1;
          return Promise.resolve(
            DeliveryEvidenceSchema.parse({
              id: randomUUID(),
              subject: input.subject,
              sequence: 1,
              previousEvidenceId: null,
              state: input.state,
              recordedAt: new Date().toISOString(),
              provider: input.provider,
              providerReference: input.providerReference,
              proof: input.proof,
              reasonCode: input.reasonCode,
              diagnosticDigest: input.diagnosticDigest,
            }),
          );
        },
      };
      const generatedAt = new Date(fixture.capturedAt.getTime() + 3_000);
      const before = await staleReport(database, generatedAt);
      expect(before.staleRecipients).toEqual([
        {
          recipientId: fixture.recipientId,
          reason: 'no-active-push-endpoint',
        },
      ]);

      const handler = createSesWebhookRouteHandler({
        readExpectedTopicArn: () => TOPIC_ARN,
        verifySignature: () => Promise.resolve(),
        createStore: () => Promise.resolve(store),
      });
      const response = await handler(bounceRequest(fixture, attempt));

      expect(response.status).toBe(204);
      expect(evidenceWrites).toBe(1);
      const persistedStatuses = await database
        .select({
          status: endpointStatusRecords.status,
          reasonCode: endpointStatusRecords.reasonCode,
        })
        .from(endpointStatusRecords)
        .where(eq(endpointStatusRecords.endpointId, fixture.endpointId));
      expect(persistedStatuses).toEqual([
        { status: 'invalid', reasonCode: 'SES_PERMANENT_BOUNCE' },
      ]);

      const after = await staleReport(database, generatedAt);
      expect(after.status).toBe('stale');
      expect(after.staleRecipients).toEqual([
        { recipientId: fixture.recipientId, reason: 'no-active-endpoint' },
      ]);
      expect(JSON.stringify(after)).not.toContain(fixture.email);
    });
  });

  test('completed callbacks stay replay-only and stale lease owners cannot finish reacquired work', async () => {
    await withinRollbackTransaction(async (database) => {
      const store = createDrizzleSesWebhookStore(
        database as unknown as Database,
      );
      const principal = { kind: 'system' as const, serviceId: 'amazon-sns' };
      const principalDigest = callbackDigest(
        'psd-eoc:system:amazon-sns:ses-webhook:v1',
      );
      const staleCreatedAt = new Date(Date.now() - 60 * 60_000);
      const completedMessageId = randomUUID();
      const completedDigest = callbackDigest('completed-callback');
      await database.insert(idempotencyRecords).values({
        id: randomUUID(),
        capabilityId: 'record-delivery-evidence',
        principal,
        principalDigest,
        key: `ses-sns:${completedMessageId}:lease:000000`,
        requestDigest: completedDigest,
        status: 'completed',
        createdAt: staleCreatedAt,
        completedAt: new Date(staleCreatedAt.getTime() + 1_000),
        resultReference: `ses-sns:${completedMessageId}`,
      });
      await expect(
        store.claimCallback(completedMessageId, completedDigest),
      ).resolves.toEqual({ kind: 'replay' });

      const reacquiredMessageId = randomUUID();
      const reacquiredDigest = callbackDigest('reacquired-callback');
      const staleRecordId = randomUUID();
      await database.insert(idempotencyRecords).values({
        id: staleRecordId,
        capabilityId: 'record-delivery-evidence',
        principal,
        principalDigest,
        key: `ses-sns:${reacquiredMessageId}:lease:000000`,
        requestDigest: reacquiredDigest,
        status: 'in-progress',
        createdAt: staleCreatedAt,
      });

      const currentOwner = await store.claimCallback(
        reacquiredMessageId,
        reacquiredDigest,
      );
      expect(currentOwner.kind).toBe('acquired');
      if (currentOwner.kind !== 'acquired') {
        throw new Error(
          'Expected the expired callback lease to be reacquired.',
        );
      }
      expect(currentOwner.recordId).not.toBe(staleRecordId);
      expect(currentOwner.leaseToken).toBe(currentOwner.recordId);
      const generations = await database
        .select({
          key: idempotencyRecords.key,
          status: idempotencyRecords.status,
          resultReference: idempotencyRecords.resultReference,
        })
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.requestDigest, reacquiredDigest))
        .orderBy(idempotencyRecords.key);
      expect(generations).toEqual([
        {
          key: `ses-sns:${reacquiredMessageId}:lease:000000`,
          status: 'failed',
          resultReference: `ses-sns-lease-expired:ses-sns:${reacquiredMessageId}:lease:000001`,
        },
        {
          key: `ses-sns:${reacquiredMessageId}:lease:000001`,
          status: 'in-progress',
          resultReference: null,
        },
      ]);

      await expect(
        store.completeCallback(
          staleRecordId,
          staleRecordId,
          reacquiredMessageId,
        ),
      ).rejects.toThrow('The SES callback could not be persisted safely.');
      await expect(
        store.failCallback(staleRecordId, staleRecordId, 'STALE_OWNER_FAILURE'),
      ).rejects.toThrow('The SES callback could not be persisted safely.');

      await store.completeCallback(
        currentOwner.recordId,
        currentOwner.leaseToken,
        reacquiredMessageId,
      );
      await expect(
        store.claimCallback(reacquiredMessageId, reacquiredDigest),
      ).resolves.toEqual({ kind: 'replay' });
    });
  });
});
