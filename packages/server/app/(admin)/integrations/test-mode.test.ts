import { describe, expect, test } from 'bun:test';
import {
  RosterSnapshotSchema,
  type Endpoint,
  type RosterGroupSourceRef,
  type RosterSnapshot,
} from '@psd-eoc/contracts';

import {
  AudienceResolutionError,
  type ResolveAudienceInput,
} from '../../../lib/roster/resolve';
import {
  TEST_MODE_TARGETING,
  TestModeAudienceResolutionError,
  resolveTestModeAudience,
} from './test-mode';

const AT = '2026-08-10T12:00:00.000Z';
const IDS = Object.freeze({
  configuration: '00000000-0000-4000-8000-000000002602',
  endpointEmail: '00000000-0000-4000-8000-000000002603',
  endpointPush: '00000000-0000-4000-8000-000000002604',
  endpointSms: '00000000-0000-4000-8000-000000002605',
  facility: '00000000-0000-4000-8000-000000002606',
  group: '00000000-0000-4000-8000-000000002607',
  recipient: '00000000-0000-4000-8000-000000002608',
  snapshot: '00000000-0000-4000-8000-000000002609',
});

const SYNTHETIC_GROUP = Object.freeze({
  id: IDS.group,
  kind: 'synthetic',
  purpose: 'building',
  facilityId: IDS.facility,
}) satisfies RosterGroupSourceRef;

const STAFF_GROUP = Object.freeze({
  id: IDS.group,
  kind: 'google-group',
  purpose: 'building',
  facilityId: IDS.facility,
}) satisfies RosterGroupSourceRef;

const SYNTHETIC_SNAPSHOT = RosterSnapshotSchema.parse({
  id: IDS.snapshot,
  version: 1,
  population: 'synthetic',
  complete: true,
  sourceConfiguration: { id: IDS.configuration, version: 1 },
  facilityIds: [IDS.facility],
  expectedSourceGroupRefs: [SYNTHETIC_GROUP],
  sourceGroupRefs: [SYNTHETIC_GROUP],
  recipients: [
    {
      id: IDS.recipient,
      population: 'synthetic',
      googleSubject: null,
      displayName: 'Synthetic Test Recipient',
      groupSourceRefs: [SYNTHETIC_GROUP],
      endpoints: [
        {
          id: IDS.endpointEmail,
          channel: 'email',
          status: 'active',
          capturedAt: AT,
          email: 'test-recipient@example.invalid',
        },
        {
          id: IDS.endpointPush,
          channel: 'push',
          status: 'active',
          capturedAt: AT,
          platform: 'ios',
          provider: 'expo',
          serviceEnvironment: 'production',
          token: 'synthetic-unroutable:test-recipient',
        },
        {
          id: IDS.endpointSms,
          channel: 'sms',
          status: 'active',
          capturedAt: AT,
          phoneNumber: '+12025550142',
        },
      ],
    },
  ],
  syncStartedAt: AT,
  capturedAt: AT,
});

const STAFF_SNAPSHOT = RosterSnapshotSchema.parse({
  id: IDS.snapshot,
  version: 1,
  population: 'staff',
  complete: true,
  sourceConfiguration: { id: IDS.configuration, version: 1 },
  facilityIds: [IDS.facility],
  expectedSourceGroupRefs: [STAFF_GROUP],
  sourceGroupRefs: [STAFF_GROUP],
  recipients: [
    {
      id: IDS.recipient,
      population: 'staff',
      googleSubject: 'synthetic-google-subject-for-test',
      displayName: 'Synthetic Staff Fixture',
      groupSourceRefs: [STAFF_GROUP],
      endpoints: [
        {
          id: IDS.endpointEmail,
          channel: 'email',
          status: 'active',
          capturedAt: AT,
          email: 'synthetic.staff@example.invalid',
        },
      ],
    },
  ],
  syncStartedAt: AT,
  capturedAt: AT,
});

function input(rosterSnapshot: RosterSnapshot): ResolveAudienceInput {
  return {
    facilityId: IDS.facility,
    rosterSnapshot,
  };
}

function withForgedEndpoint(endpoint: Endpoint): RosterSnapshot {
  const recipient = SYNTHETIC_SNAPSHOT.recipients[0];
  if (recipient === undefined) {
    throw new Error('The synthetic test recipient fixture is missing.');
  }
  return {
    ...SYNTHETIC_SNAPSHOT,
    recipients: [{ ...recipient, endpoints: [endpoint] }],
  } as RosterSnapshot;
}

function expectInvalidSyntheticSnapshot(endpoint: Endpoint): void {
  try {
    resolveTestModeAudience(input(withForgedEndpoint(endpoint)));
  } catch (error) {
    expect(error).toBeInstanceOf(AudienceResolutionError);
    expect(error).not.toBeInstanceOf(TestModeAudienceResolutionError);
    expect((error as AudienceResolutionError).code).toBe(
      'INVALID_ROSTER_SNAPSHOT',
    );
    return;
  }
  throw new Error('Expected a routable synthetic endpoint to fail closed.');
}

function expectInvalidTestModeRosterSnapshot(rosterSnapshot: unknown): void {
  const malformedInput = {
    ...input(SYNTHETIC_SNAPSHOT),
    rosterSnapshot,
  } as unknown as ResolveAudienceInput;
  try {
    resolveTestModeAudience(malformedInput);
  } catch (error) {
    expect(error).toBeInstanceOf(TestModeAudienceResolutionError);
    expect((error as TestModeAudienceResolutionError).code).toBe(
      'TEST_MODE_REQUIRES_SYNTHETIC_ROSTER',
    );
    return;
  }
  throw new Error('Expected a malformed test-mode roster to fail closed.');
}

describe('admin test-mode audience resolution', () => {
  test('fixes classification and population on the server', () => {
    expect(Object.isFrozen(TEST_MODE_TARGETING)).toBe(true);
    expect(TEST_MODE_TARGETING).toEqual({
      kind: 'test',
      templateMode: 'drill',
      rosterPopulation: 'synthetic',
    });
    expect(() => resolveTestModeAudience(input(STAFF_SNAPSHOT))).toThrow(
      TestModeAudienceResolutionError,
    );
    try {
      resolveTestModeAudience(input(STAFF_SNAPSHOT));
    } catch (error) {
      expect((error as TestModeAudienceResolutionError).code).toBe(
        'TEST_MODE_REQUIRES_SYNTHETIC_ROSTER',
      );
    }
  });

  test('rejects malformed roster snapshots with a typed test-mode error', () => {
    for (const rosterSnapshot of [
      null,
      undefined,
      false,
      0,
      'synthetic',
      [],
      {},
    ]) {
      expectInvalidTestModeRosterSnapshot(rosterSnapshot);
    }
  });

  test('rejects routable email, SMS, and push destinations during resolve', () => {
    expectInvalidSyntheticSnapshot({
      id: IDS.endpointEmail,
      channel: 'email',
      status: 'active',
      capturedAt: AT,
      email: 'real-route@example.com',
    });
    expectInvalidSyntheticSnapshot({
      id: IDS.endpointSms,
      channel: 'sms',
      status: 'active',
      capturedAt: AT,
      phoneNumber: '+12125550100',
    });
    expectInvalidSyntheticSnapshot({
      id: IDS.endpointPush,
      channel: 'push',
      status: 'active',
      capturedAt: AT,
      platform: 'ios',
      provider: 'expo',
      serviceEnvironment: 'production',
      token: 'ExponentPushToken[routable-fixture]',
    });
  });

  test('resolves only reserved synthetic destinations without network access', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('Test-mode resolution attempted provider access.');
    }) as unknown as typeof globalThis.fetch;

    try {
      const resolved = resolveTestModeAudience(input(SYNTHETIC_SNAPSHOT));
      expect(fetchCalls).toBe(0);
      expect(resolved.rosterSnapshot.population).toBe('synthetic');
      expect(
        resolved.recipients.flatMap((recipient) => recipient.endpoints),
      ).toEqual([...(SYNTHETIC_SNAPSHOT.recipients[0]?.endpoints ?? [])]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
