import type { AgentCapabilityGrant } from '@psd-eoc/contracts';

import type { AgentDeployedCapabilityId } from './availability';

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
 * the capability catalog.
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
      'Create and revise unpublished template drafts, publish a template version so later activations render its wording, and prepare activation previews and intents. Nothing in this group starts an event or sends a notification; activating a prepared intent still needs an authenticated human in the app.',
  }),
  Object.freeze({
    id: 'synthetic-event-lifecycle',
    title: 'Synthetic event lifecycle',
    description:
      'Start, join, all-clear, reactivate, close, and reopen events, and append, correct, or redact journal entries. The server accepts lifecycle transitions from an agent key only for drills and tests on the synthetic roster and refuses every real incident or staff-notifying transition as human-only. Journal writes are append-only, attributed to the agent, and reach any event within the facility scope.',
  }),
]);

/**
 * Every deployed, grantable capability belongs to exactly one group. The
 * `satisfies` clause fails the typecheck when the deployed list gains or
 * loses an ID, so a new grant cannot appear on the page unclassified.
 */
export const AGENT_GRANT_GROUP_BY_CAPABILITY = Object.freeze({
  'start-event': 'synthetic-event-lifecycle',
  'join-event': 'synthetic-event-lifecycle',
  'all-clear-event': 'synthetic-event-lifecycle',
  'reactivate-event': 'synthetic-event-lifecycle',
  'close-event': 'synthetic-event-lifecycle',
  'reopen-as-correction': 'synthetic-event-lifecycle',
  'append-journal-entry': 'synthetic-event-lifecycle',
  'correct-journal-entry': 'synthetic-event-lifecycle',
  'redact-journal-entry': 'synthetic-event-lifecycle',
  'list-journal-entries': 'reads-and-reports',
  'search-journal-entries': 'reads-and-reports',
  'create-lifecycle-consequence-preview': 'drafts',
  'get-facility': 'reads-and-reports',
  'list-active-events': 'reads-and-reports',
  'get-event': 'reads-and-reports',
  'create-activation-preview': 'drafts',
  'prepare-activation': 'drafts',
  'get-prepared-activation': 'reads-and-reports',
  'get-stale-roster-report': 'reads-and-reports',
  'list-facilities': 'reads-and-reports',
  'list-threats': 'reads-and-reports',
  'list-agent-api-keys': 'reads-and-reports',
  'create-event-type-draft': 'drafts',
  'update-event-type-draft': 'drafts',
  'publish-event-type-version': 'drafts',
  'list-event-types': 'reads-and-reports',
  'get-event-type-version': 'reads-and-reports',
  'get-event-type-draft': 'reads-and-reports',
  'preview-event-type-rendering': 'reads-and-reports',
  'list-drill-records': 'reads-and-reports',
  'export-drill-records': 'reads-and-reports',
  'export-event-summary': 'reads-and-reports',
  'query-security-audit': 'reads-and-reports',
  'verify-security-audit-chain': 'reads-and-reports',
} as const satisfies Readonly<
  Record<AgentDeployedCapabilityId, AgentGrantGroupId>
>);

export interface AgentGrantOption {
  readonly id: AgentCapabilityGrant;
  readonly label: string;
}

export interface AgentGrantGroupOptions extends AgentGrantGroup {
  readonly options: readonly AgentGrantOption[];
}

/**
 * Arranges the offered capability IDs into display groups, preserving the
 * incoming order inside each group. Every group is returned, including an
 * empty one, so the presentation decides what to show.
 */
export function groupAgentGrantOptions(
  capabilityIds: readonly AgentDeployedCapabilityId[],
  label: (capabilityId: AgentDeployedCapabilityId) => string,
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
