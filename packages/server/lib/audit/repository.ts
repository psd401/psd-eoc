import type {
  FacilityScope,
  SecurityAuditEntry,
  SecurityAuditHash,
  SecurityAuditPage,
  SecurityAuditQuery,
} from '@psd-eoc/contracts';

import type { SecurityAuditFact } from './model';

/**
 * Append-only persistence boundary. Deliberately no update or delete methods
 * exist; the database independently rejects both operations for audit rows.
 */
export interface SecurityAuditVerificationStore {
  append(fact: SecurityAuditFact | unknown): Promise<SecurityAuditEntry>;
  readChainAnchor(
    throughSequence: number | null,
  ): Promise<SecurityAuditChainAnchor | null>;
  readChainPage(
    input: SecurityAuditChainPageInput,
  ): Promise<SecurityAuditChainPage>;
}

export interface SecurityAuditRepository extends SecurityAuditVerificationStore {
  query(
    query: SecurityAuditQuery,
    facilityScope: FacilityScope,
  ): Promise<SecurityAuditPage>;
  runVerificationSession<T>(
    operation: (store: SecurityAuditVerificationStore) => Promise<T>,
  ): Promise<T>;
}

/** Latest independently retained commitment to the audit-chain terminal row. */
export interface SecurityAuditChainAnchor {
  readonly sequence: number;
  readonly entryHash: SecurityAuditHash;
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
  /** Earliest row whose persisted hash differs from its durable anchor. */
  readonly firstAnchorMismatchSequence: number | null;
}

/** A persisted audit row and its independently retained anchor disagree. */
export class SecurityAuditIntegrityError extends Error {
  public constructor(public readonly firstInvalidSequence: number) {
    super('The security audit chain does not match its durable anchor.');
    this.name = 'SecurityAuditIntegrityError';
  }
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
