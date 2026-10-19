import { z } from 'zod';

import { AGENT_KEY_GRANTABLE_CAPABILITY_IDS } from './agent-key-grants';
import type { CapabilitySafetyEffect } from './capability';

/** Runtime views derived once from the canonical capability catalog. */
export interface InstalledCapabilityViews {
  readonly mutationSafetyManifest: Readonly<
    Record<string, CapabilitySafetyEffect>
  >;
  readonly queryManifest: Readonly<Record<string, 'none'>>;
  /**
   * Every catalog ID whose invocation policy admits an agent principal. This
   * is the retained grant vocabulary (the persisted PostgreSQL enum), not the
   * issuance allowlist; `AGENT_KEY_GRANTABLE_CAPABILITY_IDS` authorizes keys
   * and must be a subset of it, which `installCapabilityViews` enforces.
   */
  readonly agentGrantableCapabilityIds: readonly string[];
}

let installedViews: InstalledCapabilityViews | null = null;
let installedAgentGrantSchema: z.ZodType<string> | null = null;

/**
 * Lazy exact enum of the retained grant vocabulary, used to break the
 * catalog/agent-key schema cycle safely. Persisted key rows parse through it;
 * issuance does not.
 */
export const InstalledAgentGrantableCapabilityIdSchema: z.ZodType<string> =
  z.lazy(() => {
    if (installedAgentGrantSchema === null) {
      throw new Error('Canonical capability views are not initialized.');
    }
    return installedAgentGrantSchema;
  });

/** Installs immutable closed-ID views derived from the canonical catalog. */
export function installCapabilityViews(views: InstalledCapabilityViews): void {
  if (installedViews !== null) {
    if (JSON.stringify(installedViews) !== JSON.stringify(views)) {
      throw new Error('Canonical capability views cannot be replaced.');
    }
    return;
  }
  if (views.agentGrantableCapabilityIds.length === 0) {
    throw new Error('The canonical agent-grant view must be non-empty.');
  }
  const derived = new Set(views.agentGrantableCapabilityIds);
  for (const capabilityId of AGENT_KEY_GRANTABLE_CAPABILITY_IDS) {
    if (!derived.has(capabilityId)) {
      throw new Error(
        `Agent-key allowlist entry ${capabilityId} is not an agent capability in the canonical catalog.`,
      );
    }
  }
  const agentGrantSchema = z.enum(
    views.agentGrantableCapabilityIds as [string, ...string[]],
  );
  installedViews = Object.freeze({
    mutationSafetyManifest: views.mutationSafetyManifest,
    queryManifest: views.queryManifest,
    agentGrantableCapabilityIds: views.agentGrantableCapabilityIds,
  });
  installedAgentGrantSchema = agentGrantSchema;
}

export function isInstalledMutationCapabilityId(value: string): boolean {
  return (
    installedViews !== null &&
    Object.hasOwn(installedViews.mutationSafetyManifest, value)
  );
}

export function isInstalledQueryCapabilityId(value: string): boolean {
  return (
    installedViews !== null &&
    Object.hasOwn(installedViews.queryManifest, value)
  );
}

export function isInstalledAgentGrantableCapabilityId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    installedViews !== null &&
    installedViews.agentGrantableCapabilityIds.includes(value)
  );
}
