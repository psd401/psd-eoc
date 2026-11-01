import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { GET } from './route';

/** Issue #647, the Android counterpart of the Apple association route. */

const KEYS = [
  'PSD_EOC_ANDROID_APPLICATION_ID',
  'PSD_EOC_ANDROID_SIGNING_FINGERPRINTS',
] as const;

const FINGERPRINT = `${'AB:'.repeat(31)}CD`;

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
  for (const key of KEYS) delete process.env[key];
});

afterAll(restore);

describe('GET /.well-known/assetlinks.json', () => {
  test('a configured deployment delegates login credentials only', async () => {
    process.env.PSD_EOC_ANDROID_APPLICATION_ID = 'invalid.example.eoc';
    process.env.PSD_EOC_ANDROID_SIGNING_FINGERPRINTS = FINGERPRINT;
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual([
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'invalid.example.eoc',
          sha256_cert_fingerprints: [FINGERPRINT],
        },
      },
    ]);
  });

  test('a deployment with no Play identity serves nothing', () => {
    expect(GET().status).toBe(404);
  });
});
