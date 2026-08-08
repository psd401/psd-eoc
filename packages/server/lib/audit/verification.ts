import {
  SecurityAuditEntrySchema,
  SecurityAuditVerificationSchema,
  VerifySecurityAuditChainInputSchema,
  type SecurityAuditEntry,
  type SecurityAuditVerification,
  type VerifySecurityAuditChainInput,
} from '@psd-eoc/contracts';

import {
  calculateSecurityAuditHash,
  securityAuditHashPayload,
} from './canonical';
import { parseSecurityAuditFact, securityAuditFactFromEntry } from './model';

function positiveSequence(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const sequence = Reflect.get(value, 'sequence');
  return Number.isSafeInteger(sequence) && Number(sequence) > 0
    ? Number(sequence)
    : null;
}

function invalid(firstInvalidSequence: number): SecurityAuditVerification {
  return SecurityAuditVerificationSchema.parse({
    valid: false,
    firstInvalidSequence,
  });
}

/** Incremental verifier state; it retains identifiers and hashes, never rows. */
export class SecurityAuditChainVerifier {
  private readonly input: VerifySecurityAuditChainInput;
  private expectedSequence: number;
  private expectedPreviousHash: string | null = null;
  private anchorPending: boolean;
  private verifiedThroughSequence: number;
  private failure: SecurityAuditVerification | null = null;
  private readonly seenIds = new Set<string>();
  private readonly seenHashes = new Set<string>();
  private readonly seenRequestIds = new Set<string>();

  public constructor(inputValue: VerifySecurityAuditChainInput) {
    this.input = VerifySecurityAuditChainInputSchema.parse(inputValue);
    const start = this.input.fromSequence ?? 1;
    this.anchorPending = start > 1;
    this.expectedSequence = this.anchorPending ? start - 1 : 1;
    this.verifiedThroughSequence = this.expectedSequence - 1;
  }

  /** First sequence the repository must return, minus one for keyset paging. */
  public afterSequence(): number {
    return this.expectedSequence - 1;
  }

  /** Adds one ascending page and returns early when it proves tampering. */
  public add(
    entryValues: readonly unknown[],
  ): SecurityAuditVerification | null {
    if (this.failure !== null) return this.failure;

    for (const rawEntry of entryValues) {
      const rawSequence = positiveSequence(rawEntry);
      if (rawSequence !== this.expectedSequence) {
        this.failure = invalid(
          rawSequence === null
            ? this.expectedSequence
            : Math.min(rawSequence, this.expectedSequence),
        );
        return this.failure;
      }
      const parsed = SecurityAuditEntrySchema.safeParse(rawEntry);
      if (!parsed.success) {
        this.failure = invalid(this.expectedSequence);
        return this.failure;
      }
      const entry: SecurityAuditEntry = parsed.data;
      try {
        parseSecurityAuditFact(securityAuditFactFromEntry(entry));
      } catch {
        this.failure = invalid(this.expectedSequence);
        return this.failure;
      }
      const predecessorMatches =
        this.anchorPending || entry.previousHash === this.expectedPreviousHash;
      if (
        !predecessorMatches ||
        this.seenIds.has(entry.id) ||
        this.seenHashes.has(entry.entryHash) ||
        this.seenRequestIds.has(entry.requestId) ||
        calculateSecurityAuditHash(securityAuditHashPayload(entry)) !==
          entry.entryHash
      ) {
        this.failure = invalid(entry.sequence);
        return this.failure;
      }

      this.seenIds.add(entry.id);
      this.seenHashes.add(entry.entryHash);
      this.seenRequestIds.add(entry.requestId);
      this.anchorPending = false;
      this.expectedPreviousHash = entry.entryHash;
      this.expectedSequence = entry.sequence + 1;
      this.verifiedThroughSequence = entry.sequence;
    }
    return null;
  }

  /** Completes a bounded or full scan with only contract-safe result data. */
  public finish(): SecurityAuditVerification {
    if (this.failure !== null) return this.failure;
    if (this.anchorPending) return invalid(this.expectedSequence);
    if (
      this.input.throughSequence !== null &&
      this.verifiedThroughSequence < this.input.throughSequence
    ) {
      return invalid(this.expectedSequence);
    }
    return SecurityAuditVerificationSchema.parse({
      valid: true,
      verifiedThroughSequence: this.verifiedThroughSequence,
    });
  }
}

/**
 * Pure verifier used by tests and bounded callers. A non-genesis range must
 * include its predecessor as an anchor; complete verification begins at one.
 */
export function verifySecurityAuditEntries(
  entryValues: readonly unknown[],
  inputValue: VerifySecurityAuditChainInput = {
    fromSequence: null,
    throughSequence: null,
  },
): SecurityAuditVerification {
  const input = VerifySecurityAuditChainInputSchema.parse(inputValue);
  const minimumSequence = Math.max(1, (input.fromSequence ?? 1) - 1);
  const ordered = [...entryValues]
    .filter((entry) => {
      const sequence = positiveSequence(entry);
      if (sequence === null) return true;
      return (
        sequence >= minimumSequence &&
        (input.throughSequence === null || sequence <= input.throughSequence)
      );
    })
    .sort(
      (left, right) =>
        (positiveSequence(left) ?? minimumSequence) -
        (positiveSequence(right) ?? minimumSequence),
    );
  const verifier = new SecurityAuditChainVerifier(input);
  return verifier.add(ordered) ?? verifier.finish();
}
