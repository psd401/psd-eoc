import { describe, expect, test } from 'bun:test';

import { AuthApiClient, parseAuthApiBaseUrl } from './auth-api-client';
import { MobileAuthError } from './auth-errors';
import { TEST_TOKEN } from './auth-test-fixtures';

describe('mobile auth API client', () => {
  test('requires HTTPS except for explicit development loopback', () => {
    expect(parseAuthApiBaseUrl('https://eoc.psd401.net/', false)).toBe(
      'https://eoc.psd401.net',
    );
    expect(parseAuthApiBaseUrl('http://127.0.0.1:3000', true)).toBe(
      'http://127.0.0.1:3000',
    );
    expect(parseAuthApiBaseUrl('http://[::1]:3000', true)).toBe(
      'http://[::1]:3000',
    );
    expect(() => parseAuthApiBaseUrl('http://eoc.psd401.net', true)).toThrow(
      MobileAuthError,
    );
  });

  for (const status of [429, 500, 503] as const) {
    test(`classifies a non-JSON ${status} outage as offline`, async () => {
      const client = new AuthApiClient(
        () => 'https://eoc.psd401.net',
        async () =>
          new Response('<html>gateway unavailable</html>', { status }),
      );
      const signal = new AbortController().signal;
      try {
        await client.refresh(
          TEST_TOKEN,
          'mobile-refresh-idempotency-0001',
          signal,
        );
        throw new Error('Expected an offline failure.');
      } catch (error) {
        expect(error).toBeInstanceOf(MobileAuthError);
        expect((error as MobileAuthError).kind).toBe('offline');
      }
    });
  }

  test('classifies a non-JSON unauthorized response as rejected', async () => {
    const client = new AuthApiClient(
      () => 'https://eoc.psd401.net',
      async () => new Response('unauthorized', { status: 401 }),
    );
    try {
      await client.refresh(
        TEST_TOKEN,
        'mobile-refresh-idempotency-0001',
        new AbortController().signal,
      );
      throw new Error('Expected a rejected failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(MobileAuthError);
      expect((error as MobileAuthError).kind).toBe('rejected');
    }
  });
});
