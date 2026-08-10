import { describe, expect, test } from 'bun:test';

import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  CAPABILITY_CATALOG,
  HUMAN_ONLY_ACTION_IDS,
  ApiErrorSchema,
  IdempotencyKeySchema,
  getCapabilityInvocationPolicy,
} from '@psd-eoc/contracts';
import { z } from 'zod';

import { GET } from '../../app/api/agent/v1/openapi/route';
import { isAgentDeployedCapabilityId } from './availability';
import {
  AGENT_REST_CAPABILITY_IDS,
  AGENT_REST_CAPABILITY_MANIFEST,
  AGENT_REST_OPENAPI_DOCUMENT,
  agentRestCapabilityPath,
  agentRestSchemaNames,
  assertAgentRestOpenApiDocument,
  createAgentRestOpenApiDocument,
  getAgentRestCapabilityManifestEntry,
} from './openapi';

interface ProtectedOccurrence {
  readonly kind: 'key' | 'value';
  readonly value: string;
  readonly path: readonly string[];
}

const omittedProtectedAction = Symbol('omitted-protected-action');

function safeContractSchema(
  value: unknown,
): unknown | typeof omittedProtectedAction {
  const protectedIds = new Set<string>(HUMAN_ONLY_ACTION_IDS);
  if (typeof value === 'string') {
    return protectedIds.has(value) ? omittedProtectedAction : value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = safeContractSchema(item);
      return sanitized === omittedProtectedAction ? [] : [sanitized];
    });
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (protectedIds.has(key)) return [];
        const sanitized = safeContractSchema(item);
        return sanitized === omittedProtectedAction ||
          ((key === 'enum' || key === 'required') &&
            Array.isArray(sanitized) &&
            sanitized.length === 0)
          ? []
          : [[key, sanitized] as const];
      }),
    );
  }
  return value;
}

function safeContractJsonSchema(schema: z.ZodType) {
  const sanitized = safeContractSchema(z.toJSONSchema(schema));
  if (
    sanitized === omittedProtectedAction ||
    typeof sanitized !== 'object' ||
    sanitized === null ||
    Array.isArray(sanitized)
  ) {
    throw new TypeError('A safe contract schema must remain an object.');
  }
  return sanitized as Readonly<Record<string, unknown>>;
}

function protectedOccurrences(
  value: unknown,
  path: readonly string[] = [],
): readonly ProtectedOccurrence[] {
  const protectedIds = new Set<string>(HUMAN_ONLY_ACTION_IDS);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      protectedOccurrences(item, [...path, String(index)]),
    );
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(protectedIds.has(key)
        ? [{ kind: 'key' as const, value: key, path: [...path, key] }]
        : []),
      ...protectedOccurrences(item, [...path, key]),
    ]);
  }
  return typeof value === 'string' && protectedIds.has(value)
    ? [{ kind: 'value', value, path }]
    : [];
}

function operationMetadata() {
  return Object.values(AGENT_REST_OPENAPI_DOCUMENT.paths).map(({ post }) => ({
    capabilityId: post['x-psd-eoc-capability-id'],
    operationId: post.operationId,
    tags: post.tags,
    summary: post.summary,
    description: post.description,
  }));
}

describe('agent REST OpenAPI', () => {
  test('derives the callable manifest exactly from the contract grant list', () => {
    expect(AGENT_REST_CAPABILITY_IDS).toEqual(AGENT_GRANTABLE_CAPABILITY_IDS);
    expect(new Set(AGENT_REST_CAPABILITY_IDS).size).toBe(
      AGENT_REST_CAPABILITY_IDS.length,
    );
    expect(Object.keys(AGENT_REST_CAPABILITY_MANIFEST).sort()).toEqual(
      [...AGENT_GRANTABLE_CAPABILITY_IDS].sort(),
    );

    for (const capabilityId of AGENT_REST_CAPABILITY_IDS) {
      expect(HUMAN_ONLY_ACTION_IDS).not.toContain(capabilityId);
      const contract = CAPABILITY_CATALOG[capabilityId];
      const policy = getCapabilityInvocationPolicy(capabilityId);
      const manifest = AGENT_REST_CAPABILITY_MANIFEST[capabilityId];
      expect(manifest).toMatchObject({
        id: capabilityId,
        operation: contract.operation,
        method: 'POST',
        path: agentRestCapabilityPath(capabilityId),
      });
      expect(manifest.inputSchema).toBe(contract.inputSchema);
      expect(manifest.outputSchema).toBe(contract.outputSchema);
      expect(policy.agentGrantable).toBe(true);
      expect(policy.principalKinds).toContain('agent');
      expect(policy.sources).toContain('agent-rest');
      expect(getAgentRestCapabilityManifestEntry(capabilityId)).toBe(manifest);
    }
    for (const protectedId of HUMAN_ONLY_ACTION_IDS) {
      expect(getAgentRestCapabilityManifestEntry(protectedId)).toBeNull();
    }
  });

  test('keeps every operation and JSON schema synchronized with contracts', () => {
    const document = createAgentRestOpenApiDocument();
    expect(() => assertAgentRestOpenApiDocument(document)).not.toThrow();
    expect(Object.keys(document.paths).sort()).toEqual(
      AGENT_REST_CAPABILITY_IDS.map(agentRestCapabilityPath).sort(),
    );
    expect(document.components.schemas.ApiError).toEqual(
      z.toJSONSchema(ApiErrorSchema),
    );
    expect(document.components.schemas.IdempotencyKey).toEqual(
      z.toJSONSchema(IdempotencyKeySchema),
    );

    for (const capabilityId of AGENT_REST_CAPABILITY_IDS) {
      const contract = CAPABILITY_CATALOG[capabilityId];
      const manifest = AGENT_REST_CAPABILITY_MANIFEST[capabilityId];
      const names = agentRestSchemaNames(capabilityId);
      const operation = document.paths[manifest.path]?.post;
      expect(operation).toBeDefined();
      expect(operation?.['x-psd-eoc-capability-id']).toBe(capabilityId);
      expect(operation?.['x-psd-eoc-capability-operation']).toBe(
        contract.operation,
      );
      expect(operation?.['x-psd-eoc-deployment-status']).toBe(
        isAgentDeployedCapabilityId(capabilityId) ? 'available' : 'unavailable',
      );
      expect(operation?.description).toContain(
        isAgentDeployedCapabilityId(capabilityId)
          ? 'deployed canonical capability'
          : 'not deployed yet',
      );
      expect(operation?.requestBody.content['application/json'].schema).toEqual(
        { $ref: `#/components/schemas/${names.input}` },
      );
      expect(
        operation?.responses['200']?.content['application/json'].schema,
      ).toEqual({ $ref: `#/components/schemas/${names.output}` });
      expect(document.components.schemas[names.input]).toEqual(
        safeContractJsonSchema(contract.inputSchema),
      );
      expect(document.components.schemas[names.output]).toEqual(
        safeContractJsonSchema(contract.outputSchema),
      );
      expect(operation?.parameters.map(({ name }) => name)).toEqual(
        contract.operation === 'mutation' ? ['Idempotency-Key'] : [],
      );
      for (const status of [
        '400',
        '401',
        '403',
        '404',
        '409',
        '429',
        '500',
        '503',
      ]) {
        expect(
          operation?.responses[status]?.content['application/json'].schema,
        ).toEqual({ $ref: '#/components/schemas/ApiError' });
      }
    }
  });

  test('never turns a protected action ID into callable metadata', () => {
    const protectedIds = new Set<string>(HUMAN_ONLY_ACTION_IDS);
    const callableIds = [
      ...AGENT_REST_CAPABILITY_IDS,
      ...Object.keys(AGENT_REST_OPENAPI_DOCUMENT.paths).map(
        (path) => path.split('/').at(-1) ?? '',
      ),
      ...operationMetadata().flatMap((operation) => [
        operation.capabilityId,
        operation.operationId,
        ...operation.tags,
        operation.summary,
        operation.description,
      ]),
    ];
    expect(callableIds.some((value) => protectedIds.has(value))).toBe(false);

    expect(protectedOccurrences(AGENT_REST_OPENAPI_DOCUMENT)).toEqual([]);

    const rawContractOccurrences = AGENT_REST_CAPABILITY_IDS.flatMap(
      (capabilityId) => {
        const contract = CAPABILITY_CATALOG[capabilityId];
        return [contract.inputSchema, contract.outputSchema].flatMap((schema) =>
          protectedOccurrences(z.toJSONSchema(schema)),
        );
      },
    );
    expect(rawContractOccurrences.length).toBeGreaterThan(0);
  });

  test('declares bearer authentication and serves uncached JSON', async () => {
    expect(AGENT_REST_OPENAPI_DOCUMENT.security).toEqual([
      { agentBearerAuth: [] },
    ]);
    expect(
      AGENT_REST_OPENAPI_DOCUMENT.components.securitySchemes.agentBearerAuth,
    ).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'PSD-EOC-Agent-Key',
    });
    for (const { post } of Object.values(AGENT_REST_OPENAPI_DOCUMENT.paths)) {
      expect(post.security).toEqual([{ agentBearerAuth: [] }]);
    }

    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('vary')).toBe('Authorization');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual(AGENT_REST_OPENAPI_DOCUMENT);
  });
});
