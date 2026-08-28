import { describe, expect, test } from 'bun:test';

import {
  IntegrationChannelChangeAuthorizationSchema,
  IntegrationStatusSchema,
  SetChannelEnabledInputSchema,
  type IntegrationChannelChangeAuthorization,
  type IntegrationStatus,
} from '@psd-eoc/contracts';

import { AdminCapabilityError } from '../../../lib/capabilities/admin';
import {
  SMS_INTEGRATION_ID,
  assertExactDirectPushVerificationReference,
  assertChannelChangeAllowed,
  liveChannelChangeAuthorizationCommitment,
  liveChannelChangeConsequenceDigest,
  liveChannelChangeRequestDigest,
  readDirectPushVerificationReference,
  readSmsWorkerReadiness,
} from './capabilities';

const AT = '2026-08-10T12:00:00.000Z';
const USER_ID = '00000000-0000-4000-8000-000000002670';
const SESSION_ID = '00000000-0000-4000-8000-000000002671';
const STATUS_ID = '00000000-0000-4000-8000-000000002672';
const ZERO_DIGEST = '0'.repeat(64);
const SMS_READY = Object.freeze({
  ready: true,
  registrationVerificationReference: 'carrier-registration-case-279',
});

function status(
  integrationId: string,
  label: 'mocked' | 'configured-unverified' | 'live-verified' | 'blocked',
): IntegrationStatus {
  return IntegrationStatusSchema.parse({
    integrationId,
    label,
    verifiedAt: label === 'live-verified' ? AT : null,
    verifiedByUserId: label === 'live-verified' ? USER_ID : null,
    authorizationReference:
      label === 'live-verified' ? 'po-approval-issue-26' : null,
    reasonCode: label === 'blocked' ? 'PREREQUISITE_PENDING' : null,
    observedAt: AT,
  });
}

function command(
  integrationId: string,
  enabled: boolean,
  authorization: IntegrationChannelChangeAuthorization | null = null,
) {
  return SetChannelEnabledInputSchema.parse({
    integrationId,
    enabled,
    authorization,
  });
}

function authorization(
  integrationId: string,
  desiredEnabled: boolean,
): IntegrationChannelChangeAuthorization {
  return IntegrationChannelChangeAuthorizationSchema.parse({
    reference: 'issue-26-live-change-authorization',
    integrationStatusId: STATUS_ID,
    integrationId,
    desiredEnabled,
    requestDigest: ZERO_DIGEST,
    consequenceDigest: ZERO_DIGEST,
    authorizedByUserId: USER_ID,
    authorizedWithSessionId: SESSION_ID,
    issuedAt: AT,
    expiresAt: '2026-08-10T12:15:00.000Z',
  });
}

function expectAdminError(
  operation: () => void,
  expectedStatus: 403 | 409,
): AdminCapabilityError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminCapabilityError);
    expect((error as AdminCapabilityError).status).toBe(expectedStatus);
    return error as AdminCapabilityError;
  }
  throw new Error('Expected the channel change to fail closed.');
}

describe('integration channel administration boundary', () => {
  test('refuses to enable an integration blocked by an external prerequisite', () => {
    const error = expectAdminError(
      () =>
        assertChannelChangeAllowed(
          command(SMS_INTEGRATION_ID, true),
          status(SMS_INTEGRATION_ID, 'blocked'),
        ),
      409,
    );

    expect(error.message).toContain('external prerequisite');
  });

  test('lets an administrator disable a blocked integration', () => {
    expect(() =>
      assertChannelChangeAllowed(
        command(SMS_INTEGRATION_ID, false),
        status(SMS_INTEGRATION_ID, 'blocked'),
      ),
    ).not.toThrow();
  });

  test('reads readiness only from the deployed worker and bounded carrier-registration evidence', () => {
    expect(
      readSmsWorkerReadiness({
        PSD_EOC_SMS_WORKER_READY: 'true',
        PSD_EOC_SMS_REGISTRATION_VERIFICATION_REFERENCE:
          'carrier-registration-case-279',
      }),
    ).toEqual(SMS_READY);
    expect(
      readSmsWorkerReadiness({
        PSD_EOC_SMS_WORKER_READY: 'true',
        PSD_EOC_SMS_REGISTRATION_VERIFICATION_REFERENCE: 'UNVERIFIED',
      }),
    ).toEqual({ ready: false, registrationVerificationReference: null });
  });

  test('lets an administrator enable a channel from any unblocked truth label', () => {
    for (const label of [
      'mocked',
      'configured-unverified',
      'live-verified',
    ] as const) {
      expect(() =>
        assertChannelChangeAllowed(
          command(`synthetic-${label}`, true),
          status(`synthetic-${label}`, label),
        ),
      ).not.toThrow();
    }
  });

  test('lets an administrator enable mobile push without a direct-push artifact', () => {
    const enableMobilePush = SetChannelEnabledInputSchema.parse({
      integrationId: 'mobile-push',
      enabled: true,
      authorization: null,
    });
    for (const label of [
      'mocked',
      'configured-unverified',
      'live-verified',
    ] as const) {
      expect(() =>
        assertChannelChangeAllowed(
          enableMobilePush,
          status('mobile-push', label),
        ),
      ).not.toThrow();
    }
  });

  test('binds initial direct-push verification to protected deployment truth', () => {
    const expected = 'issue-43-direct-push-proof-001';
    expect(
      readDirectPushVerificationReference({
        PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE: expected,
      }),
    ).toBe(expected);
    for (const value of [undefined, 'UNVERIFIED', 'issue-43/proof']) {
      expect(
        readDirectPushVerificationReference({
          PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE: value,
        }),
      ).toBeNull();
    }
    expect(() =>
      assertExactDirectPushVerificationReference(expected, expected),
    ).not.toThrow();
    expectAdminError(
      () =>
        assertExactDirectPushVerificationReference(
          'issue-43-direct-push-proof-002',
          expected,
        ),
      409,
    );
    expectAdminError(
      () => assertExactDirectPushVerificationReference(expected, null),
      409,
    );
  });

  test('needs no pre-issued artifact to change a live channel either way', () => {
    const live = status('synthetic-live-provider', 'live-verified');

    for (const enabled of [true, false]) {
      expect(() =>
        assertChannelChangeAllowed(
          command('synthetic-live-provider', enabled),
          live,
        ),
      ).not.toThrow();
    }
  });

  test('binds every digest input for the retained authorization record', () => {
    const artifact = authorization('synthetic-live-provider', true);

    expect(liveChannelChangeRequestDigest(artifact)).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      liveChannelChangeConsequenceDigest({
        integrationId: artifact.integrationId,
        previousConfiguration: null,
        desiredEnabled: artifact.desiredEnabled,
        integrationStatusId: artifact.integrationStatusId,
      }),
    ).not.toBe(
      liveChannelChangeConsequenceDigest({
        integrationId: artifact.integrationId,
        previousConfiguration: null,
        desiredEnabled: false,
        integrationStatusId: artifact.integrationStatusId,
      }),
    );
    expect(liveChannelChangeAuthorizationCommitment(artifact)).not.toBe(
      liveChannelChangeAuthorizationCommitment({
        ...artifact,
        expiresAt: '2026-08-10T12:14:59.000Z',
      }),
    );
  });

  test('contract-rejects artifacts copied to a different integration or state', () => {
    const artifact = authorization('synthetic-live-provider', true);
    expect(
      SetChannelEnabledInputSchema.safeParse({
        integrationId: 'different-live-provider',
        enabled: true,
        authorization: artifact,
      }).success,
    ).toBe(false);
    expect(
      SetChannelEnabledInputSchema.safeParse({
        integrationId: artifact.integrationId,
        enabled: false,
        authorization: artifact,
      }).success,
    ).toBe(false);
  });

  test('accepts equivalent offset instants and rejects lossy sub-millisecond timestamps', () => {
    const artifact = authorization('synthetic-live-provider', true);
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...artifact,
        issuedAt: '2026-08-10T05:00:00.000-07:00',
      }).success,
    ).toBe(true);
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...artifact,
        issuedAt: '2026-08-10T12:00:00.123456Z',
      }).success,
    ).toBe(false);
    expect(
      IntegrationChannelChangeAuthorizationSchema.safeParse({
        ...artifact,
        expiresAt: '2026-08-10T12:15:00.000001Z',
      }).success,
    ).toBe(false);
  });

  test('canonicalizes authorization UUIDs before commitment and comparison', () => {
    const artifact = authorization('synthetic-live-provider', true);
    const parsed = IntegrationChannelChangeAuthorizationSchema.parse({
      ...artifact,
      integrationStatusId: artifact.integrationStatusId.toUpperCase(),
      authorizedByUserId: artifact.authorizedByUserId.toUpperCase(),
      authorizedWithSessionId: artifact.authorizedWithSessionId.toUpperCase(),
    });

    expect(parsed.integrationStatusId).toBe(artifact.integrationStatusId);
    expect(parsed.authorizedByUserId).toBe(artifact.authorizedByUserId);
    expect(parsed.authorizedWithSessionId).toBe(
      artifact.authorizedWithSessionId,
    );
    expect(liveChannelChangeAuthorizationCommitment(parsed)).toBe(
      liveChannelChangeAuthorizationCommitment(artifact),
    );
  });
});
