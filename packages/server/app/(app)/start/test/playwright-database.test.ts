import { describe, expect, test } from 'bun:test';

import { startFlowPlaywrightDatabaseUrl } from './playwright-database';

describe('start-flow Playwright database isolation', () => {
  test('derives one exact synthetic database on the same loopback server', () => {
    expect(
      startFlowPlaywrightDatabaseUrl(
        'postgresql://synthetic:synthetic-only@127.0.0.1:55415/shared_test',
      ),
    ).toBe(
      'postgresql://synthetic:synthetic-only@127.0.0.1:55415/psd_eoc_issue15_playwright_test',
    );
  });

  test('rejects a production-named base before deriving a database', () => {
    expect(() =>
      startFlowPlaywrightDatabaseUrl(
        'postgresql://synthetic:synthetic-only@127.0.0.1:5432/psd_eoc',
      ),
    ).toThrow('whose name ends in _test');
  });

  test('rejects a remote database host', () => {
    expect(() =>
      startFlowPlaywrightDatabaseUrl(
        'postgresql://synthetic:synthetic-only@db.example.invalid:5432/shared_test',
      ),
    ).toThrow();
  });
});
