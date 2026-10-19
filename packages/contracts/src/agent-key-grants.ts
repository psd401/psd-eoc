import { z } from 'zod';

import type { AgentGrantableCapabilityId } from './capability-catalog';

/**
 * Owns the exact set of capability IDs a district administrator may place on
 * an agent API key.
 *
 * This is a written allowlist, not a derivation. The canonical catalog's
 * invocation policy (`AGENT_GRANTABLE_CAPABILITY_IDS`) says which capabilities
 * can execute under an agent principal at all; it is also the persisted
 * PostgreSQL grant vocabulary, so it can only grow. This list says which of
 * those a key may actually be granted. Issuance, authentication, authorization,
 * the REST gateway, the admin issue form, and the OpenAPI manifest all read it,
 * and the dispatcher's exhaustive switch proves every ID here has a handler.
 *
 * Deliberately absent, although the catalog admits an agent principal:
 * publishing an event-type version (an agent may draft wording, a human
 * publishes it), writing to a live journal, joining or reactivating an event,
 * reopening a closed event, and every configuration write.
 *
 * Lifecycle capabilities stay because the capability engine refuses every
 * staff-roster target to a non-human actor; an agent key can only run them
 * against a synthetic roster.
 */
export const AGENT_KEY_GRANTABLE_CAPABILITY_IDS = Object.freeze([
  'prepare-activation',
  'start-event',
  'all-clear-event',
  'close-event',
  'create-event-type-draft',
  'update-event-type-draft',
  'create-activation-preview',
  'create-lifecycle-consequence-preview',
  'get-prepared-activation',
  'get-stale-roster-report',
  'list-active-events',
  'get-event',
  'list-journal-entries',
  'search-journal-entries',
  'list-event-types',
  'get-event-type-version',
  'get-event-type-draft',
  'preview-event-type-rendering',
  'list-facilities',
  'list-threats',
  'get-facility',
  'list-agent-api-keys',
  'list-drill-records',
  'export-drill-records',
  'export-event-summary',
  'query-security-audit',
  'verify-security-audit-chain',
] as const satisfies readonly AgentGrantableCapabilityId[]);

/** Capability ID an agent API key may be granted, inferred from the allowlist. */
export type AgentKeyGrantableCapabilityId =
  (typeof AGENT_KEY_GRANTABLE_CAPABILITY_IDS)[number];

/** Closed enum of the allowlist; the only grant vocabulary issuance accepts. */
export const AgentKeyGrantableCapabilityIdSchema = z.enum(
  AGENT_KEY_GRANTABLE_CAPABILITY_IDS,
);

const agentKeyGrantableCapabilityIdSet = new Set<string>(
  AGENT_KEY_GRANTABLE_CAPABILITY_IDS,
);

/** Returns true only for IDs on the agent-key allowlist. */
export function isAgentKeyGrantableCapabilityId(
  value: unknown,
): value is AgentKeyGrantableCapabilityId {
  return (
    typeof value === 'string' && agentKeyGrantableCapabilityIdSet.has(value)
  );
}
