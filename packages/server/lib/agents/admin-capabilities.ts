import { randomUUID } from 'node:crypto';

import {
  AgentCapabilityGrantSchema,
  ActorSchema,
  CapabilityScopeSchema,
  InvocationSourceSchema,
  RoleSchema,
  UuidSchema,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  type Actor,
  type AgentCapabilityGrant,
  type AgentApiKeyIssuance,
  type AgentApiKeyPage,
  type AgentApiKeyRevocation,
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

import type { Database } from '../../db/client';
import {
  createDrizzleCapabilityStore,
  type AdminCapabilityTransaction,
} from '../capabilities/admin';
import {
  CapabilityEngineError,
  executeAuditedCapabilityTransaction,
  executeAuthorizedCapabilityQuery,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';
import type { AuthenticatedSession } from '../auth/sessions';
import { parseSecurityAuditFact } from '../audit/model';
import type { SecurityAuditRepository } from '../audit/repository';
import {
  AgentApiKeyError,
  AgentApiKeyService,
  type AuthenticatedAgentApiKey,
} from './keys';
import { createDrizzleAgentApiKeyRepository } from './drizzle-key-repository';

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
  readonly capabilityStore: AgentApiKeyCapabilityStore;
}

export interface AgentApiKeyCapabilityTransaction
  extends CapabilityEngineTransaction {
  readonly keys: Pick<AgentApiKeyService, 'issue' | 'revoke'>;
  setAuditTarget(target: SecurityAuditTarget): void;
}

export type AgentApiKeyCapabilityStore =
  CapabilityEngineStore<AgentApiKeyCapabilityTransaction>;

interface AgentApiKeyAdministrationContext {
  readonly keys: AgentApiKeyAdministrationDependencies['keys'];
  readonly access: AgentApiKeyAdministrationAccess;
  readonly idempotencyKey: string | null;
}

export class AgentApiKeyAdministrationError extends CapabilityEngineError {
  public constructor(
    message = 'District administration capability access is required.',
  ) {
    super('FORBIDDEN', 'CAPABILITY_INVOCATION_DENIED', message, 403, false);
    this.name = 'AgentApiKeyAdministrationError';
  }
}

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

/** Creates the production atomic key/idempotency/audit transaction boundary. */
export function createDrizzleAgentApiKeyCapabilityStore(
  database: Database,
): AgentApiKeyCapabilityStore {
  const engineStore = createDrizzleCapabilityStore(database);
  return Object.freeze({
    transaction<Result>(
      operation: (
        transaction: AgentApiKeyCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return engineStore.transaction((transaction) => {
        const adminTransaction = transaction as AdminCapabilityTransaction;
        return operation({
          readCurrentTime: (receivedAt) =>
            transaction.readCurrentTime(receivedAt),
          claimIdempotency: (claim) => transaction.claimIdempotency(claim),
          completeIdempotency: (completion) =>
            transaction.completeIdempotency(completion),
          getHumanConfirmation: (id) => transaction.getHumanConfirmation(id),
          consumeHumanConfirmation: (confirmation) =>
            transaction.consumeHumanConfirmation(confirmation),
          appendCapabilityAudit: (event) =>
            transaction.appendCapabilityAudit(event),
          keys: new AgentApiKeyService({
            repository: createDrizzleAgentApiKeyRepository(
              adminTransaction.database as Database,
            ),
          }),
          setAuditTarget: (target) => adminTransaction.setAuditTarget(target),
        });
      });
    },
    appendCapabilityAudit: (event: CapabilityAuditEvent) =>
      engineStore.appendCapabilityAudit(event),
  });
}

function mutationInvocation(
  access: AgentApiKeyAdministrationAccess,
  input: Readonly<{
    idempotencyKey: string;
    csrfVerified: boolean;
    requestId: string;
    now: Date;
  }>,
): TrustedCapabilityInvocation {
  return Object.freeze({
    actor: access.actor,
    source: access.source,
    scope: access.scope,
    requestId: input.requestId,
    serverTime: input.now,
    connectivityEpochId: access.connectivityEpochId,
    mutation: Object.freeze({
      idempotencyKey: input.idempotencyKey,
      transport: mutationTransport(access.source, input.csrfVerified),
      humanConfirmationId: null,
    }),
  });
}

export class AgentApiKeyAdministration {
  private readonly keys: AgentApiKeyAdministrationDependencies['keys'];
  private readonly audit: AgentApiKeyAdministrationDependencies['audit'];
  private readonly capabilityStore: AgentApiKeyCapabilityStore;

  public constructor(dependencies: AgentApiKeyAdministrationDependencies) {
    this.keys = dependencies.keys;
    this.audit = dependencies.audit;
    this.capabilityStore = dependencies.capabilityStore;
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

  private async authorizeMutationInvocation(
    capabilityId: 'issue-agent-api-key' | 'revoke-agent-api-key',
    access: AgentApiKeyAdministrationAccess,
    input: Readonly<{
      idempotencyKey: string;
      csrfVerified: boolean;
      requestId: string;
      now: Date;
    }>,
  ): Promise<TrustedCapabilityInvocation> {
    try {
      return mutationInvocation(access, input);
    } catch (error) {
      await this.capabilityStore.appendCapabilityAudit({
        category: 'access-denial',
        action: capabilityId,
        actionIds: [],
        confirmationId: null,
        outcome: 'denied',
        actor: access.actor,
        source: access.source,
        facilityId: null,
        requestId: input.requestId,
        reasonCode: 'CAPABILITY_INVOCATION_DENIED',
        occurredAt: input.now,
      });
      throw error;
    }
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
    const registration: ServerCapabilityRegistration<
      'issue-agent-api-key',
      AgentApiKeyCapabilityTransaction
    > = {
      id: 'issue-agent-api-key',
      mutationPersistence: 'repository-owned',
      resolveFacilityId() {
        if (!hasDistrictAdministratorAccess(access)) {
          throw new AgentApiKeyAdministrationError();
        }
        return null;
      },
      async handler(value, context) {
        if (context.invocation.actor.kind !== 'human') {
          throw new AgentApiKeyAdministrationError();
        }
        const result = await context.transaction.keys.issue(
          value,
          context.invocation.actor.userId,
          {
            actor: context.invocation.actor,
            idempotencyKey: input.idempotencyKey,
          },
        );
        context.transaction.setAuditTarget({
          kind: 'agent',
          id: result.key.agentId,
        });
        return result;
      },
    };
    const invocation = await this.authorizeMutationInvocation(
      'issue-agent-api-key',
      access,
      {
        idempotencyKey: input.idempotencyKey,
        csrfVerified: input.csrfVerified,
        requestId,
        now,
      },
    );
    return executeAuditedCapabilityTransaction(
      registration,
      input.value,
      invocation,
      this.capabilityStore,
    );
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
    const registration: ServerCapabilityRegistration<
      'revoke-agent-api-key',
      AgentApiKeyCapabilityTransaction
    > = {
      id: 'revoke-agent-api-key',
      mutationPersistence: 'repository-owned',
      resolveFacilityId(value, context) {
        if (!hasDistrictAdministratorAccess(access)) {
          throw new AgentApiKeyAdministrationError();
        }
        context.transaction.setAuditTarget({
          kind: 'configuration',
          id: value.apiKeyId,
        });
        return null;
      },
      handler(value, context) {
        if (context.invocation.actor.kind !== 'human') {
          throw new AgentApiKeyAdministrationError();
        }
        return context.transaction.keys.revoke(
          value,
          context.invocation.actor.userId,
          {
            actor: context.invocation.actor,
            idempotencyKey: input.idempotencyKey,
          },
        );
      },
    };
    const invocation = await this.authorizeMutationInvocation(
      'revoke-agent-api-key',
      access,
      {
        idempotencyKey: input.idempotencyKey,
        csrfVerified: input.csrfVerified,
        requestId,
        now,
      },
    );
    return executeAuditedCapabilityTransaction(
      registration,
      input.value,
      invocation,
      this.capabilityStore,
    );
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
      result = await executeAuthorizedCapabilityQuery(
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
