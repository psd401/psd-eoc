import { describe, expect, test } from 'bun:test';
import { HUMAN_ONLY_ACTION_IDS } from '@psd-eoc/contracts';

import {
  AgentApiCallError,
  AgentApiClient,
  AgentApiConfigurationError,
  callMcpToolByUnknownName,
  readAgentApiConfig,
} from './agent-client';
import { MCP_TOOLS } from './manifest';

const IDS = Object.freeze({
  facility: '10000000-0000-4000-8000-000000000001',
  preview: '10000000-0000-4000-8000-000000000002',
  request: '10000000-0000-4000-8000-000000000003',
  report: '10000000-0000-4000-8000-000000000004',
  run: '10000000-0000-4000-8000-000000000005',
});

const PAGE = Object.freeze({
  items: Object.freeze([]),
  pageInfo: Object.freeze({ nextCursor: null, hasMore: false }),
});

function clientWithFetch(
  fetchImplementation: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response>,
) {
  return new AgentApiClient(
    Object.freeze({
      baseUrl: 'https://eoc.example.test/api/agent/v1',
      apiKey: 'psd_agent_test-key.1',
    }),
    {
      fetch: fetchImplementation as unknown as typeof fetch,
      createIdempotencyKey: () => 'mcp-idempotency-0001',
    },
  );
}

describe('agent API configuration', () => {
  test('requires a bounded, header-safe scoped credential', () => {
    for (const apiKey of [undefined, '', 'has a space', 'x'.repeat(513)]) {
      expect(() =>
        readAgentApiConfig({ PSD_EOC_AGENT_API_KEY: apiKey }),
      ).toThrow(AgentApiConfigurationError);
    }
    expect(
      readAgentApiConfig({ PSD_EOC_AGENT_API_KEY: 'safe_key-1.value' }),
    ).toEqual({
      apiKey: 'safe_key-1.value',
      baseUrl: 'http://127.0.0.1:3000/api/agent/v1',
    });
  });

  test('requires HTTPS away from loopback and rejects URL credentials', () => {
    for (const baseUrl of [
      'http://eoc.example.test/api/agent/v1',
      'https://user:password@eoc.example.test/api/agent/v1',
      'https://eoc.example.test/api/agent/v1?secret=value',
    ]) {
      expect(() =>
        readAgentApiConfig({
          PSD_EOC_AGENT_API_KEY: 'safe-key',
          PSD_EOC_AGENT_API_BASE_URL: baseUrl,
        }),
      ).toThrow(AgentApiConfigurationError);
    }
    expect(
      readAgentApiConfig({
        PSD_EOC_AGENT_API_KEY: 'safe-key',
        PSD_EOC_AGENT_API_BASE_URL: 'https://eoc.example.test/api/agent/v1/',
      }).baseUrl,
    ).toBe('https://eoc.example.test/api/agent/v1');
  });
});

describe('AgentApiClient', () => {
  test('posts canonical query input with bearer auth and rejects redirects', async () => {
    let captured: Readonly<{ url: string; init: RequestInit }> | undefined;
    const client = clientWithFetch(async (input, init = {}) => {
      captured = Object.freeze({ url: String(input), init });
      return Response.json(PAGE);
    });

    await expect(
      client.call('list-active-events', {
        facilityId: IDS.facility,
        cursor: null,
        limit: 20,
      }),
    ).resolves.toEqual(PAGE);

    expect(captured?.url).toBe(
      'https://eoc.example.test/api/agent/v1/capabilities/list-active-events',
    );
    const headers = new Headers(captured?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer psd_agent_test-key.1');
    expect(headers.has('idempotency-key')).toBe(false);
    expect(captured?.init.redirect).toBe('error');
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      facilityId: IDS.facility,
      cursor: null,
      limit: 20,
    });
  });

  test('adds transport idempotency for safe draft/prepare mutations', async () => {
    let capturedHeaders: Headers | undefined;
    const client = clientWithFetch(async (_input, init = {}) => {
      capturedHeaders = new Headers(init.headers);
      return Response.json(
        {
          code: 'INTERNAL_ERROR',
          message: 'Not deployed.',
          requestId: IDS.request,
          retryable: false,
          fieldErrors: [],
        },
        { status: 503 },
      );
    });

    await expect(
      client.call('prepare-activation', {
        activationPreviewId: IDS.preview,
      }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message:
        'The requested PSD EOC capability is not available in this deployment.',
      retryable: false,
    });
    expect(capturedHeaders?.get('idempotency-key')).toBe(
      'mcp-idempotency-0001',
    );
  });

  test('preserves retryable canonical 503 truth without echoing details', async () => {
    const unsafeDetail = 'Synthetic provider target and readiness details.';
    const client = clientWithFetch(async () =>
      Promise.resolve(
        Response.json(
          {
            code: 'LIVE_ACTION_UNAVAILABLE',
            message: unsafeDetail,
            requestId: IDS.request,
            retryable: true,
            fieldErrors: [],
          },
          { status: 503 },
        ),
      ),
    );

    const error = await client
      .call('prepare-activation', {
        activationPreviewId: IDS.preview,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentApiCallError);
    expect(error).toMatchObject({
      code: 'LIVE_ACTION_UNAVAILABLE',
      message: 'The requested PSD EOC capability is temporarily unavailable.',
      requestId: IDS.request,
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain(unsafeDetail);
  });

  test('rejects every protected action before fetch and omits IDs from manifest', async () => {
    let fetchCalls = 0;
    const client = clientWithFetch(async () => {
      fetchCalls += 1;
      return Response.json(PAGE);
    });
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      await expect(
        callMcpToolByUnknownName(client, actionId, {}),
      ).rejects.toMatchObject({
        name: 'AgentApiInputError',
        details: ['The requested MCP tool is not exposed.'],
      });
      expect(JSON.stringify(MCP_TOOLS)).not.toContain(actionId);
    }
    expect(fetchCalls).toBe(0);
  });

  test('validates arguments and results against canonical contracts', async () => {
    let fetchCalls = 0;
    const client = clientWithFetch(async () => {
      fetchCalls += 1;
      return Response.json({ items: [] });
    });
    await expect(
      client.call('list-active-events', {
        facilityId: IDS.facility,
        cursor: null,
        limit: 0,
      }),
    ).rejects.toMatchObject({ name: 'AgentApiInputError' });
    expect(fetchCalls).toBe(0);

    await expect(
      client.call('list-active-events', {
        facilityId: IDS.facility,
        cursor: null,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      name: 'AgentApiCallError',
      code: 'UPSTREAM_RESPONSE_INVALID',
    });
  });

  test('bounds streamed upstream bodies before allocating the full response', async () => {
    const chunk = new Uint8Array(2 * 1024 * 1024 + 1);
    const client = clientWithFetch(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      client.call('list-active-events', {
        facilityId: null,
        cursor: null,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      name: 'AgentApiCallError',
      message: 'The PSD EOC agent API returned an oversized response.',
    });
  });

  test('rejects an oversized declared response before reading its body', async () => {
    const client = clientWithFetch(async () =>
      Promise.resolve(
        new Response('{}', {
          headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
        }),
      ),
    );
    await expect(
      client.call('list-active-events', {
        facilityId: null,
        cursor: null,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      message: 'The PSD EOC agent API returned an oversized response.',
    });
  });

  test('returns scope-safe failures without echoing upstream facility details', async () => {
    const secretDetail = 'other-facility-name';
    const client = clientWithFetch(async () =>
      Promise.resolve(
        Response.json(
          {
            code: 'FORBIDDEN',
            message: secretDetail,
            requestId: IDS.request,
            retryable: false,
            fieldErrors: [{ path: ['facilityId'], message: secretDetail }],
          },
          { status: 403 },
        ),
      ),
    );
    const error = await client
      .call('list-active-events', {
        facilityId: IDS.facility,
        cursor: null,
        limit: 1,
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AgentApiCallError);
    expect((error as Error).message).not.toContain(secretDetail);
    expect(JSON.stringify(error)).not.toContain(secretDetail);
  });
});
