import { randomUUID } from 'node:crypto';

import {
  AgentCapabilityGrantSchema,
  ActorSchema,
  CapabilityScopeSchema,
  FacilityPageSchema,
  FacilitySchema,
  InvocationSourceSchema,
  RoleSchema,
  UuidSchema,
  parseCapabilityEnvelopeFor,
  registerCapabilityHandler,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type FacilityPage,
  type ListFacilitiesInput,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import { and, asc, eq, gt, or, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client';
import { facilities } from '../../db/schema';
import { executeAuthorizedCapabilityQuery } from '../capabilities/engine';
import { parseSecurityAuditFact } from '../audit/model';
import type { SecurityAuditRepository } from '../audit/repository';
import {
  AgentApiKeyAdministrationError,
  hasAgentAdministrationReadAccess,
  type AgentApiKeyAdministrationAccess,
} from './admin-capabilities';

interface FacilityCursor {
  readonly version: 1;
  readonly code: string;
  readonly id: string;
  readonly includeInactive: boolean;
}

export interface AgentAdministrationFacilityStore {
  list(input: ListFacilitiesInput): Promise<FacilityPage>;
}

interface AgentAdministrationFacilityContext {
  readonly store: AgentAdministrationFacilityStore;
  readonly access: AgentApiKeyAdministrationAccess;
}

function encodeCursor(
  facility: FacilityPage['items'][number],
  includeInactive: boolean,
): string {
  const value: FacilityCursor = {
    version: 1,
    code: facility.code,
    id: facility.id,
    includeInactive,
  };
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string | null,
  includeInactive: boolean,
): FacilityCursor | null {
  if (cursor === null) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
      throw new TypeError('Non-canonical cursor.');
    }
    const value = JSON.parse(decoded) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Reflect.get(value, 'version') !== 1 ||
      typeof Reflect.get(value, 'code') !== 'string' ||
      !UuidSchema.safeParse(Reflect.get(value, 'id')).success ||
      Reflect.get(value, 'includeInactive') !== includeInactive
    ) {
      throw new TypeError('Invalid facility cursor.');
    }
    return {
      version: 1,
      code: String(Reflect.get(value, 'code')),
      id: UuidSchema.parse(Reflect.get(value, 'id')),
      includeInactive,
    };
  } catch {
    throw new TypeError('The facility-list cursor is invalid.');
  }
}

export class DrizzleAgentAdministrationFacilityStore
  implements AgentAdministrationFacilityStore
{
  public constructor(private readonly database: Database) {}

  public async list(input: ListFacilitiesInput): Promise<FacilityPage> {
    const cursor = decodeCursor(input.cursor, input.includeInactive);
    const predicates: SQL[] = [];
    if (!input.includeInactive) {
      predicates.push(eq(facilities.active, true));
    }
    if (cursor !== null) {
      predicates.push(
        or(
          gt(facilities.code, cursor.code),
          and(eq(facilities.code, cursor.code), gt(facilities.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.database
      .select({
        id: facilities.id,
        code: facilities.code,
        name: facilities.name,
        active: facilities.active,
        createdAt: facilities.createdAt,
      })
      .from(facilities)
      .where(predicates.length === 0 ? undefined : and(...predicates))
      .orderBy(asc(facilities.code), asc(facilities.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((facility) =>
      FacilitySchema.parse({
        ...facility,
        createdAt: facility.createdAt.toISOString(),
      }),
    );
    const last = items.at(-1);
    return FacilityPageSchema.parse({
      items,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor(last, input.includeInactive)
            : null,
      },
    });
  }
}

const listFacilitiesHandler = registerCapabilityHandler(
  'list-facilities',
  (input, context: AgentAdministrationFacilityContext) =>
    context.store.list(input),
);

const listFacilitiesAuthorizer: CapabilityExecutionAuthorizer<AgentAdministrationFacilityContext> =
  Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        AgentAdministrationFacilityContext
      >,
    ) {
      const { access } = request.context;
      if (
        request.definition.id !== 'list-facilities' ||
        !hasAgentAdministrationReadAccess(access, 'list-facilities') ||
        !request.invocationPolicy.principalKinds.includes(access.actor.kind) ||
        !request.invocationPolicy.sources.includes(access.source)
      ) {
        throw new AgentApiKeyAdministrationError();
      }
    },
  });

export class AgentAdministrationFacilityCapabilities {
  public constructor(
    private readonly store: AgentAdministrationFacilityStore,
    private readonly audit: Pick<SecurityAuditRepository, 'append'>,
  ) {}

  public async list(
    input: Readonly<{
      access: AgentApiKeyAdministrationAccess;
      value: ListFacilitiesInput;
      requestId?: string;
      now?: Date;
    }>,
  ): Promise<FacilityPage> {
    const access = Object.freeze({
      actor: ActorSchema.parse(input.access.actor),
      source: InvocationSourceSchema.parse(input.access.source),
      roles: Object.freeze(
        input.access.roles.map((role) => RoleSchema.parse(role)),
      ),
      capabilityGrants: Object.freeze(
        input.access.capabilityGrants.map((capabilityId) =>
          AgentCapabilityGrantSchema.parse(capabilityId),
        ),
      ),
      scope: CapabilityScopeSchema.parse(input.access.scope),
      connectivityEpochId:
        input.access.connectivityEpochId === null
          ? null
          : UuidSchema.parse(input.access.connectivityEpochId),
    });
    const requestId = UuidSchema.parse(input.requestId ?? randomUUID());
    const now = input.now ?? new Date();
    let result: FacilityPage;
    try {
      const envelope = parseCapabilityEnvelopeFor('list-facilities', {
        capabilityId: 'list-facilities',
        operation: 'query',
        actor: access.actor,
        source: access.source,
        scope: access.scope,
        requestId,
        serverTime: now.toISOString(),
        input: input.value,
      });
      result = await executeAuthorizedCapabilityQuery(
        listFacilitiesHandler,
        envelope.input,
        {
          context: Object.freeze({ store: this.store, access }),
          humanActionResolutionContext: null,
          safetyResolver: null,
          authorizer: listFacilitiesAuthorizer,
        },
      );
    } catch (error) {
      await this.audit.append(
        parseSecurityAuditFact({
          category: 'agent-access',
          action: 'list-facilities',
          actionIds: [],
          confirmationId: null,
          outcome:
            error instanceof AgentApiKeyAdministrationError
              ? 'denied'
              : 'failure',
          principal: access.actor,
          source: access.source,
          facilityId: null,
          target: { kind: 'capability', id: 'list-facilities' },
          requestId,
          reasonCode:
            error instanceof AgentApiKeyAdministrationError
              ? 'AGENT_FACILITY_LIST_FORBIDDEN'
              : 'AGENT_FACILITY_LIST_FAILED',
          occurredAt: now.toISOString(),
        }),
      );
      throw error;
    }
    await this.audit.append(
      parseSecurityAuditFact({
        category: 'agent-access',
        action: 'list-facilities',
        actionIds: [],
        confirmationId: null,
        outcome: 'success',
        principal: access.actor,
        source: access.source,
        facilityId: null,
        target: { kind: 'capability', id: 'list-facilities' },
        requestId,
        reasonCode: null,
        occurredAt: now.toISOString(),
      }),
    );
    return result;
  }
}
