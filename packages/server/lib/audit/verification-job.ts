import { randomUUID } from 'node:crypto';

import type { SecurityAuditVerification } from '@psd-eoc/contracts';

import { createDatabaseClient, readDatabaseConfig } from '../../db/client';
import { executeVerifySecurityAuditChainCapability } from './capabilities';
import { createDrizzleSecurityAuditRepository } from './drizzle-repository';
import { SecurityAuditService } from './service';

export interface SecurityAuditVerificationJobOptions {
  readonly service: SecurityAuditService;
  readonly serviceId?: string;
  readonly requestId?: string;
  readonly now?: Date;
  readonly fromSequence?: number | null;
  readonly throughSequence?: number | null;
}

/** Runs the canonical district-wide verifier as a scheduled system actor. */
export function runSecurityAuditVerificationJob(
  options: SecurityAuditVerificationJobOptions,
): Promise<SecurityAuditVerification> {
  return executeVerifySecurityAuditChainCapability({
    service: options.service,
    access: {
      actor: {
        kind: 'system',
        serviceId: options.serviceId ?? 'security-audit-verifier',
      },
      source: 'scheduled-job',
      facilityScope: { kind: 'district' },
      roles: [],
      capabilityGrants: [],
    },
    verification: {
      fromSequence: options.fromSequence ?? null,
      throughSequence: options.throughSequence ?? null,
    },
    requestId: options.requestId ?? randomUUID(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** Creates and closes an explicitly configured database client for one run. */
export async function runConfiguredSecurityAuditVerificationJob(): Promise<SecurityAuditVerification> {
  const connection = createDatabaseClient(readDatabaseConfig());
  try {
    return await runSecurityAuditVerificationJob({
      service: new SecurityAuditService(
        createDrizzleSecurityAuditRepository(connection.db),
      ),
    });
  } finally {
    await connection.close();
  }
}

if (import.meta.main) {
  const verification = await runConfiguredSecurityAuditVerificationJob();
  if (!verification.valid) {
    console.error(
      `Security audit chain invalid at sequence ${verification.firstInvalidSequence}.`,
    );
    process.exitCode = 1;
  }
}
