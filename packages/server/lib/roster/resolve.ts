import {
  FacilityIdSchema,
  RosterSnapshotSchema,
  type Endpoint,
  type RecipientId,
  type RosterGroupSourceRef,
  type RosterSnapshot,
} from '@psd-eoc/contracts';

/** Closed, non-PII reasons why audience resolution can fail closed. */
export type AudienceResolutionErrorCode =
  | 'DUPLICATE_NEIGHBORHOOD_VERSION'
  | 'ENDPOINT_PROVENANCE_CONFLICT'
  | 'GROUP_SOURCE_PROVENANCE_CONFLICT'
  | 'INVALID_AUDIENCE_CONFIG'
  | 'INVALID_NEIGHBORHOOD_VERSION'
  | 'INVALID_ROSTER_SNAPSHOT'
  | 'MISSING_AUDIENCE_FACILITY'
  | 'MISSING_BUILDING_SOURCE'
  | 'MISSING_NEIGHBORHOOD_VERSION'
  | 'MISSING_OTHERS_SOURCE'
  | 'MISSING_TARGET_FACILITY';

const ERROR_MESSAGES = Object.freeze({
  DUPLICATE_NEIGHBORHOOD_VERSION:
    'Neighborhood version evidence must be unique.',
  ENDPOINT_PROVENANCE_CONFLICT:
    'An endpoint belongs to conflicting recipient provenance.',
  GROUP_SOURCE_PROVENANCE_CONFLICT:
    'Audience and roster group-source provenance conflict.',
  INVALID_AUDIENCE_CONFIG: 'The audience configuration is invalid.',
  INVALID_NEIGHBORHOOD_VERSION: 'A neighborhood version is invalid.',
  INVALID_ROSTER_SNAPSHOT: 'The roster snapshot is invalid or incomplete.',
  MISSING_AUDIENCE_FACILITY:
    'The roster snapshot does not cover the audience facility.',
  MISSING_BUILDING_SOURCE:
    'A targeted facility has no complete building roster source.',
  MISSING_NEIGHBORHOOD_VERSION:
    'The exact audience-pinned neighborhood version is unavailable.',
  MISSING_OTHERS_SOURCE:
    'The exact audience-pinned others source is unavailable.',
  MISSING_TARGET_FACILITY:
    'The roster snapshot does not cover a targeted facility.',
} as const satisfies Readonly<Record<AudienceResolutionErrorCode, string>>);

/** Safe resolution failure that never reflects recipient or endpoint values. */
export class AudienceResolutionError extends Error {
  public readonly code: AudienceResolutionErrorCode;

  public constructor(code: AudienceResolutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AudienceResolutionError';
    this.code = code;
  }
}

/** Exact immutable inputs selected before the activation critical path. */
export interface ResolveAudienceInput {
  /**
   * The school the event was started at. Its own staff are who it reaches.
   *
   * This replaced a versioned `AudienceConfig` naming a list of targets. On the
   * live deployment there were twenty of those, one per school, and every one
   * of them held a single `building` target pointing at its own school — twenty
   * rows restating the sentence above. An empty table meant no event could be
   * activated at all, which is a high price for a configuration object that
   * carried no information.
   *
   * Every `others` source in the snapshot is selected as well: it names the
   * people who belong at every event at every school. `neighborhood` targeting
   * was never configured, and the domain-based resolver that replaces this
   * pipeline supports neighborhood reach directly, from
   * `neighborhood_facilities` rather than from a pinned target list.
   */
  readonly facilityId: string;
  readonly rosterSnapshot: RosterSnapshot;
}

/** Minimized pinned snapshot evidence retained with a resolved audience. */
export type ResolvedRosterSnapshotRef = Readonly<
  Pick<
    RosterSnapshot,
    'capturedAt' | 'id' | 'population' | 'sourceConfiguration' | 'version'
  >
>;

/** One selected recipient and only the active endpoints eligible to receive. */
export interface ResolvedAudienceRecipient {
  readonly recipientId: RecipientId;
  readonly groupSourceRefs: readonly RosterGroupSourceRef[];
  readonly endpoints: readonly Endpoint[];
}

/**
 * Pure internal delivery plan. It repeats every immutable version selected for
 * the resolution so later syncs or configuration edits cannot change a send.
 */
export interface ResolvedAudience {
  readonly rosterSnapshot: ResolvedRosterSnapshotRef;
  readonly facilityId: string;
  readonly sourceGroupRefs: readonly RosterGroupSourceRef[];
  readonly recipients: readonly ResolvedAudienceRecipient[];
}

function fail(code: AudienceResolutionErrorCode): never {
  throw new AudienceResolutionError(code);
}

function parseRosterSnapshot(value: RosterSnapshot): RosterSnapshot {
  const result = RosterSnapshotSchema.safeParse(value);
  if (!result.success) {
    return fail('INVALID_ROSTER_SNAPSHOT');
  }
  return result.data;
}

function groupSourceKey(source: RosterGroupSourceRef): string {
  return [source.purpose, source.facilityId ?? '', source.kind, source.id].join(
    ':',
  );
}

function groupSourcesEqual(
  left: RosterGroupSourceRef,
  right: RosterGroupSourceRef,
): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.purpose === right.purpose &&
    left.facilityId === right.facilityId
  );
}

function endpointKey(endpoint: Endpoint): string {
  return `${endpoint.channel}:${endpoint.id}`;
}

function endpointDestinationKey(endpoint: Endpoint): string {
  switch (endpoint.channel) {
    case 'email':
      return `email:${endpoint.email.toLowerCase()}`;
    case 'push':
      return `push:${endpoint.token}`;
    case 'sms':
      return `sms:${endpoint.phoneNumber}`;
  }
}

function compareGroupSources(
  left: RosterGroupSourceRef,
  right: RosterGroupSourceRef,
): number {
  return groupSourceKey(left).localeCompare(groupSourceKey(right));
}

function compareEndpoints(left: Endpoint, right: Endpoint): number {
  return endpointKey(left).localeCompare(endpointKey(right));
}

function addSelectedSource(
  selectedSources: Map<string, RosterGroupSourceRef>,
  source: RosterGroupSourceRef,
): void {
  const existing = selectedSources.get(source.id);
  if (existing !== undefined && !groupSourcesEqual(existing, source)) {
    fail('GROUP_SOURCE_PROVENANCE_CONFLICT');
  }
  selectedSources.set(source.id, source);
}

/**
 * Resolves a pinned audience exclusively from supplied immutable records.
 * There is deliberately no provider, database, or Google dependency here.
 */
export function resolveAudience(input: ResolveAudienceInput): ResolvedAudience {
  const facilityId = FacilityIdSchema.parse(input.facilityId);
  const rosterSnapshot = parseRosterSnapshot(input.rosterSnapshot);

  const snapshotFacilityIds = new Set(rosterSnapshot.facilityIds);
  if (!snapshotFacilityIds.has(facilityId)) {
    fail('MISSING_AUDIENCE_FACILITY');
  }

  const snapshotSourceById = new Map<string, RosterGroupSourceRef>();
  const buildingSourcesByFacility = new Map<
    string,
    readonly RosterGroupSourceRef[]
  >();
  for (const source of rosterSnapshot.sourceGroupRefs) {
    snapshotSourceById.set(source.id, source);
    if (source.purpose !== 'building') {
      continue;
    }
    const existing = buildingSourcesByFacility.get(source.facilityId) ?? [];
    buildingSourcesByFacility.set(
      source.facilityId,
      Object.freeze([...existing, source]),
    );
  }

  const selectedSources = new Map<string, RosterGroupSourceRef>();

  const selectBuildingFacility = (target: string): void => {
    if (!snapshotFacilityIds.has(target)) {
      fail('MISSING_TARGET_FACILITY');
    }
    const sources = buildingSourcesByFacility.get(target);
    if (sources === undefined || sources.length === 0) {
      fail('MISSING_BUILDING_SOURCE');
    }
    sources.forEach((source) => addSelectedSource(selectedSources, source));
  };

  // The selection rule: an event at a school reaches that school's staff and
  // everyone an others source names, at every school. An others source is the
  // district-level list, the responders who belong at every event. Every
  // snapshot carried them and nothing ever selected them, so a person on one
  // was reached nowhere.
  selectBuildingFacility(facilityId);
  for (const source of rosterSnapshot.sourceGroupRefs) {
    if (source.purpose === 'others') {
      addSelectedSource(selectedSources, source);
    }
  }

  const endpointOwnerById = new Map<string, RecipientId>();
  const endpointOwnerByDestination = new Map<string, RecipientId>();
  const recipients: ResolvedAudienceRecipient[] = [];

  for (const recipient of rosterSnapshot.recipients) {
    const matchedSources: RosterGroupSourceRef[] = [];
    for (const recipientSource of recipient.groupSourceRefs) {
      const selectedSource = selectedSources.get(recipientSource.id);
      if (selectedSource === undefined) {
        continue;
      }
      if (!groupSourcesEqual(selectedSource, recipientSource)) {
        fail('GROUP_SOURCE_PROVENANCE_CONFLICT');
      }
      matchedSources.push(selectedSource);
    }

    if (matchedSources.length === 0) {
      continue;
    }

    const activeEndpoints = recipient.endpoints
      .filter((endpoint) => endpoint.status === 'active')
      .sort(compareEndpoints);

    for (const endpoint of activeEndpoints) {
      const ownerById = endpointOwnerById.get(endpoint.id);
      const destinationKey = endpointDestinationKey(endpoint);
      const ownerByDestination = endpointOwnerByDestination.get(destinationKey);
      if (
        (ownerById !== undefined && ownerById !== recipient.id) ||
        (ownerByDestination !== undefined &&
          ownerByDestination !== recipient.id)
      ) {
        fail('ENDPOINT_PROVENANCE_CONFLICT');
      }
      endpointOwnerById.set(endpoint.id, recipient.id);
      endpointOwnerByDestination.set(destinationKey, recipient.id);
    }

    recipients.push(
      Object.freeze({
        recipientId: recipient.id,
        groupSourceRefs: Object.freeze(
          [...matchedSources].sort(compareGroupSources),
        ),
        endpoints: Object.freeze(activeEndpoints),
      }),
    );
  }

  recipients.sort((left, right) =>
    left.recipientId.localeCompare(right.recipientId),
  );

  return Object.freeze({
    rosterSnapshot: Object.freeze({
      id: rosterSnapshot.id,
      version: rosterSnapshot.version,
      population: rosterSnapshot.population,
      sourceConfiguration: Object.freeze({
        ...rosterSnapshot.sourceConfiguration,
      }),
      capturedAt: rosterSnapshot.capturedAt,
    }),
    facilityId,
    sourceGroupRefs: Object.freeze(
      [...selectedSources.values()].sort(compareGroupSources),
    ),
    recipients: Object.freeze(recipients),
  });
}
