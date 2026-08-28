import { describe, expect, test } from 'bun:test';
import {
  invokeAuthorizedCapabilityHandler,
  GroupSourceSchema,
  RosterSnapshotSchema,
  RosterSourceConfigurationSchema,
  RosterSyncResultSchema,
  type Actor,
  type GroupSource,
  type RosterGroupSourceRef,
  type RosterSnapshot,
  type RosterSyncResult,
} from '@psd-eoc/contracts';

import {
  createScheduledRosterSyncAuthorizer,
  createSyncRosterHandler,
  diffRosterGroupCounts,
  rosterSourceConfigurationRevisionDigest,
  RosterSyncError,
  syncRoster,
  type CompleteRosterSyncPersistenceRequest,
  type LoadedRosterSourceConfiguration,
  type RejectedRosterSyncPersistenceRequest,
  type RosterGroupMember,
  type RosterLocalContact,
  type RosterSyncAlert,
  type RosterSyncAlertSink,
  type RosterSyncBaseline,
  type RosterSyncCapabilityContext,
  type ScheduledRosterSyncContext,
  type RosterSyncDependencies,
  type RosterSyncReservation,
  type RosterSyncReservationRequest,
  type RosterSyncStore,
} from './groups-sync';

const SYNC_TIME = '2026-08-08T12:00:00.000Z';
const HISTORICAL_TIME = '2026-08-07T12:00:00.000Z';
const REVISION_DIGEST = 'a'.repeat(64);

const IDS = Object.freeze({
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  facilitySouth: '00000000-0000-4000-8000-000000000002',
  groupNorth: '00000000-0000-4000-8000-000000000010',
  groupSouth: '00000000-0000-4000-8000-000000000011',
  groupOthers: '00000000-0000-4000-8000-000000000012',
  groupUnknown: '00000000-0000-4000-8000-000000000013',
  configuration: '00000000-0000-4000-8000-000000000020',
  historicalSnapshot: '00000000-0000-4000-8000-000000000030',
  request: '00000000-0000-4000-8000-000000000040',
});

const SYSTEM_ACTOR = Object.freeze({
  kind: 'system',
  serviceId: 'roster-sync-job',
}) satisfies Actor;

function uuidSequence(start: number): () => string {
  let value = start;
  return () => {
    const suffix = String(value).padStart(12, '0');
    value += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

function syntheticSource(
  id: string,
  purpose: 'building' | 'others',
  facilityId: string | null,
  fixtureKey: string,
): GroupSource {
  return GroupSourceSchema.parse({
    id,
    kind: 'synthetic',
    purpose,
    facilityId,
    grantedRole: null,
    displayName: `Synthetic ${fixtureKey}`,
    active: true,
    membersCapturedAt: null,
    fixtureKey,
    createdAt: HISTORICAL_TIME,
  });
}

const NORTH_SOURCE = syntheticSource(
  IDS.groupNorth,
  'building',
  IDS.facilityNorth,
  'north-staff',
);
const SOUTH_SOURCE = syntheticSource(
  IDS.groupSouth,
  'building',
  IDS.facilitySouth,
  'south-staff',
);
const OTHERS_SOURCE = syntheticSource(
  IDS.groupOthers,
  'others',
  null,
  'other-staff',
);
const SOURCES = Object.freeze([NORTH_SOURCE, SOUTH_SOURCE, OTHERS_SOURCE]);

function sourceReference(source: GroupSource): RosterGroupSourceRef {
  if (source.purpose === 'building') {
    return Object.freeze({
      id: source.id,
      kind: source.kind,
      purpose: source.purpose,
      facilityId: source.facilityId,
    });
  }
  if (source.purpose === 'others') {
    return Object.freeze({
      id: source.id,
      kind: source.kind,
      purpose: source.purpose,
      facilityId: source.facilityId,
    });
  }
  throw new Error('Synthetic roster fixture cannot use an access group.');
}

function loadedConfiguration(
  sources: readonly GroupSource[] = SOURCES,
  revisionDigest = REVISION_DIGEST,
  reference: Readonly<{ id: string; version: number }> = Object.freeze({
    id: IDS.configuration,
    version: 3,
  }),
): LoadedRosterSourceConfiguration {
  const facilityIds = [
    ...new Set(
      sources.flatMap((source) =>
        source.purpose === 'building' ? [source.facilityId] : [],
      ),
    ),
  ].sort();
  const configuration = RosterSourceConfigurationSchema.parse({
    id: reference.id,
    version: reference.version,
    population: 'synthetic',
    facilityIds,
    groupSourceRefs: sources.map(sourceReference),
    createdAt: HISTORICAL_TIME,
  });
  return Object.freeze({
    configuration,
    sources: Object.freeze([...sources]),
    revisionDigest,
  });
}

function member(
  memberKey: string,
  displayName: string,
  email = `${memberKey}@example.invalid`,
): RosterGroupMember {
  return Object.freeze({
    memberKey,
    googleSubject: null,
    displayName,
    email,
  });
}

const NORTH_MEMBER = member('north-member', 'Synthetic North Member');
const SOUTH_MEMBER = member('south-member', 'Synthetic South Member');
const SHARED_MEMBER = member('shared-member', 'Synthetic Shared Member');

function standardFixtures(
  othersMembers: readonly RosterGroupMember[] = [SHARED_MEMBER],
): Readonly<Record<string, readonly RosterGroupMember[]>> {
  return Object.freeze({
    [NORTH_SOURCE.id]: Object.freeze([NORTH_MEMBER, SHARED_MEMBER]),
    [SOUTH_SOURCE.id]: Object.freeze([SOUTH_MEMBER]),
    [OTHERS_SOURCE.id]: Object.freeze([...othersMembers]),
  });
}

interface MemoryReservation {
  readonly id: string;
  readonly key: string;
  readonly requestDigest: string;
  status: 'in-progress' | 'completed' | 'failed';
  result: RosterSyncResult | null;
  errorCode: string | null;
}

class MemoryRosterSyncStore implements RosterSyncStore {
  public readonly snapshots: RosterSnapshot[];
  public readonly results: RosterSyncResult[] = [];
  public readonly publishedRequests: CompleteRosterSyncPersistenceRequest[] =
    [];
  public readonly rejectedRequests: RejectedRosterSyncPersistenceRequest[] = [];
  public readonly failedReservations: Readonly<{
    reservationId: string;
    errorCode: string;
    completedAt: string;
  }>[] = [];
  public readonly loadedContactSubjects: readonly string[][] = [];
  public reserveCalls = 0;
  public configurationLoads = 0;
  public localContactLoads = 0;
  public publishCalls = 0;
  public rejectionCalls = 0;

  public groupMemberFixtures: Readonly<
    Record<string, readonly RosterGroupMember[]>
  > = {};

  public readonly groupMemberLoads: string[] = [];

  public async loadGroupMembers(
    groupSourceId: string,
  ): Promise<readonly string[]> {
    this.groupMemberLoads.push(groupSourceId);
    return Object.freeze(
      (this.groupMemberFixtures[groupSourceId] ?? [])
        .map((member) => member.email)
        .sort(),
    );
  }

  private readonly reservationsByKey = new Map<string, MemoryReservation>();
  private readonly reservationsById = new Map<string, MemoryReservation>();
  private readonly nextId = uuidSequence(8_000);

  public constructor(
    public loaded: LoadedRosterSourceConfiguration | null,
    initialSnapshots: readonly RosterSnapshot[] = [],
    public localContacts: readonly RosterLocalContact[] = [],
  ) {
    this.snapshots = [...initialSnapshots];
  }

  public reserve(
    request: RosterSyncReservationRequest,
  ): Promise<RosterSyncReservation> {
    this.reserveCalls += 1;
    const actorKey =
      request.principal.kind === 'system'
        ? `system:${request.principal.serviceId}`
        : JSON.stringify(request.principal);
    const scope = `${actorKey}:${request.idempotencyKey}`;
    const existing = this.reservationsByKey.get(scope);
    if (existing !== undefined) {
      if (existing.requestDigest !== request.requestDigest) {
        throw new RosterSyncError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key belongs to another request.',
        );
      }
      if (existing.status === 'completed' && existing.result !== null) {
        return Promise.resolve(
          Object.freeze({ kind: 'replay' as const, result: existing.result }),
        );
      }
      throw new RosterSyncError(
        existing.status === 'failed'
          ? 'ROSTER_SYNC_REPLAY_FAILED'
          : 'ROSTER_SYNC_IN_PROGRESS',
        'The prior execution cannot run again.',
      );
    }

    const reservation: MemoryReservation = {
      id: this.nextId(),
      key: request.idempotencyKey,
      requestDigest: request.requestDigest,
      status: 'in-progress',
      result: null,
      errorCode: null,
    };
    this.reservationsByKey.set(scope, reservation);
    this.reservationsById.set(reservation.id, reservation);
    return Promise.resolve(
      Object.freeze({ kind: 'reserved' as const, id: reservation.id }),
    );
  }

  public loadSourceConfiguration(
    reference: Readonly<{ id: string; version: number }>,
  ): Promise<LoadedRosterSourceConfiguration | null> {
    this.configurationLoads += 1;
    if (
      this.loaded === null ||
      this.loaded.configuration.id !== reference.id ||
      this.loaded.configuration.version !== reference.version
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.loaded);
  }

  public loadLocalContacts(
    googleSubjects: readonly string[],
  ): Promise<readonly RosterLocalContact[]> {
    this.localContactLoads += 1;
    (this.loadedContactSubjects as string[][]).push([...googleSubjects]);
    return Promise.resolve(this.localContacts);
  }

  public loadLatestCompleteBaseline(
    population: 'staff' | 'synthetic',
  ): Promise<RosterSyncBaseline | null> {
    const latest = this.snapshots
      .filter((snapshot) => snapshot.population === population)
      .sort((left, right) => right.version - left.version)[0];
    if (latest === undefined) {
      return Promise.resolve(null);
    }
    const counts = new Map(
      latest.sourceGroupRefs.map((reference) => [reference.id, 0]),
    );
    for (const recipient of latest.recipients) {
      for (const reference of recipient.groupSourceRefs) {
        counts.set(reference.id, (counts.get(reference.id) ?? 0) + 1);
      }
    }
    return Promise.resolve(
      Object.freeze({
        snapshotId: latest.id,
        version: latest.version,
        population: latest.population,
        sourceConfiguration: latest.sourceConfiguration,
        groupMemberCounts: Object.freeze(
          [...counts]
            .map(([groupSourceId, memberCount]) =>
              Object.freeze({ groupSourceId, memberCount }),
            )
            .sort((left, right) =>
              left.groupSourceId.localeCompare(right.groupSourceId),
            ),
        ),
      }),
    );
  }

  public publishComplete(
    request: CompleteRosterSyncPersistenceRequest,
  ): Promise<RosterSyncResult> {
    this.publishCalls += 1;
    this.publishedRequests.push(request);
    const configuration = request.loadedConfiguration.configuration;
    const latestSnapshot = this.snapshots
      .filter((snapshot) => snapshot.population === configuration.population)
      .sort((left, right) => right.version - left.version)[0];
    if (
      latestSnapshot !== undefined &&
      latestSnapshot.sourceConfiguration.id !== configuration.id
    ) {
      throw new RosterSyncError(
        'SOURCE_CONFIGURATION_LINEAGE_AMBIGUOUS',
        'The synthetic roster configuration lineage changed.',
      );
    }
    if (
      latestSnapshot !== undefined &&
      latestSnapshot.sourceConfiguration.version > configuration.version
    ) {
      throw new RosterSyncError(
        'SOURCE_CONFIGURATION_ROLLBACK',
        'The synthetic roster configuration would roll back.',
      );
    }
    if ((latestSnapshot?.id ?? null) !== request.observedBaselineSnapshotId) {
      throw new RosterSyncError(
        'ROSTER_BASELINE_CHANGED',
        'The synthetic roster baseline changed before publication.',
      );
    }
    const version =
      Math.max(0, ...this.snapshots.map((snapshot) => snapshot.version)) + 1;
    const snapshot = RosterSnapshotSchema.parse({
      id: this.nextId(),
      version,
      population: configuration.population,
      complete: true,
      sourceConfiguration: {
        id: configuration.id,
        version: configuration.version,
      },
      facilityIds: configuration.facilityIds,
      expectedSourceGroupRefs: configuration.groupSourceRefs,
      sourceGroupRefs: configuration.groupSourceRefs,
      recipients: request.recipients,
      syncStartedAt: request.startedAt,
      capturedAt: request.capturedAt,
    });
    this.snapshots.push(snapshot);
    const result = RosterSyncResultSchema.parse({
      id: this.nextId(),
      sourceConfiguration: snapshot.sourceConfiguration,
      population: snapshot.population,
      outcome: 'complete',
      startedAt: request.startedAt,
      completedAt: request.capturedAt,
      expectedSourceGroupRefs: snapshot.expectedSourceGroupRefs,
      completedSourceGroupRefs: snapshot.sourceGroupRefs,
      publishedSnapshotId: snapshot.id,
      groupFailures: [],
    });
    this.results.push(result);
    this.completeReservation(request.reservationId, result);
    return Promise.resolve(result);
  }

  public recordRejected(
    request: RejectedRosterSyncPersistenceRequest,
  ): Promise<RosterSyncResult> {
    this.rejectionCalls += 1;
    this.rejectedRequests.push(request);
    const configuration = request.loadedConfiguration.configuration;
    const result = RosterSyncResultSchema.parse({
      id: this.nextId(),
      sourceConfiguration: {
        id: configuration.id,
        version: configuration.version,
      },
      population: configuration.population,
      outcome:
        request.completedSourceGroupRefs.length === 0
          ? 'failed'
          : 'partial-rejected',
      startedAt: request.startedAt,
      completedAt: request.completedAt,
      expectedSourceGroupRefs: configuration.groupSourceRefs,
      completedSourceGroupRefs: request.completedSourceGroupRefs,
      publishedSnapshotId: null,
      groupFailures: request.groupFailures,
    });
    this.results.push(result);
    this.completeReservation(request.reservationId, result);
    return Promise.resolve(result);
  }

  public failReservation(
    reservationId: string,
    errorCode: string,
    completedAt: string,
  ): Promise<void> {
    const reservation = this.reservationsById.get(reservationId);
    if (reservation !== undefined) {
      reservation.status = 'failed';
      reservation.errorCode = errorCode;
    }
    (
      this.failedReservations as Array<{
        reservationId: string;
        errorCode: string;
        completedAt: string;
      }>
    ).push({ reservationId, errorCode, completedAt });
    return Promise.resolve();
  }

  private completeReservation(
    reservationId: string,
    result: RosterSyncResult,
  ): void {
    const reservation = this.reservationsById.get(reservationId);
    if (reservation === undefined || reservation.status !== 'in-progress') {
      throw new Error('Synthetic reservation was unavailable.');
    }
    reservation.status = 'completed';
    reservation.result = result;
  }
}

function historicalSnapshot(
  loaded: LoadedRosterSourceConfiguration,
  version = 4,
): RosterSnapshot {
  return RosterSnapshotSchema.parse({
    id: IDS.historicalSnapshot,
    version,
    population: loaded.configuration.population,
    complete: true,
    sourceConfiguration: {
      id: loaded.configuration.id,
      version: loaded.configuration.version,
    },
    facilityIds: loaded.configuration.facilityIds,
    expectedSourceGroupRefs: loaded.configuration.groupSourceRefs,
    sourceGroupRefs: loaded.configuration.groupSourceRefs,
    recipients: [],
    syncStartedAt: HISTORICAL_TIME,
    capturedAt: HISTORICAL_TIME,
  });
}

function alertCollector(): Readonly<{
  alerts: RosterSyncAlert[];
  sink: RosterSyncAlertSink;
}> {
  const alerts: RosterSyncAlert[] = [];
  return Object.freeze({
    alerts,
    sink: Object.freeze({
      notify(alert: RosterSyncAlert): void {
        alerts.push(alert);
      },
    }),
  });
}

function context(
  idempotencyKey = 'roster-sync-schedule-0001',
  overrides: Partial<ScheduledRosterSyncContext> = {},
): RosterSyncCapabilityContext {
  return {
    actor: SYSTEM_ACTOR,
    source: 'scheduled-job',
    transport: 'scheduled-execution',
    schedulerAuthenticated: true,
    requestId: IDS.request,
    idempotencyKey,
    ...overrides,
  };
}

const SYNC_INPUT = Object.freeze({
  sourceConfiguration: { id: IDS.configuration, version: 3 },
});

function dependencies(
  store: MemoryRosterSyncStore,
  fixtures: Readonly<Record<string, readonly RosterGroupMember[]>>,
  alerts: RosterSyncAlertSink,
  uuid = uuidSequence(1_000),
): RosterSyncDependencies {
  store.groupMemberFixtures = fixtures;
  return Object.freeze({
    store,
    alerts,
    now: () => new Date(SYNC_TIME),
    uuid,
    fetchConcurrency: 2,
  });
}

async function expectSyncError(
  operation: Promise<unknown>,
  code: string,
): Promise<RosterSyncError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(RosterSyncError);
    expect((error as RosterSyncError).code).toBe(code);
    return error as RosterSyncError;
  }
  throw new Error(`Expected roster synchronization to fail with ${code}.`);
}

describe('complete fail-closed roster synchronization', () => {
  test('keeps membership-read liveness out of the configuration revision', () => {
    const loaded = loadedConfiguration();
    const first = rosterSourceConfigurationRevisionDigest(
      loaded.configuration,
      loaded.sources,
    );
    const afterMembershipRead = loaded.sources.map((source) =>
      GroupSourceSchema.parse({
        ...source,
        membersCapturedAt: SYNC_TIME,
      }),
    );

    expect(
      rosterSourceConfigurationRevisionDigest(
        loaded.configuration,
        afterMembershipRead,
      ),
    ).toBe(first);
  });

  test('calculates a stable PII-free count diff against the last complete baseline', () => {
    const diff = diffRosterGroupCounts(
      [
        { groupSourceRef: sourceReference(NORTH_SOURCE), memberCount: 7 },
        { groupSourceRef: sourceReference(OTHERS_SOURCE), memberCount: 0 },
      ],
      {
        snapshotId: IDS.historicalSnapshot,
        version: 4,
        population: 'synthetic',
        sourceConfiguration: {
          id: IDS.configuration,
          version: 3,
        },
        groupMemberCounts: [
          { groupSourceId: IDS.groupNorth, memberCount: 9 },
          { groupSourceId: IDS.groupSouth, memberCount: 3 },
        ],
      },
    );

    expect(diff).toEqual([
      {
        groupSourceRef: sourceReference(NORTH_SOURCE),
        previousCount: 9,
        currentCount: 7,
        delta: -2,
      },
      {
        groupSourceRef: sourceReference(OTHERS_SOURCE),
        previousCount: null,
        currentCount: 0,
        delta: null,
      },
    ]);
    expect(Object.isFrozen(diff)).toBe(true);
    expect(JSON.stringify(diff)).not.toMatch(/email|name|subject/iu);
  });

  test('allows a forward source-configuration version after the latest snapshot', async () => {
    const previousLoaded = loadedConfiguration();
    const forwardLoaded = loadedConfiguration(SOURCES, REVISION_DIGEST, {
      id: IDS.configuration,
      version: 4,
    });
    const store = new MemoryRosterSyncStore(forwardLoaded, [
      historicalSnapshot(previousLoaded),
    ]);
    const collector = alertCollector();

    const result = await syncRoster(
      { sourceConfiguration: { id: IDS.configuration, version: 4 } },
      context('roster-sync-forward-configuration-0001'),
      dependencies(store, standardFixtures(), collector.sink),
    );

    expect(result.outcome).toBe('complete');
    expect(result.sourceConfiguration).toEqual({
      id: IDS.configuration,
      version: 4,
    });
    expect(store.snapshots.at(-1)?.sourceConfiguration).toEqual(
      result.sourceConfiguration,
    );
    expect(collector.alerts).toEqual([]);
  });

  test('publishes immutable sequential versions from the union of every source', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded, [
      historicalSnapshot(loaded),
    ]);
    const countedFixtures = standardFixtures();
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      countedFixtures,
      collector.sink,
    );

    const first = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-schedule-0001'),
      syncDependencies,
    );
    const second = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-schedule-0002'),
      syncDependencies,
    );

    expect(first.outcome).toBe('complete');
    expect(second.outcome).toBe('complete');
    expect(first.publishedSnapshotId).not.toBe(second.publishedSnapshotId);
    expect(store.snapshots.map((snapshot) => snapshot.version)).toEqual([
      4, 5, 6,
    ]);
    expect(store.publishCalls).toBe(2);
    expect(collector.alerts).toEqual([]);
    // Two publications, each reading all three configured sources once.
    expect(store.groupMemberLoads).toHaveLength(6);

    const firstPublished = store.snapshots[1];
    if (first.publishedSnapshotId === null) {
      throw new Error('Complete sync did not return its published snapshot.');
    }
    expect(firstPublished?.id).toBe(first.publishedSnapshotId);
    expect(firstPublished?.expectedSourceGroupRefs).toEqual(
      loaded.configuration.groupSourceRefs,
    );
    expect(firstPublished?.sourceGroupRefs).toEqual(
      loaded.configuration.groupSourceRefs,
    );
    expect(
      firstPublished?.recipients.map((recipient) => recipient.displayName),
    ).toEqual(['north-member', 'shared-member', 'south-member']);
    const shared = firstPublished?.recipients.find(
      (recipient) => recipient.displayName === 'shared-member',
    );
    expect(shared?.groupSourceRefs.map((source) => source.id)).toEqual([
      IDS.groupNorth,
      IDS.groupOthers,
    ]);
    expect(
      firstPublished?.recipients.every(
        (recipient) =>
          recipient.endpoints.length === 1 &&
          recipient.endpoints[0]?.channel === 'email' &&
          recipient.endpoints[0].status === 'active' &&
          recipient.endpoints[0].email.endsWith('.invalid'),
      ),
    ).toBe(true);
  });

  test('publishes a complete snapshot when the configured others group is empty', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const collector = alertCollector();
    await syncRoster(
      SYNC_INPUT,
      context('roster-sync-others-baseline-0001'),
      dependencies(store, standardFixtures(), collector.sink),
    );
    const result = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-empty-others-0001'),
      dependencies(store, standardFixtures([]), collector.sink),
    );

    expect(result.outcome).toBe('complete');
    expect(result.completedSourceGroupRefs).toHaveLength(3);
    expect(store.snapshots[1]?.sourceGroupRefs).toContainEqual(
      sourceReference(OTHERS_SOURCE),
    );
    expect(store.snapshots[1]?.recipients).toHaveLength(3);
    const shared = store.snapshots[1]?.recipients.find(
      (recipient) => recipient.displayName === 'shared-member',
    );
    expect(shared?.groupSourceRefs).toEqual([sourceReference(NORTH_SOURCE)]);
    expect(collector.alerts).toEqual([]);
  });

  test('replays a completed idempotency key without provider refetch or publication', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const countedFixtures = standardFixtures();
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      countedFixtures,
      collector.sink,
    );
    const syncContext = context('roster-sync-idempotent-0001');

    const first = await syncRoster(SYNC_INPUT, syncContext, syncDependencies);
    const callsAfterFirst = store.groupMemberLoads.length;
    const replay = await syncRoster(SYNC_INPUT, syncContext, syncDependencies);

    expect(replay).toEqual(first);
    expect(store.groupMemberLoads).toHaveLength(callsAfterFirst);
    expect(store.snapshots).toHaveLength(1);
    expect(store.publishCalls).toBe(1);
    expect(store.configurationLoads).toBe(1);
    expect(store.reserveCalls).toBe(2);
  });
});

describe('source-configuration monotonicity', () => {
  test('rejects a delayed older version before provider I/O and makes the failed key terminal', async () => {
    const candidate = loadedConfiguration(SOURCES, REVISION_DIGEST, {
      id: IDS.configuration,
      version: 2,
    });
    const latest = loadedConfiguration(SOURCES, REVISION_DIGEST, {
      id: IDS.configuration,
      version: 3,
    });
    const latestSnapshot = historicalSnapshot(latest);
    const store = new MemoryRosterSyncStore(candidate, [latestSnapshot]);
    const countedFixtures = standardFixtures();
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      countedFixtures,
      collector.sink,
    );
    const delayedContext = context('roster-sync-delayed-configuration-0001');
    const input = {
      sourceConfiguration: { id: IDS.configuration, version: 2 },
    };

    await expectSyncError(
      syncRoster(input, delayedContext, syncDependencies),
      'SOURCE_CONFIGURATION_ROLLBACK',
    );
    await expectSyncError(
      syncRoster(input, delayedContext, syncDependencies),
      'ROSTER_SYNC_REPLAY_FAILED',
    );

    expect(store.groupMemberLoads).toEqual([]);
    expect(store.localContactLoads).toBe(0);
    expect(store.publishCalls).toBe(0);
    expect(store.rejectionCalls).toBe(0);
    expect(store.snapshots).toEqual([latestSnapshot]);
    expect(store.failedReservations).toEqual([
      expect.objectContaining({ errorCode: 'SOURCE_CONFIGURATION_ROLLBACK' }),
    ]);
    expect(collector.alerts.map((alert) => alert.errorCodes)).toEqual([
      ['SOURCE_CONFIGURATION_ROLLBACK'],
      ['ROSTER_SYNC_REPLAY_FAILED'],
    ]);
    expect(JSON.stringify(collector.alerts)).not.toMatch(
      /@|displayName|googleSubject|token/iu,
    );
  });

  test('fails closed when a different configuration lineage cannot be ordered', async () => {
    const candidate = loadedConfiguration();
    const otherLineage = loadedConfiguration(SOURCES, REVISION_DIGEST, {
      id: IDS.groupUnknown,
      version: 99,
    });
    const latestSnapshot = historicalSnapshot(otherLineage);
    const store = new MemoryRosterSyncStore(candidate, [latestSnapshot]);
    const countedFixtures = standardFixtures();
    const collector = alertCollector();

    await expectSyncError(
      syncRoster(
        SYNC_INPUT,
        context('roster-sync-ambiguous-lineage-0001'),
        dependencies(store, countedFixtures, collector.sink),
      ),
      'SOURCE_CONFIGURATION_LINEAGE_AMBIGUOUS',
    );

    expect(store.groupMemberLoads).toEqual([]);
    expect(store.snapshots).toEqual([latestSnapshot]);
    expect(store.publishCalls).toBe(0);
    expect(store.rejectionCalls).toBe(0);
    expect(collector.alerts).toEqual([
      expect.objectContaining({
        outcome: 'execution-failed',
        errorCodes: ['SOURCE_CONFIGURATION_LINEAGE_AMBIGUOUS'],
      }),
    ]);
  });
});

describe('rejected roster synchronization', () => {
  test('rejects an empty building group and preserves the last complete snapshot', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const collector = alertCollector();
    const first = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-building-baseline-0001'),
      dependencies(store, standardFixtures(), collector.sink),
    );
    const lastComplete = store.snapshots[0];
    if (lastComplete === undefined) {
      throw new Error('Initial complete snapshot was not published.');
    }

    const rejected = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-empty-building-0001'),
      dependencies(
        store,
        {
          ...standardFixtures(),
          [NORTH_SOURCE.id]: [],
        },
        collector.sink,
      ),
    );

    expect(first.outcome).toBe('complete');
    expect(rejected.outcome).toBe('partial-rejected');
    expect(rejected.publishedSnapshotId).toBeNull();
    expect(rejected.groupFailures).toEqual([
      {
        groupSourceRef: sourceReference(NORTH_SOURCE),
        errorCode: 'EMPTY_BUILDING_GROUP',
        attemptedAt: SYNC_TIME,
      },
    ]);
    expect(rejected.completedSourceGroupRefs).toEqual([
      sourceReference(SOUTH_SOURCE),
      sourceReference(OTHERS_SOURCE),
    ]);
    expect(store.snapshots).toEqual([lastComplete]);
    expect(store.publishCalls).toBe(1);
    expect(collector.alerts.at(-1)?.errorCodes).toEqual([
      'EMPTY_BUILDING_GROUP',
    ]);
  });

  test('rejects a suspicious non-empty building drop against the unchanged configuration', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const baselineNorthMembers = Object.freeze(
      Array.from({ length: 10 }, (_, index) =>
        member(`north-baseline-${index}`, `Synthetic North ${index}`),
      ),
    );
    const collector = alertCollector();
    await syncRoster(
      SYNC_INPUT,
      context('roster-sync-count-baseline-0001'),
      dependencies(
        store,
        {
          [NORTH_SOURCE.id]: baselineNorthMembers,
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        },
        collector.sink,
      ),
    );
    const lastComplete = store.snapshots[0];
    if (lastComplete === undefined) {
      throw new Error('Count baseline snapshot was not published.');
    }

    const rejected = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-suspicious-drop-0001'),
      dependencies(
        store,
        {
          [NORTH_SOURCE.id]: [baselineNorthMembers[0]!],
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        },
        collector.sink,
      ),
    );

    expect(rejected.outcome).toBe('partial-rejected');
    expect(rejected.publishedSnapshotId).toBeNull();
    expect(rejected.groupFailures[0]?.errorCode).toBe(
      'SUSPICIOUS_BUILDING_GROUP_DROP',
    );
    expect(store.snapshots).toEqual([lastComplete]);
    expect(store.publishCalls).toBe(1);
    expect(collector.alerts.at(-1)?.errorCodes).toEqual([
      'SUSPICIOUS_BUILDING_GROUP_DROP',
    ]);
  });

  test('retains building-drop protection across an unrelated configuration version bump', async () => {
    const baselineLoaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(baselineLoaded);
    const baselineNorthMembers = Object.freeze(
      Array.from({ length: 10 }, (_, index) =>
        member(`north-forward-${index}`, `Synthetic Forward North ${index}`),
      ),
    );
    const collector = alertCollector();
    await syncRoster(
      SYNC_INPUT,
      context('roster-sync-forward-drop-baseline-0001'),
      dependencies(
        store,
        {
          [NORTH_SOURCE.id]: baselineNorthMembers,
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        },
        collector.sink,
      ),
    );
    const lastComplete = store.snapshots[0];
    if (lastComplete === undefined) {
      throw new Error('Forward-version count baseline was not published.');
    }
    store.loaded = loadedConfiguration(SOURCES, REVISION_DIGEST, {
      id: IDS.configuration,
      version: 4,
    });

    const rejected = await syncRoster(
      { sourceConfiguration: { id: IDS.configuration, version: 4 } },
      context('roster-sync-forward-drop-0001'),
      dependencies(
        store,
        {
          [NORTH_SOURCE.id]: [baselineNorthMembers[0]!],
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        },
        collector.sink,
      ),
    );

    expect(rejected.outcome).toBe('partial-rejected');
    expect(rejected.sourceConfiguration.version).toBe(4);
    expect(rejected.groupFailures[0]?.errorCode).toBe(
      'SUSPICIOUS_BUILDING_GROUP_DROP',
    );
    expect(store.snapshots).toEqual([lastComplete]);
    expect(store.publishCalls).toBe(1);
  });

  test('rejects routable synthetic endpoints while reserved endpoints publish', async () => {
    const singleSource = loadedConfiguration([NORTH_SOURCE]);
    const validStore = new MemoryRosterSyncStore(singleSource);
    const valid = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-reserved-endpoint-0001'),
      dependencies(
        validStore,
        {
          [NORTH_SOURCE.id]: [NORTH_MEMBER],
        },
        alertCollector().sink,
      ),
    );
    expect(valid.outcome).toBe('complete');
    const endpoint = validStore.snapshots[0]?.recipients[0]?.endpoints[0];
    expect(endpoint?.channel).toBe('email');
    expect(endpoint?.channel === 'email' ? endpoint.email : null).toBe(
      'north-member@example.invalid',
    );

    const invalidStore = new MemoryRosterSyncStore(singleSource);
    const collector = alertCollector();
    const invalid = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-routable-endpoint-0001'),
      dependencies(
        invalidStore,
        {
          [NORTH_SOURCE.id]: [
            member(
              'routable-member',
              'Synthetic Routable Member',
              'routable@example.com',
            ),
          ],
        },
        collector.sink,
      ),
    );
    expect(invalid.outcome).toBe('failed');
    expect(invalid.groupFailures[0]?.errorCode).toBe(
      'SYNTHETIC_MEMBER_ROUTABLE',
    );
    expect(invalidStore.publishCalls).toBe(0);
    expect(collector.alerts[0]?.errorCodes).toEqual([
      'SYNTHETIC_MEMBER_ROUTABLE',
    ]);
  });
});

describe('adapter, authorization, and configuration boundaries', () => {
  test('runs the scheduler authorizer before the registered handler', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const countedFixtures = standardFixtures();
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      countedFixtures,
      collector.sink,
    );
    const handler = createSyncRosterHandler(syncDependencies);
    const unauthorizedContext = context('roster-sync-unauthorized-0001', {
      actor: { kind: 'system', serviceId: 'another-service' },
    });

    await expectSyncError(
      invokeAuthorizedCapabilityHandler(handler, SYNC_INPUT, {
        context: unauthorizedContext,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: createScheduledRosterSyncAuthorizer(),
      }),
      'ROSTER_SYNC_UNAUTHORIZED',
    );

    expect(store.reserveCalls).toBe(0);
    expect(store.configurationLoads).toBe(0);
    expect(store.groupMemberLoads).toEqual([]);
    expect(collector.alerts).toEqual([]);
  });

  test('rejects a source configuration that omits a configured facility building', async () => {
    const partial = loadedConfiguration([NORTH_SOURCE, OTHERS_SOURCE]);
    const invalidLoaded: LoadedRosterSourceConfiguration = Object.freeze({
      ...partial,
      configuration: RosterSourceConfigurationSchema.parse({
        ...partial.configuration,
        facilityIds: [IDS.facilityNorth, IDS.facilitySouth],
      }),
    });
    const store = new MemoryRosterSyncStore(invalidLoaded);
    const countedFixtures = standardFixtures();
    const collector = alertCollector();

    await expectSyncError(
      syncRoster(
        SYNC_INPUT,
        context('roster-sync-missing-building-0001'),
        dependencies(store, countedFixtures, collector.sink),
      ),
      'SOURCE_CONFIGURATION_INCOMPLETE',
    );

    expect(store.groupMemberLoads).toEqual([]);
    expect(store.snapshots).toEqual([]);
    expect(store.publishCalls).toBe(0);
    expect(collector.alerts[0]?.errorCodes).toEqual([
      'SOURCE_CONFIGURATION_INCOMPLETE',
    ]);
  });

  test('sanitizes loaded-configuration failures and never reflects credentials', async () => {
    const secret = 'private-key-material-never-log-this';
    const invalidLoaded = loadedConfiguration(SOURCES, secret);
    const store = new MemoryRosterSyncStore(invalidLoaded);
    const countedFixtures = standardFixtures();
    const collector = alertCollector();

    const error = await expectSyncError(
      syncRoster(
        SYNC_INPUT,
        context(),
        dependencies(store, countedFixtures, collector.sink),
      ),
      'SOURCE_CONFIGURATION_MISMATCH',
    );

    expect(error.message).not.toContain(secret);
    expect(store.groupMemberLoads).toEqual([]);
    expect(store.failedReservations[0]?.errorCode).toBe(
      'SOURCE_CONFIGURATION_MISMATCH',
    );
    expect(collector.alerts).toEqual([
      {
        sourceConfiguration: {
          id: IDS.configuration,
          version: 3,
        },
        population: null,
        syncResultId: null,
        outcome: 'execution-failed',
        errorCodes: ['SOURCE_CONFIGURATION_MISMATCH'],
        occurredAt: SYNC_TIME,
      },
    ]);
    expect(JSON.stringify(collector.alerts)).not.toContain(secret);
  });
});
