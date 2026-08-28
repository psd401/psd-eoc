import { createHash } from 'node:crypto';

import {
  ActorInvocationSchema,
  ActorSchema,
  AuthenticationCapabilityEnvelopeSchema,
  CapabilityScopeSchema,
  HumanConfirmationRecordSchema,
  IdempotencyKeySchema,
  MutationCapabilityEnvelopeSchema,
  MutationTransportSchema,
  OidcCompletionTransportSchema,
  PreSessionOidcPrincipalSchema,
  QueryCapabilityEnvelopeSchema,
  SessionRefreshCapabilityEnvelopeSchema,
  SessionRefreshTransportSchema,
  TimestampSchema,
  UuidSchema,
  VerifiedCurrentRefreshCredentialSchema,
  deriveHumanOnlyActionIds,
  defineCapability,
  invokeAuthorizedCapabilityHandler,
  getCapabilityInvocationPolicy,
  parseCapabilityInput,
  parseCapabilityOutput,
  registerCapabilityHandler,
  type Actor,
  type ApiErrorCode,
  type CapabilityInput,
  type CapabilityPrincipalKind,
  type CapabilityExecutionDependencies,
  type CapabilityOutput,
  type CapabilitySafetyResolution,
  type CapabilitySafetyResolutionRequest,
  type CapabilityScope,
  type HumanActionRequirement,
  type HumanConfirmation,
  type HumanConfirmationRecord,
  type HumanOnlyActionId,
  type InvocationSource,
  type MutationTransport,
  type OidcCompletionTransport,
  type PreSessionOidcPrincipal,
  type RegisteredCapabilityId,
  type RegisteredMutationCapabilityId,
  type RegisteredQueryCapabilityId,
  type RegisteredCapabilityHandler,
  type SecurityAuditCategory,
  type SecurityAuditOutcome,
  type SessionRefreshTransport,
  type VerifiedCurrentRefreshCredential,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../auth/sessions';

/** Stable, non-sensitive engine failures mapped by REST and future MCP adapters. */
export type CapabilityEngineReasonCode =
  | 'CAPABILITY_INPUT_INVALID'
  | 'CAPABILITY_INVOCATION_DENIED'
  | 'CAPABILITY_SCOPE_DENIED'
  | 'CONFIRMATION_ALREADY_USED'
  | 'CONFIRMATION_INVALID'
  | 'CONFIRMATION_REQUIRED'
  | 'HUMAN_ONLY_REQUIRED'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'IDEMPOTENCY_PREVIOUSLY_FAILED'
  | 'IDEMPOTENCY_REQUEST_MISMATCH'
  | 'IDEMPOTENCY_RESULT_UNAVAILABLE'
  | 'MUTATION_METADATA_INVALID'
  | 'PERSISTENCE_CONFLICT';

/** Public-safe failure with an API code and retry truth. */
export class CapabilityEngineError extends Error {
  public constructor(
    public readonly code: ApiErrorCode,
    public readonly reasonCode: CapabilityEngineReasonCode,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CapabilityEngineError';
  }
}

/** Trusted invocation facts resolved by authentication adapters, never bodies. */
export interface TrustedCapabilityInvocation {
  readonly actor: Actor;
  /** Special authenticated evidence for the two pre-session capabilities. */
  readonly principal?:
    | PreSessionOidcPrincipal
    | VerifiedCurrentRefreshCredential;
  readonly principalKind?: CapabilityPrincipalKind;
  readonly source: InvocationSource;
  readonly scope: CapabilityScope;
  readonly requestId: string;
  readonly serverTime: Date;
  readonly connectivityEpochId: string | null;
  readonly mutation: Readonly<{
    idempotencyKey: string;
    transport:
      | MutationTransport
      | OidcCompletionTransport
      | SessionRefreshTransport;
    humanConfirmationId: string | null;
  }> | null;
}

/** Converts issue #7's authenticated session into server-owned engine facts. */
export function resolveHumanCapabilityInvocation(
  authenticated: AuthenticatedSession,
  input: Readonly<{
    requestId: string;
    serverTime?: Date;
    mutation: Readonly<{
      idempotencyKey: string;
      humanConfirmationId: string | null;
    }> | null;
  }>,
): TrustedCapabilityInvocation {
  const serverTime = input.serverTime ?? new Date();
  const mutation =
    input.mutation === null
      ? null
      : Object.freeze({
          idempotencyKey: input.mutation.idempotencyKey,
          humanConfirmationId: input.mutation.humanConfirmationId,
          transport:
            authenticated.source === 'web'
              ? ({
                  kind: 'web-interactive',
                  method: 'POST',
                  interaction: 'explicit-user-submit',
                  csrfVerified: true,
                } as const)
              : ({
                  kind: 'mobile-interactive',
                  interaction: 'explicit-user-submit',
                } as const),
        });

  return Object.freeze({
    actor: authenticated.actor,
    source: authenticated.source,
    scope: authenticated.scope,
    requestId: input.requestId,
    serverTime,
    connectivityEpochId: authenticated.result.connectivityEpoch.id,
    mutation,
  });
}

/** New and terminal idempotency states returned under the transaction lock. */
export type IdempotencyClaim =
  | Readonly<{ kind: 'new'; recordId: string }>
  | Readonly<{
      kind: 'completed';
      requestDigest: string;
      resultReference: string;
    }>
  | Readonly<{ kind: 'in-progress'; requestDigest: string }>
  | Readonly<{
      kind: 'failed';
      requestDigest: string;
      resultReference: string;
    }>;

export interface ClaimIdempotencyInput {
  readonly capabilityId: RegisteredMutationCapabilityId;
  readonly actor: Actor;
  readonly principalDigest: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly createdAt: Date;
}

export interface CompleteIdempotencyInput {
  readonly recordId: string;
  readonly resultReference: string;
  readonly completedAt: Date;
}

export interface ConsumeHumanConfirmationInput {
  readonly confirmationId: string;
  readonly requestId: string;
  readonly consumedAt: Date;
}

/** Minimized event passed to the shared hash-chain persistence boundary. */
export interface CapabilityAuditEvent {
  readonly category: SecurityAuditCategory;
  readonly action: RegisteredCapabilityId;
  readonly actionIds: readonly HumanOnlyActionId[];
  readonly confirmationId: string | null;
  readonly outcome: SecurityAuditOutcome;
  readonly actor: Actor;
  readonly source: InvocationSource;
  readonly facilityId: string | null;
  readonly requestId: string;
  readonly reasonCode: string | null;
  readonly occurredAt: Date;
}

/** Persistence required centrally by every capability transaction. */
export interface CapabilityEngineTransaction {
  /**
   * Returns an authoritative execution-time clock after any preceding lock
   * waits. In-memory stores may use the trusted request-receipt fallback.
   */
  readCurrentTime(requestReceivedAt: Date): Promise<Date>;
  claimIdempotency(input: ClaimIdempotencyInput): Promise<IdempotencyClaim>;
  completeIdempotency(input: CompleteIdempotencyInput): Promise<void>;
  getHumanConfirmation(id: string): Promise<HumanConfirmationRecord | null>;
  consumeHumanConfirmation(
    input: ConsumeHumanConfirmationInput,
  ): Promise<boolean>;
  appendCapabilityAudit(event: CapabilityAuditEvent): Promise<void>;
}

/** A store must make the supplied callback one atomic transaction. */
export interface CapabilityEngineStore<
  Transaction extends CapabilityEngineTransaction,
> {
  transaction<Result>(
    operation: (transaction: Transaction) => Promise<Result>,
  ): Promise<Result>;
  appendCapabilityAudit(event: CapabilityAuditEvent): Promise<void>;
}

export interface CapabilityHandlerAuthorization {
  readonly facilityId: string | null;
  readonly humanActionRequirement: HumanActionRequirement;
  readonly humanConfirmation: HumanConfirmation | null;
}

/** Context shared by safety resolution, authorization, and one handler. */
export interface CapabilityHandlerContext<
  Transaction extends CapabilityEngineTransaction,
> {
  readonly invocation: TrustedCapabilityInvocation;
  readonly transaction: Transaction;
  readonly cache: Map<string, unknown>;
  authorization: CapabilityHandlerAuthorization | null;
  resolvedFacilityId: string | null;
  safetyResolution: CapabilitySafetyResolution | null;
}

type CapabilityFailureAuditContext = Pick<
  CapabilityHandlerContext<CapabilityEngineTransaction>,
  'authorization' | 'invocation' | 'resolvedFacilityId' | 'safetyResolution'
>;

export function requireCapabilityAuthorization<
  Transaction extends CapabilityEngineTransaction,
>(
  context: CapabilityHandlerContext<Transaction>,
): CapabilityHandlerAuthorization {
  if (context.authorization === null) {
    throw new CapabilityEngineError(
      'INTERNAL_ERROR',
      'MUTATION_METADATA_INVALID',
      'Capability authorization was not completed.',
      500,
    );
  }
  return context.authorization;
}

/** Reads and validates the transaction's authoritative current time. */
export async function readCapabilityTime<
  Transaction extends CapabilityEngineTransaction,
>(context: CapabilityHandlerContext<Transaction>): Promise<Date> {
  const currentTime = await context.transaction.readCurrentTime(
    context.invocation.serverTime,
  );
  TimestampSchema.parse(currentTime.toISOString());
  return currentTime;
}

export interface ServerCapabilityRegistration<
  Id extends RegisteredCapabilityId,
  Transaction extends CapabilityEngineTransaction,
> {
  readonly id: Id;
  readonly handler: (
    input: CapabilityInput<Id>,
    context: CapabilityHandlerContext<Transaction>,
  ) => CapabilityOutput<Id> | Promise<CapabilityOutput<Id>>;
  readonly resolveFacilityId: (
    input: CapabilityInput<Id>,
    context: CapabilityHandlerContext<Transaction>,
  ) => string | null | Promise<string | null>;
  readonly resolveSafety?: (
    request: CapabilitySafetyResolutionRequest,
    context: CapabilityHandlerContext<Transaction>,
  ) => CapabilitySafetyResolution | Promise<CapabilitySafetyResolution>;
  readonly canonicalizeIdempotencyInput?: (
    input: CapabilityInput<Id>,
  ) => unknown;
  readonly resultReference?: (
    output: CapabilityOutput<Id>,
    context: CapabilityHandlerContext<Transaction>,
  ) => string;
  readonly loadReplay?: (
    resultReference: string,
    context: CapabilityHandlerContext<Transaction>,
  ) => CapabilityOutput<Id> | Promise<CapabilityOutput<Id>>;
  readonly resolveReplayFacilityId?: (
    resultReference: string,
    context: CapabilityHandlerContext<Transaction>,
  ) => string | null | Promise<string | null>;
  readonly replayFacilityId?: (output: CapabilityOutput<Id>) => string | null;
  /**
   * Specialized repositories may retain their existing durable idempotency
   * protocol while the engine still owns authorization and atomic audit.
   * The handler must execute inside the supplied engine-store transaction.
   */
  readonly mutationPersistence?: Id extends RepositoryOwnedMutationCapabilityId
    ? 'engine-owned' | 'repository-owned'
    : 'engine-owned';
  /**
   * Classifies repository errors without widening the committed mutation
   * allowlist. A committed failure is reserved for a security response, such
   * as refresh-token replay revocation, that must persist with its audit even
   * though the caller receives a denial.
   */
  readonly classifyRepositoryError?: Id extends RepositoryOwnedMutationCapabilityId
    ? (error: unknown) => RepositoryOwnedCapabilityErrorDisposition | null
    : never;
}

export const REPOSITORY_OWNED_MUTATION_CAPABILITY_IDS = Object.freeze([
  'refresh-session',
  'revoke-session',
  'create-event-type-draft',
  'update-event-type-draft',
  'publish-event-type-version',
  'issue-agent-api-key',
  'revoke-agent-api-key',
] as const satisfies readonly RegisteredMutationCapabilityId[]);

export type RepositoryOwnedMutationCapabilityId =
  (typeof REPOSITORY_OWNED_MUTATION_CAPABILITY_IDS)[number];

export interface RepositoryOwnedCapabilityErrorDisposition {
  readonly auditError: CapabilityEngineError;
  readonly commitTransaction: boolean;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable SHA-256 used for request and principal binding, never credentials. */
export function digestCapabilityValue(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

/**
 * Converts a caller key into the globally unique transition-evidence key used
 * by the issue #5 schema. The canonical idempotency row still retains the
 * caller key under its capability-and-principal scope.
 */
export function scopeTransitionIdempotencyKey(
  capabilityId: RegisteredMutationCapabilityId,
  principalDigest: string,
  key: string,
): string {
  return digestCapabilityValue({ capabilityId, key, principalDigest });
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const first = [...left].sort();
  const second = [...right].sort();
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function scopeAllowsFacility(
  scope: CapabilityScope,
  facilityId: string | null,
): boolean {
  if (facilityId === null || scope.facilityScope.kind === 'district') {
    return true;
  }
  return scope.facilityScope.facilityIds.includes(facilityId);
}

function assertInvocationAllowed(
  capabilityId: RegisteredCapabilityId,
  invocation: TrustedCapabilityInvocation,
): void {
  const policy = getCapabilityInvocationPolicy(capabilityId);
  const principalKinds: ReadonlySet<string> = new Set(policy.principalKinds);
  const sources: ReadonlySet<string> = new Set(policy.sources);
  if (
    !principalKinds.has(invocation.principalKind ?? invocation.actor.kind) ||
    !sources.has(invocation.source)
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'This authenticated principal cannot invoke the capability.',
      403,
    );
  }
}

function validateTrustedInvocation(
  invocation: TrustedCapabilityInvocation,
): TrustedCapabilityInvocation {
  ActorSchema.parse(invocation.actor);
  const principalKind = invocation.principalKind ?? invocation.actor.kind;
  if (principalKind === 'pre-session-oidc') {
    PreSessionOidcPrincipalSchema.parse(invocation.principal);
  } else if (principalKind === 'verified-refresh-credential') {
    VerifiedCurrentRefreshCredentialSchema.parse(invocation.principal);
  } else {
    if (invocation.principal !== undefined) {
      throw new CapabilityEngineError(
        'VALIDATION_ERROR',
        'MUTATION_METADATA_INVALID',
        'Ordinary actors cannot carry special-principal evidence.',
        400,
      );
    }
    ActorInvocationSchema.parse({
      actor: invocation.actor,
      source: invocation.source,
    });
  }
  CapabilityScopeSchema.parse(invocation.scope);
  UuidSchema.parse(invocation.requestId);
  TimestampSchema.parse(invocation.serverTime.toISOString());
  if (invocation.connectivityEpochId !== null) {
    UuidSchema.parse(invocation.connectivityEpochId);
  }
  if (invocation.mutation !== null) {
    IdempotencyKeySchema.parse(invocation.mutation.idempotencyKey);
    if (principalKind === 'pre-session-oidc') {
      OidcCompletionTransportSchema.parse(invocation.mutation.transport);
    } else if (principalKind === 'verified-refresh-credential') {
      SessionRefreshTransportSchema.parse(invocation.mutation.transport);
    } else {
      MutationTransportSchema.parse(invocation.mutation.transport);
    }
    if (invocation.mutation.humanConfirmationId !== null) {
      UuidSchema.parse(invocation.mutation.humanConfirmationId);
    }
  }
  return invocation;
}

function assertStaticMutationEnvelope(
  capabilityId: RegisteredMutationCapabilityId,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
): void {
  if (invocation.mutation === null) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'MUTATION_METADATA_INVALID',
      'Mutation metadata is required.',
      400,
    );
  }
  if (
    capabilityId === 'complete-oidc-sign-in' &&
    invocation.principalKind === 'pre-session-oidc'
  ) {
    const parsed = AuthenticationCapabilityEnvelopeSchema.safeParse({
      capabilityId,
      operation: 'mutation',
      principal: invocation.principal,
      source: invocation.source,
      requestId: invocation.requestId,
      serverTime: invocation.serverTime.toISOString(),
      input,
      idempotencyKey: invocation.mutation.idempotencyKey,
      transport: invocation.mutation.transport,
    });
    if (!parsed.success) {
      throw new CapabilityEngineError(
        'VALIDATION_ERROR',
        'MUTATION_METADATA_INVALID',
        'The trusted OIDC mutation metadata is inconsistent.',
        400,
      );
    }
    return;
  }
  if (
    capabilityId === 'refresh-session' &&
    invocation.principalKind === 'verified-refresh-credential'
  ) {
    const parsed = SessionRefreshCapabilityEnvelopeSchema.safeParse({
      capabilityId,
      operation: 'mutation',
      principal: invocation.principal,
      source: invocation.source,
      requestId: invocation.requestId,
      serverTime: invocation.serverTime.toISOString(),
      input,
      idempotencyKey: invocation.mutation.idempotencyKey,
      transport: invocation.mutation.transport,
    });
    if (!parsed.success) {
      throw new CapabilityEngineError(
        'VALIDATION_ERROR',
        'MUTATION_METADATA_INVALID',
        'The trusted refresh mutation metadata is inconsistent.',
        400,
      );
    }
    return;
  }
  const parsed = MutationCapabilityEnvelopeSchema.safeParse({
    capabilityId,
    operation: 'mutation',
    actor: invocation.actor,
    source: invocation.source,
    scope: invocation.scope,
    requestId: invocation.requestId,
    serverTime: invocation.serverTime.toISOString(),
    input,
    idempotencyKey: invocation.mutation.idempotencyKey,
    transport: invocation.mutation.transport,
    connectivityEpochId: invocation.connectivityEpochId,
    requiredHumanActionIds: [],
    requiredConsequenceDigest: null,
    humanConfirmation: null,
  });
  if (!parsed.success) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'MUTATION_METADATA_INVALID',
      'The trusted mutation metadata is inconsistent.',
      400,
    );
  }
}

/** At most this much of an unexpected failure is written to the log. */
const UNEXPECTED_FAILURE_MESSAGE_LIMIT = 300;

/**
 * A bounded, value-free description of an unexpected capability failure.
 *
 * A schema refusal reports the field paths it rejected rather than its own
 * message, because a Zod message can quote the value it refused.
 */
function unexpectedFailureMessage(error: unknown): string {
  const issues = (
    error as { issues?: readonly { path?: readonly unknown[] }[] } | null
  )?.issues;
  if (Array.isArray(issues)) {
    const paths = [
      ...new Set(
        issues.map((issue) =>
          Array.isArray(issue.path) ? issue.path.join('.') : '',
        ),
      ),
    ]
      .filter((path) => path.length > 0)
      .sort();
    return `schema refused: ${paths.join(', ')}`;
  }
  if (!(error instanceof Error)) return 'no message';
  const message = error.message.trim().replace(/\s+/gu, ' ');
  if (message.length === 0) return 'no message';
  return message.length > UNEXPECTED_FAILURE_MESSAGE_LIMIT
    ? `${message.slice(0, UNEXPECTED_FAILURE_MESSAGE_LIMIT)}\u2026`
    : message;
}

function errorForUnknownFailure(error: unknown): CapabilityEngineError {
  if (error instanceof CapabilityEngineError) {
    return error;
  }
  if (
    error instanceof Error &&
    error.message ===
      'Only a human may execute lifecycle capabilities against a staff roster.'
  ) {
    return new CapabilityEngineError(
      'FORBIDDEN',
      'HUMAN_ONLY_REQUIRED',
      'This lifecycle action requires an authenticated human.',
      403,
    );
  }
  // The response deliberately says nothing about why: a capability failure can
  // hold a recipient, a token, or a provider payload. The operator still has to
  // be able to find out, and this used to be the end of the error's life --
  // every unexpected failure reached a person as one sentence with no way back
  // to a cause, which is why diagnosing one took a rebuild.
  //
  // The name and a bounded message go to the log, where an operator can read
  // them and a viewer of the response cannot. Values are never included; a Zod
  // failure contributes the field paths it refused, never what they held.
  console.error(
    JSON.stringify({
      event: 'capability-failed',
      error: error instanceof Error ? error.name : typeof error,
      message: unexpectedFailureMessage(error),
    }),
  );
  return new CapabilityEngineError(
    'INTERNAL_ERROR',
    'PERSISTENCE_CONFLICT',
    'The capability could not be completed.',
    500,
    true,
    error,
  );
}

function parseServerCapabilityInput<Id extends RegisteredCapabilityId>(
  capabilityId: Id,
  untrustedInput: unknown,
): CapabilityInput<Id> {
  try {
    return parseCapabilityInput(capabilityId, untrustedInput);
  } catch {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'CAPABILITY_INPUT_INVALID',
      'The capability input is invalid.',
      400,
    );
  }
}

/**
 * Performs the side-effect-free validation shared by canonical execution and
 * dependency preflights that must run before opening a transaction.
 */
export function preflightCapabilityInvocation<
  Id extends RegisteredCapabilityId,
>(
  capabilityId: Id,
  untrustedInput: unknown,
  untrustedInvocation: TrustedCapabilityInvocation,
): CapabilityInput<Id> {
  const invocation = validateTrustedInvocation(untrustedInvocation);
  const input = parseServerCapabilityInput(capabilityId, untrustedInput);
  assertInvocationAllowed(capabilityId, invocation);
  const definition = defineCapability(capabilityId);
  if (definition.operation === 'mutation') {
    assertStaticMutationEnvelope(
      capabilityId as RegisteredMutationCapabilityId,
      input,
      invocation,
    );
  } else if (invocation.mutation !== null) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'MUTATION_METADATA_INVALID',
      'Query capabilities cannot carry mutation metadata.',
      400,
    );
  }
  return input;
}

function validateConfirmation(
  record: HumanConfirmationRecord,
  invocation: TrustedCapabilityInvocation,
  capabilityId: RegisteredCapabilityId,
  requirement: HumanActionRequirement,
  currentTime: Date,
): HumanConfirmation {
  if (record.status !== 'issued') {
    throw new CapabilityEngineError(
      'CONFLICT',
      'CONFIRMATION_ALREADY_USED',
      'The human confirmation is no longer available.',
      409,
    );
  }
  const confirmation = record.confirmation;
  if (
    invocation.actor.kind !== 'human' ||
    confirmation.capabilityId !== capabilityId ||
    confirmation.confirmedByUserId !== invocation.actor.userId ||
    confirmation.confirmedWithSessionId !== invocation.actor.sessionId ||
    confirmation.connectivityEpochId !== invocation.connectivityEpochId ||
    confirmation.consequenceDigest !== requirement.consequenceDigest ||
    !sameStrings(confirmation.actionIds, requirement.actionIds)
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CONFIRMATION_INVALID',
      'The human confirmation does not authorize this request.',
      403,
    );
  }
  const at = currentTime.getTime();
  if (
    at < Date.parse(confirmation.issuedAt) ||
    at > Date.parse(confirmation.expiresAt)
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CONFIRMATION_INVALID',
      'The human confirmation has expired.',
      403,
    );
  }
  return confirmation;
}

function successAuditEvent(
  capabilityId: RegisteredCapabilityId,
  context: CapabilityHandlerContext<CapabilityEngineTransaction>,
): CapabilityAuditEvent {
  const authorization = requireCapabilityAuthorization(context);
  return {
    category:
      context.invocation.actor.kind === 'agent'
        ? 'agent-access'
        : 'capability-execution',
    action: capabilityId,
    actionIds: authorization.humanActionRequirement.actionIds,
    confirmationId: authorization.humanConfirmation?.id ?? null,
    outcome: 'success',
    actor: context.invocation.actor,
    source: context.invocation.source,
    facilityId: authorization.facilityId,
    requestId: context.invocation.requestId,
    reasonCode: null,
    occurredAt: context.invocation.serverTime,
  };
}

function failureAuditEvent(
  capabilityId: RegisteredCapabilityId,
  context: CapabilityFailureAuditContext,
  error: CapabilityEngineError,
): CapabilityAuditEvent {
  const actionIds =
    context.authorization?.humanActionRequirement.actionIds ??
    (context.safetyResolution === null
      ? []
      : deriveHumanOnlyActionIds(
          defineCapability(capabilityId).safetyEffect,
          context.safetyResolution,
        ));
  const isDenied = error.status === 401 || error.status === 403;
  const isHumanOnly =
    error.reasonCode === 'HUMAN_ONLY_REQUIRED' && actionIds.length > 0;
  return {
    category: isHumanOnly
      ? 'human-only-rejection'
      : isDenied
        ? 'access-denial'
        : 'capability-execution',
    action: capabilityId,
    actionIds,
    confirmationId: null,
    outcome: isDenied ? 'denied' : 'failure',
    actor: context.invocation.actor,
    source: context.invocation.source,
    facilityId: context.authorization?.facilityId ?? context.resolvedFacilityId,
    requestId: context.invocation.requestId,
    reasonCode: error.reasonCode,
    occurredAt: context.invocation.serverTime,
  };
}

async function authorizeExecution<
  Id extends RegisteredCapabilityId,
  Transaction extends CapabilityEngineTransaction,
>(
  registration: ServerCapabilityRegistration<Id, Transaction>,
  input: CapabilityInput<Id>,
  requirement: HumanActionRequirement,
  context: CapabilityHandlerContext<Transaction>,
): Promise<void> {
  const { invocation, transaction } = context;
  assertInvocationAllowed(registration.id, invocation);
  const facilityId = await registration.resolveFacilityId(input, context);
  context.resolvedFacilityId = facilityId;
  if (!scopeAllowsFacility(invocation.scope, facilityId)) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_SCOPE_DENIED',
      'The requested facility is outside the authenticated scope.',
      403,
    );
  }

  let confirmation: HumanConfirmation | null = null;
  if (requirement.actionIds.length > 0) {
    if (invocation.actor.kind !== 'human') {
      throw new CapabilityEngineError(
        'FORBIDDEN',
        'HUMAN_ONLY_REQUIRED',
        'This lifecycle action requires an authenticated human.',
        403,
      );
    }
    const confirmationId = invocation.mutation?.humanConfirmationId ?? null;
    if (confirmationId === null) {
      throw new CapabilityEngineError(
        'FORBIDDEN',
        'CONFIRMATION_REQUIRED',
        'A current human confirmation is required.',
        403,
      );
    }
    const record = await transaction.getHumanConfirmation(confirmationId);
    if (record === null) {
      throw new CapabilityEngineError(
        'FORBIDDEN',
        'CONFIRMATION_INVALID',
        'The human confirmation is invalid.',
        403,
      );
    }
    const authorizationTime = await readCapabilityTime(context);
    confirmation = validateConfirmation(
      HumanConfirmationRecordSchema.parse(record),
      invocation,
      registration.id,
      requirement,
      authorizationTime,
    );
    if (
      !(await transaction.consumeHumanConfirmation({
        confirmationId,
        requestId: invocation.requestId,
        consumedAt: authorizationTime,
      }))
    ) {
      throw new CapabilityEngineError(
        'CONFLICT',
        'CONFIRMATION_ALREADY_USED',
        'The human confirmation is no longer available.',
        409,
      );
    }
  } else if (
    invocation.mutation !== null &&
    invocation.mutation.humanConfirmationId !== null
  ) {
    throw new CapabilityEngineError(
      'VALIDATION_ERROR',
      'CONFIRMATION_INVALID',
      'This capability does not accept a human confirmation.',
      400,
    );
  }

  context.authorization = Object.freeze({
    facilityId,
    humanActionRequirement: requirement,
    humanConfirmation: confirmation,
  });

  const definition = defineCapability(registration.id);
  const serverTime = invocation.serverTime.toISOString();
  if (definition.operation === 'mutation') {
    if (invocation.mutation === null) {
      throw new CapabilityEngineError(
        'VALIDATION_ERROR',
        'MUTATION_METADATA_INVALID',
        'Mutation metadata is required.',
        400,
      );
    }
    if (
      invocation.principalKind !== 'pre-session-oidc' &&
      invocation.principalKind !== 'verified-refresh-credential'
    ) {
      MutationCapabilityEnvelopeSchema.parse({
        capabilityId: registration.id,
        operation: 'mutation',
        actor: invocation.actor,
        source: invocation.source,
        scope: invocation.scope,
        requestId: invocation.requestId,
        serverTime,
        input,
        idempotencyKey: invocation.mutation.idempotencyKey,
        transport: invocation.mutation.transport,
        connectivityEpochId: invocation.connectivityEpochId,
        requiredHumanActionIds: requirement.actionIds,
        requiredConsequenceDigest: requirement.consequenceDigest,
        humanConfirmation: confirmation,
      });
    }
  } else {
    if (invocation.mutation !== null) {
      throw new CapabilityEngineError(
        'VALIDATION_ERROR',
        'MUTATION_METADATA_INVALID',
        'Query capabilities cannot carry mutation metadata.',
        400,
      );
    }
    QueryCapabilityEnvelopeSchema.parse({
      capabilityId: registration.id,
      operation: 'query',
      actor: invocation.actor,
      source: invocation.source,
      scope: invocation.scope,
      requestId: invocation.requestId,
      serverTime,
      input,
    });
  }
}

function assertMutationRegistration<
  Id extends RegisteredCapabilityId,
  Transaction extends CapabilityEngineTransaction,
>(
  registration: ServerCapabilityRegistration<Id, Transaction>,
): asserts registration is ServerCapabilityRegistration<
  Id & RegisteredMutationCapabilityId,
  Transaction
> &
  Required<
    Pick<
      ServerCapabilityRegistration<Id, Transaction>,
      | 'loadReplay'
      | 'resolveReplayFacilityId'
      | 'resultReference'
      | 'replayFacilityId'
    >
  > {
  if (
    registration.resultReference === undefined ||
    registration.loadReplay === undefined ||
    registration.resolveReplayFacilityId === undefined ||
    registration.replayFacilityId === undefined
  ) {
    throw new CapabilityEngineError(
      'INTERNAL_ERROR',
      'IDEMPOTENCY_RESULT_UNAVAILABLE',
      'The mutation is missing replay persistence.',
      500,
    );
  }
}

/**
 * Runs a read-only capability through the canonical parser and authorizer.
 * The query-only generic prevents this lower tier from becoming a mutation
 * side door around the audited transactional engine.
 */
export function executeAuthorizedCapabilityQuery<
  Id extends RegisteredQueryCapabilityId,
  Context,
>(
  registration: RegisteredCapabilityHandler<Id, Context>,
  input: unknown,
  dependencies: CapabilityExecutionDependencies<Context>,
): Promise<CapabilityOutput<Id>> {
  return invokeAuthorizedCapabilityHandler(registration, input, dependencies);
}

/**
 * Executes the sole pre-session mutation whose session repository already
 * commits replay protection, session issuance, and access-gate audit in one
 * serializable transaction. The literal capability ID keeps this exception
 * from becoming a general mutation bypass.
 */
export function executeRepositoryAuditedOidcCompletion<Context>(
  registration: RegisteredCapabilityHandler<'complete-oidc-sign-in', Context>,
  input: unknown,
  dependencies: CapabilityExecutionDependencies<Context>,
): Promise<CapabilityOutput<'complete-oidc-sign-in'>> {
  return invokeAuthorizedCapabilityHandler(registration, input, dependencies);
}

type AuditedSessionReplayCapabilityId = 'refresh-session' | 'revoke-session';

interface AuditedSessionReplayInput<
  Id extends AuditedSessionReplayCapabilityId,
> {
  readonly capabilityId: Id;
  readonly actor: Extract<Actor, { readonly kind: 'human' }>;
  readonly source: Extract<InvocationSource, 'web' | 'mobile'>;
  readonly requestId: string;
  readonly serverTime: Date;
}

function sessionReplayAuditEvent<Id extends AuditedSessionReplayCapabilityId>(
  input: AuditedSessionReplayInput<Id>,
  outcome: Extract<SecurityAuditOutcome, 'success' | 'denied'>,
): CapabilityAuditEvent {
  const actor = ActorSchema.parse(input.actor);
  if (actor.kind !== 'human') {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'Only the authenticated human session may replay this capability.',
      403,
    );
  }
  const requestId = UuidSchema.parse(input.requestId);
  const occurredAt = new Date(
    TimestampSchema.parse(input.serverTime.toISOString()),
  );
  return Object.freeze({
    category: outcome === 'success' ? 'capability-execution' : 'access-denial',
    action: input.capabilityId,
    actionIds: [],
    confirmationId: null,
    outcome,
    actor,
    source: input.source,
    facilityId: null,
    requestId,
    reasonCode: outcome === 'success' ? null : 'CAPABILITY_INVOCATION_DENIED',
    occurredAt,
  });
}

/**
 * Records a fresh canonical success fact for one exact completed session
 * mutation replay. Keeping the two literal IDs here prevents this engine
 * entry point from becoming a general repository-owned mutation bypass.
 */
export function executeAuditedSessionReplaySuccess<
  Id extends AuditedSessionReplayCapabilityId,
  Transaction extends CapabilityEngineTransaction,
>(
  input: AuditedSessionReplayInput<Id>,
  store: CapabilityEngineStore<Transaction>,
): Promise<void> {
  const event = sessionReplayAuditEvent(input, 'success');
  return store.transaction((transaction) =>
    transaction.appendCapabilityAudit(event),
  );
}

/**
 * Commits the refresh-token replay security response and its canonical denial
 * fact together. The literal refresh ID and transaction callback keep the
 * lost-race security mutation inside the named capability engine boundary.
 */
export function executeAuditedRefreshReplayDenial<
  Transaction extends CapabilityEngineTransaction,
>(
  input: Omit<AuditedSessionReplayInput<'refresh-session'>, 'capabilityId'>,
  store: CapabilityEngineStore<Transaction>,
  recordSecurityResponse: (transaction: Transaction) => Promise<void>,
): Promise<void> {
  const event = sessionReplayAuditEvent(
    { ...input, capabilityId: 'refresh-session' },
    'denied',
  );
  return store.transaction(async (transaction) => {
    await recordSecurityResponse(transaction);
    await transaction.appendCapabilityAudit(event);
  });
}

/**
 * Executes one canonical capability through trusted actor resolution, central
 * safety resolution, scope authorization, idempotency, and append-only audit.
 */
export async function executeAuditedCapabilityTransaction<
  Id extends RegisteredCapabilityId,
  Transaction extends CapabilityEngineTransaction,
>(
  registration: ServerCapabilityRegistration<Id, Transaction>,
  untrustedInput: unknown,
  untrustedInvocation: TrustedCapabilityInvocation,
  store: CapabilityEngineStore<Transaction>,
): Promise<CapabilityOutput<Id>> {
  const invocation = validateTrustedInvocation(untrustedInvocation);
  const definition = defineCapability(registration.id);
  const committedFailure: {
    value: Readonly<{
      original: unknown;
      auditError: CapabilityEngineError;
    }> | null;
  } = { value: null };
  let auditContext: CapabilityFailureAuditContext = {
    invocation,
    authorization: null,
    resolvedFacilityId: null,
    safetyResolution: null,
  };

  try {
    const input = preflightCapabilityInvocation(
      registration.id,
      untrustedInput,
      invocation,
    );
    const output = await store.transaction(async (transaction) => {
      const transactionContext: CapabilityHandlerContext<Transaction> = {
        invocation,
        transaction,
        cache: new Map<string, unknown>(),
        authorization: null,
        resolvedFacilityId: null,
        safetyResolution: null,
      };
      auditContext = transactionContext;
      try {
        assertInvocationAllowed(registration.id, invocation);

        let idempotencyRecordId: string | null = null;
        if (definition.operation === 'mutation') {
          assertStaticMutationEnvelope(
            registration.id as RegisteredMutationCapabilityId,
            input,
            invocation,
          );
          const mutation = invocation.mutation;
          if (mutation === null) {
            throw new CapabilityEngineError(
              'VALIDATION_ERROR',
              'MUTATION_METADATA_INVALID',
              'Mutation metadata is required.',
              400,
            );
          }
          if (registration.mutationPersistence !== 'repository-owned') {
            assertMutationRegistration(registration);
            const parsedKey = IdempotencyKeySchema.parse(
              mutation.idempotencyKey,
            );
            const principalDigest = digestCapabilityValue(invocation.actor);
            const requestDigest = digestCapabilityValue({
              capabilityId: registration.id,
              input:
                registration.canonicalizeIdempotencyInput?.(input) ?? input,
            });
            const claim = await transaction.claimIdempotency({
              capabilityId: registration.id,
              actor: invocation.actor,
              principalDigest,
              key: parsedKey,
              requestDigest,
              createdAt: invocation.serverTime,
            });
            if (claim.kind !== 'new') {
              if (claim.requestDigest !== requestDigest) {
                throw new CapabilityEngineError(
                  'IDEMPOTENCY_CONFLICT',
                  'IDEMPOTENCY_REQUEST_MISMATCH',
                  'The idempotency key was already used for a different request.',
                  409,
                );
              }
              if (claim.kind === 'in-progress') {
                throw new CapabilityEngineError(
                  'CONFLICT',
                  'IDEMPOTENCY_IN_PROGRESS',
                  'The original request is still in progress.',
                  409,
                  true,
                );
              }
              if (claim.kind === 'failed') {
                throw new CapabilityEngineError(
                  'CONFLICT',
                  'IDEMPOTENCY_PREVIOUSLY_FAILED',
                  'The original request failed and will not be executed again.',
                  409,
                );
              }
              const facilityId = await registration.resolveReplayFacilityId(
                claim.resultReference,
                transactionContext,
              );
              transactionContext.resolvedFacilityId = facilityId;
              if (!scopeAllowsFacility(invocation.scope, facilityId)) {
                throw new CapabilityEngineError(
                  'FORBIDDEN',
                  'CAPABILITY_SCOPE_DENIED',
                  'The requested facility is outside the authenticated scope.',
                  403,
                );
              }
              const replay = parseCapabilityOutput(
                registration.id,
                await registration.loadReplay(
                  claim.resultReference,
                  transactionContext,
                ),
              );
              if (registration.replayFacilityId(replay) !== facilityId) {
                throw new CapabilityEngineError(
                  'INTERNAL_ERROR',
                  'IDEMPOTENCY_RESULT_UNAVAILABLE',
                  'The original result facility evidence is inconsistent.',
                  500,
                );
              }
              if (definition.auditPolicy === 'all-outcomes') {
                await transaction.appendCapabilityAudit({
                  category:
                    invocation.actor.kind === 'agent'
                      ? 'agent-access'
                      : 'capability-execution',
                  action: registration.id,
                  actionIds: [],
                  confirmationId: null,
                  outcome: 'success',
                  actor: invocation.actor,
                  source: invocation.source,
                  facilityId,
                  requestId: invocation.requestId,
                  reasonCode: null,
                  occurredAt: invocation.serverTime,
                });
              }
              return replay;
            }
            idempotencyRecordId = claim.recordId;
          }
        } else if (invocation.mutation !== null) {
          throw new CapabilityEngineError(
            'VALIDATION_ERROR',
            'MUTATION_METADATA_INVALID',
            'Query capabilities cannot carry mutation metadata.',
            400,
          );
        }

        const registeredHandler = registerCapabilityHandler(
          registration.id,
          registration.handler,
        );
        const output = await invokeAuthorizedCapabilityHandler(
          registeredHandler,
          input,
          {
            context: transactionContext,
            humanActionResolutionContext:
              definition.humanActionPolicy.kind === 'central'
                ? {
                    actor: invocation.actor,
                    source: invocation.source,
                    scope: invocation.scope,
                    requestId: invocation.requestId,
                    serverTime: invocation.serverTime.toISOString(),
                    connectivityEpochId: invocation.connectivityEpochId,
                  }
                : null,
            safetyResolver:
              definition.humanActionPolicy.kind === 'central'
                ? {
                    resolve: async (request) => {
                      if (registration.resolveSafety === undefined) {
                        throw new CapabilityEngineError(
                          'INTERNAL_ERROR',
                          'MUTATION_METADATA_INVALID',
                          'The protected capability has no safety resolver.',
                          500,
                        );
                      }
                      const facilityId = await registration.resolveFacilityId(
                        input,
                        transactionContext,
                      );
                      transactionContext.resolvedFacilityId = facilityId;
                      if (!scopeAllowsFacility(invocation.scope, facilityId)) {
                        throw new CapabilityEngineError(
                          'FORBIDDEN',
                          'CAPABILITY_SCOPE_DENIED',
                          'The requested facility is outside the authenticated scope.',
                          403,
                        );
                      }
                      const resolution = await registration.resolveSafety(
                        request,
                        transactionContext,
                      );
                      transactionContext.safetyResolution = resolution;
                      return resolution;
                    },
                  }
                : null,
            authorizer: {
              authorize: async ({ humanActionRequirement }) =>
                authorizeExecution(
                  registration,
                  input,
                  humanActionRequirement,
                  transactionContext,
                ),
            },
          },
        );

        if (definition.operation === 'mutation') {
          if (registration.mutationPersistence !== 'repository-owned') {
            assertMutationRegistration(registration);
            if (idempotencyRecordId === null) {
              throw new CapabilityEngineError(
                'INTERNAL_ERROR',
                'IDEMPOTENCY_RESULT_UNAVAILABLE',
                'The mutation did not reserve idempotency.',
                500,
              );
            }
            await transaction.completeIdempotency({
              recordId: idempotencyRecordId,
              resultReference: registration.resultReference(
                output,
                transactionContext,
              ),
              completedAt: invocation.serverTime,
            });
          }
        }

        if (definition.auditPolicy === 'all-outcomes') {
          await transaction.appendCapabilityAudit(
            successAuditEvent(
              registration.id,
              transactionContext as CapabilityHandlerContext<CapabilityEngineTransaction>,
            ),
          );
        }
        return output;
      } catch (error) {
        const disposition = registration.classifyRepositoryError?.(error);
        if (
          registration.mutationPersistence === 'repository-owned' &&
          disposition?.commitTransaction === true
        ) {
          await transaction.appendCapabilityAudit(
            failureAuditEvent(
              registration.id,
              transactionContext,
              disposition.auditError,
            ),
          );
          committedFailure.value = Object.freeze({
            original: error,
            auditError: disposition.auditError,
          });
          return undefined as CapabilityOutput<Id>;
        }
        throw error;
      }
    });
    if (committedFailure.value !== null) {
      throw committedFailure.value.original;
    }
    return output;
  } catch (error) {
    if (
      committedFailure.value !== null &&
      error === committedFailure.value.original
    ) {
      throw error;
    }
    const disposition = registration.classifyRepositoryError?.(error);
    const engineError =
      disposition?.auditError ?? errorForUnknownFailure(error);
    try {
      const event = failureAuditEvent(
        registration.id,
        auditContext,
        engineError,
      );
      await store.appendCapabilityAudit(event);
    } catch {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'PERSISTENCE_CONFLICT',
        'The capability was denied and its audit evidence could not be recorded.',
        500,
        true,
      );
    }
    throw disposition === null || disposition === undefined
      ? engineError
      : error;
  }
}
