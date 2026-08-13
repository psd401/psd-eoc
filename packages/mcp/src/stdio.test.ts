import { describe, expect, test } from 'bun:test';

import { AgentApiClient } from './agent-client';
import { PsdEocMcpProtocol } from './protocol';
import { runStdioServer, type StdioWriter } from './stdio';

function protocol(
  implementation: typeof fetch = (async () =>
    Response.json({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    })) as unknown as typeof fetch,
) {
  return new PsdEocMcpProtocol(
    new AgentApiClient(
      {
        baseUrl: 'https://eoc.example.test/api/agent/v1',
        apiKey: 'safe-test-key',
      },
      {
        fetch: implementation,
      },
    ),
  );
}

async function runInput(
  input: ReadableStream<Uint8Array>,
  selectedProtocol = protocol(),
): Promise<string[]> {
  const chunks: Uint8Array[] = [];
  const output: StdioWriter = {
    write(value) {
      chunks.push(value.slice());
      return value.byteLength;
    },
    flush() {
      return 0;
    },
    end() {
      return 0;
    },
  };
  await runStdioServer(selectedProtocol, input, output);
  const total = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes).trim().split('\n').filter(Boolean);
}

async function runLines(lines: readonly string[]): Promise<string[]> {
  const encoded = new TextEncoder().encode(`${lines.join('\n')}\n`);
  return runInput(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const split = Math.floor(encoded.byteLength / 2);
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    }),
  );
}

describe('stdio transport', () => {
  test('frames only one valid JSON-RPC response per output line', async () => {
    const lines = await runLines([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1' },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    ]);
    expect(lines).toHaveLength(2);
    const messages = lines.map((line) => JSON.parse(line) as unknown);
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18' },
    });
    expect(messages[1]).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: expect.any(Array) },
    });
  });

  test('proxies destination-free delivery-test report reads over stdio', async () => {
    let capturedUrl = '';
    let capturedHeaders = new Headers();
    let capturedBody: unknown;
    const selectedProtocol = protocol((async (
      input: Parameters<typeof fetch>[0],
      init: RequestInit = {},
    ) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init.headers);
      capturedBody = JSON.parse(String(init.body)) as unknown;
      return Response.json({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    }) as unknown as typeof fetch);
    const input = {
      facilityId: '30000000-0000-4000-8000-000000000001',
      status: null,
      generatedFrom: null,
      generatedThrough: null,
      cursor: null,
      limit: 20,
    };
    const lines = await runInput(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: 30,
                method: 'tools/call',
                params: {
                  name: 'list-delivery-test-reports',
                  arguments: input,
                  _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientCapabilities': {},
                  },
                },
              })}\n`,
            ),
          );
          controller.close();
        },
      }),
      selectedProtocol,
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      id: 30,
      result: {
        isError: false,
        structuredContent: {
          items: [],
          pageInfo: { nextCursor: null, hasMore: false },
        },
      },
    });
    expect(capturedUrl).toBe(
      'https://eoc.example.test/api/agent/v1/capabilities/list-delivery-test-reports',
    );
    expect(capturedBody).toEqual(input);
    expect(capturedHeaders.has('idempotency-key')).toBe(false);
  });

  test('returns a JSON-RPC parse error without non-protocol stdout', async () => {
    const lines = await runLines(['{not json']);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  test('discards an entire oversized line without executing its request suffix', async () => {
    let fetchCalls = 0;
    const selectedProtocol = protocol((async () => {
      fetchCalls += 1;
      return Response.json({
        items: [],
        pageInfo: { nextCursor: null, hasMore: false },
      });
    }) as unknown as typeof fetch);
    const suffix = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'list-active-events',
        arguments: {
          facilityId: '20000000-0000-4000-8000-000000000001',
          cursor: null,
          limit: 10,
        },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
    const encoder = new TextEncoder();
    const lines = await runInput(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(' '.repeat(1024 * 1024 + 1)));
          controller.enqueue(encoder.encode(`${suffix}\n`));
          controller.close();
        },
      }),
      selectedProtocol,
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    expect(fetchCalls).toBe(0);
  });

  test('rejects a truncated UTF-8 sequence at end of input', async () => {
    const lines = await runInput(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(0xc3));
          controller.close();
        },
      }),
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  });
});
