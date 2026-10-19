import {
  AGENT_KEY_GRANTABLE_CAPABILITY_IDS,
  isAgentKeyGrantableCapabilityId,
  type AgentKeyGrantableCapabilityId,
} from '@psd-eoc/contracts';

/**
 * Capabilities with a deployed agent handler. By decision this is the agent-key
 * allowlist itself: every grantable ID has a handler, and no handler is
 * reachable by an agent without a grant. Deriving it keeps the two lists from
 * drifting, and the dispatcher's exhaustive switch makes an allowlist entry
 * without a handler a compile error.
 */
export const AGENT_DEPLOYED_CAPABILITY_IDS = AGENT_KEY_GRANTABLE_CAPABILITY_IDS;

export type AgentDeployedCapabilityId = AgentKeyGrantableCapabilityId;

/** Narrows an ID to the deployed, grantable agent vocabulary. */
export const isAgentDeployedCapabilityId = isAgentKeyGrantableCapabilityId;
