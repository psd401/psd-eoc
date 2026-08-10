import {
  AgentIdSchema,
  type AgentApiKeySummary,
  type Facility,
  type SecurityAuditEntry,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../auth/sessions';
import {
  executeQuerySecurityAuditCapability,
  type SecurityAuditService,
} from '../audit';
import {
  agentApiKeyAdministrationAccessFromSession,
  type AgentApiKeyAdministration,
} from './admin-capabilities';
import type { AgentAdministrationFacilityCapabilities } from './admin-facilities';

export interface AgentAdministrationPageAgent {
  readonly id: string;
  readonly displayName: string;
  readonly keys: readonly AgentApiKeySummary[];
  readonly auditRecords: readonly SecurityAuditEntry[];
}

export interface AgentAdministrationPageData {
  readonly agents: readonly AgentAdministrationPageAgent[];
  readonly facilities: readonly Facility[];
}

export interface AgentAdministrationPageLoaderDependencies {
  readonly administration: AgentApiKeyAdministration;
  readonly facilities: AgentAdministrationFacilityCapabilities;
  readonly securityAudit: SecurityAuditService;
}

/**
 * Builds the admin presentation from secret-free projections. API-key reads
 * and audit reads still enter their respective canonical capability paths.
 */
export class AgentAdministrationPageLoader {
  private readonly administration: AgentApiKeyAdministration;
  private readonly facilities: AgentAdministrationFacilityCapabilities;
  private readonly securityAudit: SecurityAuditService;

  public constructor(dependencies: AgentAdministrationPageLoaderDependencies) {
    this.administration = dependencies.administration;
    this.facilities = dependencies.facilities;
    this.securityAudit = dependencies.securityAudit;
  }

  private async listAllKeys(
    authenticated: AuthenticatedSession,
  ): Promise<readonly AgentApiKeySummary[]> {
    const access = agentApiKeyAdministrationAccessFromSession(authenticated);
    const keys: AgentApiKeySummary[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.administration.list({
        access,
        value: {
          agentId: null,
          includeRevoked: true,
          cursor,
          limit: 200,
        },
      });
      keys.push(...page.items);
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      if (page.pageInfo.hasMore && cursor === null) {
        throw new TypeError('Agent API-key pagination did not advance.');
      }
    } while (cursor !== null);
    return Object.freeze(keys);
  }

  private async listAllFacilities(
    authenticated: AuthenticatedSession,
  ): Promise<readonly Facility[]> {
    const access = agentApiKeyAdministrationAccessFromSession(authenticated);
    const retained: Facility[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.facilities.list({
        access,
        value: { includeInactive: true, cursor, limit: 200 },
      });
      retained.push(...page.items);
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      if (page.pageInfo.hasMore && cursor === null) {
        throw new TypeError('Facility pagination did not advance.');
      }
    } while (cursor !== null);
    return Object.freeze(retained);
  }

  private async readAudit(
    authenticated: AuthenticatedSession,
    agentId: string,
  ): Promise<readonly SecurityAuditEntry[]> {
    const page = await executeQuerySecurityAuditCapability({
      service: this.securityAudit,
      access: {
        actor: authenticated.actor,
        source: authenticated.source,
        facilityScope: authenticated.scope.facilityScope,
        roles: authenticated.roles,
        capabilityGrants: [],
      },
      query: {
        actorKind: 'agent',
        principal: { kind: 'agent', agentId: AgentIdSchema.parse(agentId) },
        category: null,
        outcome: null,
        action: null,
        facilityId: null,
        occurredFrom: null,
        occurredThrough: null,
        cursor: null,
        limit: 100,
      },
    });
    return page.items;
  }

  public async load(
    authenticated: AuthenticatedSession,
  ): Promise<AgentAdministrationPageData> {
    const [keys, retainedFacilities] = await Promise.all([
      this.listAllKeys(authenticated),
      this.listAllFacilities(authenticated),
    ]);
    const keysByAgent = new Map<string, AgentApiKeySummary[]>();
    for (const key of keys) {
      const retained = keysByAgent.get(key.agentId) ?? [];
      retained.push(key);
      keysByAgent.set(key.agentId, retained);
    }
    const records = await Promise.all(
      [...keysByAgent.entries()].map(
        async ([agentId, agentKeys]): Promise<AgentAdministrationPageAgent> => {
          const id = AgentIdSchema.parse(agentId);
          const firstIssuedKey = agentKeys.at(-1);
          if (firstIssuedKey === undefined) {
            throw new TypeError('Agent identity has no retained key evidence.');
          }
          return Object.freeze({
            id,
            displayName: firstIssuedKey.displayName,
            keys: Object.freeze(agentKeys),
            auditRecords: await this.readAudit(authenticated, id),
          });
        },
      ),
    );
    records.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id),
    );

    return Object.freeze({
      agents: Object.freeze(records),
      facilities: retainedFacilities,
    });
  }
}
