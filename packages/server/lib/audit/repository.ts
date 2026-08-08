import type {
  FacilityScope,
  SecurityAuditEntry,
  SecurityAuditPage,
  SecurityAuditQuery,
} from '@psd-eoc/contracts';

import type { SecurityAuditFact } from './model';

/**
 * Append-only persistence boundary. Deliberately no update or delete methods
 * exist; the database independently rejects both operations for audit rows.
 */
export interface SecurityAuditRepository {
  append(fact: SecurityAuditFact | unknown): Promise<SecurityAuditEntry>;
  query(
    query: SecurityAuditQuery,
    facilityScope: FacilityScope,
  ): Promise<SecurityAuditPage>;
  readChainPage(
    input: SecurityAuditChainPageInput,
  ): Promise<SecurityAuditChainPage>;
}

/** Bounded verifier read that stays below Aurora Data API response limits. */
export interface SecurityAuditChainPageInput {
  readonly afterSequence: number;
  readonly throughSequence: number | null;
  readonly limit: number;
}

/** Raw candidates let the verifier report malformed persisted rows as tamper. */
export interface SecurityAuditChainPage {
  readonly entries: readonly unknown[];
  readonly lastSequence: number | null;
  readonly hasMore: boolean;
}

/** Conflicting reuse of a request ID never silently changes audit truth. */
export class SecurityAuditRequestConflictError extends Error {
  public constructor() {
    super('The security audit request ID is already bound to another fact.');
    this.name = 'SecurityAuditRequestConflictError';
  }
}

/** Malformed or cross-query cursors fail closed without exposing internals. */
export class SecurityAuditCursorError extends Error {
  public constructor() {
    super('The security audit cursor is invalid for this query.');
    this.name = 'SecurityAuditCursorError';
  }
}

/** Explicit requests outside the server-resolved facility scope are denied. */
export class SecurityAuditScopeError extends Error {
  public constructor() {
    super('The requested security audit facility is outside caller scope.');
    this.name = 'SecurityAuditScopeError';
  }
}
