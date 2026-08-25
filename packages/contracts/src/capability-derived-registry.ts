import { z } from 'zod';

import type { CapabilitySafetyEffect } from './capability';

/** Runtime views derived once from the canonical capability catalog. */
export interface InstalledCapabilityViews {
  readonly mutationSafetyManifest: Readonly<
    Record<string, CapabilitySafetyEffect>
  >;
  readonly queryManifest: Readonly<Record<string, 'none'>>;
  readonly agentGrantableCapabilityIds: readonly string[];
}

let installedViews: InstalledCapabilityViews | null = null;
let installedAgentGrantSchema: z.ZodType<string> | null = null;

/** Lazy exact enum used to break the catalog/agent-key schema cycle safely. */
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
