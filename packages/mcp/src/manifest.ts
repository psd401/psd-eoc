import {
  CAPABILITY_CATALOG,
  HUMAN_ONLY_ACTION_IDS,
  McpDraftMessageRevisionInputSchema,
  type AgentGrantableCapabilityId,
} from '@psd-eoc/contracts';
import { z } from 'zod';

export const MCP_TOOL_CAPABILITY_IDS = Object.freeze([
  'list-active-events',
  'get-event',
  'search-journal-entries',
  'list-drill-records',
  'export-drill-records',
  'export-event-summary',
  'list-delivery-test-reports',
  'get-stale-roster-report',
  'list-facilities',
  'get-facility',
  'list-threats',
  'list-event-types',
  'get-event-type-version',
  'get-event-type-draft',
  'create-activation-preview',
  'prepare-activation',
] as const satisfies readonly AgentGrantableCapabilityId[]);

export type McpToolCapabilityId = (typeof MCP_TOOL_CAPABILITY_IDS)[number];

export const MCP_FACADE_TOOL_NAMES = Object.freeze([
  'draft-message-template-revision',
] as const);

export type McpFacadeToolName = (typeof MCP_FACADE_TOOL_NAMES)[number];
export type McpToolName = McpToolCapabilityId | McpFacadeToolName;

export interface McpToolDefinition {
  readonly name: McpToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: Readonly<{
    title: string;
    readOnlyHint: boolean;
    destructiveHint: false;
    idempotentHint: boolean;
    openWorldHint: false;
  }>;
}

const descriptions = Object.freeze({
  'list-active-events': Object.freeze({
    title: 'List active events',
    description:
      'List active PSD EOC events within the configured agent key facility scope. This is read-only and cannot change an event.',
  }),
  'get-event': Object.freeze({
    title: 'Get event',
    description:
      'Read one PSD EOC event when it is within the configured agent key facility scope. This is read-only.',
  }),
  'search-journal-entries': Object.freeze({
    title: 'Search event journals',
    description:
      'Search append-only event journal projections within the configured facility scope. Corrections and redactions remain separate provenance-bearing entries.',
  }),
  'list-drill-records': Object.freeze({
    title: 'List drill records',
    description:
      'List retained drill and test records by site and time range, including date/time and event type. The result is records evidence, not a legal or policy compliance determination.',
  }),
  'export-drill-records': Object.freeze({
    title: 'Export drill records',
    description:
      'Create a private, short-lived CSV export of authorized retained drill and test records by site and time range. The export is records evidence, not a legal or district-policy compliance determination.',
  }),
  'export-event-summary': Object.freeze({
    title: 'Export event summary',
    description:
      'Create a private, short-lived PDF summary of one authorized event, preserving append-only journal provenance, photo checksums, and exact delivery truth states without recipient contact data. The export is records evidence, not a legal or district-policy compliance determination.',
  }),
  'list-delivery-test-reports': Object.freeze({
    title: 'List monthly delivery-test reports',
    description:
      'List authorized append-only monthly live delivery-test report snapshots. Results are destination-free and preserve provider acceptance, delivery, failure, and unknown as distinct evidence states. This is read-only and cannot start a test, send a notification, or change a report.',
  }),
  'get-stale-roster-report': Object.freeze({
    title: 'Read roster staleness report',
    description:
      'Read bounded staff or synthetic roster health facts for authorized facilities. This never returns student data or recipient contact details.',
  }),
  'list-facilities': Object.freeze({
    title: 'List facilities',
    description:
      'List site identities and names visible to the configured agent key so facility IDs in event and drill records can be resolved safely.',
  }),
  'get-facility': Object.freeze({
    title: 'Get facility',
    description:
      'Read one authorized site identity and name. Records outside the configured agent key facility scope remain unavailable.',
  }),
  'list-threats': Object.freeze({
    title: 'List threats',
    description:
      'List the district-declared threats an operator chooses from before the response, in declared order, so a threat ID can be supplied to an activation preview. This is read-only.',
  }),
  'list-event-types': Object.freeze({
    title: 'List event types',
    description:
      'List authorized event-type identities and their latest immutable versions so an agent can select a base version for a draft. This is read-only.',
  }),
  'get-event-type-version': Object.freeze({
    title: 'Get event-type version',
    description:
      'Read one exact immutable event-type version, including its real-or-drill mode and channel templates, for use as the base of an unpublished revision.',
  }),
  'get-event-type-draft': Object.freeze({
    title: 'Read event-type template draft',
    description:
      'Read one unpublished event-type and channel-template draft within the configured agent scope.',
  }),
  'create-activation-preview': Object.freeze({
    title: 'Create activation consequence preview',
    description:
      'Create a short-lived consequence preview for a human-operated activation flow. This only prepares information; it never activates an event or sends a notification.',
  }),
  'prepare-activation': Object.freeze({
    title: 'Prepare activation for human confirmation',
    description:
      'Prepare a one-tap activation intent from an existing, unexpired activation preview. This never activates or sends; an authenticated human must review and confirm in the PSD EOC app.',
  }),
} as const satisfies Record<
  McpToolCapabilityId,
  Readonly<{ title: string; description: string }>
>);

const humanOnlyActionIds = new Set<string>(HUMAN_ONLY_ACTION_IDS);
const queryToolsWithRetainedSideEffects = new Set<McpToolCapabilityId>([
  'create-activation-preview',
  'export-drill-records',
  'export-event-summary',
]);

function containsHumanOnlyActionId(value: unknown): boolean {
  if (typeof value === 'string') return humanOnlyActionIds.has(value);
  if (Array.isArray(value)) return value.some(containsHumanOnlyActionId);
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.entries(value).some(
      ([key, child]) =>
        humanOnlyActionIds.has(key) || containsHumanOnlyActionId(child),
    )
  );
}

function contractInputJsonSchema(
  capabilityId: McpToolCapabilityId,
): Readonly<Record<string, unknown>> {
  const jsonSchema = z.toJSONSchema(
    CAPABILITY_CATALOG[capabilityId].inputSchema,
  );
  if (
    typeof jsonSchema !== 'object' ||
    jsonSchema === null ||
    Array.isArray(jsonSchema) ||
    containsHumanOnlyActionId(jsonSchema)
  ) {
    throw new TypeError(
      'An MCP tool input schema must be an object without protected action IDs.',
    );
  }
  return Object.freeze(jsonSchema as Record<string, unknown>);
}

const directMcpTools: readonly McpToolDefinition[] = Object.freeze(
  MCP_TOOL_CAPABILITY_IDS.map((capabilityId): McpToolDefinition => {
    if (humanOnlyActionIds.has(capabilityId)) {
      throw new TypeError(
        'A protected action cannot be exposed as an MCP tool.',
      );
    }
    const operation = CAPABILITY_CATALOG[capabilityId].operation;
    const copy = descriptions[capabilityId];
    return Object.freeze({
      name: capabilityId,
      title: copy.title,
      description: copy.description,
      inputSchema: contractInputJsonSchema(capabilityId),
      annotations: Object.freeze({
        title: copy.title,
        readOnlyHint:
          operation === 'query' &&
          !queryToolsWithRetainedSideEffects.has(capabilityId),
        destructiveHint: false as const,
        idempotentHint:
          operation === 'query' &&
          !queryToolsWithRetainedSideEffects.has(capabilityId),
        openWorldHint: false as const,
      }),
    });
  }),
);

const draftMessageTemplateRevisionTool: McpToolDefinition = Object.freeze({
  name: 'draft-message-template-revision',
  title: 'Draft a message-template revision',
  description:
    'Create or revise one unpublished channel-message draft from an exact published version or draft revision. The safe resolution phase names stored wording only. This never publishes, activates an event, changes event state, or sends a notification.',
  inputSchema: (() => {
    const schema = z.toJSONSchema(McpDraftMessageRevisionInputSchema);
    if (containsHumanOnlyActionId(schema)) {
      throw new TypeError(
        'The MCP draft facade schema cannot contain a protected action ID.',
      );
    }
    return Object.freeze(schema);
  })(),
  annotations: Object.freeze({
    title: 'Draft a message-template revision',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }),
});

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  ...directMcpTools,
  draftMessageTemplateRevisionTool,
]);

const mcpToolIds = new Set<string>(MCP_TOOL_CAPABILITY_IDS);
const mcpToolNames = new Set<string>([
  ...MCP_TOOL_CAPABILITY_IDS,
  ...MCP_FACADE_TOOL_NAMES,
]);

export function isMcpToolCapabilityId(
  value: unknown,
): value is McpToolCapabilityId {
  return typeof value === 'string' && mcpToolIds.has(value);
}

export function isMcpToolName(value: unknown): value is McpToolName {
  return typeof value === 'string' && mcpToolNames.has(value);
}

/** Load-bearing assertion for every serialized agent-facing tool manifest. */
export function assertSafeMcpManifest(value: unknown): void {
  if (containsHumanOnlyActionId(value)) {
    throw new TypeError(
      'A protected action ID cannot appear in the MCP agent manifest.',
    );
  }
}

assertSafeMcpManifest(MCP_TOOLS);
