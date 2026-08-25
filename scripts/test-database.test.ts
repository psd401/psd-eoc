import { describe, expect, test } from 'bun:test';

import {
  composeArguments,
  conflictingAmbientDatabaseVariables,
  generatedLocalEnvironment,
  isGeneratedLocalEnvironment,
  parseTestDatabaseCommand,
  pinnedSyntheticEnvironment,
  testDatabaseProjectName,
  validatedGeneratedEnvironment,
  withStartupRollback,
} from './test-database';

const syntheticDatabaseUrl =
  'postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:49152/psd_eoc_test';

function generatedFixture(databaseUrl = syntheticDatabaseUrl): string {
  return generatedLocalEnvironment(
    [
      'DATABASE_DRIVER=postgres',
      'DATABASE_URL=postgresql://old.invalid/psd_eoc_test',
      'PSD_EOC_ORGANIZATION_NAME=Example School District',
      'TEST_DATABASE_URL=postgresql://old.invalid/psd_eoc_test',
      '',
    ].join('\n'),
    databaseUrl,
  );
}

describe('synthetic PostgreSQL helper', () => {
  test('starts only the repository-owned Compose service and waits for health', () => {
    expect(composeArguments('start', 'psd-eoc-fixture')).toEqual([
      'compose',
      '--project-name',
      'psd-eoc-fixture',
      '-f',
      'compose.test.yml',
      'up',
      '-d',
      '--wait',
    ]);
  });

  test('stops the repository-owned service and removes its synthetic data', () => {
    expect(composeArguments('stop', 'psd-eoc-fixture')).toEqual([
      'compose',
      '--project-name',
      'psd-eoc-fixture',
      '-f',
      'compose.test.yml',
      'down',
      '--volumes',
    ]);
  });

  test('rejects every unsupported operation', () => {
    expect(parseTestDatabaseCommand(['start'])).toBe('start');
    expect(parseTestDatabaseCommand(['migrate'])).toBe('migrate');
    expect(parseTestDatabaseCommand(['seed'])).toBe('seed');
    expect(parseTestDatabaseCommand(['web'])).toBe('web');
    expect(parseTestDatabaseCommand(['stop'])).toBe('stop');
    expect(() => parseTestDatabaseCommand(['restart'])).toThrow(/Usage/u);
    expect(() => parseTestDatabaseCommand(['start', '--force'])).toThrow(
      /Usage/u,
    );
    expect(() => parseTestDatabaseCommand([])).toThrow(/Usage/u);
  });

  test('isolates Compose resources by worktree parent', () => {
    expect(testDatabaseProjectName('/tmp/worktrees/c79c/psd-eoc')).toMatch(
      /^psd-eoc-c79c-[a-f0-9]{8}$/u,
    );
  });

  test('does not collide when two clones share a parent directory', () => {
    const first = testDatabaseProjectName('/tmp/repos/psd-eoc');
    const second = testDatabaseProjectName('/tmp/repos/psd-eoc-copy');
    expect(first).not.toBe(second);
    expect(testDatabaseProjectName('/tmp/repos/psd-eoc/')).toBe(first);
  });

  test('generates an ignored local environment from reserved example values', () => {
    const contents = generatedFixture();

    expect(isGeneratedLocalEnvironment(contents)).toBe(true);
    expect(contents).toContain(`DATABASE_URL=${syntheticDatabaseUrl}`);
    expect(contents).toContain(`TEST_DATABASE_URL=${syntheticDatabaseUrl}`);
    expect(contents).toContain(
      'PSD_EOC_ORGANIZATION_NAME=Example School District',
    );
    expect(contents).not.toContain('old.invalid');
  });

  test('recognizes only the repository-generated local environment', () => {
    expect(isGeneratedLocalEnvironment(undefined)).toBe(false);
    expect(isGeneratedLocalEnvironment('DATABASE_URL=custom')).toBe(false);
    expect(
      isGeneratedLocalEnvironment(
        generatedLocalEnvironment(
          'DATABASE_URL=old\nTEST_DATABASE_URL=old\n',
          'postgresql://example.invalid/psd_eoc_test',
        ),
      ),
    ).toBe(true);
  });

  test('accepts only identical repository-generated loopback configuration', () => {
    const contents = generatedFixture();
    expect(validatedGeneratedEnvironment(contents, contents)).toMatchObject({
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: syntheticDatabaseUrl,
      TEST_DATABASE_URL: syntheticDatabaseUrl,
    });
    expect(() =>
      validatedGeneratedEnvironment(
        contents,
        generatedFixture(
          'postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:49153/psd_eoc_test',
        ),
      ),
    ).toThrow(/missing, unmanaged, or inconsistent/u);
    expect(() =>
      validatedGeneratedEnvironment(
        generatedFixture(
          'postgresql://operator:password@database.example.com:5432/production',
        ),
        generatedFixture(
          'postgresql://operator:password@database.example.com:5432/production',
        ),
      ),
    ).toThrow(/URL failed validation/u);
  });

  test('rejects ambient database settings unless they match generated values', () => {
    const generated = validatedGeneratedEnvironment(
      generatedFixture(),
      generatedFixture(),
    );
    expect(
      conflictingAmbientDatabaseVariables({
        DATABASE_ADMIN_PASSWORD: 'live-admin-password',
        DATABASE_MAX_CONNECTIONS: '999',
        DATABASE_URL:
          'postgresql://operator:password@database.example.com:5432/production',
      }),
    ).toEqual([
      'DATABASE_ADMIN_PASSWORD',
      'DATABASE_MAX_CONNECTIONS',
      'DATABASE_URL',
    ]);
    expect(
      conflictingAmbientDatabaseVariables(
        {
          AWS_REGION: 'example-region-1',
          DATABASE_URL: syntheticDatabaseUrl,
          TEST_DATABASE_URL: syntheticDatabaseUrl,
        },
        generated,
      ),
    ).toEqual([]);
  });

  test('pins child commands to generated values and removes alternate drivers', () => {
    const generated = validatedGeneratedEnvironment(
      generatedFixture(),
      generatedFixture(),
    );
    const environment = pinnedSyntheticEnvironment(
      {
        DATABASE_ADMIN_PASSWORD: 'live-admin-password',
        DATABASE_APPLICATION_USERNAME: 'live-application-user',
        DATABASE_DRIVER: 'aurora-data-api',
        DATABASE_URL:
          'postgresql://operator:password@database.example.com:5432/production',
        DATABASE_HOST: 'database.example.com',
        DATABASE_MAX_CONNECTIONS: '999',
        DATABASE_RESOURCE_ARN: 'arn:example:database',
        NODE_ENV: 'production',
        SAFE_UNRELATED_VALUE: 'kept',
      },
      generated,
    );
    expect(environment).toMatchObject({
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: syntheticDatabaseUrl,
      SAFE_UNRELATED_VALUE: 'kept',
      TEST_DATABASE_URL: syntheticDatabaseUrl,
    });
    expect(environment.DATABASE_ADMIN_PASSWORD).toBeUndefined();
    expect(environment.DATABASE_APPLICATION_USERNAME).toBeUndefined();
    expect(environment.DATABASE_HOST).toBeUndefined();
    expect(environment.DATABASE_MAX_CONNECTIONS).toBeUndefined();
    expect(environment.DATABASE_RESOURCE_ARN).toBeUndefined();
    expect(environment.NODE_ENV).toBeUndefined();
  });

  test('rolls startup back exactly once when finalization fails', async () => {
    let rollbacks = 0;
    await expect(
      withStartupRollback(
        async () => {
          throw new Error('port discovery failed');
        },
        async () => {
          rollbacks += 1;
        },
      ),
    ).rejects.toThrow('port discovery failed');
    expect(rollbacks).toBe(1);

    await expect(
      withStartupRollback(
        async () => 'ready',
        async () => {
          rollbacks += 1;
        },
      ),
    ).resolves.toBe('ready');
    expect(rollbacks).toBe(1);
  });
});
