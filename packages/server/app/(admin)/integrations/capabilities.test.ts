import { describe, expect, test } from 'bun:test';

import {
  IntegrationStatusSchema,
  SetChannelEnabledInputSchema,
  type IntegrationStatus,
} from '@psd-eoc/contracts';

import { AdminCapabilityError } from '../facilities/admin-core';
import { SMS_INTEGRATION_ID, assertChannelChangeAllowed } from './capabilities';

const AT = '2026-08-10T12:00:00.000Z';
const USER_ID = '00000000-0000-4000-8000-000000002670';

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
  productOwnerApprovalReference = 'po-approval-issue-26',
) {
  return SetChannelEnabledInputSchema.parse({
    integrationId,
    enabled,
    productOwnerApprovalReference,
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
  test('keeps SMS dark even if persisted truth is accidentally permissive', () => {
    const error = expectAdminError(
      () =>
        assertChannelChangeAllowed(
          command(SMS_INTEGRATION_ID, true),
          status(SMS_INTEGRATION_ID, 'mocked'),
        ),
      409,
    );

    expect(error.message).toContain('SMS remains disabled');
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

  test('requires exact recorded product-owner approval for every live change', () => {
    const live = status('synthetic-live-provider', 'live-verified');

    for (const enabled of [true, false]) {
      expectAdminError(
        () =>
          assertChannelChangeAllowed(
            command('synthetic-live-provider', enabled, 'wrong-reference'),
            live,
          ),
        403,
      );
      expect(() =>
        assertChannelChangeAllowed(
          command('synthetic-live-provider', enabled),
          live,
        ),
      ).not.toThrow();
    }
  });
});
