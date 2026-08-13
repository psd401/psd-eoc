import { randomBytes } from 'node:crypto';
import { lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test } from 'bun:test';

import { isAcceptedMobileOidcState } from './mobile-mock-google-idp';
import {
  MobileRuntimeManifestSchema,
  acquireMobileRuntimeRoot,
  createMobileRuntimeRunId,
  executeMobileRuntimeCleanup,
  mobileRuntimePaths,
  parseMobileRuntimeCli,
  publishMobileRuntimeManifest,
  removeMobileRuntimeRoot,
  removeOwnedMobileRuntimeManifest,
  requireMobileRuntimeEnvironment,
} from './mobile-runtime-lib';

const RUN_ID = 'a'.repeat(32);
const ROUTE_EVIDENCE = `Issue 32 route proof ${RUN_ID}`;

function manifest(runId = RUN_ID) {
  return {
    runId,
    appOrigin: 'http://127.0.0.1:23132',
    idpOrigin: 'http://127.0.0.1:33132',
    event: {
      id: '15000000-0000-4000-8000-000000000011',
      facilityId: '00000000-0000-4000-8000-000000000001',
      eventTypeVersionId: '00000000-0000-4000-8000-000000000201',
      routeEvidence:
        runId === RUN_ID ? ROUTE_EVIDENCE : `Issue 32 route proof ${runId}`,
    },
    classification: 'drill' as const,
    templateMode: 'drill' as const,
    rosterPopulation: 'synthetic' as const,
  };
}

function uniqueManifestPath(): string {
  return resolve(
    tmpdir(),
    `psd-eoc-issue32-mobile-${randomBytes(8).toString('hex')}.json`,
  );
}

describe('issue #32 mobile runtime process boundary', () => {
  test('parses only the stable start CLI with absolute manifest and distinct user ports', () => {
    const manifestPath = uniqueManifestPath();
    expect(
      parseMobileRuntimeCli([
        'start',
        '--run-id',
        RUN_ID,
        '--manifest',
        manifestPath,
        '--app-port',
        '23132',
        '--idp-port',
        '33132',
      ]),
    ).toEqual({
      command: 'start',
      runId: RUN_ID,
      manifestPath,
      appPort: 23132,
      idpPort: 33132,
    });
    expect(() =>
      parseMobileRuntimeCli([
        'start',
        '--run-id',
        RUN_ID,
        '--manifest',
        'relative.json',
        '--app-port',
        '23132',
        '--idp-port',
        '33132',
      ]),
    ).toThrow('absolute');
    expect(() =>
      parseMobileRuntimeCli([
        'start',
        '--run-id',
        RUN_ID,
        '--manifest',
        manifestPath,
        '--app-port',
        '23132',
        '--idp-port',
        '23132',
      ]),
    ).toThrow('must differ');
    expect(() =>
      parseMobileRuntimeCli([
        'start',
        '--run-id',
        RUN_ID,
        '--manifest',
        manifestPath,
        '--app-port',
        '80',
        '--idp-port',
        '33132',
      ]),
    ).toThrow('1024');
    expect(() =>
      parseMobileRuntimeCli([
        'start',
        '--run-id',
        '../unsafe',
        '--manifest',
        manifestPath,
        '--app-port',
        '23132',
        '--idp-port',
        '33132',
      ]),
    ).toThrow('32 lowercase hexadecimal');
  });

  test('requires an explicit synthetic-only flag and loopback test database', () => {
    const valid = {
      PSD_EOC_E2E_SYNTHETIC_ONLY: 'true',
      TEST_DATABASE_URL: 'postgresql://local@127.0.0.1:5432/psd_eoc_test',
    };
    expect(requireMobileRuntimeEnvironment(valid)).toBe(
      valid.TEST_DATABASE_URL,
    );
    expect(() =>
      requireMobileRuntimeEnvironment({
        ...valid,
        PSD_EOC_E2E_SYNTHETIC_ONLY: 'false',
      }),
    ).toThrow('PSD_EOC_E2E_SYNTHETIC_ONLY=true');
    expect(() =>
      requireMobileRuntimeEnvironment({
        ...valid,
        TEST_DATABASE_URL: 'postgresql://local@example.com/psd_eoc_test',
      }),
    ).toThrow('loopback PostgreSQL');
    expect(() =>
      requireMobileRuntimeEnvironment({
        ...valid,
        TEST_DATABASE_URL: 'postgresql://local@127.0.0.1/psd_eoc',
      }),
    ).toThrow('ends in _test');
    expect(() =>
      requireMobileRuntimeEnvironment({
        ...valid,
        TEST_DATABASE_URL:
          'postgresql://local@127.0.0.1/psd_eoc_test?sslmode=require',
      }),
    ).toThrow('loopback PostgreSQL');
  });

  test('accepts only the canonical versioned mobile OIDC state', () => {
    expect(isAcceptedMobileOidcState(`m1.${'S'.repeat(43)}`)).toBe(true);
    expect(isAcceptedMobileOidcState('S'.repeat(43))).toBe(false);
    expect(isAcceptedMobileOidcState(`m1.${'S'.repeat(42)}`)).toBe(false);
    expect(isAcceptedMobileOidcState(`m1.${'S'.repeat(44)}`)).toBe(false);
    expect(isAcceptedMobileOidcState(null)).toBe(false);
  });
});

describe('issue #32 mobile runtime manifest', () => {
  test('requires exact synthetic drill truth and run-bound route evidence', () => {
    expect(MobileRuntimeManifestSchema.parse(manifest())).toEqual(manifest());
    expect(
      MobileRuntimeManifestSchema.safeParse({
        ...manifest(),
        classification: 'incident',
      }).success,
    ).toBe(false);
    expect(
      MobileRuntimeManifestSchema.safeParse({
        ...manifest(),
        event: { ...manifest().event, routeEvidence: 'unbound' },
      }).success,
    ).toBe(false);
    expect(
      MobileRuntimeManifestSchema.safeParse({
        ...manifest(),
        appOrigin: 'https://eoc.psd401.net',
      }).success,
    ).toBe(false);
    expect(
      MobileRuntimeManifestSchema.safeParse({
        ...manifest(),
        appOrigin: 'http://localhost:23132',
        idpOrigin: 'http://LOCALHOST:23132',
      }).success,
    ).toBe(false);
  });

  test('publishes atomically at mode 0600 and removes the exact owned inode', async () => {
    const path = uniqueManifestPath();
    const owned = await publishMobileRuntimeManifest(path, manifest());
    try {
      const metadata = await lstat(path);
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(manifest());
    } finally {
      await removeOwnedMobileRuntimeManifest(owned);
    }
    expect(await lstat(path).catch(() => null)).toBeNull();
  });

  test('never adopts or removes a pre-existing manifest', async () => {
    const path = uniqueManifestPath();
    await writeFile(path, 'pre-existing-owner\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await expect(
        publishMobileRuntimeManifest(path, manifest()),
      ).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('pre-existing-owner\n');
    } finally {
      await unlink(path);
    }
  });

  test('refuses to remove a path replaced after publication', async () => {
    const path = uniqueManifestPath();
    const owned = await publishMobileRuntimeManifest(path, manifest());
    await unlink(path);
    await writeFile(path, 'replacement-owner\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await expect(removeOwnedMobileRuntimeManifest(owned)).rejects.toThrow(
        'identity changed',
      );
      expect(await readFile(path, 'utf8')).toBe('replacement-owner\n');
    } finally {
      await unlink(path);
    }
  });
});

describe('issue #32 mobile runtime cleanup', () => {
  test('removes only an exact marker-owned runtime root', async () => {
    const runId = createMobileRuntimeRunId();
    const paths = await acquireMobileRuntimeRoot(runId);
    expect(await readFile(paths.owner, 'utf8')).toBe(`${runId}\n`);
    await removeMobileRuntimeRoot(runId);
    expect(await lstat(paths.root).catch(() => null)).toBeNull();
  });

  test('refuses cleanup when the ownership marker changes', async () => {
    const runId = createMobileRuntimeRunId();
    const paths = await acquireMobileRuntimeRoot(runId);
    await writeFile(paths.owner, `${RUN_ID}\n`, 'utf8');
    try {
      await expect(removeMobileRuntimeRoot(runId)).rejects.toThrow(
        'does not match',
      );
      expect((await lstat(paths.root)).isDirectory()).toBe(true);
    } finally {
      await rm(mobileRuntimePaths(runId).root, { recursive: true });
    }
  });

  test('runs every cleanup task and reports all failures', async () => {
    const visited: number[] = [];
    await expect(
      executeMobileRuntimeCleanup([
        () => {
          visited.push(1);
          throw new Error('first cleanup failed');
        },
        () => {
          visited.push(2);
        },
        () => {
          visited.push(3);
          throw new Error('third cleanup failed');
        },
      ]),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(visited).toEqual([1, 2, 3]);
  });
});
