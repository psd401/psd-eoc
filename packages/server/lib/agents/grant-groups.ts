import type { AgentKeyGrantableCapabilityId } from '@psd-eoc/contracts';

/**
 * Risk groups the administration page uses to present agent grants. The order
 * is the display order: the most common and least consequential group first.
 */
export const AGENT_GRANT_GROUP_IDS = Object.freeze([
  'reads-and-reports',
  'drafts',
  'synthetic-event-lifecycle',
] as const);

export type AgentGrantGroupId = (typeof AGENT_GRANT_GROUP_IDS)[number];

export interface AgentGrantGroup {
  readonly id: AgentGrantGroupId;
  readonly title: string;
  readonly description: string;
}

/**
 * One accurate description per group. Each sentence states what the server
 * does with the grant, so an administrator can judge the risk without reading
 * the capability catalog or the allowlist.
 */
export const AGENT_GRANT_GROUPS: readonly AgentGrantGroup[] = Object.freeze([
  Object.freeze({
    id: 'reads-and-reports',
    title: 'Reads and reports',
    description:
      'Read events, journals, drill records, facilities, threats, templates, roster health, and audit facts within the facility scope, and create private, short-lived CSV and PDF exports. Results include free text that staff wrote. Nothing in this group changes an event, a template, or a notification.',
  }),
  Object.freeze({
    id: 'drafts',
    title: 'Drafts',
    description:
      'Create and revise unpublished template drafts, and prepare activation and lifecycle previews and intents. Nothing in this group publishes a template, starts an event, or sends a notification; publishing and activating still need an authenticated human in the app.',
  }),
  Object.freeze({
    id: 'synthetic-event-lifecycle',
    title: 'Synthetic event lifecycle',
    description:
      'Start, all-clear, and close events. The server accepts these transitions from an agent key only for drills and tests on the synthetic roster and refuses every real incident or staff-notifying transition as human-only; each one is recorded in the audit chain.',
  }),
]);

/**
 * Every allowlisted grant belongs to exactly one group. The `satisfies` clause
 * fails the typecheck when `AGENT_KEY_GRANTABLE_CAPABILITY_IDS` gains or loses
 * an ID, so a new grant cannot reach the page unclassified.
 */
export const AGENT_GRANT_GROUP_BY_CAPABILITY = Object.freeze({
  'prepare-activation': 'drafts',
  'start-event': 'synthetic-event-lifecycle',
  'all-clear-event': 'synthetic-event-lifecycle',
  'close-event': 'synthetic-event-lifecycle',
  'create-event-type-draft': 'drafts',
  'update-event-type-draft': 'drafts',
  'create-activation-preview': 'drafts',
  'create-lifecycle-consequence-preview': 'drafts',
  'get-prepared-activation': 'reads-and-reports',
  'get-stale-roster-report': 'reads-and-reports',
  'list-active-events': 'reads-and-reports',
  'get-event': 'reads-and-reports',
  'list-journal-entries': 'reads-and-reports',
  'search-journal-entries': 'reads-and-reports',
  'list-event-types': 'reads-and-reports',
  'get-event-type-version': 'reads-and-reports',
  'get-event-type-draft': 'reads-and-reports',
  'preview-event-type-rendering': 'reads-and-reports',
  'list-facilities': 'reads-and-reports',
  'list-threats': 'reads-and-reports',
  'get-facility': 'reads-and-reports',
  'list-agent-api-keys': 'reads-and-reports',
  'list-drill-records': 'reads-and-reports',
  'export-drill-records': 'reads-and-reports',
  'export-event-summary': 'reads-and-reports',
  'query-security-audit': 'reads-and-reports',
  'verify-security-audit-chain': 'reads-and-reports',
} as const satisfies Readonly<
  Record<AgentKeyGrantableCapabilityId, AgentGrantGroupId>
>);

/** One grant checkbox: the allowlisted ID and the label the page shows for it. */
export interface AgentGrantOption {
  readonly id: AgentKeyGrantableCapabilityId;
  readonly label: string;
}

/**
 * One risk group of grants with the single description the page shows for it.
 * The server decides membership; the presentation only renders what it is
 * given and still drops any human-only ID that reaches it.
 */
export interface AgentGrantGroupOptions extends AgentGrantGroup {
  readonly options: readonly AgentGrantOption[];
}

/**
 * Arranges the offered allowlisted IDs into display groups, preserving the
 * incoming order inside each group. Every group is returned, including an
 * empty one, so the presentation decides what to show.
 */
export function groupAgentGrantOptions(
  capabilityIds: readonly AgentKeyGrantableCapabilityId[],
  label: (capabilityId: AgentKeyGrantableCapabilityId) => string,
): readonly AgentGrantGroupOptions[] {
  return AGENT_GRANT_GROUPS.map((group) =>
    Object.freeze({
      ...group,
      options: Object.freeze(
        capabilityIds
          .filter(
            (capabilityId) =>
              AGENT_GRANT_GROUP_BY_CAPABILITY[capabilityId] === group.id,
          )
          .map((capabilityId) =>
            Object.freeze({ id: capabilityId, label: label(capabilityId) }),
          ),
      ),
    }),
  );
}
