import { beforeAll, describe, expect, test } from 'bun:test';
import { GroupSourceSchema } from '@psd-eoc/contracts';
import { exportPKCS8, generateKeyPair } from 'jose';

import {
  createGoogleAdminRosterAdapter,
  RosterSyncError,
  type GoogleAdminRosterConfiguration,
} from './groups-sync';

const MAX_GOOGLE_RESPONSE_BYTES = 512 * 1024;
const TEST_TIME = '2026-08-08T12:00:00.000Z';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PROVIDER_PAYLOAD_SECRET = 'provider-payload-must-never-leak';

const GOOGLE_SOURCE = GroupSourceSchema.parse({
  id: '00000000-0000-4000-8000-000000000101',
  kind: 'google-group',
  purpose: 'building',
  facilityId: '00000000-0000-4000-8000-000000000102',
  displayName: 'Synthetic staff group',
  active: true,
  googleGroupId: 'synthetic-staff-group',
  email: 'synthetic-staff@psd401.net',
  createdAt: TEST_TIME,
});

let syntheticPrivateKey = '';

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  syntheticPrivateKey = await exportPKCS8(privateKey);
});

function configuration(
  timeoutMilliseconds = 1_000,
): GoogleAdminRosterConfiguration {
  return Object.freeze({
    serviceAccountEmail:
      'synthetic-roster@synthetic-project.iam.gserviceaccount.com',
    delegatedSubject: 'synthetic-admin@psd401.net',
    privateKey: syntheticPrivateKey,
    timeoutMilliseconds,
  });
}

function tokenResponse(): Response {
  return Response.json({
    access_token: 'synthetic-access-token',
    expires_in: 3_600,
    token_type: 'Bearer',
  });
}

interface SyntheticFetch {
  readonly fetch: typeof fetch;
  readonly calls: string[];
}

function syntheticFetch(
  groupResponse: (signal: AbortSignal) => Response | Promise<Response>,
): SyntheticFetch {
  const calls: string[] = [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push(String(input));
    if (calls.length === 1) {
      return tokenResponse();
    }
    if (calls.length === 2) {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('The adapter omitted its HTTP abort signal.');
      }
      return groupResponse(signal);
    }
    throw new Error('The adapter made an unexpected provider request.');
  }) as typeof fetch;
  return { fetch: fetchImplementation, calls };
}

function serializedError(error: RosterSyncError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    stack: error.stack,
  });
}

async function expectSanitizedRosterError(
  operation: Promise<unknown>,
  expectedCode: string,
  forbiddenPayload = PROVIDER_PAYLOAD_SECRET,
): Promise<RosterSyncError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(RosterSyncError);
    const rosterError = error as RosterSyncError;
    expect(rosterError.code).toBe(expectedCode);
    expect(serializedError(rosterError)).not.toContain(forbiddenPayload);
    return rosterError;
  }
  throw new Error(`Expected roster adapter error ${expectedCode}.`);
}

function createAdapter(network: SyntheticFetch, timeoutMilliseconds = 1_000) {
  return createGoogleAdminRosterAdapter(configuration(timeoutMilliseconds), {
    fetch: network.fetch,
    now: () => new Date(TEST_TIME),
  });
}

function expectTokenThenGroupRequests(calls: readonly string[]): void {
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe(TOKEN_ENDPOINT);
  expect(calls[1]).toStartWith(
    'https://admin.googleapis.com/admin/directory/v1/groups/',
  );
}

describe('Google Admin roster adapter bounded HTTP responses', () => {
  test('rejects an oversized declared content length without reading or leaking the provider body', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(PROVIDER_PAYLOAD_SECRET));
        controller.close();
      },
    });
    const network = syntheticFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: {
            'Content-Length': String(MAX_GOOGLE_RESPONSE_BYTES + 1),
            'Content-Type': 'application/json',
          },
        }),
    );

    await expectSanitizedRosterError(
      createAdapter(network).fetchPage(GOOGLE_SOURCE, null),
      'GOOGLE_RESPONSE_TOO_LARGE',
    );

    expectTokenThenGroupRequests(network.calls);
  });

  test('cancels a chunked body as soon as its observed bytes exceed 512 KiB', async () => {
    const firstChunk = new Uint8Array(MAX_GOOGLE_RESPONSE_BYTES);
    firstChunk.fill(32);
    const overflowChunk = new TextEncoder().encode(PROVIDER_PAYLOAD_SECRET);
    let chunkIndex = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex === 0) {
          chunkIndex += 1;
          controller.enqueue(firstChunk);
          return;
        }
        controller.enqueue(overflowChunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const network = syntheticFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await expectSanitizedRosterError(
      createAdapter(network).fetchPage(GOOGLE_SOURCE, null),
      'GOOGLE_RESPONSE_TOO_LARGE',
    );

    expect(cancelled).toBe(true);
    expectTokenThenGroupRequests(network.calls);
  });

  test('aborts and sanitizes a provider body read that never completes', async () => {
    const timeoutMilliseconds = 25;
    let groupSignal: AbortSignal | undefined;
    let bodyObservedAbort = false;
    const network = syntheticFetch((signal) => {
      groupSignal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener(
            'abort',
            () => {
              bodyObservedAbort = true;
              controller.error(new Error(PROVIDER_PAYLOAD_SECRET));
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    let guard: ReturnType<typeof setTimeout> | undefined;
    const guardFailure = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(
        () =>
          reject(new Error('Roster response body timeout was not honored.')),
        500,
      );
    });

    try {
      await expectSanitizedRosterError(
        Promise.race([
          createAdapter(network, timeoutMilliseconds).fetchPage(
            GOOGLE_SOURCE,
            null,
          ),
          guardFailure,
        ]),
        'GOOGLE_UNAVAILABLE',
      );
    } finally {
      clearTimeout(guard);
    }

    expect(groupSignal?.aborted).toBe(true);
    expect(bodyObservedAbort).toBe(true);
    expectTokenThenGroupRequests(network.calls);
  });
});
