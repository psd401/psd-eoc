import {
  executeCapability,
  parseCapabilityEnvelopeFor,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type RegisteredCapabilityId,
  type RosterHealthQuery,
  type StaleRosterReport,
} from '@psd-eoc/contracts';

import {
  createGetStaleRosterReportHandler,
  type StaleRosterAuthorizationContext,
  type StaleRosterReportStore,
} from '../roster/stale-report';
import {
  CapabilityEngineError,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import type { AuthenticatedAgentApiKey } from './keys';

/** Deployment-default freshness window used by every agent roster-health read. */
export const AGENT_ROSTER_STALE_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

interface AgentRosterReportContext extends StaleRosterAuthorizationContext {
  readonly authenticated: AuthenticatedAgentApiKey;
  readonly invocation: TrustedCapabilityInvocation;
}

export interface AgentRosterReportDependencies {
  readonly store: StaleRosterReportStore<StaleRosterAuthorizationContext>;
  readonly staleThresholdSeconds?: number;
}

export interface AgentRosterReportRuntime {
  execute(
    input: unknown,
    invocation: TrustedCapabilityInvocation,
    authenticated: AuthenticatedAgentApiKey,
  ): Promise<StaleRosterReport>;
}

function scopeDenied(): CapabilityEngineError {
  return new CapabilityEngineError(
    'FORBIDDEN',
    'CAPABILITY_SCOPE_DENIED',
    'The roster-health query is outside the agent API key facility scope.',
    403,
  );
}

function invocationDenied(): CapabilityEngineError {
  return new CapabilityEngineError(
    'FORBIDDEN',
    'CAPABILITY_INVOCATION_DENIED',
    'The roster-health capability invocation was not authorized.',
    403,
  );
}

function sameAgent(
  authenticated: AuthenticatedAgentApiKey,
  invocation: TrustedCapabilityInvocation,
): boolean {
  return (
    invocation.actor.kind === 'agent' &&
    invocation.actor.agentId === authenticated.actor.agentId &&
    invocation.actor.apiKeyId === authenticated.actor.apiKeyId
  );
}

const authorizer: CapabilityExecutionAuthorizer<AgentRosterReportContext> =
  Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        AgentRosterReportContext
      >,
    ): void {
      const { authenticated, invocation } = request.context;
      if (
        request.definition.id !== 'get-stale-roster-report' ||
        invocation.source !== 'agent-rest' ||
        invocation.mutation !== null ||
        !sameAgent(authenticated, invocation) ||
        !request.invocationPolicy.principalKinds.includes('agent') ||
        !request.invocationPolicy.sources.includes('agent-rest') ||
        !authenticated.capabilityIds.includes('get-stale-roster-report') ||
        request.humanActionRequirement.actionIds.length !== 0
      ) {
        throw invocationDenied();
      }

      const facilityId =
        typeof request.input === 'object' &&
        request.input !== null &&
        'facilityId' in request.input &&
        (typeof request.input.facilityId === 'string' ||
          request.input.facilityId === null)
          ? request.input.facilityId
          : null;
      const scope = authenticated.scope.facilityScope;
      if (
        scope.kind === 'facilities' &&
        (facilityId === null || !scope.facilityIds.includes(facilityId))
      ) {
        throw scopeDenied();
      }
    },
  });

/**
 * Executes the canonical stale-roster handler with agent identity and facility
 * scope held exclusively in trusted server context.
 */
export function createAgentRosterReportRuntime(
  dependencies: AgentRosterReportDependencies,
): AgentRosterReportRuntime {
  return Object.freeze({
    async execute(
      input: unknown,
      invocation: TrustedCapabilityInvocation,
      authenticated: AuthenticatedAgentApiKey,
    ): Promise<StaleRosterReport> {
      const envelope = parseCapabilityEnvelopeFor('get-stale-roster-report', {
        capabilityId: 'get-stale-roster-report',
        operation: 'query',
        actor: invocation.actor,
        source: invocation.source,
        scope: invocation.scope,
        requestId: invocation.requestId,
        serverTime: invocation.serverTime.toISOString(),
        input,
      });
      const context: AgentRosterReportContext = Object.freeze({
        authenticated,
        invocation,
        facilityScope: authenticated.scope.facilityScope,
      });
      const handler = createGetStaleRosterReportHandler({
        store: Object.freeze({
          loadScopedEvidence: (
            query: RosterHealthQuery,
            authorizedContext: StaleRosterAuthorizationContext,
          ) =>
            dependencies.store.loadScopedEvidence(query, {
              facilityScope: authorizedContext.facilityScope,
            }),
        }),
        clock: () => new Date(invocation.serverTime.getTime()),
        staleThresholdSeconds:
          dependencies.staleThresholdSeconds ??
          AGENT_ROSTER_STALE_THRESHOLD_SECONDS,
      });
      return executeCapability(handler, envelope.input, {
        context,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer,
      });
    },
  });
}
