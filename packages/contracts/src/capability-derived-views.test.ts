import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { AgentCapabilityGrantSchema } from './agent-api';

import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  CAPABILITY_AUDIT_POLICY,
  CAPABILITY_CATALOG,
  CAPABILITY_INVOCATION_POLICY,
  CAPABILITY_MUTATION_SAFETY_MANIFEST,
  CAPABILITY_QUERY_MANIFEST,
  deriveCapabilityViews,
  type CanonicalCapabilityDefinition,
  type AgentCapabilityGrant,
  type AgentGrantableCapabilityId,
} from './capability-catalog';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

const agentGrantTypeIsExact: Equal<
  AgentCapabilityGrant,
  AgentGrantableCapabilityId
> = true;
const agentGrantSchemaOutputIsExact: Equal<
  z.output<typeof AgentCapabilityGrantSchema>,
  AgentGrantableCapabilityId
> = true;

const syntheticPolicy = Object.freeze({
  principalKinds: Object.freeze(['human', 'agent'] as const),
  sources: Object.freeze(['web', 'agent-rest'] as const),
  agentGrantable: true,
});

const syntheticCapability = Object.freeze({
  id: 'synthetic-derived-view',
  operation: 'query',
  safetyEffect: 'none',
  humanActionPolicy: Object.freeze({ kind: 'none' as const }),
  invocationPolicy: syntheticPolicy,
  auditPolicy: 'all-outcomes',
  inputSchema: z.object({ value: z.string() }).strict().readonly(),
  outputSchema: z.object({ accepted: z.boolean() }).strict().readonly(),
} satisfies CanonicalCapabilityDefinition<
  'synthetic-derived-view',
  'query',
  'none',
  z.ZodType,
  z.ZodType,
  'all-outcomes'
>);

describe('canonical capability derived views', () => {
  test('adds one synthetic definition to every required view without another registration', () => {
    const fixture = Object.freeze({
      existing: Object.freeze({
        ...syntheticCapability,
        id: 'existing',
        invocationPolicy: Object.freeze({
          principalKinds: Object.freeze(['human'] as const),
          sources: Object.freeze(['web'] as const),
          agentGrantable: false,
        }),
      }),
      'synthetic-derived-view': syntheticCapability,
    });

    const views = deriveCapabilityViews(fixture);

    expect(views.registeredCapabilityIds).toEqual([
      'existing',
      'synthetic-derived-view',
    ]);
    expect(views.queryManifest['synthetic-derived-view']).toBe('none');
    expect(views.mutationSafetyManifest).toEqual({});
    expect(views.invocationPolicy['synthetic-derived-view']).toBe(
      syntheticPolicy,
    );
    expect(views.auditPolicy['synthetic-derived-view']).toBe('all-outcomes');
    expect(views.agentGrantableCapabilityIds).toEqual([
      'synthetic-derived-view',
    ]);
  });

  test('removing the synthetic definition leaves no stale derived entry', () => {
    const withSynthetic = Object.freeze({
      existing: Object.freeze({
        ...syntheticCapability,
        id: 'existing',
        invocationPolicy: Object.freeze({
          principalKinds: Object.freeze(['human'] as const),
          sources: Object.freeze(['web'] as const),
          agentGrantable: false,
        }),
      }),
      'synthetic-derived-view': syntheticCapability,
    });
    const { 'synthetic-derived-view': removed, ...withoutSynthetic } =
      withSynthetic;

    expect(removed).toBe(syntheticCapability);
    const serializedViews = JSON.stringify(
      deriveCapabilityViews(Object.freeze(withoutSynthetic)),
    );
    expect(serializedViews).not.toContain('synthetic-derived-view');
  });

  test('builds every production registry from the canonical catalog', () => {
    const views = deriveCapabilityViews(CAPABILITY_CATALOG);

    expect(views.mutationSafetyManifest).toEqual(
      CAPABILITY_MUTATION_SAFETY_MANIFEST,
    );
    expect(views.queryManifest).toEqual(CAPABILITY_QUERY_MANIFEST);
    expect(views.invocationPolicy).toEqual(CAPABILITY_INVOCATION_POLICY);
    expect(views.auditPolicy).toEqual(CAPABILITY_AUDIT_POLICY);
    expect(views.agentGrantableCapabilityIds).toEqual(
      AGENT_GRANTABLE_CAPABILITY_IDS,
    );
  });

  test('keeps the public agent-grant type and JSON Schema exact', () => {
    expect(agentGrantTypeIsExact).toBe(true);
    expect(agentGrantSchemaOutputIsExact).toBe(true);
    expect(z.toJSONSchema(AgentCapabilityGrantSchema)).toMatchObject({
      type: 'string',
      enum: [...AGENT_GRANTABLE_CAPABILITY_IDS],
    });
  });

  test('exposes only the initialized root contract entry point', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports?: unknown };
    expect(packageJson.exports).toEqual({ '.': './src/index.ts' });
  });
});
