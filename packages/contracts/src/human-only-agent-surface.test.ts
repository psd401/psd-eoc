import { describe, expect, test } from 'bun:test';

import { AGENT_GRANTABLE_CAPABILITY_IDS } from './agent-api';
import { HUMAN_ONLY_ACTION_IDS } from './human-only';

/**
 * Every agent operation/tool manifest must be registered here. P4.1 extends
 * this guard when the REST and MCP surface manifests are introduced.
 */
const AGENT_SURFACE_MANIFESTS = {
  'contracts agent capability grants': AGENT_GRANTABLE_CAPABILITY_IDS,
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
});
