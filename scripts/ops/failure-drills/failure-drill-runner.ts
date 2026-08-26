import { randomUUID } from 'node:crypto';

import {
  DescribeAlarmsCommand,
  CloudWatchClient,
  type StateValue,
} from '@aws-sdk/client-cloudwatch';
import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
} from '@aws-sdk/client-ecs';
import {
  DescribeDBClustersCommand,
  FailoverDBClusterCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import {
  ChannelAttemptSchema,
  EndpointSchema,
  type ChannelAttempt,
  type DispatchBatch,
  type Endpoint,
} from '@psd-eoc/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { createDatabaseClient } from '../../../packages/server/db/client';
import { seedDatabase } from '../../../packages/server/db/seed';
import {
  channelAttemptExecutions,
  channelAttempts,
  deliveryEvidence,
  events,
  outbox,
  rosterEndpoints,
  sessions,
} from '../../../packages/server/db/schema';
import { createDrizzleDeliveryEvidenceStore } from '../../../packages/server/app/api/internal/delivery-state/runtime';
import {
  DrizzleSessionStore,
  SessionService,
  createDrizzleSessionCapabilityStore,
  executeRevokeSessionCapability,
  type AuthenticatedSession,
} from '../../../packages/server/lib/auth/sessions';
import { WEB_SESSION_COOKIE_NAME } from '../../../packages/server/lib/auth/sessions';
import {
  createDrizzleOutboxDispatcherStore,
  dispatchOutbox,
  serializeDispatchQueueEntries,
  type DispatchBatchQueue,
} from '../../../packages/server/lib/notify/dispatcher';
import {
  FAILURE_DRILL_SCENARIO_IDS,
  assertSuccessfulFailureDrillManifest,
  parseFocusedFailureDrillResult,
  reconcileSideEffects,
  type FailureDrillAlarmObservation,
  type FailureDrillManifest,
  type FailureDrillInvariantEvidence,
  type FailureDrillInvariantId,
  type FailureDrillScenarioEvidence,
  type FailureDrillScenarioId,
  type FocusedFailureDrillResult,
} from './contract';

const POLL_MILLISECONDS = 5_000;
const RECOVERY_TIMEOUT_MILLISECONDS = 15 * 60_000;

type ScenarioInvariants = Readonly<
  Record<FailureDrillInvariantId, FailureDrillInvariantEvidence>
>;

function preserved(
  ...evidence: readonly string[]
): FailureDrillInvariantEvidence {
  if (evidence.length === 0) throw new Error('Invariant evidence is required.');
  return Object.freeze({ status: 'preserved' as const, evidence });
}

function notApplicable(reason: string): FailureDrillInvariantEvidence {
  return Object.freeze({
    status: 'not-applicable' as const,
    evidence: Object.freeze([reason]),
  });
}

function nonLifecycleInvariants(
  appendOnlyEvidence: string,
  classificationEvidence: string,
): ScenarioInvariants {
  return Object.freeze({
    appendOnlyHistory: preserved(appendOnlyEvidence),
    authorization: notApplicable(
      'This transport-only scenario invokes no human or session capability.',
    ),
    classification: preserved(classificationEvidence),
    honestUnknown: notApplicable(
      'This scenario has a determinate transport result and creates no unknown outcome.',
    ),
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required by the failure-drill runner.`);
  return value;
}

function assertSafetyBoundary(): void {
  const exact = {
    PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS: 'non-production',
    PSD_EOC_FAILURE_DRILL_PROVIDER_MODE: 'mocked',
    PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION: 'synthetic',
  } as const;
  for (const [name, expected] of Object.entries(exact)) {
    if (requiredEnvironment(name) !== expected) {
      throw new Error(`${name} must remain ${expected}.`);
    }
  }
  if (requiredEnvironment('GOOGLE_OIDC_HOSTED_DOMAIN') !== 'example.invalid') {
    throw new Error('Failure-drill identities must remain unroutable.');
  }
  for (const forbidden of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) {
    // ECS task credentials arrive through the container metadata endpoint. A
    // static credential in the process is never part of this drill contract.
    if (Object.hasOwn(process.env, forbidden)) {
      throw new Error(`Static ${forbidden} is forbidden in the drill task.`);
    }
  }
}

function remoteIntegrationTestEnvironment(): Record<string, string> {
  const url = new URL('postgresql://synthetic.invalid/synthetic');
  url.hostname = requiredEnvironment('DATABASE_HOST');
  url.port = requiredEnvironment('DATABASE_PORT');
  url.username = requiredEnvironment('DATABASE_ADMIN_USERNAME');
  url.password = requiredEnvironment('DATABASE_ADMIN_PASSWORD');
  url.pathname = `/${syntheticTestDatabaseName()}`;
  url.searchParams.set('sslmode', 'verify-full');
  return {
    ...process.env,
    NODE_ENV: 'test',
    NODE_EXTRA_CA_CERTS: requiredEnvironment('DATABASE_SSL_ROOT_CERT'),
    PSD_EOC_ALLOW_REMOTE_TEST_DATABASE: 'true',
    TEST_DATABASE_URL: url.toString(),
  } as Record<string, string>;
}

function syntheticTestDatabaseName(): string {
  const runId = requiredEnvironment('PSD_EOC_FAILURE_DRILL_RUN_ID');
  const name = `failure_drill_${runId.replaceAll('-', '_')}_test`;
  if (!/^[a-z][a-z0-9_]{1,57}_test$/u.test(name)) {
    throw new Error('The failure-drill test database name is invalid.');
  }
  return name;
}

async function createSyntheticTestDatabase(): Promise<void> {
  const connection = createDatabaseClient({
    connectTimeoutSeconds: 10,
    database: requiredEnvironment('DATABASE_NAME'),
    driver: 'postgres',
    host: requiredEnvironment('DATABASE_HOST'),
    idleTimeoutSeconds: 0,
    maxConnections: 1,
    password: requiredEnvironment('DATABASE_ADMIN_PASSWORD'),
    port: Number(requiredEnvironment('DATABASE_PORT')),
    sslRootCertificatePath: requiredEnvironment('DATABASE_SSL_ROOT_CERT'),
    username: requiredEnvironment('DATABASE_ADMIN_USERNAME'),
  });
  if (
    connection.driver !== 'postgres' ||
    connection.nativeClient === undefined
  ) {
    throw new Error('Failure drills require native PostgreSQL administration.');
  }
  const name = syntheticTestDatabaseName();
  try {
    const existing = await connection.nativeClient<
      readonly { exists: boolean }[]
    >`
      select exists(select 1 from pg_database where datname = ${name}) as exists
    `;
    if (existing[0]?.exists !== false) {
      throw new Error(
        'The exact one-run synthetic test database already exists.',
      );
    }
    await connection.nativeClient.unsafe(`create database "${name}"`);
  } finally {
    await connection.close();
  }
}

async function runFocusedTest(
  path: string,
  pattern: string,
  databaseBacked = false,
  captureScenario?: FailureDrillScenarioId,
): Promise<FocusedFailureDrillResult | undefined> {
  const baseEnvironment = databaseBacked
    ? remoteIntegrationTestEnvironment()
    : (process.env as Record<string, string>);
  const child = Bun.spawn({
    cmd: ['bun', 'test', path, '--test-name-pattern', pattern],
    env:
      captureScenario === undefined
        ? baseEnvironment
        : {
            ...baseEnvironment,
            PSD_EOC_FAILURE_DRILL_CAPTURE_SCENARIO: captureScenario,
          },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = `${stdout}\n${stderr}`;
  if (
    exitCode !== 0 ||
    !/\b[1-9]\d* pass\b/u.test(output) ||
    /\(skip\)/u.test(output)
  ) {
    console.error(
      JSON.stringify({
        kind: 'failure-drill-focused-test-failed',
        path,
        pattern,
        stderrTail: stderr.slice(-1_000),
        stdoutTail: stdout.slice(-1_000),
      }),
    );
    throw new Error(
      'A focused failure-recovery assertion failed, skipped, or ran no matching test.',
    );
  }
  return captureScenario === undefined
    ? undefined
    : parseFocusedFailureDrillResult(output, captureScenario);
}

function databaseConnection() {
  return createDatabaseClient({
    connectTimeoutSeconds: 10,
    database: requiredEnvironment('DATABASE_NAME'),
    driver: 'postgres',
    host: requiredEnvironment('DATABASE_HOST'),
    idleTimeoutSeconds: 0,
    maxConnections: 1,
    password: requiredEnvironment('DATABASE_PASSWORD'),
    port: Number(requiredEnvironment('DATABASE_PORT')),
    sslRootCertificatePath: requiredEnvironment('DATABASE_SSL_ROOT_CERT'),
    username: requiredEnvironment('DATABASE_USERNAME'),
  });
}

interface DeployedScenarioFixture {
  readonly authenticated: AuthenticatedSession;
  readonly sessionCredential: string;
  readonly eventId: string;
  readonly emailWorkerItems: readonly DeployedWorkerItem[];
  readonly callbackItem: DeployedWorkerItem;
  readonly dlqItem: DeployedWorkerItem;
  readonly revokedDeviceItem: DeployedWorkerItem;
}

type DeployedWorkerItem = Readonly<{
  batch: DispatchBatch;
  attempt: ChannelAttempt;
  endpoint: Endpoint;
}>;

class CapturingDispatchQueue implements DispatchBatchQueue {
  public batches: readonly DispatchBatch[] = [];

  public send(batches: readonly DispatchBatch[]) {
    this.batches = [...batches];
    return Promise.resolve(
      serializeDispatchQueueEntries(batches).map((entry, index) => ({
        entryId: entry.id,
        messageId: `synthetic-dispatch-${String(index + 1)}`,
      })),
    );
  }
}

function endpointFromRow(row: typeof rosterEndpoints.$inferSelect): Endpoint {
  return EndpointSchema.parse({
    id: row.id,
    status: row.status,
    capturedAt: row.capturedAt.toISOString(),
    channel: row.channel,
    ...(row.channel === 'push'
      ? { platform: row.platform, token: row.token }
      : row.channel === 'email'
        ? { email: row.email }
        : { phoneNumber: row.phoneNumber }),
  });
}

function attemptFor(
  batch: DispatchBatch,
  endpoint: typeof rosterEndpoints.$inferSelect,
  attemptNumber: number,
): ChannelAttempt {
  return ChannelAttemptSchema.parse({
    id: randomUUID(),
    batchId: batch.id,
    intentId: batch.intentId,
    eventId: batch.eventId,
    eventKind: batch.eventKind,
    templateMode: batch.templateMode,
    purpose: batch.purpose,
    eventTypeVersion: batch.eventTypeVersion,
    rosterSnapshotId: batch.rosterSnapshotId,
    rosterPopulation: batch.rosterPopulation,
    recipientId: endpoint.recipientId,
    endpointId: endpoint.id,
    channel: batch.channel,
    attemptNumber,
    attemptedAt: new Date().toISOString(),
  });
}

async function createDeployedScenarioFixture(): Promise<DeployedScenarioFixture> {
  const applicationOrigin = requiredEnvironment(
    'PSD_EOC_FAILURE_DRILL_APP_ORIGIN',
  );
  const response = await fetch(
    `${applicationOrigin}/api/failure-drills/session`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requiredEnvironment('PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN')}`,
        Origin: applicationOrigin,
      },
    },
  );
  if (response.status !== 201) {
    throw new Error('The deployed synthetic session fixture was refused.');
  }
  const setup = (await response.json()) as Readonly<{
    applicationOrigin?: unknown;
    eventPath?: unknown;
  }>;
  if (
    setup.applicationOrigin !== applicationOrigin ||
    typeof setup.eventPath !== 'string' ||
    !/^\/events\/[0-9a-f-]{36}$/u.test(setup.eventPath)
  ) {
    throw new Error('The deployed synthetic session fixture was invalid.');
  }
  const sessionCookiePattern = new RegExp(
    `(?:^|[,;]\\s*)${WEB_SESSION_COOKIE_NAME}=([^;,]+)`,
    'u',
  );
  const sessionCookie = sessionCookiePattern.exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  if (sessionCookie === undefined) {
    throw new Error('The deployed synthetic session omitted its credential.');
  }
  const sessionCredential = decodeURIComponent(sessionCookie);
  const eventId = setup.eventPath.slice('/events/'.length);
  const connection = databaseConnection();
  if (connection.driver !== 'postgres') {
    throw new Error('The deployed fixture requires PostgreSQL.');
  }
  try {
    const sessionService = new SessionService(
      new DrizzleSessionStore(connection.db),
    );
    const authenticated = await sessionService.authenticate(
      sessionCredential,
      'web',
      new Date(),
    );
    const [outboxRow] = await connection.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.eventId, eventId))
      .limit(1);
    if (outboxRow === undefined) {
      throw new Error('The deployed synthetic event omitted its outbox.');
    }
    const queue = new CapturingDispatchQueue();
    await dispatchOutbox(outboxRow.id, {
      store: createDrizzleOutboxDispatcherStore(connection.db),
      queue,
    });
    const emailBatch = queue.batches.find((batch) => batch.channel === 'email');
    const pushBatch = queue.batches.find((batch) => batch.channel === 'push');
    if (emailBatch === undefined || pushBatch === undefined) {
      throw new Error('The deployed synthetic event omitted a mock channel.');
    }
    const endpoints = await connection.db
      .select()
      .from(rosterEndpoints)
      .where(eq(rosterEndpoints.rosterSnapshotId, emailBatch.rosterSnapshotId));
    const emailEndpoints = endpoints.filter(
      (endpoint) =>
        endpoint.channel === 'email' && endpoint.status === 'active',
    );
    const pushEndpoint = endpoints.find(
      (endpoint) => endpoint.channel === 'push' && endpoint.status === 'active',
    );
    if (emailEndpoints.length < 2 || pushEndpoint === undefined) {
      throw new Error('The deployed synthetic roster omitted mock endpoints.');
    }
    const fanoutEndpoints = emailEndpoints.slice(0, 2);
    const emailWorkerItems = fanoutEndpoints.map((endpoint) =>
      Object.freeze({
        batch: emailBatch,
        attempt: attemptFor(emailBatch, endpoint, 1),
        endpoint: endpointFromRow(endpoint),
      }),
    );
    const callbackEndpoint = emailEndpoints[0]!;
    const callbackAttempt = attemptFor(emailBatch, callbackEndpoint, 2);
    const dlqEndpoint = emailEndpoints[1]!;
    const dlqAttempt = attemptFor(emailBatch, dlqEndpoint, 2);
    const revokedDeviceAttempt = attemptFor(pushBatch, pushEndpoint, 1);
    const evidenceStore = createDrizzleDeliveryEvidenceStore(connection.db);
    for (const attempt of [callbackAttempt, dlqAttempt]) {
      await evidenceStore.recordAttemptEvidence({
        attempt,
        evidence: {
          subject: { kind: 'attempt', attemptId: attempt.id },
          state: 'attempted',
          provider: null,
          providerReference: null,
          proof: null,
          reasonCode: null,
          diagnosticDigest: null,
        },
      });
    }
    return Object.freeze({
      authenticated,
      sessionCredential,
      eventId,
      emailWorkerItems: Object.freeze(emailWorkerItems),
      callbackItem: Object.freeze({
        batch: emailBatch,
        attempt: callbackAttempt,
        endpoint: endpointFromRow(callbackEndpoint),
      }),
      dlqItem: Object.freeze({
        batch: emailBatch,
        attempt: dlqAttempt,
        endpoint: endpointFromRow(dlqEndpoint),
      }),
      revokedDeviceItem: Object.freeze({
        batch: pushBatch,
        attempt: revokedDeviceAttempt,
        endpoint: endpointFromRow(pushEndpoint),
      }),
    });
  } finally {
    await connection.close();
  }
}

interface DeployedWorkerResult {
  readonly taskArn: string;
  readonly exitCode: number;
  readonly stoppedReason: string;
}

function ecsClient(): ECSClient {
  return new ECSClient({
    region: requiredEnvironment('AWS_REGION'),
    maxAttempts: 3,
  });
}

async function startDeployedWorker(
  workerMode: 'crash-after-provider' | 'recover-after-crash' | 'revoked-device',
  workItems: readonly DeployedWorkerItem[],
  session?: Readonly<{ id: string; credential: string }>,
): Promise<string> {
  const client = ecsClient();
  try {
    const environment = [
      {
        name: 'PSD_EOC_FAILURE_DRILL_WORKER_MODE',
        value: workerMode,
      },
      {
        name: 'PSD_EOC_FAILURE_DRILL_WORK_ITEM',
        value: JSON.stringify(workItems),
      },
      ...(session === undefined
        ? []
        : [
            {
              name: 'PSD_EOC_FAILURE_DRILL_SESSION_ID',
              value: session.id,
            },
            {
              name: 'PSD_EOC_FAILURE_DRILL_SESSION_CREDENTIAL',
              value: session.credential,
            },
          ]),
    ];
    const result = await client.send(
      new RunTaskCommand({
        cluster: requiredEnvironment('PSD_EOC_FAILURE_DRILL_CLUSTER_ARN'),
        taskDefinition: requiredEnvironment(
          'PSD_EOC_FAILURE_DRILL_WORKER_TASK_DEFINITION',
        ),
        launchType: 'FARGATE',
        platformVersion: 'LATEST',
        count: 1,
        startedBy: `drill-${workerMode}-${Date.now()}`.slice(0, 36),
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'DISABLED',
            securityGroups: [
              requiredEnvironment('PSD_EOC_FAILURE_DRILL_SECURITY_GROUP_ID'),
            ],
            subnets: requiredEnvironment(
              'PSD_EOC_FAILURE_DRILL_SUBNET_IDS',
            ).split(','),
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: 'failure-drill-worker',
              environment,
            },
          ],
        },
      }),
    );
    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn || (result.failures?.length ?? 0) > 0) {
      throw new Error('The exact deployed mock worker task did not start.');
    }
    return taskArn;
  } finally {
    client.destroy();
  }
}

async function waitForDeployedWorker(
  taskArn: string,
): Promise<DeployedWorkerResult> {
  const client = ecsClient();
  try {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const response = await client.send(
        new DescribeTasksCommand({
          cluster: requiredEnvironment('PSD_EOC_FAILURE_DRILL_CLUSTER_ARN'),
          tasks: [taskArn],
        }),
      );
      const task = response.tasks?.[0];
      if (task?.lastStatus === 'STOPPED') {
        const exitCode = task.containers?.[0]?.exitCode;
        if (exitCode === undefined) {
          throw new Error('The deployed mock worker omitted its exit code.');
        }
        return {
          taskArn,
          exitCode,
          stoppedReason: task.stoppedReason ?? 'unspecified',
        };
      }
      await Bun.sleep(2_000);
    }
    throw new Error(
      'The deployed mock worker did not stop before its deadline.',
    );
  } finally {
    client.destroy();
  }
}

async function attemptEvidenceStates(
  attemptId: string,
): Promise<
  readonly Readonly<{ id: string; sequence: number; state: string }>[]
> {
  const connection = databaseConnection();
  try {
    return await connection.db
      .select({
        id: deliveryEvidence.id,
        sequence: deliveryEvidence.sequence,
        state: deliveryEvidence.state,
      })
      .from(deliveryEvidence)
      .where(eq(deliveryEvidence.attemptId, attemptId))
      .orderBy(asc(deliveryEvidence.sequence));
  } finally {
    await connection.close();
  }
}

async function authenticateFixtureSession(): Promise<AuthenticatedSession> {
  const connection = databaseConnection();
  try {
    return await new SessionService(
      new DrizzleSessionStore(connection.db),
    ).authenticate(fixture().sessionCredential, 'web', new Date());
  } finally {
    await connection.close();
  }
}

async function seedSyntheticFixtures(): Promise<void> {
  const connection = createDatabaseClient({
    connectTimeoutSeconds: 10,
    database: requiredEnvironment('DATABASE_NAME'),
    driver: 'postgres',
    host: requiredEnvironment('DATABASE_HOST'),
    idleTimeoutSeconds: 0,
    maxConnections: 1,
    password: requiredEnvironment('DATABASE_ADMIN_PASSWORD'),
    port: Number(requiredEnvironment('DATABASE_PORT')),
    sslRootCertificatePath: requiredEnvironment('DATABASE_SSL_ROOT_CERT'),
    username: requiredEnvironment('DATABASE_ADMIN_USERNAME'),
  });
  try {
    await seedDatabase(connection.db);
  } finally {
    await connection.close();
  }
}

async function journalCount(): Promise<number> {
  const connection = databaseConnection();
  if (connection.driver !== 'postgres') {
    throw new Error('Failure drills require native PostgreSQL.');
  }
  const nativeClient = connection.nativeClient;
  if (nativeClient === undefined) {
    throw new Error('Failure drills require a native PostgreSQL client.');
  }
  try {
    const rows = await nativeClient<readonly { count: string }[]>`
      select count(*)::text as count from journal_entries
    `;
    return Number(rows[0]?.count ?? Number.NaN);
  } finally {
    await connection.close();
  }
}

async function auroraWriter(
  client: RDSClient,
  identifier: string,
): Promise<Readonly<{ status: string; writer: string }>> {
  const result = await client.send(
    new DescribeDBClustersCommand({ DBClusterIdentifier: identifier }),
  );
  const cluster = result.DBClusters?.[0];
  const writer = cluster?.DBClusterMembers?.find(
    (member) => member.IsClusterWriter === true,
  )?.DBInstanceIdentifier;
  if (!cluster?.Status || !writer) {
    throw new Error('The synthetic Aurora writer could not be resolved.');
  }
  return { status: cluster.Status, writer };
}

function alarmName(suffix: string): string {
  return `psd-eoc-drill-${requiredEnvironment('PSD_EOC_FAILURE_DRILL_RUN_ID')}-${suffix}`;
}

async function alarmObservation(
  client: CloudWatchClient,
  name: string,
  phase: FailureDrillAlarmObservation['phase'],
): Promise<FailureDrillAlarmObservation> {
  const response = await client.send(
    new DescribeAlarmsCommand({ AlarmNames: [name] }),
  );
  const alarm = response.MetricAlarms?.[0];
  if (
    alarm?.AlarmName !== name ||
    !['OK', 'ALARM', 'INSUFFICIENT_DATA'].includes(String(alarm.StateValue)) ||
    alarm.StateUpdatedTimestamp === undefined
  ) {
    throw new Error(`CloudWatch alarm ${name} could not be observed exactly.`);
  }
  return Object.freeze({
    alarmName: name,
    state: alarm.StateValue as Exclude<StateValue, undefined>,
    phase,
    observedAt: new Date().toISOString(),
    stateUpdatedAt: alarm.StateUpdatedTimestamp.toISOString(),
  });
}

async function waitForAlarmState(
  client: CloudWatchClient,
  name: string,
  state: 'OK' | 'ALARM',
  phase: FailureDrillAlarmObservation['phase'],
): Promise<FailureDrillAlarmObservation> {
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    const observed = await alarmObservation(client, name, phase);
    if (observed.state === state) return observed;
    await Bun.sleep(10_000);
  }
  throw new Error(`CloudWatch alarm ${name} did not reach ${state}.`);
}

async function runAuroraFailover(): Promise<
  Readonly<{
    alarms: readonly FailureDrillAlarmObservation[];
    facts: Readonly<Record<string, string | number | boolean>>;
  }>
> {
  const region = requiredEnvironment('AWS_REGION');
  const identifier = requiredEnvironment(
    'PSD_EOC_FAILURE_DRILL_CLUSTER_IDENTIFIER',
  );
  const client = new RDSClient({ region, maxAttempts: 3 });
  const cloudWatch = new CloudWatchClient({ region, maxAttempts: 3 });
  const beforeJournalCount = await journalCount();
  const before = await auroraWriter(client, identifier);
  const alarms = [
    await alarmObservation(cloudWatch, alarmName('aurora-acu'), 'before'),
    await alarmObservation(cloudWatch, alarmName('apprunner-5xx'), 'before'),
  ];
  await client.send(
    new FailoverDBClusterCommand({ DBClusterIdentifier: identifier }),
  );
  const transitions = [`${before.status}:${before.writer}`];
  const deadline = Date.now() + RECOVERY_TIMEOUT_MILLISECONDS;
  let recovered: Awaited<ReturnType<typeof auroraWriter>> | undefined;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MILLISECONDS);
    const current = await auroraWriter(client, identifier);
    const transition = `${current.status}:${current.writer}`;
    if (transitions.at(-1) !== transition) transitions.push(transition);
    if (current.status === 'available' && current.writer !== before.writer) {
      recovered = current;
      break;
    }
  }
  if (recovered === undefined) {
    client.destroy();
    cloudWatch.destroy();
    throw new Error('Synthetic Aurora did not recover before the deadline.');
  }
  const afterJournalCount = await journalCount();
  if (afterJournalCount !== beforeJournalCount) {
    throw new Error('Aurora failover changed append-only journal cardinality.');
  }
  const health = await fetch(
    `${requiredEnvironment('PSD_EOC_FAILURE_DRILL_APP_ORIGIN')}/api/health`,
  );
  if (!health.ok) {
    throw new Error('App Runner did not recover after Aurora failover.');
  }
  alarms.push(
    await alarmObservation(cloudWatch, alarmName('aurora-acu'), 'after'),
    await alarmObservation(cloudWatch, alarmName('apprunner-5xx'), 'after'),
  );
  client.destroy();
  cloudWatch.destroy();
  return {
    alarms,
    facts: {
      appRunnerHealthStatus: health.status,
      afterJournalCount,
      beforeJournalCount,
      beforeWriter: before.writer,
      recoveredStatus: recovered.status,
      recoveredWriter: recovered.writer,
      writerTransitions: transitions.join(' -> '),
    },
  };
}

async function queueVisible(client: SQSClient, queueUrl: string) {
  const result = await client.send(
    new GetQueueAttributesCommand({
      AttributeNames: ['ApproximateNumberOfMessages'],
      QueueUrl: queueUrl,
    }),
  );
  return Number(result.Attributes?.ApproximateNumberOfMessages ?? '0');
}

async function waitForQueue(
  client: SQSClient,
  queueUrl: string,
  predicate: (count: number) => boolean,
): Promise<number> {
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const count = await queueVisible(client, queueUrl);
    if (predicate(count)) return count;
    await Bun.sleep(2_000);
  }
  throw new Error(
    'Synthetic queue state did not converge before the deadline.',
  );
}

async function runDlqRedrive(): Promise<
  Readonly<{
    expectedId: string;
    observedId: string;
    alarms: readonly FailureDrillAlarmObservation[];
    facts: Readonly<Record<string, string | number | boolean>>;
  }>
> {
  const item = fixture().dlqItem;
  const connection = databaseConnection();
  let persisted:
    | Readonly<{
        attemptId: string;
        endpointId: string;
        eventId: string;
      }>
    | undefined;
  try {
    [persisted] = await connection.db
      .select({
        attemptId: channelAttempts.id,
        endpointId: rosterEndpoints.id,
        eventId: channelAttempts.eventId,
      })
      .from(channelAttempts)
      .innerJoin(
        rosterEndpoints,
        and(
          eq(rosterEndpoints.id, channelAttempts.endpointId),
          eq(
            rosterEndpoints.rosterSnapshotId,
            channelAttempts.rosterSnapshotId,
          ),
          eq(rosterEndpoints.recipientId, channelAttempts.recipientId),
        ),
      )
      .where(eq(channelAttempts.id, item.attempt.id))
      .limit(1);
  } finally {
    await connection.close();
  }
  if (
    persisted === undefined ||
    persisted.attemptId !== item.attempt.id ||
    persisted.endpointId !== item.attempt.endpointId ||
    persisted.eventId !== item.attempt.eventId ||
    item.endpoint.channel !== 'email' ||
    !item.endpoint.email.endsWith('@example.invalid')
  ) {
    throw new Error(
      'The synthetic DLQ work did not resolve to a durable unroutable endpoint.',
    );
  }
  const region = requiredEnvironment('AWS_REGION');
  const client = new SQSClient({
    region,
    maxAttempts: 3,
  });
  const cloudWatch = new CloudWatchClient({ region, maxAttempts: 3 });
  const emailDlqAlarmName = alarmName('dlq-2');
  const alarmBefore = await waitForAlarmState(
    cloudWatch,
    emailDlqAlarmName,
    'OK',
    'before',
  );
  const deadLetterQueueUrl = requiredEnvironment('EMAIL_DEAD_LETTER_QUEUE_URL');
  const sourceQueueUrl = requiredEnvironment('EMAIL_QUEUE_URL');
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      AttributeNames: ['QueueArn'],
      QueueUrl: deadLetterQueueUrl,
    }),
  );
  const deadLetterQueueArn = attributes.Attributes?.QueueArn;
  if (!deadLetterQueueArn) throw new Error('Synthetic DLQ ARN is unavailable.');
  const runId = requiredEnvironment('PSD_EOC_FAILURE_DRILL_RUN_ID');
  const attemptId = persisted.attemptId;
  const endpointId = persisted.endpointId;
  const sent = await client.send(
    new SendMessageCommand({
      MessageBody: JSON.stringify({
        attemptId,
        classification: 'synthetic',
        destination: item.endpoint.email,
        endpointId,
        eventId: persisted.eventId,
        kind: 'failure-drill-redrive',
        runId,
      }),
      QueueUrl: deadLetterQueueUrl,
    }),
  );
  const messageId = sent.MessageId;
  if (!messageId) throw new Error('Synthetic DLQ message omitted its ID.');
  await waitForQueue(client, deadLetterQueueUrl, (count) => count >= 1);
  const alarmDuring = await waitForAlarmState(
    cloudWatch,
    emailDlqAlarmName,
    'ALARM',
    'during',
  );
  await client.send(
    new StartMessageMoveTaskCommand({ SourceArn: deadLetterQueueArn }),
  );
  await waitForQueue(client, sourceQueueUrl, (count) => count >= 1);
  const received = await client.send(
    new ReceiveMessageCommand({
      MaxNumberOfMessages: 1,
      QueueUrl: sourceQueueUrl,
      WaitTimeSeconds: 10,
    }),
  );
  const moved = received.Messages?.[0];
  if (!moved?.MessageId || !moved.ReceiptHandle || !moved.Body) {
    throw new Error(
      'DLQ redrive did not return one complete synthetic message.',
    );
  }
  const body: unknown = JSON.parse(moved.Body);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('attemptId' in body) ||
    body.attemptId !== attemptId ||
    !('endpointId' in body) ||
    body.endpointId !== endpointId ||
    !('eventId' in body) ||
    body.eventId !== persisted.eventId
  ) {
    throw new Error(
      'DLQ redrive changed the immutable attempt or endpoint identity.',
    );
  }
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: sourceQueueUrl,
      ReceiptHandle: moved.ReceiptHandle,
    }),
  );
  await waitForQueue(client, sourceQueueUrl, (count) => count === 0);
  await waitForQueue(client, deadLetterQueueUrl, (count) => count === 0);
  const alarmAfter = await waitForAlarmState(
    cloudWatch,
    emailDlqAlarmName,
    'OK',
    'after',
  );
  client.destroy();
  cloudWatch.destroy();
  const evidence = await attemptEvidenceStates(attemptId);
  if (evidence.length !== 1 || evidence[0]?.state !== 'attempted') {
    throw new Error('DLQ reconciliation changed durable attempt evidence.');
  }
  return {
    expectedId: `attempt:${persisted.attemptId}:endpoint:${persisted.endpointId}`,
    observedId: `attempt:${String(body.attemptId)}:endpoint:${String(body.endpointId)}`,
    alarms: [alarmBefore, alarmDuring, alarmAfter],
    facts: {
      attemptId,
      endpointId,
      eventId: persisted.eventId,
      evidenceId: evidence[0].id,
      evidenceState: evidence[0].state,
      originalTransportMessageId: messageId,
      redrivenTransportMessageId: moved.MessageId,
      transportIdentityRetained: moved.MessageId === messageId,
    },
  };
}

let deployedFixture: DeployedScenarioFixture | undefined;

function fixture(): DeployedScenarioFixture {
  if (deployedFixture === undefined) {
    throw new Error('The deployed scenario fixture is unavailable.');
  }
  return deployedFixture;
}

async function runDeployedWorkerTermination(): Promise<ScenarioExecution> {
  const items = fixture().emailWorkerItems;
  if (items.length < 2) {
    throw new Error('Worker termination requires a multi-endpoint fan-out.');
  }
  const beforeJournalCount = await journalCount();
  const crashedTask = await waitForDeployedWorker(
    await startDeployedWorker('crash-after-provider', items),
  );
  if (crashedTask.exitCode !== 86) {
    throw new Error('The injected worker task did not terminate at the fault.');
  }
  await Bun.sleep(2_000);
  const recoveredTask = await waitForDeployedWorker(
    await startDeployedWorker('recover-after-crash', items),
  );
  if (recoveredTask.exitCode !== 0) {
    throw new Error('The replacement worker task did not recover the attempt.');
  }
  const queueUrl = requiredEnvironment(
    'PSD_EOC_FAILURE_DRILL_MOCK_PROVIDER_QUEUE_URL',
  );
  const sqs = new SQSClient({
    region: requiredEnvironment('AWS_REGION'),
    maxAttempts: 3,
  });
  const expectedByAttempt = new Map(
    items.map((item) => [item.attempt.id, item] as const),
  );
  const observedSideEffects: string[] = [];
  const mockProviderMessageIds: string[] = [];
  try {
    const deadline = Date.now() + 2 * 60_000;
    while (
      observedSideEffects.length < expectedByAttempt.size &&
      Date.now() < deadline
    ) {
      const received = await sqs.send(
        new ReceiveMessageCommand({
          MaxNumberOfMessages: 10,
          QueueUrl: queueUrl,
          WaitTimeSeconds: 10,
        }),
      );
      for (const message of received.Messages ?? []) {
        if (!message.Body || !message.MessageId || !message.ReceiptHandle) {
          throw new Error('The FIFO mock provider evidence was incomplete.');
        }
        const body = JSON.parse(message.Body) as Readonly<
          Record<string, unknown>
        >;
        const attemptId = String(body.attemptId);
        const expected = expectedByAttempt.get(attemptId);
        if (
          expected === undefined ||
          body.endpointId !== expected.attempt.endpointId ||
          body.eventId !== expected.attempt.eventId
        ) {
          throw new Error(
            'The mock provider changed an immutable work identity.',
          );
        }
        const identity = `attempt:${attemptId}:endpoint:${String(body.endpointId)}`;
        if (observedSideEffects.includes(identity)) {
          throw new Error('The mock provider exposed a duplicate side effect.');
        }
        observedSideEffects.push(identity);
        mockProviderMessageIds.push(message.MessageId);
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }
    if (observedSideEffects.length !== expectedByAttempt.size) {
      throw new Error(
        'The recovered fan-out did not retain every logical side effect.',
      );
    }
    await waitForQueue(sqs, queueUrl, (count) => count === 0);
    const replay = await sqs.send(
      new ReceiveMessageCommand({
        MaxNumberOfMessages: 10,
        QueueUrl: queueUrl,
        WaitTimeSeconds: 2,
      }),
    );
    if ((replay.Messages?.length ?? 0) !== 0) {
      throw new Error(
        'The replacement worker created a duplicate side effect.',
      );
    }
  } finally {
    sqs.destroy();
  }

  const evidenceSets = await Promise.all(
    items.map((item) => attemptEvidenceStates(item.attempt.id)),
  );
  if (
    evidenceSets.some(
      (evidence) =>
        evidence.length !== 2 ||
        evidence[0]?.state !== 'attempted' ||
        evidence[0]?.sequence !== 1 ||
        evidence[1]?.state !== 'provider-accepted' ||
        evidence[1]?.sequence !== 2,
    )
  ) {
    throw new Error('The recovered worker evidence was not append-only.');
  }
  const connection = databaseConnection();
  const attemptIds = items.map(({ attempt }) => attempt.id);
  let executions: readonly Readonly<{ completedAt: Date | null }>[];
  try {
    executions = await connection.db
      .select({ completedAt: channelAttemptExecutions.completedAt })
      .from(channelAttemptExecutions)
      .where(inArray(channelAttemptExecutions.attemptId, attemptIds));
  } finally {
    await connection.close();
  }
  if (
    executions.length !== items.length ||
    executions.some(({ completedAt }) => completedAt === null)
  ) {
    throw new Error(
      'The replacement worker did not complete every durable lease.',
    );
  }
  const afterJournalCount = await journalCount();
  if (afterJournalCount !== beforeJournalCount) {
    throw new Error('Worker recovery rewrote event journal history.');
  }
  const expectedSideEffects = items.map(
    ({ attempt }) => `attempt:${attempt.id}:endpoint:${attempt.endpointId}`,
  );
  return {
    observation:
      'One ECS worker task terminated after the first endpoint side effect in a multi-endpoint fan-out; a replacement reclaimed that lease and completed the untouched remainder with exactly one logical send per endpoint.',
    alarmTransitions: [],
    expectedSideEffects,
    observedSideEffects,
    invariants: nonLifecycleInvariants(
      `Journal cardinality remained ${String(beforeJournalCount)} and both attempts appended evidence sequences 1 then 2.`,
      `Attempts ${attemptIds.join(',')} remained test/drill/synthetic through both ECS tasks.`,
    ),
    facts: {
      attemptIds: attemptIds.join(','),
      endpointIds: items.map(({ attempt }) => attempt.endpointId).join(','),
      eventId: items[0]!.attempt.eventId,
      crashedTaskArn: crashedTask.taskArn,
      crashedTaskExitCode: crashedTask.exitCode,
      recoveredTaskArn: recoveredTask.taskArn,
      recoveredTaskExitCode: recoveredTask.exitCode,
      mockProviderMessageIds: mockProviderMessageIds.join(','),
      fanoutEndpointCount: items.length,
      logicalSideEffectCount: observedSideEffects.length,
      evidenceSequences: evidenceSets
        .map((evidence) => evidence.map(({ sequence }) => sequence).join(','))
        .join('|'),
    },
  };
}

async function runDeployedCallbackReplay(): Promise<ScenarioExecution> {
  const item = fixture().callbackItem;
  const callbackId = randomUUID();
  const applicationOrigin = requiredEnvironment(
    'PSD_EOC_FAILURE_DRILL_APP_ORIGIN',
  );
  const beforeJournalCount = await journalCount();
  const response = await fetch(
    `${applicationOrigin}/api/failure-drills/callback`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requiredEnvironment('PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN')}`,
        'Content-Type': 'application/json',
        Origin: applicationOrigin,
      },
      body: JSON.stringify({ attemptId: item.attempt.id, callbackId }),
    },
  );
  if (!response.ok) {
    throw new Error('The deployed callback replay route failed safely.');
  }
  const result = (await response.json()) as Readonly<{
    observedSideEffects?: unknown;
    facts?: unknown;
  }>;
  if (
    !Array.isArray(result.observedSideEffects) ||
    !result.observedSideEffects.every((value) => typeof value === 'string') ||
    typeof result.facts !== 'object' ||
    result.facts === null ||
    Array.isArray(result.facts)
  ) {
    throw new Error('The deployed callback route returned invalid evidence.');
  }
  const facts = result.facts as Readonly<Record<string, unknown>>;
  const expectedIdentity = `callback:${callbackId}:attempt:${item.attempt.id}:endpoint:${item.attempt.endpointId}`;
  if (
    facts.callbackId !== callbackId ||
    facts.attemptId !== item.attempt.id ||
    facts.endpointId !== item.attempt.endpointId ||
    result.observedSideEffects.length !== 1
  ) {
    throw new Error(
      'The deployed callback evidence changed an immutable fixture identity.',
    );
  }
  const evidence = await attemptEvidenceStates(item.attempt.id);
  const afterJournalCount = await journalCount();
  if (
    evidence.length !== 2 ||
    evidence[0]?.state !== 'attempted' ||
    evidence[1]?.state !== 'provider-accepted' ||
    beforeJournalCount !== afterJournalCount
  ) {
    throw new Error('The deployed callback replay changed durable history.');
  }
  return {
    observation:
      'The deployed drill callback route replayed one exact synthetic callback through the production handler and retained one capability write.',
    alarmTransitions: [],
    expectedSideEffects: [expectedIdentity],
    observedSideEffects: result.observedSideEffects,
    invariants: {
      appendOnlyHistory: preserved(
        `Callback attempt evidence appended sequences ${evidence.map(({ sequence }) => sequence).join(',')} while journal cardinality remained ${String(beforeJournalCount)}.`,
      ),
      authorization: preserved(
        'The drill-only bearer and exact App Runner origin authorized the outer route; the production webhook capability authorized only the synthetic system callback.',
      ),
      classification: preserved(
        `Callback attempt ${item.attempt.id} remained test/drill/synthetic email work.`,
      ),
      honestUnknown: preserved(
        'The exact replay appended no second provider-accepted claim and did not invent a delivery outcome.',
      ),
    },
    facts: facts as Readonly<Record<string, string | number | boolean>>,
  };
}

async function runDeployedIdpOutage(): Promise<ScenarioExecution> {
  const item = fixture();
  const beforeJournalCount = await journalCount();
  if (process.env.GOOGLE_OAUTH_CONFIG !== undefined) {
    throw new Error('The runner unexpectedly received an IdP credential.');
  }
  const connection = databaseConnection();
  try {
    const authenticated = await new SessionService(
      new DrizzleSessionStore(connection.db),
    ).authenticate(item.sessionCredential, 'web', new Date());
    const [event] = await connection.db
      .select({
        kind: events.kind,
        rosterPopulation: events.rosterPopulation,
        templateMode: events.templateMode,
      })
      .from(events)
      .where(eq(events.id, item.eventId))
      .limit(1);
    const afterJournalCount = await journalCount();
    if (
      authenticated.result.session.id !==
        item.authenticated.result.session.id ||
      event?.kind !== 'drill' ||
      event.templateMode !== 'drill' ||
      event.rosterPopulation !== 'synthetic' ||
      beforeJournalCount !== afterJournalCount
    ) {
      throw new Error('Retained IdP-outage authorization diverged.');
    }
    return {
      observation:
        'A second deployed process authenticated the existing synthetic session from retained group membership with no Google credential or network call.',
      alarmTransitions: [],
      expectedSideEffects: [],
      observedSideEffects: [],
      invariants: {
        appendOnlyHistory: preserved(
          `Journal cardinality remained ${String(beforeJournalCount)} during retained-membership authentication.`,
        ),
        authorization: preserved(
          `Session ${authenticated.result.session.id} authenticated from ${authenticated.membershipState} retained membership without an IdP credential.`,
        ),
        classification: preserved(
          `Event ${item.eventId} remained drill/drill/synthetic.`,
        ),
        honestUnknown: preserved(
          'The outage check made no provider or delivery claim; it proved only retained session authorization.',
        ),
      },
      facts: {
        eventId: item.eventId,
        sessionId: authenticated.result.session.id,
        membershipState: authenticated.membershipState,
        googleCredentialPresent: false,
        journalCount: beforeJournalCount,
      },
    };
  } finally {
    await connection.close();
  }
}

async function runDeployedDeviceRevocation(): Promise<ScenarioExecution> {
  const item = fixture().revokedDeviceItem;
  const sessionId = fixture().authenticated.result.session.id;
  const beforeJournalCount = await journalCount();
  const taskArn = await startDeployedWorker('revoked-device', [item], {
    id: sessionId,
    credential: fixture().sessionCredential,
  });
  const deadline = Date.now() + 2 * 60_000;
  for (;;) {
    const evidence = await attemptEvidenceStates(item.attempt.id);
    if (evidence.some(({ state }) => state === 'attempted')) break;
    if (Date.now() >= deadline) {
      throw new Error(
        'The deployed worker did not reach its revocation window.',
      );
    }
    await Bun.sleep(1_000);
  }
  const connection = databaseConnection();
  let revokedAt: Date | null | undefined;
  try {
    const service = new SessionService(new DrizzleSessionStore(connection.db));
    const revocation = await executeRevokeSessionCapability({
      service,
      capabilityStore: createDrizzleSessionCapabilityStore(connection.db),
      authenticated: fixture().authenticated,
      sessionId,
      reasonCode: 'FAILURE_DRILL_DEVICE_REVOKED',
      idempotencyKey: `failure-drill-revoke-${randomUUID()}`,
      csrfVerified: true,
      now: new Date(),
    });
    const [session] = await connection.db
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    revokedAt = session?.revokedAt;
    if (
      revocation.sessionId !== sessionId ||
      revokedAt === null ||
      revokedAt === undefined
    ) {
      throw new Error('The deployed session revocation was not retained.');
    }
  } finally {
    await connection.close();
  }
  const worker = await waitForDeployedWorker(taskArn);
  if (worker.exitCode !== 0) {
    throw new Error('The deployed revocation worker did not stop safely.');
  }
  const evidence = await attemptEvidenceStates(item.attempt.id);
  if (evidence.length !== 1 || evidence[0]?.state !== 'attempted') {
    throw new Error('Revocation produced a mock provider outcome.');
  }
  const afterJournalCount = await journalCount();
  if (afterJournalCount !== beforeJournalCount) {
    throw new Error('Device revocation rewrote event journal history.');
  }
  return {
    observation:
      'A deployed worker paused after attempted evidence, observed the same session revocation from Aurora, and its final authorization check blocked mock provider I/O.',
    alarmTransitions: [],
    expectedSideEffects: [],
    observedSideEffects: [],
    invariants: {
      appendOnlyHistory: preserved(
        `Attempt ${item.attempt.id} retained only sequence 1 attempted evidence and journal cardinality remained ${String(beforeJournalCount)}.`,
      ),
      authorization: preserved(
        `Session ${sessionId} was revoked at ${revokedAt!.toISOString()} and the worker exited only after PROVIDER_SEND_DISABLED.`,
      ),
      classification: preserved(
        `Event ${item.attempt.eventId}, attempt ${item.attempt.id}, and endpoint ${item.attempt.endpointId} remained test/drill/synthetic push work.`,
      ),
      honestUnknown: preserved(
        'The worker retained attempted evidence without fabricating provider acceptance after revocation.',
      ),
    },
    facts: {
      eventId: item.attempt.eventId,
      attemptId: item.attempt.id,
      endpointId: item.attempt.endpointId,
      sessionId,
      revokedAt: revokedAt!.toISOString(),
      workerTaskArn: worker.taskArn,
      workerExitCode: worker.exitCode,
      providerSideEffectCount: 0,
      evidenceState: evidence[0]!.state,
    },
  };
}

interface ScenarioExecution {
  readonly observation: string;
  readonly alarmTransitions: readonly FailureDrillAlarmObservation[];
  readonly expectedSideEffects: readonly string[];
  readonly observedSideEffects: readonly string[];
  readonly invariants: ScenarioInvariants;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

const scenarioExecutions: Readonly<
  Record<FailureDrillScenarioId, () => Promise<ScenarioExecution>>
> = {
  'worker-termination-mid-fanout': runDeployedWorkerTermination,
  'aurora-failover': async () => {
    const failover = await runAuroraFailover();
    const authenticated = await authenticateFixtureSession();
    return {
      observation:
        'Aurora changed writers, returned to available, reconnected over TLS, and preserved deployed application and alarm truth.',
      alarmTransitions: failover.alarms,
      expectedSideEffects: [],
      observedSideEffects: [],
      invariants: {
        appendOnlyHistory: preserved(
          `Journal cardinality remained ${String(failover.facts.beforeJournalCount)} before and after failover.`,
        ),
        authorization: preserved(
          `Session ${authenticated.result.session.id} authenticated through the recovered writer.`,
        ),
        classification: preserved(
          `Synthetic event ${fixture().eventId} remained the drill fixture while App Runner returned HTTP ${String(failover.facts.appRunnerHealthStatus)}.`,
        ),
        honestUnknown: preserved(
          'Failover evidence reports observed writer and health state only; it makes no provider-delivery claim.',
        ),
      },
      facts: failover.facts,
    };
  },
  'google-idp-outage': runDeployedIdpOutage,
  'dlq-redrive': async () => {
    const redrive = await runDlqRedrive();
    return {
      observation:
        'One synthetic DLQ message retained its immutable attempt and endpoint identities across transport redrive and was reconciled once.',
      alarmTransitions: redrive.alarms,
      expectedSideEffects: [redrive.expectedId],
      observedSideEffects: [redrive.observedId],
      invariants: nonLifecycleInvariants(
        'The source and dead-letter messages were deleted only after the exact body identities reconciled.',
        'The redriven body remained synthetic and addressed only example.invalid.',
      ),
      facts: redrive.facts,
    };
  },
  'duplicate-provider-callback': runDeployedCallbackReplay,
  'delayed-callback-after-all-clear': async () => {
    const proof = await runFocusedTest(
      'packages/server/app/(app)/events/[id]/journal.database.test.ts',
      'records synthetic all-clear, delayed callback recovery, and close as append-only facts',
      true,
      'delayed-callback-after-all-clear',
    );
    if (proof === undefined)
      throw new Error('Delayed callback proof was unavailable.');
    return {
      observation: `A late callback appended evidence after all-clear, reconciliation appended explicit unknown, and journal cardinality remained ${String(proof.facts.journalCardinalityBeforeCallback)} before and ${String(proof.facts.journalCardinalityAfterCallback)} after callback processing for event ${String(proof.facts.eventId)}.`,
      alarmTransitions: [],
      expectedSideEffects: proof.expectedSideEffects,
      observedSideEffects: proof.observedSideEffects,
      invariants: {
        appendOnlyHistory: preserved(
          `Journal cardinality advanced only by appends from ${String(proof.facts.journalCardinalityBeforeCallback)} to ${String(proof.facts.journalCardinalityAfterCallback)}.`,
        ),
        authorization: preserved(
          `All-clear and callback writes retained their capability evidence IDs ${String(proof.facts.allClearTransitionId)} and ${String(proof.facts.acceptedEvidenceId)}.`,
        ),
        classification: preserved(
          `Event ${String(proof.facts.eventId)} remained synthetic test/drill throughout the delayed callback.`,
        ),
        honestUnknown: preserved(
          `Reconciliation appended explicit unknown evidence ${String(proof.facts.reconciliationEvidenceId)} rather than inferring delivery.`,
        ),
      },
      facts: proof.facts as Readonly<Record<string, string | number | boolean>>,
    };
  },
  'device-revocation-mid-event': runDeployedDeviceRevocation,
  'roster-sync-failure-during-activation': async () => {
    const proof = await runFocusedTest(
      'packages/server/lib/roster/groups-sync.integration.test.ts',
      'records a partial provider failure then activates from the retained last-good snapshot',
      true,
      'roster-sync-failure-during-activation',
    );
    if (proof === undefined)
      throw new Error('Roster activation proof was unavailable.');
    return {
      observation: `Partial sync ${String(proof.facts.partialSyncResultId)} published no snapshot, and synthetic event ${String(proof.facts.activatedEventId)} activated from retained snapshot ${String(proof.facts.retainedRosterSnapshotId)} version ${String(proof.facts.retainedRosterSnapshotVersion)}.`,
      alarmTransitions: [],
      expectedSideEffects: proof.expectedSideEffects,
      observedSideEffects: proof.observedSideEffects,
      invariants: {
        appendOnlyHistory: preserved(
          `Partial sync ${String(proof.facts.partialSyncResultId)} published no replacement snapshot; retained snapshot ${String(proof.facts.retainedRosterSnapshotId)} remained immutable.`,
        ),
        authorization: preserved(
          `Activation ${String(proof.facts.activatedEventId)} crossed the ordinary synthetic human capability path.`,
        ),
        classification: preserved(
          `Activation ${String(proof.facts.activatedEventId)} remained drill/drill/synthetic.`,
        ),
        honestUnknown: preserved(
          'The partial provider read stayed a failed sync result and was not promoted as complete roster truth.',
        ),
      },
      facts: proof.facts as Readonly<Record<string, string | number | boolean>>,
    };
  },
};

async function executeScenario(
  id: FailureDrillScenarioId,
): Promise<FailureDrillScenarioEvidence> {
  try {
    const result = await scenarioExecutions[id]();
    return {
      id,
      status: 'passed',
      observation: result.observation,
      alarmTransitions: result.alarmTransitions,
      invariants: result.invariants,
      facts: result.facts,
      sideEffects: reconcileSideEffects(
        result.expectedSideEffects,
        result.observedSideEffects,
      ),
    };
  } catch (error) {
    return {
      id,
      status: 'failed',
      observation: `Scenario failed safely (${error instanceof Error ? error.name : 'unknown-error'}).`,
      alarmTransitions: [],
      invariants: {
        appendOnlyHistory: notApplicable(
          'The scenario failed before proving this invariant.',
        ),
        authorization: notApplicable(
          'The scenario failed before proving this invariant.',
        ),
        classification: notApplicable(
          'The scenario failed before proving this invariant.',
        ),
        honestUnknown: notApplicable(
          'The scenario failed before proving this invariant.',
        ),
      },
      facts: {
        failureName: error instanceof Error ? error.name : 'unknown-error',
      },
      sideEffects: reconcileSideEffects([], []),
    };
  }
}

async function main(): Promise<void> {
  assertSafetyBoundary();
  await seedSyntheticFixtures();
  await createSyntheticTestDatabase();
  deployedFixture = await createDeployedScenarioFixture();
  const startedAt = new Date().toISOString();
  const scenarios: FailureDrillScenarioEvidence[] = [];
  for (const id of FAILURE_DRILL_SCENARIO_IDS) {
    console.log(JSON.stringify({ kind: 'failure-drill-scenario-start', id }));
    const evidence = await executeScenario(id);
    scenarios.push(evidence);
    console.log(
      JSON.stringify({
        kind: 'failure-drill-scenario-complete',
        id,
        status: evidence.status,
      }),
    );
  }
  const manifest: FailureDrillManifest = {
    schemaVersion: 1,
    runId: requiredEnvironment('PSD_EOC_FAILURE_DRILL_RUN_ID'),
    revision: {
      sourceSha: requiredEnvironment('SOURCE_SHA'),
      imageDigest: requiredEnvironment('PSD_EOC_FAILURE_DRILL_IMAGE_DIGEST'),
      stackId: requiredEnvironment('PSD_EOC_FAILURE_DRILL_STACK_ID'),
    },
    safety: {
      deploymentClass: 'non-production',
      providerMode: 'mocked',
      rosterPopulation: 'synthetic',
      recipientDomain: 'example.invalid',
    },
    startedAt,
    completedAt: new Date().toISOString(),
    scenarios,
    cleanup: {
      status: 'pending',
      stackName: requiredEnvironment('PSD_EOC_FAILURE_DRILL_STACK_NAME'),
      remainingResources: [],
    },
  };
  console.log(JSON.stringify({ kind: 'failure-drill-manifest', manifest }));
  assertSuccessfulFailureDrillManifest(manifest);
}

await main();
