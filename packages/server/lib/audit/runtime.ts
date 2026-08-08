import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../db/client';
import { createDrizzleSecurityAuditRepository } from './drizzle-repository';
import { SecurityAuditService } from './service';

let defaultConnection: DatabaseConnection | undefined;
let defaultService: SecurityAuditService | undefined;

/** Lazily creates the database-backed service used by server-rendered routes. */
export function getDefaultSecurityAuditService(): SecurityAuditService {
  if (defaultService === undefined) {
    defaultConnection = createDatabaseClient(readDatabaseConfig());
    defaultService = new SecurityAuditService(
      createDrizzleSecurityAuditRepository(defaultConnection.db),
    );
  }
  return defaultService;
}

/** Test/script lifecycle hook; normal Next.js processes retain the pool. */
export async function closeDefaultSecurityAuditService(): Promise<void> {
  const connection = defaultConnection;
  defaultConnection = undefined;
  defaultService = undefined;
  await connection?.close();
}
