import {
  SecurityAuditRequestConflictError,
  type SecurityAuditRepository,
} from '../audit/repository';
import { parseSecurityAuditFact } from '../audit/model';
import type {
  AgentGatewayAuditEvent,
  AgentGatewayAuditAppendOptions,
  AgentGatewayAuditSink,
} from './gateway';

/** Converts engine-shaped agent denials into the canonical hash-chain fact. */
export function createAgentGatewayAuditSink(
  repository: SecurityAuditRepository,
): AgentGatewayAuditSink {
  return Object.freeze({
    async append(
      event: AgentGatewayAuditEvent,
      options?: AgentGatewayAuditAppendOptions,
    ) {
      try {
        await repository.append(
          parseSecurityAuditFact({
            category: event.category,
            action: event.action,
            actionIds: event.actionIds,
            confirmationId: event.confirmationId,
            outcome: event.outcome,
            principal: 'actor' in event ? event.actor : event.principal,
            source: event.source,
            facilityId: event.facilityId,
            target: { kind: 'capability', id: event.action },
            requestId: event.requestId,
            reasonCode: event.reasonCode,
            occurredAt: event.occurredAt.toISOString(),
          }),
        );
      } catch (error) {
        if (
          options?.acceptCanonicalRequestAudit === true &&
          error instanceof SecurityAuditRequestConflictError
        ) {
          return;
        }
        throw error;
      }
    },
  });
}
