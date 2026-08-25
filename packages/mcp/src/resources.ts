const REPOSITORY_ROOT = new URL('../../../', import.meta.url);

export const MCP_RESOURCES = Object.freeze([
  Object.freeze({
    uri: 'psd-eoc://docs/architecture',
    name: 'PSD EOC current architecture',
    title: 'PSD EOC Architecture and Contributing',
    description:
      'Current package ownership, capability execution, data, safety, and contributor boundaries.',
    mimeType: 'text/markdown',
  }),
  Object.freeze({
    uri: 'psd-eoc://docs/readiness',
    name: 'PSD EOC operational readiness',
    title: 'PSD EOC Operational Readiness Register',
    description:
      'Current deployment, identity, monitoring, provider, and mobile readiness evidence.',
    mimeType: 'text/markdown',
  }),
] as const);

export type McpResourceUri = (typeof MCP_RESOURCES)[number]['uri'];

const resourcePaths = Object.freeze({
  'psd-eoc://docs/architecture': new URL(
    'docs/ARCHITECTURE.md',
    REPOSITORY_ROOT,
  ),
  'psd-eoc://docs/readiness': new URL('docs/INTEGRATIONS.md', REPOSITORY_ROOT),
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
