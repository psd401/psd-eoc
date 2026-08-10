import { randomUUID } from 'node:crypto';

import {
  SecurityAuditQuerySchema,
  VerifySecurityAuditChainInputSchema,
  executeCapability,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type RegisteredCapabilityId,
  type SecurityAuditPage,
  type SecurityAuditQuery,
  type SecurityAuditVerification,
  type VerifySecurityAuditChainInput,
} from '@psd-eoc/contracts';

import type {
  SecurityAuditService,
  SecurityAuditAccessContext,
  SecurityAuditCapabilityId,
} from './service';

interface SecurityAuditExecutionContext {
  readonly service: SecurityAuditService;
  readonly access: SecurityAuditAccessContext;
}

const querySecurityAuditHandler = registerCapabilityHandler(
  'query-security-audit',
  (query, context: SecurityAuditExecutionContext) =>
    context.service.query(context.access, query),
);

const verifySecurityAuditChainHandler = registerCapabilityHandler(
  'verify-security-audit-chain',
  (input, context: SecurityAuditExecutionContext) =>
    context.service.verify(context.access, input),
);

const securityAuditAuthorizer: CapabilityExecutionAuthorizer<SecurityAuditExecutionContext> =
  Object.freeze({
    async authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        SecurityAuditExecutionContext
      >,
    ) {
      const capabilityId = request.definition.id;
      if (
        capabilityId !== 'query-security-audit' &&
        capabilityId !== 'verify-security-audit-chain'
      ) {
        throw new TypeError(
          'The security audit authorizer rejects other capabilities.',
        );
      }
      const { access, service } = request.context;
      await service.authorize(
        capabilityId,
        access,
        capabilityId === 'query-security-audit'
          ? SecurityAuditQuerySchema.parse(request.input)
          : undefined,
      );
    },
  });

function envelopeContext(
  service: SecurityAuditService,
  access: SecurityAuditAccessContext,
): SecurityAuditExecutionContext {
  return Object.freeze({ service, access });
}

/** Executes the scoped, self-auditing query through the canonical boundary. */
export async function executeQuerySecurityAuditCapability(input: {
  readonly service: SecurityAuditService;
  readonly access: Omit<SecurityAuditAccessContext, 'requestId' | 'serverTime'>;
  readonly query: SecurityAuditQuery;
  readonly requestId?: string;
  readonly now?: Date;
}): Promise<SecurityAuditPage> {
  const requestId = input.requestId ?? randomUUID();
  const serverTime = (input.now ?? new Date()).toISOString();
  const access: SecurityAuditAccessContext = Object.freeze({
    ...input.access,
    requestId,
    serverTime,
  });
  const envelope = parseCapabilityEnvelopeFor('query-security-audit', {
    capabilityId: 'query-security-audit',
    operation: 'query',
    actor: access.actor,
    source: access.source,
    scope: { facilityScope: access.facilityScope },
    requestId,
    serverTime,
    input: input.query,
  });
  const context = envelopeContext(input.service, access);
  return executeCapability(querySecurityAuditHandler, envelope.input, {
    context,
    humanActionResolutionContext: null,
    safetyResolver: null,
    authorizer: securityAuditAuthorizer,
  });
}

/** Executes a district-wide verification job through the same capability. */
export async function executeVerifySecurityAuditChainCapability(input: {
  readonly service: SecurityAuditService;
  readonly access: Omit<SecurityAuditAccessContext, 'requestId' | 'serverTime'>;
  readonly verification: VerifySecurityAuditChainInput;
  readonly requestId?: string;
  readonly now?: Date;
}): Promise<SecurityAuditVerification> {
  const requestId = input.requestId ?? randomUUID();
  const serverTime = (input.now ?? new Date()).toISOString();
  const access: SecurityAuditAccessContext = Object.freeze({
    ...input.access,
    requestId,
    serverTime,
  });
  const verification = VerifySecurityAuditChainInputSchema.parse(
    input.verification,
  );
  const envelope = parseCapabilityEnvelopeFor('verify-security-audit-chain', {
    capabilityId: 'verify-security-audit-chain',
    operation: 'query',
    actor: access.actor,
    source: access.source,
    scope: { facilityScope: access.facilityScope },
    requestId,
    serverTime,
    input: verification,
  });
  const context = envelopeContext(input.service, access);
  return executeCapability(verifySecurityAuditChainHandler, envelope.input, {
    context,
    humanActionResolutionContext: null,
    safetyResolver: null,
    authorizer: securityAuditAuthorizer,
  });
}

/** Narrows arbitrary canonical IDs accepted by the shared authorizer. */
export function isSecurityAuditCapabilityId(
  capabilityId: string,
): capabilityId is SecurityAuditCapabilityId {
  return (
    capabilityId === 'query-security-audit' ||
    capabilityId === 'verify-security-audit-chain'
  );
}
