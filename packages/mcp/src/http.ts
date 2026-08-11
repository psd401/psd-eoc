import {
  AgentApiClient,
  AgentApiConfigurationError,
  readAgentApiConfig,
} from './agent-client';
import {
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  PsdEocMcpProtocol,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
} from './protocol';

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface StreamableHttpConfig {
  readonly hostname: '127.0.0.1' | '::1' | 'localhost';
  readonly port: number;
  readonly path: '/mcp';
  readonly allowedOrigins: ReadonlySet<string>;
}

function errorResponse(
  code: number,
  message: string,
  id: string | number | null = null,
  data?: unknown,
): JsonRpcErrorResponse {
  return Object.freeze({
    jsonrpc: '2.0' as const,
    id,
    error:
      data === undefined
        ? Object.freeze({ code, message })
        : Object.freeze({ code, message, data }),
  });
}

function jsonResponse(body: JsonRpcResponse, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseId(value: unknown): string | number | null {
  if (!isObject(value)) return null;
  return typeof value.id === 'string' ||
    (typeof value.id === 'number' && Number.isInteger(value.id))
    ? value.id
    : null;
}

function decodedHeaderValue(value: string | null): string | null {
  if (value === null) return null;
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice('=?base64?'.length, -'?='.length);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    return null;
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function expectedMcpName(value: Record<string, unknown>): string | null {
  if (!isObject(value.params)) return null;
  if (value.method === 'tools/call' || value.method === 'prompts/get') {
    return typeof value.params.name === 'string' ? value.params.name : null;
  }
  if (value.method === 'resources/read') {
    return typeof value.params.uri === 'string' ? value.params.uri : null;
  }
  return null;
}

function validateModernHeaders(
  request: Request,
  value: Record<string, unknown>,
): JsonRpcErrorResponse | null {
  const id = responseId(value);
  const params = isObject(value.params) ? value.params : null;
  const meta = params !== null && isObject(params._meta) ? params._meta : null;
  const bodyVersion = meta?.['io.modelcontextprotocol/protocolVersion'] ?? null;
  const headerVersion = request.headers.get('mcp-protocol-version');
  const headerMethod = request.headers.get('mcp-method');
  const bodyMethod = typeof value.method === 'string' ? value.method : null;
  const expectedName = expectedMcpName(value);
  const actualName = decodedHeaderValue(request.headers.get('mcp-name'));
  const requiresName =
    bodyMethod === 'tools/call' ||
    bodyMethod === 'resources/read' ||
    bodyMethod === 'prompts/get';
  if (
    headerVersion !== MCP_MODERN_PROTOCOL_VERSION ||
    bodyVersion !== MCP_MODERN_PROTOCOL_VERSION ||
    headerVersion !== bodyVersion ||
    headerMethod === null ||
    headerMethod !== bodyMethod ||
    (requiresName &&
      (expectedName === null ||
        actualName === null ||
        actualName !== expectedName)) ||
    (!requiresName && request.headers.has('mcp-name'))
  ) {
    return errorResponse(-32020, 'Header mismatch', id);
  }
  return null;
}

function originAllowed(
  request: Request,
  config: StreamableHttpConfig,
): boolean {
  const value = request.headers.get('origin');
  if (value === null) return true;
  if (config.allowedOrigins.has(value)) return true;
  try {
    const origin = new URL(value);
    return (
      config.allowedOrigins.size === 0 &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname) &&
      ['http:', 'https:'].includes(origin.protocol)
    );
  } catch {
    return false;
  }
}

async function boundedRequestJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new RangeError('request-too-large');
  }
  if (request.body === null) throw new SyntaxError('missing-body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError('request-too-large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  ) as unknown;
}

function httpStatus(response: JsonRpcResponse, modern: boolean): number {
  if (!('error' in response)) return 200;
  if (response.error.code === -32603) return 500;
  if (!modern) return 200;
  if (response.error.code === -32601) return 404;
  if (
    response.error.code === -32600 ||
    response.error.code === -32602 ||
    response.error.code === -32020 ||
    response.error.code === -32021 ||
    response.error.code === -32022
  ) {
    return 400;
  }
  return 200;
}

export function createStreamableHttpHandler(
  protocol: PsdEocMcpProtocol,
  config: StreamableHttpConfig,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (!originAllowed(request, config)) {
      return jsonResponse(errorResponse(-32600, 'Invalid Origin'), 403);
    }
    if (new URL(request.url).pathname !== config.path) {
      return jsonResponse(errorResponse(-32601, 'Method not found'), 404);
    }
    if (request.method !== 'POST') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
      });
    }
    const contentType = request.headers.get('content-type')?.toLowerCase();
    if (contentType?.split(';', 1)[0]?.trim() !== 'application/json') {
      return jsonResponse(errorResponse(-32600, 'Invalid Request'), 415);
    }
    const accept = request.headers.get('accept')?.toLowerCase() ?? '';
    if (
      !accept.includes('*/*') &&
      !(
        accept.includes('application/json') &&
        accept.includes('text/event-stream')
      )
    ) {
      return jsonResponse(errorResponse(-32600, 'Invalid Request'), 406);
    }

    let value: unknown;
    try {
      value = await boundedRequestJson(request);
    } catch (error) {
      return jsonResponse(
        errorResponse(-32700, 'Parse error'),
        error instanceof RangeError ? 413 : 400,
      );
    }
    if (!isObject(value)) {
      return jsonResponse(errorResponse(-32600, 'Invalid Request'), 400);
    }

    const headerVersion = request.headers.get('mcp-protocol-version');
    const bodyMeta =
      isObject(value.params) && isObject(value.params._meta)
        ? value.params._meta
        : null;
    const bodyVersion = bodyMeta?.['io.modelcontextprotocol/protocolVersion'];
    const modern =
      headerVersion === MCP_MODERN_PROTOCOL_VERSION ||
      bodyVersion === MCP_MODERN_PROTOCOL_VERSION;
    const unsupportedRequestedVersion =
      headerVersion !== null &&
      !(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
        headerVersion,
      )
        ? headerVersion
        : bodyVersion !== undefined &&
            (typeof bodyVersion !== 'string' ||
              !(MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
                bodyVersion,
              ))
          ? bodyVersion
          : undefined;
    if (unsupportedRequestedVersion !== undefined) {
      return jsonResponse(
        errorResponse(
          -32022,
          'Unsupported protocol version',
          responseId(value),
          {
            supported: MCP_SUPPORTED_PROTOCOL_VERSIONS,
            requested:
              typeof unsupportedRequestedVersion === 'string'
                ? unsupportedRequestedVersion
                : null,
          },
        ),
        400,
      );
    }
    if (modern) {
      const mismatch = validateModernHeaders(request, value);
      if (mismatch !== null) return jsonResponse(mismatch, 400);
    }

    const context =
      headerVersion === null ? {} : { protocolVersion: headerVersion };
    const response = await protocol.handle(value, context);
    if (response === null) {
      return new Response(null, {
        status: 202,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return jsonResponse(response, httpStatus(response, modern));
  };
}

export function readStreamableHttpConfig(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): StreamableHttpConfig {
  const hostname = environment.PSD_EOC_MCP_HTTP_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new AgentApiConfigurationError(
      'PSD_EOC_MCP_HTTP_HOST must be a loopback hostname.',
    );
  }
  const portText = environment.PSD_EOC_MCP_HTTP_PORT?.trim() || '3100';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AgentApiConfigurationError(
      'PSD_EOC_MCP_HTTP_PORT must be an integer from 1 through 65535.',
    );
  }
  const allowedOrigins = new Set(
    (environment.PSD_EOC_MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== ''),
  );
  return Object.freeze({
    hostname: hostname as StreamableHttpConfig['hostname'],
    port,
    path: '/mcp' as const,
    allowedOrigins,
  });
}

function main(): void {
  try {
    const agentApi = new AgentApiClient(readAgentApiConfig());
    const config = readStreamableHttpConfig();
    const protocol = new PsdEocMcpProtocol(agentApi);
    const server = Bun.serve({
      hostname: config.hostname,
      port: config.port,
      fetch: createStreamableHttpHandler(protocol, config),
    });
    console.error(`PSD EOC MCP listening at ${server.url.toString()}mcp`);
  } catch (error) {
    const message =
      error instanceof AgentApiConfigurationError
        ? error.message
        : 'The PSD EOC MCP HTTP server could not start.';
    console.error(message);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
