import { describe, expect, it } from 'bun:test';

import {
  MAX_RESPONSE_BYTES,
  assertCanaryUrl,
  parseCredential,
  readBoundedBody,
  requiredEnvironment,
  scheduledMetricTimestamp,
} from '../lambda/canary/core.mjs';

const credential = `psd_eoc_agent_v1_ABCDEFGHIJKL.${'a'.repeat(43)}`;

describe('one-minute canary runtime boundaries', () => {
  it('accepts only the exact App Runner health URL and agent credential shape', () => {
    expect(
      assertCanaryUrl('https://service.us-west-2.awsapprunner.com/api/health')
        .pathname,
    ).toBe('/api/health');
    expect(parseCredential({ SecretString: credential })).toBe(credential);
    expect(() =>
      assertCanaryUrl(
        'https://service.us-west-2.awsapprunner.com/api/health?kind=test',
      ),
    ).toThrow('Canary URL is unavailable.');
    expect(() => parseCredential({ SecretString: 'not-a-key' })).toThrow(
      'Canary credential is unavailable.',
    );
    expect(() => requiredEnvironment({}, 'PROVIDER_SENDS')).toThrow(
      'Canary configuration is unavailable.',
    );
  });

  it('accepts only an exact minute-aligned EventBridge schedule timestamp', () => {
    expect(
      scheduledMetricTimestamp({
        'detail-type': 'Scheduled Event',
        id: '00000000-0000-4000-8000-000000000029',
        source: 'aws.events',
        time: '2026-08-12T19:20:37.123Z',
      }).toISOString(),
    ).toBe('2026-08-12T19:20:00.000Z');
    expect(() =>
      scheduledMetricTimestamp({
        'detail-type': 'Scheduled Event',
        id: '00000000-0000-4000-8000-000000000029',
        source: 'caller',
        time: '2026-08-12T19:20:00Z',
      }),
    ).toThrow('Canary schedule is unavailable.');
  });

  it('accepts the exact generic response and rejects oversized or invalid UTF-8', async () => {
    const response = new Response('{"status":"ok"}', {
      headers: { 'content-length': '15' },
    });
    expect(await readBoundedBody(response)).toBe('{"status":"ok"}');

    await expect(
      readBoundedBody(
        new Response('x', {
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        }),
      ),
    ).rejects.toThrow('Canary response is unavailable.');
    await expect(
      readBoundedBody(new Response(new Uint8Array([0xc3, 0x28]))),
    ).rejects.toThrow('Canary response is unavailable.');
  });
});
