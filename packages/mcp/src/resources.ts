const REPOSITORY_ROOT = new URL('../../../', import.meta.url);

export const MCP_RESOURCES = Object.freeze([
  Object.freeze({
    uri: 'psd-eoc://docs/plan',
    name: 'PSD EOC implementation plan',
    title: 'PSD EOC Implementation Plan',
    description:
      'Binding architecture, scope, delivery phases, and safety invariants for PSD EOC.',
    mimeType: 'text/markdown',
  }),
  Object.freeze({
    uri: 'psd-eoc://docs/decision-log',
    name: 'PSD EOC discovery decision log',
    title: 'PSD EOC Discovery Decision Log',
    description:
      'Binding confirmed product decisions and explicitly recorded assumptions and open questions.',
    mimeType: 'text/markdown',
  }),
] as const);

export type McpResourceUri = (typeof MCP_RESOURCES)[number]['uri'];

const resourcePaths = Object.freeze({
  'psd-eoc://docs/plan': new URL('docs/PLAN.md', REPOSITORY_ROOT),
  'psd-eoc://docs/decision-log': new URL(
    'docs/discovery/DECISION_LOG.md',
    REPOSITORY_ROOT,
  ),
} as const satisfies Record<McpResourceUri, URL>);

export function isMcpResourceUri(value: unknown): value is McpResourceUri {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(resourcePaths, value)
  );
}

export async function readMcpResource(uri: McpResourceUri) {
  const text = await Bun.file(resourcePaths[uri]).text();
  return Object.freeze({
    uri,
    mimeType: 'text/markdown' as const,
    text,
  });
}
