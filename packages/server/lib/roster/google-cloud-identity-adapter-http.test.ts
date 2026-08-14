import { beforeAll, describe, expect, test } from 'bun:test';
import { GroupSourceSchema, type GroupSource } from '@psd-eoc/contracts';
import { exportPKCS8, generateKeyPair } from 'jose';

import {
  createGoogleCloudIdentityRosterAdapter,
  RosterSyncError,
  type GoogleCloudIdentityRosterConfiguration,
} from './groups-sync';

const MAX_GOOGLE_RESPONSE_BYTES = 512 * 1024;
const TEST_TIME = '2026-08-08T12:00:00.000Z';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CLOUD_IDENTITY_ENDPOINT = 'https://cloudidentity.googleapis.com/v1';
const READONLY_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
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
}) as Extract<GroupSource, { kind: 'google-group'; purpose: 'building' }>;

let syntheticPrivateKey = '';

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  syntheticPrivateKey = await exportPKCS8(privateKey);
});

function configuration(
  timeoutMilliseconds = 1_000,
): GoogleCloudIdentityRosterConfiguration {
  return Object.freeze({
    serviceAccountEmail:
      'roster-sync-reader@psd401-eoc.iam.gserviceaccount.com',
    privateKeyId: 'a'.repeat(40),
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
  readonly calls: ReadonlyArray<
    Readonly<{ url: string; init: RequestInit | undefined }>
  >;
}

function syntheticFetch(
  groupResponse: (
    signal: AbortSignal,
    url: string,
  ) => Response | Promise<Response>,
): SyntheticFetch {
  const calls: Array<Readonly<{ url: string; init: RequestInit | undefined }>> =
    [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    calls.push(Object.freeze({ url, init }));
    if (calls.length === 1) {
      return tokenResponse();
    }
    if (calls.length === 2) {
      return Response.json({ name: `groups/${GOOGLE_SOURCE.googleGroupId}` });
    }
    if (calls.length >= 3) {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error('The adapter omitted its HTTP abort signal.');
      }
      return groupResponse(signal, url);
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
  return createGoogleCloudIdentityRosterAdapter(
    configuration(timeoutMilliseconds),
    {
      fetch: network.fetch,
      now: () => new Date(TEST_TIME),
    },
  );
}

function expectTokenThenGroupRequests(calls: SyntheticFetch['calls']): void {
  expect(calls).toHaveLength(3);
  expect(calls[0]?.url).toBe(TOKEN_ENDPOINT);
  expect(calls[1]?.url).toStartWith(
    `${CLOUD_IDENTITY_ENDPOINT}/groups:lookup?`,
  );
  expect(calls[2]?.url).toStartWith(
    `${CLOUD_IDENTITY_ENDPOINT}/groups/${GOOGLE_SOURCE.googleGroupId}/memberships:searchTransitiveMemberships?`,
  );
}

function decodedJwtPart(
  assertion: string,
  index: 0 | 1,
): Readonly<Record<string, unknown>> {
  const encoded = assertion.split('.')[index];
  if (encoded === undefined) {
    throw new Error('The synthetic token request omitted its JWT assertion.');
  }
  return JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ) as Readonly<Record<string, unknown>>;
}

describe('non-delegated Cloud Identity roster adapter HTTP boundaries', () => {
  test('uses only non-delegated Cloud Identity reads and preserves direct plus nested staff membership', async () => {
    const network = syntheticFetch(() =>
      Response.json({
        memberships: [
          {
            preferredMemberKey: [{ id: 'DIRECT.STAFF@PSD401.NET' }],
            member: 'users/100000000000000000001',
            roles: [{ role: 'MEMBER' }],
            relationType: 'DIRECT',
          },
          {
            preferredMemberKey: [{ id: 'nested-group@psd401.net' }],
            member: 'groups/nested_group',
            roles: [{ role: 'MEMBER' }],
            relationType: 'DIRECT',
          },
          {
            preferredMemberKey: [{ id: 'nested.staff@psd401.net' }],
            member: 'users/100000000000000000002',
            roles: [{ role: 'MEMBER' }],
            relationType: 'INDIRECT',
          },
        ],
      }),
    );

    const page = await createAdapter(network).fetchPage(GOOGLE_SOURCE, null);

    expect(page).toEqual({
      members: [
        {
          memberKey: 'direct.staff@psd401.net',
          googleSubject: null,
          displayName: 'Staff member',
          email: 'direct.staff@psd401.net',
        },
        {
          memberKey: 'nested.staff@psd401.net',
          googleSubject: null,
          displayName: 'Staff member',
          email: 'nested.staff@psd401.net',
        },
      ],
      nextPageToken: null,
    });
    expectTokenThenGroupRequests(network.calls);
    expect(network.calls.every((call) => call.init?.redirect === 'error')).toBe(
      true,
    );

    const tokenCall = network.calls[0];
    if (tokenCall === undefined) {
      throw new Error('The token request was not captured.');
    }
    const tokenParameters = new URLSearchParams(String(tokenCall.init?.body));
    const assertion = tokenParameters.get('assertion');
    if (assertion === null) {
      throw new Error('The token request omitted its assertion.');
    }
    expect(decodedJwtPart(assertion, 0)).toMatchObject({
      alg: 'RS256',
      kid: 'a'.repeat(40),
      typ: 'JWT',
    });
    const claims = decodedJwtPart(assertion, 1);
    expect(claims).toMatchObject({
      aud: TOKEN_ENDPOINT,
      iss: 'roster-sync-reader@psd401-eoc.iam.gserviceaccount.com',
      scope: READONLY_SCOPE,
    });
    expect(claims).not.toHaveProperty('sub');

    const lookup = new URL(network.calls[1]?.url ?? 'https://invalid.invalid');
    expect(lookup.searchParams.get('groupKey.id')).toBe(GOOGLE_SOURCE.email);
    expect(lookup.searchParams.get('fields')).toBe('name');
    const membership = new URL(
      network.calls[2]?.url ?? 'https://invalid.invalid',
    );
    expect(membership.searchParams.get('pageSize')).toBe('200');
    expect(membership.searchParams.get('pageToken')).toBeNull();
    expect(membership.searchParams.get('fields')).toBe(
      'memberships(member,preferredMemberKey,relationType,roles),nextPageToken',
    );
  });

  test('paginates transitive memberships without repeating token exchange or group lookup', async () => {
    let membershipPage = 0;
    const network = syntheticFetch((_signal, url) => {
      membershipPage += 1;
      const pageToken = new URL(url).searchParams.get('pageToken');
      if (membershipPage === 1) {
        expect(pageToken).toBeNull();
        return Response.json({
          memberships: [],
          nextPageToken: 'synthetic-next-page',
        });
      }
      expect(pageToken).toBe('synthetic-next-page');
      return Response.json({ memberships: [] });
    });
    const adapter = createAdapter(network);

    const first = await adapter.fetchPage(GOOGLE_SOURCE, null);
    const second = await adapter.fetchPage(GOOGLE_SOURCE, first.nextPageToken);

    expect(first.nextPageToken).toBe('synthetic-next-page');
    expect(second.nextPageToken).toBeNull();
    expect(network.calls).toHaveLength(4);
    expect(
      network.calls.filter((call) => call.url === TOKEN_ENDPOINT),
    ).toHaveLength(1);
    expect(
      network.calls.filter((call) => call.url.includes('/groups:lookup?')),
    ).toHaveLength(1);
  });

  test('rejects an email-to-group-ID mismatch and strict extra member fields without leaking payloads', async () => {
    const mismatchCalls: SyntheticFetch['calls'][number][] = [];
    const mismatchFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      mismatchCalls.push({ url: String(input), init });
      return mismatchCalls.length === 1
        ? tokenResponse()
        : Response.json({ name: 'groups/other-group' });
    }) as typeof fetch;
    await expectSanitizedRosterError(
      createGoogleCloudIdentityRosterAdapter(configuration(), {
        fetch: mismatchFetch,
        now: () => new Date(TEST_TIME),
      }).fetchPage(GOOGLE_SOURCE, null),
      'GOOGLE_GROUP_IDENTITY_MISMATCH',
    );
    expect(mismatchCalls).toHaveLength(2);

    const extraField = syntheticFetch(() =>
      Response.json({
        memberships: [
          {
            preferredMemberKey: [{ id: 'staff@psd401.net' }],
            member: 'users/100000000000000000001',
            roles: [{ role: 'MEMBER' }],
            relationType: 'DIRECT',
            unexpected: PROVIDER_PAYLOAD_SECRET,
          },
        ],
      }),
    );
    await expectSanitizedRosterError(
      createAdapter(extraField).fetchPage(GOOGLE_SOURCE, null),
      'GOOGLE_GROUP_RESPONSE_INVALID',
    );

    const unsupportedRoleField = syntheticFetch(() =>
      Response.json({
        memberships: [
          {
            preferredMemberKey: [{ id: 'staff@psd401.net' }],
            member: 'users/100000000000000000001',
            roles: [{ role: 'MEMBER', expiryTime: TEST_TIME }],
            relationType: 'DIRECT',
          },
        ],
      }),
    );
    await expectSanitizedRosterError(
      createAdapter(unsupportedRoleField).fetchPage(GOOGLE_SOURCE, null),
      'GOOGLE_GROUP_RESPONSE_INVALID',
    );
  });

  test('fails closed on a transitive-membership 403 without exposing the provider body', async () => {
    const network = syntheticFetch(() =>
      Response.json(
        { error: { message: PROVIDER_PAYLOAD_SECRET } },
        { status: 403 },
      ),
    );

    await expectSanitizedRosterError(
      createAdapter(network).fetchPage(GOOGLE_SOURCE, null),
      'GOOGLE_GROUP_FETCH_REJECTED',
    );

    expectTokenThenGroupRequests(network.calls);
  });

  test('rejects an oversized declared content length without reading or leaking the provider body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(PROVIDER_PAYLOAD_SECRET));
        controller.close();
      },
      cancel() {
        cancelled = true;
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
    expect(cancelled).toBe(true);
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
