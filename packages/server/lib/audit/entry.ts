import { randomUUID } from 'node:crypto';

import {
  SecurityAuditEntrySchema,
  SecurityAuditHashSchema,
  UuidSchema,
  type SecurityAuditEntry,
} from '@psd-eoc/contracts';

import { calculateSecurityAuditHash } from './canonical';
import { parseSecurityAuditFact, type SecurityAuditFact } from './model';

/** The serialized chain head required to build the next append-only entry. */
export interface SecurityAuditPredecessor {
  readonly sequence: number;
  readonly entryHash: string;
}

export interface BuildSecurityAuditEntryOptions {
  readonly createId?: () => string;
}

/**
 * Builds and validates one immutable entry after its caller has serialized the
 * chain. Persistence code must hold the shared audit advisory lock first.
 */
export function buildSecurityAuditEntry(
  factValue: SecurityAuditFact | unknown,
  previous: SecurityAuditPredecessor | null,
  options: BuildSecurityAuditEntryOptions = {},
): SecurityAuditEntry {
  const fact = parseSecurityAuditFact(factValue);
  if (previous !== null) {
    if (!Number.isSafeInteger(previous.sequence) || previous.sequence < 1) {
      throw new TypeError('Security audit predecessor sequence is invalid.');
    }
    SecurityAuditHashSchema.parse(previous.entryHash);
  }

  const id = UuidSchema.parse((options.createId ?? randomUUID)()).toLowerCase();
  const payload = {
    id,
    sequence: (previous?.sequence ?? 0) + 1,
    previousHash: previous?.entryHash ?? null,
    ...fact,
  } as const;

  return SecurityAuditEntrySchema.parse({
    ...payload,
    entryHash: calculateSecurityAuditHash(payload),
  });
}
