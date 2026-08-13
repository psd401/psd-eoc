import { describe, expect, test } from 'bun:test';

import { AgentApiClient, AgentApiConfigurationError } from './agent-client';
import {
  createStreamableHttpHandler,
  readStreamableHttpConfig,
  type StreamableHttpConfig,
} from './http';
import { MCP_MODERN_PROTOCOL_VERSION, PsdEocMcpProtocol } from './protocol';

const PAGE = Object.freeze({
  items: Object.freeze([]),
  pageInfo: Object.freeze({ nextCursor: null, hasMore: false }),
});
const DELIVERY_TEST_REPORT_INPUT = Object.freeze({
  facilityId: '30000000-0000-4000-8000-000000000001',
  status: null,
  generatedFrom: null,
  generatedThrough: null,
  cursor: null,
  limit: 20,
});
const CONFIG: StreamableHttpConfig = Object.freeze({
  hostname: '127.0.0.1',
  port: 3100,
  path: '/mcp',
  allowedOrigins: new Set<string>(),
});

function harness(
  fetchImplementation: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response> = async () => Response.json(PAGE),
) {
  const protocol = new PsdEocMcpProtocol(
    new AgentApiClient(
      {
        baseUrl: 'https://eoc.example.test/api/agent/v1',
        apiKey: 'safe-test-key',
      },
      { fetch: fetchImplementation as unknown as typeof fetch },
    ),
  );
  return createStreamableHttpHandler(protocol, CONFIG);
}

function modernBody(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': {
          name: 'http-test',
          version: '1',
        },
      },
    },
  };
}

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const name =
    method === 'resources/read'
      ? params.uri
      : method === 'tools/call' || method === 'prompts/get'
        ? params.name
        : undefined;
  return new Request('http://127.0.0.1:3100/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_MODERN_PROTOCOL_VERSION,
      'Mcp-Method': method,
      ...(typeof name === 'string' ? { 'Mcp-Name': name } : {}),
      ...headers,
    },
    body: JSON.stringify(modernBody(method, params)),
  });
}

describe('Streamable HTTP transport', () => {
  test('serves a valid modern request with JSON and cache hints', async () => {
    const response = await harness()(modernRequest('tools/list'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      result: {
        resultType: 'complete',
        ttlMs: 300_000,
        cacheScope: 'public',
      },
    });
  });

  test('proxies the read-only delivery-test report tool with matching modern headers', async () => {
    let capturedUrl = '';
    let capturedHeaders = new Headers();
    let capturedBody: unknown;
    const handler = harness(async (input, init = {}) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init.headers);
      capturedBody = JSON.parse(String(init.body)) as unknown;
      return Response.json(PAGE);
    });
    const response = await handler(
      modernRequest('tools/call', {
        name: 'list-delivery-test-reports',
        arguments: DELIVERY_TEST_REPORT_INPUT,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { isError: false, structuredContent: PAGE },
    });
    expect(capturedUrl).toBe(
      'https://eoc.example.test/api/agent/v1/capabilities/list-delivery-test-reports',
    );
    expect(capturedBody).toEqual(DELIVERY_TEST_REPORT_INPUT);
    expect(capturedHeaders.has('idempotency-key')).toBe(false);
  });

  test('requires matching modern protocol, method, and name headers', async () => {
    const callBody = modernBody('tools/call', {
      name: 'list-active-events',
      arguments: { facilityId: null, cursor: null, limit: 1 },
    });
    const cases = [
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'list-active-events',
        },
        body: JSON.stringify(callBody),
      }),
      modernRequest(
        'tools/call',
        {
          name: 'list-active-events',
          arguments: { facilityId: null, cursor: null, limit: 1 },
        },
        { 'Mcp-Method': 'tools/list' },
      ),
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': MCP_MODERN_PROTOCOL_VERSION,
          'Mcp-Method': 'tools/call',
        },
        body: JSON.stringify(callBody),
      }),
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': MCP_MODERN_PROTOCOL_VERSION,
          'Mcp-Method': 'tools/call',
        },
        body: JSON.stringify(modernBody('tools/call', { arguments: {} })),
      }),
    ];
    for (const request of cases) {
      const response = await harness()(request);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: -32020, message: 'Header mismatch' },
      });
    }
  });

  test('rejects an unsupported metadata version without a transport header', async () => {
    const response = await harness()(
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2099-01-01',
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      id: 17,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: {
          requested: '2099-01-01',
          supported: expect.arrayContaining([MCP_MODERN_PROTOCOL_VERSION]),
        },
      },
    });
  });

  test('denies disallowed origins before processing the request', async () => {
    const response = await harness()(
      modernRequest('tools/list', {}, { Origin: 'https://attacker.test' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: 'Invalid Origin' },
    });
  });

  test('bounds request bodies before reading oversized declared content', async () => {
    const response = await harness()(
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': String(1024 * 1024 + 1),
        },
        body: '{}',
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: -32700 },
    });
  });

  test('supports legacy initialize and headerless 2025-03-26 fallback', async () => {
    const initialize = await harness()(
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'legacy', version: '1' },
          },
        }),
      }),
    );
    expect(initialize.status).toBe(200);
    expect(await initialize.json()).toMatchObject({
      result: { protocolVersion: '2025-06-18' },
    });

    const fallback = await harness()(
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      }),
    );
    expect(fallback.status).toBe(200);
    const body = (await fallback.json()) as { result: Record<string, unknown> };
    expect(body.result.tools).toBeArray();
    expect(body.result.resultType).toBeUndefined();
  });

  test('returns 202 with no body for accepted legacy notifications', async () => {
    const response = await harness()(
      new Request('http://127.0.0.1:3100/mcp', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  test('does not offer GET streams', async () => {
    const response = await harness()(new Request('http://127.0.0.1:3100/mcp'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('HTTP configuration', () => {
  test('binds only to loopback with a bounded port', () => {
    expect(
      readStreamableHttpConfig({ PSD_EOC_MCP_HTTP_PORT: '4310' }),
    ).toMatchObject({ hostname: '127.0.0.1', port: 4310, path: '/mcp' });
    expect(() =>
      readStreamableHttpConfig({ PSD_EOC_MCP_HTTP_HOST: '0.0.0.0' }),
    ).toThrow(AgentApiConfigurationError);
    expect(() =>
      readStreamableHttpConfig({ PSD_EOC_MCP_HTTP_PORT: '70000' }),
    ).toThrow(AgentApiConfigurationError);
  });
});
