import { describe, expect, test } from 'bun:test';

import { parseCapabilityEnvelopeFor } from '@psd-eoc/contracts';

import {
  appReviewCredentialMatches,
  appReviewSignInDigest,
  createAppReviewSignInExchange,
  readAppReviewSignInDigest,
} from './app-review-sign-in';
import { createCompleteMobileOidcSignInEnvelope } from './oidc';

const EMAIL = 'review-account@example.invalid';
const CODE = 'synthetic-review-code-0123456789abcdef';

describe('app review sign-in configuration', () => {
  test('is off unless a deployment supplies a digest', () => {
    expect(readAppReviewSignInDigest(undefined)).toBeNull();
    expect(readAppReviewSignInDigest('')).toBeNull();
    expect(readAppReviewSignInDigest('disabled')).toBeNull();
    expect(readAppReviewSignInDigest('abc123')).toBeNull();
    const digest = appReviewSignInDigest(EMAIL, CODE);
    expect(readAppReviewSignInDigest(` ${digest.toUpperCase()} `)).toBe(digest);
  });
});

describe('app review credential', () => {
  const digest = appReviewSignInDigest(EMAIL, CODE);

  test('accepts the configured email and code', () => {
    expect(appReviewCredentialMatches(digest, EMAIL, CODE)).toBe(true);
  });

  test('ignores email case and surrounding space, as a reviewer types it', () => {
    expect(
      appReviewCredentialMatches(
        digest,
        ' Review-Account@Example.invalid ',
        ` ${CODE} `,
      ),
    ).toBe(true);
  });

  test('refuses a different code or a different account', () => {
    expect(appReviewCredentialMatches(digest, EMAIL, `${CODE}x`)).toBe(false);
    expect(
      appReviewCredentialMatches(digest, 'someone@example.invalid', CODE),
    ).toBe(false);
  });
});

describe('app review sign-in evidence', () => {
  test('is accepted by the canonical sign-in capability envelope', () => {
    const requestId = crypto.randomUUID();
    const exchange = createAppReviewSignInExchange({
      clientId: 'synthetic-client-id',
      googleSubject: 'synthetic-review-subject',
      email: EMAIL,
      displayName: 'App review account',
      platform: 'android',
      installationId: 'synthetic-installation-0001',
      requestId,
    });
    const envelope = parseCapabilityEnvelopeFor(
      'complete-oidc-sign-in',
      createCompleteMobileOidcSignInEnvelope(exchange, {
        requestId,
        serverTime: new Date().toISOString(),
      }),
    );
    expect(envelope.source).toBe('mobile');
    expect(envelope.idempotencyKey).toBe(`oidc:${exchange.responseDigest}`);
    expect(exchange.capabilityInput.device).toEqual({
      platform: 'android',
      unlockMethod: 'biometric',
      installationId: 'synthetic-installation-0001',
    });
  });

  test('gives every sign-in its own replay key', () => {
    const base = {
      clientId: 'synthetic-client-id',
      googleSubject: 'synthetic-review-subject',
      email: EMAIL,
      displayName: 'App review account',
      platform: 'ios' as const,
      installationId: 'synthetic-installation-0001',
    };
    const first = createAppReviewSignInExchange({
      ...base,
      requestId: crypto.randomUUID(),
    });
    const second = createAppReviewSignInExchange({
      ...base,
      requestId: crypto.randomUUID(),
    });
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});
