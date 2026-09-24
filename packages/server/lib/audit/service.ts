import {
  ActorSchema,
  AgentCapabilityGrantSchema,
  FacilityScopeSchema,
  InvocationSourceSchema,
  RoleSchema,
  SecurityAuditQuerySchema,
  TimestampSchema,
  UuidSchema,
  VerifySecurityAuditChainInputSchema,
  getCapabilityInvocationPolicy,
  isActorSourceCompatible,
  type Actor,
  type AgentCapabilityGrant,
  type FacilityScope,
  type InvocationSource,
  type Role,
  type SecurityAuditPage,
  type SecurityAuditQuery,
  type SecurityAuditVerification,
  type VerifySecurityAuditChainInput,
} from '@psd-eoc/contracts';

import { parseSecurityAuditFact, type SecurityAuditFact } from './model';
import {
  SecurityAuditCursorError,
  SecurityAuditIntegrityError,
  SecurityAuditScopeError,
  type SecurityAuditRepository,
} from './repository';
import {
  SecurityAuditChainVerifier,
  invalidSecurityAuditVerification,
} from './verification';

const VERIFICATION_PAGE_SIZE = 200;

export type SecurityAuditCapabilityId =
  'query-security-audit' | 'verify-security-audit-chain';

/** Trusted, server-resolved identity and scope for one audit capability call. */
export interface SecurityAuditAccessContext {
  readonly actor: Actor;
  readonly source: InvocationSource;
  readonly facilityScope: FacilityScope;
  readonly roles: readonly Role[];
  readonly capabilityGrants: readonly AgentCapabilityGrant[];
  readonly requestId: string;
  readonly serverTime: string;
}

/** Client-safe shape produced only after an audit-query denial is appended. */
export interface SecurityAuditForbidden {
  readonly code: 'FORBIDDEN';
  readonly status: 403;
  readonly requestId: string;
}

class SecurityAuditForbiddenError
  extends Error
  implements SecurityAuditForbidden
{
  public readonly code = 'FORBIDDEN' as const;
  public readonly status = 403 as const;

  public constructor(public readonly requestId: string) {
    super('Security audit access is not authorized.');
    this.name = 'SecurityAuditForbiddenError';
  }
}

/** Lets adapters map the service-produced denial without exposing a constructor. */
export function isSecurityAuditForbiddenError(
  value: unknown,
): value is SecurityAuditForbiddenError {
  return value instanceof SecurityAuditForbiddenError;
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

/** Revalidates trusted adapter context before it can influence authorization. */
export function parseSecurityAuditAccessContext(
  value: SecurityAuditAccessContext,
): SecurityAuditAccessContext {
  const actor = ActorSchema.parse(value.actor);
  const source = InvocationSourceSchema.parse(value.source);
  const facilityScope = FacilityScopeSchema.parse(value.facilityScope);
  const roles = value.roles.map((role) => RoleSchema.parse(role));
  const capabilityGrants = value.capabilityGrants.map((grant) =>
    AgentCapabilityGrantSchema.parse(grant),
  );
  const requestId = UuidSchema.parse(value.requestId);
  const serverTime = TimestampSchema.parse(value.serverTime);

  if (!isActorSourceCompatible(actor, source)) {
    throw new TypeError('Security audit actor and source are incompatible.');
  }
  if (!unique(roles) || !unique(capabilityGrants)) {
    throw new TypeError('Security audit authorization lists must be unique.');
  }
  if (
    (actor.kind === 'human' && capabilityGrants.length > 0) ||
    (actor.kind !== 'human' && roles.length > 0) ||
    (actor.kind !== 'agent' && capabilityGrants.length > 0)
  ) {
    throw new TypeError(
      'Security audit roles and grants must match the authenticated actor kind.',
    );
  }

  return Object.freeze({
    actor,
    source,
    facilityScope,
    roles: Object.freeze(roles),
    capabilityGrants: Object.freeze(capabilityGrants),
    requestId,
    serverTime,
  });
}

function isAuthorizedForCapability(
  capabilityId: SecurityAuditCapabilityId,
  context: SecurityAuditAccessContext,
): boolean {
  switch (context.actor.kind) {
    case 'human':
      return context.roles.includes('admin');
    case 'agent':
      return context.capabilityGrants.includes(capabilityId);
    case 'system':
      return (
        capabilityId === 'verify-security-audit-chain' &&
        context.source === 'scheduled-job'
      );
  }
}

function requestedFacilityIsAuthorized(
  query: SecurityAuditQuery,
  facilityScope: FacilityScope,
): boolean {
  return (
    facilityScope.kind === 'district' ||
    query.facilityId === null ||
    facilityScope.facilityIds.includes(query.facilityId)
  );
}

function auditFacility(
  context: SecurityAuditAccessContext,
  requestedFacilityId: string | null,
): string | null {
  if (
    requestedFacilityId !== null &&
    (context.facilityScope.kind === 'district' ||
      context.facilityScope.facilityIds.includes(requestedFacilityId))
  ) {
    return requestedFacilityId;
  }
  if (
    context.facilityScope.kind === 'facilities' &&
    context.facilityScope.facilityIds.length === 1
  ) {
    return context.facilityScope.facilityIds[0] ?? null;
  }
  return null;
}

function queryAuditFact(
  context: SecurityAuditAccessContext,
  capabilityId: SecurityAuditCapabilityId,
  outcome: 'success' | 'denied' | 'failure',
  reasonCode: string | null,
  requestedFacilityId: string | null,
): SecurityAuditFact {
  return parseSecurityAuditFact({
    category: 'audit-query',
    action: capabilityId,
    actionIds: [],
    confirmationId: null,
    outcome,
    principal: context.actor,
    source: context.source,
    facilityId: auditFacility(context, requestedFacilityId),
    target: { kind: 'audit-query', id: context.requestId },
    requestId: context.requestId,
    reasonCode,
    occurredAt: context.serverTime,
  });
}

/**
 * Owns authorized audit reads and records exactly one minimized audit-query
 * fact before any result or 403 is returned to its adapter.
 */
export class SecurityAuditService {
  public constructor(private readonly repository: SecurityAuditRepository) {}

  public async authorize(
    capabilityId: SecurityAuditCapabilityId,
    contextValue: SecurityAuditAccessContext,
    queryValue?: SecurityAuditQuery,
  ): Promise<SecurityAuditAccessContext> {
    const context = parseSecurityAuditAccessContext(contextValue);
    const query =
      queryValue === undefined
        ? undefined
        : SecurityAuditQuerySchema.parse(queryValue);
    const policy = getCapabilityInvocationPolicy(capabilityId);
    const principalKinds: ReadonlySet<string> = new Set(policy.principalKinds);
    const sources: ReadonlySet<string> = new Set(policy.sources);
    const authorized =
      principalKinds.has(context.actor.kind) &&
      sources.has(context.source) &&
      isAuthorizedForCapability(capabilityId, context) &&
      (capabilityId !== 'verify-security-audit-chain' ||
        context.facilityScope.kind === 'district') &&
      (query === undefined ||
        requestedFacilityIsAuthorized(query, context.facilityScope));

    if (!authorized) {
      await this.repository.append(
        queryAuditFact(
          context,
          capabilityId,
          'denied',
          'AUDIT_QUERY_FORBIDDEN',
          query?.facilityId ?? null,
        ),
      );
      throw new SecurityAuditForbiddenError(context.requestId);
    }
    return context;
  }

  public async query(
    contextValue: SecurityAuditAccessContext,
    queryValue: SecurityAuditQuery,
  ): Promise<SecurityAuditPage> {
    const query = SecurityAuditQuerySchema.parse(queryValue);
    const context = await this.authorize(
      'query-security-audit',
      contextValue,
      query,
    );
    let page: SecurityAuditPage;
    try {
      page = await this.repository.query(query, context.facilityScope);
    } catch (error) {
      const reasonCode =
        error instanceof SecurityAuditCursorError ||
        error instanceof SecurityAuditScopeError
          ? 'AUDIT_QUERY_INVALID'
          : 'AUDIT_QUERY_FAILED';
      await this.repository.append(
        queryAuditFact(
          context,
          'query-security-audit',
          error instanceof SecurityAuditScopeError ||
            error instanceof SecurityAuditCursorError
            ? 'denied'
            : 'failure',
          reasonCode,
          query.facilityId,
        ),
      );
      throw error;
    }

    await this.repository.append(
      queryAuditFact(
        context,
        'query-security-audit',
        'success',
        null,
        query.facilityId,
      ),
    );
    return page;
  }

  public async verify(
    contextValue: SecurityAuditAccessContext,
    inputValue: VerifySecurityAuditChainInput,
  ): Promise<SecurityAuditVerification> {
    const input = VerifySecurityAuditChainInputSchema.parse(inputValue);
    const context = await this.authorize(
      'verify-security-audit-chain',
      contextValue,
    );
    try {
      return await this.repository.runVerificationSession(async (store) => {
        const persistedAnchor = await store.readChainAnchor(
          input.throughSequence,
        );
        const effectiveThroughSequence =
          input.throughSequence ?? persistedAnchor?.sequence ?? null;
        const verifier = new SecurityAuditChainVerifier({
          fromSequence: input.fromSequence,
          throughSequence: effectiveThroughSequence,
        });
        let verification: SecurityAuditVerification;
        let afterSequence = verifier.afterSequence();
        const capturedEmptyChain =
          input.throughSequence === null && persistedAnchor === null;
        for (;;) {
          if (capturedEmptyChain) {
            verification = verifier.finish();
            break;
          }
          const page = await store.readChainPage({
            afterSequence,
            throughSequence: effectiveThroughSequence,
            limit: VERIFICATION_PAGE_SIZE,
          });
          if (page.firstAnchorMismatchSequence !== null) {
            verification = invalidSecurityAuditVerification(
              page.firstAnchorMismatchSequence,
            );
            break;
          }
          const failure = verifier.add(page.entries);
          if (failure !== null) {
            verification = failure;
            break;
          }
          if (!page.hasMore) {
            verification = verifier.finish();
            break;
          }
          if (
            page.lastSequence === null ||
            page.lastSequence <= afterSequence
          ) {
            throw new TypeError('Security audit verification did not advance.');
          }
          afterSequence = page.lastSequence;
        }

        if (verification.valid) {
          const verifiedAnchor = verifier.verifiedAnchor();
          if (persistedAnchor === null) {
            if (verifiedAnchor !== null || input.throughSequence !== null) {
              verification = invalidSecurityAuditVerification(
                input.throughSequence ?? verifiedAnchor?.sequence ?? 1,
              );
            }
          } else if (
            verifiedAnchor === null ||
            verifiedAnchor.sequence !== persistedAnchor.sequence ||
            verifiedAnchor.entryHash !== persistedAnchor.entryHash
          ) {
            verification = invalidSecurityAuditVerification(
              persistedAnchor.sequence,
            );
          }
        }

        const appendResult = (result: SecurityAuditVerification) =>
          store.append(
            queryAuditFact(
              context,
              'verify-security-audit-chain',
              result.valid ? 'success' : 'failure',
              result.valid ? null : 'AUDIT_CHAIN_INVALID',
              null,
            ),
          );

        try {
          await appendResult(verification);
        } catch (error) {
          if (
            !(error instanceof SecurityAuditIntegrityError) ||
            !verification.valid
          ) {
            throw error;
          }
          verification = invalidSecurityAuditVerification(
            error.firstInvalidSequence,
          );
          await appendResult(verification);
        }
        return verification;
      });
    } catch (error) {
      await this.repository.append(
        queryAuditFact(
          context,
          'verify-security-audit-chain',
          'failure',
          'AUDIT_VERIFICATION_FAILED',
          null,
        ),
      );
      throw error;
    }
  }
}
