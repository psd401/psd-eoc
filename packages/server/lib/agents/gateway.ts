import {
  HUMAN_ONLY_ACTION_IDS,
  defineCapability,
  isAgentGrantableCapabilityId,
  isHumanOnlyActionId,
  parseCapabilityInput,
  parseCapabilityOutput,
  type AgentGrantableCapabilityId,
  type HumanOnlyActionId,
} from '@psd-eoc/contracts';
import { ZodError } from 'zod';

import type {
  CapabilityAuditEvent,
  TrustedCapabilityInvocation,
} from '../capabilities/engine';
import type { AgentApiKeyService, AuthenticatedAgentApiKey } from './keys';

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

/** Append-only audit boundary used for denials before capability dispatch. */
export interface AgentGatewayAuditSink {
  append(
    event: CapabilityAuditEvent,
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

function auditFacilityId(
  authenticated: AuthenticatedAgentApiKey,
): string | null {
  const scope = authenticated.scope.facilityScope;
  return scope.kind === 'facilities' && scope.facilityIds.length === 1
    ? (scope.facilityIds[0] ?? null)
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
): CapabilityAuditEvent {
  return Object.freeze({
    category: outcome === 'denied' ? 'access-denial' : 'agent-access',
    action: call.capabilityId,
    actionIds: [],
    confirmationId: null,
    outcome,
    actor: call.authenticated.actor,
    source: 'agent-rest',
    facilityId: auditFacilityId(call.authenticated),
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
    const authenticated = await this.dependencies.keys.authenticate(
      request.credential,
    );

    if (isHumanOnlyActionId(request.capabilityId)) {
      const actionId = request.capabilityId;
      await this.dependencies.audit.append(
        denialAudit(authenticated, {
          capabilityId: protectedActionCapability[actionId],
          actionIds: [actionId],
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
        request.capabilityId,
      );
    } catch (error) {
      if (isAgentGrantableCapabilityId(request.capabilityId)) {
        await this.dependencies.audit.append(
          denialAudit(authenticated, {
            capabilityId: request.capabilityId,
            actionIds: [],
            requestId: request.requestId,
            serverTime: request.serverTime,
            reasonCode: 'CAPABILITY_NOT_GRANTED',
          }),
        );
      }
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
        executionAudit(call, 'success', null),
        auditOptions,
      );
      return parsed;
    } catch (error) {
      const outcome = auditOutcome(error);
      await this.dependencies.audit.append(
        executionAudit(call, outcome, auditReasonCode(error)),
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
