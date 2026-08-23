import { beforeAll, describe, expect, test } from 'bun:test';
import {
  executeCapability,
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
import { exportPKCS8, generateKeyPair } from 'jose';

import {
  createMockGoogleGroupsAdapter as createRuntimeMockGoogleGroupsAdapter,
  createScheduledRosterSyncAuthorizer,
  createSyncRosterHandler,
  diffRosterGroupCounts,
  readGoogleCloudIdentityRosterConfiguration,
  rosterSourceConfigurationRevisionDigest,
  RosterSyncError,
  syncRoster,
  type CompleteRosterSyncPersistenceRequest,
  type LoadedRosterSourceConfiguration,
  type RejectedRosterSyncPersistenceRequest,
  type RosterGroupMember,
  type RosterGroupPage,
  type RosterGroupsAdapter,
  type RosterLocalContact,
  type RosterSyncAlert,
  type RosterSyncAlertSink,
  type RosterSyncBaseline,
  type RosterSyncCapabilityContext,
  type RosterSyncDependencies,
  type RosterSyncReservation,
  type RosterSyncReservationRequest,
  type RosterSyncStore,
} from './groups-sync';

const SYNC_TIME = '2026-08-08T12:00:00.000Z';
const HISTORICAL_TIME = '2026-08-07T12:00:00.000Z';
const REVISION_DIGEST = 'a'.repeat(64);
let syntheticPrivateKey = '';

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  syntheticPrivateKey = await exportPKCS8(privateKey);
});

function serializedCloudIdentityCredential(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'psd401-eoc',
    private_key_id: 'a'.repeat(40),
    private_key: syntheticPrivateKey,
    client_email: 'roster-sync-reader@psd401-eoc.iam.gserviceaccount.com',
    client_id: '123456789012345678901',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/roster-sync-reader%40psd401-eoc.iam.gserviceaccount.com',
    universe_domain: 'googleapis.com',
    approved_staff_group_sha256: 'b'.repeat(64),
    credential_created_at: HISTORICAL_TIME,
    domain_wide_delegation: false,
    oauth_scopes: [
      'https://www.googleapis.com/auth/cloud-identity.groups.readonly',
    ],
    workspace_admin_role: '_GROUPS_READER_ROLE',
    ...overrides,
  });
}

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

function staffLoadedConfiguration(): LoadedRosterSourceConfiguration {
  const source = GroupSourceSchema.parse({
    id: IDS.groupNorth,
    kind: 'google-group',
    purpose: 'building',
    facilityId: IDS.facilityNorth,
    grantedRole: null,
    displayName: 'North Staff',
    active: true,
    membersCapturedAt: null,
    googleGroupId: 'north-staff-group',
    email: 'north-staff@example.invalid',
    createdAt: HISTORICAL_TIME,
  });
  const configuration = RosterSourceConfigurationSchema.parse({
    id: IDS.configuration,
    version: 3,
    population: 'staff',
    facilityIds: [IDS.facilityNorth],
    groupSourceRefs: [sourceReference(source)],
    createdAt: HISTORICAL_TIME,
  });
  return Object.freeze({
    configuration,
    sources: Object.freeze([source]),
    revisionDigest: REVISION_DIGEST,
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

function createMockGoogleGroupsAdapter(
  fixtures: Readonly<Record<string, readonly RosterGroupMember[]>>,
  pageSize = 200,
): RosterGroupsAdapter {
  return createRuntimeMockGoogleGroupsAdapter(fixtures, pageSize, {
    runtimeMode: 'test',
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

function countingAdapter(adapter: RosterGroupsAdapter): Readonly<{
  adapter: RosterGroupsAdapter;
  calls: ReadonlyArray<{ sourceId: string; pageToken: string | null }>;
}> {
  const calls: Array<{ sourceId: string; pageToken: string | null }> = [];
  return Object.freeze({
    calls,
    adapter: Object.freeze({
      truthLabel: adapter.truthLabel,
      fetchPage(
        source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        calls.push({ sourceId: source.id, pageToken });
        return adapter.fetchPage(source, pageToken);
      },
    }),
  });
}

function context(
  idempotencyKey = 'roster-sync-schedule-0001',
  overrides: Partial<RosterSyncCapabilityContext> = {},
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
  store: RosterSyncStore,
  adapter: RosterGroupsAdapter,
  alerts: RosterSyncAlertSink,
  uuid = uuidSequence(1_000),
): RosterSyncDependencies {
  return Object.freeze({
    store,
    adapter,
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
      dependencies(
        store,
        createMockGoogleGroupsAdapter(standardFixtures(), 1),
        collector.sink,
      ),
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

  test('publishes immutable sequential versions from complete multi-page union', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded, [
      historicalSnapshot(loaded),
    ]);
    const counted = countingAdapter(
      createMockGoogleGroupsAdapter(standardFixtures(), 1),
    );
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      counted.adapter,
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
    expect(counted.calls).toHaveLength(8);

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
    ).toEqual([
      'Synthetic North Member',
      'Synthetic Shared Member',
      'Synthetic South Member',
    ]);
    const shared = firstPublished?.recipients.find(
      (recipient) => recipient.displayName === 'Synthetic Shared Member',
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
      dependencies(
        store,
        createMockGoogleGroupsAdapter(standardFixtures(), 1),
        collector.sink,
      ),
    );
    const result = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-empty-others-0001'),
      dependencies(
        store,
        createMockGoogleGroupsAdapter(standardFixtures([]), 1),
        collector.sink,
      ),
    );

    expect(result.outcome).toBe('complete');
    expect(result.completedSourceGroupRefs).toHaveLength(3);
    expect(store.snapshots[1]?.sourceGroupRefs).toContainEqual(
      sourceReference(OTHERS_SOURCE),
    );
    expect(store.snapshots[1]?.recipients).toHaveLength(3);
    const shared = store.snapshots[1]?.recipients.find(
      (recipient) => recipient.displayName === 'Synthetic Shared Member',
    );
    expect(shared?.groupSourceRefs).toEqual([sourceReference(NORTH_SOURCE)]);
    expect(collector.alerts).toEqual([]);
  });

  test('replays a completed idempotency key without provider refetch or publication', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const counted = countingAdapter(
      createMockGoogleGroupsAdapter(standardFixtures(), 1),
    );
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      counted.adapter,
      collector.sink,
    );
    const syncContext = context('roster-sync-idempotent-0001');

    const first = await syncRoster(SYNC_INPUT, syncContext, syncDependencies);
    const callsAfterFirst = counted.calls.length;
    const replay = await syncRoster(SYNC_INPUT, syncContext, syncDependencies);

    expect(replay).toEqual(first);
    expect(counted.calls).toHaveLength(callsAfterFirst);
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
    const counted = countingAdapter(
      createMockGoogleGroupsAdapter(standardFixtures(), 1),
    );
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      counted.adapter,
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

    expect(counted.calls).toEqual([]);
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
    const counted = countingAdapter(
      createMockGoogleGroupsAdapter(standardFixtures(), 1),
    );
    const collector = alertCollector();

    await expectSyncError(
      syncRoster(
        SYNC_INPUT,
        context('roster-sync-ambiguous-lineage-0001'),
        dependencies(store, counted.adapter, collector.sink),
      ),
      'SOURCE_CONFIGURATION_LINEAGE_AMBIGUOUS',
    );

    expect(counted.calls).toEqual([]);
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
      dependencies(
        store,
        createMockGoogleGroupsAdapter(standardFixtures()),
        collector.sink,
      ),
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
        createMockGoogleGroupsAdapter({
          ...standardFixtures(),
          [NORTH_SOURCE.id]: [],
        }),
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
        createMockGoogleGroupsAdapter({
          [NORTH_SOURCE.id]: baselineNorthMembers,
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        }),
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
        createMockGoogleGroupsAdapter({
          [NORTH_SOURCE.id]: [baselineNorthMembers[0]!],
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        }),
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
        createMockGoogleGroupsAdapter({
          [NORTH_SOURCE.id]: baselineNorthMembers,
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        }),
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
        createMockGoogleGroupsAdapter({
          [NORTH_SOURCE.id]: [baselineNorthMembers[0]!],
          [SOUTH_SOURCE.id]: [SOUTH_MEMBER],
          [OTHERS_SOURCE.id]: [],
        }),
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

  test('rejects a partial fetch, preserves last-good, and emits only sanitized alert facts', async () => {
    const loaded = loadedConfiguration();
    const previous = historicalSnapshot(loaded);
    const store = new MemoryRosterSyncStore(loaded, [previous]);
    const base = createMockGoogleGroupsAdapter(standardFixtures(), 1);
    const rawFailure = 'raw-secret-token-and-person@example.invalid';
    const adapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked',
      fetchPage(
        source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        if (source.id === SOUTH_SOURCE.id) {
          return Promise.reject(new Error(rawFailure));
        }
        return base.fetchPage(source, pageToken);
      },
    });
    const collector = alertCollector();

    const result = await syncRoster(
      SYNC_INPUT,
      context(),
      dependencies(store, adapter, collector.sink),
    );

    expect(result.outcome).toBe('partial-rejected');
    expect(result.publishedSnapshotId).toBeNull();
    expect(result.completedSourceGroupRefs.map((source) => source.id)).toEqual([
      IDS.groupNorth,
      IDS.groupOthers,
    ]);
    expect(result.groupFailures).toEqual([
      {
        groupSourceRef: sourceReference(SOUTH_SOURCE),
        errorCode: 'GROUP_FETCH_FAILED',
        attemptedAt: SYNC_TIME,
      },
    ]);
    expect(store.publishCalls).toBe(0);
    expect(store.snapshots).toEqual([previous]);
    expect(collector.alerts).toEqual([
      {
        sourceConfiguration: {
          id: IDS.configuration,
          version: 3,
        },
        population: 'synthetic',
        syncResultId: result.id,
        outcome: 'partial-rejected',
        errorCodes: ['GROUP_FETCH_FAILED'],
        occurredAt: SYNC_TIME,
      },
    ]);
    expect(JSON.stringify({ result, alerts: collector.alerts })).not.toContain(
      rawFailure,
    );
  });

  test('records a total provider failure without publishing', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const adapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked',
      fetchPage(): Promise<RosterGroupPage> {
        return Promise.reject(
          new Error('provider body with credential=do-not-record'),
        );
      },
    });
    const collector = alertCollector();

    const result = await syncRoster(
      SYNC_INPUT,
      context(),
      dependencies(store, adapter, collector.sink),
    );

    expect(result.outcome).toBe('failed');
    expect(result.completedSourceGroupRefs).toEqual([]);
    expect(result.groupFailures).toHaveLength(3);
    expect(
      result.groupFailures.every(
        (failure) => failure.errorCode === 'GROUP_FETCH_FAILED',
      ),
    ).toBe(true);
    expect(store.snapshots).toEqual([]);
    expect(store.publishCalls).toBe(0);
    expect(collector.alerts[0]?.outcome).toBe('failed');
    expect(collector.alerts[0]?.errorCodes).toEqual(['GROUP_FETCH_FAILED']);
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  test('rejects malformed pages and repeated pagination tokens', async () => {
    const singleSource = loadedConfiguration([NORTH_SOURCE]);
    const cases: ReadonlyArray<{
      name: string;
      code: string;
      adapter: RosterGroupsAdapter;
    }> = [
      {
        name: 'malformed page',
        code: 'GROUP_RESPONSE_INVALID',
        adapter: Object.freeze({
          truthLabel: 'mocked' as const,
          fetchPage(): Promise<RosterGroupPage> {
            return Promise.resolve({
              members: 'not-an-array',
              nextPageToken: null,
            } as unknown as RosterGroupPage);
          },
        }),
      },
      {
        name: 'pagination loop',
        code: 'GROUP_PAGINATION_LOOP',
        adapter: Object.freeze({
          truthLabel: 'mocked' as const,
          fetchPage(): Promise<RosterGroupPage> {
            return Promise.resolve({
              members: [],
              nextPageToken: 'repeat-page-token',
            });
          },
        }),
      },
    ];

    for (const testCase of cases) {
      const store = new MemoryRosterSyncStore(singleSource);
      const collector = alertCollector();
      const result = await syncRoster(
        SYNC_INPUT,
        context(`roster-sync-${testCase.name.replaceAll(' ', '-')}-0001`),
        dependencies(store, testCase.adapter, collector.sink),
      );
      expect(result.outcome).toBe('failed');
      expect(result.groupFailures.map((failure) => failure.errorCode)).toEqual([
        testCase.code,
      ]);
      expect(store.publishCalls).toBe(0);
      expect(collector.alerts[0]?.errorCodes).toEqual([testCase.code]);
    }
  });

  test('rejects sources that exceed page and member safety caps without publishing', async () => {
    const loaded = loadedConfiguration();

    const pageLimitedStore = new MemoryRosterSyncStore(loaded);
    let pageCalls = 0;
    const endlessAdapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked' as const,
      fetchPage(
        _source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        pageCalls += 1;
        const pageIndex = pageToken === null ? 0 : Number(pageToken);
        return Promise.resolve({
          members: [],
          nextPageToken: String(pageIndex + 1),
        });
      },
    });
    const pageLimited = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-page-limit-0001'),
      dependencies(pageLimitedStore, endlessAdapter, alertCollector().sink),
    );

    expect(pageLimited.outcome).toBe('failed');
    expect(
      pageLimited.groupFailures.map((failure) => failure.errorCode),
    ).toEqual([
      'GROUP_PAGE_LIMIT_EXCEEDED',
      'GROUP_PAGE_LIMIT_EXCEEDED',
      'GROUP_PAGE_LIMIT_EXCEEDED',
    ]);
    expect(pageCalls).toBe(300);
    expect(pageLimitedStore.publishCalls).toBe(0);

    const memberLimitedStore = new MemoryRosterSyncStore(loaded);
    let memberPageCalls = 0;
    const oversizedMembershipAdapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'mocked' as const,
      fetchPage(
        source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        memberPageCalls += 1;
        const pageIndex = pageToken === null ? 0 : Number(pageToken);
        return Promise.resolve({
          members: Array.from({ length: 200 }, (_, memberIndex) =>
            member(
              `${source.id}-${pageIndex}-${memberIndex}`,
              `Synthetic bounded member ${pageIndex}-${memberIndex}`,
            ),
          ),
          nextPageToken: pageIndex < 6 ? String(pageIndex + 1) : null,
        });
      },
    });
    const memberLimited = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-member-limit-0001'),
      dependencies(
        memberLimitedStore,
        oversizedMembershipAdapter,
        alertCollector().sink,
      ),
    );

    expect(memberLimited.outcome).toBe('failed');
    expect(
      memberLimited.groupFailures.map((failure) => failure.errorCode),
    ).toEqual([
      'GROUP_MEMBER_LIMIT_EXCEEDED',
      'GROUP_MEMBER_LIMIT_EXCEEDED',
      'GROUP_MEMBER_LIMIT_EXCEEDED',
    ]);
    expect(memberPageCalls).toBe(21);
    expect(memberLimitedStore.publishCalls).toBe(0);
  });

  test('rejects a cross-group member conflict after every source completes', async () => {
    const loaded = loadedConfiguration();
    const conflicting = member(
      SHARED_MEMBER.memberKey,
      'Conflicting Synthetic Name',
      'conflicting-shared@example.invalid',
    );
    const adapter = createMockGoogleGroupsAdapter({
      [NORTH_SOURCE.id]: [SHARED_MEMBER],
      [SOUTH_SOURCE.id]: [conflicting],
      [OTHERS_SOURCE.id]: [],
    });
    const store = new MemoryRosterSyncStore(loaded);
    const collector = alertCollector();

    const result = await syncRoster(
      SYNC_INPUT,
      context(),
      dependencies(store, adapter, collector.sink),
    );

    expect(result.outcome).toBe('failed');
    expect(result.completedSourceGroupRefs).toEqual([]);
    expect(result.groupFailures).toHaveLength(3);
    expect(
      result.groupFailures.every(
        (failure) => failure.errorCode === 'ROSTER_MEMBER_CONFLICT',
      ),
    ).toBe(true);
    expect(store.publishCalls).toBe(0);
    expect(store.rejectionCalls).toBe(1);
    expect(collector.alerts[0]?.errorCodes).toEqual(['ROSTER_MEMBER_CONFLICT']);
  });

  test('rejects routable synthetic endpoints while reserved endpoints publish', async () => {
    const singleSource = loadedConfiguration([NORTH_SOURCE]);
    const validStore = new MemoryRosterSyncStore(singleSource);
    const valid = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-reserved-endpoint-0001'),
      dependencies(
        validStore,
        createMockGoogleGroupsAdapter({
          [NORTH_SOURCE.id]: [NORTH_MEMBER],
        }),
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
        createMockGoogleGroupsAdapter({
          [NORTH_SOURCE.id]: [
            member(
              'routable-member',
              'Synthetic Routable Member',
              'routable@example.com',
            ),
          ],
        }),
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
  test('enables the mock adapter only for explicit test or development runtimes', async () => {
    for (const runtimeMode of ['production', 'staging', '']) {
      await expectSyncError(
        Promise.resolve().then(() =>
          createRuntimeMockGoogleGroupsAdapter({}, 1, { runtimeMode }),
        ),
        'MOCK_ROSTER_DISABLED',
      );
    }

    expect(
      createRuntimeMockGoogleGroupsAdapter({}, 1, {
        runtimeMode: 'test',
      }).truthLabel,
    ).toBe('mocked');
    expect(
      createRuntimeMockGoogleGroupsAdapter({}, 1, {
        runtimeMode: 'development',
      }).truthLabel,
    ).toBe('mocked');
  });

  test('never permits a mocked adapter to populate the staff roster', async () => {
    const loaded = staffLoadedConfiguration();
    const source = loaded.sources[0];
    if (source === undefined || source.kind !== 'google-group') {
      throw new Error('Google staff source fixture was missing.');
    }
    const store = new MemoryRosterSyncStore(loaded);
    const collector = alertCollector();
    const result = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-mock-staff-0001'),
      dependencies(
        store,
        createMockGoogleGroupsAdapter({
          [source.id]: [
            {
              memberKey: 'staff-google-subject',
              googleSubject: 'staff-google-subject',
              displayName: 'Staff Fixture',
              email: 'staff-fixture@example.invalid',
            },
          ],
        }),
        collector.sink,
      ),
    );

    expect(result.outcome).toBe('failed');
    expect(result.groupFailures[0]?.errorCode).toBe(
      'MOCK_STAFF_ROSTER_FORBIDDEN',
    );
    expect(store.snapshots).toEqual([]);
    expect(store.publishCalls).toBe(0);
    expect(collector.alerts[0]?.errorCodes).toEqual([
      'MOCK_STAFF_ROSTER_FORBIDDEN',
    ]);
  });

  test('reads only the database-configured group and matches its staff emails to local identities', async () => {
    const loaded = staffLoadedConfiguration();
    const source = loaded.sources[0];
    if (source === undefined || source.kind !== 'google-group') {
      throw new Error('Google staff source fixture was missing.');
    }
    const staffEmail = 'staff.member@example.invalid';
    const pushEndpointId = '00000000-0000-4000-8000-000000000099';
    const store = new MemoryRosterSyncStore(
      loaded,
      [],
      [
        {
          staffEmail,
          googleSubject: 'verified-google-subject',
          displayName: 'Verified Staff Member',
          pushEndpoints: [
            {
              id: pushEndpointId,
              platform: 'ios',
              token: 'synthetic-unroutable-push-token',
            },
          ],
        },
      ],
    );
    const providerReads: Array<
      Readonly<{ id: string; email: string; googleGroupId: string }>
    > = [];
    const adapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'configured-unverified' as const,
      fetchPage(configuredSource: GroupSource): Promise<RosterGroupPage> {
        if (configuredSource.kind !== 'google-group') {
          throw new Error('The staff sync read a non-Google source.');
        }
        providerReads.push({
          id: configuredSource.id,
          email: configuredSource.email,
          googleGroupId: configuredSource.googleGroupId,
        });
        return Promise.resolve({
          members: [
            {
              memberKey: staffEmail,
              googleSubject: null,
              displayName: 'Staff member',
              email: staffEmail,
            },
            {
              memberKey: 'unmatched.staff@example.invalid',
              googleSubject: null,
              displayName: 'Staff member',
              email: 'unmatched.staff@example.invalid',
            },
          ],
          nextPageToken: null,
        });
      },
    });

    const result = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-cloud-identity-email-0001'),
      dependencies(store, adapter, alertCollector().sink),
    );

    expect(result.outcome).toBe('complete');
    expect(providerReads).toEqual([
      {
        id: source.id,
        email: source.email,
        googleGroupId: source.googleGroupId,
      },
    ]);
    expect(store.loadedContactSubjects).toEqual([
      ['staff.member@example.invalid', 'unmatched.staff@example.invalid'],
    ]);
    expect(store.snapshots[0]?.recipients).toEqual([
      expect.objectContaining({
        googleSubject: 'verified-google-subject',
        staffEmail,
        displayName: 'Verified Staff Member',
        endpoints: [
          expect.objectContaining({ channel: 'email', email: staffEmail }),
          expect.objectContaining({
            id: pushEndpointId,
            channel: 'push',
          }),
        ],
      }),
      expect.objectContaining({
        googleSubject: null,
        staffEmail: 'unmatched.staff@example.invalid',
        displayName: 'Staff member',
        endpoints: [
          expect.objectContaining({
            channel: 'email',
            email: 'unmatched.staff@example.invalid',
          }),
        ],
      }),
    ]);
  });

  test('rejects a provider-supplied subject and preserves the last complete staff snapshot', async () => {
    const loaded = staffLoadedConfiguration();
    const previous = RosterSnapshotSchema.parse({
      id: IDS.historicalSnapshot,
      version: 1,
      population: 'staff',
      complete: true,
      sourceConfiguration: {
        id: loaded.configuration.id,
        version: loaded.configuration.version,
      },
      facilityIds: loaded.configuration.facilityIds,
      expectedSourceGroupRefs: loaded.configuration.groupSourceRefs,
      sourceGroupRefs: loaded.configuration.groupSourceRefs,
      recipients: [
        {
          id: '00000000-0000-4000-8000-000000000097',
          population: 'staff',
          googleSubject: null,
          staffEmail: 'previous.staff@example.invalid',
          displayName: 'Previous Staff',
          groupSourceRefs: loaded.configuration.groupSourceRefs,
          endpoints: [],
        },
      ],
      syncStartedAt: HISTORICAL_TIME,
      capturedAt: HISTORICAL_TIME,
    });
    const store = new MemoryRosterSyncStore(loaded, [previous]);
    const adapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'configured-unverified' as const,
      fetchPage(): Promise<RosterGroupPage> {
        return Promise.resolve({
          members: [
            {
              memberKey: 'provider-supplied-subject',
              googleSubject: 'provider-supplied-subject',
              displayName: 'Unverified Provider Identity',
              email: 'provider.subject@example.invalid',
            },
          ],
          nextPageToken: null,
        });
      },
    });

    const result = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-provider-subject-0001'),
      dependencies(store, adapter, alertCollector().sink),
    );

    expect(result.outcome).toBe('failed');
    expect(result.groupFailures[0]?.errorCode).toBe('GROUP_MEMBER_INVALID');
    expect(store.snapshots).toEqual([previous]);
    expect(store.publishCalls).toBe(0);
  });

  test('rejects a 403 after a partial membership page and preserves the last complete snapshot', async () => {
    const loaded = staffLoadedConfiguration();
    const previous = RosterSnapshotSchema.parse({
      id: IDS.historicalSnapshot,
      version: 1,
      population: 'staff',
      complete: true,
      sourceConfiguration: {
        id: loaded.configuration.id,
        version: loaded.configuration.version,
      },
      facilityIds: loaded.configuration.facilityIds,
      expectedSourceGroupRefs: loaded.configuration.groupSourceRefs,
      sourceGroupRefs: loaded.configuration.groupSourceRefs,
      recipients: [
        {
          id: '00000000-0000-4000-8000-000000000096',
          population: 'staff',
          googleSubject: null,
          staffEmail: 'previous.staff@example.invalid',
          displayName: 'Previous Staff',
          groupSourceRefs: loaded.configuration.groupSourceRefs,
          endpoints: [],
        },
      ],
      syncStartedAt: HISTORICAL_TIME,
      capturedAt: HISTORICAL_TIME,
    });
    const store = new MemoryRosterSyncStore(loaded, [previous]);
    const providerPayload = 'provider-403-member-payload-must-not-leak';
    const adapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'configured-unverified' as const,
      fetchPage(
        _source: GroupSource,
        pageToken: string | null,
      ): Promise<RosterGroupPage> {
        if (pageToken === null) {
          return Promise.resolve({
            members: [
              {
                memberKey: 'partial.staff@example.invalid',
                googleSubject: null,
                displayName: 'Staff member',
                email: 'partial.staff@example.invalid',
              },
            ],
            nextPageToken: 'second-provider-page',
          });
        }
        return Promise.reject(
          new RosterSyncError('GOOGLE_GROUP_FETCH_REJECTED', providerPayload),
        );
      },
    });
    const collector = alertCollector();

    const result = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-partial-page-403-0001'),
      dependencies(store, adapter, collector.sink),
    );

    expect(result.outcome).toBe('failed');
    expect(result.groupFailures[0]?.errorCode).toBe(
      'GOOGLE_GROUP_FETCH_REJECTED',
    );
    expect(store.localContactLoads).toBe(0);
    expect(store.snapshots).toEqual([previous]);
    expect(store.publishCalls).toBe(0);
    expect(collector.alerts[0]?.errorCodes).toEqual([
      'GOOGLE_GROUP_FETCH_REJECTED',
    ]);
    expect(JSON.stringify({ result, alerts: collector.alerts })).not.toContain(
      providerPayload,
    );
  });

  test('rejects ambiguous local email mappings without replacing the last complete snapshot', async () => {
    const loaded = staffLoadedConfiguration();
    const source = loaded.sources[0];
    if (source === undefined) {
      throw new Error('Staff source fixture was missing.');
    }
    const previous = RosterSnapshotSchema.parse({
      id: IDS.historicalSnapshot,
      version: 1,
      population: 'staff',
      complete: true,
      sourceConfiguration: {
        id: loaded.configuration.id,
        version: loaded.configuration.version,
      },
      facilityIds: loaded.configuration.facilityIds,
      expectedSourceGroupRefs: loaded.configuration.groupSourceRefs,
      sourceGroupRefs: loaded.configuration.groupSourceRefs,
      recipients: [
        {
          id: '00000000-0000-4000-8000-000000000098',
          population: 'staff',
          googleSubject: null,
          staffEmail: 'previous.staff@example.invalid',
          displayName: 'Previous Staff',
          groupSourceRefs: loaded.configuration.groupSourceRefs,
          endpoints: [],
        },
      ],
      syncStartedAt: HISTORICAL_TIME,
      capturedAt: HISTORICAL_TIME,
    });
    const duplicateEmail = 'duplicate.staff@example.invalid';
    const store = new MemoryRosterSyncStore(
      loaded,
      [previous],
      [
        {
          staffEmail: duplicateEmail,
          googleSubject: 'verified-subject-one',
          displayName: 'First Local Match',
          pushEndpoints: [],
        },
        {
          staffEmail: duplicateEmail,
          googleSubject: 'verified-subject-two',
          displayName: 'Second Local Match',
          pushEndpoints: [],
        },
      ],
    );
    const adapter: RosterGroupsAdapter = Object.freeze({
      truthLabel: 'configured-unverified' as const,
      fetchPage(): Promise<RosterGroupPage> {
        return Promise.resolve({
          members: [
            {
              memberKey: duplicateEmail,
              googleSubject: null,
              displayName: 'Staff member',
              email: duplicateEmail,
            },
          ],
          nextPageToken: null,
        });
      },
    });

    const result = await syncRoster(
      SYNC_INPUT,
      context('roster-sync-ambiguous-email-0001'),
      dependencies(store, adapter, alertCollector().sink),
    );

    expect(result.outcome).toBe('failed');
    expect(result.groupFailures[0]?.errorCode).toBe('LOCAL_CONTACT_DUPLICATE');
    expect(result.publishedSnapshotId).toBeNull();
    expect(store.snapshots).toEqual([previous]);
    expect(store.publishCalls).toBe(0);
  });

  test('keeps mock fixtures isolated, frozen, paged, and network-free', async () => {
    const mutableFixture = {
      memberKey: 'isolated-member',
      googleSubject: null,
      displayName: 'Original Synthetic Name',
      email: 'isolated@example.invalid',
    };
    const adapter = createMockGoogleGroupsAdapter(
      { [NORTH_SOURCE.id]: [mutableFixture] },
      1,
    );
    mutableFixture.displayName = 'Mutated Outside Adapter';
    mutableFixture.email = 'mutated@example.invalid';

    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (() => {
      networkCalls += 1;
      throw new Error('Mock adapter attempted network access.');
    }) as unknown as typeof globalThis.fetch;
    try {
      const page = await adapter.fetchPage(NORTH_SOURCE, null);
      expect(page.members).toEqual([
        {
          memberKey: 'isolated-member',
          googleSubject: null,
          displayName: 'Original Synthetic Name',
          email: 'isolated@example.invalid',
        },
      ]);
      expect(page.nextPageToken).toBeNull();
      expect(Object.isFrozen(page)).toBe(true);
      expect(Object.isFrozen(page.members)).toBe(true);
      expect(Object.isFrozen(page.members[0])).toBe(true);
      expect(networkCalls).toBe(0);

      const unknownSource = syntheticSource(
        IDS.groupUnknown,
        'building',
        IDS.facilityNorth,
        'unknown-staff',
      );
      await expectSyncError(
        Promise.resolve().then(() => adapter.fetchPage(unknownSource, null)),
        'MOCK_GROUP_NOT_FOUND',
      );
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('runs the scheduler authorizer before the registered handler', async () => {
    const loaded = loadedConfiguration();
    const store = new MemoryRosterSyncStore(loaded);
    const counted = countingAdapter(
      createMockGoogleGroupsAdapter(standardFixtures()),
    );
    const collector = alertCollector();
    const syncDependencies = dependencies(
      store,
      counted.adapter,
      collector.sink,
    );
    const handler = createSyncRosterHandler(syncDependencies);
    const unauthorizedContext = context('roster-sync-unauthorized-0001', {
      actor: { kind: 'system', serviceId: 'another-service' },
    });

    await expectSyncError(
      executeCapability(handler, SYNC_INPUT, {
        context: unauthorizedContext,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: createScheduledRosterSyncAuthorizer(),
      }),
      'ROSTER_SYNC_UNAUTHORIZED',
    );

    expect(store.reserveCalls).toBe(0);
    expect(store.configurationLoads).toBe(0);
    expect(counted.calls).toEqual([]);
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
    const counted = countingAdapter(
      createMockGoogleGroupsAdapter(standardFixtures()),
    );
    const collector = alertCollector();

    await expectSyncError(
      syncRoster(
        SYNC_INPUT,
        context('roster-sync-missing-building-0001'),
        dependencies(store, counted.adapter, collector.sink),
      ),
      'SOURCE_CONFIGURATION_INCOMPLETE',
    );

    expect(counted.calls).toEqual([]);
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
    const counted = countingAdapter(
      createMockGoogleGroupsAdapter(standardFixtures()),
    );
    const collector = alertCollector();

    const error = await expectSyncError(
      syncRoster(
        SYNC_INPUT,
        context(),
        dependencies(store, counted.adapter, collector.sink),
      ),
      'SOURCE_CONFIGURATION_MISMATCH',
    );

    expect(error.message).not.toContain(secret);
    expect(counted.calls).toEqual([]);
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

  test('accepts only the exact non-delegated Cloud Identity secret contract', () => {
    const runtimeConfiguration = readGoogleCloudIdentityRosterConfiguration({
      GOOGLE_ROSTER_CONFIG: serializedCloudIdentityCredential(),
      GOOGLE_ROSTER_HTTP_TIMEOUT_MS: '12000',
    });
    expect(runtimeConfiguration).toEqual({
      serviceAccountEmail:
        'roster-sync-reader@psd401-eoc.iam.gserviceaccount.com',
      privateKeyId: 'a'.repeat(40),
      privateKey: syntheticPrivateKey,
      timeoutMilliseconds: 12_000,
    });
    expect(
      readGoogleCloudIdentityRosterConfiguration({
        GOOGLE_ROSTER_CONFIG: serializedCloudIdentityCredential({
          approved_staff_group_sha256: 'c'.repeat(64),
        }),
        GOOGLE_ROSTER_HTTP_TIMEOUT_MS: '12000',
      }),
    ).toEqual(runtimeConfiguration);

    for (const override of [
      { project_id: 'wrong-project' },
      { client_email: 'other-reader@psd401-eoc.iam.gserviceaccount.com' },
      {
        oauth_scopes: [
          'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
        ],
      },
      { domain_wide_delegation: true },
      { delegated_subject: 'admin@example.invalid' },
      { approved_staff_group_sha256: 'not-a-sha256' },
      { private_key: 'not-a-private-key' },
    ]) {
      expect(() =>
        readGoogleCloudIdentityRosterConfiguration({
          GOOGLE_ROSTER_CONFIG: serializedCloudIdentityCredential(override),
        }),
      ).toThrow(RosterSyncError);
    }
  });

  test('does not include supplied secrets in Google configuration errors', () => {
    const secret = 'secret-private-key-body-never-reflect';
    let caught: unknown;
    try {
      readGoogleCloudIdentityRosterConfiguration({
        GOOGLE_ROSTER_CONFIG: serializedCloudIdentityCredential({
          private_key: `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
        }),
        GOOGLE_ROSTER_HTTP_TIMEOUT_MS: '999999',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RosterSyncError);
    expect((caught as RosterSyncError).code).toBe(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
    );
    expect((caught as Error).message).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });
});
