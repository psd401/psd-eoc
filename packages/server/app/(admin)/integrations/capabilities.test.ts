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
  assertChannelChangeAllowed,
  liveChannelChangeAuthorizationCommitment,
  liveChannelChangeConsequenceDigest,
  liveChannelChangeRequestDigest,
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
  test('keeps SMS dark until persisted truth is live-verified', () => {
    const error = expectAdminError(
      () =>
        assertChannelChangeAllowed(
          command(SMS_INTEGRATION_ID, true),
          status(SMS_INTEGRATION_ID, 'mocked'),
        ),
      409,
    );

    expect(error.message).toContain('independent live verification');
    expect(() =>
      assertChannelChangeAllowed(
        command(
          SMS_INTEGRATION_ID,
          true,
          authorization(SMS_INTEGRATION_ID, true),
        ),
        status(SMS_INTEGRATION_ID, 'live-verified'),
        SMS_READY,
      ),
    ).not.toThrow();
  });

  test('requires deployed worker readiness without conflating carrier evidence with the live authorization', () => {
    const input = command(
      SMS_INTEGRATION_ID,
      true,
      authorization(SMS_INTEGRATION_ID, true),
    );
    const live = status(SMS_INTEGRATION_ID, 'live-verified');
    for (const readiness of [
      { ready: false, registrationVerificationReference: null },
      { ready: true, registrationVerificationReference: null },
      { ready: true, registrationVerificationReference: 'UNVERIFIED' },
    ]) {
      const error = expectAdminError(
        () => assertChannelChangeAllowed(input, live, readiness),
        409,
      );
      expect(error.message).toContain('worker deployment');
    }

    expect(live.authorizationReference).not.toBe(
      SMS_READY.registrationVerificationReference,
    );
    expect(() =>
      assertChannelChangeAllowed(input, live, SMS_READY),
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

  test('rejects enabling blocked or configured-unverified integrations', () => {
    for (const label of ['blocked', 'configured-unverified'] as const) {
      expectAdminError(
        () =>
          assertChannelChangeAllowed(
            command(`synthetic-${label}`, true),
            status(`synthetic-${label}`, label),
          ),
        409,
      );
    }
  });

  test('requires a pre-issued artifact for every live change', () => {
    const live = status('synthetic-live-provider', 'live-verified');

    for (const enabled of [true, false]) {
      expectAdminError(
        () =>
          assertChannelChangeAllowed(
            command('synthetic-live-provider', enabled),
            live,
          ),
        403,
      );
      expect(() =>
        assertChannelChangeAllowed(
          command(
            'synthetic-live-provider',
            enabled,
            authorization('synthetic-live-provider', enabled),
          ),
          live,
        ),
      ).not.toThrow();
    }
  });

  test('rejects live artifacts on mocked status and binds every digest input', () => {
    const artifact = authorization('synthetic-live-provider', true);
    expectAdminError(
      () =>
        assertChannelChangeAllowed(
          command('synthetic-live-provider', true, artifact),
          status('synthetic-live-provider', 'mocked'),
        ),
      409,
    );

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
