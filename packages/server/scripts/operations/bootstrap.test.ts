import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import type { ReferenceSeedSummary } from '../../db/seed';
import {
  APPLICATION_LOGIN_PROBE_QUERY,
  assertApplicationRoleState,
  buildApplicationRoleStatements,
  configureAndVerifyApplicationRole,
  ROLE_STATE_QUERY,
  verifyApplicationLogin,
  verifyDatabaseTls,
} from './application-role';
import {
  buildGetSecretValueRequest,
  getApplicationDatabaseSecret,
  parseApplicationDatabaseSecretResponse,
} from './application-secret';
import { createRoleStatementExecutor, runBootstrap } from './bootstrap';
import { DATABASE_LOGIN, DATABASE_ROLE, readBootstrapConfig } from './config';

const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const APPLICATION_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:000000000000:secret:/psd-eoc/database/application-EfGh34';
const RESOURCE_ARN = 'arn:aws:rds:us-east-1:000000000000:cluster:psd-eoc';
const GOOGLE_SUBJECT = '123456789012345678901';
const DATABASE_HOST =
  'psd-eoc.cluster-abcdefghijkl.us-east-1.rds.amazonaws.com';
const DATABASE_ADMIN_PASSWORD = 'synthetic-admin-password-value-123456';
const DATABASE_APPLICATION_PASSWORD =
  'synthetic-application-password-value-123456';
const DATABASE_SSL_ROOT_CERT = new URL(
  '../../certs/aws-rds-global-bundle.pem',
  import.meta.url,
).pathname;
const referenceSeedSummary: ReferenceSeedSummary = Object.freeze({
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
    AWS_ACCOUNT_ID: '000000000000',
    AWS_REGION: 'us-east-1',
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
    APPROVED_STAFF_EMAIL: 'approved.staff@example.invalid',
    APPROVED_STAFF_DISPLAY_NAME: 'Approved Staff',
    SOURCE_SHA,
  };
}

describe('bootstrap configuration', () => {
  test('pins the native writer, roles, TLS bundle, and connection bounds', () => {
    expect(readBootstrapConfig(validConfigEnvironment())).toEqual({
      accountId: '000000000000',
      region: 'us-east-1',
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
      sourceSha: SOURCE_SHA,
      mode: 'migrate',
    });
  });

  test('defaults to migrations only and accepts nothing but the two modes', () => {
    expect(
      readBootstrapConfig({
        ...validConfigEnvironment(),
        BOOTSTRAP_MODE: 'migrate',
      }).mode,
    ).toBe('migrate');
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

  test('rejects an account or region that is not one', () => {
    for (const [name, value] of [
      ['AWS_ACCOUNT_ID', '12345'],
      ['AWS_ACCOUNT_ID', '00000000000a'],
      ['AWS_REGION', 'nowhere'],
      ['AWS_REGION', 'US-EAST-1'],
    ] as const) {
      expect(() =>
        readBootstrapConfig({ ...validConfigEnvironment(), [name]: value }),
      ).toThrow(name);
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
      region: 'us-east-1',
      secretArn: APPLICATION_SECRET_ARN,
    });
    expect(request.endpoint).toBe(
      'https://secretsmanager.us-east-1.amazonaws.com/',
    );
    expect(request.headers['x-amz-target']).toBe(
      'secretsmanager.GetSecretValue',
    );
    expect(request.body).toBe(
      JSON.stringify({ SecretId: APPLICATION_SECRET_ARN }),
    );
    expect(request.headers.authorization).toContain(
      '/us-east-1/secretsmanager/aws4_request',
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
        region: 'us-east-1',
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

describe('bootstrap coordinator', () => {
  test('runs native TLS, migrations, and the access bootstrap twice under one lock', async () => {
    const config = readBootstrapConfig({
      ...validConfigEnvironment(),
      BOOTSTRAP_MODE: 'migrate',
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
      async bootstrapAccess() {
        calls.push('bootstrap-access');
        return {
          kind: 'created' as const,
          groupSourceId: 'synthetic',
          email: 'admins@example.invalid',
        };
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
      'bootstrap-access',
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
      mode: 'migrate',
      database: {
        transport: 'native-postgres',
        migrationsApplied: true,
        tlsVerified: true,
      },
      idempotence: { runs: 2, equivalent: true },
    });
    expect(summary.referenceSeed).toEqual(referenceSeedSummary);
    expect(summary.accessBootstrap).toBe('created');
    expect(summary.integrations).toEqual({
      googleOidc: 'configured-unverified',
      googleGroups: 'mocked',
      messaging: 'disabled',
    });
  });

  test('migrates and leaves access alone when no initial group is configured', async () => {
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
      async bootstrapAccess() {
        calls.push('bootstrap-access');
        return { kind: 'not-configured' as const };
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
      // Runs on every deploy and reports that it had nothing to do.
      'bootstrap-access',
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
    expect(summary.accessBootstrap).toBe('not-configured');
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
      async bootstrapAccess() {
        calls.push('bootstrap-access');
        return {
          kind: 'created' as const,
          groupSourceId: 'synthetic',
          email: 'admins@example.invalid',
        };
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

describe('bootstrap failure reporting', () => {
  test('writes the cause to stderr and still exits non-zero', async () => {
    const environment = validConfigEnvironment();
    delete environment.DATABASE_HOST;
    const child = Bun.spawn(
      [process.execPath, new URL('./bootstrap.ts', import.meta.url).pathname],
      {
        env: { ...environment, PATH: process.env.PATH ?? '' },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Database bootstrap failed closed.');
    expect(stderr).toContain('name=BootstrapConfigurationError');
    expect(stderr).toContain(
      'message=Invalid bootstrap configuration: DATABASE_HOST.',
    );
    // The diagnostic names the variable at fault, never its value.
    for (const secret of [
      DATABASE_ADMIN_PASSWORD,
      DATABASE_APPLICATION_PASSWORD,
    ]) {
      expect(stderr).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    }
  });
});

describe('bootstrap statement executor', () => {
  // The executor reaches only `db.execute`; the rest of the connection surface
  // is irrelevant to what these tests prove.
  function connectionThat(execute: () => Promise<unknown>) {
    return { db: { execute } } as unknown as Parameters<
      typeof createRoleStatementExecutor
    >[0];
  }

  function driverError(): Error {
    return Object.assign(
      // Postgres reports the offending token, so a failure on the role DDL can
      // put the password literal in `message`.
      new Error(`syntax error at or near "${DATABASE_APPLICATION_PASSWORD}"`),
      {
        code: '42601',
        severity: 'ERROR',
        routine: 'scanner_yyerror',
        constraint: 'psd_eoc_app_pkey',
        detail: 'Key (email)=(staff@example.invalid) already exists.',
        hint: 'Perhaps you meant to reference the column "t.email".',
        where: 'PL/pgSQL function inline_code_block line 3',
        // postgres.js hangs the whole statement here, password and all.
        query: `ALTER ROLE "psd_eoc_application" WITH PASSWORD '${DATABASE_APPLICATION_PASSWORD}'`,
      },
    );
  }

  test('names the failing step and the SQLSTATE', async () => {
    const executor = createRoleStatementExecutor(
      connectionThat(() => Promise.reject(driverError())),
    );

    await expect(
      executor.execute(`GRANT "${DATABASE_ROLE}" TO "${DATABASE_LOGIN}"`),
    ).rejects.toThrow(
      'A native database bootstrap statement failed. statement=GRANT' +
        ' code=42601 severity=ERROR routine=scanner_yyerror' +
        ' constraint=psd_eoc_app_pkey',
    );
  });

  test('never reflects the statement, its password, or row data', async () => {
    const executor = createRoleStatementExecutor(
      connectionThat(() => Promise.reject(driverError())),
    );
    const statement = `ALTER ROLE "${DATABASE_LOGIN}" WITH PASSWORD '${DATABASE_APPLICATION_PASSWORD}'`;

    const message = await executor.execute(statement).then(
      () => 'the executor resolved',
      (error: unknown) => String(Reflect.get(Object(error), 'message')),
    );

    expect(message).toContain('statement=ALTER ROLE');
    for (const leak of [
      DATABASE_APPLICATION_PASSWORD,
      'staff@example.invalid',
      'syntax error at or near',
      'Perhaps you meant',
      'PL/pgSQL function',
    ]) {
      expect(message).not.toContain(leak);
    }
  });

  test('reduces a statement to bare leading keywords', async () => {
    const labels: string[] = [];
    for (const statement of [
      ...buildApplicationRoleStatements(DATABASE_APPLICATION_PASSWORD),
      ROLE_STATE_QUERY,
      'SELECT pg_advisory_lock(178401)',
    ]) {
      const executor = createRoleStatementExecutor(
        connectionThat(() => Promise.reject(new Error('boom'))),
      );
      const message = await executor.execute(statement).then(
        () => '',
        (error: unknown) => String(Reflect.get(Object(error), 'message')),
      );
      labels.push(message.replace(/^.*statement=/u, ''));
      expect(message).not.toContain(DATABASE_APPLICATION_PASSWORD);
    }

    expect(labels).toEqual([
      'DO',
      'ALTER ROLE',
      'DO',
      'GRANT',
      'REVOKE ADMIN',
      'SELECT ROLNAME',
      'SELECT',
    ]);
  });

  test('separates an unusable result from a driver failure', async () => {
    const executor = createRoleStatementExecutor(
      connectionThat(() => Promise.resolve('not rows')),
    );

    await expect(executor.execute('SELECT 1')).rejects.toThrow(
      'A native database bootstrap statement returned an unusable result.' +
        ' statement=SELECT',
    );
  });

  test('treats an unserializable result as unusable rather than throwing', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const executor = createRoleStatementExecutor(
      connectionThat(() => Promise.resolve([circular])),
    );

    await expect(executor.execute('SELECT 1')).rejects.toThrow(
      'returned an unusable result',
    );
  });

  test('freezes the rows it returns', async () => {
    const executor = createRoleStatementExecutor(
      connectionThat(() => Promise.resolve([{ unlocked: true }])),
    );

    const rows = await executor.execute('SELECT 1');
    expect(rows).toEqual([{ unlocked: true }]);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });
});
