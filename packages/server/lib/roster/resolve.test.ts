import { describe, expect, test } from 'bun:test';
import {
  AudienceConfigSchema,
  NeighborhoodSchema,
  RosterSnapshotSchema,
  type AudienceConfig,
  type Neighborhood,
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

function neighborhood(
  version: number,
  facilityIds: readonly string[],
): Neighborhood {
  return NeighborhoodSchema.parse({
    id: IDS.neighborhood,
    version,
    name: `Synthetic Neighborhood v${version}`,
    facilityIds,
    createdAt: TIMESTAMP,
  });
}

const NEIGHBORHOOD_V1 = neighborhood(1, [IDS.facilityNorth, IDS.facilitySouth]);
const NEIGHBORHOOD_V2 = neighborhood(2, [IDS.facilityNorth]);

function audience(
  targets: AudienceConfig['targets'],
  options: Readonly<{
    facilityId?: string;
    version?: number;
  }> = {},
): AudienceConfig {
  return AudienceConfigSchema.parse({
    id: IDS.audience,
    facilityId: options.facilityId ?? IDS.facilityNorth,
    version: options.version ?? 1,
    targets,
    createdAt: TIMESTAMP,
  });
}

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
  audienceConfig: AudienceConfig,
  overrides: Partial<ResolveAudienceInput> = {},
): ResolveAudienceInput {
  return {
    audienceConfig,
    neighborhoodVersions: [NEIGHBORHOOD_V2, NEIGHBORHOOD_V1],
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

describe('pinned roster audience resolution', () => {
  test('resolves the event building and retains recipients without active endpoints', () => {
    const result = resolveAudience(
      input(audience([{ kind: 'building', facilityId: IDS.facilityNorth }])),
    );

    expect(result.sourceGroupRefs).toEqual([NORTH_GROUP]);
    expect(recipientIds(result)).toEqual([
      IDS.recipientNorth,
      IDS.recipientShared,
      IDS.recipientNoEndpoint,
    ]);
    expect(
      result.recipients[0]?.endpoints.map((endpoint) => endpoint.id),
    ).toEqual([IDS.endpointNorthEmail]);
    expect(result.recipients[2]?.endpoints).toEqual([]);
    expect(endpointIds(result)).not.toContain(IDS.endpointNorthPush);
  });

  test('unions all building sources in the exact neighborhood version', () => {
    const result = resolveAudience(
      input(
        audience([
          {
            kind: 'neighborhood',
            neighborhood: { id: IDS.neighborhood, version: 1 },
          },
        ]),
      ),
    );

    expect(result.neighborhoodVersions).toEqual([
      { id: IDS.neighborhood, version: 1 },
    ]);
    expect(result.sourceGroupRefs).toEqual([NORTH_GROUP, SOUTH_GROUP]);
    expect(recipientIds(result)).toEqual([
      IDS.recipientNorth,
      IDS.recipientShared,
      IDS.recipientSouth,
      IDS.recipientNoEndpoint,
      IDS.recipientInactive,
    ]);
    expect(
      result.recipients.filter(
        (recipient) => recipient.recipientId === IDS.recipientShared,
      ),
    ).toHaveLength(1);
    expect(result.recipients.at(-1)?.endpoints).toEqual([]);
  });

  test('resolves the exact others group and accepts a completed empty group', () => {
    const othersAudience = audience([
      { kind: 'others', groupSourceRef: OTHERS_GROUP },
    ]);
    const populated = resolveAudience(input(othersAudience));

    expect(populated.sourceGroupRefs).toEqual([OTHERS_GROUP]);
    expect(recipientIds(populated)).toEqual([
      IDS.recipientShared,
      IDS.recipientOthers,
    ]);

    const recipientsWithoutOthers = BASE_RECIPIENTS.flatMap((recipient) => {
      if (recipient.id === IDS.recipientOthers) {
        return [];
      }
      if (recipient.id !== IDS.recipientShared) {
        return [recipient];
      }
      return [
        {
          ...recipient,
          groupSourceRefs: [SOUTH_GROUP, NORTH_GROUP],
        },
      ];
    });
    const empty = resolveAudience(
      input(othersAudience, {
        rosterSnapshot: snapshot({ recipients: recipientsWithoutOthers }),
      }),
    );

    expect(empty.sourceGroupRefs).toEqual([OTHERS_GROUP]);
    expect(empty.recipients).toEqual([]);
  });

  test('deduplicates combined components and is stable across target order', () => {
    const targets = [
      { kind: 'building', facilityId: IDS.facilityNorth },
      {
        kind: 'neighborhood',
        neighborhood: { id: IDS.neighborhood, version: 1 },
      },
      { kind: 'others', groupSourceRef: OTHERS_GROUP },
    ] as const;
    const forward = resolveAudience(input(audience(targets)));
    const reverse = resolveAudience(input(audience([...targets].reverse())));

    expect(forward).toEqual(reverse);
    expect(recipientIds(forward)).toEqual([
      IDS.recipientNorth,
      IDS.recipientShared,
      IDS.recipientSouth,
      IDS.recipientOthers,
      IDS.recipientNoEndpoint,
      IDS.recipientInactive,
    ]);
    expect(new Set(recipientIds(forward)).size).toBe(forward.recipients.length);
    expect(new Set(endpointIds(forward)).size).toBe(
      endpointIds(forward).length,
    );
    expect(endpointIds(forward)).toEqual([
      IDS.endpointNorthEmail,
      IDS.endpointSharedEmail,
      IDS.endpointSharedPush,
      IDS.endpointSouthSms,
      IDS.endpointOthersPush,
    ]);
  });

  test('pins old snapshot, audience, and neighborhood versions exactly', () => {
    const oldConfig = audience(
      [
        {
          kind: 'neighborhood',
          neighborhood: { id: IDS.neighborhood, version: 1 },
        },
      ],
      { version: 1 },
    );
    const oldSnapshot = snapshot();
    const newRecipients: readonly Recipient[] = BASE_RECIPIENTS.map(
      (recipient) => {
        if (recipient.id !== IDS.recipientNorth) {
          return recipient;
        }
        const emailEndpoint = recipient.endpoints.find(
          (endpoint) => endpoint.channel === 'email',
        );
        if (emailEndpoint === undefined) {
          throw new Error('Synthetic fixture omitted its email endpoint.');
        }
        return {
          ...recipient,
          endpoints: [
            {
              ...emailEndpoint,
              email: 'north.new@example.invalid',
            },
          ],
        };
      },
    );
    const newSnapshot = snapshot({
      id: IDS.snapshotNew,
      version: 8,
      recipients: newRecipients,
    });
    const newConfig = audience(
      [
        {
          kind: 'neighborhood',
          neighborhood: { id: IDS.neighborhood, version: 2 },
        },
      ],
      { version: 2 },
    );

    const oldResult = resolveAudience(
      input(oldConfig, { rosterSnapshot: oldSnapshot }),
    );
    const newResult = resolveAudience(
      input(newConfig, { rosterSnapshot: newSnapshot }),
    );

    expect(oldResult.rosterSnapshot).toEqual({
      id: IDS.snapshotOld,
      version: 7,
      population: 'synthetic',
      sourceConfiguration: { id: IDS.configuration, version: 3 },
      capturedAt: TIMESTAMP,
    });
    expect(oldResult.audienceConfig).toEqual({
      id: IDS.audience,
      version: 1,
      facilityId: IDS.facilityNorth,
    });
    expect(oldResult.neighborhoodVersions).toEqual([
      { id: IDS.neighborhood, version: 1 },
    ]);
    expect(recipientIds(oldResult)).toContain(IDS.recipientSouth);
    expect(
      oldResult.recipients[0]?.endpoints[0]?.channel === 'email'
        ? oldResult.recipients[0].endpoints[0].email
        : null,
    ).toBe('north.staff@example.invalid');

    expect(newResult.rosterSnapshot.id).toBe(IDS.snapshotNew);
    expect(newResult.audienceConfig.version).toBe(2);
    expect(newResult.neighborhoodVersions).toEqual([
      { id: IDS.neighborhood, version: 2 },
    ]);
    expect(recipientIds(newResult)).not.toContain(IDS.recipientSouth);
    expect(
      newResult.recipients[0]?.endpoints[0]?.channel === 'email'
        ? newResult.recipients[0].endpoints[0].email
        : null,
    ).toBe('north.new@example.invalid');
  });

  test('returns frozen deterministic evidence without a Google call', () => {
    const originalFetch = globalThis.fetch;
    let attemptedNetwork = false;
    globalThis.fetch = (() => {
      attemptedNetwork = true;
      throw new Error('Audience resolution attempted a network request.');
    }) as unknown as typeof globalThis.fetch;

    try {
      const result = resolveAudience(
        input(audience([{ kind: 'building', facilityId: IDS.facilityNorth }])),
      );
      expect(attemptedNetwork).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.rosterSnapshot)).toBe(true);
      expect(Object.isFrozen(result.sourceGroupRefs)).toBe(true);
      expect(Object.isFrozen(result.recipients)).toBe(true);
      expect(Object.isFrozen(result.recipients[0]?.endpoints)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('fail-closed audience resolution', () => {
  test('rejects invalid audience configuration and incomplete roster input', () => {
    const buildingAudience = audience([
      { kind: 'building', facilityId: IDS.facilityNorth },
    ]);
    const invalidAudience = {
      ...buildingAudience,
      targets: [{ kind: 'building', facilityId: IDS.facilitySouth }],
    } as AudienceConfig;
    expectResolutionError(
      () => resolveAudience(input(invalidAudience)),
      'INVALID_AUDIENCE_CONFIG',
    );

    const completeSnapshot = snapshot();
    const incompleteSnapshot = {
      ...completeSnapshot,
      sourceGroupRefs: completeSnapshot.sourceGroupRefs.filter(
        (source) => source.id !== IDS.groupOthers,
      ),
    } as RosterSnapshot;
    expectResolutionError(
      () =>
        resolveAudience(
          input(audience([{ kind: 'others', groupSourceRef: OTHERS_GROUP }]), {
            rosterSnapshot: incompleteSnapshot,
          }),
        ),
      'INVALID_ROSTER_SNAPSHOT',
    );
  });

  test('rejects missing exact neighborhood and duplicate version evidence', () => {
    const neighborhoodAudience = audience([
      {
        kind: 'neighborhood',
        neighborhood: { id: IDS.neighborhood, version: 1 },
      },
    ]);
    expectResolutionError(
      () =>
        resolveAudience(
          input(neighborhoodAudience, { neighborhoodVersions: [] }),
        ),
      'MISSING_NEIGHBORHOOD_VERSION',
    );
    expectResolutionError(
      () =>
        resolveAudience(
          input(neighborhoodAudience, {
            neighborhoodVersions: [NEIGHBORHOOD_V1, NEIGHBORHOOD_V1],
          }),
        ),
      'DUPLICATE_NEIGHBORHOOD_VERSION',
    );
  });

  test('rejects missing audience and neighborhood facilities', () => {
    const westAudience = audience(
      [{ kind: 'others', groupSourceRef: OTHERS_GROUP }],
      { facilityId: IDS.facilityWest },
    );
    expectResolutionError(
      () => resolveAudience(input(westAudience)),
      'MISSING_AUDIENCE_FACILITY',
    );

    const neighborhoodV3 = neighborhood(3, [
      IDS.facilityNorth,
      IDS.facilityWest,
    ]);
    const neighborhoodAudience = audience([
      {
        kind: 'neighborhood',
        neighborhood: { id: IDS.neighborhood, version: 3 },
      },
    ]);
    expectResolutionError(
      () =>
        resolveAudience(
          input(neighborhoodAudience, {
            neighborhoodVersions: [neighborhoodV3],
          }),
        ),
      'MISSING_TARGET_FACILITY',
    );
  });

  test('rejects targeted facilities without a building source', () => {
    const westAudience = audience(
      [{ kind: 'building', facilityId: IDS.facilityWest }],
      { facilityId: IDS.facilityWest },
    );
    const expandedSnapshot = snapshot({
      facilityIds: [IDS.facilityNorth, IDS.facilitySouth, IDS.facilityWest],
    });

    expectResolutionError(
      () =>
        resolveAudience(
          input(westAudience, { rosterSnapshot: expandedSnapshot }),
        ),
      'MISSING_BUILDING_SOURCE',
    );
  });

  test('rejects missing or conflicting others provenance', () => {
    const missingOthers = Object.freeze({
      id: IDS.groupMissing,
      kind: 'synthetic',
      purpose: 'others',
      facilityId: null,
    }) satisfies RosterGroupSourceRef;
    expectResolutionError(
      () =>
        resolveAudience(
          input(audience([{ kind: 'others', groupSourceRef: missingOthers }])),
        ),
      'MISSING_OTHERS_SOURCE',
    );

    const conflictingOthers = Object.freeze({
      id: IDS.groupOthers,
      kind: 'google-group',
      purpose: 'others',
      facilityId: null,
    }) satisfies RosterGroupSourceRef;
    expectResolutionError(
      () =>
        resolveAudience(
          input(
            audience([{ kind: 'others', groupSourceRef: conflictingOthers }]),
          ),
        ),
      'GROUP_SOURCE_PROVENANCE_CONFLICT',
    );
  });
});
