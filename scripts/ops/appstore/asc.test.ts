import { Buffer } from 'node:buffer';
import { generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  createAscJwt,
  isPathInside,
  parseCli,
  parseReviewInfo,
  parseTesterCsv,
  syncTestFlight,
  type AscClient,
  type BetaReviewInfo,
  type JsonApiResource,
} from './asc';

const resource = (
  type: string,
  id: string,
  attributes: Record<string, unknown> = {},
): JsonApiResource => ({ attributes, id, type });

const bodyData = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error('Expected JSON:API data.');
  }
  const data = body.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Expected one JSON:API resource.');
  }
  return data as Record<string, unknown>;
};

const dataAttributes = (body: unknown): Record<string, unknown> => {
  const data = bodyData(body);
  const attributes = data.attributes;
  if (
    typeof attributes !== 'object' ||
    attributes === null ||
    Array.isArray(attributes)
  ) {
    throw new Error('Expected JSON:API attributes.');
  }
  return attributes as Record<string, unknown>;
};

const relationshipId = (body: unknown, name: string): string => {
  const data = bodyData(body);
  const relationships = data.relationships;
  if (
    typeof relationships !== 'object' ||
    relationships === null ||
    !(name in relationships)
  ) {
    throw new Error(`Expected ${name} relationship.`);
  }
  const relationship = (relationships as Record<string, unknown>)[name];
  if (
    typeof relationship !== 'object' ||
    relationship === null ||
    !('data' in relationship)
  ) {
    throw new Error(`Expected ${name} relationship data.`);
  }
  const linkage = relationship.data;
  const first = Array.isArray(linkage) ? linkage[0] : linkage;
  if (typeof first !== 'object' || first === null || !('id' in first)) {
    throw new Error(`Expected ${name} linkage ID.`);
  }
  return String(first.id);
};

class StatefulClient implements AscClient {
  readonly app = resource('apps', 'app-1', {
    bundleId: 'net.psd401.eoc',
    name: 'PSD EOC',
    sku: 'PSD-EOC-IOS',
  });
  readonly groups = [
    resource('betaGroups', 'internal-group', {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: true,
      name: 'District Technology',
    }),
    resource('betaGroups', 'external-group', {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: false,
      name: 'Staff',
      publicLinkEnabled: false,
    }),
  ];
  readonly buildAttributes: Record<string, unknown> = {
    buildAudienceType: 'APP_STORE_ELIGIBLE',
    expired: false,
    processingState: 'VALID',
    uploadedDate: '2026-08-08T12:00:00Z',
    version: '1',
  };
  readonly build = resource('builds', 'build-1', this.buildAttributes);
  readonly mutations: Array<{
    body: unknown;
    method: string;
    path: string;
  }> = [];
  readonly listPaths: string[] = [];
  readonly appTesters: JsonApiResource[] = [];
  readonly groupTesters = new Map<string, JsonApiResource[]>([
    ['internal-group', []],
    ['external-group', []],
  ]);
  readonly groupBuilds = new Map<string, JsonApiResource[]>([
    ['internal-group', []],
    ['external-group', []],
  ]);
  reviewDetails = resource('betaAppReviewDetails', 'review-1', {
    demoAccountRequired: false,
  });
  readonly localizations: JsonApiResource[] = [];
  readonly submissions: JsonApiResource[] = [];
  readonly users = [
    resource('users', 'user-1', {
      allAppsVisible: true,
      roles: ['APP_MANAGER'],
      username: 'internal@example.invalid',
    }),
  ];

  async first(path: string): Promise<JsonApiResource | null> {
    this.listPaths.push(path);
    if (path.startsWith('/v1/builds?')) return this.build;
    throw new Error(`Unexpected first path ${path}`);
  }

  async list(path: string): Promise<readonly JsonApiResource[]> {
    this.listPaths.push(path);
    if (path.startsWith('/v1/apps?')) return [this.app];
    if (path.startsWith('/v1/users?')) return this.users;
    if (path.startsWith('/v1/betaGroups?')) return this.groups;
    if (path.startsWith('/v1/betaTesters?')) return this.appTesters;
    if (path.startsWith('/v1/betaAppLocalizations?')) return this.localizations;
    if (path.startsWith('/v1/builds?')) return [this.build];
    if (path.startsWith('/v1/betaAppReviewSubmissions?'))
      return this.submissions;
    const testerMatch = /^\/v1\/betaGroups\/([^/]+)\/betaTesters\?/u.exec(path);
    if (testerMatch?.[1] !== undefined) {
      return this.groupTesters.get(testerMatch[1]) ?? [];
    }
    const buildMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/builds\?/u.exec(path);
    if (buildMatch?.[1] !== undefined) {
      return this.groupBuilds.get(buildMatch[1]) ?? [];
    }
    throw new Error(`Unexpected list path ${path}`);
  }

  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    if (
      path === '/v1/apps/app-1/betaAppReviewDetail' &&
      expectedType === 'betaAppReviewDetails'
    ) {
      return this.reviewDetails;
    }
    throw new Error(`Unexpected get path ${path}`);
  }

  async mutate(
    method: 'PATCH' | 'POST',
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    this.mutations.push({ body, method, path });
    if (method === 'POST' && path === '/v1/betaGroups') {
      const attributes = dataAttributes(body);
      const internal = attributes.isInternalGroup === true;
      const group = resource(
        'betaGroups',
        internal ? 'created-internal-group' : 'created-external-group',
        attributes,
      );
      this.groups.push(group);
      this.groupTesters.set(group.id, []);
      this.groupBuilds.set(group.id, []);
      return group;
    }
    if (method === 'POST' && path === '/v1/betaTesters') {
      const attributes = dataAttributes(body);
      const tester = resource(
        'betaTesters',
        `tester-${this.appTesters.length + 1}`,
        {
          email: attributes.email,
        },
      );
      const groupId = relationshipId(body, 'betaGroups');
      this.appTesters.push(tester);
      this.groupTesters.get(groupId)?.push(tester);
      return tester;
    }
    const testerRelationshipMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/betaTesters$/u.exec(path);
    if (method === 'POST' && testerRelationshipMatch?.[1] !== undefined) {
      if (
        typeof body !== 'object' ||
        body === null ||
        !('data' in body) ||
        !Array.isArray(body.data)
      ) {
        throw new Error('Expected tester relationship linkages.');
      }
      const target = this.groupTesters.get(testerRelationshipMatch[1]);
      for (const linkage of body.data) {
        if (
          typeof linkage !== 'object' ||
          linkage === null ||
          !('id' in linkage)
        ) {
          throw new Error('Expected tester relationship linkage ID.');
        }
        const tester = this.appTesters.find(({ id }) => id === linkage.id);
        if (tester !== undefined) target?.push(tester);
      }
      return null;
    }
    if (method === 'PATCH' && path === '/v1/betaAppReviewDetails/review-1') {
      this.reviewDetails = resource(
        'betaAppReviewDetails',
        'review-1',
        dataAttributes(body),
      );
      return this.reviewDetails;
    }
    if (method === 'POST' && path === '/v1/betaAppLocalizations') {
      const localization = resource(
        'betaAppLocalizations',
        'localization-1',
        dataAttributes(body),
      );
      this.localizations.push(localization);
      return localization;
    }
    const buildMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/builds$/u.exec(path);
    if (method === 'POST' && buildMatch?.[1] !== undefined) {
      this.groupBuilds.get(buildMatch[1])?.push(this.build);
      return null;
    }
    if (method === 'POST' && path === '/v1/betaAppReviewSubmissions') {
      const submission = resource('betaAppReviewSubmissions', 'submission-1', {
        betaReviewState: 'WAITING_FOR_REVIEW',
      });
      this.submissions.push(submission);
      return submission;
    }
    throw new Error(
      `Unexpected mutation ${method} ${path} (${expectedType ?? 'no type'}).`,
    );
  }
}

class PlanClient extends StatefulClient {
  override readonly groups: JsonApiResource[] = [];

  override async mutate(): Promise<JsonApiResource | null> {
    throw new Error('Plan mode attempted a mutation.');
  }
}

const review: BetaReviewInfo = {
  betaDescription: 'Synthetic PSD EOC beta description.',
  contactEmail: 'review@example.invalid',
  contactFirstName: 'Synthetic',
  contactLastName: 'Reviewer',
  contactPhone: '+12065550100',
  demoAccountRequired: false,
  feedbackEmail: 'feedback@example.invalid',
  locale: 'en-US',
  notes: 'Synthetic review notes.',
};

describe('App Store Connect authentication', () => {
  test('creates a standards-compliant short-lived ES256 token', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const token = createAscJwt(
      {
        issuerId: 'issuer-id',
        keyId: 'key-id',
        privateKey: privateKey
          .export({ format: 'pem', type: 'pkcs8' })
          .toString(),
      },
      new Date('2026-08-08T12:00:00Z'),
    );
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    expect(headerPart).toBeDefined();
    expect(payloadPart).toBeDefined();
    expect(signaturePart).toBeDefined();
    const header = JSON.parse(
      Buffer.from(headerPart ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const payload = JSON.parse(
      Buffer.from(payloadPart ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'ES256', kid: 'key-id', typ: 'JWT' });
    expect(payload.aud).toBe('appstoreconnect-v1');
    expect(payload.iss).toBe('issuer-id');
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(
      1_200,
    );
    expect(
      verify(
        'sha256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        { dsaEncoding: 'ieee-p1363', key: publicKey },
        Buffer.from(signaturePart ?? '', 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('controlled input parsing', () => {
  test('parses BOM, RFC 4180 quoting, Google headers, and only user rows', () => {
    const testers = parseTesterCsv(
      '\uFEFFMember Email,Given Name,Family Name,Member Type\r\n' +
        'one@example.invalid,"Synthetic, One",Tester,USER\r\n' +
        'nested@example.invalid,Ignored,Group,GROUP\r\n' +
        'ONE@example.invalid,Duplicate,Tester,USER\r\n',
    );
    expect(testers).toEqual([
      {
        email: 'one@example.invalid',
        firstName: 'Synthetic, One',
        lastName: 'Tester',
      },
    ]);
  });

  test('rejects malformed data without echoing the address', () => {
    expect(() => parseTesterCsv('email\nnot-an-email\n')).toThrow('row 2');
    try {
      parseTesterCsv('email\nnot-an-email\n');
    } catch (error) {
      expect(String(error)).not.toContain('not-an-email');
    }
  });

  test('validates review access and does not accept unknown fields', () => {
    expect(parseReviewInfo(review)).toEqual(review);
    expect(() =>
      parseReviewInfo({ ...review, demoAccountRequired: true }),
    ).toThrow('needs both name and password');
    expect(() => parseReviewInfo({ ...review, surprise: true })).toThrow(
      'unsupported field surprise',
    );
    expect(() =>
      parseReviewInfo({ ...review, demoAccountPassword: 'unneeded' }),
    ).toThrow('forbidden when no demo account is required');
    expect(
      parseReviewInfo({
        ...review,
        demoAccountName: 'demo',
        demoAccountPassword: ' password with spaces ',
        demoAccountRequired: true,
      }).demoAccountPassword,
    ).toBe(' password with spaces ');
  });

  test('recognizes repository-contained paths', () => {
    expect(isPathInside('/repo/private/testers.csv', '/repo')).toBe(true);
    expect(isPathInside('/secure/testers.csv', '/repo')).toBe(false);
  });
});

describe('write gates and reconciliation', () => {
  test('CLI refuses an unconfirmed apply or incomplete beta review request', () => {
    expect(() => parseCli(['sync', '--apply'])).toThrow(
      '--confirm-apply net.psd401.eoc',
    );
    expect(() => parseCli(['sync', '--submit-beta-review'])).toThrow(
      'requires --review-info and --build',
    );
    expect(
      parseCli([
        'sync',
        '--submit-beta-review',
        '--review-info',
        '/secure/review.json',
        '--build',
        'build-1',
      ]).apply,
    ).toBe(false);
  });

  test('apply requires the exact build ID from a prior preview', async () => {
    await expect(
      syncTestFlight(new StatefulClient(), {
        apply: true,
        build: 'latest',
        externalTesters: [],
        internalTesters: [],
        submitBetaReview: false,
      }),
    ).rejects.toThrow('exact build ID');
  });

  test('plan mode describes all consequences without a mutation or sensitive values', async () => {
    const client = new PlanClient();
    const result = await syncTestFlight(client, {
      apply: false,
      build: 'latest',
      externalTesters: [{ email: 'external@example.invalid' }],
      internalTesters: [{ email: 'internal@example.invalid' }],
      reviewInfo: {
        ...review,
        demoAccountName: 'demo',
        demoAccountPassword: 'secret',
        demoAccountRequired: true,
      },
      submitBetaReview: true,
    });
    expect(result.mode).toBe('plan');
    expect(result.actions.filter(({ kind }) => kind === 'group')).toHaveLength(
      2,
    );
    expect(result.actions.filter(({ kind }) => kind === 'tester')).toHaveLength(
      3,
    );
    expect(
      result.actions.filter(({ kind }) => kind === 'build-distribution'),
    ).toHaveLength(2);
    expect(
      result.actions.some(({ kind }) => kind === 'beta-review-submission'),
    ).toBe(true);
    const output = JSON.stringify(result);
    expect(output).not.toContain('external@example.invalid');
    expect(output).not.toContain('internal@example.invalid');
    expect(output).not.toContain('secret');
    expect(result.selectedBuild).toEqual({
      audienceType: 'APP_STORE_ELIGIBLE',
      id: 'build-1',
      uploadedDate: '2026-08-08T12:00:00Z',
      version: '1',
    });
  });

  test('latest preview deterministically selects the first sorted build', async () => {
    class MultipleBuildClient extends StatefulClient {
      override async first(path: string): Promise<JsonApiResource | null> {
        expect(path).toContain('limit=1');
        expect(path).toContain('sort=-uploadedDate');
        return this.build;
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        if (path.startsWith('/v1/builds?')) {
          throw new Error('Latest build lookup followed pagination.');
        }
        return super.list(path);
      }
    }

    const result = await syncTestFlight(new MultipleBuildClient(), {
      apply: false,
      build: 'latest',
      externalTesters: [],
      internalTesters: [],
      submitBetaReview: false,
    });
    expect(result.selectedBuild?.id).toBe('build-1');
  });

  test('external review rejects an internal-only build before mutation', async () => {
    const client = new StatefulClient();
    client.buildAttributes.buildAudienceType = 'INTERNAL_ONLY';
    await expect(
      syncTestFlight(client, {
        apply: true,
        build: 'build-1',
        externalTesters: [],
        internalTesters: [],
        reviewInfo: review,
        submitBetaReview: true,
      }),
    ).rejects.toThrow('APP_STORE_ELIGIBLE');
    expect(client.mutations).toHaveLength(0);
  });

  test('preflights tester limits across every group in an audience', async () => {
    const client = new StatefulClient();
    client.groups.push(
      resource('betaGroups', 'other-internal-group', {
        hasAccessToAllBuilds: false,
        isInternalGroup: true,
        name: 'Other Internal',
      }),
    );
    client.groupTesters.set(
      'other-internal-group',
      Array.from({ length: 99 }, (_, index) =>
        resource('betaTesters', `existing-${index}`, {
          email: `existing-${index}@example.invalid`,
        }),
      ),
    );
    for (const index of [1, 2]) {
      client.users.push(
        resource('users', `new-user-${index}`, {
          allAppsVisible: true,
          roles: ['APP_MANAGER'],
          username: `new-${index}@example.invalid`,
        }),
      );
    }
    await expect(
      syncTestFlight(client, {
        apply: false,
        externalTesters: [],
        internalTesters: [
          { email: 'new-1@example.invalid' },
          { email: 'new-2@example.invalid' },
        ],
        submitBetaReview: false,
      }),
    ).rejects.toThrow('App-wide internal membership');
    expect(client.mutations).toHaveLength(0);
  });

  test('accepts Customer Support users as eligible internal testers', async () => {
    const client = new StatefulClient();
    client.users.push(
      resource('users', 'customer-support-user', {
        allAppsVisible: true,
        roles: ['CUSTOMER_SUPPORT'],
        username: 'support@example.invalid',
      }),
    );
    const result = await syncTestFlight(client, {
      apply: false,
      externalTesters: [],
      internalTesters: [{ email: 'support@example.invalid' }],
      submitBetaReview: false,
    });
    expect(
      result.actions.some(
        ({ detail }) =>
          detail ===
          '1 internal tester(s) are eligible App Store Connect users.',
      ),
    ).toBe(true);
  });

  test('rejected Beta App Review is never reported as unchanged success', async () => {
    const client = new StatefulClient();
    client.submissions.push(
      resource('betaAppReviewSubmissions', 'rejected-submission', {
        betaReviewState: 'REJECTED',
      }),
    );
    await expect(
      syncTestFlight(client, {
        apply: false,
        build: 'build-1',
        externalTesters: [],
        internalTesters: [],
        reviewInfo: review,
        submitBetaReview: true,
      }),
    ).rejects.toThrow('rejected by Beta App Review');
    expect(client.mutations).toHaveLength(0);
  });

  test('apply creates both required groups with private explicit-build settings', async () => {
    const client = new StatefulClient();
    client.groups.splice(0);
    const result = await syncTestFlight(client, {
      apply: true,
      externalTesters: [],
      internalTesters: [],
      submitBetaReview: false,
    });
    const groupCreates = client.mutations.filter(
      ({ method, path }) => method === 'POST' && path === '/v1/betaGroups',
    );
    expect(groupCreates).toHaveLength(2);
    expect(dataAttributes(groupCreates[0]?.body).isInternalGroup).toBe(true);
    expect(dataAttributes(groupCreates[1]?.body)).toMatchObject({
      hasAccessToAllBuilds: false,
      isInternalGroup: false,
      name: 'Staff',
      publicLinkEnabled: false,
    });
    expect(result.actions.at(-1)?.kind).toBe('verification');
  });

  test('batches large tester filters into bounded URLs', async () => {
    const client = new StatefulClient();
    const externalTesters = Array.from({ length: 120 }, (_, index) => ({
      email: `tester-${index}@example.invalid`,
    }));
    await syncTestFlight(client, {
      apply: false,
      externalTesters,
      internalTesters: [],
      submitBetaReview: false,
    });
    const testerLookups = client.listPaths.filter((path) =>
      path.startsWith('/v1/betaTesters?'),
    );
    expect(testerLookups).toHaveLength(3);
    expect(Math.max(...testerLookups.map((path) => path.length))).toBeLessThan(
      4_096,
    );
  });

  test('links an account-level tester instead of recreating it', async () => {
    const client = new StatefulClient();
    client.appTesters.push(
      resource('betaTesters', 'existing-account-tester', {
        email: 'existing@example.invalid',
      }),
    );
    await syncTestFlight(client, {
      apply: true,
      externalTesters: [{ email: 'existing@example.invalid' }],
      internalTesters: [],
      submitBetaReview: false,
    });
    expect(
      client.mutations.some(({ path }) => path === '/v1/betaTesters'),
    ).toBe(false);
    expect(
      client.mutations.some(({ path }) =>
        path.endsWith('/relationships/betaTesters'),
      ),
    ).toBe(true);
  });

  test('apply is additive, verifies read-back, and becomes idempotent', async () => {
    const client = new StatefulClient();
    const options = {
      apply: true,
      build: 'build-1',
      externalTesters: [{ email: 'external@example.invalid' }],
      internalTesters: [{ email: 'internal@example.invalid' }],
      reviewInfo: review,
      submitBetaReview: true,
    } as const;
    const first = await syncTestFlight(client, options);
    expect(first.actions.at(-1)).toEqual({
      detail: 'Read-back verification passed.',
      kind: 'verification',
      status: 'applied',
    });
    expect(
      client.mutations.some(({ path }) => path === '/v1/betaTesters'),
    ).toBe(true);
    expect(
      client.mutations.some(
        ({ path }) => path === '/v1/betaAppReviewSubmissions',
      ),
    ).toBe(true);
    expect(client.mutations.every(({ method }) => method !== 'DELETE')).toBe(
      true,
    );

    const mutationCount = client.mutations.length;
    const second = await syncTestFlight(client, options);
    expect(client.mutations).toHaveLength(mutationCount);
    expect(
      second.actions.filter(({ status }) => status === 'planned'),
    ).toHaveLength(0);
  });
});
