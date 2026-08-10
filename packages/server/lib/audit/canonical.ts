import { createHash } from 'node:crypto';

import type { SecurityAuditEntry } from '@psd-eoc/contracts';

/** Every immutable entry field except the hash derived from those fields. */
export type SecurityAuditHashPayload = Readonly<
  Omit<SecurityAuditEntry, 'entryHash'>
>;

/**
 * Recursively sorts object keys while retaining array order. This is byte-for-
 * byte compatible with the issue #6 sign-in audit writer already in use.
 */
export function canonicalSecurityAuditJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSecurityAuditJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSecurityAuditJson(record[key])}`,
      )
      .join(',')}}`;
  }

  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Security audit hash payloads must be JSON values.');
  }
  return encoded;
}

/** Calculates a lowercase SHA-256 digest for canonical audit-owned data. */
export function calculateCanonicalSecurityAuditDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalSecurityAuditJson(value), 'utf8')
    .digest('hex');
}

/** Calculates the lowercase SHA-256 digest for one canonical entry payload. */
export function calculateSecurityAuditHash(
  payload: SecurityAuditHashPayload,
): string {
  return calculateCanonicalSecurityAuditDigest(payload);
}

/** Removes only the derived hash, preserving every field covered by it. */
export function securityAuditHashPayload(
  entry: SecurityAuditEntry,
): SecurityAuditHashPayload {
  return {
    id: entry.id,
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    category: entry.category,
    action: entry.action,
    actionIds: entry.actionIds,
    confirmationId: entry.confirmationId,
    outcome: entry.outcome,
    principal: entry.principal,
    source: entry.source,
    facilityId: entry.facilityId,
    target: entry.target,
    requestId: entry.requestId,
    reasonCode: entry.reasonCode,
    occurredAt: entry.occurredAt,
  };
}
