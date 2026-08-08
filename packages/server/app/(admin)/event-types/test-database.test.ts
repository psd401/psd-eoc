import { describe, expect, test } from 'bun:test';

import { requireSyntheticTestDatabaseUrl } from './test-database';

describe('event-type test database guard', () => {
  test('accepts an explicitly named loopback PostgreSQL test database', () => {
    const value =
      'postgresql://synthetic:synthetic@127.0.0.1:5432/psd_eoc_test';
    expect(requireSyntheticTestDatabaseUrl(value, false)).toBe(value);
  });

  test('rejects production-shaped, remote, and non-PostgreSQL targets', () => {
    for (const value of [
      'postgresql://synthetic:synthetic@127.0.0.1:5432/psd_eoc',
      'postgresql://synthetic:synthetic@database.internal:5432/psd_eoc_test',
      'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test?host=production.internal',
      'postgresql://synthetic:synthetic@localhost:5432/psd_eoc_test?database=psd_eoc',
      'https://localhost/psd_eoc_test',
      'not a URL',
    ]) {
      expect(() => requireSyntheticTestDatabaseUrl(value, false)).toThrow();
    }
  });

  test('requires a separate explicit opt-in for a remote test service', () => {
    const value =
      'postgresql://synthetic:synthetic@database.internal:5432/psd_eoc_test';
    expect(requireSyntheticTestDatabaseUrl(value, true)).toBe(value);
  });

  test('never reflects a credential-bearing value in its failure', () => {
    const value =
      'postgresql://sensitive-user:sensitive-password@database.internal:5432/production';
    try {
      requireSyntheticTestDatabaseUrl(value, false);
      throw new Error('Expected the database guard to reject the URL.');
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-user');
      expect(String(error)).not.toContain('sensitive-password');
    }
  });
});
