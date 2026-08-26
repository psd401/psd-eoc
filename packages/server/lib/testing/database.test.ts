import { describe, expect, test } from 'bun:test';

import { requireSyntheticTestDatabaseUrl } from './database';

describe('synthetic test database URL boundary', () => {
  test('accepts local test databases without transport overrides', () => {
    const url = 'postgresql://synthetic@127.0.0.1/fixture_test';
    expect(requireSyntheticTestDatabaseUrl(url)).toBe(url);
  });

  test('accepts only verified TLS for an explicitly allowed remote test database', () => {
    const url =
      'postgresql://synthetic@database.example.invalid/fixture_test?sslmode=verify-full';
    expect(requireSyntheticTestDatabaseUrl(url, true)).toBe(url);
    expect(() => requireSyntheticTestDatabaseUrl(url, false)).toThrow(
      'remote test databases require explicit opt-in',
    );
  });

  test('rejects remote TLS weakening and unrelated URL parameters', () => {
    for (const query of [
      'sslmode=disable',
      'sslmode=require',
      'sslmode=verify-full&application_name=drill',
    ]) {
      expect(() =>
        requireSyntheticTestDatabaseUrl(
          `postgresql://synthetic@database.example.invalid/fixture_test?${query}`,
          true,
        ),
      ).toThrow();
    }
  });
});
