import { beforeAll, describe, expect, test } from 'bun:test';
import { exportPKCS8, generateKeyPair } from 'jose';

import type { GoogleCloudIdentityRosterConfiguration } from './google-roster-config';
import {
  AccessMembershipEvaluationError,
  createGoogleAccessMembershipEvaluator,
  createGoogleGroupResolver,
  createGoogleMembershipChecker,
} from './google-access-membership';

// The group these tests configure. Nothing about it is special any more: the
// evaluator reads whatever the caller passes, so this is just a fixture.
const DESIGNATED_ACCESS_GROUP_EMAIL = 'tsd-engineering@example.invalid';
const CONFIGURED_GROUPS = Object.freeze([
  Object.freeze({
    groupSourceId: '00000000-0000-4000-8000-0000000000a1',
    email: DESIGNATED_ACCESS_GROUP_EMAIL,
    grantedRole: 'admin' as const,
  }),
]);

const SYNTHETIC_TRANSITION_EMAIL = 'initial.mobile@example.invalid';

const TEST_TIME = '2026-08-17T12:00:00.000Z';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CLOUD_IDENTITY_ENDPOINT = 'https://cloudidentity.googleapis.com/v1';
const GROUP_ID = '01synthetic_engineering';
const PROVIDER_SECRET = 'provider-payload-must-not-leak';

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
      'roster-sync-reader@example-eoc-project.iam.gserviceaccount.com',
    privateKeyId: 'a'.repeat(40),
    privateKey: syntheticPrivateKey,
    timeoutMilliseconds,
  });
}

function tokenResponse(): Response {
  return Response.json({
    access_token: 'synthetic-readonly-access-token',
    expires_in: 3_600,
    token_type: 'Bearer',
  });
}

function groupResponse(): Response {
  return Response.json({
    name: `groups/${GROUP_ID}`,
    groupKey: { id: DESIGNATED_ACCESS_GROUP_EMAIL },
    labels: {
      'cloudidentity.googleapis.com/groups.discussion_forum': '',
    },
  });
}

interface ProviderHarness {
  readonly calls: Array<Readonly<{ init?: RequestInit; url: string }>>;
  readonly fetch: typeof fetch;
}

function providerHarness(
  membershipResponse: (
    pageToken: string | null,
    signal: AbortSignal,
  ) => Response | Promise<Response>,
  lookupResponse: () => Response | Promise<Response> = groupResponse,
): ProviderHarness {
  const calls: Array<Readonly<{ init?: RequestInit; url: string }>> = [];
  const fetchImplementation = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    calls.push(Object.freeze({ ...(init === undefined ? {} : { init }), url }));
    if (url === TOKEN_ENDPOINT) return tokenResponse();
    // `groups:lookup` resolves the key to a resource name and returns nothing
    // else. Group details come from the separate `groups.get` call below.
    if (url.startsWith(`${CLOUD_IDENTITY_ENDPOINT}/groups:lookup?`)) {
      return Response.json({ name: `groups/${GROUP_ID}` });
    }
    if (
      url.startsWith(
        `${CLOUD_IDENTITY_ENDPOINT}/groups/${GROUP_ID}/memberships?`,
      )
    ) {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error('The provider request omitted its abort signal.');
      }
      return membershipResponse(
        new URL(url).searchParams.get('pageToken'),
        signal,
      );
    }
    if (url.startsWith(`${CLOUD_IDENTITY_ENDPOINT}/groups/${GROUP_ID}?`)) {
      return lookupResponse();
    }
    throw new Error('The evaluator contacted an unexpected provider URL.');
  }) as typeof fetch;
  return { calls, fetch: fetchImplementation };
}

function evaluator(harness: ProviderHarness, timeoutMilliseconds = 1_000) {
  return createGoogleAccessMembershipEvaluator(
    configuration(timeoutMilliseconds),
    {
      fetch: harness.fetch,
      now: () => new Date(TEST_TIME),
    },
  );
}

async function expectEvaluationError(
  operation: Promise<unknown>,
  code: string,
): Promise<AccessMembershipEvaluationError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AccessMembershipEvaluationError);
    const providerError = error as AccessMembershipEvaluationError;
    expect(providerError.code).toBe(code);
    expect(
      JSON.stringify({
        code: providerError.code,
        message: providerError.message,
        stack: providerError.stack,
      }),
    ).not.toContain(PROVIDER_SECRET);
    return providerError;
  }
  throw new Error(`Expected access-membership error ${code}.`);
}

function currentMembership(
  email: string,
  id = '000000000000000000001',
): Readonly<Record<string, unknown>> {
  return {
    name: `groups/${GROUP_ID}/memberships/${id}`,
    preferredMemberKey: { id: email },
    roles: [{ name: 'MEMBER' }],
    type: 'USER',
  };
}

function decodedJwtPart(
  assertion: string,
  index: 0 | 1,
): Readonly<Record<string, unknown>> {
  const encoded = assertion.split('.')[index];
  if (encoded === undefined) throw new Error('The JWT part is missing.');
  return JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ) as Readonly<Record<string, unknown>>;
}

describe('exact Google access-membership evaluator', () => {
  test('publishes a complete sorted direct-user evaluation without a delegated subject', async () => {
    const harness = providerHarness(() =>
      Response.json({
        memberships: [
          currentMembership('ZED@EXAMPLE.INVALID', '000000000000000000002'),
          currentMembership(SYNTHETIC_TRANSITION_EMAIL),
          {
            ...currentMembership(
              'expired.user@example.invalid',
              '000000000000000000003',
            ),
            roles: [
              {
                name: 'MEMBER',
                expiryDetail: { expireTime: '2026-08-17T11:59:59.000Z' },
              },
            ],
          },
        ],
      }),
    );

    const result = await evaluator(harness).evaluate(CONFIGURED_GROUPS);

    expect(result).toMatchObject({
      groups: [
        {
          groupSourceId: CONFIGURED_GROUPS[0]?.groupSourceId,
          groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
          googleGroupId: GROUP_ID,
          // The role the configured group grants travels with its membership,
          // so the publisher never has to look it up again.
          grantedRole: 'admin',
          memberEmails: [SYNTHETIC_TRANSITION_EMAIL, 'zed@example.invalid'],
        },
      ],
      syncStartedAt: TEST_TIME,
      capturedAt: TEST_TIME,
    });
    expect(result.membershipDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.providerGroupIdDigest).toMatch(/^[a-f0-9]{64}$/u);
    // token, groups:lookup, groups.get, memberships
    expect(harness.calls).toHaveLength(4);
    expect(harness.calls.every(({ init }) => init?.redirect === 'error')).toBe(
      true,
    );

    const tokenCall = harness.calls[0];
    if (tokenCall === undefined) throw new Error('The token call is missing.');
    const assertion = new URLSearchParams(String(tokenCall.init?.body)).get(
      'assertion',
    );
    if (assertion === null) throw new Error('The assertion is missing.');
    expect(decodedJwtPart(assertion, 0)).toMatchObject({
      alg: 'RS256',
      kid: 'a'.repeat(40),
      typ: 'JWT',
    });
    expect(decodedJwtPart(assertion, 1)).toMatchObject({
      aud: TOKEN_ENDPOINT,
      iss: configuration().serviceAccountEmail,
      scope: 'https://www.googleapis.com/auth/cloud-identity.groups.readonly',
    });
    expect(decodedJwtPart(assertion, 1)).not.toHaveProperty('sub');

    const lookup = new URL(harness.calls[1]?.url ?? 'https://invalid.invalid');
    expect(lookup.searchParams.get('groupKey.id')).toBe(
      DESIGNATED_ACCESS_GROUP_EMAIL,
    );
    // `groups:lookup` returns only a resource name. Requesting groupKey,
    // labels, or dynamicGroupMetadata from it is rejected with 400
    // INVALID_ARGUMENT, so the mask here must stay limited to `name` and the
    // details must be read from `groups.get`.
    expect(lookup.searchParams.get('fields')).toBe('name');
    const groupRead = new URL(
      harness.calls[2]?.url ?? 'https://invalid.invalid',
    );
    expect(groupRead.pathname).toBe(`/v1/groups/${GROUP_ID}`);
    expect(groupRead.searchParams.get('fields')).toBe(
      'name,groupKey(id),labels,dynamicGroupMetadata',
    );
    const memberships = new URL(
      harness.calls[3]?.url ?? 'https://invalid.invalid',
    );
    expect(memberships.searchParams.get('view')).toBe('FULL');
    expect(memberships.searchParams.get('pageSize')).toBe('200');
    expect(memberships.searchParams.get('pageToken')).toBeNull();
  });

  test('evaluates every configured group and refuses a set it cannot trust', async () => {
    const second = Object.freeze({
      groupSourceId: '00000000-0000-4000-8000-0000000000a2',
      email: 'eoc-staff@example.invalid',
      grantedRole: 'staff' as const,
    });
    const idFor = new Map([
      [DESIGNATED_ACCESS_GROUP_EMAIL, GROUP_ID],
      [second.email, '01second_group'],
    ]);

    /** Resolves each configured address to its own group and members. */
    function multiGroupFetch(
      membersFor: (email: string) => readonly string[],
    ): typeof fetch {
      return (async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url === TOKEN_ENDPOINT) return tokenResponse();
        if (url.startsWith(`${CLOUD_IDENTITY_ENDPOINT}/groups:lookup?`)) {
          const key = new URL(url).searchParams.get('groupKey.id') ?? '';
          const id = idFor.get(key);
          if (id === undefined) throw new Error(`unexpected group ${key}`);
          return Response.json({ name: `groups/${id}` });
        }
        const match = [...idFor.entries()].find(([, id]) =>
          url.startsWith(`${CLOUD_IDENTITY_ENDPOINT}/groups/${id}`),
        );
        if (match === undefined) {
          throw new Error('The evaluator contacted an unexpected URL.');
        }
        const [email, id] = match;
        if (url.includes('/memberships?')) {
          return Response.json({
            memberships: membersFor(email).map((member, index) => ({
              name: `groups/${id}/memberships/${index}`,
              preferredMemberKey: { id: member },
              roles: [{ name: 'MEMBER' }],
              type: 'USER',
            })),
          });
        }
        return Response.json({
          name: `groups/${id}`,
          groupKey: { id: email },
          labels: {
            'cloudidentity.googleapis.com/groups.discussion_forum': '',
          },
        });
      }) as typeof fetch;
    }

    // Both groups are read, and each member arrives carrying the role its own
    // group grants — which is what lets one deployment have administrators and
    // staff without either being compiled in.
    const evaluated = await createGoogleAccessMembershipEvaluator(
      configuration(),
      {
        fetch: multiGroupFetch((email) =>
          email === DESIGNATED_ACCESS_GROUP_EMAIL
            ? ['admin.one@example.invalid']
            : ['staff.one@example.invalid'],
        ),
        now: () => new Date(TEST_TIME),
      },
    ).evaluate([...CONFIGURED_GROUPS, second]);
    expect(
      evaluated.groups.map(({ groupEmail, grantedRole, memberEmails }) => ({
        groupEmail,
        grantedRole,
        memberEmails: [...memberEmails],
      })),
    ).toEqual([
      {
        groupEmail: DESIGNATED_ACCESS_GROUP_EMAIL,
        grantedRole: 'admin',
        memberEmails: ['admin.one@example.invalid'],
      },
      {
        groupEmail: second.email,
        grantedRole: 'staff',
        memberEmails: ['staff.one@example.invalid'],
      },
    ]);

    // One empty group is allowed: a deployment may configure a group before
    // populating it, and the other group still grants access.
    const partiallyEmpty = await createGoogleAccessMembershipEvaluator(
      configuration(),
      {
        fetch: multiGroupFetch((email) =>
          email === DESIGNATED_ACCESS_GROUP_EMAIL
            ? ['admin.one@example.invalid']
            : [],
        ),
        now: () => new Date(TEST_TIME),
      },
    ).evaluate([...CONFIGURED_GROUPS, second]);
    expect(partiallyEmpty.groups[1]?.memberEmails).toEqual([]);

    // Every group empty is refused. Publishing that would grant nobody access
    // and lock the deployment out of itself.
    await expect(
      createGoogleAccessMembershipEvaluator(configuration(), {
        fetch: multiGroupFetch(() => []),
        now: () => new Date(TEST_TIME),
      }).evaluate([...CONFIGURED_GROUPS, second]),
    ).rejects.toThrow(AccessMembershipEvaluationError);

    // Duplicates and an empty configuration are refused before any provider
    // call: a repeated group would be counted twice and make the digest
    // ambiguous, and no configured group cannot grant anyone access.
    const refuseBeforeIO = createGoogleAccessMembershipEvaluator(
      configuration(),
      {
        fetch: (() => {
          throw new Error('The evaluator contacted the provider.');
        }) as unknown as typeof fetch,
        now: () => new Date(TEST_TIME),
      },
    );
    for (const invalid of [
      [],
      [
        ...CONFIGURED_GROUPS,
        { ...second, email: DESIGNATED_ACCESS_GROUP_EMAIL },
      ],
      [
        ...CONFIGURED_GROUPS,
        { ...second, groupSourceId: CONFIGURED_GROUPS[0]?.groupSourceId ?? '' },
      ],
    ]) {
      await expect(refuseBeforeIO.evaluate(invalid)).rejects.toThrow(
        AccessMembershipEvaluationError,
      );
    }
  });

  test('paginates every direct edge and rejects token loops', async () => {
    const harness = providerHarness((pageToken) => {
      if (pageToken === null) {
        return Response.json({
          memberships: [currentMembership(SYNTHETIC_TRANSITION_EMAIL)],
          nextPageToken: 'page-two',
        });
      }
      expect(pageToken).toBe('page-two');
      return Response.json({
        memberships: [
          currentMembership('other@example.invalid', '000000000000000000002'),
        ],
      });
    });
    expect(
      (await evaluator(harness).evaluate(CONFIGURED_GROUPS)).groups[0]
        ?.memberEmails,
    ).toEqual([SYNTHETIC_TRANSITION_EMAIL, 'other@example.invalid']);
    expect(harness.calls).toHaveLength(5);

    const looping = providerHarness(() =>
      Response.json({ memberships: [], nextPageToken: 'repeat' }),
    );
    await expectEvaluationError(
      evaluator(looping).evaluate(CONFIGURED_GROUPS),
      'GROUP_PAGINATION_LOOP',
    );
  });

  test('fails closed on nested groups, service accounts, or external namespaces', async () => {
    for (const membership of [
      {
        ...currentMembership('nested-group@example.invalid'),
        type: 'GROUP',
      },
      {
        ...currentMembership('service@project.iam.gserviceaccount.com'),
        type: 'SERVICE_ACCOUNT',
      },
      {
        ...currentMembership('external@example.net'),
        preferredMemberKey: {
          id: 'external@example.net',
          namespace: 'identitysources/external',
        },
      },
    ]) {
      const harness = providerHarness(() =>
        Response.json({ memberships: [membership] }),
      );
      await expectEvaluationError(
        evaluator(harness).evaluate(CONFIGURED_GROUPS),
        'NESTED_OR_NON_USER_MEMBERSHIP',
      );
    }

    const externalUser = providerHarness(() =>
      Response.json({
        memberships: [currentMembership('external@example.net')],
      }),
    );
    await expectEvaluationError(
      evaluator(externalUser).evaluate(CONFIGURED_GROUPS),
      'NON_STAFF_MEMBERSHIP',
    );
  });

  test('rejects dynamic or mismatched group identity before listing members', async () => {
    for (const lookup of [
      {
        name: `groups/${GROUP_ID}`,
        groupKey: { id: 'another-group@example.invalid' },
        labels: {
          'cloudidentity.googleapis.com/groups.discussion_forum': '',
        },
      },
      {
        name: `groups/${GROUP_ID}`,
        groupKey: { id: DESIGNATED_ACCESS_GROUP_EMAIL },
        labels: {
          'cloudidentity.googleapis.com/groups.discussion_forum': '',
        },
        dynamicGroupMetadata: { queries: [PROVIDER_SECRET] },
      },
    ]) {
      const harness = providerHarness(
        () => Response.json({ memberships: [] }),
        () => Response.json(lookup),
      );
      await expectEvaluationError(
        evaluator(harness).evaluate(CONFIGURED_GROUPS),
        'DESIGNATED_GROUP_IDENTITY_INVALID',
      );
      expect(harness.calls).toHaveLength(3);
    }
  });

  test('rejects duplicate resources and normalized identities', async () => {
    const duplicateResource = currentMembership(SYNTHETIC_TRANSITION_EMAIL);
    await expectEvaluationError(
      evaluator(
        providerHarness(() =>
          Response.json({
            memberships: [duplicateResource, duplicateResource],
          }),
        ),
      ).evaluate(CONFIGURED_GROUPS),
      'DUPLICATE_PROVIDER_MEMBERSHIP',
    );
    await expectEvaluationError(
      evaluator(
        providerHarness(() =>
          Response.json({
            memberships: [
              currentMembership('INITIAL.MOBILE@EXAMPLE.INVALID'),
              currentMembership(
                SYNTHETIC_TRANSITION_EMAIL,
                '000000000000000000002',
              ),
            ],
          }),
        ),
      ).evaluate(CONFIGURED_GROUPS),
      'DUPLICATE_EVALUATED_EMAIL',
    );
  });

  test('bounds malformed, oversized, rejected, and hanging provider responses', async () => {
    const malformed = providerHarness(
      () => new Response(`{"unexpected":"${PROVIDER_SECRET}"}`),
    );
    await expectEvaluationError(
      evaluator(malformed).evaluate(CONFIGURED_GROUPS),
      'GOOGLE_RESPONSE_INVALID',
    );

    const oversized = providerHarness(
      () =>
        new Response('{}', {
          headers: { 'content-length': String(512 * 1024 + 1) },
        }),
    );
    await expectEvaluationError(
      evaluator(oversized).evaluate(CONFIGURED_GROUPS),
      'GOOGLE_RESPONSE_TOO_LARGE',
    );

    const rejected = providerHarness(
      () => new Response(PROVIDER_SECRET, { status: 403 }),
    );
    await expectEvaluationError(
      evaluator(rejected).evaluate(CONFIGURED_GROUPS),
      'GOOGLE_REQUEST_REJECTED',
    );

    const hanging = providerHarness(
      (_pageToken, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error(PROVIDER_SECRET)),
            { once: true },
          );
        }),
    );
    await expectEvaluationError(
      evaluator(hanging, 1).evaluate(CONFIGURED_GROUPS),
      'GOOGLE_UNAVAILABLE',
    );
  });
});

describe('exact Google Group resolver for the administration forms', () => {
  function resolver(harness: ProviderHarness) {
    return createGoogleGroupResolver(configuration(), {
      fetch: harness.fetch,
      now: () => new Date(TEST_TIME),
    });
  }

  function membersMustNotBeListed(): never {
    throw new Error('The resolver must not list memberships.');
  }

  test('resolves an address to the ID Google holds without listing members', async () => {
    const harness = providerHarness(membersMustNotBeListed);
    const resolved = await resolver(harness).resolve(
      ` ${DESIGNATED_ACCESS_GROUP_EMAIL.toUpperCase()} `,
    );
    expect(resolved).toEqual({
      name: `groups/${GROUP_ID}`,
      googleGroupId: GROUP_ID,
    });
    // Token, lookup by the normalized address, then the exact group read.
    const urls = harness.calls.map(({ url }) => url);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(TOKEN_ENDPOINT);
    expect(urls[1]).toBe(
      `${CLOUD_IDENTITY_ENDPOINT}/groups:lookup?groupKey.id=${encodeURIComponent(DESIGNATED_ACCESS_GROUP_EMAIL)}&fields=name`,
    );
    expect(
      urls[2]?.startsWith(`${CLOUD_IDENTITY_ENDPOINT}/groups/${GROUP_ID}?`),
    ).toBe(true);
  });

  test('refuses a mismatched or dynamic group under the evaluator rule', async () => {
    for (const lookup of [
      {
        name: `groups/${GROUP_ID}`,
        groupKey: { id: 'another-group@example.invalid' },
        labels: {
          'cloudidentity.googleapis.com/groups.discussion_forum': '',
        },
      },
      {
        name: `groups/${GROUP_ID}`,
        groupKey: { id: DESIGNATED_ACCESS_GROUP_EMAIL },
        labels: {
          'cloudidentity.googleapis.com/groups.discussion_forum': '',
        },
        dynamicGroupMetadata: { queries: [PROVIDER_SECRET] },
      },
    ]) {
      const harness = providerHarness(membersMustNotBeListed, () =>
        Response.json(lookup),
      );
      await expectEvaluationError(
        resolver(harness).resolve(DESIGNATED_ACCESS_GROUP_EMAIL),
        'DESIGNATED_GROUP_IDENTITY_INVALID',
      );
      expect(harness.calls).toHaveLength(3);
    }
  });

  test('refuses an address that is not an email before contacting Google', async () => {
    const harness = providerHarness(membersMustNotBeListed);
    await expectEvaluationError(
      resolver(harness).resolve('not an address'),
      'DESIGNATED_GROUP_IDENTITY_INVALID',
    );
    expect(harness.calls).toHaveLength(0);
  });

  test('reports a group Google refuses by code, keeping the provider body out', async () => {
    const harness = providerHarness(
      membersMustNotBeListed,
      () => new Response(PROVIDER_SECRET, { status: 404 }),
    );
    await expectEvaluationError(
      resolver(harness).resolve(DESIGNATED_ACCESS_GROUP_EMAIL),
      'GOOGLE_REQUEST_REJECTED',
    );
  });
});

describe('direct Google membership checker for sign-in', () => {
  const GROUPS = Object.freeze([
    { groupSourceId: 'source-a', googleGroupId: '01a' },
    { groupSourceId: 'source-b', googleGroupId: '01b' },
  ]);

  /** Answers `memberships:lookup` per group: a status, or a foreign name. */
  function lookupHarness(
    answers: Readonly<Record<string, number | 'foreign'>>,
  ): ProviderHarness {
    const calls: Array<Readonly<{ init?: RequestInit; url: string }>> = [];
    const fetchImplementation = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      calls.push(
        Object.freeze({ ...(init === undefined ? {} : { init }), url }),
      );
      if (url === TOKEN_ENDPOINT) return tokenResponse();
      const match = /\/groups\/([^/]+)\/memberships:lookup\?/u.exec(url);
      const group = match?.[1];
      if (group === undefined) {
        throw new Error('The checker contacted an unexpected provider URL.');
      }
      const answer = answers[group] ?? 404;
      if (answer === 'foreign') {
        return Response.json({ name: 'groups/elsewhere/memberships/0001' });
      }
      if (answer === 200) {
        return Response.json({ name: `groups/${group}/memberships/0001` });
      }
      return new Response(PROVIDER_SECRET, { status: answer });
    }) as typeof fetch;
    return { calls, fetch: fetchImplementation };
  }

  function checker(harness: ProviderHarness) {
    return createGoogleMembershipChecker(configuration(), {
      fetch: harness.fetch,
      now: () => new Date(TEST_TIME),
    });
  }

  test('answers membership per group from one token and one lookup each', async () => {
    const harness = lookupHarness({ '01a': 200, '01b': 404 });
    const answers = await checker(harness).check(
      ' Person@Example.invalid ',
      GROUPS,
    );
    expect([...answers]).toEqual([
      ['source-a', true],
      ['source-b', false],
    ]);
    expect(harness.calls).toHaveLength(3);
    expect(harness.calls[0]?.url).toBe(TOKEN_ENDPOINT);
    expect(harness.calls[1]?.url).toContain(
      '/groups/01a/memberships:lookup?memberKey.id=person%40example.invalid',
    );
    expect(harness.calls[2]?.url).toContain('/groups/01b/memberships:lookup?');
  });

  test('asks nothing when no sign-in group is configured', async () => {
    const harness = lookupHarness({});
    expect([
      ...(await checker(harness).check('person@example.invalid', [])),
    ]).toEqual([]);
    expect(harness.calls).toHaveLength(0);
  });

  test('treats any answer other than a membership or a 404 as a failure', async () => {
    for (const status of [403, 500]) {
      const harness = lookupHarness({ '01a': status });
      await expectEvaluationError(
        checker(harness).check('person@example.invalid', GROUPS),
        'GOOGLE_REQUEST_REJECTED',
      );
    }
  });

  test('refuses a membership Google names under another group', async () => {
    const harness = lookupHarness({ '01a': 'foreign' });
    await expectEvaluationError(
      checker(harness).check('person@example.invalid', GROUPS),
      'GOOGLE_RESPONSE_INVALID',
    );
  });

  test('refuses an address that is not an email before contacting Google', async () => {
    const harness = lookupHarness({ '01a': 200 });
    await expectEvaluationError(
      checker(harness).check('not an address', GROUPS),
      'GOOGLE_REQUEST_REJECTED',
    );
    expect(harness.calls).toHaveLength(0);
  });
});
