import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  CAPABILITY_CATALOG,
  HUMAN_ONLY_ACTION_IDS,
  ApiErrorSchema,
  IdempotencyKeySchema,
  getCapabilityInvocationPolicy,
  type AgentGrantableCapabilityId,
} from '@psd-eoc/contracts';
import { z } from 'zod';

import { isAgentDeployedCapabilityId } from './availability';

const AGENT_API_BASE_PATH = '/api/agent/v1/capabilities' as const;
const JSON_SCHEMA_DIALECT =
  'https://json-schema.org/draft/2020-12/schema' as const;

/** The exact contract-owned capability IDs callable through agent REST. */
export const AGENT_REST_CAPABILITY_IDS: readonly AgentGrantableCapabilityId[] =
  Object.freeze([...AGENT_GRANTABLE_CAPABILITY_IDS]);

export type AgentRestCapabilityId = AgentGrantableCapabilityId;

export interface AgentRestCapabilityManifestEntry {
  readonly id: AgentRestCapabilityId;
  readonly operation: 'query' | 'mutation';
  readonly method: 'POST';
  readonly path: `${typeof AGENT_API_BASE_PATH}/${AgentRestCapabilityId}`;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
}

export type AgentRestJsonSchema = Readonly<Record<string, unknown>>;

interface OpenApiSchemaReference {
  readonly $ref: string;
}

interface OpenApiMediaType {
  readonly schema: OpenApiSchemaReference;
}

interface OpenApiResponse {
  readonly description: string;
  readonly content: Readonly<Record<'application/json', OpenApiMediaType>>;
}

interface OpenApiParameter {
  readonly name: string;
  readonly in: 'header';
  readonly required: boolean;
  readonly description: string;
  readonly schema: OpenApiSchemaReference;
}

export interface AgentRestOpenApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody: Readonly<{
    required: true;
    content: Readonly<Record<'application/json', OpenApiMediaType>>;
  }>;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
  readonly 'x-psd-eoc-capability-id': AgentRestCapabilityId;
  readonly 'x-psd-eoc-capability-operation': 'query' | 'mutation';
  readonly 'x-psd-eoc-deployment-status': 'available' | 'unavailable';
}

export interface AgentRestOpenApiDocument {
  readonly openapi: '3.1.0';
  readonly jsonSchemaDialect: typeof JSON_SCHEMA_DIALECT;
  readonly info: Readonly<{
    title: string;
    version: string;
    description: string;
  }>;
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly paths: Readonly<
    Record<
      string,
      Readonly<{
        post: AgentRestOpenApiOperation;
      }>
    >
  >;
  readonly components: Readonly<{
    securitySchemes: Readonly<
      Record<
        'agentBearerAuth',
        Readonly<{
          type: 'http';
          scheme: 'bearer';
          bearerFormat: string;
          description: string;
        }>
      >
    >;
    schemas: Readonly<Record<string, AgentRestJsonSchema>>;
  }>;
}

const agentRestCapabilityIdSet = new Set<string>(AGENT_REST_CAPABILITY_IDS);
const humanOnlyActionIdSet = new Set<string>(HUMAN_ONLY_ACTION_IDS);

/** Narrows an untrusted route segment to the closed agent REST manifest. */
export function isAgentRestCapabilityId(
  value: unknown,
): value is AgentRestCapabilityId {
  return typeof value === 'string' && agentRestCapabilityIdSet.has(value);
}

/** Returns the only canonical REST path for an agent capability. */
export function agentRestCapabilityPath(
  capabilityId: AgentRestCapabilityId,
): `${typeof AGENT_API_BASE_PATH}/${AgentRestCapabilityId}` {
  return `${AGENT_API_BASE_PATH}/${capabilityId}`;
}

function createManifest(): Readonly<
  Record<AgentRestCapabilityId, AgentRestCapabilityManifestEntry>
> {
  const entries = AGENT_REST_CAPABILITY_IDS.map((capabilityId) => {
    if (humanOnlyActionIdSet.has(capabilityId)) {
      throw new TypeError(
        'A human-only action ID cannot appear in the agent REST manifest.',
      );
    }
    const definition = CAPABILITY_CATALOG[capabilityId];
    const policy = getCapabilityInvocationPolicy(capabilityId);
    if (
      !policy.agentGrantable ||
      !policy.principalKinds.includes('agent') ||
      !policy.sources.includes('agent-rest')
    ) {
      throw new TypeError(
        `The canonical invocation policy does not expose ${capabilityId} to agent REST.`,
      );
    }
    const entry: AgentRestCapabilityManifestEntry = Object.freeze({
      id: capabilityId,
      operation: definition.operation,
      method: 'POST',
      path: agentRestCapabilityPath(capabilityId),
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
    });
    return [capabilityId, entry] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<AgentRestCapabilityId, AgentRestCapabilityManifestEntry>
  >;
}

/**
 * Shared route manifest for the REST gateway and the generated description.
 * Its schemas are the catalog objects themselves; adapters must not fork them.
 */
export const AGENT_REST_CAPABILITY_MANIFEST = createManifest();

/** Resolves one gateway entry without accepting aliases or protected IDs. */
export function getAgentRestCapabilityManifestEntry(
  value: unknown,
): AgentRestCapabilityManifestEntry | null {
  return isAgentRestCapabilityId(value)
    ? AGENT_REST_CAPABILITY_MANIFEST[value]
    : null;
}

function pascalCaseCapabilityId(capabilityId: AgentRestCapabilityId): string {
  return capabilityId
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/** Stable component names shared by document generation and drift tests. */
export function agentRestSchemaNames(capabilityId: AgentRestCapabilityId) {
  const stem = pascalCaseCapabilityId(capabilityId);
  return Object.freeze({
    input: `${stem}Input`,
    output: `${stem}Output`,
  });
}

function schemaReference(name: string): OpenApiSchemaReference {
  return Object.freeze({ $ref: `#/components/schemas/${name}` });
}

function jsonContent(name: string) {
  return Object.freeze({
    'application/json': Object.freeze({ schema: schemaReference(name) }),
  });
}

const omittedProtectedAction = Symbol('omitted-protected-action');

function withoutProtectedActionIds(
  value: unknown,
): unknown | typeof omittedProtectedAction {
  if (typeof value === 'string') {
    return humanOnlyActionIdSet.has(value) ? omittedProtectedAction : value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = withoutProtectedActionIds(item);
      return sanitized === omittedProtectedAction ? [] : [sanitized];
    });
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (humanOnlyActionIdSet.has(key)) continue;
      const child = withoutProtectedActionIds(item);
      if (
        child !== omittedProtectedAction &&
        !(
          (key === 'enum' || key === 'required') &&
          Array.isArray(child) &&
          child.length === 0
        )
      ) {
        sanitized[key] = child;
      }
    }
    return sanitized;
  }
  return value;
}

function contractJsonSchema(schema: z.ZodType): AgentRestJsonSchema {
  const sanitized = withoutProtectedActionIds(z.toJSONSchema(schema));
  if (
    sanitized === omittedProtectedAction ||
    typeof sanitized !== 'object' ||
    sanitized === null ||
    Array.isArray(sanitized)
  ) {
    throw new TypeError('A contract JSON schema must remain an object.');
  }
  return sanitized as AgentRestJsonSchema;
}

function errorResponse(description: string): OpenApiResponse {
  return Object.freeze({
    description,
    content: jsonContent('ApiError'),
  });
}

function operationId(
  capabilityId: AgentRestCapabilityId,
  operation: 'query' | 'mutation',
): string {
  return `agent${operation === 'query' ? 'Query' : 'Command'}${pascalCaseCapabilityId(capabilityId)}`;
}

function operationFor(
  entry: AgentRestCapabilityManifestEntry,
): AgentRestOpenApiOperation {
  const deployed = isAgentDeployedCapabilityId(entry.id);
  const schemaNames = agentRestSchemaNames(entry.id);
  const idempotencyParameters: readonly OpenApiParameter[] =
    entry.operation === 'mutation'
      ? Object.freeze([
          Object.freeze({
            name: 'Idempotency-Key',
            in: 'header' as const,
            required: true,
            description:
              'Caller-generated key that binds one mutation payload to one safe retry identity.',
            schema: schemaReference('IdempotencyKey'),
          }),
        ])
      : Object.freeze([]);

  return Object.freeze({
    operationId: operationId(entry.id, entry.operation),
    summary:
      entry.operation === 'query'
        ? 'Execute an agent query capability'
        : 'Execute an agent mutation capability',
    description: deployed
      ? 'The server authenticates the API key, applies its capability and facility scope, executes the deployed canonical capability, and records security audit evidence.'
      : 'The contract is reserved for agent parity, but its canonical handler is not deployed yet. Authenticated calls fail closed with an audited 503 response.',
    tags: Object.freeze([
      entry.operation === 'query' ? 'agent-query' : 'agent-mutation',
    ]),
    security: Object.freeze([
      Object.freeze({ agentBearerAuth: Object.freeze([]) }),
    ]),
    parameters: idempotencyParameters,
    requestBody: Object.freeze({
      required: true as const,
      content: jsonContent(schemaNames.input),
    }),
    responses: Object.freeze({
      '200': Object.freeze({
        description: 'Canonical capability result.',
        content: jsonContent(schemaNames.output),
      }),
      '400': errorResponse(
        'The request does not match the canonical contract.',
      ),
      '401': errorResponse('The bearer credential is absent or invalid.'),
      '403': errorResponse(
        'The authenticated key is not permitted by its grant, facility scope, or server safety policy.',
      ),
      '404': errorResponse('The requested record is unavailable.'),
      '409': errorResponse(
        'The request conflicts with retained state or idempotency evidence.',
      ),
      '429': errorResponse('The caller must wait before retrying.'),
      '500': errorResponse(
        'The request failed without overstating its outcome.',
      ),
      '503': errorResponse('The capability is currently unavailable.'),
    }),
    'x-psd-eoc-capability-id': entry.id,
    'x-psd-eoc-capability-operation': entry.operation,
    'x-psd-eoc-deployment-status': deployed ? 'available' : 'unavailable',
  });
}

/** Builds the OpenAPI 3.1 document directly from the canonical Zod catalog. */
export function createAgentRestOpenApiDocument(): AgentRestOpenApiDocument {
  const schemas: Record<string, AgentRestJsonSchema> = {
    ApiError: contractJsonSchema(ApiErrorSchema),
    IdempotencyKey: contractJsonSchema(IdempotencyKeySchema),
  };
  const paths: Record<
    string,
    Readonly<{ post: AgentRestOpenApiOperation }>
  > = {};

  for (const capabilityId of AGENT_REST_CAPABILITY_IDS) {
    const entry = AGENT_REST_CAPABILITY_MANIFEST[capabilityId];
    const names = agentRestSchemaNames(capabilityId);
    if (
      schemas[names.input] !== undefined ||
      schemas[names.output] !== undefined
    ) {
      throw new TypeError('Agent REST component schema names must be unique.');
    }
    schemas[names.input] = contractJsonSchema(entry.inputSchema);
    schemas[names.output] = contractJsonSchema(entry.outputSchema);
    paths[entry.path] = Object.freeze({ post: operationFor(entry) });
  }

  return Object.freeze({
    openapi: '3.1.0' as const,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: Object.freeze({
      title: 'PSD EOC Agent REST API',
      version: '1.0.0',
      description:
        'Scoped, audited access to canonical PSD EOC capabilities for district agents. Server safety policy remains authoritative for every request.',
    }),
    security: Object.freeze([
      Object.freeze({ agentBearerAuth: Object.freeze([]) }),
    ]),
    paths: Object.freeze(paths),
    components: Object.freeze({
      securitySchemes: Object.freeze({
        agentBearerAuth: Object.freeze({
          type: 'http' as const,
          scheme: 'bearer' as const,
          bearerFormat: 'PSD-EOC-Agent-Key',
          description:
            'Opaque, revocable agent credential. Submit it only in the Authorization header.',
        }),
      }),
      schemas: Object.freeze(schemas),
    }),
  });
}

function containsProtectedActionId(value: unknown): boolean {
  if (typeof value === 'string') return humanOnlyActionIdSet.has(value);
  if (Array.isArray(value)) return value.some(containsProtectedActionId);
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.entries(value).some(
      ([key, item]) =>
        humanOnlyActionIdSet.has(key) || containsProtectedActionId(item),
    )
  );
}

/**
 * Fails closed if the generated callable surface drifts from the safe manifest.
 * Protected action IDs are absent from both callable operations and component
 * schemas; the safety charter outranks descriptive-schema completeness.
 */
export function assertAgentRestOpenApiDocument(
  document: AgentRestOpenApiDocument,
): void {
  if (containsProtectedActionId(document)) {
    throw new TypeError(
      'A human-only action ID cannot appear in the agent REST document.',
    );
  }
  const paths = Object.keys(document.paths).sort();
  const expectedPaths = AGENT_REST_CAPABILITY_IDS.map((capabilityId) =>
    agentRestCapabilityPath(capabilityId),
  ).sort();
  if (
    paths.length !== expectedPaths.length ||
    paths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new TypeError('Agent REST OpenAPI paths do not match the manifest.');
  }

  const operationIds = new Set<string>();
  for (const capabilityId of AGENT_REST_CAPABILITY_IDS) {
    if (humanOnlyActionIdSet.has(capabilityId)) {
      throw new TypeError(
        'A human-only action ID cannot be a callable OpenAPI operation.',
      );
    }
    const entry = AGENT_REST_CAPABILITY_MANIFEST[capabilityId];
    const operation = document.paths[entry.path]?.post;
    if (
      operation === undefined ||
      operation['x-psd-eoc-capability-id'] !== capabilityId ||
      operation['x-psd-eoc-capability-operation'] !== entry.operation ||
      operation['x-psd-eoc-deployment-status'] !==
        (isAgentDeployedCapabilityId(capabilityId)
          ? 'available'
          : 'unavailable') ||
      operationIds.has(operation.operationId)
    ) {
      throw new TypeError(
        'Agent REST OpenAPI operations do not match the manifest.',
      );
    }
    operationIds.add(operation.operationId);
  }
}

export const AGENT_REST_OPENAPI_DOCUMENT = createAgentRestOpenApiDocument();
assertAgentRestOpenApiDocument(AGENT_REST_OPENAPI_DOCUMENT);
