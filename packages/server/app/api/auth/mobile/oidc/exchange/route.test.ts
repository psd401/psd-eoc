import { describe, expect, test } from 'bun:test';

import { ApiErrorSchema } from '@psd-eoc/contracts';
import { NextRequest } from 'next/server';

import { POST } from './route';

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('set-cookie')).toBeNull();
}

describe('POST /api/auth/mobile/oidc/exchange', () => {
  test('rejects malformed provider material without reflecting or processing it', async () => {
    const authorizationCode = 'sensitive-synthetic-authorization-code';
    const response = await POST(
      new NextRequest('http://127.0.0.1/api/auth/mobile/oidc/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorizationCode,
          state: `m1.${'S'.repeat(43)}`,
          codeVerifier: 'too-short',
          flowToken: `m1.${'I'.repeat(16)}.${'C'.repeat(80)}`,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expectPrivateResponse(response);
    const serialized = JSON.stringify(
      ApiErrorSchema.parse(await response.json()),
    );
    expect(serialized).not.toContain(authorizationCode);
  });
});
