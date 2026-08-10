import type {
  Actor,
  AgentApiKey,
  AgentApiKeyRevocation,
  AgentApiKeySummary,
} from '@psd-eoc/contracts';

/** Durable mutation identity bound before any key-lifecycle write occurs. */
export interface AgentApiKeyMutationIdempotency {
  readonly capabilityId: 'issue-agent-api-key' | 'revoke-agent-api-key';
  readonly actor: Extract<Actor, { readonly kind: 'human' }>;
  readonly key: string;
  readonly principalDigest: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

/** Atomic issuance command. Plaintext credentials are structurally absent. */
export interface PersistIssuedAgentApiKeyInput {
  readonly key: AgentApiKey;
  /** Creates the stable agent principal in the same transaction as its first key. */
  readonly createAgent: boolean;
  readonly idempotency: AgentApiKeyMutationIdempotency;
}

/** Issuance is at-most-once; replay never reconstructs the plaintext secret. */
export type PersistIssuedAgentApiKeyResult =
  | Readonly<{ kind: 'issued'; key: AgentApiKey }>
  | Readonly<{ kind: 'replayed'; key: AgentApiKey }>;

/** Stable keyset position used by the service-owned opaque list cursor. */
export interface AgentApiKeyListPosition {
  readonly issuedAt: string;
  readonly id: string;
}

/** Internal bounded list query. Repositories must never select a digest here. */
export interface AgentApiKeySummaryListQuery {
  readonly agentId: string | null;
  readonly includeRevoked: boolean;
  readonly before: AgentApiKeyListPosition | null;
  readonly limit: number;
}

/** One bounded summary page plus truthful continuation state. */
export interface AgentApiKeySummaryListResult {
  readonly items: readonly AgentApiKeySummary[];
  readonly hasMore: boolean;
}

/** Atomic append-only revocation result. */
export type AppendAgentApiKeyRevocationResult =
  | Readonly<{
      kind: 'appended';
      revocation: AgentApiKeyRevocation;
    }>
  | Readonly<{
      kind: 'replayed';
      revocation: AgentApiKeyRevocation;
    }>
  | Readonly<{ kind: 'not-found' }>
  | Readonly<{ kind: 'already-revoked' }>;

/**
 * Persistence boundary for the agent-key lifecycle.
 *
 * There are deliberately no update/delete methods for agent identities,
 * verifier records, grants, scopes, or revocation facts. The sole projection
 * update needed by the existing schema occurs inside `appendRevocation` and
 * must be atomic with the append-only revocation insert.
 */
export interface AgentApiKeyRepository {
  persistIssuedKey(
    input: PersistIssuedAgentApiKeyInput,
  ): Promise<PersistIssuedAgentApiKeyResult>;
  findVerifierByPrefix(keyPrefix: string): Promise<AgentApiKey | null>;
  appendRevocation(input: {
    readonly revocation: AgentApiKeyRevocation;
    readonly idempotency: AgentApiKeyMutationIdempotency;
  }): Promise<AppendAgentApiKeyRevocationResult>;
  listSummaries(
    query: AgentApiKeySummaryListQuery,
  ): Promise<AgentApiKeySummaryListResult>;
}

/** Persisted rows disagree with the contracts or normalized scope graph. */
export class AgentApiKeyRepositoryIntegrityError extends Error {
  public constructor() {
    super('Agent API-key persistence is inconsistent.');
    this.name = 'AgentApiKeyRepositoryIntegrityError';
  }
}

/** Issuance collided with an existing immutable identity or verifier. */
export class AgentApiKeyRepositoryConflictError extends Error {
  public constructor() {
    super('Agent API-key persistence conflicts with an existing record.');
    this.name = 'AgentApiKeyRepositoryConflictError';
  }
}

/** One idempotency key was rebound to different key-lifecycle input. */
export class AgentApiKeyRepositoryIdempotencyConflictError extends Error {
  public constructor() {
    super('Agent API-key idempotency evidence conflicts with this request.');
    this.name = 'AgentApiKeyRepositoryIdempotencyConflictError';
  }
}
