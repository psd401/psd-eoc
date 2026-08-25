import { describe, expect, test } from 'bun:test';

import {
  balanceShards,
  countSkippedTests,
  isDatabaseDependentTest,
  parseTestArguments,
  requireFullGateDatabase,
} from './test';

describe('repository test gate', () => {
  test('defaults to the authoritative full database-backed suite', () => {
    expect(parseTestArguments([])).toMatchObject({
      mode: 'full',
      passthrough: [],
    });
  });

  test('keeps gate-only arguments out of Bun test passthrough', () => {
    expect(
      parseTestArguments([
        '--test-name-pattern',
        'safety',
        '--unit-only',
        '--shards',
        '3',
      ]),
    ).toEqual({
      mode: 'unit',
      passthrough: ['--test-name-pattern', 'safety'],
      shardCount: 3,
    });
  });

  test('rejects an invalid shard count', () => {
    expect(() => parseTestArguments(['--shards', '0'])).toThrow(
      '--shards must be an integer between 1 and 16.',
    );
  });

  test('requires an explicit synthetic database for the full gate', () => {
    expect(() => requireFullGateDatabase('full', undefined)).toThrow(
      /TEST_DATABASE_URL.*bun run test:db:start.*bun run check/u,
    );
    expect(() => requireFullGateDatabase('unit', undefined)).not.toThrow();
    expect(() =>
      requireFullGateDatabase(
        'full',
        'postgresql://psd_eoc_test:synthetic@localhost:5432/psd_eoc_test',
      ),
    ).not.toThrow();
    expect(() =>
      requireFullGateDatabase(
        'full',
        'postgresql://production@example.invalid/production',
      ),
    ).toThrow(/loopback PostgreSQL database/u);
  });

  test('unit-only discovery excludes actual database consumers, not setup assertions', () => {
    expect(
      isDatabaseDependentTest(
        'packages/server/drizzle/database.integration.test.ts',
      ),
    ).toBe(true);
    expect(isDatabaseDependentTest('scripts/test.test.ts')).toBe(false);
  });

  test('treats every runtime skip as an unexpected full-gate result', () => {
    expect(countSkippedTests(' 4 pass\n 0 fail\n 2 skip\n')).toBe(2);
    expect(countSkippedTests(' 4 pass\n 0 fail\n')).toBe(0);
  });

  test('balances every discovered file into a shard exactly once', () => {
    const files = [
      'scripts/test.test.ts',
      'packages/contracts/src/contracts.test.ts',
      'infra/test/health-route.test.ts',
    ];
    const shards = balanceShards(files, 2);
    expect(shards.flat().sort()).toEqual([...files].sort());
  });
});
