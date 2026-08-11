import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../db/client';
import { createStartFlowCapabilityRuntime } from '../../app/(app)/start/_lib/capabilities';
import {
  createDrizzleSecurityAuditRepository,
  SecurityAuditService,
} from '../audit';
import { createEventCapabilityRuntime } from '../capabilities/events';
import { createJournalCapabilityRuntime } from '../capabilities/journal';
import { createRecordsCapabilityRuntime } from '../capabilities/records';
import { createDrizzleStaleRosterReportStore } from '../roster/stale-report';
import { AgentApiKeyAdministration } from './admin-capabilities';
import {
  AgentAdministrationFacilityCapabilities,
  DrizzleAgentAdministrationFacilityStore,
} from './admin-facilities';
import { AgentAdministrationPageLoader } from './admin-page';
import { createAgentGatewayAuditSink } from './audit';
import { createDefaultAgentCapabilityDispatcher } from './dispatcher';
import { createDrizzleAgentApiKeyRepository } from './drizzle-key-repository';
import { createDrizzlePreparedActivationCapabilityStore } from './drizzle-prepared-activation-store';
import { createAtomicAgentEventTypeStore } from './event-types';
import { AgentRestGateway } from './gateway';
import { AgentApiKeyService } from './keys';
import { createAgentRosterReportRuntime } from './roster-report';

export interface AgentRestRuntime {
  readonly gateway: AgentRestGateway;
  readonly keys: AgentApiKeyService;
  readonly administration: AgentApiKeyAdministration;
  readonly administrationPage: AgentAdministrationPageLoader;
  close(): Promise<void>;
}

/** Builds the one-deployment agent runtime around explicitly managed storage. */
export function createAgentRestRuntime(
  connection: DatabaseConnection,
): AgentRestRuntime {
  const auditRepository = createDrizzleSecurityAuditRepository(connection.db);
  const audit = createAgentGatewayAuditSink(auditRepository);
  const securityAudit = new SecurityAuditService(auditRepository);
  const keys = new AgentApiKeyService({
    repository: createDrizzleAgentApiKeyRepository(connection.db),
  });
  const administration = new AgentApiKeyAdministration({
    keys,
    audit: auditRepository,
  });
  const administrationFacilities = new AgentAdministrationFacilityCapabilities(
    new DrizzleAgentAdministrationFacilityStore(connection.db),
    auditRepository,
  );
  const administrationPage = new AgentAdministrationPageLoader({
    administration,
    facilities: administrationFacilities,
    securityAudit,
  });
  const events = createEventCapabilityRuntime(connection);
  const journal = createJournalCapabilityRuntime(connection);
  const activationPreviews = createStartFlowCapabilityRuntime(connection);
  const records = createRecordsCapabilityRuntime(journal.store);
  const dispatcher = createDefaultAgentCapabilityDispatcher({
    events,
    journal,
    activationPreviews,
    records,
    administration,
    administrationFacilities,
    eventTypes: createAtomicAgentEventTypeStore(connection.db),
    preparedActivations: createDrizzlePreparedActivationCapabilityStore(
      connection.db,
    ),
    rosterReport: createAgentRosterReportRuntime({
      store: createDrizzleStaleRosterReportStore(connection.db),
    }),
    securityAudit,
  });
  const gateway = new AgentRestGateway({ keys, dispatcher, audit });
  return Object.freeze({
    gateway,
    keys,
    administration,
    administrationPage,
    close: () => events.close(),
  });
}

let defaultRuntime: AgentRestRuntime | undefined;

export function getDefaultAgentRestRuntime(): AgentRestRuntime {
  defaultRuntime ??= createAgentRestRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultRuntime;
}

export function getDefaultAgentRestGateway(): AgentRestGateway {
  return getDefaultAgentRestRuntime().gateway;
}

export function getDefaultAgentApiKeyService(): AgentApiKeyService {
  return getDefaultAgentRestRuntime().keys;
}

export function getDefaultAgentApiKeyAdministration(): AgentApiKeyAdministration {
  return getDefaultAgentRestRuntime().administration;
}

export function getDefaultAgentAdministrationPageLoader(): AgentAdministrationPageLoader {
  return getDefaultAgentRestRuntime().administrationPage;
}

/** Test/script lifecycle hook; normal Next.js processes retain the runtime. */
export async function closeDefaultAgentRestRuntime(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = undefined;
  await runtime?.close();
}
