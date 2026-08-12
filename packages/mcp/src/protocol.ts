import { AgentApiCallError, AgentApiInputError } from './agent-client';
import type { AgentApiClient } from './agent-client';
import { MCP_TOOLS, assertSafeMcpManifest, isMcpToolName } from './manifest';
import { MCP_RESOURCES, isMcpResourceUri, readMcpResource } from './resources';

export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28' as const;
export const MCP_LEGACY_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
] as const);
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MCP_MODERN_PROTOCOL_VERSION,
  ...MCP_LEGACY_PROTOCOL_VERSIONS,
] as const);

export type McpProtocolVersion =
  (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];
export type JsonRpcId = string | number;

const SERVER_INFO = Object.freeze({
  name: 'psd-eoc',
  title: 'PSD EOC',
  version: '0.0.0',
});
const SERVER_CAPABILITIES = Object.freeze({
  tools: Object.freeze({}),
  resources: Object.freeze({}),
});
const SERVER_INSTRUCTIONS =
  'Use these scoped tools for PSD EOC reads, drill records, reports, unpublished template drafts, and activation preparation. Starting a real incident, sending a real notification, declaring an event all clear, and closing a real event always require an authenticated human in the PSD EOC app. Drill records are evidence, not a compliance determination.';

type JsonObject = Record<string, unknown>;

export interface JsonRpcResultResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId | null;
  readonly error: Readonly<{
    code: number;
    message: string;
    data?: unknown;
  }>;
}

export type JsonRpcResponse = JsonRpcResultResponse | JsonRpcErrorResponse;

export interface McpRequestContext {
  readonly protocolVersion?: string;
}

export interface McpProtocolDependencies {
  readonly readResource?: typeof readMcpResource;
}

export class McpProtocolError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): JsonRpcId | null {
  if (!isObject(value)) return null;
  const id = value.id;
  return typeof id === 'string' ||
    (typeof id === 'number' && Number.isInteger(id))
    ? id
    : null;
}

function requiredRequestId(value: unknown): JsonRpcId {
  const id = requestId(value);
  if (id === null) throw new McpProtocolError(-32600, 'Invalid Request');
  return id;
}

function requestParams(value: JsonObject): JsonObject {
  if (value.params === undefined) return {};
  if (!isObject(value.params)) {
    throw new McpProtocolError(-32602, 'Invalid params');
  }
  return value.params;
}

function isSupportedProtocolVersion(
  value: unknown,
): value is McpProtocolVersion {
  return (
    typeof value === 'string' &&
    (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value)
  );
}

function unsupportedProtocolVersion(requested: unknown): McpProtocolError {
  return new McpProtocolError(-32022, 'Unsupported protocol version', {
    supported: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    requested: typeof requested === 'string' ? requested : null,
  });
}

function mismatchedProtocolVersions(
  transportVersion: McpProtocolVersion,
  metadataVersion: McpProtocolVersion,
): McpProtocolError {
  return new McpProtocolError(-32022, 'Protocol version mismatch', {
    supported: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    requested: metadataVersion,
    transport: transportVersion,
  });
}

function modernRequestMetadata(params: JsonObject): JsonObject {
  if (!isObject(params._meta)) {
    throw new McpProtocolError(-32602, 'Invalid params');
  }
  const meta = params._meta;
  const version = meta['io.modelcontextprotocol/protocolVersion'];
  if (version !== MCP_MODERN_PROTOCOL_VERSION) {
    if (typeof version === 'string') throw unsupportedProtocolVersion(version);
    throw new McpProtocolError(-32602, 'Invalid params');
  }
  if (!isObject(meta['io.modelcontextprotocol/clientCapabilities'])) {
    throw new McpProtocolError(-32602, 'Invalid params');
  }
  const clientInfo = meta['io.modelcontextprotocol/clientInfo'];
  if (clientInfo !== undefined) {
    if (
      !isObject(clientInfo) ||
      typeof clientInfo.name !== 'string' ||
      clientInfo.name.length < 1 ||
      typeof clientInfo.version !== 'string' ||
      clientInfo.version.length < 1
    ) {
      throw new McpProtocolError(-32602, 'Invalid params');
    }
  }
  return meta;
}

function resultForVersion(
  protocolVersion: McpProtocolVersion,
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (protocolVersion !== MCP_MODERN_PROTOCOL_VERSION) return result;
  return Object.freeze({
    resultType: 'complete',
    ...result,
    _meta: Object.freeze({
      'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    }),
  });
}

function success(
  id: JsonRpcId,
  protocolVersion: McpProtocolVersion,
  result: Readonly<Record<string, unknown>>,
): JsonRpcResultResponse {
  return Object.freeze({
    jsonrpc: '2.0' as const,
    id,
    result: resultForVersion(protocolVersion, result),
  });
}

function failure(
  id: JsonRpcId | null,
  error: McpProtocolError,
): JsonRpcErrorResponse {
  const body =
    error.data === undefined
      ? Object.freeze({ code: error.code, message: error.message })
      : Object.freeze({
          code: error.code,
          message: error.message,
          data: error.data,
        });
  return Object.freeze({ jsonrpc: '2.0' as const, id, error: body });
}

function protocolVersionFor(
  params: JsonObject,
  context: McpRequestContext,
): McpProtocolVersion {
  const metadataVersion = isObject(params._meta)
    ? params._meta['io.modelcontextprotocol/protocolVersion']
    : undefined;
  const transportVersion = context.protocolVersion;
  if (
    transportVersion !== undefined &&
    !isSupportedProtocolVersion(transportVersion)
  ) {
    throw unsupportedProtocolVersion(transportVersion);
  }
  if (
    metadataVersion !== undefined &&
    !isSupportedProtocolVersion(metadataVersion)
  ) {
    throw unsupportedProtocolVersion(metadataVersion);
  }
  if (
    transportVersion !== undefined &&
    metadataVersion !== undefined &&
    transportVersion !== metadataVersion
  ) {
    throw mismatchedProtocolVersions(transportVersion, metadataVersion);
  }
  const requested = metadataVersion ?? transportVersion;
  if (requested === undefined) return '2025-03-26';
  if (requested === MCP_MODERN_PROTOCOL_VERSION) modernRequestMetadata(params);
  return requested;
}

function initializationResult(params: JsonObject): Readonly<JsonObject> {
  const requested = params.protocolVersion;
  const selected = isSupportedProtocolVersion(requested)
    ? requested === MCP_MODERN_PROTOCOL_VERSION
      ? MCP_LEGACY_PROTOCOL_VERSIONS[0]
      : requested
    : MCP_LEGACY_PROTOCOL_VERSIONS[0];
  return Object.freeze({
    protocolVersion: selected,
    capabilities: SERVER_CAPABILITIES,
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  });
}

function validateInitializationParams(params: JsonObject): void {
  const clientInfo = params.clientInfo;
  if (
    typeof params.protocolVersion !== 'string' ||
    !isObject(params.capabilities) ||
    !isObject(clientInfo) ||
    typeof clientInfo.name !== 'string' ||
    clientInfo.name.length < 1 ||
    typeof clientInfo.version !== 'string' ||
    clientInfo.version.length < 1
  ) {
    throw new McpProtocolError(-32602, 'Invalid params');
  }
}

function discoverResult(): Readonly<JsonObject> {
  return Object.freeze({
    resultType: 'complete',
    supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
    capabilities: SERVER_CAPABILITIES,
    instructions: SERVER_INSTRUCTIONS,
    ttlMs: 300_000,
    cacheScope: 'private',
    _meta: Object.freeze({
      'io.modelcontextprotocol/serverInfo': SERVER_INFO,
    }),
  });
}

function toolErrorResult(error: AgentApiCallError): Readonly<JsonObject> {
  const structuredContent = Object.freeze({
    error: Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId: error.requestId,
    }),
  });
  return Object.freeze({
    content: Object.freeze([
      Object.freeze({
        type: 'text' as const,
        text: JSON.stringify(structuredContent),
      }),
    ]),
    structuredContent,
    isError: true,
  });
}

export class PsdEocMcpProtocol {
  readonly #readResource: typeof readMcpResource;

  public constructor(
    private readonly agentApi: AgentApiClient,
    dependencies: McpProtocolDependencies = {},
  ) {
    this.#readResource = dependencies.readResource ?? readMcpResource;
  }

  public async handle(
    value: unknown,
    context: McpRequestContext = {},
  ): Promise<JsonRpcResponse | null> {
    const id = requestId(value);
    const isNotification = isObject(value) && value.id === undefined;
    try {
      if (
        !isObject(value) ||
        value.jsonrpc !== '2.0' ||
        typeof value.method !== 'string' ||
        (!isNotification && id === null)
      ) {
        throw new McpProtocolError(-32600, 'Invalid Request');
      }
      const params = requestParams(value);

      if (isNotification) {
        if (
          value.method === 'notifications/initialized' ||
          value.method === 'notifications/cancelled'
        ) {
          return null;
        }
        return null;
      }

      const responseId = requiredRequestId(value);
      if (value.method === 'initialize') {
        validateInitializationParams(params);
        return Object.freeze({
          jsonrpc: '2.0' as const,
          id: responseId,
          result: initializationResult(params),
        });
      }
      if (value.method === 'server/discover') {
        modernRequestMetadata(params);
        return Object.freeze({
          jsonrpc: '2.0' as const,
          id: responseId,
          result: discoverResult(),
        });
      }

      const protocolVersion = protocolVersionFor(params, context);
      switch (value.method) {
        case 'ping':
          return success(responseId, protocolVersion, Object.freeze({}));

        case 'tools/list':
          assertSafeMcpManifest(MCP_TOOLS);
          return success(
            responseId,
            protocolVersion,
            Object.freeze({
              tools: MCP_TOOLS,
              ...(protocolVersion === MCP_MODERN_PROTOCOL_VERSION
                ? { ttlMs: 300_000, cacheScope: 'public' }
                : {}),
            }),
          );

        case 'tools/call': {
          if (!isMcpToolName(params.name)) {
            throw new McpProtocolError(-32602, 'Invalid params');
          }
          const args = params.arguments ?? {};
          if (!isObject(args)) {
            throw new McpProtocolError(-32602, 'Invalid params');
          }
          try {
            const output =
              params.name === 'draft-message-template-revision'
                ? await this.agentApi.draftMessageTemplateRevision(args)
                : await this.agentApi.call(params.name, args);
            const serialized = JSON.stringify(output);
            return success(
              responseId,
              protocolVersion,
              Object.freeze({
                content: Object.freeze([
                  Object.freeze({ type: 'text' as const, text: serialized }),
                ]),
                structuredContent: output as JsonObject,
                isError: false,
              }),
            );
          } catch (error) {
            if (error instanceof AgentApiInputError) {
              throw new McpProtocolError(-32602, 'Invalid params', {
                details: error.details,
              });
            }
            if (error instanceof AgentApiCallError) {
              return success(
                responseId,
                protocolVersion,
                toolErrorResult(error),
              );
            }
            throw error;
          }
        }

        case 'resources/list':
          return success(
            responseId,
            protocolVersion,
            Object.freeze({
              resources: MCP_RESOURCES,
              ...(protocolVersion === MCP_MODERN_PROTOCOL_VERSION
                ? { ttlMs: 300_000, cacheScope: 'public' }
                : {}),
            }),
          );

        case 'resources/read': {
          if (!isMcpResourceUri(params.uri)) {
            throw new McpProtocolError(-32602, 'Resource not found');
          }
          const content = await this.#readResource(params.uri);
          return success(
            responseId,
            protocolVersion,
            Object.freeze({
              contents: Object.freeze([content]),
              ...(protocolVersion === MCP_MODERN_PROTOCOL_VERSION
                ? { ttlMs: 300_000, cacheScope: 'public' }
                : {}),
            }),
          );
        }

        case 'resources/templates/list':
          return success(
            responseId,
            protocolVersion,
            Object.freeze({
              resourceTemplates: Object.freeze([]),
              ...(protocolVersion === MCP_MODERN_PROTOCOL_VERSION
                ? { ttlMs: 300_000, cacheScope: 'public' }
                : {}),
            }),
          );

        default:
          throw new McpProtocolError(-32601, 'Method not found');
      }
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof McpProtocolError) return failure(id, error);
      return failure(id, new McpProtocolError(-32603, 'Internal error'));
    }
  }
}
