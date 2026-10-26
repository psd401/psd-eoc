import { describe, expect, test } from 'bun:test';

import {
  CapabilityScopeSchema,
  getCapabilityInvocationPolicy,
  isPartnerCapabilityId,
  PARTNER_CAPABILITY_IDS,
  RegisteredCapabilityIdSchema,
} from './index';

/** The written allowlist, repeated here so a silent edit cannot pass. */
const EXPECTED_ALLOWLIST = [
  'list-active-events',
  'get-event',
  'list-facilities',
  'get-facility',
  'list-threats',
  'list-event-types',
  'get-event-type-version',
  'sync-event-room',
  'join-event',
  'list-journal-entries',
  'append-journal-entry',
  'create-media-upload-intent',
  'complete-media-upload',
  'get-media-read-grant',
  'get-current-session',
  'revoke-session',
  'list-my-devices',
  'register-push-token',
  'unregister-push-token',
  'record-sms-consent',
  'withdraw-sms-consent',
  'read-my-sms-consent',
] as const;

/** Capabilities a partner must never reach, named so a widening is visible. */
const NEVER_PARTNER = [
  'prepare-activation',
  'start-event',
  'all-clear-event',
  'reactivate-event',
  'close-event',
  'reopen-as-correction',
  'correct-journal-entry',
  'redact-journal-entry',
  'publish-event-type-version',
  'sync-roster',
  'set-user-facility-scope',
  'invite-partner',
  'disable-partner',
  'list-event-records',
  'export-drill-records',
  'export-event-summary',
  'query-security-audit',
  'issue-agent-api-key',
] as const;

describe('partner capability allowlist', () => {
  test('is exactly the written list', () => {
    expect([...PARTNER_CAPABILITY_IDS]).toEqual([...EXPECTED_ALLOWLIST]);
  });

  test('every entry is a capability a human may invoke from the web', () => {
    for (const id of PARTNER_CAPABILITY_IDS) {
      const policy = getCapabilityInvocationPolicy(id);
      expect(policy.principalKinds).toContain('human');
      expect(policy.sources).toContain('web');
    }
  });

  test('admits nothing that starts, ends, corrects, or administers', () => {
    for (const id of NEVER_PARTNER) {
      expect(RegisteredCapabilityIdSchema.safeParse(id).success).toBe(true);
      expect(isPartnerCapabilityId(id)).toBe(false);
    }
    expect(isPartnerCapabilityId('not-a-capability')).toBe(false);
    expect(isPartnerCapabilityId(undefined)).toBe(false);
  });

  test('the scope marker is only ever literally true', () => {
    const scope = { facilityScope: { kind: 'district' } };
    expect(
      CapabilityScopeSchema.parse({ ...scope, partner: true }).partner,
    ).toBe(true);
    expect(CapabilityScopeSchema.parse(scope).partner).toBeUndefined();
    expect(
      CapabilityScopeSchema.safeParse({ ...scope, partner: false }).success,
    ).toBe(false);
  });
});
