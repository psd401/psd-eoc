import { describe, expect, test } from 'bun:test';

import type { SeedSummary } from '../../db/seed';
import {
  assertExplorationAccessFixtureEvidence,
  createExplorationAccessFixture,
  seedExplorationAccessFixture,
  type ExplorationAccessFixture,
  type ExplorationAccessFixtureEvidence,
  type ExplorationAccessFixtureStore,
} from './access-fixture';
import {
  APPLICATION_LOGIN_PROBE_QUERY,
  assertApplicationRoleState,
  buildApplicationRoleStatements,
  configureAndVerifyApplicationRole,
  verifyApplicationLogin,
} from './application-role';
import {
  buildGetSecretValueRequest,
  getApplicationDatabaseSecret,
  parseApplicationDatabaseSecretResponse,
} from './application-secret';
import { runExplorationBootstrap } from './bootstrap';
import {
  EXPLORATION_AWS_ACCOUNT_ID,
  EXPLORATION_AWS_REGION,
  EXPLORATION_DATABASE_LOGIN,
  EXPLORATION_DATABASE_ROLE,
  readExplorationBootstrapConfig,
} from './config';

const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const ADMIN_SECRET_ARN =
  'arn:aws:secretsmanager:us-west-2:<aws-account-id>:secret:/psd-eoc/exploration-smoke/database/admin-AbCd12';
const APPLICATION_SECRET_ARN =
  'arn:aws:secretsmanager:us-west-2:<aws-account-id>:secret:/psd-eoc/exploration-smoke/database/application-EfGh34';
const RESOURCE_ARN =
  'arn:aws:rds:us-west-2:<aws-account-id>:cluster:psd-eoc-exploration-smoke';
const GOOGLE_SUBJECT = '123456789012345678901';

const syntheticSeedSummary: SeedSummary = Object.freeze({
  facilities: 2,
  neighborhoods: 1,
  neighborhoodFacilities: 2,
  audienceConfigurations: 2,
  audienceTargets: 6,
  groupSources: 3,
  rosterSourceConfigurations: 1,
  rosterSnapshots: 1,
  rosterRecipients: 4,
  rosterEndpoints: 12,
  eventTypes: 8,
  eventTypeVersions: 8,
  eventTypeTemplates: 72,
  integrationStatuses: 5,
  channelConfigurations: 3,
  events: 0,
  outboxMessages: 0,
});

function validConfigEnvironment(): Record<string, string> {
  return {
    AWS_ACCOUNT_ID: EXPLORATION_AWS_ACCOUNT_ID,
    AWS_REGION: EXPLORATION_AWS_REGION,
    DATABASE_NAME: 'psd_eoc',
    DATABASE_RESOURCE_ARN: RESOURCE_ARN,
    DATABASE_ADMIN_SECRET_ARN: ADMIN_SECRET_ARN,
    DATABASE_APPLICATION_SECRET_ARN: APPLICATION_SECRET_ARN,
    APPROVED_GOOGLE_SUBJECT: GOOGLE_SUBJECT,
    APPROVED_STAFF_EMAIL: 'approved.staff@psd401.net',
    APPROVED_STAFF_DISPLAY_NAME: 'Approved Staff',
    SOURCE_SHA,
  };
}

function fixtureEvidence(
  fixture: ExplorationAccessFixture,
): ExplorationAccessFixtureEvidence {
  return Object.freeze({
    activeAccessGroups: [
      {
        id: fixture.accessGroup.id,
        kind: 'google-group',
        purpose: 'access',
        active: true,
        googleGroupId: fixture.accessGroup.googleGroupId,
        email: fixture.accessGroup.email,
        fixtureKey: null,
      },
    ],
    users: [{ ...fixture.user }],
    roles: [{ role: 'staff' }],
    facilityScopes: [],
    snapshots: [{ ...fixture.snapshot }],
    snapshotGroups: [
      {
        groupSourceId: fixture.accessGroup.id,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'completed',
      },
      {
        groupSourceId: fixture.accessGroup.id,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
        completionKind: 'expected',
      },
    ],
    members: [
      {
        snapshotId: fixture.snapshot.id,
        userId: fixture.user.id,
        googleSubject: fixture.user.googleSubject,
        facilityScopeKind: 'district',
      },
    ],
    memberGroups: [
      {
        groupSourceId: fixture.accessGroup.id,
        groupSourceKind: 'google-group',
        groupPurpose: 'access',
      },
    ],
    channels: [
      {
        integrationId: 'aws-eum-sms',
        enabled: false,
        statusLabel: 'blocked',
      },
      {
        integrationId: 'expo-push',
        enabled: false,
        statusLabel: 'mocked',
      },
      {
        integrationId: 'ses-email',
        enabled: false,
        statusLabel: 'mocked',
      },
    ],
    matchingRosterRecipients: 0,
  });
}

describe('exploration-smoke configuration', () => {
  test('pins every database ARN to the approved account, region, and namespace', () => {
    expect(readExplorationBootstrapConfig(validConfigEnvironment())).toEqual({
      accountId: EXPLORATION_AWS_ACCOUNT_ID,
      region: EXPLORATION_AWS_REGION,
      databaseName: 'psd_eoc',
      databaseResourceArn: RESOURCE_ARN,
      databaseAdminSecretArn: ADMIN_SECRET_ARN,
      databaseApplicationSecretArn: APPLICATION_SECRET_ARN,
      approvedGoogleSubject: GOOGLE_SUBJECT,
      approvedStaffEmail: 'approved.staff@psd401.net',
      approvedStaffDisplayName: 'Approved Staff',
      sourceSha: SOURCE_SHA,
    });
  });

  test('rejects another account without reflecting supplied values', () => {
    const environment = validConfigEnvironment();
    environment.DATABASE_RESOURCE_ARN =
      'arn:aws:rds:us-west-2:000000000000:cluster:psd-eoc-exploration-smoke';
    let message = '';
    try {
      readExplorationBootstrapConfig(environment);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('outside the exploration-smoke account');
    expect(message).not.toContain('000000000000');
  });

  test('rejects personal or mixed-case email identities', () => {
    for (const email of ['kris@example.com', 'Approved.Staff@psd401.net']) {
      expect(() =>
        readExplorationBootstrapConfig({
          ...validConfigEnvironment(),
          APPROVED_STAFF_EMAIL: email,
        }),
      ).toThrow('APPROVED_STAFF_EMAIL');
    }
  });
});

describe('application database secret and role', () => {
  test('signs only a regional GetSecretValue request with temporary credentials', () => {
    const request = buildGetSecretValueRequest({
      credentials: {
        accessKeyId: 'ASIA1234567890ABCDEF',
        secretAccessKey: 'temporary-secret-key-material',
        sessionToken: 'temporary-session-token-material',
        expiration: new Date('2026-08-15T13:00:00.000Z'),
      },
      now: new Date('2026-08-15T12:00:00.000Z'),
      region: EXPLORATION_AWS_REGION,
      secretArn: APPLICATION_SECRET_ARN,
    });
    expect(request.endpoint).toBe(
      'https://secretsmanager.us-west-2.amazonaws.com/',
    );
    expect(request.headers['x-amz-target']).toBe(
      'secretsmanager.GetSecretValue',
    );
    expect(request.body).toBe(
      JSON.stringify({ SecretId: APPLICATION_SECRET_ARN }),
    );
    expect(request.headers.authorization).toContain(
      '/us-west-2/secretsmanager/aws4_request',
    );
  });

  test('accepts only the exact generated application LOGIN secret contract', () => {
    const password = 'A-strong-generated-password-value-123';
    expect(
      parseApplicationDatabaseSecretResponse(
        {
          ARN: APPLICATION_SECRET_ARN,
          SecretString: JSON.stringify({
            username: EXPLORATION_DATABASE_LOGIN,
            password,
          }),
        },
        APPLICATION_SECRET_ARN,
      ),
    ).toEqual({ username: EXPLORATION_DATABASE_LOGIN, password });

    expect(() =>
      parseApplicationDatabaseSecretResponse(
        {
          ARN: APPLICATION_SECRET_ARN,
          SecretString: JSON.stringify({
            username: 'postgres',
            password,
            host: 'database.example.invalid',
          }),
        },
        APPLICATION_SECRET_ARN,
      ),
    ).toThrow('secret response was invalid');
  });

  test('bounds the untrusted Secrets Manager response before parsing', async () => {
    const credentials = {
      accessKeyId: 'ASIA1234567890ABCDEF',
      secretAccessKey: 'temporary-secret-key-material',
      sessionToken: 'temporary-session-token-material',
    };
    const oversizedResponseFetch: typeof fetch = Object.assign(
      () => Promise.resolve(new Response('x'.repeat(64 * 1_024 + 1))),
      { preconnect: globalThis.fetch.preconnect },
    );
    await expect(
      getApplicationDatabaseSecret({
        credentials,
        fetchImplementation: oversizedResponseFetch,
        now: new Date('2026-08-15T12:00:00.000Z'),
        region: EXPLORATION_AWS_REGION,
        secretArn: APPLICATION_SECRET_ARN,
      }),
    ).rejects.toThrow('secret response was invalid');
  });

  test('creates an idempotent LOGIN DDL sequence and quotes the generated password', () => {
    const password = "generated-password-with-quote-'--123456";
    const statements = buildApplicationRoleStatements(password);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain('IF NOT EXISTS');
    expect(statements[1]).toContain(
      'LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    );
    expect(statements[1]).toContain("quote-''--123456'");
    expect(statements[2]).toContain('REVOKE %I');
    expect(statements[3]).toBe(
      `GRANT "${EXPLORATION_DATABASE_ROLE}" TO "${EXPLORATION_DATABASE_LOGIN}"`,
    );
    expect(statements[4]).toBe(
      `REVOKE ADMIN OPTION FOR "${EXPLORATION_DATABASE_ROLE}" FROM "${EXPLORATION_DATABASE_LOGIN}"`,
    );
  });

  test('requires exact NOLOGIN/LOGIN flags and one direct membership', async () => {
    const roleRows = [
      {
        roleName: EXPLORATION_DATABASE_ROLE,
        canLogin: false,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        inherits: true,
      },
      {
        roleName: EXPLORATION_DATABASE_LOGIN,
        canLogin: true,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        inherits: true,
      },
    ];
    expect(
      assertApplicationRoleState(roleRows, [
        { grantedRole: EXPLORATION_DATABASE_ROLE, adminOption: false },
      ]),
    ).toEqual({
      applicationLogin: EXPLORATION_DATABASE_LOGIN,
      inheritedRole: EXPLORATION_DATABASE_ROLE,
      directMembershipCount: 1,
      privilegedFlags: false,
    });
    expect(() =>
      assertApplicationRoleState(roleRows, [
        { grantedRole: EXPLORATION_DATABASE_ROLE, adminOption: false },
        { grantedRole: 'unexpected_role', adminOption: false },
      ]),
    ).toThrow('unexpected role membership');

    const statements: string[] = [];
    const executor = {
      async execute(_secretArn: string, sql: string) {
        statements.push(sql);
        if (sql.includes('FROM pg_catalog.pg_roles')) return roleRows;
        if (sql.includes('FROM pg_catalog.pg_auth_members')) {
          return [
            { grantedRole: EXPLORATION_DATABASE_ROLE, adminOption: false },
          ];
        }
        if (sql === APPLICATION_LOGIN_PROBE_QUERY) {
          return [
            {
              currentUser: EXPLORATION_DATABASE_LOGIN,
              sessionUser: EXPLORATION_DATABASE_LOGIN,
              applicationRoleMember: true,
            },
          ];
        }
        return [];
      },
    };
    await configureAndVerifyApplicationRole({
      administratorSecretArn: ADMIN_SECRET_ARN,
      executor,
      password: 'A-strong-generated-password-value-123',
    });
    await verifyApplicationLogin({
      applicationSecretArn: APPLICATION_SECRET_ARN,
      executor,
    });
    expect(statements).toContain(APPLICATION_LOGIN_PROBE_QUERY);
  });
});

describe('approved access fixture', () => {
  const fixtureInput = {
    googleSubject: GOOGLE_SUBJECT,
    staffEmail: 'approved.staff@psd401.net',
    staffDisplayName: 'Approved Staff',
  } as const;
  const fixture = createExplorationAccessFixture(fixtureInput);

  test('is deterministic, Google-group-shaped, and contains no recipient/student payload', () => {
    expect(createExplorationAccessFixture(fixtureInput)).toEqual(fixture);
    expect(fixture.snapshot.capturedAt.toISOString()).toBe(
      '2026-08-15T12:00:00.000Z',
    );
    expect(fixture.accessGroup).toMatchObject({
      kind: 'google-group',
      purpose: 'access',
      googleGroupId: 'exploration-smoke-approved-access.invalid',
      email: 'exploration-smoke-access@example.invalid',
    });
    expect(fixture.role).toEqual({ userId: fixture.user.id, role: 'staff' });
    expect(JSON.stringify(fixture)).not.toMatch(
      /student|recipient|phoneNumber|pushToken|endpoint/iu,
    );
  });

  test('accepts one exact identity graph and rejects any enabled provider', () => {
    const evidence = fixtureEvidence(fixture);
    expect(assertExplorationAccessFixtureEvidence(fixture, evidence)).toEqual({
      accessGroups: 1,
      users: 1,
      staffRoles: 1,
      accessSnapshots: 1,
      notificationChannelsEnabled: 0,
      matchingRosterRecipients: 0,
    });
    expect(() =>
      assertExplorationAccessFixtureEvidence(fixture, {
        ...evidence,
        channels: evidence.channels.map((channel, index) =>
          index === 1 ? { ...channel, enabled: true } : channel,
        ),
      }),
    ).toThrow('notification channel');
  });

  test('is repeatable without changing the fixture identity', async () => {
    let applies = 0;
    let persisted: ExplorationAccessFixture | undefined;
    const store: ExplorationAccessFixtureStore = {
      async apply(received): Promise<void> {
        applies += 1;
        persisted ??= received;
      },
      async readEvidence() {
        if (persisted === undefined) {
          throw new Error('fixture was not persisted');
        }
        return fixtureEvidence(persisted);
      },
    };
    const first = await seedExplorationAccessFixture({ fixture, store });
    const independentlyCreatedFixture =
      createExplorationAccessFixture(fixtureInput);
    const second = await seedExplorationAccessFixture({
      fixture: independentlyCreatedFixture,
      store,
    });
    expect(independentlyCreatedFixture).toEqual(fixture);
    expect(second).toEqual(first);
    expect(applies).toBe(2);
  });
});

describe('bootstrap coordinator', () => {
  test('reapplies migrations/seeds idempotently in the safe order', async () => {
    const config = readExplorationBootstrapConfig(validConfigEnvironment());
    const calls: string[] = [];
    const dependencies = {
      async readApplicationSecret() {
        calls.push('read-application-secret');
        return {
          username: EXPLORATION_DATABASE_LOGIN,
          password: 'A-strong-generated-password-value-123',
        } as const;
      },
      async migrate(): Promise<void> {
        calls.push('migrate-admin');
      },
      async configureApplicationRole() {
        calls.push('configure-application-role');
        return {
          applicationLogin: EXPLORATION_DATABASE_LOGIN,
          inheritedRole: EXPLORATION_DATABASE_ROLE,
          directMembershipCount: 1,
          privilegedFlags: false,
        } as const;
      },
      async seedSynthetic() {
        calls.push('seed-synthetic');
        return syntheticSeedSummary;
      },
      async seedApprovedAccess() {
        calls.push('seed-approved-access');
        return {
          accessGroups: 1,
          users: 1,
          staffRoles: 1,
          accessSnapshots: 1,
          notificationChannelsEnabled: 0,
          matchingRosterRecipients: 0,
        } as const;
      },
      async verifyApplicationLogin(): Promise<void> {
        calls.push('verify-application-login');
      },
    };

    const first = await runExplorationBootstrap(config, dependencies);
    const second = await runExplorationBootstrap(config, dependencies);
    expect(second).toEqual(first);
    const expectedRunOrder = [
      'read-application-secret',
      'migrate-admin',
      'configure-application-role',
      'seed-synthetic',
      'seed-approved-access',
      'verify-application-login',
    ];
    expect(calls).toEqual([...expectedRunOrder, ...expectedRunOrder]);
    expect(first.integrations).toEqual({
      googleOidc: 'configured-unverified',
      googleGroups: 'mocked',
      messaging: 'disabled',
    });
  });
});

describe('immutable server image contract', () => {
  test('pins the Bun base, reviewed source SHA, non-root runtime, and server-only workspace', async () => {
    const dockerfile = await Bun.file(
      new URL('../../container/exploration-smoke.Dockerfile', import.meta.url),
    ).text();
    expect(dockerfile).toContain(
      'oven/bun:1.2.23-alpine@sha256:0841c588f6304300baf1d395ae339ce09a6e18c4b6a7cdd4fddcbdb87a2f096a',
    );
    expect(dockerfile).toContain("'^[0-9a-f]{40}$'");
    expect(dockerfile).toContain(
      'manifest.workspaces = ["packages/contracts", "packages/server"]',
    );
    expect(dockerfile).toContain(
      'RUN bun install --frozen-lockfile --production',
    );
    expect(dockerfile).toContain('USER bun');
    expect(dockerfile).toContain(
      'CMD ["bun", "--cwd", "packages/server", "start"]',
    );
    expect(dockerfile).not.toMatch(/(?:npm|npx|:latest)/u);
  });

  test('excludes credentials, local build output, mobile, and infrastructure from context', async () => {
    const ignore = await Bun.file(
      new URL(
        '../../container/exploration-smoke.Dockerfile.dockerignore',
        import.meta.url,
      ),
    ).text();
    for (const excluded of [
      '.git',
      '.github',
      '.codex',
      '**/.next',
      '**/node_modules',
      'infra',
      'packages/mobile',
    ]) {
      expect(ignore.split('\n')).toContain(excluded);
    }
  });
});
