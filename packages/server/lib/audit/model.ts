import {
  RegisteredCapabilityIdSchema,
  SecurityAuditEntrySchema,
  UuidSchema,
  type SecurityAuditEntry,
  type SecurityAuditPrincipal,
  type SecurityAuditTarget,
} from '@psd-eoc/contracts';

/**
 * The caller-supplied portion of one security audit entry. Chain identity,
 * sequence, and hashes are always assigned by the serialized writer.
 */
export type SecurityAuditFact = Readonly<
  Omit<SecurityAuditEntry, 'id' | 'sequence' | 'previousHash' | 'entryHash'>
>;

const SECURITY_AUDIT_FACT_KEYS = new Set([
  'category',
  'action',
  'actionIds',
  'confirmationId',
  'outcome',
  'principal',
  'source',
  'facilityId',
  'target',
  'requestId',
  'reasonCode',
  'occurredAt',
]);

const VALIDATION_ENTRY_ID = '00000000-0000-4000-8000-000000000001';
const VALIDATION_ENTRY_HASH = '0'.repeat(64);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

function canonicalPrincipal(
  principal: SecurityAuditPrincipal,
): SecurityAuditPrincipal {
  switch (principal.kind) {
    case 'human':
      return Object.freeze({
        kind: principal.kind,
        userId: canonicalUuid(principal.userId),
        sessionId: canonicalUuid(principal.sessionId),
      });
    case 'agent':
      return Object.freeze({
        kind: principal.kind,
        agentId: canonicalUuid(principal.agentId),
        apiKeyId: canonicalUuid(principal.apiKeyId),
      });
    case 'system':
    case 'unauthenticated':
      return principal;
  }
}

function canonicalTarget(
  target: SecurityAuditTarget | null,
): SecurityAuditTarget | null {
  if (target === null || target.kind === 'capability') return target;
  return Object.freeze({ ...target, id: canonicalUuid(target.id) });
}

/** Extracts only the contract-owned, minimized fact fields from an entry. */
export function securityAuditFactFromEntry(
  entry: SecurityAuditEntry,
): SecurityAuditFact {
  return Object.freeze({
    category: entry.category,
    action: entry.action,
    actionIds: entry.actionIds,
    confirmationId:
      entry.confirmationId === null
        ? null
        : canonicalUuid(entry.confirmationId),
    outcome: entry.outcome,
    principal: canonicalPrincipal(entry.principal),
    source: entry.source,
    facilityId:
      entry.facilityId === null ? null : canonicalUuid(entry.facilityId),
    target: canonicalTarget(entry.target),
    requestId: canonicalUuid(entry.requestId),
    reasonCode: entry.reasonCode,
    occurredAt: new Date(entry.occurredAt).toISOString(),
  });
}

/**
 * Strictly validates an append request against the canonical contract. Unknown
 * fields are rejected so message content, email addresses, provider payloads,
 * and arbitrary metadata cannot drift into the security log.
 */
export function parseSecurityAuditFact(value: unknown): SecurityAuditFact {
  if (!isRecord(value)) {
    throw new TypeError('Security audit facts must be objects.');
  }

  const unexpectedKeys = Object.keys(value).filter(
    (key) => !SECURITY_AUDIT_FACT_KEYS.has(key),
  );
  if (unexpectedKeys.length > 0) {
    throw new TypeError(
      `Security audit facts contain unsupported fields: ${unexpectedKeys
        .sort()
        .join(', ')}.`,
    );
  }

  const parsed = SecurityAuditEntrySchema.parse({
    id: VALIDATION_ENTRY_ID,
    sequence: 1,
    previousHash: null,
    entryHash: VALIDATION_ENTRY_HASH,
    category: value.category,
    action: value.action,
    actionIds: value.actionIds,
    confirmationId: value.confirmationId,
    outcome: value.outcome,
    principal: value.principal,
    source: value.source,
    facilityId: value.facilityId,
    target: value.target,
    requestId: value.requestId,
    reasonCode: value.reasonCode,
    occurredAt: value.occurredAt,
  });
  if (!RegisteredCapabilityIdSchema.safeParse(parsed.action).success) {
    throw new TypeError(
      'Security audit actions must use canonical registered capability IDs.',
    );
  }

  if (parsed.target !== null) {
    const targetIdResult =
      parsed.target.kind === 'capability'
        ? RegisteredCapabilityIdSchema.safeParse(parsed.target.id)
        : UuidSchema.safeParse(parsed.target.id);
    if (
      !targetIdResult.success ||
      (parsed.target.kind === 'capability' &&
        parsed.target.id !== parsed.action)
    ) {
      throw new TypeError(
        'Security audit targets must use canonical capability IDs or opaque UUIDs; contact data is prohibited.',
      );
    }
  }

  return securityAuditFactFromEntry(parsed);
}
