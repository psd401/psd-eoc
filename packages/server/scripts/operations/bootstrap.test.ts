import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import type { ReferenceSeedSummary } from '../../db/seed';
import {
  assertAccessFixtureSnapshotCurrent,
  assertAccessFixtureEvidence,
  assertNoRealAccessGroups,
  createAccessFixture,
  seedAccessFixture,
  type AccessFixture,
  type AccessFixtureEvidence,
  type AccessFixtureStore,
} from './access-fixture';
import {
  APPLICATION_LOGIN_PROBE_QUERY,
  assertApplicationRoleState,
  buildApplicationRoleStatements,
  configureAndVerifyApplicationRole,
  verifyApplicationLogin,
  verifyDatabaseTls,
} from './application-role';
import {
  buildGetSecretValueRequest,
  getApplicationDatabaseSecret,
  parseApplicationDatabaseSecretResponse,
} from './application-secret';
import {
  runBootstrap,
  verifyCanonicalSyntheticRemoval,
  type CanonicalSyntheticRemovalSummary,
} from './bootstrap';
import {
  AWS_ACCOUNT_ID,
  AWS_REGION,
  DATABASE_LOGIN,
  DATABASE_ROLE,
  readBootstrapConfig,
} from './config';

const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const APPLICATION_SECRET_ARN =
  'arn:aws:secretsmanager:us-west-2:<aws-account-id>:secret:/psd-eoc/exploration-smoke/database/application-EfGh34';
const RESOURCE_ARN =
  'arn:aws:rds:us-west-2:<aws-account-id>:cluster:psd-eoc-exploration-smoke';
const GOOGLE_SUBJECT = '123456789012345678901';
const DATABASE_HOST =
  'psd-eoc-exploration-smoke.cluster-abcdefghijkl.us-west-2.rds.amazonaws.com';
const DATABASE_ADMIN_PASSWORD = 'synthetic-admin-password-value-123456';
const DATABASE_APPLICATION_PASSWORD =
  'synthetic-application-password-value-123456';
const DATABASE_SSL_ROOT_CERT = new URL(
  '../../certs/aws-rds-global-bundle.pem',
  import.meta.url,
).pathname;
const FIRST_ACCESS_SNAPSHOT = Object.freeze({
  id: '00000000-0000-4000-8000-000000000165',
  version: 163,
  capturedAt: new Date('2026-08-16T17:00:00.000Z'),
});
const SECOND_ACCESS_SNAPSHOT = Object.freeze({
  id: '00000000-0000-4000-8000-000000000166',
  version: 164,
  capturedAt: new Date('2026-08-16T18:00:00.000Z'),
});

const referenceSeedSummary: ReferenceSeedSummary = Object.freeze({
  eventTypes: 8,
  eventTypeVersions: 8,
  eventTypeTemplates: 72,
  integrationStatuses: 5,
  channelConfigurations: 3,
  events: 0,
  outboxMessages: 0,
});

const canonicalSyntheticRemovalSummary: CanonicalSyntheticRemovalSummary =
  Object.freeze({
    operationalRows: Object.freeze({
      facilities: 0,
      neighborhoodVersions: 0,
      neighborhoodFacilities: 0,
      groupSources: 0,
      audienceConfigurations: 0,
      audienceTargets: 0,
      rosterSourceConfigurations: 0,
      rosterSourceConfigurationFacilities: 0,
      rosterSourceConfigurationGroups: 0,
      rosterSnapshots: 0,
      rosterSnapshotFacilities: 0,
      rosterSnapshotSources: 0,
      rosterRecipients: 0,
      rosterRecipientGroupSources: 0,
      rosterEndpoints: 0,
      total: 0,
    }),
    retainedTruth: Object.freeze({
      facilityAnchors: 2,
      securityAuditEntries: 2,
      idempotencyRecords: 1,
    }),
  });

function validConfigEnvironment(): Record<string, string> {
  return {
    AWS_ACCOUNT_ID: AWS_ACCOUNT_ID,
    AWS_REGION: AWS_REGION,
    DATABASE_DRIVER: 'postgres',
    DATABASE_HOST,
    DATABASE_PORT: '5432',
    DATABASE_NAME: 'psd_eoc',
    DATABASE_SSL_ROOT_CERT,
    DATABASE_MAX_CONNECTIONS: '1',
    DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
    DATABASE_IDLE_TIMEOUT_SECONDS: '20',
    DATABASE_ADMIN_USERNAME: 'psd_eoc_admin',
    DATABASE_ADMIN_PASSWORD,
    DATABASE_APPLICATION_USERNAME: DATABASE_LOGIN,
    DATABASE_APPLICATION_PASSWORD,
    APPROVED_GOOGLE_SUBJECT: GOOGLE_SUBJECT,
    APPROVED_STAFF_EMAIL: 'approved.staff@psd401.net',
    APPROVED_STAFF_DISPLAY_NAME: 'Approved Staff',
    SOURCE_SHA,
  };
}

function fixtureEvidence(fixture: AccessFixture): AccessFixtureEvidence {
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
  test('pins the native writer, roles, TLS bundle, and connection bounds', () => {
    expect(readBootstrapConfig(validConfigEnvironment())).toEqual({
      accountId: AWS_ACCOUNT_ID,
      region: AWS_REGION,
      databaseDriver: 'postgres',
      databaseHost: DATABASE_HOST,
      databasePort: 5432,
      databaseName: 'psd_eoc',
      databaseSslRootCertificate: DATABASE_SSL_ROOT_CERT,
      databaseMaxConnections: 1,
      databaseConnectTimeoutSeconds: 10,
      databaseIdleTimeoutSeconds: 20,
      databaseAdminUsername: 'psd_eoc_admin',
      databaseAdminPassword: DATABASE_ADMIN_PASSWORD,
      databaseApplicationUsername: DATABASE_LOGIN,
      databaseApplicationPassword: DATABASE_APPLICATION_PASSWORD,
      approvedGoogleSubject: GOOGLE_SUBJECT,
      approvedStaffEmail: 'approved.staff@psd401.net',
      approvedStaffDisplayName: 'Approved Staff',
      sourceSha: SOURCE_SHA,
      mode: 'migrate',
    });
  });

  test('defaults to migrations only and accepts nothing but the two modes', () => {
    expect(
      readBootstrapConfig({
        ...validConfigEnvironment(),
        BOOTSTRAP_MODE: 'seed-access-fixture',
      }).mode,
    ).toBe('seed-access-fixture');
    for (const mode of ['', 'full', 'MIGRATE', 'seed', 'migrate ']) {
      expect(() =>
        readBootstrapConfig({
          ...validConfigEnvironment(),
          BOOTSTRAP_MODE: mode,
        }),
      ).toThrow('BOOTSTRAP_MODE');
    }
  });

  test('rejects Data API inputs and malformed native credentials without reflection', () => {
    for (const environment of [
      { ...validConfigEnvironment(), DATABASE_RESOURCE_ARN: RESOURCE_ARN },
      {
        ...validConfigEnvironment(),
        DATABASE_HOST: 'not-the-exploration-writer.example.invalid',
      },
      {
        ...validConfigEnvironment(),
        DATABASE_ADMIN_PASSWORD: 'too-short',
      },
    ]) {
      let message = '';
      try {
        readBootstrapConfig(environment);
      } catch (error) {
        message = String(error);
      }
      expect(message).toBeTruthy();
      expect(message).not.toContain(RESOURCE_ARN);
      expect(message).not.toContain('not-the-exploration-writer');
      expect(message).not.toContain('too-short');
    }
  });

  test('rejects personal or mixed-case email identities', () => {
    for (const email of ['kris@example.com', 'Approved.Staff@psd401.net']) {
      expect(() =>
        readBootstrapConfig({
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
      region: AWS_REGION,
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
            username: DATABASE_LOGIN,
            password,
          }),
        },
        APPLICATION_SECRET_ARN,
      ),
    ).toEqual({ username: DATABASE_LOGIN, password });

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
        region: AWS_REGION,
        secretArn: APPLICATION_SECRET_ARN,
      }),
    ).rejects.toThrow('secret response was invalid');
  });

  test('creates an idempotent LOGIN DDL sequence and quotes the generated password', () => {
    const password = "generated-password-with-quote-'--123456";
    const statements = buildApplicationRoleStatements(password);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain('IF NOT EXISTS');
    expect(statements[1]).toBe(
      `ALTER ROLE "${DATABASE_LOGIN}" WITH PASSWORD 'generated-password-with-quote-''--123456'`,
    );
    expect(statements[1]).not.toContain('NOSUPERUSER');
    expect(statements[2]).toContain('REVOKE %I');
    expect(statements[3]).toBe(
      `GRANT "${DATABASE_ROLE}" TO "${DATABASE_LOGIN}"`,
    );
    expect(statements[4]).toBe(
      `REVOKE ADMIN OPTION FOR "${DATABASE_ROLE}" FROM "${DATABASE_LOGIN}"`,
    );
  });

  test('requires exact NOLOGIN/LOGIN flags and one direct membership', async () => {
    const roleRows = [
      {
        roleName: DATABASE_ROLE,
        canLogin: false,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        inherits: true,
      },
      {
        roleName: DATABASE_LOGIN,
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
        { grantedRole: DATABASE_ROLE, adminOption: false },
      ]),
    ).toEqual({
      applicationLogin: DATABASE_LOGIN,
      inheritedRole: DATABASE_ROLE,
      directMembershipCount: 1,
      privilegedFlags: false,
    });
    expect(() =>
      assertApplicationRoleState(roleRows, [
        { grantedRole: DATABASE_ROLE, adminOption: false },
        { grantedRole: 'unexpected_role', adminOption: false },
      ]),
    ).toThrow('unexpected role membership');

    const statements: string[] = [];
    const executor = {
      async execute(statement: string) {
        statements.push(statement);
        if (statement.includes('FROM pg_catalog.pg_roles')) return roleRows;
        if (statement.includes('FROM pg_catalog.pg_auth_members')) {
          return [{ grantedRole: DATABASE_ROLE, adminOption: false }];
        }
        if (statement === APPLICATION_LOGIN_PROBE_QUERY) {
          return [
            {
              currentUser: DATABASE_LOGIN,
              sessionUser: DATABASE_LOGIN,
              applicationRoleMember: true,
            },
          ];
        }
        if (statement.includes('FROM pg_catalog.pg_stat_ssl')) {
          return [{ ssl: true, tlsVersion: 'TLSv1.3' }];
        }
        return [];
      },
    };
    await configureAndVerifyApplicationRole({
      executor,
      password: 'A-strong-generated-password-value-123',
    });
    await verifyApplicationLogin({ executor });
    await verifyDatabaseTls({ executor });
    expect(statements).toContain(APPLICATION_LOGIN_PROBE_QUERY);
  });
});

describe('approved access fixture', () => {
  const fixtureInput = {
    googleSubject: GOOGLE_SUBJECT,
    staffEmail: 'approved.staff@psd401.net',
    staffDisplayName: 'Approved Staff',
  } as const;
  const fixture = createAccessFixture(fixtureInput, FIRST_ACCESS_SNAPSHOT);

  test('is deterministic for one allocated snapshot, current, and contains no recipient/student payload', () => {
    expect(createAccessFixture(fixtureInput, FIRST_ACCESS_SNAPSHOT)).toEqual(
      fixture,
    );
    expect(fixture.snapshot.capturedAt.toISOString()).toBe(
      FIRST_ACCESS_SNAPSHOT.capturedAt.toISOString(),
    );
    expect(() =>
      assertAccessFixtureSnapshotCurrent(
        fixture,
        new Date(FIRST_ACCESS_SNAPSHOT.capturedAt.getTime() + 5 * 60 * 1_000),
      ),
    ).not.toThrow();
    expect(() =>
      assertAccessFixtureSnapshotCurrent(
        fixture,
        new Date(
          FIRST_ACCESS_SNAPSHOT.capturedAt.getTime() + 5 * 60 * 1_000 + 1,
        ),
      ),
    ).toThrow('not current');
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

  test('scopes fixture identity proof while rejecting any enabled provider', () => {
    const evidence = fixtureEvidence(fixture);
    expect(
      assertAccessFixtureEvidence(fixture, {
        ...evidence,
        activeAccessGroups: [
          ...evidence.activeAccessGroups,
          {
            id: '00000000-0000-4000-8000-000000000197',
            kind: 'google-group',
            purpose: 'access',
            active: true,
            googleGroupId: 'real-approved-group',
            email: 'approved-group@psd401.net',
            fixtureKey: null,
          },
        ],
        roles: [...evidence.roles, { role: 'admin' }],
      }),
    ).toEqual({
      accessGroups: 1,
      users: 1,
      staffRoles: 1,
      accessSnapshots: 1,
      notificationChannelsEnabled: 0,
      matchingRosterRecipients: 0,
    });
    expect(() =>
      assertAccessFixtureEvidence(fixture, {
        ...evidence,
        channels: evidence.channels.map((channel, index) =>
          index === 1 ? { ...channel, enabled: true } : channel,
        ),
      }),
    ).toThrow('notification channel');
  });

  test('refuses to publish onto a stack that already has real access groups', () => {
    expect(() => assertNoRealAccessGroups([])).not.toThrow();
    for (const activeAccessGroupIds of [
      ['00000000-0000-4000-8000-000000000197'],
      [
        '00000000-0000-4000-8000-000000000197',
        '00000000-0000-4000-8000-000000000198',
      ],
    ]) {
      expect(() => assertNoRealAccessGroups(activeAccessGroupIds)).toThrow(
        'already has active access groups',
      );
    }
  });

  test('replays within one bootstrap and appends a newer snapshot later', async () => {
    let publishes = 0;
    const allocated: AccessFixture[] = [];
    let persisted: AccessFixture | undefined;
    const store: AccessFixtureStore = {
      async publish(identity, replay) {
        publishes += 1;
        const published =
          replay ??
          createAccessFixture(
            identity,
            allocated.length === 0
              ? FIRST_ACCESS_SNAPSHOT
              : SECOND_ACCESS_SNAPSHOT,
          );
        if (replay === null) allocated.push(published);
        persisted = published;
        return published;
      },
      async readEvidence(received) {
        if (persisted === undefined) {
          throw new Error('fixture was not persisted');
        }
        expect(received).toEqual(persisted);
        return fixtureEvidence(received);
      },
    };
    const first = await seedAccessFixture({
      identity: fixtureInput,
      replay: null,
      store,
      now: () => new Date(FIRST_ACCESS_SNAPSHOT.capturedAt),
    });
    const second = await seedAccessFixture({
      identity: fixtureInput,
      replay: first.fixture,
      store,
      now: () => new Date(FIRST_ACCESS_SNAPSHOT.capturedAt),
    });
    const later = await seedAccessFixture({
      identity: fixtureInput,
      replay: null,
      store,
      now: () => new Date(SECOND_ACCESS_SNAPSHOT.capturedAt),
    });
    expect(second).toEqual(first);
    expect(later.fixture.snapshot).toEqual({
      ...SECOND_ACCESS_SNAPSHOT,
      syncStartedAt: SECOND_ACCESS_SNAPSHOT.capturedAt,
      complete: true,
    });
    expect(later.fixture.snapshot.id).not.toBe(first.fixture.snapshot.id);
    expect(later.fixture.snapshot.version).toBe(
      first.fixture.snapshot.version + 1,
    );
    expect(allocated).toEqual([first.fixture, later.fixture]);
    expect(allocated[0]).toEqual(fixture);
    expect(publishes).toBe(3);
  });
});

describe('bootstrap coordinator', () => {
  test('requires exact zero operational fixture rows and retained truth', async () => {
    const exactReadback = {
      ...canonicalSyntheticRemovalSummary.operationalRows,
      facilityAnchors: 2,
      securityAuditEntries: 2,
      reviewedSecurityAuditEntries: 2,
      idempotencyRecords: 1,
    };
    let statement = '';
    expect(
      await verifyCanonicalSyntheticRemoval({
        executor: {
          async execute(sqlStatement) {
            statement = sqlStatement;
            return [exactReadback];
          },
        },
      }),
    ).toEqual(canonicalSyntheticRemovalSummary);
    expect(statement).toContain('SYN-NORTH');
    expect(statement).toContain('Synthetic Twin Campuses');
    expect(statement).toContain(
      '8e7cd227e4b9b725834acdb718866e0156b47fbdd6184136c83eec7f4077b2da',
    );
    expect(statement).toContain('81ec2daa-83e7-4ded-a914-b72bdda54e8e');

    for (const invalidReadback of [
      { ...exactReadback, facilities: 1 },
      { ...exactReadback, reviewedSecurityAuditEntries: 1 },
      { ...exactReadback, facilityAnchors: 1 },
      { ...exactReadback, idempotencyRecords: 0 },
    ]) {
      await expect(
        verifyCanonicalSyntheticRemoval({
          executor: {
            async execute() {
              return [invalidReadback];
            },
          },
        }),
      ).rejects.toThrow('Canonical synthetic removal readback failed.');
    }
  });

  test('runs native TLS, migrations, and fixtures twice under one lock', async () => {
    const config = readBootstrapConfig({
      ...validConfigEnvironment(),
      BOOTSTRAP_MODE: 'seed-access-fixture',
    });
    const calls: string[] = [];
    const dependencies = {
      async acquireAdvisoryLock(): Promise<void> {
        calls.push('acquire-lock');
      },
      async releaseAdvisoryLock(): Promise<void> {
        calls.push('release-lock');
      },
      async verifyAdministratorTls(): Promise<void> {
        calls.push('verify-admin-tls');
      },
      async migrate(): Promise<void> {
        calls.push('migrate-admin');
      },
      async configureApplicationRole() {
        calls.push('configure-application-role');
        return {
          applicationLogin: DATABASE_LOGIN,
          inheritedRole: DATABASE_ROLE,
          directMembershipCount: 1,
          privilegedFlags: false,
        } as const;
      },
      async seedReference() {
        calls.push('seed-reference');
        return referenceSeedSummary;
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
      async verifyCanonicalSyntheticRemoval() {
        calls.push('verify-canonical-synthetic-removal');
        return canonicalSyntheticRemovalSummary;
      },
      async verifyApplicationLogin(): Promise<void> {
        calls.push('verify-application-login');
      },
      async verifyApplicationTls(): Promise<void> {
        calls.push('verify-application-tls');
      },
    };

    const summary = await runBootstrap(config, dependencies);
    const expectedRunOrder = [
      'verify-admin-tls',
      'migrate-admin',
      'configure-application-role',
      'seed-reference',
      'seed-approved-access',
      'verify-canonical-synthetic-removal',
      'verify-application-login',
      'verify-application-tls',
    ];
    expect(calls).toEqual([
      'acquire-lock',
      ...expectedRunOrder,
      ...expectedRunOrder,
      'release-lock',
    ]);
    expect(summary).toMatchObject({
      sourceSha: SOURCE_SHA,
      mode: 'seed-access-fixture',
      database: {
        transport: 'native-postgres',
        migrationsApplied: true,
        tlsVerified: true,
      },
      idempotence: { runs: 2, equivalent: true },
    });
    expect(summary.referenceSeed).toEqual(referenceSeedSummary);
    expect(summary.canonicalSyntheticRemoval).toEqual(
      canonicalSyntheticRemovalSummary,
    );
    expect(summary.integrations).toEqual({
      googleOidc: 'configured-unverified',
      googleGroups: 'mocked',
      messaging: 'disabled',
    });
  });

  test('migrates without touching the access fixture by default', async () => {
    const config = readBootstrapConfig(validConfigEnvironment());
    expect(config.mode).toBe('migrate');
    const calls: string[] = [];
    const dependencies = {
      async acquireAdvisoryLock(): Promise<void> {
        calls.push('acquire-lock');
      },
      async releaseAdvisoryLock(): Promise<void> {
        calls.push('release-lock');
      },
      async verifyAdministratorTls(): Promise<void> {
        calls.push('verify-admin-tls');
      },
      async migrate(): Promise<void> {
        calls.push('migrate-admin');
      },
      async configureApplicationRole() {
        calls.push('configure-application-role');
        return {
          applicationLogin: DATABASE_LOGIN,
          inheritedRole: DATABASE_ROLE,
          directMembershipCount: 1,
          privilegedFlags: false,
        } as const;
      },
      async seedReference() {
        calls.push('seed-reference');
        return referenceSeedSummary;
      },
      async seedApprovedAccess(): Promise<never> {
        throw new Error('a migration run must not seed the access fixture');
      },
      async verifyCanonicalSyntheticRemoval(): Promise<never> {
        throw new Error('a migration run must not read the fixture removal');
      },
      async verifyApplicationLogin(): Promise<void> {
        calls.push('verify-application-login');
      },
      async verifyApplicationTls(): Promise<void> {
        calls.push('verify-application-tls');
      },
    };

    const summary = await runBootstrap(config, dependencies);
    const expectedRunOrder = [
      'verify-admin-tls',
      'migrate-admin',
      'configure-application-role',
      'seed-reference',
      'verify-application-login',
      'verify-application-tls',
    ];
    expect(calls).toEqual([
      'acquire-lock',
      ...expectedRunOrder,
      ...expectedRunOrder,
      'release-lock',
    ]);
    expect(summary.mode).toBe('migrate');
    expect(summary.idempotence).toEqual({ runs: 2, equivalent: true });
    expect(summary.referenceSeed).toEqual(referenceSeedSummary);
    expect(summary.approvedAccess).toBeUndefined();
    expect(summary.canonicalSyntheticRemoval).toBeUndefined();
    expect(Object.keys(summary)).not.toContain('approvedAccess');
    expect(Object.keys(summary)).not.toContain('canonicalSyntheticRemoval');
  });

  test('releases the advisory lock after any native bootstrap failure', async () => {
    const calls: string[] = [];
    const dependencies = {
      async acquireAdvisoryLock(): Promise<void> {
        calls.push('acquire-lock');
      },
      async releaseAdvisoryLock(): Promise<void> {
        calls.push('release-lock');
      },
      async verifyAdministratorTls(): Promise<void> {
        calls.push('verify-admin-tls');
      },
      async migrate(): Promise<void> {
        calls.push('migrate');
        throw new Error('synthetic migration failure');
      },
      async configureApplicationRole() {
        throw new Error('unreachable');
      },
      async seedReference() {
        throw new Error('unreachable');
      },
      async seedApprovedAccess() {
        throw new Error('unreachable');
      },
      async verifyCanonicalSyntheticRemoval() {
        throw new Error('unreachable');
      },
      async verifyApplicationLogin(): Promise<void> {
        throw new Error('unreachable');
      },
      async verifyApplicationTls(): Promise<void> {
        throw new Error('unreachable');
      },
    };
    await expect(
      runBootstrap(readBootstrapConfig(validConfigEnvironment()), dependencies),
    ).rejects.toThrow('synthetic migration failure');
    expect(calls).toEqual([
      'acquire-lock',
      'verify-admin-tls',
      'migrate',
      'release-lock',
    ]);
  });
});

describe('immutable server image contract', () => {
  test('pins the Bun base, reviewed source SHA, non-root runtime, and server-only workspace', async () => {
    const dockerfile = await Bun.file(
      new URL('../../container/psd-eoc.Dockerfile', import.meta.url),
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
    expect(dockerfile).toContain(
      'COPY --from=build --chown=bun:bun /app/packages/server ./packages/server',
    );
    const imageInputs = [
      new URL('./bootstrap.ts', import.meta.url),
      new URL(
        '../../drizzle/migrations/0000_youthful_captain_stacy.sql',
        import.meta.url,
      ),
      new URL('../../certs/aws-rds-global-bundle.pem', import.meta.url),
    ];
    for (const input of imageInputs) {
      expect(await Bun.file(input).exists()).toBe(true);
    }
    const caBundle = await Bun.file(imageInputs[2]!).text();
    expect(caBundle.match(/-----BEGIN CERTIFICATE-----/gu)).toHaveLength(108);
    expect(caBundle).not.toContain('PRIVATE KEY');
    expect(createHash('sha256').update(caBundle).digest('hex')).toBe(
      '53af412739e58556da2f3d6343d6f4d73530839ab589b9e9e600e17f96984d49',
    );
    expect(dockerfile).not.toMatch(/(?:npm|npx|:latest)/u);
  });

  test('excludes credentials, local build output, mobile, and infrastructure from context', async () => {
    const ignore = await Bun.file(
      new URL(
        '../../container/psd-eoc.Dockerfile.dockerignore',
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
