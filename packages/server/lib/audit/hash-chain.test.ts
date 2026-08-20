import { describe, expect, test } from 'bun:test';

import type { SecurityAuditEntry } from '@psd-eoc/contracts';

import { buildAccessGateAuditEntry } from '../auth/sign-in-audit';
import {
  calculateSecurityAuditHash,
  canonicalSecurityAuditJson,
  securityAuditHashPayload,
} from './canonical';
import { buildSecurityAuditEntry } from './entry';
import { parseSecurityAuditFact, securityAuditFactFromEntry } from './model';
import {
  SecurityAuditChainVerifier,
  verifySecurityAuditEntries,
} from './verification';

const REQUEST_ONE = '00000000-0000-4000-8000-000000000101';
const REQUEST_TWO = '00000000-0000-4000-8000-000000000102';
const REQUEST_THREE = '00000000-0000-4000-8000-000000000103';
const REQUEST_FOUR = '00000000-0000-4000-8000-000000000104';
const ENTRY_TWO = '00000000-0000-4000-8000-000000000202';
const ENTRY_THREE = '00000000-0000-4000-8000-000000000203';
const ENTRY_FOUR = '00000000-0000-4000-8000-000000000204';
const OCCURRED_AT = '2026-08-08T12:00:00.000Z';

function verificationFact(requestId: string, occurredAt: string = OCCURRED_AT) {
  return {
    category: 'audit-query',
    action: 'verify-security-audit-chain',
    actionIds: [],
    confirmationId: null,
    outcome: 'success',
    principal: { kind: 'system', serviceId: 'security-audit-verifier' },
    source: 'scheduled-job',
    facilityId: null,
    target: { kind: 'audit-query', id: requestId },
    requestId,
    reasonCode: null,
    occurredAt,
  } as const;
}

function buildVerificationEntry(
  previous: SecurityAuditEntry,
  requestId: string,
  entryId: string,
): SecurityAuditEntry {
  return buildSecurityAuditEntry(verificationFact(requestId), previous, {
    createId: () => entryId,
  });
}

function compatibleChain(): readonly [SecurityAuditEntry, SecurityAuditEntry] {
  const signInEntry = buildAccessGateAuditEntry(
    {
      outcome: 'denied',
      requestId: REQUEST_ONE,
      occurredAt: OCCURRED_AT,
      subjectDigest: 'a'.repeat(64),
      reasonCode: 'UNKNOWN_USER',
      userId: null,
      source: 'web',
    },
    null,
  );
  const verificationEntry = buildVerificationEntry(
    signInEntry,
    REQUEST_TWO,
    ENTRY_TWO,
  );
  return [signInEntry, verificationEntry];
}

function fourEntryChain(): readonly [
  SecurityAuditEntry,
  SecurityAuditEntry,
  SecurityAuditEntry,
  SecurityAuditEntry,
] {
  const [first, second] = compatibleChain();
  const third = buildVerificationEntry(second, REQUEST_THREE, ENTRY_THREE);
  const fourth = buildVerificationEntry(third, REQUEST_FOUR, ENTRY_FOUR);
  return [first, second, third, fourth];
}

describe('security audit hash chain', () => {
  test('preserves native source for post-gate denial and successful sign-in facts', () => {
    const denial = buildAccessGateAuditEntry(
      {
        outcome: 'denied',
        requestId: REQUEST_ONE,
        occurredAt: OCCURRED_AT,
        subjectDigest: 'b'.repeat(64),
        reasonCode: 'SESSION_REPLAY_REJECTED',
        userId: REQUEST_THREE,
        source: 'mobile',
      },
      null,
    );
    const success = buildAccessGateAuditEntry(
      {
        outcome: 'success',
        requestId: REQUEST_TWO,
        occurredAt: OCCURRED_AT,
        userId: REQUEST_THREE,
        sessionId: REQUEST_FOUR,
        source: 'mobile',
      },
      { sequence: denial.sequence, entryHash: denial.entryHash },
    );

    expect(denial).toMatchObject({
      category: 'access-denial',
      outcome: 'denied',
      source: 'mobile',
      target: { kind: 'user', id: REQUEST_THREE },
      reasonCode: 'SESSION_REPLAY_REJECTED',
    });
    expect(success).toMatchObject({
      category: 'sign-in',
      outcome: 'success',
      source: 'mobile',
      target: { kind: 'session', id: REQUEST_FOUR },
    });
    expect(verifySecurityAuditEntries([denial, success])).toEqual({
      valid: true,
      verifiedThroughSequence: 2,
    });
  });

  test('verifies existing sign-in entries and generic entries together', () => {
    const entries = compatibleChain();
    expect(entries[1].sequence).toBe(2);
    expect(entries[1].previousHash).toBe(entries[0].entryHash);
    expect(verifySecurityAuditEntries([...entries].reverse())).toEqual({
      valid: true,
      verifiedThroughSequence: 2,
    });
    expect(
      verifySecurityAuditEntries(entries, {
        fromSequence: 1,
        throughSequence: 1,
      }),
    ).toEqual({ valid: true, verifiedThroughSequence: 1 });
  });

  test('identifies the first changed payload without exposing its contents', () => {
    const entries = compatibleChain();
    const tampered = [
      entries[0],
      { ...entries[1], action: 'query-security-audit' },
    ];
    expect(verifySecurityAuditEntries(tampered)).toEqual({
      valid: false,
      firstInvalidSequence: 2,
    });
  });

  test('detects gaps and duplicate identities', () => {
    const entries = compatibleChain();
    expect(
      verifySecurityAuditEntries([{ ...entries[1], sequence: 3 }]),
    ).toEqual({ valid: false, firstInvalidSequence: 1 });
    expect(
      verifySecurityAuditEntries([
        entries[0],
        { ...entries[1], id: entries[0].id },
      ]),
    ).toEqual({ valid: false, firstInvalidSequence: 2 });
  });

  test('detects a missing requested tail sequence', () => {
    const entries = compatibleChain();
    expect(
      verifySecurityAuditEntries(entries, {
        fromSequence: 1,
        throughSequence: 3,
      }),
    ).toEqual({ valid: false, firstInvalidSequence: 3 });
  });

  test('uses the preceding entry as a non-genesis range anchor across pages', () => {
    const [, second, third, fourth] = fourEntryChain();
    const verifier = new SecurityAuditChainVerifier({
      fromSequence: 3,
      throughSequence: 4,
    });

    expect(verifier.afterSequence()).toBe(1);
    expect(verifier.add([second])).toBeNull();
    expect(verifier.afterSequence()).toBe(2);
    expect(verifier.add([third])).toBeNull();
    expect(verifier.add([fourth])).toBeNull();
    expect(verifier.finish()).toEqual({
      valid: true,
      verifiedThroughSequence: 4,
    });

    const missingAnchor = new SecurityAuditChainVerifier({
      fromSequence: 3,
      throughSequence: 4,
    });
    expect(missingAnchor.add([third])).toEqual({
      valid: false,
      firstInvalidSequence: 2,
    });

    const changedAnchor = new SecurityAuditChainVerifier({
      fromSequence: 3,
      throughSequence: 4,
    });
    expect(
      changedAnchor.add([{ ...second, action: 'query-security-audit' }]),
    ).toEqual({ valid: false, firstInvalidSequence: 2 });
  });

  test('reports malformed raw persisted rows as structured tamper evidence', () => {
    const entries = compatibleChain();
    const verifier = new SecurityAuditChainVerifier({
      fromSequence: null,
      throughSequence: null,
    });

    expect(verifier.add([entries[0]])).toBeNull();
    expect(
      verifier.add([{ ...entries[1], persistedPrincipalKind: 'agent' }]),
    ).toEqual({ valid: false, firstInvalidSequence: 2 });
    expect(verifier.finish()).toEqual({
      valid: false,
      firstInvalidSequence: 2,
    });
  });

  test('rejects a hash-consistent persisted row that violates PII policy', () => {
    const [first, second] = compatibleChain();
    const unsafe = {
      ...second,
      target: { kind: 'configuration', id: '2535551212' },
    } as SecurityAuditEntry;
    const entry = {
      ...unsafe,
      entryHash: calculateSecurityAuditHash(securityAuditHashPayload(unsafe)),
    };

    expect(verifySecurityAuditEntries([first, entry])).toEqual({
      valid: false,
      firstInvalidSequence: 2,
    });
  });

  test('hashes the canonical timestamp preserved by a database Date round trip', () => {
    const fact = parseSecurityAuditFact(
      verificationFact(
        '00000000-0000-4000-8000-000000000105',
        '2026-08-08T05:00:00.123456-07:00',
      ),
    );
    const entry = buildSecurityAuditEntry(fact, null, {
      createId: () => '00000000-0000-4000-8000-000000000205',
    });
    const roundTripped = {
      ...entry,
      occurredAt: new Date(entry.occurredAt).toISOString(),
    };

    expect(entry.occurredAt).toBe('2026-08-08T12:00:00.123Z');
    expect(roundTripped.occurredAt).toBe(entry.occurredAt);
    expect(verifySecurityAuditEntries([roundTripped])).toEqual({
      valid: true,
      verifiedThroughSequence: 1,
    });
  });

  test('canonicalizes UUID text before database persistence and retry comparison', () => {
    const rawFact = {
      category: 'admin-change',
      action: 'update-facility',
      actionIds: [],
      confirmationId: null,
      outcome: 'success',
      principal: {
        kind: 'human',
        userId: '00000000-0000-4000-8000-ABCDEFABCDE1',
        sessionId: '00000000-0000-4000-8000-ABCDEFABCDE2',
      },
      source: 'web',
      facilityId: '00000000-0000-4000-8000-ABCDEFABCDE3',
      target: {
        kind: 'configuration',
        id: '00000000-0000-4000-8000-ABCDEFABCDE3',
      },
      requestId: '00000000-0000-4000-8000-ABCDEFABCDE4',
      reasonCode: null,
      occurredAt: OCCURRED_AT,
    } as const;
    const fact = parseSecurityAuditFact(rawFact);
    const entry = buildSecurityAuditEntry(fact, null, {
      createId: () => '00000000-0000-4000-8000-ABCDEFABCDE5',
    });
    const persistedFact = securityAuditFactFromEntry({
      ...entry,
      id: entry.id.toLowerCase(),
      facilityId: entry.facilityId?.toLowerCase() ?? null,
      requestId: entry.requestId.toLowerCase(),
    });

    expect(entry.id).toBe('00000000-0000-4000-8000-abcdefabcde5');
    expect(entry.principal).toEqual({
      kind: 'human',
      userId: '00000000-0000-4000-8000-abcdefabcde1',
      sessionId: '00000000-0000-4000-8000-abcdefabcde2',
    });
    expect(entry.facilityId).toBe('00000000-0000-4000-8000-abcdefabcde3');
    expect(entry.target?.id).toBe('00000000-0000-4000-8000-abcdefabcde3');
    expect(entry.requestId).toBe('00000000-0000-4000-8000-abcdefabcde4');
    expect(canonicalSecurityAuditJson(persistedFact)).toBe(
      canonicalSecurityAuditJson(fact),
    );
    expect(verifySecurityAuditEntries([entry])).toEqual({
      valid: true,
      verifiedThroughSequence: 1,
    });
  });

  test('treats an empty retained chain as valid through sequence zero', () => {
    expect(verifySecurityAuditEntries([])).toEqual({
      valid: true,
      verifiedThroughSequence: 0,
    });
  });

  test('rejects arbitrary PII and message-content fields before hashing', () => {
    const baseFact = {
      category: 'agent-access',
      action: 'list-facilities',
      actionIds: [],
      confirmationId: null,
      outcome: 'success',
      principal: {
        kind: 'agent',
        agentId: '00000000-0000-4000-8000-000000000301',
        apiKeyId: '00000000-0000-4000-8000-000000000302',
      },
      source: 'agent-rest',
      facilityId: null,
      target: { kind: 'capability', id: 'list-facilities' },
      requestId: '00000000-0000-4000-8000-000000000303',
      reasonCode: null,
      occurredAt: OCCURRED_AT,
    } as const;

    expect(() =>
      parseSecurityAuditFact({
        ...baseFact,
        email: 'synthetic.staff@psd401.net',
        messageContent: 'content must never enter this log',
      }),
    ).toThrow('unsupported fields');
    expect(() =>
      parseSecurityAuditFact({
        ...baseFact,
        target: {
          kind: 'configuration',
          id: 'synthetic.staff@psd401.net',
        },
      }),
    ).toThrow('contact data is prohibited');
    expect(() =>
      parseSecurityAuditFact({
        ...baseFact,
        target: {
          kind: 'configuration',
          id: '2535551212',
        },
      }),
    ).toThrow('contact data is prohibited');
    expect(() =>
      parseSecurityAuditFact({
        ...baseFact,
        target: {
          kind: 'capability',
          id: '2535551212',
        },
      }),
    ).toThrow('contact data is prohibited');
  });
});
