import { describe, expect, test } from 'bun:test';

import { forwardedClientAddress } from './client-address';

function request(forwarded: string | null): Request {
  const headers = new Headers();
  if (forwarded !== null) headers.set('x-forwarded-for', forwarded);
  return new Request('https://eoc.example.invalid/auth/partner', { headers });
}

describe('forwarded client address', () => {
  test('is the entry the platform appended, not one the caller wrote', () => {
    // A caller may send any x-forwarded-for; the proxy appends the address it
    // actually saw, so only the right-most entry is not caller-chosen.
    expect(forwardedClientAddress(request('203.0.113.9, 198.51.100.7'))).toBe(
      '198.51.100.7',
    );
    expect(forwardedClientAddress(request('198.51.100.7'))).toBe(
      '198.51.100.7',
    );
  });

  test('is absent when the header is missing, empty, or oversized', () => {
    expect(forwardedClientAddress(request(null))).toBeNull();
    expect(forwardedClientAddress(request(' , '))).toBeNull();
    expect(forwardedClientAddress(request('x'.repeat(65)))).toBeNull();
  });
});
