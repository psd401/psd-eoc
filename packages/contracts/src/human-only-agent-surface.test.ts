import { describe, expect, test } from 'bun:test';

import { AGENT_GRANTABLE_CAPABILITY_IDS } from './agent-api';
import { CAPABILITY_INVOCATION_POLICY } from './capability-catalog';
import { HUMAN_ONLY_ACTION_IDS } from './human-only';

/**
 * Every agent operation/tool manifest must be registered here. Invocation
 * policy is included so a capability cannot evade the key-grant guard while
 * remaining callable from agent REST or MCP.
 */
const agentTransportCapabilities = Object.entries(CAPABILITY_INVOCATION_POLICY)
  .filter(
    ([, policy]) =>
      policy.principalKinds.includes('agent') ||
      policy.sources.includes('agent-rest') ||
      policy.sources.includes('mcp'),
  )
  .map(([capabilityId]) => capabilityId);

const AGENT_SURFACE_MANIFESTS = {
  'contracts agent capability grants': AGENT_GRANTABLE_CAPABILITY_IDS,
  'canonical agent REST and MCP invocation policy': agentTransportCapabilities,
} as const satisfies Readonly<Record<string, readonly string[]>>;

describe('human-only agent-surface manifest guard', () => {
  test('does not expose a canonical human-only action ID', () => {
    const exposures = Object.entries(AGENT_SURFACE_MANIFESTS).flatMap(
      ([manifestName, agentIds]) => {
        const exposedAgentIds: ReadonlySet<string> = new Set(agentIds);

        return HUMAN_ONLY_ACTION_IDS.filter((actionId) =>
          exposedAgentIds.has(actionId),
        ).map((actionId) => `${manifestName}: ${actionId}`);
      },
    );

    expect(exposures).toEqual([]);
  });

  test('exposes only the destination-free delivery-test report query', () => {
    expect(AGENT_GRANTABLE_CAPABILITY_IDS).toContain(
      'list-delivery-test-reports',
    );
    const agentSurfaceIds: ReadonlySet<string> = new Set(
      AGENT_GRANTABLE_CAPABILITY_IDS,
    );
    for (const protectedWorkflowId of [
      'record-delivery-test-canary-eligibility',
      'create-delivery-test-target-set-version',
      'create-delivery-test-preview',
      'finalize-delivery-test-report',
    ]) {
      expect(agentSurfaceIds.has(protectedWorkflowId)).toBe(false);
    }
  });

  test('keeps district fanout control human-only and agent-free', () => {
    for (const capabilityId of [
      'get-fanout-status',
      'get-fanout-control',
      'set-fanout-control',
    ] as const) {
      expect(AGENT_GRANTABLE_CAPABILITY_IDS).not.toContain(capabilityId);
      expect(agentTransportCapabilities).not.toContain(capabilityId);
      expect(CAPABILITY_INVOCATION_POLICY[capabilityId]).toEqual({
        principalKinds: ['human'],
        sources:
          capabilityId === 'get-fanout-status' ? ['web', 'mobile'] : ['web'],
        agentGrantable: false,
      });
    }
    expect(
      CAPABILITY_INVOCATION_POLICY['authorize-notification-fanout'],
    ).toEqual({
      principalKinds: ['system'],
      sources: ['worker'],
      agentGrantable: false,
    });
    expect(AGENT_GRANTABLE_CAPABILITY_IDS).not.toContain(
      'authorize-notification-fanout',
    );
    expect(agentTransportCapabilities).not.toContain(
      'authorize-notification-fanout',
    );
  });
});
