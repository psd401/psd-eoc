import { describe, expect, test } from 'bun:test';
import {
  RosterSnapshotSchema,
  type Recipient,
  type RosterGroupSourceRef,
  type RosterSnapshot,
} from '@psd-eoc/contracts';

import {
  AudienceResolutionError,
  resolveAudience,
  type AudienceResolutionErrorCode,
  type ResolveAudienceInput,
} from './resolve';

const TIMESTAMP = '2026-08-08T12:00:00.000Z';

const IDS = Object.freeze({
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  facilitySouth: '00000000-0000-4000-8000-000000000002',
  facilityWest: '00000000-0000-4000-8000-000000000003',
  neighborhood: '00000000-0000-4000-8000-000000000010',
  audience: '00000000-0000-4000-8000-000000000020',
  groupNorth: '00000000-0000-4000-8000-000000000030',
  groupSouth: '00000000-0000-4000-8000-000000000031',
  groupOthers: '00000000-0000-4000-8000-000000000032',
  groupMissing: '00000000-0000-4000-8000-000000000033',
  configuration: '00000000-0000-4000-8000-000000000040',
  snapshotOld: '00000000-0000-4000-8000-000000000041',
  snapshotNew: '00000000-0000-4000-8000-000000000042',
  recipientNorth: '00000000-0000-4000-8000-000000000050',
  recipientShared: '00000000-0000-4000-8000-000000000051',
  recipientSouth: '00000000-0000-4000-8000-000000000052',
  recipientOthers: '00000000-0000-4000-8000-000000000053',
  recipientNoEndpoint: '00000000-0000-4000-8000-000000000054',
  recipientInactive: '00000000-0000-4000-8000-000000000055',
  endpointNorthEmail: '00000000-0000-4000-8000-000000000060',
  endpointNorthPush: '00000000-0000-4000-8000-000000000061',
  endpointSharedPush: '00000000-0000-4000-8000-000000000062',
  endpointSharedEmail: '00000000-0000-4000-8000-000000000063',
  endpointSouthSms: '00000000-0000-4000-8000-000000000064',
  endpointOthersPush: '00000000-0000-4000-8000-000000000065',
  endpointInactiveEmail: '00000000-0000-4000-8000-000000000066',
});

const NORTH_GROUP = Object.freeze({
  id: IDS.groupNorth,
  kind: 'synthetic',
  purpose: 'building',
  facilityId: IDS.facilityNorth,
}) satisfies RosterGroupSourceRef;

const SOUTH_GROUP = Object.freeze({
  id: IDS.groupSouth,
  kind: 'synthetic',
  purpose: 'building',
  facilityId: IDS.facilitySouth,
}) satisfies RosterGroupSourceRef;

const OTHERS_GROUP = Object.freeze({
  id: IDS.groupOthers,
  kind: 'synthetic',
  purpose: 'others',
  facilityId: null,
}) satisfies RosterGroupSourceRef;

const GROUPS = Object.freeze([NORTH_GROUP, SOUTH_GROUP, OTHERS_GROUP]);

const BASE_RECIPIENTS: readonly Recipient[] = Object.freeze([
  {
    id: IDS.recipientNorth,
    population: 'synthetic',
    googleSubject: null,
    displayName: 'Synthetic North Staff',
    groupSourceRefs: [NORTH_GROUP],
    endpoints: [
      {
        id: IDS.endpointNorthEmail,
        channel: 'email',
        status: 'active',
        capturedAt: TIMESTAMP,
        email: 'north.staff@example.invalid',
      },
      {
        id: IDS.endpointNorthPush,
        channel: 'push',
        status: 'disabled',
        capturedAt: TIMESTAMP,
        platform: 'ios',
        provider: 'expo',
        serviceEnvironment: 'production',
        token: 'synthetic-unroutable:north-disabled',
      },
    ],
  },
  {
    id: IDS.recipientShared,
    population: 'synthetic',
    googleSubject: null,
    displayName: 'Synthetic Shared Staff',
    groupSourceRefs: [OTHERS_GROUP, SOUTH_GROUP, NORTH_GROUP],
    endpoints: [
      {
        id: IDS.endpointSharedEmail,
        channel: 'email',
        status: 'active',
        capturedAt: TIMESTAMP,
        email: 'shared.staff@example.invalid',
      },
      {
        id: IDS.endpointSharedPush,
        channel: 'push',
        status: 'active',
        capturedAt: TIMESTAMP,
        platform: 'android',
        provider: 'expo',
        serviceEnvironment: 'production',
        token: 'synthetic-unroutable:shared-active',
      },
    ],
  },
  {
    id: IDS.recipientSouth,
    population: 'synthetic',
    googleSubject: null,
    displayName: 'Synthetic South Staff',
    groupSourceRefs: [SOUTH_GROUP],
    endpoints: [
      {
        id: IDS.endpointSouthSms,
        channel: 'sms',
        status: 'active',
        capturedAt: TIMESTAMP,
        phoneNumber: '+12025550101',
      },
    ],
  },
  {
    id: IDS.recipientOthers,
    population: 'synthetic',
    googleSubject: null,
    displayName: 'Synthetic Other Staff',
    groupSourceRefs: [OTHERS_GROUP],
    endpoints: [
      {
        id: IDS.endpointOthersPush,
        channel: 'push',
        status: 'active',
        capturedAt: TIMESTAMP,
        platform: 'ios',
        provider: 'expo',
        serviceEnvironment: 'production',
        token: 'synthetic-unroutable:other-active',
      },
    ],
  },
  {
    id: IDS.recipientNoEndpoint,
    population: 'synthetic',
    googleSubject: null,
    displayName: 'Synthetic Staff Without Endpoint',
    groupSourceRefs: [NORTH_GROUP],
    endpoints: [],
  },
  {
    id: IDS.recipientInactive,
    population: 'synthetic',
    googleSubject: null,
    displayName: 'Synthetic Staff With Invalid Endpoint',
    groupSourceRefs: [SOUTH_GROUP],
    endpoints: [
      {
        id: IDS.endpointInactiveEmail,
        channel: 'email',
        status: 'invalid',
        capturedAt: TIMESTAMP,
        email: 'inactive.staff@example.invalid',
      },
    ],
  },
]);

function snapshot(overrides: Partial<RosterSnapshot> = {}): RosterSnapshot {
  return RosterSnapshotSchema.parse({
    id: IDS.snapshotOld,
    version: 7,
    population: 'synthetic',
    complete: true,
    sourceConfiguration: { id: IDS.configuration, version: 3 },
    facilityIds: [IDS.facilityNorth, IDS.facilitySouth],
    expectedSourceGroupRefs: GROUPS,
    sourceGroupRefs: GROUPS,
    recipients: BASE_RECIPIENTS,
    syncStartedAt: TIMESTAMP,
    capturedAt: TIMESTAMP,
    ...overrides,
  });
}

function input(
  facilityId: string,
  overrides: Partial<ResolveAudienceInput> = {},
): ResolveAudienceInput {
  return {
    facilityId,
    rosterSnapshot: snapshot(),
    ...overrides,
  };
}

function recipientIds(result: ReturnType<typeof resolveAudience>): string[] {
  return result.recipients.map((recipient) => recipient.recipientId);
}

function endpointIds(result: ReturnType<typeof resolveAudience>): string[] {
  return result.recipients.flatMap((recipient) =>
    recipient.endpoints.map((endpoint) => endpoint.id),
  );
}

function expectResolutionError(
  operation: () => unknown,
  code: AudienceResolutionErrorCode,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AudienceResolutionError);
    expect((error as AudienceResolutionError).code).toBe(code);
    return;
  }
  throw new Error(`Expected audience resolution to fail with ${code}.`);
}

describe('roster audience resolution for one school', () => {
  const recipientById = (
    result: ReturnType<typeof resolveAudience>,
    id: string,
  ) => result.recipients.find((recipient) => recipient.recipientId === id);

  test('resolves the school and retains recipients without active endpoints', () => {
    const result = resolveAudience(input(IDS.facilityNorth));

    // The school's own building source plus every others source, which reach
    // their people at every school.
    expect(result.sourceGroupRefs).toEqual([NORTH_GROUP, OTHERS_GROUP]);
    expect(result.facilityId).toBe(IDS.facilityNorth);
    expect(recipientIds(result)).toContain(IDS.recipientNorth);
    expect(recipientIds(result)).toContain(IDS.recipientNoEndpoint);
    expect(
      recipientById(result, IDS.recipientNorth)?.endpoints.map(
        (endpoint) => endpoint.id,
      ),
    ).toEqual([IDS.endpointNorthEmail]);
    // Kept with no endpoints rather than dropped: somebody at the school with
    // no reachable address is a fact the consequence preview should be able to
    // show, not one to quietly omit.
    expect(recipientById(result, IDS.recipientNoEndpoint)?.endpoints).toEqual(
      [],
    );
    // Inactive endpoints are excluded from the plan.
    expect(endpointIds(result)).not.toContain(IDS.endpointNorthPush);
  });

  test('reaches the school it was given plus every others source', () => {
    // The rule that replaced twenty configuration rows: an event at a school
    // reaches that school's building source. It also reaches every others
    // source, the district-level lists whose people belong at every event, so
    // both schools resolve the same others group.
    const north = resolveAudience(input(IDS.facilityNorth));
    const south = resolveAudience(input(IDS.facilitySouth));

    expect(north.sourceGroupRefs).toEqual([NORTH_GROUP, OTHERS_GROUP]);
    expect(south.sourceGroupRefs).toEqual([SOUTH_GROUP, OTHERS_GROUP]);
    // The other school's building-only recipient still cannot appear.
    expect(recipientIds(north)).not.toContain(IDS.recipientSouth);
    expect(recipientIds(south)).not.toContain(IDS.recipientNorth);
  });

  test('reaches an others-only recipient at every school and nowhere is empty', () => {
    // A person on a district others source and no building source is exactly
    // the case the resolver used to drop: nothing selected the others source,
    // so they were reached nowhere. They now appear at both schools.
    const north = resolveAudience(input(IDS.facilityNorth));
    const south = resolveAudience(input(IDS.facilitySouth));

    expect(recipientIds(north)).toContain(IDS.recipientOthers);
    expect(recipientIds(south)).toContain(IDS.recipientOthers);
    // Their group provenance in the plan is the others source they belong to.
    expect(recipientById(north, IDS.recipientOthers)?.groupSourceRefs).toEqual([
      OTHERS_GROUP,
    ]);
    expect(
      recipientById(north, IDS.recipientOthers)?.endpoints.map(
        (endpoint) => endpoint.id,
      ),
    ).toEqual([IDS.endpointOthersPush]);
  });

  test('a recipient at both schools resolves under either', () => {
    expect(recipientIds(resolveAudience(input(IDS.facilityNorth)))).toContain(
      IDS.recipientShared,
    );
    expect(recipientIds(resolveAudience(input(IDS.facilitySouth)))).toContain(
      IDS.recipientShared,
    );
  });

  test('pins the exact snapshot version it resolved against', () => {
    // The reason the snapshot reference survives the audience configuration:
    // the record of who was notified must not change under a later sync.
    const result = resolveAudience(input(IDS.facilityNorth));

    expect(result.rosterSnapshot.id).toBe(IDS.snapshotOld);
    expect(result.rosterSnapshot.population).toBe('synthetic');
    expect(result.rosterSnapshot.capturedAt).toBe(TIMESTAMP);
  });

  test('returns frozen deterministic evidence without a Google call', () => {
    const first = resolveAudience(input(IDS.facilityNorth));
    const second = resolveAudience(input(IDS.facilityNorth));

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.recipients)).toBe(true);
    expect(Object.isFrozen(first.sourceGroupRefs)).toBe(true);
  });

  test('rejects a school the snapshot does not cover', () => {
    expectResolutionError(
      () => resolveAudience(input(IDS.facilityWest)),
      'MISSING_AUDIENCE_FACILITY',
    );
  });

  test('rejects a school with no building source in the snapshot', () => {
    // A school in the snapshot but with no staff group would resolve to nobody
    // and look like an empty audience. It is refused instead, because those are
    // different problems.
    expectResolutionError(
      () =>
        resolveAudience(
          input(IDS.facilityNorth, {
            rosterSnapshot: snapshot({
              // Both lists, because the schema requires the snapshot to have
              // read exactly the sources it expected to.
              expectedSourceGroupRefs: [SOUTH_GROUP],
              sourceGroupRefs: [SOUTH_GROUP],
              facilityIds: [IDS.facilityNorth, IDS.facilitySouth],
              recipients: [],
            }),
          }),
        ),
      'MISSING_BUILDING_SOURCE',
    );
  });
});
