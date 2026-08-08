import { describe, expect, test } from 'bun:test';
import {
  registerCapabilityHandler,
  type CapabilityAuthorizationRequest,
  type RegisteredCapabilityId,
  type RosterSyncResult,
} from '@psd-eoc/contracts';

import {
  RosterSyncError,
  createScheduledRosterSyncAuthorizer,
  type RosterSyncAlert,
  type RosterSyncCapabilityContext,
} from '../../../../lib/roster/groups-sync';
import {
  ROSTER_SYNC_EVENT_DETAIL_TYPE,
  ROSTER_SYNC_EVENT_MAX_BODY_BYTES,
  ROSTER_SYNC_EVENT_SOURCE,
  createRosterSyncRouteHandler,
  type EventBridgeRosterSyncEvent,
  type RosterSyncCleanupFailure,
  type RosterSyncRouteDependencies,
  type RosterSyncRouteRuntime,
} from './route';

const JOB_TOKEN = 'synthetic-roster-job-token-32-bytes-minimum';
const NOW = new Date('2026-08-08T12:00:00.000Z');
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_EVENT_ID = '00000000-0000-4000-8000-000000000002';
const CONFIGURATION_ID = '10000000-0000-4000-8000-000000000001';
const GROUP_SOURCE_ID = '20000000-0000-4000-8000-000000000001';
const RESULT_ID = '30000000-0000-4000-8000-000000000001';
const SNAPSHOT_ID = '40000000-0000-4000-8000-000000000001';
const FACILITY_ID = '50000000-0000-4000-8000-000000000001';

const EVENT: EventBridgeRosterSyncEvent = {
  version: '0',
  id: EVENT_ID,
  'detail-type': ROSTER_SYNC_EVENT_DETAIL_TYPE,
  source: ROSTER_SYNC_EVENT_SOURCE,
  account: '338414773271',
  time: NOW.toISOString(),
  region: 'us-west-2',
  resources: [
    'arn:aws:scheduler:us-west-2:338414773271:schedule/default/roster-sync',
  ],
  detail: {
    sourceConfiguration: { id: CONFIGURATION_ID, version: 1 },
  },
};

const GROUP_SOURCE = {
  id: GROUP_SOURCE_ID,
  kind: 'google-group' as const,
  purpose: 'building' as const,
  facilityId: FACILITY_ID,
};

const RESULT: RosterSyncResult = {
  id: RESULT_ID,
  sourceConfiguration: { id: CONFIGURATION_ID, version: 1 },
  population: 'staff',
  outcome: 'complete',
  startedAt: NOW.toISOString(),
  completedAt: NOW.toISOString(),
  expectedSourceGroupRefs: [GROUP_SOURCE],
  completedSourceGroupRefs: [GROUP_SOURCE],
  publishedSnapshotId: SNAPSHOT_ID,
  groupFailures: [],
};

interface HarnessOptions {
  readonly execute?: (
    context: RosterSyncCapabilityContext,
  ) => RosterSyncResult | Promise<RosterSyncResult>;
  readonly closeError?: Error;
}

function createHarness(options: HarnessOptions = {}) {
  let tokenReads = 0;
  let runtimeCreates = 0;
  let closes = 0;
  let authorizerCalls = 0;
  const contexts: RosterSyncCapabilityContext[] = [];
  const inputs: unknown[] = [];
  const alerts: RosterSyncAlert[] = [];
  const cleanupFailures: RosterSyncCleanupFailure[] = [];
  const canonicalAuthorizer = createScheduledRosterSyncAuthorizer();

  const dependencies: RosterSyncRouteDependencies = {
    readExpectedBearerToken() {
      tokenReads += 1;
      return JOB_TOKEN;
    },
    async createRuntime(): Promise<RosterSyncRouteRuntime> {
      runtimeCreates += 1;
      return {
        handler: registerCapabilityHandler(
          'sync-roster',
          async (input, context) => {
            inputs.push(input);
            contexts.push(context);
            return options.execute?.(context) ?? RESULT;
          },
        ),
        authorizer: {
          async authorize(
            request: CapabilityAuthorizationRequest<
              RegisteredCapabilityId,
              RosterSyncCapabilityContext
            >,
          ): Promise<void> {
            authorizerCalls += 1;
            await canonicalAuthorizer.authorize(request);
          },
        },
        async close(): Promise<void> {
          closes += 1;
          if (options.closeError !== undefined) {
            throw options.closeError;
          }
        },
      };
    },
    alerts: {
      notify(alert) {
        alerts.push(alert);
      },
    },
    cleanupFailures: {
      notify(failure) {
        cleanupFailures.push(failure);
      },
    },
    clock: () => NOW,
  };

  return {
    route: createRosterSyncRouteHandler(dependencies),
    stats: () => ({
      tokenReads,
      runtimeCreates,
      closes,
      authorizerCalls,
      contexts,
      inputs,
      alerts,
      cleanupFailures,
    }),
  };
}

function requestFor(
  body: string,
  options: {
    readonly method?: string;
    readonly token?: string | null;
    readonly contentType?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Request {
  const token = options.token === undefined ? JOB_TOKEN : options.token;
  return new Request('https://eoc.example.invalid/api/jobs/roster-sync', {
    method: options.method ?? 'POST',
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': options.contentType ?? 'application/json',
      ...options.headers,
    },
    ...(options.method === 'GET' || options.method === 'HEAD' ? {} : { body }),
  });
}

function validRequest(event: EventBridgeRosterSyncEvent = EVENT): Request {
  return requestFor(JSON.stringify(event));
}

async function jsonBody(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

describe('scheduled roster-sync route', () => {
  test('authenticates bearer credentials before parsing the request body', async () => {
    const harness = createHarness();
    const response = await harness.route(
      requestFor('{not-json', {
        token: 'wrong-synthetic-token-that-is-long-enough',
        contentType: 'text/plain',
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(harness.stats()).toMatchObject({
      tokenReads: 1,
      runtimeCreates: 0,
      authorizerCalls: 0,
      closes: 0,
    });
  });

  test('rejects non-POST methods without authentication or side effects', async () => {
    const harness = createHarness();
    const response = await harness.route(
      requestFor('', { method: 'GET', token: null }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(harness.stats()).toMatchObject({
      tokenReads: 0,
      runtimeCreates: 0,
      authorizerCalls: 0,
      closes: 0,
    });
  });

  test('rejects unsupported media, malformed JSON, and oversized bodies before runtime creation', async () => {
    const unsupported = createHarness();
    expect(
      (
        await unsupported.route(
          requestFor(JSON.stringify(EVENT), { contentType: 'text/plain' }),
        )
      ).status,
    ).toBe(415);
    expect(unsupported.stats().runtimeCreates).toBe(0);

    const malformed = createHarness();
    expect((await malformed.route(requestFor('{'))).status).toBe(400);
    expect(malformed.stats().runtimeCreates).toBe(0);

    const oversized = createHarness();
    expect(
      (
        await oversized.route(
          requestFor('x'.repeat(ROSTER_SYNC_EVENT_MAX_BODY_BYTES + 1)),
        )
      ).status,
    ).toBe(413);
    expect(oversized.stats().runtimeCreates).toBe(0);
  });

  test('strictly rejects body attempts to provide capability provenance', async () => {
    const harness = createHarness();
    const response = await harness.route(
      requestFor(
        JSON.stringify({
          ...EVENT,
          actor: { kind: 'system', serviceId: 'body-controlled-service' },
          idempotencyKey: 'body-controlled-key',
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(harness.stats().runtimeCreates).toBe(0);
  });

  test('executes valid events through the canonical capability authorizer and closes runtime', async () => {
    const harness = createHarness();
    const response = await harness.route(validRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await jsonBody(response)).toEqual({ result: RESULT });
    expect(harness.stats()).toMatchObject({
      tokenReads: 1,
      runtimeCreates: 1,
      authorizerCalls: 1,
      closes: 1,
      inputs: [EVENT.detail],
    });
    expect(harness.stats().contexts).toEqual([
      {
        actor: { kind: 'system', serviceId: 'roster-sync-job' },
        source: 'scheduled-job',
        transport: 'scheduled-execution',
        schedulerAuthenticated: true,
        requestId: EVENT_ID,
        idempotencyKey: `eventbridge:${EVENT_ID}`,
      },
    ]);
  });

  test('derives a stable idempotency key from the authenticated EventBridge event ID', async () => {
    const harness = createHarness();
    const secondEvent = { ...EVENT, id: OTHER_EVENT_ID };

    expect((await harness.route(validRequest())).status).toBe(200);
    expect((await harness.route(validRequest())).status).toBe(200);
    expect((await harness.route(validRequest(secondEvent))).status).toBe(200);

    expect(
      harness.stats().contexts.map(({ idempotencyKey }) => idempotencyKey),
    ).toEqual([
      `eventbridge:${EVENT_ID}`,
      `eventbridge:${EVENT_ID}`,
      `eventbridge:${OTHER_EVENT_ID}`,
    ]);
    expect(harness.stats().closes).toBe(3);
  });

  test('returns the committed result when runtime cleanup fails and reports cleanup separately', async () => {
    const harness = createHarness({
      closeError: new Error(
        'postgres://synthetic-user:synthetic-password@db.invalid/eoc',
      ),
    });

    const response = await harness.route(validRequest());

    expect(response.status).toBe(200);
    expect(await jsonBody(response)).toEqual({ result: RESULT });
    expect(harness.stats().alerts).toEqual([]);
    expect(harness.stats().cleanupFailures).toEqual([
      {
        eventId: EVENT_ID,
        errorCode: 'ROSTER_SYNC_RUNTIME_CLOSE_FAILED',
        occurredAt: NOW.toISOString(),
      },
    ]);
    expect(JSON.stringify(harness.stats().cleanupFailures)).not.toContain(
      'synthetic-password',
    );
  });

  test('sanitizes provider and store failures while emitting structured safe alerts', async () => {
    const provider = createHarness({
      execute() {
        throw new RosterSyncError(
          'GOOGLE_GROUP_FETCH_REJECTED',
          'provider payload contained synthetic-secret-token',
        );
      },
    });
    const providerResponse = await provider.route(validRequest());
    const providerBody = JSON.stringify(await jsonBody(providerResponse));

    expect(providerResponse.status).toBe(503);
    expect(providerBody).not.toContain('synthetic-secret-token');
    expect(providerBody).not.toContain('GOOGLE_GROUP_FETCH_REJECTED');
    expect(provider.stats().alerts).toEqual([
      expect.objectContaining({
        outcome: 'execution-failed',
        errorCodes: ['GOOGLE_GROUP_FETCH_REJECTED'],
        sourceConfiguration: EVENT.detail.sourceConfiguration,
      }),
    ]);
    expect(provider.stats().closes).toBe(1);

    const store = createHarness({
      execute() {
        throw new Error(
          'postgres://synthetic-user:synthetic-password@db.invalid/eoc',
        );
      },
    });
    const storeResponse = await store.route(validRequest());
    const storeBody = JSON.stringify(await jsonBody(storeResponse));

    expect(storeResponse.status).toBe(503);
    expect(storeBody).not.toContain('synthetic-password');
    expect(store.stats().alerts).toEqual([
      expect.objectContaining({ errorCodes: ['ROSTER_SYNC_ROUTE_FAILED'] }),
    ]);
    expect(store.stats().closes).toBe(1);
  });
});
