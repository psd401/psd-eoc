import { describe, expect, test } from 'bun:test';

import {
  EmailAttemptReferenceMessageSchema,
  EmailRuntimeRequestSchema,
  SesSendLedgerClaimSchema,
} from './email-runtime';

const ATTEMPT_ID = '10000000-0000-4000-8000-000000000001';
const LEASE_TOKEN = '10000000-0000-4000-8000-000000000002';
const FINGERPRINT = 'a'.repeat(64);

describe('email runtime contracts', () => {
  test('accepts only destination-free retry references', () => {
    expect(
      EmailAttemptReferenceMessageSchema.parse({
        kind: 'ses-email-attempt-reference',
        sourceAttemptId: ATTEMPT_ID,
      }),
    ).toEqual({
      kind: 'ses-email-attempt-reference',
      sourceAttemptId: ATTEMPT_ID,
    });
    expect(
      EmailAttemptReferenceMessageSchema.safeParse({
        kind: 'ses-email-attempt-reference',
        sourceAttemptId: ATTEMPT_ID,
        email: 'must-not-enter-the-queue@example.invalid',
      }).success,
    ).toBeFalse();
  });

  test('requires an exact digest and lease for durable SES completion', () => {
    const request = {
      operation: 'complete-provider-io',
      attemptId: ATTEMPT_ID,
      requestFingerprint: FINGERPRINT,
      leaseToken: LEASE_TOKEN,
      outcome: {
        state: 'provider-accepted',
        provider: 'aws-ses-v2',
        providerReference: 'provider-message-id',
        proof: null,
        reasonCode: null,
        diagnosticDigest: null,
      },
    } as const;

    expect(EmailRuntimeRequestSchema.parse(request)).toEqual(request);
    expect(
      EmailRuntimeRequestSchema.safeParse({
        ...request,
        requestFingerprint: 'not-a-digest',
      }).success,
    ).toBeFalse();
  });

  test('preserves an unfinished provider claim as in-progress', () => {
    expect(SesSendLedgerClaimSchema.parse({ kind: 'in-progress' })).toEqual({
      kind: 'in-progress',
    });
    expect(
      SesSendLedgerClaimSchema.safeParse({
        kind: 'acquired',
        leaseToken: 'not-a-uuid',
      }).success,
    ).toBeFalse();
  });
});
