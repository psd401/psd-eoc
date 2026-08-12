import {
  ApiErrorSchema,
  CAPABILITY_CATALOG,
  HUMAN_ONLY_ACTION_IDS,
  McpDraftMessageRevisionInputSchema,
  McpDraftMessageRevisionResultSchema,
  type AgentGrantableCapabilityId,
  type CapabilityOutput,
  type McpDraftMessageRevisionInput,
  type McpDraftMessageRevisionResult,
} from '@psd-eoc/contracts';

import {
  MCP_TOOL_CAPABILITY_IDS,
  isMcpToolCapabilityId,
  type McpToolCapabilityId,
} from './manifest';

const DEFAULT_AGENT_API_BASE_URL =
  'http://127.0.0.1:3000/api/agent/v1' as const;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const AGENT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,512}$/u;
const humanOnlyActionIds = new Set<string>(HUMAN_ONLY_ACTION_IDS);
const MCP_ADAPTER_CAPABILITY_IDS = Object.freeze([
  ...MCP_TOOL_CAPABILITY_IDS,
  'create-event-type-draft',
  'update-event-type-draft',
] as const satisfies readonly AgentGrantableCapabilityId[]);
type McpAdapterCapabilityId = (typeof MCP_ADAPTER_CAPABILITY_IDS)[number];
const mcpAdapterCapabilityIds = new Set<string>(MCP_ADAPTER_CAPABILITY_IDS);

export interface AgentApiConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface AgentApiClientDependencies {
  readonly fetch?: typeof fetch;
  readonly createIdempotencyKey?: () => string;
}

export class AgentApiConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentApiConfigurationError';
  }
}

export class AgentApiInputError extends Error {
  public constructor(public readonly details: readonly string[]) {
    super(
      'The MCP tool arguments do not match the canonical PSD EOC contract.',
    );
    this.name = 'AgentApiInputError';
  }
}

export class AgentApiCallError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'AgentApiCallError';
  }
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentApiConfigurationError(
      'PSD_EOC_AGENT_API_BASE_URL must be an absolute HTTP(S) URL.',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AgentApiConfigurationError(
      'PSD_EOC_AGENT_API_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.',
    );
  }
  const isLoopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === 'localhost';
  if (url.protocol === 'http:' && !isLoopback) {
    throw new AgentApiConfigurationError(
      'PSD_EOC_AGENT_API_BASE_URL must use HTTPS unless it targets loopback.',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

export function readAgentApiConfig(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): AgentApiConfig {
  const apiKey = environment.PSD_EOC_AGENT_API_KEY ?? '';
  if (!AGENT_KEY_PATTERN.test(apiKey)) {
    throw new AgentApiConfigurationError(
      'PSD_EOC_AGENT_API_KEY is required and must use the agent bearer credential format.',
    );
  }
  return Object.freeze({
    baseUrl: normalizedBaseUrl(
      environment.PSD_EOC_AGENT_API_BASE_URL?.trim() ||
        DEFAULT_AGENT_API_BASE_URL,
    ),
    apiKey,
  });
}

function inputIssueDetails(error: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): readonly string[] {
  return Object.freeze(
    error.issues.slice(0, 8).map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    }),
  );
}

function safeApiFailure(status: number, body: unknown): AgentApiCallError {
  const parsed = ApiErrorSchema.safeParse(body);
  const requestId = parsed.success ? parsed.data.requestId : null;
  const retryable = parsed.success ? parsed.data.retryable : status >= 500;
  if (status === 401) {
    return new AgentApiCallError(
      'The configured PSD EOC agent API key was rejected.',
      'UNAUTHENTICATED',
      false,
      requestId,
    );
  }
  if (status === 403) {
    return new AgentApiCallError(
      'The configured agent key does not permit this tool or requested facility.',
      'FORBIDDEN',
      false,
      requestId,
    );
  }
  if (status === 404) {
    return new AgentApiCallError(
      'The requested record is unavailable within the configured agent scope.',
      'NOT_FOUND',
      false,
      requestId,
    );
  }
  if (status === 503) {
    if (
      parsed.success &&
      parsed.data.code === 'INTERNAL_ERROR' &&
      !parsed.data.retryable
    ) {
      return new AgentApiCallError(
        'The requested PSD EOC capability is not available in this deployment.',
        'UNAVAILABLE',
        false,
        requestId,
      );
    }
    return new AgentApiCallError(
      'The requested PSD EOC capability is temporarily unavailable.',
      parsed.success ? parsed.data.code : 'UPSTREAM_FAILURE',
      retryable,
      requestId,
    );
  }
  if (parsed.success && status < 500) {
    return new AgentApiCallError(
      parsed.data.message,
      parsed.data.code,
      retryable,
      requestId,
    );
  }
  return new AgentApiCallError(
    'The PSD EOC agent API could not complete the request; its outcome is unknown.',
    'UPSTREAM_FAILURE',
    retryable,
    requestId,
  );
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new AgentApiCallError(
      'The PSD EOC agent API returned an oversized response.',
      'UPSTREAM_RESPONSE_INVALID',
      false,
      null,
    );
  }
  if (response.body === null) {
    throw new AgentApiCallError(
      'The PSD EOC agent API returned an invalid response.',
      'UPSTREAM_RESPONSE_INVALID',
      false,
      null,
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new AgentApiCallError(
        'The PSD EOC agent API returned an oversized response.',
        'UPSTREAM_RESPONSE_INVALID',
        false,
        null,
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentApiCallError(
      'The PSD EOC agent API returned an invalid response.',
      'UPSTREAM_RESPONSE_INVALID',
      false,
      null,
    );
  }
}

type DraftableTemplateCatalog =
  CapabilityOutput<'get-event-type-version'>['templates'];

function reviseMessageWording(
  templates: DraftableTemplateCatalog,
  input: McpDraftMessageRevisionInput,
): DraftableTemplateCatalog {
  const purpose =
    input.phase === 'resolution' ? ('all-clear' as const) : input.phase;
  const currentSet = templates[purpose];
  const channel = input.wording.channel;
  return {
    ...templates,
    [purpose]: {
      ...currentSet,
      [channel]: {
        ...currentSet[channel],
        ...input.wording,
      },
    },
  } as DraftableTemplateCatalog;
}

export class AgentApiClient {
  readonly #fetch: typeof fetch;
  readonly #createIdempotencyKey: () => string;
  readonly #config: AgentApiConfig;

  public constructor(
    config: AgentApiConfig,
    dependencies: AgentApiClientDependencies = {},
  ) {
    if (!AGENT_KEY_PATTERN.test(config.apiKey)) {
      throw new AgentApiConfigurationError(
        'The configured agent API key does not use the bearer credential format.',
      );
    }
    this.#config = Object.freeze({
      baseUrl: normalizedBaseUrl(config.baseUrl),
      apiKey: config.apiKey,
    });
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#createIdempotencyKey =
      dependencies.createIdempotencyKey ?? (() => crypto.randomUUID());
  }

  public async call(
    capabilityId: McpToolCapabilityId,
    input: unknown,
  ): Promise<unknown> {
    // Check the local closed allowlist before constructing a URL or invoking fetch.
    if (
      humanOnlyActionIds.has(capabilityId) ||
      !isMcpToolCapabilityId(capabilityId) ||
      !MCP_TOOL_CAPABILITY_IDS.includes(capabilityId)
    ) {
      throw new AgentApiInputError(['The requested MCP tool is not exposed.']);
    }
    return this.#callCapability(capabilityId, input);
  }

  async #callCapability<Id extends McpAdapterCapabilityId>(
    capabilityId: Id,
    input: unknown,
  ): Promise<CapabilityOutput<Id>> {
    if (
      humanOnlyActionIds.has(capabilityId) ||
      !mcpAdapterCapabilityIds.has(capabilityId)
    ) {
      throw new AgentApiInputError(['The requested MCP tool is not exposed.']);
    }
    const definition = CAPABILITY_CATALOG[capabilityId];
    const parsedInput = definition.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new AgentApiInputError(inputIssueDetails(parsedInput.error));
    }

    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${this.#config.apiKey}`,
      'Content-Type': 'application/json',
    });
    if (definition.operation === 'mutation') {
      headers.set('Idempotency-Key', this.#createIdempotencyKey());
    }

    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#config.baseUrl}/capabilities/${encodeURIComponent(capabilityId)}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(parsedInput.data),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      throw new AgentApiCallError(
        'The PSD EOC agent API could not be reached; the request outcome is unknown.',
        'UPSTREAM_UNREACHABLE',
        true,
        null,
      );
    }
    const body = await boundedJson(response);
    if (!response.ok) throw safeApiFailure(response.status, body);

    const parsedOutput = definition.outputSchema.safeParse(body);
    if (!parsedOutput.success) {
      throw new AgentApiCallError(
        'The PSD EOC agent API returned data that failed canonical contract validation.',
        'UPSTREAM_RESPONSE_INVALID',
        false,
        null,
      );
    }
    return parsedOutput.data as CapabilityOutput<Id>;
  }

  public async draftMessageTemplateRevision(
    value: unknown,
  ): Promise<McpDraftMessageRevisionResult> {
    const parsed = McpDraftMessageRevisionInputSchema.safeParse(value);
    if (!parsed.success) {
      throw new AgentApiInputError(inputIssueDetails(parsed.error));
    }
    const input = parsed.data;
    const draft =
      input.source.kind === 'published-version'
        ? await this.#createDraftFromPublishedVersion(input, input.source)
        : await this.#updateExistingDraft(input, input.source);
    return McpDraftMessageRevisionResultSchema.parse({
      draftId: draft.id,
      draftRevision: draft.draftRevision,
      eventTypeId: draft.eventTypeId,
      baseVersionId: draft.baseVersionId,
      templateMode: draft.templateMode,
      changedPhase: input.phase,
      changedChannel: input.wording.channel,
      createdAt: draft.createdAt,
    });
  }

  async #createDraftFromPublishedVersion(
    input: McpDraftMessageRevisionInput,
    source: Extract<
      McpDraftMessageRevisionInput['source'],
      { readonly kind: 'published-version' }
    >,
  ): Promise<CapabilityOutput<'create-event-type-draft'>> {
    const version = await this.#callCapability('get-event-type-version', {
      eventTypeVersionId: source.baseVersionId,
    });
    return this.#callCapability('create-event-type-draft', {
      target: {
        kind: 'existing-event-type',
        eventTypeId: version.eventTypeId,
        baseVersionId: version.id,
      },
      name: version.name,
      description: version.description,
      enabled: version.enabled,
      templates: reviseMessageWording(version.templates, input),
    });
  }

  async #updateExistingDraft(
    input: McpDraftMessageRevisionInput,
    source: Extract<
      McpDraftMessageRevisionInput['source'],
      { readonly kind: 'existing-draft' }
    >,
  ): Promise<CapabilityOutput<'update-event-type-draft'>> {
    const current = await this.#callCapability('get-event-type-draft', {
      draftId: source.draftId,
    });
    if (current.draftRevision !== source.expectedDraftRevision) {
      throw new AgentApiCallError(
        'The event-type draft changed; read its current revision before retrying.',
        'CONFLICT',
        false,
        null,
      );
    }
    return this.#callCapability('update-event-type-draft', {
      draftId: current.id,
      expectedDraftRevision: source.expectedDraftRevision,
      name: current.name,
      description: current.description,
      enabled: current.enabled,
      templates: reviseMessageWording(current.templates, input),
    });
  }
}

/** Test-only generic entry proves rejected aliases never reach fetch. */
export async function callMcpToolByUnknownName(
  client: AgentApiClient,
  capabilityId: unknown,
  input: unknown,
): Promise<unknown> {
  if (!isMcpToolCapabilityId(capabilityId)) {
    throw new AgentApiInputError(['The requested MCP tool is not exposed.']);
  }
  return client.call(capabilityId, input);
}

// Compile-time proof that the HTTP adapter cannot widen to arbitrary grants.
const _toolIdsAreAgentCapabilities: readonly AgentGrantableCapabilityId[] =
  MCP_TOOL_CAPABILITY_IDS;
void _toolIdsAreAgentCapabilities;
