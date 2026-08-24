import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import {
  invokeAuthorizedCapabilityHandler,
  registerCapabilityHandler,
  type CapabilityExecutionAuthorizer,
  type CapabilityPrincipalKind,
  type InvocationSource,
} from '@psd-eoc/contracts';

import { REPOSITORY_OWNED_MUTATION_CAPABILITY_IDS } from './engine';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const LOWER_TIER_PRODUCTION_ALLOWLIST = Object.freeze([
  'packages/contracts/src/capability-catalog.ts',
  'packages/contracts/src/capability.ts',
  'packages/server/app/api/internal/delivery-state/runtime.ts',
  'packages/server/app/api/jobs/roster-sync/runtime.ts',
  'packages/server/app/api/webhooks/ses/runtime.ts',
  'packages/server/lib/capabilities/engine.ts',
  'packages/server/lib/notify/dispatcher.ts',
  'packages/server/lib/notify/reconcile.ts',
  'packages/server/lib/notify/sms-policy.ts',
  'packages/server/scripts/operations/sync-access-membership.ts',
] as const);

const SESSION_REPLAY_ENGINE_ALLOWLIST = Object.freeze([
  'packages/server/lib/auth/sessions.ts',
  'packages/server/lib/capabilities/engine.ts',
] as const);

const REPOSITORY_AUDITED_OIDC_ALLOWLIST = Object.freeze([
  'packages/server/app/(auth)/auth/callback/route.ts',
  'packages/server/app/api/auth/mobile/oidc/exchange/route.ts',
  'packages/server/lib/capabilities/engine.ts',
] as const);

function isProductionSource(path: string): boolean {
  return (
    (path.startsWith('packages/') || path.startsWith('workers/')) &&
    (path.endsWith('.ts') || path.endsWith('.tsx')) &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.test.tsx') &&
    !path.endsWith('.integration.test.ts') &&
    !path.includes('/e2e/') &&
    !path.includes('/node_modules/') &&
    !path.includes('/.next/')
  );
}

function productionSources(): readonly string[] {
  const paths: string[] = [];
  const glob = new Bun.Glob('{packages,workers}/**/*.{ts,tsx}');
  for (const path of glob.scanSync({ cwd: repositoryRoot })) {
    if (isProductionSource(path)) paths.push(path);
  }
  return paths.sort();
}

function source(path: string): string {
  return readFileSync(`${repositoryRoot}/${path}`, 'utf8');
}

interface DisallowedLowerTierContext {
  readonly surface: 'browser' | 'rest' | 'mcp' | 'mobile' | 'job' | 'webhook';
  readonly principalKind: CapabilityPrincipalKind;
  readonly source: InvocationSource;
  readonly auditHistory: unknown[];
}

const REPRESENTATIVE_SURFACE_ADAPTERS = Object.freeze({
  browser: 'packages/server/app/(admin)/event-types/api/route.ts',
  rest: 'packages/server/lib/agents/gateway.ts',
  mcp: 'packages/mcp/src/http.ts',
  mobile: 'packages/server/app/api/mobile/start/_lib/http.ts',
  job: 'packages/server/app/api/jobs/roster-sync/runtime.ts',
  webhook: 'packages/server/app/api/webhooks/ses/runtime.ts',
} as const);

describe('capability execution source boundary', () => {
  test('lower-tier imports stay on the machine and webhook allowlist', () => {
    const consumers = productionSources().filter((path) =>
      source(path).includes('invokeAuthorizedCapabilityHandler'),
    );
    expect(consumers).toEqual([...LOWER_TIER_PRODUCTION_ALLOWLIST]);
  });

  test('capability-boundary-denial fails closed without mutating audit history on every surface', async () => {
    let handlerCalls = 0;
    const registration = registerCapabilityHandler(
      'get-admin-readiness',
      async () => {
        handlerCalls += 1;
        throw new Error('A denied lower-tier handler must never run.');
      },
    );
    const authorizer: CapabilityExecutionAuthorizer<DisallowedLowerTierContext> =
      {
        authorize({ invocationPolicy, context }) {
          if (
            !invocationPolicy.principalKinds.includes(context.principalKind) ||
            !invocationPolicy.sources.includes(context.source)
          ) {
            throw new Error(`LOWER_TIER_DENIED:${context.surface}`);
          }
          context.auditHistory.push({
            action: 'get-admin-readiness',
            outcome: 'success',
          });
        },
      };
    const attempts = Object.freeze([
      { surface: 'browser', principalKind: 'agent', source: 'web' },
      { surface: 'rest', principalKind: 'system', source: 'agent-rest' },
      { surface: 'mcp', principalKind: 'system', source: 'mcp' },
      { surface: 'mobile', principalKind: 'agent', source: 'mobile' },
      { surface: 'job', principalKind: 'human', source: 'scheduled-job' },
      { surface: 'webhook', principalKind: 'human', source: 'webhook' },
    ] as const);

    for (const attempt of attempts) {
      const adapterPath = REPRESENTATIVE_SURFACE_ADAPTERS[attempt.surface];
      const adapterSource = source(adapterPath);
      if (attempt.surface === 'job' || attempt.surface === 'webhook') {
        expect(adapterSource).toContain('invokeAuthorizedCapabilityHandler');
      } else {
        expect(adapterSource).not.toContain(
          'invokeAuthorizedCapabilityHandler',
        );
      }
      const auditHistory: unknown[] = [];
      await expect(
        invokeAuthorizedCapabilityHandler(
          registration,
          {},
          {
            context: Object.freeze({ ...attempt, auditHistory }),
            humanActionResolutionContext: null,
            safetyResolver: null,
            authorizer,
          },
        ),
      ).rejects.toThrow(`LOWER_TIER_DENIED:${attempt.surface}`);
      expect(auditHistory).toEqual([]);
    }
    expect(handlerCalls).toBe(0);
  });

  test('production exports no ambiguous executeCapability function', () => {
    const ambiguous = productionSources().filter((path) =>
      /export\s+(?:async\s+)?function\s+executeCapability\b/u.test(
        source(path),
      ),
    );
    expect(ambiguous).toEqual([]);
  });

  test('the repository-audited pre-session exception stays literal-ID and exact', () => {
    const consumers = productionSources().filter((path) =>
      source(path).includes('executeRepositoryAuditedOidcCompletion'),
    );
    expect(consumers).toEqual([...REPOSITORY_AUDITED_OIDC_ALLOWLIST]);
    expect(source('packages/server/lib/capabilities/engine.ts')).toMatch(
      /RegisteredCapabilityHandler<\s*'complete-oidc-sign-in'/u,
    );
  });

  test('session mutation replays stay inside their exact engine entry points', () => {
    for (const entryPoint of [
      'executeAuditedSessionReplaySuccess',
      'executeAuditedRefreshReplayDenial',
    ]) {
      const consumers = productionSources().filter((path) =>
        source(path).includes(entryPoint),
      );
      expect(consumers).toEqual([...SESSION_REPLAY_ENGINE_ALLOWLIST]);
    }
    expect(source('packages/server/lib/capabilities/engine.ts')).toMatch(
      /type AuditedSessionReplayCapabilityId = 'refresh-session' \| 'revoke-session'/u,
    );
  });

  test('no unrestricted persisted-service mutation bridge remains', () => {
    const consumers = productionSources().filter((path) =>
      source(path).includes('executePersistedCapabilityService'),
    );
    expect(consumers).toEqual([]);
  });

  test('repository-owned idempotency stays on the exact audited allowlist', () => {
    expect(REPOSITORY_OWNED_MUTATION_CAPABILITY_IDS).toEqual([
      'refresh-session',
      'revoke-session',
      'create-event-type-draft',
      'update-event-type-draft',
      'publish-event-type-version',
      'issue-agent-api-key',
      'revoke-agent-api-key',
    ]);
  });

  test('shared library code never imports from a Next app directory', () => {
    const violations = productionSources()
      .filter((path) => path.startsWith('packages/server/lib/'))
      .filter((path) => /from\s+['"][^'"]*\/app\//u.test(source(path)));
    expect(violations).toEqual([]);
  });

  test('only the contracts primitive invokes a registered handler directly', () => {
    const consumers = productionSources().filter((path) =>
      source(path).includes('.handler('),
    );
    expect(consumers).toEqual(['packages/contracts/src/capability-catalog.ts']);
  });
});
