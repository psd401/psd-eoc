import { randomUUID } from 'node:crypto';

import {
  AgentCapabilityGrantSchema,
  ActorSchema,
  CapabilityScopeSchema,
  InvocationSourceSchema,
  RoleSchema,
  UuidSchema,
  executeCapability,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  type Actor,
  type AgentCapabilityGrant,
  type AgentApiKeyIssuance,
  type AgentApiKeyPage,
  type AgentApiKeyRevocation,
  type AgentApiKeySummary,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type CapabilityScope,
  type InvocationSource,
  type IssueAgentApiKeyInput,
  type ListAgentApiKeysInput,
  type MutationTransport,
  type RegisteredCapabilityId,
  type RevokeAgentApiKeyInput,
  type Role,
  type SecurityAuditOutcome,
  type SecurityAuditTarget,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../auth/sessions';
import { parseSecurityAuditFact } from '../audit/model';
import type { SecurityAuditRepository } from '../audit/repository';
import {
  AgentApiKeyError,
  type AgentApiKeyService,
  type AuthenticatedAgentApiKey,
} from './keys';

export type AgentApiKeyAdministrationCapabilityId =
  | 'issue-agent-api-key'
  | 'revoke-agent-api-key'
  | 'list-agent-api-keys';

/** Trusted identity and scope supplied only after an adapter authenticates. */
export interface AgentApiKeyAdministrationAccess {
  readonly actor: Actor;
  readonly source: InvocationSource;
  readonly roles: readonly Role[];
  readonly capabilityGrants: readonly AgentCapabilityGrant[];
  readonly scope: CapabilityScope;
  readonly connectivityEpochId: string | null;
}

export interface AgentApiKeyAdministrationDependencies {
  readonly keys: Pick<AgentApiKeyService, 'issue' | 'list' | 'revoke'>;
  readonly audit: Pick<SecurityAuditRepository, 'append'>;
}

interface AgentApiKeyAdministrationContext {
  readonly keys: AgentApiKeyAdministrationDependencies['keys'];
  readonly access: AgentApiKeyAdministrationAccess;
  readonly idempotencyKey: string | null;
}

export class AgentApiKeyAdministrationError extends Error {
  public readonly code = 'FORBIDDEN' as const;
  public readonly status = 403 as const;
  public readonly retryable = false as const;

  public constructor(
    message = 'District administration capability access is required.',
  ) {
    super(message);
    this.name = 'AgentApiKeyAdministrationError';
  }
}

export type AgentApiKeyCommittedWithoutAudit =
  | Readonly<{ kind: 'issued'; key: AgentApiKeySummary }>
  | Readonly<{ kind: 'revoked'; revocation: AgentApiKeyRevocation }>;

/** Truthful bounded failure when mutation persistence commits before audit. */
export class AgentApiKeyAdministrationCommitError extends Error {
  public constructor(
    public readonly committed: AgentApiKeyCommittedWithoutAudit,
  ) {
    super(
      committed.kind === 'issued'
        ? 'The API key was issued, but its audit append could not be confirmed.'
        : 'The API key was revoked, but its audit append could not be confirmed.',
    );
    this.name = 'AgentApiKeyAdministrationCommitError';
  }
}

const issueAgentApiKeyHandler = registerCapabilityHandler(
  'issue-agent-api-key',
  (input, context: AgentApiKeyAdministrationContext) => {
    if (context.access.actor.kind !== 'human') {
      throw new AgentApiKeyAdministrationError();
    }
    if (context.idempotencyKey === null) {
      throw new AgentApiKeyAdministrationError(
        'Key issuance requires durable idempotency.',
      );
    }
    return context.keys.issue(input, context.access.actor.userId, {
      actor: context.access.actor,
      idempotencyKey: context.idempotencyKey,
    });
  },
);

const revokeAgentApiKeyHandler = registerCapabilityHandler(
  'revoke-agent-api-key',
  (input, context: AgentApiKeyAdministrationContext) => {
    if (context.access.actor.kind !== 'human') {
      throw new AgentApiKeyAdministrationError();
    }
    if (context.idempotencyKey === null) {
      throw new AgentApiKeyAdministrationError(
        'Key revocation requires durable idempotency.',
      );
    }
    return context.keys.revoke(input, context.access.actor.userId, {
      actor: context.access.actor,
      idempotencyKey: context.idempotencyKey,
    });
  },
);

const listAgentApiKeysHandler = registerCapabilityHandler(
  'list-agent-api-keys',
  (input, context: AgentApiKeyAdministrationContext) =>
    context.keys.list(input),
);

function hasDistrictAdministratorAccess(
  access: AgentApiKeyAdministrationAccess,
): boolean {
  return (
    access.actor.kind === 'human' &&
    access.source === 'web' &&
    access.roles.includes('admin') &&
    access.scope.facilityScope.kind === 'district'
  );
}

function hasDistrictAgentReadAccess(
  access: AgentApiKeyAdministrationAccess,
  capabilityId: 'list-agent-api-keys' | 'list-facilities',
): boolean {
  return (
    access.actor.kind === 'agent' &&
    (access.source === 'agent-rest' || access.source === 'mcp') &&
    access.roles.length === 0 &&
    access.connectivityEpochId === null &&
    access.scope.facilityScope.kind === 'district' &&
    access.capabilityGrants.includes(capabilityId)
  );
}

/** Shared district-wide read policy for agent key and facility metadata. */
export function hasAgentAdministrationReadAccess(
  access: AgentApiKeyAdministrationAccess,
  capabilityId: 'list-agent-api-keys' | 'list-facilities',
): boolean {
  return (
    hasDistrictAdministratorAccess(access) ||
    hasDistrictAgentReadAccess(access, capabilityId)
  );
}

const administrationAuthorizer: CapabilityExecutionAuthorizer<AgentApiKeyAdministrationContext> =
  Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        AgentApiKeyAdministrationContext
      >,
    ) {
      const { access } = request.context;
      const recognized =
        request.definition.id === 'issue-agent-api-key' ||
        request.definition.id === 'revoke-agent-api-key' ||
        request.definition.id === 'list-agent-api-keys';
      const authorized =
        request.definition.id === 'list-agent-api-keys'
          ? hasAgentAdministrationReadAccess(access, 'list-agent-api-keys')
          : hasDistrictAdministratorAccess(access);
      if (
        !recognized ||
        !authorized ||
        !request.invocationPolicy.principalKinds.includes(access.actor.kind) ||
        !request.invocationPolicy.sources.includes(access.source)
      ) {
        throw new AgentApiKeyAdministrationError();
      }
    },
  });

function parseAccess(
  value: AgentApiKeyAdministrationAccess,
): AgentApiKeyAdministrationAccess {
  const actor = ActorSchema.parse(value.actor);
  const source = InvocationSourceSchema.parse(value.source);
  const roles = value.roles.map((role) => RoleSchema.parse(role));
  const capabilityGrants = value.capabilityGrants.map((capabilityId) =>
    AgentCapabilityGrantSchema.parse(capabilityId),
  );
  const scope = CapabilityScopeSchema.parse(value.scope);
  const connectivityEpochId =
    value.connectivityEpochId === null
      ? null
      : UuidSchema.parse(value.connectivityEpochId);
  if (
    new Set(roles).size !== roles.length ||
    new Set(capabilityGrants).size !== capabilityGrants.length ||
    (actor.kind === 'agent' &&
      (roles.length !== 0 || connectivityEpochId !== null)) ||
    (actor.kind !== 'agent' && capabilityGrants.length !== 0)
  ) {
    throw new AgentApiKeyAdministrationError();
  }
  return Object.freeze({
    actor,
    source,
    roles: Object.freeze(roles),
    capabilityGrants: Object.freeze(capabilityGrants),
    scope,
    connectivityEpochId,
  });
}

/** Converts issue #7's authenticated web session into trusted admin context. */
export function agentApiKeyAdministrationAccessFromSession(
  authenticated: AuthenticatedSession,
): AgentApiKeyAdministrationAccess {
  return parseAccess({
    actor: authenticated.actor,
    source: authenticated.source,
    roles: authenticated.roles,
    capabilityGrants: [],
    scope: authenticated.scope,
    connectivityEpochId: authenticated.result.connectivityEpoch.id,
  });
}

/** Converts an authenticated API key into trusted read-only admin context. */
export function agentApiKeyAdministrationAccessFromAgent(
  authenticated: AuthenticatedAgentApiKey,
): AgentApiKeyAdministrationAccess {
  return parseAccess({
    actor: authenticated.actor,
    source: 'agent-rest',
    roles: [],
    capabilityGrants: authenticated.capabilityIds,
    scope: authenticated.scope,
    connectivityEpochId: null,
  });
}

function mutationTransport(
  source: InvocationSource,
  csrfVerified: boolean,
): MutationTransport {
  switch (source) {
    case 'web':
      if (!csrfVerified) {
        throw new AgentApiKeyAdministrationError(
          'Verified same-origin POST is required.',
        );
      }
      return Object.freeze({
        kind: 'web-interactive',
        method: 'POST',
        interaction: 'explicit-user-submit',
        csrfVerified: true,
      });
    case 'mobile':
      return Object.freeze({
        kind: 'mobile-interactive',
        interaction: 'explicit-user-submit',
      });
    case 'agent-rest':
      return Object.freeze({ kind: 'agent-rest-command', method: 'POST' });
    case 'mcp':
      return Object.freeze({ kind: 'mcp-tool-call' });
    case 'worker':
      return Object.freeze({ kind: 'worker-execution' });
    case 'scheduled-job':
      return Object.freeze({ kind: 'scheduled-execution' });
    case 'webhook':
      return Object.freeze({ kind: 'webhook-delivery' });
  }
}

function reasonFor(error: unknown): Readonly<{
  outcome: Exclude<SecurityAuditOutcome, 'success'>;
  reasonCode: string;
}> {
  if (error instanceof AgentApiKeyAdministrationError) {
    return { outcome: 'denied', reasonCode: 'AGENT_KEY_ADMIN_FORBIDDEN' };
  }
  if (error instanceof AgentApiKeyError) {
    return {
      outcome: error.status < 500 ? 'denied' : 'failure',
      reasonCode: error.code,
    };
  }
  return { outcome: 'failure', reasonCode: 'AGENT_KEY_ADMIN_FAILED' };
}

function targetFor(
  capabilityId: AgentApiKeyAdministrationCapabilityId,
  targetId: string | null,
): SecurityAuditTarget {
  if (targetId !== null) {
    return {
      kind: capabilityId === 'issue-agent-api-key' ? 'agent' : 'configuration',
      id: UuidSchema.parse(targetId),
    };
  }
  return { kind: 'capability', id: capabilityId };
}

export class AgentApiKeyAdministration {
  private readonly keys: AgentApiKeyAdministrationDependencies['keys'];
  private readonly audit: AgentApiKeyAdministrationDependencies['audit'];

  public constructor(dependencies: AgentApiKeyAdministrationDependencies) {
    this.keys = dependencies.keys;
    this.audit = dependencies.audit;
  }

  private async appendAudit(
    input: Readonly<{
      capabilityId: AgentApiKeyAdministrationCapabilityId;
      access: AgentApiKeyAdministrationAccess;
      requestId: string;
      occurredAt: Date;
      outcome: SecurityAuditOutcome;
      reasonCode: string | null;
      targetId: string | null;
    }>,
  ): Promise<void> {
    await this.audit.append(
      parseSecurityAuditFact({
        category:
          input.capabilityId === 'list-agent-api-keys'
            ? 'agent-access'
            : 'admin-change',
        action: input.capabilityId,
        actionIds: [],
        confirmationId: null,
        outcome: input.outcome,
        principal: input.access.actor,
        source: input.access.source,
        facilityId: null,
        target: targetFor(input.capabilityId, input.targetId),
        requestId: input.requestId,
        reasonCode: input.reasonCode,
        occurredAt: input.occurredAt.toISOString(),
      }),
    );
  }

  public async issue(
    input: Readonly<{
      access: AgentApiKeyAdministrationAccess;
      value: IssueAgentApiKeyInput;
      idempotencyKey: string;
      csrfVerified: boolean;
      requestId?: string;
      now?: Date;
    }>,
  ): Promise<AgentApiKeyIssuance> {
    const access = parseAccess(input.access);
    const requestId = UuidSchema.parse(input.requestId ?? randomUUID());
    const now = input.now ?? new Date();
    let result: AgentApiKeyIssuance;
    try {
      const envelope = parseCapabilityEnvelopeFor('issue-agent-api-key', {
        capabilityId: 'issue-agent-api-key',
        operation: 'mutation',
        actor: access.actor,
        source: access.source,
        scope: access.scope,
        requestId,
        serverTime: now.toISOString(),
        input: input.value,
        idempotencyKey: input.idempotencyKey,
        transport: mutationTransport(access.source, input.csrfVerified),
        connectivityEpochId: access.connectivityEpochId,
        requiredHumanActionIds: [],
        requiredConsequenceDigest: null,
        humanConfirmation: null,
      });
      const context = Object.freeze({
        keys: this.keys,
        access,
        idempotencyKey: input.idempotencyKey,
      });
      result = await executeCapability(
        issueAgentApiKeyHandler,
        envelope.input,
        {
          context,
          humanActionResolutionContext: null,
          safetyResolver: null,
          authorizer: administrationAuthorizer,
        },
      );
    } catch (error) {
      const reportedError = hasDistrictAdministratorAccess(access)
        ? error
        : new AgentApiKeyAdministrationError();
      const failure = reasonFor(reportedError);
      try {
        await this.appendAudit({
          capabilityId: 'issue-agent-api-key',
          access,
          requestId,
          occurredAt: now,
          ...failure,
          targetId: null,
        });
      } catch {
        // Preserve the known mutation outcome instead of replacing it with an
        // audit transport error; the adapter must render that truth safely.
      }
      throw reportedError;
    }
    try {
      await this.appendAudit({
        capabilityId: 'issue-agent-api-key',
        access,
        requestId,
        occurredAt: now,
        outcome: 'success',
        reasonCode: null,
        targetId: result.key.agentId,
      });
    } catch {
      throw new AgentApiKeyAdministrationCommitError({
        kind: 'issued',
        key: result.key,
      });
    }
    return result;
  }

  public async revoke(
    input: Readonly<{
      access: AgentApiKeyAdministrationAccess;
      value: RevokeAgentApiKeyInput;
      idempotencyKey: string;
      csrfVerified: boolean;
      requestId?: string;
      now?: Date;
    }>,
  ): Promise<AgentApiKeyRevocation> {
    const access = parseAccess(input.access);
    const requestId = UuidSchema.parse(input.requestId ?? randomUUID());
    const now = input.now ?? new Date();
    let result: AgentApiKeyRevocation;
    try {
      const envelope = parseCapabilityEnvelopeFor('revoke-agent-api-key', {
        capabilityId: 'revoke-agent-api-key',
        operation: 'mutation',
        actor: access.actor,
        source: access.source,
        scope: access.scope,
        requestId,
        serverTime: now.toISOString(),
        input: input.value,
        idempotencyKey: input.idempotencyKey,
        transport: mutationTransport(access.source, input.csrfVerified),
        connectivityEpochId: access.connectivityEpochId,
        requiredHumanActionIds: [],
        requiredConsequenceDigest: null,
        humanConfirmation: null,
      });
      const context = Object.freeze({
        keys: this.keys,
        access,
        idempotencyKey: input.idempotencyKey,
      });
      result = await executeCapability(
        revokeAgentApiKeyHandler,
        envelope.input,
        {
          context,
          humanActionResolutionContext: null,
          safetyResolver: null,
          authorizer: administrationAuthorizer,
        },
      );
    } catch (error) {
      const reportedError = hasDistrictAdministratorAccess(access)
        ? error
        : new AgentApiKeyAdministrationError();
      const failure = reasonFor(reportedError);
      try {
        await this.appendAudit({
          capabilityId: 'revoke-agent-api-key',
          access,
          requestId,
          occurredAt: now,
          ...failure,
          targetId: null,
        });
      } catch {
        // Preserve the known mutation outcome for truthful adapter handling.
      }
      throw reportedError;
    }
    try {
      await this.appendAudit({
        capabilityId: 'revoke-agent-api-key',
        access,
        requestId,
        occurredAt: now,
        outcome: 'success',
        reasonCode: null,
        targetId: result.apiKeyId,
      });
    } catch {
      throw new AgentApiKeyAdministrationCommitError({
        kind: 'revoked',
        revocation: result,
      });
    }
    return result;
  }

  public async list(
    input: Readonly<{
      access: AgentApiKeyAdministrationAccess;
      value: ListAgentApiKeysInput;
      requestId?: string;
      now?: Date;
    }>,
  ): Promise<AgentApiKeyPage> {
    const access = parseAccess(input.access);
    const requestId = UuidSchema.parse(input.requestId ?? randomUUID());
    const now = input.now ?? new Date();
    let result: AgentApiKeyPage;
    try {
      const envelope = parseCapabilityEnvelopeFor('list-agent-api-keys', {
        capabilityId: 'list-agent-api-keys',
        operation: 'query',
        actor: access.actor,
        source: access.source,
        scope: access.scope,
        requestId,
        serverTime: now.toISOString(),
        input: input.value,
      });
      const context = Object.freeze({
        keys: this.keys,
        access,
        idempotencyKey: null,
      });
      result = await executeCapability(
        listAgentApiKeysHandler,
        envelope.input,
        {
          context,
          humanActionResolutionContext: null,
          safetyResolver: null,
          authorizer: administrationAuthorizer,
        },
      );
    } catch (error) {
      const reportedError = hasAgentAdministrationReadAccess(
        access,
        'list-agent-api-keys',
      )
        ? error
        : new AgentApiKeyAdministrationError();
      const failure = reasonFor(reportedError);
      await this.appendAudit({
        capabilityId: 'list-agent-api-keys',
        access,
        requestId,
        occurredAt: now,
        ...failure,
        targetId: null,
      });
      throw reportedError;
    }
    await this.appendAudit({
      capabilityId: 'list-agent-api-keys',
      access,
      requestId,
      occurredAt: now,
      outcome: 'success',
      reasonCode: null,
      targetId: null,
    });
    return result;
  }
}
