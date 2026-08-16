import { describe, expect, test } from 'bun:test';

import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import { applicationUrlForRequest } from '../../../lib/auth/application-origin';
import {
  AdminFormError,
  adminFormErrorResponse,
  adminSuccessRedirect,
  readAdminForm,
} from './admin-request';

function formRequest(
  body: BodyInit,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request('https://eoc.example.invalid/facilities/api', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...headers,
    },
  });
}

describe('shared administration request boundary', () => {
  test('parses one bounded URL-encoded form with explicit repeat rules', async () => {
    const form = await readAdminForm(
      formRequest('intent=save&name=North+Site&member=a&member=b'),
    );

    expect(() =>
      form.assertFields(['intent', 'name', 'member'], ['member']),
    ).not.toThrow();
    expect(form.required('name')).toBe('North Site');
    expect(form.optional('missing')).toBeNull();
    expect(form.all('member')).toEqual(['a', 'b']);
    expect(() => form.assertFields(['intent', 'name'])).toThrow(AdminFormError);
  });

  test('enforces the actual request-stream cap even without Content-Length', async () => {
    const oversized = new Uint8Array(64 * 1024 + 1).fill(97);

    await expect(readAdminForm(formRequest(oversized))).rejects.toThrow(
      'The administration form is too large.',
    );
  });

  test('rejects invalid UTF-8 and non-form content before parsing fields', async () => {
    await expect(
      readAdminForm(formRequest(new Uint8Array([0xff]))),
    ).rejects.toThrow('The administration form is not valid UTF-8.');
    await expect(
      readAdminForm(
        new Request('https://eoc.example.invalid/facilities/api', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).rejects.toThrow('must use URL-encoded data');
  });

  test('preserves safe capability statuses and emits cache-disabled HTML', async () => {
    const response = adminFormErrorResponse(
      new CapabilityEngineError(
        'CONFLICT',
        'IDEMPOTENCY_REQUEST_MISMATCH',
        'The idempotency key was already used for a different request.',
        409,
      ),
      '/facilities',
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    expect(await response.text()).toContain(
      'The idempotency key was already used for a different request.',
    );
  });

  test('uses a 303 redirect to a whitelisted local administration path', () => {
    const response = adminSuccessRedirect(
      formRequest('intent=save'),
      '/facilities',
      'facility-created',
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://eoc.example.invalid/facilities?status=facility-created',
    );
  });

  test('redirects a proxied production request on the fixed public origin', () => {
    const response = adminSuccessRedirect(
      new Request('https://localhost:3000/facilities/api', {
        method: 'POST',
      }),
      '/facilities',
      'facility-created',
      { NODE_ENV: 'production' },
    );

    expect(response.headers.get('location')).toBe(
      'https://eoc.psd401.net/facilities?status=facility-created',
    );
    expect(() =>
      applicationUrlForRequest(
        'https://localhost:3000/facilities/api',
        'https://evil.example/phish',
        { NODE_ENV: 'production' },
      ),
    ).toThrow('Application redirects must remain same-origin.');
  });
});
