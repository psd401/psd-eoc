import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  ActorSchema,
  AgentApiKeyIdSchema,
  AgentApiKeyIssuanceSchema,
  AgentApiKeyRevocationSchema,
  AgentApiKeySchema,
  AgentApiKeySummarySchema,
  AgentApiKeyPageSchema,
  IssueAgentApiKeyInputSchema,
  IdempotencyKeySchema,
  ListAgentApiKeysInputSchema,
  RevokeAgentApiKeyInputSchema,
  TimestampSchema,
  UuidSchema,
  isAgentGrantableCapabilityId,
  type Actor,
  type AgentApiKey,
  type AgentApiKeyIssuance,
  type AgentApiKeyPage,
  type AgentApiKeyRevocation,
  type AgentApiKeySummary,
  type AgentGrantableCapabilityId,
  type CapabilityScope,
  type ListAgentApiKeysInput,
} from '@psd-eoc/contracts';

import {
  AgentApiKeyRepositoryConflictError,
  AgentApiKeyRepositoryIdempotencyConflictError,
  AgentApiKeyRepositoryIntegrityError,
  type AgentApiKeyMutationIdempotency,
  type AgentApiKeyListPosition,
  type AgentApiKeyRepository,
} from './key-repository';
import { digestCapabilityValue } from '../capabilities/engine';

const KEY_PREFIX_BYTES = 9;
const KEY_SECRET_BYTES = 32;
const KEY_PREFIX_LENGTH = 12;
const KEY_SECRET_LENGTH = 43;
const SHA_256_BYTES = 32;
const LIST_CURSOR_VERSION = 1;
const AUDIT_SUBJECT_DOMAIN = 'psd-eoc-agent-api-key-prefix-v1';

/** Public format marker; the complete bearer remains secret. */
export const AGENT_API_KEY_CREDENTIAL_MARKER = 'psd_eoc_agent_v1_';

const credentialPattern = new RegExp(
  `^${AGENT_API_KEY_CREDENTIAL_MARKER}([A-Za-z0-9_-]{${KEY_PREFIX_LENGTH}})\\.([A-Za-z0-9_-]{${KEY_SECRET_LENGTH}})$`,
  'u',
);

const invalidCredentialDigest = createHash('sha256')
  .update('psd-eoc-invalid-agent-api-key-v1', 'utf8')
  .digest('hex');

export type AgentApiKeyErrorCode =
  | 'CAPABILITY_NOT_GRANTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CREDENTIAL'
  | 'INVALID_CURSOR'
  | 'ISSUANCE_ALREADY_COMMITTED'
  | 'KEY_ALREADY_REVOKED'
  | 'KEY_NOT_FOUND'
  | 'PERSISTENCE_CONFLICT'
  | 'PERSISTENCE_FAILURE';

const errorStatus = {
  CAPABILITY_NOT_GRANTED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_CREDENTIAL: 401,
  INVALID_CURSOR: 400,
  ISSUANCE_ALREADY_COMMITTED: 409,
  KEY_ALREADY_REVOKED: 409,
  KEY_NOT_FOUND: 404,
  PERSISTENCE_CONFLICT: 409,
  PERSISTENCE_FAILURE: 500,
} as const satisfies Record<AgentApiKeyErrorCode, number>;

/** Bounded, credential-free failure safe for REST/admin translation. */
export class AgentApiKeyError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(
    public readonly code: AgentApiKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentApiKeyError';
    this.status = errorStatus[code];
    this.retryable = code === 'PERSISTENCE_FAILURE';
  }
}

/** Safe replay signal: the original plaintext credential is unrecoverable. */
export class AgentApiKeyIssuanceReplayError extends AgentApiKeyError {
  public constructor(public readonly key: AgentApiKeySummary) {
    super(
      'ISSUANCE_ALREADY_COMMITTED',
      'This API-key issuance already completed; its credential cannot be shown again.',
    );
    this.name = 'AgentApiKeyIssuanceReplayError';
  }
}

export interface AgentApiKeyMutationInvocation {
  readonly actor: Extract<Actor, { readonly kind: 'human' }>;
  readonly idempotencyKey: string;
}

/** Authenticated server-owned identity and exact persisted authority. */
export interface AuthenticatedAgentApiKey {
  readonly actor: Extract<Actor, { readonly kind: 'agent' }>;
  readonly scope: CapabilityScope;
  readonly capabilityIds: readonly AgentGrantableCapabilityId[];
  readonly key: AgentApiKeySummary;
}

export interface AgentApiKeyServiceDependencies {
  readonly repository: AgentApiKeyRepository;
  /** Injectable trusted clock for deterministic boundary tests. */
  readonly now?: () => Date;
}

interface ListCursorPayload {
  readonly version: typeof LIST_CURSOR_VERSION;
  readonly issuedAt: string;
  readonly id: string;
  readonly agentId: string | null;
  readonly includeRevoked: boolean;
}

function currentTime(now: () => Date): Date {
  const value = new Date(now().getTime());
  if (Number.isNaN(value.getTime())) {
    throw new AgentApiKeyError(
      'PERSISTENCE_FAILURE',
      'The trusted key-lifecycle clock is invalid.',
    );
  }
  TimestampSchema.parse(value.toISOString());
  return value;
}

function addSeconds(date: Date, seconds: number): Date {
  const timestamp = date.getTime() + seconds * 1_000;
  if (!Number.isSafeInteger(timestamp)) {
    throw new AgentApiKeyError(
      'PERSISTENCE_FAILURE',
      'The requested key expiry is outside the supported range.',
    );
  }
  const result = new Date(timestamp);
  if (Number.isNaN(result.getTime())) {
    throw new AgentApiKeyError(
      'PERSISTENCE_FAILURE',
      'The requested key expiry is outside the supported range.',
    );
  }
  return result;
}

function createCredential(): Readonly<{
  keyPrefix: string;
  credential: string;
}> {
  const keyPrefix = randomBytes(KEY_PREFIX_BYTES).toString('base64url');
  const secret = randomBytes(KEY_SECRET_BYTES).toString('base64url');
  if (
    keyPrefix.length !== KEY_PREFIX_LENGTH ||
    secret.length !== KEY_SECRET_LENGTH
  ) {
    throw new AgentApiKeyError(
      'PERSISTENCE_FAILURE',
      'Secure agent credential generation failed.',
    );
  }
  return Object.freeze({
    keyPrefix,
    credential: `${AGENT_API_KEY_CREDENTIAL_MARKER}${keyPrefix}.${secret}`,
  });
}

/** SHA-256 is the sole representation accepted by key persistence. */
export function digestAgentApiKeyCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

function credentialPrefix(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  return credentialPattern.exec(value)?.[1] ?? null;
}

/**
 * Correlates failed attempts against the non-secret public key prefix only.
 * The full bearer and its verifier digest must never enter security audit.
 */
export function digestAgentApiKeyAuditSubject(
  credentialValue: unknown,
): string | null {
  const prefix = credentialPrefix(credentialValue);
  return prefix === null
    ? null
    : createHash('sha256')
        .update(`${AUDIT_SUBJECT_DOMAIN}:${prefix}`, 'utf8')
        .digest('hex');
}

function constantTimeDigestMatch(
  candidateDigest: string,
  expectedDigest: string,
): boolean {
  const candidate = Buffer.from(candidateDigest, 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  if (candidate.length !== SHA_256_BYTES || expected.length !== SHA_256_BYTES) {
    return false;
  }
  return timingSafeEqual(candidate, expected);
}

function toSummary(key: AgentApiKey): AgentApiKeySummary {
  return AgentApiKeySummarySchema.parse({
    id: key.id,
    agentId: key.agentId,
    displayName: key.displayName,
    facilityScope: key.facilityScope,
    capabilityIds: key.capabilityIds,
    keyPrefix: key.keyPrefix,
    issuedByUserId: key.issuedByUserId,
    issuedAt: key.issuedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  });
}

function encodeListCursor(
  key: AgentApiKeySummary,
  input: ListAgentApiKeysInput,
): string {
  const payload: ListCursorPayload = {
    version: LIST_CURSOR_VERSION,
    issuedAt: key.issuedAt,
    id: key.id,
    agentId: input.agentId,
    includeRevoked: input.includeRevoked,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeListCursor(
  cursor: string | null,
  input: ListAgentApiKeysInput,
): AgentApiKeyListPosition | null {
  if (cursor === null) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new TypeError('Non-canonical cursor.');
    }
    const payload = JSON.parse(decoded) as unknown;
    if (typeof payload !== 'object' || payload === null) {
      throw new TypeError('Invalid cursor payload.');
    }
    const version = Reflect.get(payload, 'version');
    const issuedAt = Reflect.get(payload, 'issuedAt');
    const id = Reflect.get(payload, 'id');
    const agentId = Reflect.get(payload, 'agentId');
    const includeRevoked = Reflect.get(payload, 'includeRevoked');
    if (
      version !== LIST_CURSOR_VERSION ||
      !TimestampSchema.safeParse(issuedAt).success ||
      !AgentApiKeyIdSchema.safeParse(id).success ||
      agentId !== input.agentId ||
      includeRevoked !== input.includeRevoked
    ) {
      throw new TypeError('Cursor does not match the list query.');
    }
    return Object.freeze({ issuedAt: String(issuedAt), id: String(id) });
  } catch {
    throw new AgentApiKeyError(
      'INVALID_CURSOR',
      'The agent API-key list cursor is invalid for this query.',
    );
  }
}

function persistenceError(error: unknown): AgentApiKeyError {
  if (error instanceof AgentApiKeyError) return error;
  if (error instanceof AgentApiKeyRepositoryIdempotencyConflictError) {
    return new AgentApiKeyError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key was already used for a different API-key request.',
    );
  }
  if (error instanceof AgentApiKeyRepositoryConflictError) {
    return new AgentApiKeyError(
      'PERSISTENCE_CONFLICT',
      'The agent identity or key already exists.',
    );
  }
  if (error instanceof AgentApiKeyRepositoryIntegrityError) {
    return new AgentApiKeyError(
      'PERSISTENCE_FAILURE',
      'Stored agent API-key data failed integrity validation.',
    );
  }
  return new AgentApiKeyError(
    'PERSISTENCE_FAILURE',
    'Agent API-key persistence is unavailable.',
  );
}

function mutationIdempotency(
  capabilityId: AgentApiKeyMutationIdempotency['capabilityId'],
  invocationValue: AgentApiKeyMutationInvocation,
  input: unknown,
  createdAt: Date,
): AgentApiKeyMutationIdempotency {
  const actor = ActorSchema.parse(invocationValue.actor);
  if (actor.kind !== 'human') {
    throw new AgentApiKeyError(
      'PERSISTENCE_FAILURE',
      'Only a human actor can administer agent API keys.',
    );
  }
  const key = IdempotencyKeySchema.parse(invocationValue.idempotencyKey);
  return Object.freeze({
    capabilityId,
    actor,
    key,
    principalDigest: digestCapabilityValue(actor),
    requestDigest: digestCapabilityValue({ capabilityId, input }),
    createdAt: createdAt.toISOString(),
  });
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Complete scoped API-key lifecycle. Authentication never returns a verifier
 * digest, and every credential failure is deliberately indistinguishable.
 */
export class AgentApiKeyService {
  private readonly repository: AgentApiKeyRepository;
  private readonly now: () => Date;

  public constructor(dependencies: AgentApiKeyServiceDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? (() => new Date());
  }

  public async issue(
    inputValue: unknown,
    issuedByUserIdValue: string,
    invocation: AgentApiKeyMutationInvocation,
  ): Promise<AgentApiKeyIssuance> {
    const input = IssueAgentApiKeyInputSchema.parse(inputValue);
    const issuedByUserId = UuidSchema.parse(issuedByUserIdValue);
    const issuedAt = currentTime(this.now);
    const idempotency = mutationIdempotency(
      'issue-agent-api-key',
      invocation,
      input,
      issuedAt,
    );
    if (idempotency.actor.userId !== issuedByUserId) {
      throw new AgentApiKeyError(
        'PERSISTENCE_FAILURE',
        'The API-key issuer does not match the authenticated actor.',
      );
    }
    const expiresAt =
      input.expiresInSeconds === null
        ? null
        : addSeconds(issuedAt, input.expiresInSeconds);
    const generated = createCredential();
    const agentId = input.agentId ?? randomUUID();
    const key = AgentApiKeySchema.parse({
      id: randomUUID(),
      agentId,
      displayName: input.displayName,
      facilityScope: input.facilityScope,
      capabilityIds: input.capabilityIds,
      keyPrefix: generated.keyPrefix,
      credentialDigest: digestAgentApiKeyCredential(generated.credential),
      issuedByUserId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
      revokedAt: null,
    });

    try {
      const persistence = await this.repository.persistIssuedKey({
        key,
        createAgent: input.agentId === null,
        idempotency,
      });
      const persisted = AgentApiKeySchema.parse(persistence.key);
      if (persistence.kind === 'replayed') {
        throw new AgentApiKeyIssuanceReplayError(toSummary(persisted));
      }
      if (!structurallyEqual(persisted, key)) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }
      return AgentApiKeyIssuanceSchema.parse({
        key: toSummary(persisted),
        oneTimeCredential: generated.credential,
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }

  public async authenticate(
    credentialValue: unknown,
  ): Promise<AuthenticatedAgentApiKey> {
    const prefix = credentialPrefix(credentialValue);
    const credential =
      prefix !== null && typeof credentialValue === 'string'
        ? credentialValue
        : '';
    const candidateDigest = digestAgentApiKeyCredential(credential);

    let stored: AgentApiKey | null;
    try {
      stored =
        prefix === null
          ? null
          : AgentApiKeySchema.nullable().parse(
              await this.repository.findVerifierByPrefix(prefix),
            );
    } catch (error) {
      throw persistenceError(error);
    }

    const expectedDigest = stored?.credentialDigest ?? invalidCredentialDigest;
    const digestMatches = constantTimeDigestMatch(
      candidateDigest,
      expectedDigest,
    );
    const at = currentTime(this.now).getTime();
    const notYetIssued = stored !== null && at < Date.parse(stored.issuedAt);
    const expired =
      stored?.expiresAt !== null &&
      stored?.expiresAt !== undefined &&
      at >= Date.parse(stored.expiresAt);
    const revoked =
      stored?.revokedAt !== null && stored?.revokedAt !== undefined;
    if (
      prefix === null ||
      stored === null ||
      stored.keyPrefix !== prefix ||
      !digestMatches ||
      notYetIssued ||
      expired ||
      revoked
    ) {
      throw new AgentApiKeyError(
        'INVALID_CREDENTIAL',
        'The agent API key is invalid.',
      );
    }

    const key = toSummary(stored);
    return Object.freeze({
      actor: Object.freeze({
        kind: 'agent' as const,
        agentId: stored.agentId,
        apiKeyId: stored.id,
      }),
      scope: Object.freeze({ facilityScope: stored.facilityScope }),
      capabilityIds: Object.freeze([...stored.capabilityIds]),
      key,
    });
  }

  public authorizeCapability(
    authenticated: AuthenticatedAgentApiKey,
    capabilityIdValue: unknown,
  ): AgentGrantableCapabilityId {
    if (
      !isAgentGrantableCapabilityId(capabilityIdValue) ||
      !authenticated.capabilityIds.includes(capabilityIdValue)
    ) {
      throw new AgentApiKeyError(
        'CAPABILITY_NOT_GRANTED',
        'The agent API key does not grant this capability.',
      );
    }
    return capabilityIdValue;
  }

  public async revoke(
    inputValue: unknown,
    revokedByUserIdValue: string,
    invocation: AgentApiKeyMutationInvocation,
  ): Promise<AgentApiKeyRevocation> {
    const input = RevokeAgentApiKeyInputSchema.parse(inputValue);
    const revokedByUserId = UuidSchema.parse(revokedByUserIdValue);
    const revokedAt = currentTime(this.now);
    const idempotency = mutationIdempotency(
      'revoke-agent-api-key',
      invocation,
      input,
      revokedAt,
    );
    if (idempotency.actor.userId !== revokedByUserId) {
      throw new AgentApiKeyError(
        'PERSISTENCE_FAILURE',
        'The API-key revoker does not match the authenticated actor.',
      );
    }
    const revocation = AgentApiKeyRevocationSchema.parse({
      id: randomUUID(),
      apiKeyId: input.apiKeyId,
      revokedByUserId,
      reasonCode: input.reasonCode,
      revokedAt: revokedAt.toISOString(),
    });
    try {
      const result = await this.repository.appendRevocation({
        revocation,
        idempotency,
      });
      if (result.kind === 'not-found') {
        throw new AgentApiKeyError(
          'KEY_NOT_FOUND',
          'The agent API key does not exist.',
        );
      }
      if (result.kind === 'already-revoked') {
        throw new AgentApiKeyError(
          'KEY_ALREADY_REVOKED',
          'The agent API key is already revoked.',
        );
      }
      const persisted = AgentApiKeyRevocationSchema.parse(result.revocation);
      if (
        result.kind === 'appended' &&
        !structurallyEqual(persisted, revocation)
      ) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }
      return persisted;
    } catch (error) {
      throw persistenceError(error);
    }
  }

  public async list(inputValue: unknown): Promise<AgentApiKeyPage> {
    const input = ListAgentApiKeysInputSchema.parse(inputValue);
    const before = decodeListCursor(input.cursor, input);
    try {
      const result = await this.repository.listSummaries({
        agentId: input.agentId,
        includeRevoked: input.includeRevoked,
        before,
        limit: input.limit,
      });
      if (
        result.items.length > input.limit ||
        (result.hasMore && result.items.length === 0)
      ) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }
      const items = result.items.map((item) =>
        AgentApiKeySummarySchema.parse(item),
      );
      if (
        items.some(
          (item) =>
            (input.agentId !== null && item.agentId !== input.agentId) ||
            (!input.includeRevoked && item.revokedAt !== null),
        )
      ) {
        throw new AgentApiKeyRepositoryIntegrityError();
      }
      const last = items.at(-1);
      return AgentApiKeyPageSchema.parse({
        items,
        pageInfo: {
          hasMore: result.hasMore,
          nextCursor:
            result.hasMore && last !== undefined
              ? encodeListCursor(last, input)
              : null,
        },
      });
    } catch (error) {
      throw persistenceError(error);
    }
  }
}
