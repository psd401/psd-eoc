import { describe, expect, test } from 'bun:test';

import { POST } from './route';

describe('facilities administration POST route', () => {
  test('rejects non-URL-encoded input before authentication or capability execution', async () => {
    const response = await POST(
      new Request('https://eoc.example.test/facilities/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'create-facility' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
    const body = await response.text();
    expect(body).toContain('Review the administration form');
    expect(body).toContain('must use URL-encoded data');
    expect(body).toContain('No incident or notification action was performed.');
    expect(body).toContain('href="/facilities"');
  });
});
