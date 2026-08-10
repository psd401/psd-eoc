import {
  FacilityIdSchema,
  HUMAN_ONLY_ACTION_IDS,
  defineCapability,
  isAgentGrantableCapabilityId,
  isHumanOnlyActionId,
  parseCapabilityInput,
  parseCapabilityOutput,
  type AgentGrantableCapabilityId,
  type HumanOnlyActionId,
  type UnauthenticatedAuditPrincipal,
} from '@psd-eoc/contracts';
import { ZodError } from 'zod';

import type {
  CapabilityAuditEvent,
  TrustedCapabilityInvocation,
} from '../capabilities/engine';
import {
  AgentApiKeyError,
  digestAgentApiKeyAuditSubject,
  type AgentApiKeyService,
  type AuthenticatedAgentApiKey,
} from './keys';

const protectedActionCapability = Object.freeze({
  'start-real-incident': 'start-event',
  'send-real-notification': 'start-event',
  'all-clear': 'all-clear-event',
  'close-real-event': 'close-event',
} as const satisfies Record<HumanOnlyActionId, AgentGrantableCapabilityId>);

export interface AgentCapabilityDispatcher {
  /** Dispatches through the canonical capability implementation. */
  auditOwnership(
    capabilityId: AgentGrantableCapabilityId,
  ): 'canonical' | 'gateway';
  execute(
    capabilityId: AgentGrantableCapabilityId,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
    authenticated: AuthenticatedAgentApiKey,
  ): Promise<unknown>;
}

export interface AgentGatewayAuditAppendOptions {
  /** A canonical handler may already have persisted this request's fact. */
  readonly acceptCanonicalRequestAudit: boolean;
}

/** Pre-authentication denial using the canonical minimized principal shape. */
export interface UnauthenticatedAgentGatewayAuditEvent
  extends Omit<CapabilityAuditEvent, 'actor'> {
  readonly principal: UnauthenticatedAuditPrincipal;
}

export type AgentGatewayAuditEvent =
  | CapabilityAuditEvent
  | UnauthenticatedAgentGatewayAuditEvent;

/** Append-only audit boundary used for denials before capability dispatch. */
export interface AgentGatewayAuditSink {
  append(
    event: AgentGatewayAuditEvent,
    options?: AgentGatewayAuditAppendOptions,
  ): Promise<void>;
}

export interface AgentGatewayDependencies {
  readonly keys: Pick<
    AgentApiKeyService,
    'authenticate' | 'authorizeCapability'
  >;
  readonly dispatcher: AgentCapabilityDispatcher;
  readonly audit: AgentGatewayAuditSink;
}

export interface AgentGatewayRequest {
  readonly credential: string;
  readonly capabilityId: string;
  readonly input: unknown;
  readonly idempotencyKey: string | null;
  readonly requestId: string;
  readonly serverTime: Date;
}

/** Authenticated and grant-authorized identity for one canonical REST call. */
export interface AuthorizedAgentGatewayCall {
  readonly authenticated: AuthenticatedAgentApiKey;
  readonly capabilityId: AgentGrantableCapabilityId;
  readonly requestId: string;
  readonly serverTime: Date;
}

export interface PreparedAgentGatewayRequest {
  readonly input: unknown;
  readonly idempotencyKey: string | null;
}

/** Public-safe gateway denial before any capability handler is selected. */
export class AgentGatewayError extends Error {
  public readonly code = 'FORBIDDEN' as const;
  public readonly status = 403 as const;
  public readonly retryable = false as const;

  public constructor(
    public readonly reasonCode:
      | 'CAPABILITY_NOT_GRANTED'
      | 'HUMAN_ONLY_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'AgentGatewayError';
  }
}

/** Unknown route IDs are rejected before they can become agent calls. */
export class AgentGatewayCapabilityNotFoundError extends Error {
  public readonly code = 'NOT_FOUND' as const;
  public readonly status = 404 as const;
  public readonly retryable = false as const;

  public constructor() {
    super('The requested agent capability route does not exist.');
    this.name = 'AgentGatewayCapabilityNotFoundError';
  }
}

/** Canonical implementation returned data that violated its output contract. */
export class AgentGatewayOutputError extends Error {
  public readonly code = 'INTERNAL_ERROR' as const;
  public readonly status = 500 as const;
  public readonly retryable = false as const;
  public readonly reasonCode = 'AGENT_CAPABILITY_OUTPUT_INVALID' as const;

  public constructor() {
    super('The agent capability returned an invalid server result.');
    this.name = 'AgentGatewayOutputError';
  }
}

interface ResolvedAgentGatewayRoute {
  readonly capabilityId: AgentGrantableCapabilityId;
  readonly actionIds: readonly HumanOnlyActionId[];
}

function resolveAgentGatewayRoute(
  capabilityId: string,
): ResolvedAgentGatewayRoute {
  if (isHumanOnlyActionId(capabilityId)) {
    return Object.freeze({
      capabilityId: protectedActionCapability[capabilityId],
      actionIds: Object.freeze([capabilityId]),
    });
  }
  if (isAgentGrantableCapabilityId(capabilityId)) {
    return Object.freeze({ capabilityId, actionIds: Object.freeze([]) });
  }
  throw new AgentGatewayCapabilityNotFoundError();
}

function authenticationDenialAudit(
  request: Pick<AgentGatewayRequest, 'credential' | 'requestId' | 'serverTime'>,
  route: ResolvedAgentGatewayRoute,
): UnauthenticatedAgentGatewayAuditEvent {
  return Object.freeze({
    category:
      route.actionIds.length === 0 ? 'access-denial' : 'human-only-rejection',
    action: route.capabilityId,
    actionIds: route.actionIds,
    confirmationId: null,
    outcome: 'denied',
    principal: Object.freeze({
      kind: 'unauthenticated' as const,
      subjectDigest: digestAgentApiKeyAuditSubject(request.credential),
    }),
    source: 'agent-rest',
    facilityId: null,
    requestId: request.requestId,
    reasonCode: 'INVALID_CREDENTIAL',
    occurredAt: request.serverTime,
  });
}

function auditFacilityId(
  authenticated: AuthenticatedAgentApiKey,
  targetFacilityId: string | null = null,
): string | null {
  const scope = authenticated.scope.facilityScope;
  if (
    targetFacilityId !== null &&
    (scope.kind === 'district' || scope.facilityIds.includes(targetFacilityId))
  ) {
    return targetFacilityId;
  }
  return scope.kind === 'facilities' && scope.facilityIds.length === 1
    ? (scope.facilityIds[0] ?? null)
    : null;
}

function directFacilityId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const parsed = FacilityIdSchema.safeParse(Reflect.get(value, 'facilityId'));
  return parsed.success ? parsed.data : null;
}

/** Returns one unambiguous contract-parsed target without inventing scope. */
function auditTargetFacilityId(...values: readonly unknown[]): string | null {
  const candidates = new Set<string>();
  for (const value of values) {
    const direct = directFacilityId(value);
    if (direct !== null) candidates.add(direct);
    if (typeof value !== 'object' || value === null) continue;
    for (const key of ['event', 'preview'] as const) {
      const nested = directFacilityId(Reflect.get(value, key));
      if (nested !== null) candidates.add(nested);
    }
  }
  return candidates.size === 1
    ? (candidates.values().next().value ?? null)
    : null;
}

function denialAudit(
  authenticated: AuthenticatedAgentApiKey,
  input: Readonly<{
    capabilityId: AgentGrantableCapabilityId;
    actionIds: readonly HumanOnlyActionId[];
    requestId: string;
    serverTime: Date;
    reasonCode: 'CAPABILITY_NOT_GRANTED' | 'HUMAN_ONLY_REQUIRED';
  }>,
): CapabilityAuditEvent {
  return Object.freeze({
    category:
      input.reasonCode === 'HUMAN_ONLY_REQUIRED'
        ? 'human-only-rejection'
        : 'access-denial',
    action: input.capabilityId,
    actionIds: input.actionIds,
    confirmationId: null,
    outcome: 'denied',
    actor: authenticated.actor,
    source: 'agent-rest',
    facilityId: auditFacilityId(authenticated),
    requestId: input.requestId,
    reasonCode: input.reasonCode,
    occurredAt: input.serverTime,
  });
}

function agentInvocation(
  authenticated: AuthenticatedAgentApiKey,
  request: AgentGatewayRequest,
  capabilityId: AgentGrantableCapabilityId,
): TrustedCapabilityInvocation {
  const definition = defineCapability(capabilityId);
  return Object.freeze({
    actor: authenticated.actor,
    source: 'agent-rest',
    scope: authenticated.scope,
    requestId: request.requestId,
    serverTime: request.serverTime,
    connectivityEpochId: null,
    mutation:
      definition.operation === 'mutation'
        ? Object.freeze({
            idempotencyKey: request.idempotencyKey ?? '',
            transport: Object.freeze({
              kind: 'agent-rest-command' as const,
              method: 'POST' as const,
            }),
            humanConfirmationId: null,
          })
        : null,
  });
}

function auditReasonCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    for (const key of ['reasonCode', 'code'] as const) {
      const value = Reflect.get(error, key);
      if (
        typeof value === 'string' &&
        value.length <= 100 &&
        /^[A-Z0-9_]+$/u.test(value)
      ) {
        return value;
      }
    }
  }
  return error instanceof TypeError ||
    error instanceof SyntaxError ||
    (typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'name') === 'ZodError')
    ? 'AGENT_REQUEST_INVALID'
    : 'AGENT_CAPABILITY_FAILED';
}

function auditOutcome(error: unknown): 'denied' | 'failure' {
  if (typeof error !== 'object' || error === null) return 'failure';
  const status = Reflect.get(error, 'status');
  return status === 401 || status === 403 ? 'denied' : 'failure';
}

function executionAudit(
  call: AuthorizedAgentGatewayCall,
  outcome: 'success' | 'denied' | 'failure',
  reasonCode: string | null,
  targetFacilityId: string | null,
): CapabilityAuditEvent {
  return Object.freeze({
    category: outcome === 'denied' ? 'access-denial' : 'agent-access',
    action: call.capabilityId,
    actionIds: [],
    confirmationId: null,
    outcome,
    actor: call.authenticated.actor,
    source: 'agent-rest',
    facilityId: auditFacilityId(call.authenticated, targetFacilityId),
    requestId: call.requestId,
    reasonCode,
    occurredAt: call.serverTime,
  });
}

/**
 * Authenticates, applies the persisted capability grant, rejects protected
 * action aliases, and dispatches with server-owned agent identity and scope.
 */
export class AgentRestGateway {
  public constructor(private readonly dependencies: AgentGatewayDependencies) {}

  /** Authenticates first so all later parsing and execution has an audit identity. */
  public async authorize(
    request: Pick<
      AgentGatewayRequest,
      'credential' | 'capabilityId' | 'requestId' | 'serverTime'
    >,
  ): Promise<AuthorizedAgentGatewayCall> {
    const route = resolveAgentGatewayRoute(request.capabilityId);
    let authenticated: AuthenticatedAgentApiKey;
    try {
      authenticated = await this.dependencies.keys.authenticate(
        request.credential,
      );
    } catch (error) {
      if (
        error instanceof AgentApiKeyError &&
        error.code === 'INVALID_CREDENTIAL'
      ) {
        await this.dependencies.audit.append(
          authenticationDenialAudit(request, route),
        );
      }
      throw error;
    }

    if (route.actionIds.length > 0) {
      await this.dependencies.audit.append(
        denialAudit(authenticated, {
          capabilityId: route.capabilityId,
          actionIds: route.actionIds,
          requestId: request.requestId,
          serverTime: request.serverTime,
          reasonCode: 'HUMAN_ONLY_REQUIRED',
        }),
      );
      throw new AgentGatewayError(
        'HUMAN_ONLY_REQUIRED',
        'This action requires an authenticated human in PSD EOC.',
      );
    }

    let capabilityId: AgentGrantableCapabilityId;
    try {
      capabilityId = this.dependencies.keys.authorizeCapability(
        authenticated,
        route.capabilityId,
      );
    } catch (error) {
      await this.dependencies.audit.append(
        denialAudit(authenticated, {
          capabilityId: route.capabilityId,
          actionIds: [],
          requestId: request.requestId,
          serverTime: request.serverTime,
          reasonCode: 'CAPABILITY_NOT_GRANTED',
        }),
      );
      throw error;
    }

    return Object.freeze({
      authenticated,
      capabilityId,
      requestId: request.requestId,
      serverTime: request.serverTime,
    });
  }

  /**
   * Parses and executes only after authorization, appending one ingress audit
   * for every authenticated canonical call, including validation failures.
   */
  public async executeAuthorized(
    call: AuthorizedAgentGatewayCall,
    prepare: () => Promise<PreparedAgentGatewayRequest>,
  ): Promise<unknown> {
    const auditOptions =
      this.dependencies.dispatcher.auditOwnership(call.capabilityId) ===
      'canonical'
        ? Object.freeze({ acceptCanonicalRequestAudit: true })
        : undefined;
    let targetFacilityId: string | null = null;
    try {
      const request = await prepare();
      const definition = defineCapability(call.capabilityId);
      if (
        (definition.operation === 'mutation') !==
        (request.idempotencyKey !== null)
      ) {
        throw new TypeError(
          definition.operation === 'mutation'
            ? 'Agent mutations require an idempotency key.'
            : 'Agent queries cannot carry an idempotency key.',
        );
      }
      const parsedInput = parseCapabilityInput(
        call.capabilityId,
        request.input,
      );
      targetFacilityId = auditTargetFacilityId(parsedInput);

      const invocation = agentInvocation(
        call.authenticated,
        {
          credential: '',
          capabilityId: call.capabilityId,
          input: parsedInput,
          idempotencyKey: request.idempotencyKey,
          requestId: call.requestId,
          serverTime: call.serverTime,
        },
        call.capabilityId,
      );
      let parsed: unknown;
      try {
        const output = await this.dependencies.dispatcher.execute(
          call.capabilityId,
          parsedInput,
          invocation,
          call.authenticated,
        );
        parsed = parseCapabilityOutput(call.capabilityId, output);
        targetFacilityId = auditTargetFacilityId(parsedInput, parsed);
      } catch (error) {
        if (
          error instanceof ZodError ||
          error instanceof TypeError ||
          error instanceof SyntaxError
        ) {
          throw new AgentGatewayOutputError();
        }
        throw error;
      }
      await this.dependencies.audit.append(
        executionAudit(call, 'success', null, targetFacilityId),
        auditOptions,
      );
      return parsed;
    } catch (error) {
      const outcome = auditOutcome(error);
      await this.dependencies.audit.append(
        executionAudit(call, outcome, auditReasonCode(error), targetFacilityId),
        auditOptions,
      );
      throw error;
    }
  }

  public async execute(request: AgentGatewayRequest): Promise<unknown> {
    const call = await this.authorize(request);

    return this.executeAuthorized(call, async () => ({
      input: request.input,
      idempotencyKey: request.idempotencyKey,
    }));
  }
}

/** Compile-time/runtime guard kept beside the REST gateway, not its manifest. */
export const AGENT_GATEWAY_PROTECTED_ACTION_IDS = Object.freeze([
  ...HUMAN_ONLY_ACTION_IDS,
]);
