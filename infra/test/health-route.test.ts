import { describe, expect, it } from 'bun:test';

import {
  createCanaryRouteHandler,
  createHealthRouteHandler,
  createRuntimeDeepHealthDependencies,
  type CanaryAgentGateway,
  type CanaryFailureStage,
  type CanaryRouteDependencies,
  type CanaryTransactionDatabase,
  type DeepHealthDependencies,
  type RuntimeHealthAdapters,
  type TransactionalCanaryRuntime,
} from '../../packages/server/app/api/health/runtime';
import { AgentApiKeyError } from '../../packages/server/lib/agents/keys';
import { SessionAccessError } from '../../packages/server/lib/auth/sessions';

const REGION = 'us-west-2';
const ACCOUNT_ID = '123456789012';
const QUEUE_NAME = 'psd-eoc-delivery';
const QUEUE_URL = `https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${QUEUE_NAME}`;
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}`;
const RUNTIME_SECRET_ARN = `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:psd-eoc-runtime-AbCdEf`;
const DATABASE_HOST =
  'psd-eoc.cluster-abcdefghijkl.us-west-2.rds.amazonaws.com';
const DATABASE_PASSWORD = 'synthetic-native-health-password-value';
const DATABASE_SSL_ROOT_CERT = new URL(
  '../../packages/server/certs/aws-rds-global-bundle.pem',
  import.meta.url,
).pathname;
const SYNTHETIC_ACCESS_KEY_ID = 'ASIA0000000000000000';
const SYNTHETIC_SECRET_ACCESS_KEY = 'synthetic-health-secret-access-key-value';
const SYNTHETIC_SESSION_TOKEN = 'synthetic-health-session-token-value';
const FIXED_TIME = new Date('2026-08-12T12:34:56.000Z');
const CANARY_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const CANARY_EVENT_TYPE_VERSION_ID = '00000000-0000-4000-8000-000000000002';
const CANARY_PREVIEW_ID = '00000000-0000-4000-8000-000000000003';
const CANARY_EVENT_ID = '00000000-0000-4000-8000-000000000004';
const CANARY_LIFECYCLE_PREVIEW_ID = '00000000-0000-4000-8000-000000000005';
const CANARY_AGENT_ID = '00000000-0000-4000-8000-000000000006';
const CANARY_KEY_ID = '00000000-0000-4000-8000-000000000007';
const CANARY_ISSUER_ID = '00000000-0000-4000-8000-000000000008';
const OTHER_FACILITY_ID = '00000000-0000-4000-8000-000000000009';
const OTHER_KEY_ID = '00000000-0000-4000-8000-000000000010';
const CANARY_CREDENTIAL = `psd_eoc_agent_v1_ABCDEFGHIJKL.${'a'.repeat(43)}`;
const OAUTH_PROJECT_NUMBER = '338414773271';
const OAUTH_WEB_CLIENT_ID = `${OAUTH_PROJECT_NUMBER}-webclient.apps.googleusercontent.com`;
const OAUTH_IOS_CLIENT_ID = `${OAUTH_PROJECT_NUMBER}-iosclient.apps.googleusercontent.com`;
const OAUTH_CLIENT_SECRET = `GOCSPX-${'a'.repeat(32)}`;
const OIDC_COOKIE_SECRET = Buffer.alloc(32, 31).toString('base64url');
const CANARY_CAPABILITIES = [
  'create-activation-preview',
  'start-event',
  'create-lifecycle-consequence-preview',
  'all-clear-event',
  'close-event',
] as const;

const SYNTHETIC_IOS_BUNDLE_ID = 'invalid.example.eoc';

function runtimeEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    API_SALT: 's'.repeat(64),
    AWS_REGION: REGION,
    DATABASE_DRIVER: 'postgres',
    DATABASE_HOST,
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'psd_eoc',
    DATABASE_USERNAME: 'psd_eoc_application',
    DATABASE_PASSWORD,
    DATABASE_SSL_ROOT_CERT,
    DATABASE_MAX_CONNECTIONS: '1',
    DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
    DATABASE_IDLE_TIMEOUT_SECONDS: '0',
    RUNTIME_SECRET_ARN,
    DELIVERY_QUEUE_URL: QUEUE_URL,
    GOOGLE_OAUTH_CONFIG: JSON.stringify({
      clientId: OAUTH_WEB_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET,
      iosBundleId: SYNTHETIC_IOS_BUNDLE_ID,
      iosClientId: OAUTH_IOS_CLIENT_ID,
      webClientId: OAUTH_WEB_CLIENT_ID,
    }),
    GOOGLE_OIDC_COOKIE_SECRET: OIDC_COOKIE_SECRET,
    // A synthetic district: the origin, domain, and bundle identifier are
    // configuration now rather than literals in source.
    GOOGLE_OIDC_APPLICATION_ORIGIN: 'https://eoc.example.invalid',
    GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
    PSD_EOC_IOS_BUNDLE_ID: SYNTHETIC_IOS_BUNDLE_ID,
    NODE_ENV: 'production',
  });
}

function successfulDependencies(calls: string[] = []): DeepHealthDependencies {
  return Object.freeze({
    async checkDatabase(signal: AbortSignal): Promise<void> {
      expect(signal.aborted).toBe(false);
      calls.push('database');
    },
    async checkDeliveryQueue(signal: AbortSignal): Promise<void> {
      expect(signal.aborted).toBe(false);
      calls.push('delivery-queue');
    },
    async checkRuntimeSecrets(signal: AbortSignal): Promise<void> {
      expect(signal.aborted).toBe(false);
      calls.push('runtime-secrets');
    },
  });
}

function expectNoCache(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  expect(response.headers.get('surrogate-control')).toBe('no-store');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('expires')).toBe('0');
  expect(response.headers.get('content-type')).toBe(
    'application/json; charset=utf-8',
  );
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('www-authenticate')).toBeNull();
}

type CanaryCapabilityId = (typeof CANARY_CAPABILITIES)[number];

interface CapturedCanaryExecution {
  readonly capabilityId: CanaryCapabilityId;
  readonly prepared: Awaited<
    ReturnType<Parameters<CanaryAgentGateway['executeAuthorized']>[1]>
  >;
}

interface CanaryHarness {
  readonly dependencies: CanaryRouteDependencies;
  readonly authorizationAttempts: CanaryCapabilityId[];
  readonly authorizedCapabilityIds: CanaryCapabilityId[];
  readonly executions: CapturedCanaryExecution[];
  readonly failureStages: CanaryFailureStage[];
  readonly state: {
    closes: number;
    commits: number;
    outerTransactions: number;
    rollbacks: number;
    transactionConfigurations: number;
    transactionalRuntimeCreations: number;
  };
}

function canaryEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    CANARY_EVENT_TYPE_VERSION_ID,
    CANARY_FACILITY_ID,
  });
}

function canaryRequest(
  input: Readonly<{
    body?: string;
    credential?: string | null;
    query?: string;
  }> = {},
): Request {
  const credential =
    input.credential === undefined ? CANARY_CREDENTIAL : input.credential;
  const headers = new Headers();
  if (credential !== null) headers.set('authorization', `Bearer ${credential}`);
  return new Request(`https://eoc.synthetic/api/health${input.query ?? ''}`, {
    method: 'POST',
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}

function canaryEvent(status: 'active' | 'all-clear' | 'closed') {
  return Object.freeze({
    id: CANARY_EVENT_ID,
    facilityId: CANARY_FACILITY_ID,
    kind: 'test' as const,
    templateMode: 'drill' as const,
    eventTypeVersion: {
      id: CANARY_EVENT_TYPE_VERSION_ID,
      templateMode: 'drill' as const,
    },
    rosterPopulation: 'synthetic' as const,
    status,
  });
}

function canaryIntent(purpose: 'activation' | 'all-clear') {
  return Object.freeze({
    eventId: CANARY_EVENT_ID,
    purpose,
    eventKind: 'test' as const,
    templateMode: 'drill' as const,
    eventTypeVersion: {
      id: CANARY_EVENT_TYPE_VERSION_ID,
      templateMode: 'drill' as const,
    },
    rosterPopulation: 'synthetic' as const,
  });
}

function canaryOutput(capabilityId: CanaryCapabilityId): unknown {
  switch (capabilityId) {
    case 'create-activation-preview':
      return {
        id: CANARY_PREVIEW_ID,
        facilityId: CANARY_FACILITY_ID,
        kind: 'test',
        templateMode: 'drill',
        eventTypeVersion: {
          id: CANARY_EVENT_TYPE_VERSION_ID,
          templateMode: 'drill',
        },
        rosterPopulation: 'synthetic',
        sendReadiness: 'ready',
        activeEventIds: [],
      };
    case 'start-event':
      return {
        event: canaryEvent('active'),
        notificationIntent: canaryIntent('activation'),
      };
    case 'create-lifecycle-consequence-preview':
      return {
        id: CANARY_LIFECYCLE_PREVIEW_ID,
        eventId: CANARY_EVENT_ID,
        purpose: 'all-clear',
        kind: 'test',
        templateMode: 'drill',
        eventTypeVersion: {
          id: CANARY_EVENT_TYPE_VERSION_ID,
          templateMode: 'drill',
        },
        rosterPopulation: 'synthetic',
        sendReadiness: 'ready',
      };
    case 'all-clear-event':
      return {
        event: canaryEvent('all-clear'),
        notificationIntent: canaryIntent('all-clear'),
      };
    case 'close-event':
      return {
        event: canaryEvent('closed'),
        notificationIntent: null,
      };
  }
}

function createCanaryHarness(
  options: Readonly<{
    authority?:
      | 'district'
      | 'exact'
      | 'extra-grant'
      | 'mixed-identity'
      | 'wrong-facility';
    failAuthorizationAt?: CanaryCapabilityId;
    failExecutionAt?: CanaryCapabilityId;
    failTransactionConfiguration?: boolean;
    swallowOuterError?: boolean;
  }> = {},
): CanaryHarness {
  const authorizationAttempts: CanaryCapabilityId[] = [];
  const authorizedCapabilityIds: CanaryCapabilityId[] = [];
  const executions: CapturedCanaryExecution[] = [];
  const failureStages: CanaryFailureStage[] = [];
  const state = {
    closes: 0,
    commits: 0,
    outerTransactions: 0,
    rollbacks: 0,
    transactionConfigurations: 0,
    transactionalRuntimeCreations: 0,
  };
  const transactionToken = Object.freeze({ kind: 'synthetic-transaction' });

  const gateway: CanaryAgentGateway = {
    async authorize(input) {
      const capabilityId = input.capabilityId as CanaryCapabilityId;
      authorizationAttempts.push(capabilityId);
      if (input.credential !== CANARY_CREDENTIAL) {
        throw new AgentApiKeyError(
          'INVALID_CREDENTIAL',
          'private invalid credential detail',
        );
      }
      authorizedCapabilityIds.push(capabilityId);
      if (capabilityId === options.failAuthorizationAt) {
        throw new AgentApiKeyError(
          'CAPABILITY_NOT_GRANTED',
          'private missing grant detail',
        );
      }
      const authority = options.authority ?? 'exact';
      const keyId =
        authority === 'mixed-identity' && capabilityId === 'close-event'
          ? OTHER_KEY_ID
          : CANARY_KEY_ID;
      const facilityScope =
        authority === 'district'
          ? ({ kind: 'district' } as const)
          : ({
              kind: 'facilities' as const,
              facilityIds: [
                authority === 'wrong-facility'
                  ? OTHER_FACILITY_ID
                  : CANARY_FACILITY_ID,
              ],
            } as const);
      const capabilityIds =
        authority === 'extra-grant'
          ? [...CANARY_CAPABILITIES, 'list-active-events' as const]
          : [...CANARY_CAPABILITIES];
      return Object.freeze({
        capabilityId,
        requestId: input.requestId,
        serverTime: input.serverTime,
        authenticated: Object.freeze({
          actor: {
            kind: 'agent' as const,
            agentId: CANARY_AGENT_ID,
            apiKeyId: keyId,
          },
          scope: { facilityScope },
          capabilityIds,
          key: {
            id: keyId,
            agentId: CANARY_AGENT_ID,
            displayName: 'Synthetic rollback canary',
            facilityScope,
            capabilityIds,
            keyPrefix: 'ABCDEFGHIJKL',
            issuedByUserId: CANARY_ISSUER_ID,
            issuedAt: '2026-08-12T00:00:00.000Z',
            expiresAt: null,
            revokedAt: null,
          },
        }),
      }) as unknown as Awaited<ReturnType<CanaryAgentGateway['authorize']>>;
    },
    async executeAuthorized() {
      throw new Error('The base gateway must never execute a canary handler.');
    },
  };

  const database: CanaryTransactionDatabase = {
    async transaction<Result>(
      operation: (transaction: unknown) => Promise<Result>,
    ) {
      state.outerTransactions += 1;
      try {
        const result = await operation(transactionToken);
        state.commits += 1;
        return result;
      } catch (error) {
        state.rollbacks += 1;
        if (options.swallowOuterError === true) {
          state.commits += 1;
          return undefined as Result;
        }
        throw error;
      }
    },
  };

  const dependencies: CanaryRouteDependencies = Object.freeze({
    database,
    gateway,
    async configureTransaction(transaction: unknown): Promise<void> {
      expect(transaction).toBe(transactionToken);
      state.transactionConfigurations += 1;
      if (options.failTransactionConfiguration === true) {
        throw new Error('private transaction configuration failure');
      }
    },
    createRequestId: (() => {
      let sequence = 100;
      return () =>
        `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
    })(),
    createTransactionalRuntime(
      transaction: unknown,
    ): TransactionalCanaryRuntime {
      expect(transaction).toBe(transactionToken);
      state.transactionalRuntimeCreations += 1;
      return Object.freeze({
        gateway: Object.freeze({
          async authorize() {
            throw new Error(
              'Transaction-bound execution must reuse preauthorization.',
            );
          },
          async executeAuthorized(
            call: Parameters<CanaryAgentGateway['executeAuthorized']>[0],
            prepare: Parameters<CanaryAgentGateway['executeAuthorized']>[1],
          ) {
            expect(state.transactionConfigurations).toBe(1);
            const capabilityId = call.capabilityId as CanaryCapabilityId;
            const prepared = await prepare();
            executions.push(Object.freeze({ capabilityId, prepared }));
            if (capabilityId === options.failExecutionAt) {
              throw new Error(
                'private lifecycle failure with secret-like material',
              );
            }
            return canaryOutput(capabilityId);
          },
        }),
        async close() {
          state.closes += 1;
        },
      });
    },
    now: () => FIXED_TIME,
    reportFailure(stage: CanaryFailureStage): void {
      failureStages.push(stage);
    },
  });

  return {
    dependencies,
    authorizationAttempts,
    authorizedCapabilityIds,
    executions,
    failureStages,
    state,
  };
}

describe('deep health GET contract', () => {
  it('is unauthenticated, runs all deep reads, and returns a no-store success', async () => {
    const calls: string[] = [];
    const handler = createHealthRouteHandler(successfulDependencies(calls));

    expect(handler.length).toBe(0);
    const response = await handler();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(calls.sort()).toEqual([
      'database',
      'delivery-queue',
      'runtime-secrets',
    ]);
    expectNoCache(response);
  });

  it('never writes driver statement text or bound parameters to the log', async () => {
    // What drizzle actually throws: the statement and the bound parameters are
    // in the message, and again on .query/.params. Logging cause.message
    // verbatim would put a staff address or a credential into CloudWatch.
    const wrapped = Object.assign(
      new Error(
        'Failed query: insert into "group_members" ("email") values ($1)\nparams: someone@psd401.net',
      ),
      {
        name: 'DrizzleQueryError',
        query: 'insert into "group_members" ("email") values ($1)',
        params: ['someone@psd401.net'],
      },
    );
    const handler = createHealthRouteHandler({
      checkDatabase: () => Promise.reject(wrapped),
      checkDeliveryQueue: () => Promise.resolve(),
      checkRuntimeSecrets: () => Promise.resolve(),
    });

    const written: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      written.push(String(line));
    };
    try {
      const response = await handler();
      expect(response.status).toBe(503);
    } finally {
      console.error = original;
    }

    const all = written.join('\n');
    expect(all).toContain('health-check-failed');
    expect(all).toContain('database');
    // The whole point: none of the payload survives.
    expect(all).not.toContain('someone@psd401.net');
    expect(all).not.toContain('group_members');
    expect(all).not.toContain('insert into');
    expect(all).not.toContain('params:');
    expect(all).toContain('redacted');
  });

  it('coalesces concurrent public probes into one set of dependency reads', async () => {
    const calls: string[] = [];
    let releaseDatabase: (() => void) | undefined;
    const handler = createHealthRouteHandler({
      async checkDatabase(): Promise<void> {
        calls.push('database');
        await new Promise<void>((resolve) => {
          releaseDatabase = resolve;
        });
      },
      async checkDeliveryQueue(): Promise<void> {
        calls.push('delivery-queue');
      },
      async checkRuntimeSecrets(): Promise<void> {
        calls.push('runtime-secrets');
      },
    });

    const pending = Array.from({ length: 20 }, () => handler());
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.sort()).toEqual([
      'database',
      'delivery-queue',
      'runtime-secrets',
    ]);
    if (releaseDatabase === undefined) {
      throw new Error('The synthetic database probe did not start.');
    }
    releaseDatabase();

    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('fails closed with one generic response for every dependency failure', async () => {
    const probeNames = [
      'checkDatabase',
      'checkDeliveryQueue',
      'checkRuntimeSecrets',
    ] as const;
    const privateFailure =
      'private-health-failure-with-secret-like-value-do-not-return';
    const responseBodies = new Set<string>();

    for (const failingProbe of probeNames) {
      const calls: string[] = [];
      const dependency = async (name: (typeof probeNames)[number]) => {
        calls.push(name);
        if (name === failingProbe) throw new Error(privateFailure);
      };
      const response = await createHealthRouteHandler({
        checkDatabase: () => dependency('checkDatabase'),
        checkDeliveryQueue: () => dependency('checkDeliveryQueue'),
        checkRuntimeSecrets: () => dependency('checkRuntimeSecrets'),
      })();
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
      expect(body).not.toContain(privateFailure);
      expect(calls.sort()).toEqual([...probeNames].sort());
      expectNoCache(response);
      responseBodies.add(body);
    }

    expect(responseBodies.size).toBe(1);
  });

  it('aborts an over-deadline read and returns the same generic failure', async () => {
    let observedAbort = false;
    const blockingProbe = (signal: AbortSignal): Promise<void> =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            reject(new Error('private timeout detail'));
          },
          { once: true },
        );
      });
    const handler = createHealthRouteHandler(
      {
        ...successfulDependencies(),
        checkDatabase: blockingProbe,
      },
      { timeoutMilliseconds: 10 },
    );

    const response = await handler();

    expect(observedAbort).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expectNoCache(response);
  });
});

describe('authenticated rollback canary POST', () => {
  it('preauthorizes every grant, executes the exact canonical synthetic lifecycle, and succeeds only after rollback', async () => {
    const harness = createCanaryHarness();
    const handler = createCanaryRouteHandler(
      harness.dependencies,
      canaryEnvironment(),
    );

    const response = await handler(canaryRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expectNoCache(response);
    expect(harness.authorizedCapabilityIds).toEqual([...CANARY_CAPABILITIES]);
    expect(harness.executions.map(({ capabilityId }) => capabilityId)).toEqual([
      ...CANARY_CAPABILITIES,
    ]);
    expect(harness.state).toEqual({
      closes: 1,
      commits: 0,
      outerTransactions: 1,
      rollbacks: 1,
      transactionConfigurations: 1,
      transactionalRuntimeCreations: 1,
    });
    expect(harness.failureStages).toEqual([]);

    const preparedByCapability = new Map(
      harness.executions.map(({ capabilityId, prepared }) => [
        capabilityId,
        prepared,
      ]),
    );
    expect(preparedByCapability.get('create-activation-preview')).toEqual({
      input: {
        facilityId: CANARY_FACILITY_ID,
        kind: 'test',
        templateMode: 'drill',
        eventTypeVersion: {
          id: CANARY_EVENT_TYPE_VERSION_ID,
          templateMode: 'drill',
        },
        rosterPopulation: 'synthetic',
      },
      idempotencyKey: null,
    });
    expect(preparedByCapability.get('start-event')?.input).toEqual({
      source: 'activation-preview',
      activationPreviewId: CANARY_PREVIEW_ID,
      activeEventDecision: {
        decision: 'start-new',
        activeEventIdsSeen: [],
      },
    });
    expect(
      preparedByCapability.get('create-lifecycle-consequence-preview')?.input,
    ).toEqual({ eventId: CANARY_EVENT_ID, purpose: 'all-clear' });
    expect(preparedByCapability.get('all-clear-event')?.input).toEqual({
      eventId: CANARY_EVENT_ID,
      lifecyclePreviewId: CANARY_LIFECYCLE_PREVIEW_ID,
    });
    expect(preparedByCapability.get('close-event')?.input).toEqual({
      eventId: CANARY_EVENT_ID,
    });
    const mutationKeys = harness.executions
      .map(({ prepared }) => prepared.idempotencyKey)
      .filter((value): value is string => value !== null);
    expect(mutationKeys).toHaveLength(4);
    expect(new Set(mutationKeys).size).toBe(4);
    expect(mutationKeys.every((key) => key.startsWith('health-canary:'))).toBe(
      true,
    );
  });

  it('requires one real bearer with all five grants before opening the transaction', async () => {
    for (const testCase of [
      { credential: null, failureAt: undefined, expectedStatus: 401 },
      {
        credential: CANARY_CREDENTIAL,
        failureAt: 'close-event' as const,
        expectedStatus: 403,
      },
    ]) {
      const harness = createCanaryHarness({
        ...(testCase.failureAt === undefined
          ? {}
          : { failAuthorizationAt: testCase.failureAt }),
      });
      const response = await createCanaryRouteHandler(
        harness.dependencies,
        canaryEnvironment(),
      )(canaryRequest({ credential: testCase.credential }));
      const body = await response.text();

      expect(response.status).toBe(testCase.expectedStatus);
      expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
      expect(body).not.toContain('private');
      expect(harness.state.outerTransactions).toBe(0);
      expect(harness.state.transactionalRuntimeCreations).toBe(0);
      expect(harness.executions).toEqual([]);
      if (testCase.credential === null) {
        expect(harness.authorizationAttempts).toEqual([
          'create-activation-preview',
        ]);
      } else if (testCase.failureAt !== undefined) {
        expect(harness.authorizationAttempts).toEqual([...CANARY_CAPABILITIES]);
        expect(harness.authorizedCapabilityIds).toEqual([
          ...CANARY_CAPABILITIES,
        ]);
      }
      expect(harness.failureStages).toEqual(['authorization']);
      expectNoCache(response);
    }
  });

  it('rejects district, wrong-facility, extra-grant, and mixed-identity credentials', async () => {
    for (const authority of [
      'district',
      'wrong-facility',
      'extra-grant',
      'mixed-identity',
    ] as const) {
      const harness = createCanaryHarness({ authority });
      const response = await createCanaryRouteHandler(
        harness.dependencies,
        canaryEnvironment(),
      )(canaryRequest());

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ status: 'unavailable' });
      expect(harness.authorizationAttempts).toEqual([...CANARY_CAPABILITIES]);
      expect(harness.state.outerTransactions).toBe(0);
      expect(harness.state.transactionConfigurations).toBe(0);
      expect(harness.executions).toEqual([]);
      expect(harness.failureStages).toEqual(['credential-authority']);
    }
  });

  it('rolls back and sanitizes every canonical stage failure', async () => {
    const expectedStage = {
      'create-activation-preview': 'activation-preview',
      'start-event': 'start-event',
      'create-lifecycle-consequence-preview': 'lifecycle-preview',
      'all-clear-event': 'all-clear-event',
      'close-event': 'close-event',
    } as const satisfies Record<CanaryCapabilityId, CanaryFailureStage>;
    for (const failExecutionAt of CANARY_CAPABILITIES) {
      const harness = createCanaryHarness({ failExecutionAt });
      const response = await createCanaryRouteHandler(
        harness.dependencies,
        canaryEnvironment(),
      )(canaryRequest());
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
      expect(body).not.toContain('private lifecycle failure');
      expect(harness.authorizedCapabilityIds).toEqual([...CANARY_CAPABILITIES]);
      expect(harness.state.outerTransactions).toBe(1);
      expect(harness.state.rollbacks).toBe(1);
      expect(harness.state.commits).toBe(0);
      expect(harness.state.closes).toBe(1);
      expect(harness.failureStages).toEqual([expectedStage[failExecutionAt]]);
      expectNoCache(response);
    }
  });

  it('fails before runtime creation when transaction-local limits cannot be set', async () => {
    const harness = createCanaryHarness({
      failTransactionConfiguration: true,
    });
    const response = await createCanaryRouteHandler(
      harness.dependencies,
      canaryEnvironment(),
    )(canaryRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(harness.state.transactionConfigurations).toBe(1);
    expect(harness.state.transactionalRuntimeCreations).toBe(0);
    expect(harness.state.rollbacks).toBe(1);
    expect(harness.failureStages).toEqual(['transaction-configuration']);
  });

  it('fails closed if the outer transaction does not propagate the rollback sentinel', async () => {
    const harness = createCanaryHarness({ swallowOuterError: true });

    const response = await createCanaryRouteHandler(
      harness.dependencies,
      canaryEnvironment(),
    )(canaryRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(harness.state.commits).toBe(1);
    expect(harness.state.rollbacks).toBe(1);
    expect(harness.failureStages).toEqual(['rollback-proof']);
  });

  it('accepts no body, query, or caller-supplied human confirmation', async () => {
    const requests = [
      canaryRequest({ body: '{}' }),
      canaryRequest({ query: '?detail=true' }),
      new Request('https://eoc.synthetic/api/health', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CANARY_CREDENTIAL}`,
          'human-confirmation-id': '00000000-0000-4000-8000-000000000099',
        },
      }),
    ];

    for (const request of requests) {
      const harness = createCanaryHarness();
      const response = await createCanaryRouteHandler(
        harness.dependencies,
        canaryEnvironment(),
      )(request);
      expect([400, 403]).toContain(response.status);
      expect(await response.json()).toEqual({ status: 'unavailable' });
      expect(harness.state.outerTransactions).toBe(0);
      expect(harness.executions).toEqual([]);
      expect(harness.failureStages).toEqual(['request-validation']);
    }
  });
});

describe('production deep health reads', () => {
  it('proves both shared route pools, delivery queue, and secret reachability using reads only', async () => {
    const sharedDatabaseCalls: string[] = [];
    const sessionProbeCredentials: string[] = [];
    const requestedSignals: AbortSignal[] = [];
    const requests: Array<
      Readonly<{ endpoint: string; init: RequestInit; target: string }>
    > = [];
    const fetchImplementation: NonNullable<
      RuntimeHealthAdapters['fetch']
    > = async (input, init) => {
      const requestInit = init ?? {};
      const headers = new Headers(requestInit.headers);
      const target = headers.get('x-amz-target') ?? '';
      requests.push(
        Object.freeze({
          endpoint: String(input),
          init: requestInit,
          target,
        }),
      );
      if (target === 'AmazonSQS.GetQueueAttributes') {
        return new Response(
          JSON.stringify({ Attributes: { QueueArn: QUEUE_ARN } }),
          { status: 200 },
        );
      }
      if (target === 'secretsmanager.DescribeSecret') {
        return new Response(JSON.stringify({ ARN: RUNTIME_SECRET_ARN }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ message: 'unsupported target' }), {
        status: 400,
      });
    };
    const dependencies = createRuntimeDeepHealthDependencies(
      runtimeEnvironment(),
      {
        authenticateSharedSession: async (credential) => {
          sharedDatabaseCalls.push('session');
          sessionProbeCredentials.push(credential);
          throw new SessionAccessError(
            'INVALID_CREDENTIAL',
            'Synthetic unknown health credential.',
          );
        },
        querySharedAdminDatabase: async () => {
          sharedDatabaseCalls.push('admin');
          return { value: 1, ssl: true, tlsVersion: 'TLSv1.3' };
        },
        fetch: fetchImplementation,
        now: () => FIXED_TIME,
        resolveAwsCredentials: async (_region, signal) => {
          requestedSignals.push(signal);
          return {
            accessKeyId: SYNTHETIC_ACCESS_KEY_ID,
            expiration: new Date('2026-08-12T13:34:56.000Z'),
            secretAccessKey: SYNTHETIC_SECRET_ACCESS_KEY,
            sessionToken: SYNTHETIC_SESSION_TOKEN,
          };
        },
      },
    );
    const controller = new AbortController();

    await Promise.all([
      dependencies.checkDatabase(controller.signal),
      dependencies.checkDeliveryQueue(controller.signal),
      dependencies.checkRuntimeSecrets(controller.signal),
    ]);

    expect(sharedDatabaseCalls.sort()).toEqual(['admin', 'session']);
    expect(sessionProbeCredentials).toHaveLength(1);
    expect(sessionProbeCredentials[0]).toMatch(
      /^health-[0-9a-f-]{36}-[0-9a-f-]{36}$/u,
    );
    expect(
      requestedSignals.every((signal) => signal === controller.signal),
    ).toBe(true);
    expect(requests.map(({ target }) => target)).toEqual([
      'AmazonSQS.GetQueueAttributes',
      'secretsmanager.DescribeSecret',
    ]);
    for (const request of requests) {
      expect(request.init.method).toBe('POST');
      const headers = new Headers(request.init.headers);
      expect(headers.get('authorization')).toBe(
        request.target === 'AmazonSQS.GetQueueAttributes'
          ? 'AWS4-HMAC-SHA256 Credential=ASIA0000000000000000/20260812/us-west-2/sqs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=a00b8f0c9e022358e76efaaff4bf6ca9e2372c28c707495a2fabb14245dc39ec'
          : 'AWS4-HMAC-SHA256 Credential=ASIA0000000000000000/20260812/us-west-2/secretsmanager/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=3f22f37d61f3770208bddaba6f739cd88b37fb96a232fd9c68668085640bb3c2',
      );
      expect(headers.get('content-type')).toBe(
        request.target === 'AmazonSQS.GetQueueAttributes'
          ? 'application/x-amz-json-1.0'
          : 'application/x-amz-json-1.1',
      );
      expect(headers.get('x-amz-date')).toBe('20260812T123456Z');
      expect(headers.get('x-amz-target')).toBe(request.target);
      expect(headers.get('x-amz-security-token')).toBe(SYNTHETIC_SESSION_TOKEN);
      expect(request.init.signal).toBe(controller.signal);
    }

    const queueRequest = requests.find(
      ({ target }) => target === 'AmazonSQS.GetQueueAttributes',
    );
    if (queueRequest === undefined) {
      throw new Error('Missing a synthetic AWS read request.');
    }
    expect(queueRequest.endpoint).toBe(`https://sqs.${REGION}.amazonaws.com/`);
    expect(JSON.parse(String(queueRequest.init.body))).toEqual({
      AttributeNames: ['QueueArn'],
      QueueUrl: QUEUE_URL,
    });
    expect(queueRequest.init.body).not.toContain('MessageBody');
    expect(queueRequest.init.body).not.toContain('Entries');
    const secretRequest = requests.find(
      ({ target }) => target === 'secretsmanager.DescribeSecret',
    );
    if (secretRequest === undefined) {
      throw new Error('Missing a synthetic Secrets Manager read request.');
    }
    expect(secretRequest.endpoint).toBe(
      `https://secretsmanager.${REGION}.amazonaws.com/`,
    );
    expect(JSON.parse(String(secretRequest.init.body))).toEqual({
      SecretId: RUNTIME_SECRET_ARN,
    });
    const serializedRequests = JSON.stringify(requests);
    expect(serializedRequests).not.toContain(
      runtimeEnvironment().GOOGLE_OAUTH_CONFIG,
    );
    expect(serializedRequests).not.toContain(OAUTH_CLIENT_SECRET);
    expect(serializedRequests).not.toContain(OIDC_COOKIE_SECRET);
    expect(serializedRequests).not.toContain(runtimeEnvironment().API_SALT);
    expect(serializedRequests).not.toContain(SYNTHETIC_SECRET_ACCESS_KEY);
  });

  it('times out one queued shared probe, coalesces it, and becomes healthy after the queue drains', async () => {
    const healthyResult = { value: 1, ssl: true, tlsVersion: 'TLSv1.3' };
    let adminAttempts = 0;
    let sessionAttempts = 0;
    let releaseQueuedAdmin:
      | ((result: typeof healthyResult) => void)
      | undefined;
    const runtimeDependencies = createRuntimeDeepHealthDependencies(
      runtimeEnvironment(),
      {
        authenticateSharedSession: async () => {
          sessionAttempts += 1;
          throw new SessionAccessError(
            'INVALID_CREDENTIAL',
            'Synthetic unknown health credential.',
          );
        },
        querySharedAdminDatabase: async () => {
          adminAttempts += 1;
          if (adminAttempts === 1) {
            return new Promise<typeof healthyResult>((resolve) => {
              releaseQueuedAdmin = resolve;
            });
          }
          return healthyResult;
        },
      },
    );
    const handler = createHealthRouteHandler(
      {
        checkDatabase: runtimeDependencies.checkDatabase,
        async checkDeliveryQueue(): Promise<void> {},
        async checkRuntimeSecrets(): Promise<void> {},
      },
      { timeoutMilliseconds: 10 },
    );

    const firstResponse = await handler();
    expect(firstResponse.status).toBe(503);
    expect(adminAttempts).toBe(1);
    expect(sessionAttempts).toBe(1);

    const secondProbe = handler();
    await Promise.resolve();
    await Promise.resolve();
    expect(adminAttempts).toBe(1);
    expect(sessionAttempts).toBe(1);
    if (releaseQueuedAdmin === undefined) {
      throw new Error('The synthetic queued admin probe did not start.');
    }
    releaseQueuedAdmin(healthyResult);
    expect((await secondProbe).status).toBe(200);

    await Promise.resolve();
    expect((await handler()).status).toBe(200);
    expect(adminAttempts).toBe(2);
    expect(sessionAttempts).toBe(2);
  });

  it('keeps a poisoned generation coalesced until queued sibling work settles, then proves recovery', async () => {
    const healthyResult = { value: 1, ssl: true, tlsVersion: 'TLSv1.3' };
    let adminAttempts = 0;
    let sessionAttempts = 0;
    let releaseQueuedAdmin:
      | ((result: typeof healthyResult) => void)
      | undefined;
    const runtimeDependencies = createRuntimeDeepHealthDependencies(
      runtimeEnvironment(),
      {
        authenticateSharedSession: async () => {
          sessionAttempts += 1;
          if (sessionAttempts === 1) {
            throw Object.assign(
              new Error('Synthetic private session-pool failure.'),
              { code: 'CONNECTION_DESTROYED' },
            );
          }
          throw new SessionAccessError(
            'INVALID_CREDENTIAL',
            'Synthetic unknown health credential.',
          );
        },
        querySharedAdminDatabase: async () => {
          adminAttempts += 1;
          if (adminAttempts === 1) {
            return new Promise<typeof healthyResult>((resolve) => {
              releaseQueuedAdmin = resolve;
            });
          }
          return healthyResult;
        },
      },
    );
    const handler = createHealthRouteHandler(
      {
        checkDatabase: runtimeDependencies.checkDatabase,
        async checkDeliveryQueue(): Promise<void> {},
        async checkRuntimeSecrets(): Promise<void> {},
      },
      { timeoutMilliseconds: 10 },
    );

    expect((await handler()).status).toBe(503);
    const secondProbe = handler();
    await Promise.resolve();
    await Promise.resolve();
    expect(adminAttempts).toBe(1);
    expect(sessionAttempts).toBe(1);
    if (releaseQueuedAdmin === undefined) {
      throw new Error('The synthetic queued admin probe did not start.');
    }
    releaseQueuedAdmin(healthyResult);
    expect((await secondProbe).status).toBe(503);

    expect((await handler()).status).toBe(200);
    expect(adminAttempts).toBe(2);
    expect(sessionAttempts).toBe(2);
  });

  it('accepts only exact unknown-credential evidence from the shared session path', async () => {
    const invalidSessionOutcomes: Array<() => Promise<void>> = [
      async () => {},
      async () => {
        throw new SessionAccessError(
          'SESSION_EXPIRED',
          'Synthetic wrong session outcome.',
        );
      },
      async () => {
        throw new Error('Synthetic private session failure.');
      },
    ];

    for (const authenticateSharedSession of invalidSessionOutcomes) {
      const dependencies = createRuntimeDeepHealthDependencies(
        runtimeEnvironment(),
        {
          authenticateSharedSession,
          querySharedAdminDatabase: async () => ({
            value: 1,
            ssl: true,
            tlsVersion: 'TLSv1.3',
          }),
        },
      );

      await expect(
        dependencies.checkDatabase(new AbortController().signal),
      ).rejects.toThrow();
    }
  });

  it('rejects absent runtime secret injection without contacting AWS', async () => {
    const environment = { ...runtimeEnvironment() };
    delete (environment as { GOOGLE_OAUTH_CONFIG?: string })
      .GOOGLE_OAUTH_CONFIG;
    let fetchCalled = false;
    const dependencies = createRuntimeDeepHealthDependencies(environment, {
      fetch: async () => {
        fetchCalled = true;
        return new Response('{}');
      },
      now: () => FIXED_TIME,
      resolveAwsCredentials: async () => ({
        accessKeyId: SYNTHETIC_ACCESS_KEY_ID,
        secretAccessKey: SYNTHETIC_SECRET_ACCESS_KEY,
        sessionToken: SYNTHETIC_SESSION_TOKEN,
      }),
    });

    await expect(
      dependencies.checkRuntimeSecrets(new AbortController().signal),
    ).rejects.toThrow();
    expect(fetchCalled).toBe(false);
  });

  it('rejects a runtime OAuth contract that auth would reject', async () => {
    const environment = {
      ...runtimeEnvironment(),
      GOOGLE_OAUTH_CONFIG: JSON.stringify({
        clientId: OAUTH_WEB_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
        iosBundleId: SYNTHETIC_IOS_BUNDLE_ID,
        iosClientId: OAUTH_IOS_CLIENT_ID,
        webClientId: OAUTH_WEB_CLIENT_ID,
        issuer: 'https://accounts.google.com',
      }),
    };
    let fetchCalled = false;
    const dependencies = createRuntimeDeepHealthDependencies(environment, {
      fetch: async () => {
        fetchCalled = true;
        return new Response('{}');
      },
      now: () => FIXED_TIME,
      resolveAwsCredentials: async () => ({
        accessKeyId: SYNTHETIC_ACCESS_KEY_ID,
        secretAccessKey: SYNTHETIC_SECRET_ACCESS_KEY,
        sessionToken: SYNTHETIC_SESSION_TOKEN,
      }),
    });

    await expect(
      dependencies.checkRuntimeSecrets(new AbortController().signal),
      // The message now names the cause. That is the point of it: a 503 from
      // /api/health used to say only 'unavailable', which during a live outage
      // gave no way to tell a bad OAuth contract from an unreachable database.
    ).rejects.toThrow(
      'Health dependency configuration is unavailable: GOOGLE_OAUTH_CONFIG must contain exactly the approved five fields.',
    );
    expect(fetchCalled).toBe(false);
  });

  it('rejects invalid or untrusted dependency evidence', async () => {
    const baseAdapters: RuntimeHealthAdapters = {
      authenticateSharedSession: async () => {
        throw new SessionAccessError(
          'INVALID_CREDENTIAL',
          'Synthetic unknown health credential.',
        );
      },
      querySharedAdminDatabase: async () => ({
        value: 0,
        ssl: false,
        tlsVersion: 'TLSv1.3',
      }),
      fetch: async (_input, init) => {
        const target = new Headers(init?.headers).get('x-amz-target');
        if (target === 'AmazonSQS.GetQueueAttributes') {
          return new Response(
            JSON.stringify({
              Attributes: { QueueArn: `${QUEUE_ARN}-wrong` },
            }),
          );
        }
        return new Response(JSON.stringify({ ARN: RUNTIME_SECRET_ARN }), {
          headers: { 'content-length': '65537' },
        });
      },
      now: () => FIXED_TIME,
      resolveAwsCredentials: async () => ({
        accessKeyId: SYNTHETIC_ACCESS_KEY_ID,
        secretAccessKey: SYNTHETIC_SECRET_ACCESS_KEY,
        sessionToken: SYNTHETIC_SESSION_TOKEN,
      }),
    };
    const dependencies = createRuntimeDeepHealthDependencies(
      runtimeEnvironment(),
      baseAdapters,
    );
    const signal = new AbortController().signal;

    await expect(dependencies.checkDatabase(signal)).rejects.toThrow();
    await expect(dependencies.checkDeliveryQueue(signal)).rejects.toThrow();
    await expect(dependencies.checkRuntimeSecrets(signal)).rejects.toThrow();
  });
});
