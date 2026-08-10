import type { AgentGrantableCapabilityId } from '@psd-eoc/contracts';

/** Canonical implementations present in this deployment, not future catalog promises. */
export const AGENT_DEPLOYED_CAPABILITY_IDS = Object.freeze([
  'start-event',
  'join-event',
  'all-clear-event',
  'reactivate-event',
  'close-event',
  'reopen-as-correction',
  'list-active-events',
  'get-event',
  'prepare-activation',
  'get-prepared-activation',
  'list-event-types',
  'get-event-type-version',
  'get-event-type-draft',
  'preview-event-type-rendering',
  'query-security-audit',
  'verify-security-audit-chain',
] as const satisfies readonly AgentGrantableCapabilityId[]);

export type AgentDeployedCapabilityId =
  (typeof AGENT_DEPLOYED_CAPABILITY_IDS)[number];

const deployedCapabilityIds = new Set<string>(AGENT_DEPLOYED_CAPABILITY_IDS);

/** Narrows contract catalog entries to handlers deployed by issue #24. */
export function isAgentDeployedCapabilityId(
  value: unknown,
): value is AgentDeployedCapabilityId {
  return typeof value === 'string' && deployedCapabilityIds.has(value);
}
