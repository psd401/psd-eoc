import { describe, expect, it } from 'bun:test';

import { GET } from './route';

describe('GET /api/health/live', () => {
  it('answers 200 without any dependency configuration', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(await response.json()).toEqual({ status: 'live' });
  });
});
