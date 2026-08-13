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
  type DispatchBatch,
  type NotificationChannel,
} from '@psd-eoc/contracts';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  createDrizzleStartFlowCapabilityStore,
  executeStartFlowCapability,
  loadAudienceConfiguration,
  loadRosterSnapshot,
} from '../../packages/server/app/(app)/start/_lib/capabilities';
import {
  createDatabaseClient,
  type DatabaseQuery,
  type PostgresDatabaseConnection,
} from '../../packages/server/db/client';
import { seedDatabase } from '../../packages/server/db/seed';
import {
  accessMembershipMembers,
  accessMembershipSnapshots,
  agents,
  channelConfigurations,
  deviceEnrollments,
  integrationStatuses,
  outbox,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  sessions,
  userRoles,
  users,
} from '../../packages/server/db/schema';
import { migrateDatabase } from '../../packages/server/drizzle/migrate';
import {
  createDrizzleEventCapabilityStore,
  executeEventCapability,
} from '../../packages/server/lib/capabilities/events';
import type { TrustedCapabilityInvocation } from '../../packages/server/lib/capabilities/engine';
import {
  createDrizzleOutboxDispatcherStore,
  createSqsDispatchBatchQueue,
  dispatchOutboxAfterCommit,
} from '../../packages/server/lib/notify/dispatcher';
import {
  appendFanoutControlRecord,
  lockAndReadCurrentFanoutControl,
} from '../../packages/server/lib/notify/fanout-control';
import { resolveAudience } from '../../packages/server/lib/roster/resolve';
import {
  parseWorkerAttemptWorkItem,
  type WorkerAttemptWorkItem,
} from './attempt';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl === undefined ? describe.skip : describe;
const SLO_CHILD_ENV = 'PSD_EOC_ISSUE30_SLO_CHILD';
const SLO_SUCCESS_PREFIX = '[issue-30 synthetic SLO success]';
const SLO_GATE_RESULT_KEY = Symbol.for('psd-eoc.issue30.slo-gate-result');
const isSloChild = process.env[SLO_CHILD_ENV] === 'true';
const testFilePath = fileURLToPath(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

setDefaultTimeout(180_000);

const SAMPLE_COUNT = 40;
const RECIPIENT_COUNT = 1_200;
const CHANNEL_COUNT = 3;
const WORK_ITEMS_PER_SAMPLE = RECIPIENT_COUNT * CHANNEL_COUNT;
const ACTIVATION_P95_LIMIT_MILLISECONDS = 500;
const OUTBOX_TO_ENQUEUE_P95_LIMIT_MILLISECONDS = 2_000;
const COMBINED_P95_LIMIT_MILLISECONDS = 2_500;

const SEEDED = Object.freeze({
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  facilitySouth: '00000000-0000-4000-8000-000000000002',
  audience: '00000000-0000-4000-8000-000000000020',
  groupNorth: '00000000-0000-4000-8000-000000000030',
  groupSouth: '00000000-0000-4000-8000-000000000031',
  groupOthers: '00000000-0000-4000-8000-000000000032',
  rosterConfiguration: '00000000-0000-4000-8000-000000000040',
  eventTypeVersion: '00000000-0000-4000-8000-000000000201',
});

const SYNTHETIC_ROSTER_ID = randomUUID();
const SYNTHETIC_PREVIEW_AGENT_ID = randomUUID();
const SYNTHETIC_PREVIEW_API_KEY_ID = randomUUID();
const SYNTHETIC_FANOUT_ADMIN = Object.freeze({
  userId: randomUUID(),
  sessionId: randomUUID(),
});
const FIXTURE_CAPTURED_AT = new Date();
const FIXTURE_SYNC_STARTED_AT = new Date(FIXTURE_CAPTURED_AT.getTime() - 1_000);
const QUEUE_URL =
  'https://sqs.us-west-2.amazonaws.com/123456789012/synthetic-issue-30-slo';
const SQS_ENDPOINT = 'https://sqs.us-west-2.amazonaws.com/';
const MOCK_OBSERVED_AT = new Date('2026-08-13T12:00:00.000Z');
const INTEGRATION_IDS = Object.freeze({
  push: 'expo-push',
  email: 'ses-email',
  sms: 'aws-eum-sms',
} as const);

const integrationStatusIds = Object.freeze({
  push: randomUUID(),
  email: randomUUID(),
  sms: randomUUID(),
});

const isolatedDatabaseName = `psd_eoc_issue30_${randomUUID().replaceAll('-', '')}_test`;

let connection: PostgresDatabaseConnection | undefined;
let controlConnection: PostgresDatabaseConnection | undefined;

function validatedSyntheticTestDatabaseUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('TEST_DATABASE_URL is required for the SLO gate.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname) ||
    !/^[a-z0-9_]+_test$/u.test(databaseName)
  ) {
    throw new Error(
      'The SLO gate requires a loopback PostgreSQL database ending in _test.',
    );
  }
  return parsed.toString();
}

function sloChildEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    TEST_DATABASE_URL: databaseUrl,
    [SLO_CHILD_ENV]: 'true',
  };
}

function recordedSloGateResult(): string | null {
  const value = Reflect.get(globalThis, SLO_GATE_RESULT_KEY) as unknown;
  return typeof value === 'string' && value.startsWith(SLO_SUCCESS_PREFIX)
    ? value
    : null;
}

function recordSloGateResult(value: string): void {
  if (!value.startsWith(SLO_SUCCESS_PREFIX)) {
    throw new Error('The synthetic SLO success marker is invalid.');
  }
  Reflect.set(globalThis, SLO_GATE_RESULT_KEY, value);
}

function isolatedTestDatabaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${isolatedDatabaseName}`;
  return parsed.toString();
}

function databaseIdentifierStatement(operation: 'create' | 'drop') {
  if (!/^[a-z0-9_]+$/u.test(isolatedDatabaseName)) {
    throw new Error('The generated SLO test database name is unsafe.');
  }
  return sql.raw(
    operation === 'create'
      ? `create database "${isolatedDatabaseName}" template template0`
      : `drop database if exists "${isolatedDatabaseName}" with (force)`,
  );
}

function databaseConnection(): PostgresDatabaseConnection {
  if (connection === undefined) {
    throw new Error('The SLO test PostgreSQL connection is not open.');
  }
  return connection;
}

function integrationId(channel: NotificationChannel) {
  return INTEGRATION_IDS[channel];
}

function previewInvocation(requestId: string): TrustedCapabilityInvocation {
  return {
    actor: {
      kind: 'agent',
      agentId: SYNTHETIC_PREVIEW_AGENT_ID,
      apiKeyId: SYNTHETIC_PREVIEW_API_KEY_ID,
    },
    source: 'agent-rest',
    scope: { facilityScope: { kind: 'district' } },
    requestId,
    serverTime: new Date(),
    connectivityEpochId: null,
    mutation: null,
  };
}

function syntheticStartInvocation(
  requestId: string,
  idempotencyKey: string,
): TrustedCapabilityInvocation {
  return {
    actor: { kind: 'system', serviceId: 'synthetic-slo-harness' },
    source: 'scheduled-job',
    scope: {
      facilityScope: {
        kind: 'facilities',
        facilityIds: [SEEDED.facilityNorth],
      },
    },
    requestId,
    serverTime: new Date(),
    connectivityEpochId: null,
    mutation: {
      idempotencyKey,
      transport: { kind: 'scheduled-execution' },
      humanConfirmationId: null,
    },
  };
}

function nearestRankP95(samples: readonly number[]): number {
  if (samples.length !== SAMPLE_COUNT) {
    throw new Error('The SLO gate requires every one of its 40 samples.');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.ceil(samples.length * 0.95) - 1];
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error('The SLO gate produced an invalid latency sample.');
  }
  return value;
}

function attemptId(sample: number, ordinal: number): string {
  const sequence = sample * WORK_ITEMS_PER_SAMPLE + ordinal + 1;
  return `30000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

async function configureSyntheticChannels(): Promise<void> {
  const database = databaseConnection().db;
  const statuses = (['push', 'email', 'sms'] as const).map((channel) => ({
    id: integrationStatusIds[channel],
    integrationId: integrationId(channel),
    label: 'mocked' as const,
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: MOCK_OBSERVED_AT,
  }));
  await database.transaction(async (transaction) => {
    await transaction.insert(integrationStatuses).values(statuses);
    for (const channel of ['push', 'email', 'sms'] as const) {
      await transaction
        .update(channelConfigurations)
        .set({
          enabled: true,
          statusId: integrationStatusIds[channel],
          statusLabel: 'mocked',
          changedAt: MOCK_OBSERVED_AT,
        })
        .where(eq(channelConfigurations.integrationId, integrationId(channel)));
    }
  });
}

async function enableSyntheticFanout(): Promise<void> {
  const database = databaseConnection().db;
  if ((await lockAndReadCurrentFanoutControl(database)) !== null) {
    throw new Error(
      'The isolated SLO database has unexpected fan-out history.',
    );
  }
  const changedAt = new Date(Date.now() - 1_000);
  const identityCreatedAt = new Date(changedAt.getTime() - 60_000);
  const membershipSnapshotId = randomUUID();
  const deviceEnrollmentId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  const membershipSnapshotVersion = Number.parseInt(suffix.slice(0, 7), 16) + 1;

  const enabled = await database.transaction(async (transaction) => {
    await transaction.insert(users).values({
      id: SYNTHETIC_FANOUT_ADMIN.userId,
      googleSubject: `synthetic-slo-fanout-admin-${suffix}`,
      email: `synthetic.slo.fanout.admin.${suffix}@psd401.net`,
      displayName: 'Synthetic SLO Fanout Administrator',
      facilityScopeKind: 'district',
      createdAt: identityCreatedAt,
      disabledAt: null,
    });
    await transaction.insert(userRoles).values({
      userId: SYNTHETIC_FANOUT_ADMIN.userId,
      role: 'admin',
    });
    await transaction.insert(accessMembershipSnapshots).values({
      id: membershipSnapshotId,
      version: membershipSnapshotVersion,
      complete: true,
      syncStartedAt: identityCreatedAt,
      capturedAt: identityCreatedAt,
    });
    await transaction.insert(accessMembershipMembers).values({
      snapshotId: membershipSnapshotId,
      userId: SYNTHETIC_FANOUT_ADMIN.userId,
      googleSubject: `synthetic-slo-fanout-admin-${suffix}`,
      facilityScopeKind: 'district',
    });
    await transaction.insert(deviceEnrollments).values({
      id: deviceEnrollmentId,
      userId: SYNTHETIC_FANOUT_ADMIN.userId,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `synthetic-slo-fanout-admin-${suffix}`,
      enrolledAt: identityCreatedAt,
      lastSeenAt: changedAt,
      revokedAt: null,
    });
    await transaction.insert(sessions).values({
      id: SYNTHETIC_FANOUT_ADMIN.sessionId,
      userId: SYNTHETIC_FANOUT_ADMIN.userId,
      deviceEnrollmentId,
      membershipSnapshotId,
      membershipValidUntil: new Date(changedAt.getTime() + 60 * 60_000),
      membershipGraceUntil: new Date(changedAt.getTime() + 2 * 60 * 60_000),
      createdAt: identityCreatedAt,
      expiresAt: new Date(changedAt.getTime() + 24 * 60 * 60_000),
      revokedAt: null,
    });
    return appendFanoutControlRecord({
      database: transaction,
      actor: SYNTHETIC_FANOUT_ADMIN,
      requestId: randomUUID(),
      expectedCurrentRecordId: null,
      desiredMode: 'enabled',
      reason: 'Synthetic issue-104 SLO fixture only.',
      productOwnerApprovalReference: `synthetic-issue-104-slo-${suffix}`,
      changedAt,
    });
  });
  if (enabled.enableEpochId === null) {
    throw new Error('The synthetic SLO fan-out fixture omitted its epoch.');
  }
}

/**
 * Publishes a second immutable synthetic snapshot rather than changing the
 * seed. Every destination is reserved and cannot be routed by a real provider.
 */
async function installLargeSyntheticRoster(): Promise<void> {
  const database = databaseConnection().db;
  const recipients = Array.from({ length: RECIPIENT_COUNT }, (_, index) => ({
    id: randomUUID(),
    index,
  }));
  const endpoints = recipients.flatMap(({ id: recipientId, index }) => {
    const suffix = String(index + 1).padStart(12, '0');
    return [
      {
        id: randomUUID(),
        rosterSnapshotId: SYNTHETIC_ROSTER_ID,
        recipientId,
        population: 'synthetic' as const,
        channel: 'push' as const,
        status: 'active' as const,
        capturedAt: FIXTURE_CAPTURED_AT,
        platform: index % 2 === 0 ? ('ios' as const) : ('android' as const),
        token: `synthetic-unroutable:issue-30-slo-${suffix}`,
        email: null,
        phoneNumber: null,
      },
      {
        id: randomUUID(),
        rosterSnapshotId: SYNTHETIC_ROSTER_ID,
        recipientId,
        population: 'synthetic' as const,
        channel: 'email' as const,
        status: 'active' as const,
        capturedAt: FIXTURE_CAPTURED_AT,
        platform: null,
        token: null,
        email: `issue-30-slo-${suffix}@example.invalid`,
        phoneNumber: null,
      },
      {
        id: randomUUID(),
        rosterSnapshotId: SYNTHETIC_ROSTER_ID,
        recipientId,
        population: 'synthetic' as const,
        channel: 'sms' as const,
        status: 'active' as const,
        capturedAt: FIXTURE_CAPTURED_AT,
        platform: null,
        token: null,
        email: null,
        phoneNumber: `+999${suffix}`,
      },
    ];
  });

  await database.transaction(async (transaction) => {
    await transaction.insert(agents).values({
      id: SYNTHETIC_PREVIEW_AGENT_ID,
      displayName: 'Synthetic issue 30 SLO preview agent',
      createdAt: FIXTURE_SYNC_STARTED_AT,
    });
    await transaction.insert(rosterSnapshots).values({
      id: SYNTHETIC_ROSTER_ID,
      version: 2,
      population: 'synthetic',
      complete: true,
      sourceConfigurationId: SEEDED.rosterConfiguration,
      sourceConfigurationVersion: 1,
      syncStartedAt: FIXTURE_SYNC_STARTED_AT,
      capturedAt: FIXTURE_CAPTURED_AT,
    });
    await transaction.insert(rosterSnapshotFacilities).values([
      {
        rosterSnapshotId: SYNTHETIC_ROSTER_ID,
        facilityId: SEEDED.facilityNorth,
      },
      {
        rosterSnapshotId: SYNTHETIC_ROSTER_ID,
        facilityId: SEEDED.facilitySouth,
      },
    ]);
    await transaction.insert(rosterSnapshotSources).values(
      [
        {
          id: SEEDED.groupNorth,
          purpose: 'building' as const,
        },
        {
          id: SEEDED.groupSouth,
          purpose: 'building' as const,
        },
        { id: SEEDED.groupOthers, purpose: 'others' as const },
      ].flatMap((source) =>
        (['expected', 'completed'] as const).map((completionKind) => ({
          rosterSnapshotId: SYNTHETIC_ROSTER_ID,
          population: 'synthetic' as const,
          groupSourceId: source.id,
          groupSourceKind: 'synthetic' as const,
          groupPurpose: source.purpose,
          completionKind,
        })),
      ),
    );
    await transaction.insert(rosterRecipients).values(
      recipients.map(({ id, index }) => ({
        id,
        rosterSnapshotId: SYNTHETIC_ROSTER_ID,
        population: 'synthetic' as const,
        googleSubject: null,
        displayName: `Synthetic SLO Recipient ${String(index + 1).padStart(4, '0')}`,
      })),
    );
    await transaction.insert(rosterRecipientGroupSources).values(
      recipients.map(({ id }) => ({
        rosterSnapshotId: SYNTHETIC_ROSTER_ID,
        recipientId: id,
        population: 'synthetic' as const,
        groupSourceId: SEEDED.groupNorth,
        groupSourceKind: 'synthetic' as const,
        groupPurpose: 'building' as const,
      })),
    );
    await transaction.insert(rosterEndpoints).values(endpoints);
  });
}

async function resolveCanonicalSyntheticAudience() {
  // The canonical loaders normalize raw execute results internally; this
  // structural seam is the same direct-Postgres query surface they consume.
  const database = databaseConnection().db as unknown as DatabaseQuery;
  const audience = await loadAudienceConfiguration(
    database,
    SEEDED.facilityNorth,
  );
  const rosterSnapshot = await loadRosterSnapshot(
    database,
    'synthetic',
    SEEDED.facilityNorth,
    SYNTHETIC_ROSTER_ID,
  );
  if (audience === null || rosterSnapshot === null) {
    throw new Error('The canonical synthetic SLO audience is unavailable.');
  }
  if (
    audience.audienceConfig.id !== SEEDED.audience ||
    rosterSnapshot.id !== SYNTHETIC_ROSTER_ID
  ) {
    throw new Error('The canonical SLO resolution selected stale inputs.');
  }
  return resolveAudience({
    audienceConfig: audience.audienceConfig,
    neighborhoodVersions: audience.neighborhoodVersions,
    rosterSnapshot,
  });
}

function composeAndAcceptMockWorkItems(
  batches: readonly DispatchBatch[],
  sample: number,
  recipients: Awaited<
    ReturnType<typeof resolveCanonicalSyntheticAudience>
  >['recipients'],
  acceptWithMockProvider: (workItem: WorkerAttemptWorkItem) => void,
): Readonly<Record<NotificationChannel, number>> {
  const accepted = { push: 0, email: 0, sms: 0 };
  let ordinal = 0;
  for (const batch of batches) {
    for (const recipient of recipients) {
      for (const endpoint of recipient.endpoints) {
        if (endpoint.channel !== batch.channel) continue;
        const workItem: WorkerAttemptWorkItem = {
          batch,
          attempt: {
            id: attemptId(sample, ordinal),
            batchId: batch.id,
            intentId: batch.intentId,
            eventId: batch.eventId,
            eventKind: batch.eventKind,
            templateMode: batch.templateMode,
            purpose: batch.purpose,
            eventTypeVersion: batch.eventTypeVersion,
            rosterSnapshotId: batch.rosterSnapshotId,
            rosterPopulation: batch.rosterPopulation,
            deliveryTest: batch.deliveryTest,
            recipientId: recipient.recipientId,
            endpointId: endpoint.id,
            channel: batch.channel,
            attemptNumber: 1,
            attemptedAt: batch.createdAt,
          },
          endpoint,
        };
        const parsed = parseWorkerAttemptWorkItem(workItem);
        // This is the provider boundary for the SLO harness. It records only a
        // local mock acceptance after strict work-item validation and performs
        // no provider adapter or network call.
        acceptWithMockProvider(parsed);
        accepted[parsed.batch.channel] += 1;
        ordinal += 1;
      }
    }
  }
  if (ordinal !== WORK_ITEMS_PER_SAMPLE) {
    throw new Error('The SLO harness composed an inexact fan-out.');
  }
  return Object.freeze(accepted);
}

if (isSloChild) {
  describeWithDatabase(
    'synthetic activation-to-enqueue SLO regression gate',
    () => {
      beforeAll(async () => {
        const databaseUrl = validatedSyntheticTestDatabaseUrl(testDatabaseUrl);
        const createdControlConnection = createDatabaseClient({
          driver: 'postgres',
          url: databaseUrl,
          maxConnections: 1,
        });
        if (createdControlConnection.driver !== 'postgres') {
          throw new Error('The SLO gate requires direct PostgreSQL.');
        }
        controlConnection = createdControlConnection;
        await migrateDatabase(createdControlConnection);
        await createdControlConnection.db.execute(
          databaseIdentifierStatement('create'),
        );

        const isolatedConnection = createDatabaseClient({
          driver: 'postgres',
          url: isolatedTestDatabaseUrl(databaseUrl),
          maxConnections: 6,
        });
        if (isolatedConnection.driver !== 'postgres') {
          throw new Error('The isolated SLO gate requires PostgreSQL.');
        }
        connection = isolatedConnection;
        await migrateDatabase(isolatedConnection);
        await seedDatabase(isolatedConnection.db);
        await enableSyntheticFanout();
        await configureSyntheticChannels();
        await installLargeSyntheticRoster();
      });

      afterAll(async () => {
        await connection?.close();
        connection = undefined;
        if (controlConnection !== undefined) {
          await controlConnection.db.execute(
            databaseIdentifierStatement('drop'),
          );
          await controlConnection.close();
          controlConnection = undefined;
        }
      });

      test('keeps 40 unique 1,200-recipient x 3-channel samples inside every p95 budget', async () => {
        const database = databaseConnection().db;
        const previewStore = createDrizzleStartFlowCapabilityStore(database);
        const eventStore = createDrizzleEventCapabilityStore(database);
        const dispatcherStore = createDrizzleOutboxDispatcherStore(database);
        const previewIds = new Set<string>();
        const previewRequestIds = new Set<string>();
        const startRequestIds = new Set<string>();
        const idempotencyKeys = new Set<string>();
        const eventIds = new Set<string>();
        const intentIds = new Set<string>();
        const outboxIds = new Set<string>();
        const batchIds = new Set<string>();
        const dispatchRequestIds = new Set<string>();
        const activationSamples: number[] = [];
        const outboxToEnqueueSamples: number[] = [];
        const combinedSamples: number[] = [];
        const workItemCounts: number[] = [];
        const workItemChannelCounts: Array<
          Readonly<Record<NotificationChannel, number>>
        > = [];
        const capturedBatchSamples: Array<readonly DispatchBatch[]> = [];
        let sqsRequests = 0;
        let providerAcceptedWorkItems = 0;
        let providerNetworkRequests = 0;
        const failClosedMockProvider = Object.freeze({
          accept(workItem: WorkerAttemptWorkItem): void {
            if (
              workItem.batch.integrationStatus.label !== 'mocked' ||
              workItem.batch.rosterPopulation !== 'synthetic'
            ) {
              throw new Error(
                'The SLO provider mock rejects every non-synthetic delivery.',
              );
            }
            providerAcceptedWorkItems += 1;
          },
          requestNetwork(): never {
            providerNetworkRequests += 1;
            throw new Error(
              'The SLO provider mock cannot perform network I/O.',
            );
          },
        });

        const persistedAudience = await resolveCanonicalSyntheticAudience();
        expect(persistedAudience.recipients).toHaveLength(RECIPIENT_COUNT);
        expect(
          persistedAudience.recipients.every(
            (recipient) =>
              recipient.endpoints.length === CHANNEL_COUNT &&
              new Set(recipient.endpoints.map((endpoint) => endpoint.channel))
                .size === CHANNEL_COUNT &&
              recipient.endpoints.every(
                (endpoint) =>
                  endpoint.channel !== 'sms' ||
                  /^\+999\d{12}$/u.test(endpoint.phoneNumber),
              ),
          ),
        ).toBe(true);

        const syntheticSqsFetch = (async (
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          expect(String(input)).toBe(SQS_ENDPOINT);
          expect(new Headers(init?.headers).get('x-amz-target')).toBe(
            'AmazonSQS.SendMessageBatch',
          );
          const body = JSON.parse(String(init?.body)) as {
            QueueUrl: string;
            Entries: Array<{ Id: string; MessageBody: string }>;
          };
          expect(body.QueueUrl).toBe(QUEUE_URL);
          expect(body.Entries).toHaveLength(CHANNEL_COUNT);
          const batches = body.Entries.map((entry) =>
            DispatchBatchSchema.parse(JSON.parse(entry.MessageBody)),
          );
          expect(batches.map((batch) => batch.channel).sort()).toEqual([
            'email',
            'push',
            'sms',
          ]);
          expect(
            batches.every(
              (batch) =>
                batch.endpointCount === RECIPIENT_COUNT &&
                batch.eventKind === 'test' &&
                batch.templateMode === 'drill' &&
                batch.rosterSnapshotId === SYNTHETIC_ROSTER_ID &&
                batch.rosterPopulation === 'synthetic' &&
                batch.integrationStatus.label === 'mocked',
            ),
          ).toBe(true);
          batches.forEach((batch) => batchIds.add(batch.id));
          capturedBatchSamples.push(Object.freeze(batches));
          sqsRequests += 1;
          return Response.json({
            Successful: body.Entries.map((entry, index) => ({
              Id: entry.Id,
              MessageId: `synthetic-sqs-${sqsRequests}-${index + 1}`,
            })),
            Failed: [],
          });
        }) as typeof fetch;

        const queue = createSqsDispatchBatchQueue(
          {
            queueUrl: QUEUE_URL,
            region: 'us-west-2',
            timeoutMilliseconds: 10_000,
          },
          {
            fetch: syntheticSqsFetch,
            now: () => new Date(),
            credentialProvider: {
              getCredentials: () =>
                Promise.resolve({
                  accessKeyId: 'SYNTHETICEXAMPLEKEY',
                  secretAccessKey: 'synthetic-example-secret-not-a-credential',
                  sessionToken: 'synthetic-example-session-not-a-token',
                  expiration: new Date('2030-01-01T00:00:00.000Z'),
                }),
              invalidate() {},
            },
          },
        );

        for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
          const previewRequestId = randomUUID();
          const startRequestId = randomUUID();
          const idempotencyKey = `issue-30-synthetic-slo-${sample}-${randomUUID()}`;

          // The monotonic clock starts immediately before the canonical preview;
          // setup, fixture checks, and invocation construction are not hidden in
          // the measured path.
          const activationStartedAt = performance.now();
          const preview = await executeStartFlowCapability(
            'create-activation-preview',
            {
              facilityId: SEEDED.facilityNorth,
              kind: 'test',
              templateMode: 'drill',
              eventTypeVersion: {
                id: SEEDED.eventTypeVersion,
                templateMode: 'drill',
              },
              rosterPopulation: 'synthetic',
            },
            previewInvocation(previewRequestId),
            previewStore,
          );
          const activation = await executeEventCapability(
            'start-event',
            {
              source: 'activation-preview',
              activationPreviewId: preview.id,
              activeEventDecision: {
                decision: 'start-new',
                activeEventIdsSeen: [...preview.activeEventIds],
              },
            },
            syntheticStartInvocation(startRequestId, idempotencyKey),
            eventStore,
          );
          const activationAcceptedAt = performance.now();

          expect(preview).toMatchObject({
            rosterSnapshotId: SYNTHETIC_ROSTER_ID,
            recipientCount: RECIPIENT_COUNT,
            sendReadiness: 'ready',
            kind: 'test',
            templateMode: 'drill',
            rosterPopulation: 'synthetic',
          });
          expect(
            preview.channels
              .map(({ channel, endpointCount }) => ({ channel, endpointCount }))
              .sort((left, right) => left.channel.localeCompare(right.channel)),
          ).toEqual([
            { channel: 'email', endpointCount: RECIPIENT_COUNT },
            { channel: 'push', endpointCount: RECIPIENT_COUNT },
            { channel: 'sms', endpointCount: RECIPIENT_COUNT },
          ]);

          const intentId = activation.notificationIntent?.id;
          if (intentId === undefined) {
            throw new Error(
              'A successful synthetic activation omitted its intent.',
            );
          }
          const [pending] = await database
            .select({ id: outbox.id })
            .from(outbox)
            .where(eq(outbox.intentId, intentId))
            .limit(1);
          if (pending === undefined) {
            throw new Error(
              'A successful synthetic activation omitted its outbox.',
            );
          }
          const dispatchRequestId = randomUUID();
          const dispatch = await dispatchOutboxAfterCommit(
            pending.id,
            {
              store: dispatcherStore,
              queue,
              authorizeFanout: () => true,
            },
            dispatchRequestId,
          );
          // dispatchOutboxAfterCommit returns published only after the mocked
          // SQS acknowledgement and the durable markPublished commit. The read
          // below proves that state without adding test-query time to the SLO.
          const enqueuedAndDurableAt = performance.now();
          const [published] = await database
            .select({
              id: outbox.id,
              status: outbox.status,
              publishedAt: outbox.publishedAt,
            })
            .from(outbox)
            .where(eq(outbox.id, pending.id))
            .limit(1);

          expect(dispatch.outcome).toBe('published');
          expect(published).toEqual({
            id: pending.id,
            status: 'published',
            publishedAt: expect.any(Date),
          });
          if (dispatch.outcome !== 'published') {
            throw new Error('The mocked enqueue did not publish successfully.');
          }
          expect(dispatch.result.batches).toHaveLength(CHANNEL_COUNT);
          expect(
            dispatch.result.batches.every(
              (batch) => batch.endpointCount === RECIPIENT_COUNT,
            ),
          ).toBe(true);

          previewIds.add(preview.id);
          previewRequestIds.add(previewRequestId);
          startRequestIds.add(startRequestId);
          idempotencyKeys.add(idempotencyKey);
          eventIds.add(activation.event.id);
          intentIds.add(intentId);
          outboxIds.add(pending.id);
          dispatchRequestIds.add(dispatchRequestId);
          activationSamples.push(activationAcceptedAt - activationStartedAt);
          outboxToEnqueueSamples.push(
            enqueuedAndDurableAt - activationAcceptedAt,
          );
          combinedSamples.push(enqueuedAndDurableAt - activationStartedAt);
        }

        expect(capturedBatchSamples).toHaveLength(SAMPLE_COUNT);
        // SQS accepts destination-free channel batches. Worker fan-out happens
        // after that acknowledgement in production, so validate every sample's
        // canonical audience and exact work-item composition after collecting
        // the enqueue timings. No sample is retried, discarded, or reused.
        for (const [sample, batches] of capturedBatchSamples.entries()) {
          const resolvedAudience = await resolveCanonicalSyntheticAudience();
          const channelCounts = composeAndAcceptMockWorkItems(
            batches,
            sample,
            resolvedAudience.recipients,
            failClosedMockProvider.accept,
          );
          workItemChannelCounts.push(channelCounts);
          workItemCounts.push(
            channelCounts.push + channelCounts.email + channelCounts.sms,
          );
        }

        expect(previewIds.size).toBe(SAMPLE_COUNT);
        expect(previewRequestIds.size).toBe(SAMPLE_COUNT);
        expect(startRequestIds.size).toBe(SAMPLE_COUNT);
        expect(idempotencyKeys.size).toBe(SAMPLE_COUNT);
        expect(eventIds.size).toBe(SAMPLE_COUNT);
        expect(intentIds.size).toBe(SAMPLE_COUNT);
        expect(outboxIds.size).toBe(SAMPLE_COUNT);
        expect(batchIds.size).toBe(SAMPLE_COUNT * CHANNEL_COUNT);
        expect(dispatchRequestIds.size).toBe(SAMPLE_COUNT);
        expect(sqsRequests).toBe(SAMPLE_COUNT);
        expect(providerAcceptedWorkItems).toBe(
          SAMPLE_COUNT * WORK_ITEMS_PER_SAMPLE,
        );
        expect(providerNetworkRequests).toBe(0);
        expect(workItemCounts).toEqual(
          Array.from({ length: SAMPLE_COUNT }, () => WORK_ITEMS_PER_SAMPLE),
        );
        expect(workItemChannelCounts).toEqual(
          Array.from({ length: SAMPLE_COUNT }, () => ({
            push: RECIPIENT_COUNT,
            email: RECIPIENT_COUNT,
            sms: RECIPIENT_COUNT,
          })),
        );
        expect(activationSamples).toHaveLength(SAMPLE_COUNT);
        expect(outboxToEnqueueSamples).toHaveLength(SAMPLE_COUNT);
        expect(combinedSamples).toHaveLength(SAMPLE_COUNT);

        // Nearest-rank p95 uses every recorded sample: no retry, warm-up, or
        // outlier is removed before enforcing any of the three budgets.
        const activationP95 = nearestRankP95(activationSamples);
        const outboxToEnqueueP95 = nearestRankP95(outboxToEnqueueSamples);
        const combinedP95 = nearestRankP95(combinedSamples);
        console.info(
          `[issue-30 synthetic SLO] samples=${SAMPLE_COUNT} recipients=${RECIPIENT_COUNT} channels=${CHANNEL_COUNT} work_items_per_sample=${WORK_ITEMS_PER_SAMPLE} activation_p95_ms=${activationP95.toFixed(2)} outbox_to_enqueue_p95_ms=${outboxToEnqueueP95.toFixed(2)} combined_p95_ms=${combinedP95.toFixed(2)}`,
        );
        expect(activationP95).toBeLessThan(ACTIVATION_P95_LIMIT_MILLISECONDS);
        expect(outboxToEnqueueP95).toBeLessThan(
          OUTBOX_TO_ENQUEUE_P95_LIMIT_MILLISECONDS,
        );
        expect(combinedP95).toBeLessThan(COMBINED_P95_LIMIT_MILLISECONDS);
        console.info(
          `${SLO_SUCCESS_PREFIX} samples=${SAMPLE_COUNT} work_items_per_sample=${WORK_ITEMS_PER_SAMPLE} activation_p95_ms=${activationP95.toFixed(2)} outbox_to_enqueue_p95_ms=${outboxToEnqueueP95.toFixed(2)} combined_p95_ms=${combinedP95.toFixed(2)}`,
        );
      });
    },
  );
} else {
  const testWithDatabase = testDatabaseUrl === undefined ? test.skip : test;

  describe('synthetic activation-to-enqueue SLO process gate', () => {
    test('CI cannot silently skip the 40-sample SLO path', () => {
      if (process.env.CI === 'true') {
        expect(testDatabaseUrl).toBeTruthy();
      }
    });

    testWithDatabase(
      'runs the 40-sample measurement once in a fresh Bun process',
      () => {
        const existingResult = recordedSloGateResult();
        if (existingResult !== null) {
          console.info(existingResult);
          return;
        }
        const databaseUrl = validatedSyntheticTestDatabaseUrl(testDatabaseUrl);
        // Block this Bun test process while the one measured child runs. An
        // async wait permits unrelated files to consume CPU during wall-clock
        // samples and would make the regression gate measure the test runner.
        const child = Bun.spawnSync({
          cmd: [process.execPath, 'test', '--timeout=180000', testFilePath],
          cwd: workspaceRoot,
          env: sloChildEnvironment(databaseUrl),
          timeout: 210_000,
          stdout: 'pipe',
          stderr: 'inherit',
        });
        if (child.exitedDueToTimeout === true) {
          throw new Error('The isolated synthetic SLO process timed out.');
        }
        if (!child.success || child.exitCode !== 0) {
          throw new Error('The isolated synthetic SLO process failed.');
        }
        const successLines = child.stdout
          .toString()
          .split('\n')
          .filter((line) => line.startsWith(SLO_SUCCESS_PREFIX));
        expect(successLines).toHaveLength(1);
        const successLine = successLines[0];
        if (successLine === undefined) {
          throw new Error('The isolated synthetic SLO result is unavailable.');
        }
        recordSloGateResult(successLine);
        console.info(successLine);
      },
      240_000,
    );
  });
}
