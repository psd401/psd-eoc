import { randomUUID } from 'node:crypto';

import type { AgentGrantableCapabilityId } from '@psd-eoc/contracts';

import {
  executeQuerySecurityAuditCapability,
  executeVerifySecurityAuditChainCapability,
  type SecurityAuditService,
} from '../audit';
import {
  executeGetEventTypeDraftCapability,
  executeGetEventTypeVersionCapability,
  executeListEventTypesCapability,
  executePreviewEventTypeRenderingCapability,
  type AuthenticatedEventTypeAgent,
  type EventTypeStore,
} from '../capabilities/event-types';
import {
  CapabilityEngineError,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import type { EventCapabilityRuntime } from '../capabilities/events';
import type { AgentCapabilityDispatcher } from './gateway';
import type { AuthenticatedAgentApiKey } from './keys';
import { isAgentDeployedCapabilityId } from './availability';
import {
  executePreparedActivationCapability,
  type PreparedActivationCapabilityStore,
} from './prepared-activation';

export interface DefaultAgentCapabilityDispatcherDependencies {
  readonly events: EventCapabilityRuntime;
  readonly eventTypes: EventTypeStore;
  readonly preparedActivations: PreparedActivationCapabilityStore;
  readonly securityAudit: SecurityAuditService;
}

/** Stable bounded failure while a catalog capability awaits its owning issue. */
export class AgentCapabilityUnavailableError extends Error {
  public readonly code = 'INTERNAL_ERROR' as const;
  public readonly status = 503 as const;
  public readonly retryable = false as const;

  public constructor(public readonly capabilityId: AgentGrantableCapabilityId) {
    super('The agent capability is not available in this deployment.');
    this.name = 'AgentCapabilityUnavailableError';
  }
}

const canonicallyAuditedCapabilityIds = new Set<AgentGrantableCapabilityId>([
  'start-event',
  'join-event',
  'all-clear-event',
  'reactivate-event',
  'close-event',
  'reopen-as-correction',
  'list-active-events',
  'get-event',
  'prepare-activation',
  'get-prepared-activation',
  'query-security-audit',
  'verify-security-audit-chain',
]);

function eventTypeAgent(
  authenticated: AuthenticatedAgentApiKey,
): AuthenticatedEventTypeAgent {
  return Object.freeze({
    actor: authenticated.actor,
    source: 'agent-rest',
    scope: authenticated.scope,
    grantedCapabilityIds: authenticated.capabilityIds,
  });
}

function agentPolicyQueryInvocation(
  invocation: TrustedCapabilityInvocation,
): TrustedCapabilityInvocation {
  return Object.freeze({
    ...invocation,
    requestId: randomUUID(),
    mutation: null,
  });
}

/**
 * Production dispatcher. Event lifecycle and prepared intents use the shared
 * server engine (and self-audit atomically); the REST gateway records one
 * ingress audit for every authenticated call around this dispatcher.
 */
export function createDefaultAgentCapabilityDispatcher(
  dependencies: DefaultAgentCapabilityDispatcherDependencies,
): AgentCapabilityDispatcher {
  return Object.freeze({
    auditOwnership(capabilityId: AgentGrantableCapabilityId) {
      return canonicallyAuditedCapabilityIds.has(capabilityId)
        ? 'canonical'
        : 'gateway';
    },
    async execute(
      capabilityId: AgentGrantableCapabilityId,
      input: unknown,
      invocation: TrustedCapabilityInvocation,
      authenticated: AuthenticatedAgentApiKey,
    ): Promise<unknown> {
      if (!isAgentDeployedCapabilityId(capabilityId)) {
        throw new AgentCapabilityUnavailableError(capabilityId);
      }
      switch (capabilityId) {
        case 'start-event':
        case 'join-event':
        case 'all-clear-event':
        case 'reactivate-event':
        case 'reopen-as-correction':
        case 'list-active-events':
        case 'get-event':
          return dependencies.events.execute(capabilityId, input, invocation);

        case 'close-event': {
          const event = await dependencies.events.execute(
            'get-event',
            { eventId: (input as { readonly eventId: string }).eventId },
            agentPolicyQueryInvocation(invocation),
          );
          if (event.rosterPopulation === 'staff') {
            throw new CapabilityEngineError(
              'FORBIDDEN',
              'HUMAN_ONLY_REQUIRED',
              'Closing an event that targets staff requires an authenticated human.',
              403,
            );
          }
          return dependencies.events.execute(capabilityId, input, invocation);
        }

        case 'prepare-activation':
        case 'get-prepared-activation':
          return executePreparedActivationCapability(
            capabilityId,
            input,
            invocation,
            dependencies.preparedActivations,
          );

        case 'list-event-types':
          return executeListEventTypesCapability({
            store: dependencies.eventTypes,
            authenticated: eventTypeAgent(authenticated),
            query: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        case 'get-event-type-version':
          return executeGetEventTypeVersionCapability({
            store: dependencies.eventTypes,
            authenticated: eventTypeAgent(authenticated),
            query: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        case 'get-event-type-draft':
          return executeGetEventTypeDraftCapability({
            store: dependencies.eventTypes,
            authenticated: eventTypeAgent(authenticated),
            query: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        case 'preview-event-type-rendering':
          return executePreviewEventTypeRenderingCapability({
            store: dependencies.eventTypes,
            authenticated: eventTypeAgent(authenticated),
            query: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        case 'query-security-audit':
          return executeQuerySecurityAuditCapability({
            service: dependencies.securityAudit,
            access: {
              actor: authenticated.actor,
              source: 'agent-rest',
              facilityScope: authenticated.scope.facilityScope,
              roles: [],
              capabilityGrants: authenticated.capabilityIds,
            },
            query: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        case 'verify-security-audit-chain':
          return executeVerifySecurityAuditChainCapability({
            service: dependencies.securityAudit,
            access: {
              actor: authenticated.actor,
              source: 'agent-rest',
              facilityScope: authenticated.scope.facilityScope,
              roles: [],
              capabilityGrants: authenticated.capabilityIds,
            },
            verification: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
      }
    },
  });
}
