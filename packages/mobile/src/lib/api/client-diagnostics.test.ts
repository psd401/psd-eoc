import { describe, expect, test } from 'bun:test';

import {
  CLIENT_DIAGNOSTIC_PATH,
  ClientDiagnostics,
  routeShape,
} from './client-diagnostics';

const IDENTITY = () =>
  ({
    applicationVersion: '1.0.8',
    nativeBuildVersion: '18',
    platform: 'ios',
  }) as const;

describe('client diagnostics', () => {
  test('reduces a path to a route shape carrying no identifiers', () => {
    expect(routeShape('/events/2f1d4a6e-1f2b-4d3c-9a8b-7c6d5e4f3a2b/api')).toBe(
      '/events/:id/api',
    );
    expect(
      routeShape('/events/2f1d4a6e-1f2b-4d3c-9a8b-7c6d5e4f3a2b/api?cursor=41'),
    ).toBe('/events/:id/api');
    expect(routeShape('/api/diagnostics')).toBe(CLIENT_DIAGNOSTIC_PATH);
    // Nothing that could identify a person, event, or session survives.
    for (const shaped of [
      routeShape(
        '/api/media/upload-intents/9c1f0b7a-2e3d-4f5a-8b9c-0d1e2f3a4b5c/complete',
      ),
      routeShape('/events/abcdefabcdefabcdefabcdefabcdef/api'),
    ]) {
      expect(shaped).not.toMatch(/[0-9a-f]{8}-/u);
      expect(shaped.length).toBeLessThanOrEqual(120);
    }
  });

  test('reports a failure the server never saw', async () => {
    const sent: unknown[] = [];
    const diagnostics = new ClientDiagnostics(
      { send: async (reports) => void sent.push(reports) },
      IDENTITY,
      () => new Date('2026-09-01T05:10:00.000Z'),
    );
    diagnostics.report({
      kind: 'network',
      method: 'GET',
      path: '/events/2f1d4a6e-1f2b-4d3c-9a8b-7c6d5e4f3a2b/api',
      status: null,
      requestId: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([
      [
        {
          kind: 'network',
          method: 'GET',
          routeShape: '/events/:id/api',
          status: null,
          requestId: null,
          surface: 'mobile',
          applicationVersion: '1.0.8',
          nativeBuildVersion: '18',
          platform: 'ios',
          occurredAt: '2026-09-01T05:10:00.000Z',
        },
      ],
    ]);
  });

  test('never reports a failure of the reporting route itself', async () => {
    const sent: unknown[] = [];
    const diagnostics = new ClientDiagnostics(
      { send: async (reports) => void sent.push(reports) },
      IDENTITY,
    );
    diagnostics.report({
      kind: 'network',
      method: 'POST',
      path: CLIENT_DIAGNOSTIC_PATH,
      status: null,
      requestId: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  test('never surfaces an error when reporting fails', async () => {
    const diagnostics = new ClientDiagnostics(
      {
        send: async () => {
          throw new Error('synthetic telemetry outage');
        },
      },
      IDENTITY,
    );
    expect(() =>
      diagnostics.report({
        kind: 'network',
        method: 'GET',
        path: '/events/2f1d4a6e-1f2b-4d3c-9a8b-7c6d5e4f3a2b/api',
        status: null,
        requestId: null,
      }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
