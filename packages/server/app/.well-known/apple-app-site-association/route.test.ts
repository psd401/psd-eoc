import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { GET } from './route';

/**
 * Issue #647. Apple fetches this document itself — no device, no session, and
 * no retry worth relying on — so what is worth proving is that a configured
 * deployment serves JSON at exactly this path and that an unconfigured one
 * serves nothing rather than an empty claim.
 */

const KEYS = ['PSD_EOC_IOS_BUNDLE_ID', 'PSD_EOC_APPLE_APP_TEAM_ID'] as const;

const original = new Map(KEYS.map((key) => [key, process.env[key]] as const));

function restore(): void {
  for (const [key, value] of original) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  restore();
  delete process.env.PSD_EOC_APPLE_APP_TEAM_ID;
});

afterAll(restore);

describe('GET /.well-known/apple-app-site-association', () => {
  test('a configured deployment names its own signed app', async () => {
    process.env.PSD_EOC_IOS_BUNDLE_ID = 'invalid.example.eoc';
    process.env.PSD_EOC_APPLE_APP_TEAM_ID = 'A1B2C3D4E5';
    const response = GET();
    expect(response.status).toBe(200);
    // Apple requires a JSON content type and refuses the document otherwise.
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      webcredentials: { apps: ['A1B2C3D4E5.invalid.example.eoc'] },
    });
  });

  test('a deployment with no store identity serves nothing', () => {
    process.env.PSD_EOC_IOS_BUNDLE_ID = 'invalid.example.eoc';
    const response = GET();
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
  });
});
