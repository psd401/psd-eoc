import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  ApiErrorSchema,
  MobileOidcStartResponseSchema,
} from '@psd-eoc/contracts';
import { NextRequest } from 'next/server';

import { POST } from './route';

const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'GOOGLE_OIDC_CLIENT_ID',
  'GOOGLE_OIDC_CLIENT_SECRET',
  'GOOGLE_OIDC_REDIRECT_URI',
  'GOOGLE_OIDC_COOKIE_SECRET',
  'GOOGLE_OIDC_AUTHORIZATION_ENDPOINT',
  'GOOGLE_OIDC_TOKEN_ENDPOINT',
  'GOOGLE_OIDC_JWKS_URI',
] as const;

const originalEnvironment = new Map(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const),
);

function request(body: unknown): NextRequest {
  return new NextRequest('http://127.0.0.1/api/auth/mobile/oidc/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('set-cookie')).toBeNull();
}

beforeAll(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    GOOGLE_OIDC_CLIENT_ID:
      'synthetic-mobile-route-client.apps.googleusercontent.com',
    GOOGLE_OIDC_CLIENT_SECRET: 'synthetic-route-secret',
    GOOGLE_OIDC_REDIRECT_URI: 'http://127.0.0.1:4217/auth/callback',
    GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 23).toString('base64url'),
    GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: 'http://127.0.0.1:4217/authorize',
    GOOGLE_OIDC_TOKEN_ENDPOINT: 'http://127.0.0.1:4217/token',
    GOOGLE_OIDC_JWKS_URI: 'http://127.0.0.1:4217/jwks',
  });
});

afterAll(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      Reflect.set(process.env, key, value);
    }
  }
});

describe('POST /api/auth/mobile/oidc/start', () => {
  test('returns only bounded flow metadata with private response headers', async () => {
    const response = await POST(
      request({
        platform: 'ios',
        installationId: 'synthetic-native-installation-0001',
        codeChallenge: 'A'.repeat(43),
      }),
    );

    expect(response.status).toBe(200);
    expectPrivateResponse(response);
    const body = MobileOidcStartResponseSchema.parse(await response.json());
    expect(body.authorizationUrl).toStartWith(
      'http://127.0.0.1:4217/authorize?',
    );
    expect(body.appRedirectUri).toBe('psdeoc://auth/callback');
  });

  test('rejects caller-controlled redirects without reflecting them', async () => {
    const untrustedRedirect = 'https://attacker.invalid/callback';
    const response = await POST(
      request({
        platform: 'android',
        installationId: 'synthetic-native-installation-0002',
        codeChallenge: 'B'.repeat(43),
        redirectUri: untrustedRedirect,
      }),
    );

    expect(response.status).toBe(400);
    expectPrivateResponse(response);
    const serialized = JSON.stringify(
      ApiErrorSchema.parse(await response.json()),
    );
    expect(serialized).not.toContain(untrustedRedirect);
  });
});
