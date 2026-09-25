import { afterEach, describe, expect, test } from 'bun:test';

import { ApiErrorSchema } from '@psd-eoc/contracts';
import { NextRequest } from 'next/server';

import { appReviewSignInDigest } from '../../../../../lib/auth/app-review-sign-in';
import { POST } from './route';

const ENV_NAME = 'PSD_EOC_APP_REVIEW_SIGN_IN_SHA256';
const EMAIL = 'review-account@example.invalid';
const CODE = 'synthetic-review-code-0123456789abcdef';
const previous = process.env[ENV_NAME];

function request(body: unknown): NextRequest {
  return new NextRequest('http://127.0.0.1/api/auth/mobile/app-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  expect(response.headers.get('set-cookie')).toBeNull();
}

afterEach(() => {
  if (previous === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = previous;
  }
});

describe('POST /api/auth/mobile/app-review', () => {
  test('does not exist on a deployment that has not turned it on', async () => {
    delete process.env[ENV_NAME];
    const response = await POST(
      request({
        email: EMAIL,
        code: CODE,
        platform: 'android',
        installationId: 'synthetic-installation-0001',
      }),
    );
    expect(response.status).toBe(404);
    expectPrivateResponse(response);
  });

  test('rejects a malformed request without echoing the code', async () => {
    process.env[ENV_NAME] = appReviewSignInDigest(EMAIL, CODE);
    const response = await POST(
      request({ email: 'not-an-email', code: CODE, platform: 'android' }),
    );
    expect(response.status).toBe(400);
    expectPrivateResponse(response);
    const serialized = JSON.stringify(
      ApiErrorSchema.parse(await response.json()),
    );
    expect(serialized).not.toContain(CODE);
  });
});
