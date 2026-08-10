import type { AgentGrantableCapabilityId } from '@psd-eoc/contracts';

import {
  executeQuerySecurityAuditCapability,
  executeVerifySecurityAuditChainCapability,
  type SecurityAuditService,
} from '../audit';
import {
  executeCreateEventTypeDraftCapability,
  executeGetEventTypeDraftCapability,
  executeGetEventTypeVersionCapability,
  executeListEventTypesCapability,
  executePreviewEventTypeRenderingCapability,
  executePublishEventTypeVersionCapability,
  executeUpdateEventTypeDraftCapability,
  type AuthenticatedEventTypeAgent,
  type EventTypeStore,
} from '../capabilities/event-types';
import type { TrustedCapabilityInvocation } from '../capabilities/engine';
import type { EventCapabilityRuntime } from '../capabilities/events';
import type { JournalCapabilityRuntime } from '../capabilities/journal';
import {
  agentApiKeyAdministrationAccessFromAgent,
  type AgentApiKeyAdministration,
} from './admin-capabilities';
import type { AgentAdministrationFacilityCapabilities } from './admin-facilities';
import type { AgentCapabilityDispatcher } from './gateway';
import type { AuthenticatedAgentApiKey } from './keys';
import { isAgentDeployedCapabilityId } from './availability';
import {
  executePreparedActivationCapability,
  type PreparedActivationCapabilityStore,
} from './prepared-activation';
import type { AgentRosterReportRuntime } from './roster-report';

export interface DefaultAgentCapabilityDispatcherDependencies {
  readonly events: EventCapabilityRuntime;
  readonly journal: JournalCapabilityRuntime;
  readonly administration: AgentApiKeyAdministration;
  readonly administrationFacilities: AgentAdministrationFacilityCapabilities;
  readonly eventTypes: EventTypeStore;
  readonly preparedActivations: PreparedActivationCapabilityStore;
  readonly rosterReport: AgentRosterReportRuntime;
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
  'append-journal-entry',
  'correct-journal-entry',
  'redact-journal-entry',
  'list-journal-entries',
  'create-lifecycle-consequence-preview',
  'get-facility',
  'prepare-activation',
  'get-prepared-activation',
  'create-event-type-draft',
  'update-event-type-draft',
  'publish-event-type-version',
  'query-security-audit',
  'verify-security-audit-chain',
  'list-agent-api-keys',
  'list-facilities',
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

function agentEventTypeMutation(
  invocation: TrustedCapabilityInvocation,
): Readonly<{
  idempotencyKey: string;
  transport: Extract<
    NonNullable<TrustedCapabilityInvocation['mutation']>['transport'],
    { readonly kind: 'agent-rest-command' }
  >;
}> {
  const mutation = invocation.mutation;
  if (mutation === null || mutation.transport.kind !== 'agent-rest-command') {
    throw new TypeError(
      'An agent event-type mutation requires verified REST mutation metadata.',
    );
  }
  return Object.freeze({
    idempotencyKey: mutation.idempotencyKey,
    transport: mutation.transport,
  });
}

function unhandledCapability(value: never): never {
  throw new AgentCapabilityUnavailableError(value);
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
        case 'close-event':
        case 'reopen-as-correction':
        case 'list-active-events':
        case 'get-event':
          return dependencies.events.execute(capabilityId, input, invocation);

        case 'append-journal-entry':
        case 'correct-journal-entry':
        case 'redact-journal-entry':
        case 'list-journal-entries':
        case 'create-lifecycle-consequence-preview':
        case 'get-facility':
          return dependencies.journal.execute(capabilityId, input, invocation);

        case 'prepare-activation':
        case 'get-prepared-activation':
          return executePreparedActivationCapability(
            capabilityId,
            input,
            invocation,
            dependencies.preparedActivations,
          );

        case 'get-stale-roster-report':
          return dependencies.rosterReport.execute(
            input,
            invocation,
            authenticated,
          );

        case 'list-agent-api-keys':
          return dependencies.administration.list({
            access: agentApiKeyAdministrationAccessFromAgent(authenticated),
            value: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });

        case 'list-facilities':
          return dependencies.administrationFacilities.list({
            access: agentApiKeyAdministrationAccessFromAgent(authenticated),
            value: input as never,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });

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
        case 'create-event-type-draft': {
          const mutation = agentEventTypeMutation(invocation);
          return executeCreateEventTypeDraftCapability({
            store: dependencies.eventTypes,
            authenticated: eventTypeAgent(authenticated),
            command: input as never,
            idempotencyKey: mutation.idempotencyKey,
            transport: mutation.transport,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        }
        case 'update-event-type-draft': {
          const mutation = agentEventTypeMutation(invocation);
          return executeUpdateEventTypeDraftCapability({
            store: dependencies.eventTypes,
            authenticated: eventTypeAgent(authenticated),
            command: input as never,
            idempotencyKey: mutation.idempotencyKey,
            transport: mutation.transport,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        }
        case 'publish-event-type-version': {
          const mutation = agentEventTypeMutation(invocation);
          return executePublishEventTypeVersionCapability({
            store: dependencies.eventTypes,
            authenticated: eventTypeAgent(authenticated),
            command: input as never,
            idempotencyKey: mutation.idempotencyKey,
            transport: mutation.transport,
            requestId: invocation.requestId,
            now: invocation.serverTime,
          });
        }
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
        default:
          return unhandledCapability(capabilityId);
      }
    },
  });
}
