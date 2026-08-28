import {
  createHash,
  createPrivateKey,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  ActorSchema,
  EndpointSchema,
  GroupSourceSchema,
  IdempotencyKeySchema,
  RecipientSchema,
  registerCapabilityHandler,
  RosterGroupSourceRefSchema,
  RosterPopulationSchema,
  RosterSnapshotSchema,
  RosterSourceConfigurationRefSchema,
  RosterSourceConfigurationSchema,
  SyncRosterInputSchema,
  RosterSyncResultSchema,
  TimestampSchema,
  UuidSchema,
  type Actor,
  type CapabilityAuthorizationRequest,
  type CapabilityExecutionAuthorizer,
  type GroupSource,
  type GroupCompletionKind,
  type GroupSourceKind,
  type Recipient,
  type RegisteredCapabilityHandler,
  type RegisteredCapabilityId,
  type RosterGroupFailure,
  type RosterGroupSourceRef,
  type RosterPopulation,
  type PushProviderCutover,
  type RosterSourceConfiguration,
  type RosterSourceConfigurationRef,
  type RosterSyncResult,
  type SyncRosterInput,
} from '@psd-eoc/contracts';

import { staffRosterEmail } from '../config/staff-email';
import {
  parsePushProviderCutover,
  PUSH_PROVIDER_CUTOVER_ENV,
  selectedPushProvider,
} from '../push-provider-cutover';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

import type { Database } from '../../db/client';
import {
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  groupMembers,
  groupSources,
  idempotencyRecords,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  rosterSyncGroupFailures,
  rosterSyncResults,
  rosterSyncResultSources,
  users,
} from '../../db/schema';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLOUD_IDENTITY_ENDPOINT =
  'https://cloudidentity.googleapis.com/v1';
const GOOGLE_GROUP_MEMBER_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
const GOOGLE_ROSTER_WORKSPACE_ROLE = '_GROUPS_READER_ROLE';
const DEFAULT_GOOGLE_TIMEOUT_MILLISECONDS = 10_000;
const MAX_GOOGLE_RESPONSE_BYTES = 512 * 1024;
const MAX_GROUP_PAGES = 100;
const MAX_GROUP_MEMBERS = 1_200;
const DEFAULT_FETCH_CONCURRENCY = 5;
const IDEMPOTENCY_IN_PROGRESS_MAX_AGE_MILLISECONDS = 15 * 60 * 1_000;
const SUSPICIOUS_BUILDING_DROP_MINIMUM_REMOVALS = 5;
const SUSPICIOUS_BUILDING_DROP_REMAINING_PERCENT = 80;

const SafeErrorCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_]+$/u);

/** Sanitized operational failure that never retains provider payloads or PII. */
export class RosterSyncError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'RosterSyncError';
    this.code = SafeErrorCodeSchema.parse(code);
  }
}

const RosterGroupMemberSchema = z
  .object({
    memberKey: z.string().trim().min(1).max(255),
    googleSubject: z.string().trim().min(1).max(255).nullable(),
    displayName: z.string().trim().min(1).max(160),
    email: z.string().trim().email().max(320),
  })
  .strict()
  .readonly();

/** Minimized, validated member facts returned by a roster source adapter. */
export type RosterGroupMember = z.infer<typeof RosterGroupMemberSchema>;

const RosterGroupPageSchema = z
  .object({
    members: z.array(RosterGroupMemberSchema).max(MAX_GROUP_MEMBERS).readonly(),
    nextPageToken: z.string().trim().min(1).max(2_048).nullable(),
  })
  .strict()
  .readonly();

/** One bounded page from a Google or fail-closed synthetic source. */
export type RosterGroupPage = z.infer<typeof RosterGroupPageSchema>;

/** Read-only source adapter. Implementations never receive a write credential. */
export interface RosterGroupsAdapter {
  readonly truthLabel: 'mocked' | 'configured-unverified';
  fetchPage(
    source: GroupSource,
    pageToken: string | null,
  ): Promise<RosterGroupPage>;
}

/** Active local push registration that may be copied into a new snapshot. */
export interface RosterLocalPushEndpoint {
  readonly id: string;
  readonly platform: 'ios' | 'android';
  readonly provider: 'expo' | 'apns' | 'fcm';
  readonly serviceEnvironment: 'development' | 'production';
  readonly token: string;
}

/** Local user facts matched only by the canonical staff email from Groups. */
export interface RosterLocalContact {
  readonly googleSubject: string;
  readonly staffEmail: string;
  readonly displayName: string;
  readonly pushEndpoints: readonly RosterLocalPushEndpoint[];
}

/** Exact source configuration and revision evidence read before provider I/O. */
export interface LoadedRosterSourceConfiguration {
  readonly configuration: RosterSourceConfiguration;
  readonly sources: readonly GroupSource[];
  readonly revisionDigest: string;
}

export interface RosterSyncReservationRequest {
  readonly idempotencyKey: string;
  readonly principal: Actor;
  readonly requestDigest: string;
  readonly startedAt: string;
}

export type RosterSyncReservation =
  | Readonly<{ kind: 'reserved'; id: string }>
  | Readonly<{ kind: 'replay'; result: RosterSyncResult }>;

export interface CompleteRosterSyncPersistenceRequest {
  readonly reservationId: string;
  readonly loadedConfiguration: LoadedRosterSourceConfiguration;
  readonly observedBaselineSnapshotId: string | null;
  readonly recipients: readonly Recipient[];
  readonly startedAt: string;
  readonly capturedAt: string;
}

export interface RejectedRosterSyncPersistenceRequest {
  readonly reservationId: string;
  readonly loadedConfiguration: LoadedRosterSourceConfiguration;
  readonly completedSourceGroupRefs: readonly RosterGroupSourceRef[];
  readonly groupFailures: readonly RosterGroupFailure[];
  readonly startedAt: string;
  readonly completedAt: string;
}

/** PII-free count evidence from the last complete snapshot of a population. */
export interface RosterSyncBaseline {
  readonly snapshotId: string;
  readonly version: number;
  readonly population: RosterPopulation;
  readonly sourceConfiguration: RosterSourceConfigurationRef;
  readonly groupMemberCounts: readonly Readonly<{
    groupSourceId: string;
    memberCount: number;
  }>[];
}

/** Deterministic per-source diff calculated before a complete publication. */
export interface RosterGroupCountDiff {
  readonly groupSourceRef: RosterGroupSourceRef;
  readonly previousCount: number | null;
  readonly currentCount: number;
  readonly delta: number | null;
}

/** Persistence boundary used by both PostgreSQL and deterministic unit fakes. */
export interface RosterSyncStore {
  reserve(
    request: RosterSyncReservationRequest,
  ): Promise<RosterSyncReservation>;
  loadSourceConfiguration(
    reference: RosterSourceConfigurationRef,
  ): Promise<LoadedRosterSourceConfiguration | null>;
  loadLocalContacts(
    identityKeys: readonly string[],
  ): Promise<readonly RosterLocalContact[]>;
  loadLatestCompleteBaseline(
    population: RosterPopulation,
  ): Promise<RosterSyncBaseline | null>;
  publishComplete(
    request: CompleteRosterSyncPersistenceRequest,
  ): Promise<RosterSyncResult>;
  recordRejected(
    request: RejectedRosterSyncPersistenceRequest,
  ): Promise<RosterSyncResult>;
  failReservation(
    reservationId: string,
    errorCode: string,
    completedAt: string,
  ): Promise<void>;
}

/** PII-free alert fact. It may safely feed structured logs or an alarm sink. */
export interface RosterSyncAlert {
  readonly sourceConfiguration: RosterSourceConfigurationRef;
  readonly population: RosterPopulation | null;
  readonly syncResultId: string | null;
  readonly outcome: 'failed' | 'partial-rejected' | 'execution-failed';
  readonly errorCodes: readonly string[];
  readonly occurredAt: string;
}

export interface RosterSyncAlertSink {
  notify(alert: RosterSyncAlert): void | Promise<void>;
}

/** Trusted context supplied by a capability adapter, never by its JSON body. */
export interface RosterSyncCapabilityContext {
  readonly actor: Actor;
  readonly source: 'scheduled-job';
  readonly transport: 'scheduled-execution';
  readonly schedulerAuthenticated: true;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface RosterSyncDependencies {
  readonly store: RosterSyncStore;
  readonly adapter: RosterGroupsAdapter;
  readonly alerts: RosterSyncAlertSink;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly fetchConcurrency?: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function trustedTimestamp(now: () => Date): string {
  const value = new Date(now().getTime());
  if (Number.isNaN(value.getTime())) {
    throw new RosterSyncError(
      'SYNC_CLOCK_INVALID',
      'The trusted roster-sync clock returned an invalid time.',
    );
  }
  return TimestampSchema.parse(value.toISOString());
}

function trustedUuid(uuid: () => string): string {
  return UuidSchema.parse(uuid());
}

function sourceRef(source: GroupSource): RosterGroupSourceRef {
  if (source.purpose === 'access') {
    throw new RosterSyncError(
      'ACCESS_GROUP_IN_ROSTER',
      'Access groups cannot enter roster snapshots.',
    );
  }
  return RosterGroupSourceRefSchema.parse({
    id: source.id,
    kind: source.kind,
    purpose: source.purpose,
    facilityId: source.facilityId,
  });
}

function sourceRefKey(source: RosterGroupSourceRef): string {
  return `${source.id}:${source.kind}:${source.purpose}:${source.facilityId ?? ''}`;
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof RosterSyncError ? error.code : fallback;
}

function validateMemberPopulation(
  member: RosterGroupMember,
  population: RosterPopulation,
): void {
  const normalizedEmail = member.email.toLowerCase();
  if (population === 'staff') {
    const staffEmail = staffRosterEmail().safeParse(member.email);
    if (
      !staffEmail.success ||
      staffEmail.data !== member.email ||
      member.googleSubject !== null ||
      member.memberKey !== normalizedEmail
    ) {
      throw new RosterSyncError(
        'GROUP_MEMBER_INVALID',
        'A staff group returned a member outside the approved email-only staff shape.',
      );
    }
    return;
  }
  if (member.googleSubject !== null || !normalizedEmail.endsWith('.invalid')) {
    throw new RosterSyncError(
      'SYNTHETIC_MEMBER_ROUTABLE',
      'Synthetic roster members must remain provably unroutable.',
    );
  }
}

async function fetchCompleteGroup(
  adapter: RosterGroupsAdapter,
  source: GroupSource,
  population: RosterPopulation,
): Promise<readonly RosterGroupMember[]> {
  if (
    adapter.truthLabel === 'mocked' &&
    (population !== 'synthetic' || source.kind !== 'synthetic')
  ) {
    throw new RosterSyncError(
      'MOCK_STAFF_ROSTER_FORBIDDEN',
      'Mock roster data may only populate the synthetic training roster.',
    );
  }
  if (!source.active) {
    throw new RosterSyncError(
      'GROUP_SOURCE_INACTIVE',
      'An expected roster source is inactive.',
    );
  }

  const members = new Map<string, RosterGroupMember>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | null = null;

  for (let pageNumber = 0; pageNumber < MAX_GROUP_PAGES; pageNumber += 1) {
    const pageResult = RosterGroupPageSchema.safeParse(
      await adapter.fetchPage(source, pageToken),
    );
    if (!pageResult.success) {
      throw new RosterSyncError(
        'GROUP_RESPONSE_INVALID',
        'A roster source returned an invalid page.',
      );
    }

    for (const rawMember of pageResult.data.members) {
      const member = RosterGroupMemberSchema.parse(rawMember);
      validateMemberPopulation(member, population);
      const normalized = Object.freeze({
        ...member,
        email: member.email.toLowerCase(),
      });
      const existing = members.get(normalized.memberKey);
      if (
        existing !== undefined &&
        stableJson(existing) !== stableJson(normalized)
      ) {
        throw new RosterSyncError(
          'GROUP_MEMBER_CONFLICT',
          'A roster source returned conflicting facts for one member.',
        );
      }
      members.set(normalized.memberKey, normalized);
      if (members.size > MAX_GROUP_MEMBERS) {
        throw new RosterSyncError(
          'GROUP_MEMBER_LIMIT_EXCEEDED',
          'A roster source exceeded the supported member limit.',
        );
      }
    }

    const nextPageToken = pageResult.data.nextPageToken;
    if (nextPageToken === null) {
      return Object.freeze(
        [...members.values()].sort((left, right) =>
          left.memberKey.localeCompare(right.memberKey),
        ),
      );
    }
    if (seenPageTokens.has(nextPageToken) || nextPageToken === pageToken) {
      throw new RosterSyncError(
        'GROUP_PAGINATION_LOOP',
        'A roster source repeated a pagination token.',
      );
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new RosterSyncError(
    'GROUP_PAGE_LIMIT_EXCEEDED',
    'A roster source exceeded the supported page limit.',
  );
}

interface FetchedGroup {
  readonly source: GroupSource;
  readonly reference: RosterGroupSourceRef;
  readonly members: readonly RosterGroupMember[];
}

interface FailedGroup {
  readonly reference: RosterGroupSourceRef;
  readonly errorCode: string;
  readonly attemptedAt: string;
}

const RosterSyncBaselineSchema = z
  .object({
    snapshotId: UuidSchema,
    version: z.number().int().positive(),
    population: RosterPopulationSchema,
    sourceConfiguration: RosterSourceConfigurationRefSchema,
    groupMemberCounts: z
      .array(
        z
          .object({
            groupSourceId: UuidSchema,
            memberCount: z.number().int().nonnegative().max(MAX_GROUP_MEMBERS),
          })
          .strict()
          .readonly(),
      )
      .max(1_000)
      .readonly(),
  })
  .strict()
  .readonly();

function assertSourceConfigurationIsMonotonic(
  candidateValue: RosterSourceConfigurationRef,
  baselineValue: RosterSourceConfigurationRef | null,
): void {
  const candidate = RosterSourceConfigurationRefSchema.parse(candidateValue);
  if (baselineValue === null) {
    return;
  }
  const baseline = RosterSourceConfigurationRefSchema.parse(baselineValue);
  if (candidate.id !== baseline.id) {
    throw new RosterSyncError(
      'SOURCE_CONFIGURATION_LINEAGE_AMBIGUOUS',
      'The roster source configuration did not match the established version lineage.',
    );
  }
  if (candidate.version < baseline.version) {
    throw new RosterSyncError(
      'SOURCE_CONFIGURATION_ROLLBACK',
      'An older roster source configuration cannot supersede a newer snapshot.',
    );
  }
}

/**
 * Compares complete provider counts with the last published snapshot without
 * exposing member identities. A null previous count means the source is new.
 */
export function diffRosterGroupCounts(
  current: readonly Readonly<{
    groupSourceRef: RosterGroupSourceRef;
    memberCount: number;
  }>[],
  rawBaseline: RosterSyncBaseline | null,
): readonly RosterGroupCountDiff[] {
  const baseline =
    rawBaseline === null ? null : RosterSyncBaselineSchema.parse(rawBaseline);
  const previousCounts = new Map<string, number>();
  for (const count of baseline?.groupMemberCounts ?? []) {
    if (previousCounts.has(count.groupSourceId)) {
      throw new RosterSyncError(
        'ROSTER_BASELINE_INVALID',
        'The prior roster snapshot contained duplicate source evidence.',
      );
    }
    previousCounts.set(count.groupSourceId, count.memberCount);
  }
  const seen = new Set<string>();
  return Object.freeze(
    current
      .map((rawCount) => {
        const groupSourceRef = RosterGroupSourceRefSchema.parse(
          rawCount.groupSourceRef,
        );
        if (seen.has(groupSourceRef.id)) {
          throw new RosterSyncError(
            'ROSTER_DIFF_INVALID',
            'The current roster contained duplicate source evidence.',
          );
        }
        seen.add(groupSourceRef.id);
        const currentCount = z
          .number()
          .int()
          .nonnegative()
          .max(MAX_GROUP_MEMBERS)
          .parse(rawCount.memberCount);
        const previousCount = previousCounts.get(groupSourceRef.id) ?? null;
        return Object.freeze({
          groupSourceRef,
          previousCount,
          currentCount,
          delta: previousCount === null ? null : currentCount - previousCount,
        });
      })
      .sort((left, right) =>
        sourceRefKey(left.groupSourceRef).localeCompare(
          sourceRefKey(right.groupSourceRef),
        ),
      ),
  );
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        const input = inputs[index];
        if (input !== undefined) {
          results[index] = await operation(input);
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function assertLoadedConfiguration(
  loaded: LoadedRosterSourceConfiguration,
  requested: RosterSourceConfigurationRef,
): void {
  const configuration = RosterSourceConfigurationSchema.parse(
    loaded.configuration,
  );
  if (
    configuration.id !== requested.id ||
    configuration.version !== requested.version ||
    !/^[a-f0-9]{64}$/u.test(loaded.revisionDigest)
  ) {
    throw new RosterSyncError(
      'SOURCE_CONFIGURATION_MISMATCH',
      'The roster source configuration did not match the pinned request.',
    );
  }

  const expected = new Map(
    configuration.groupSourceRefs.map((reference) => [reference.id, reference]),
  );
  if (loaded.sources.length !== expected.size) {
    throw new RosterSyncError(
      'SOURCE_CONFIGURATION_INCOMPLETE',
      'The roster source configuration was incomplete.',
    );
  }
  for (const source of loaded.sources) {
    const parsed = GroupSourceSchema.parse(source);
    const reference = expected.get(parsed.id);
    if (
      reference === undefined ||
      sourceRefKey(reference) !== sourceRefKey(sourceRef(parsed))
    ) {
      throw new RosterSyncError(
        'SOURCE_CONFIGURATION_INCOMPLETE',
        'The roster source configuration contained an unexpected source.',
      );
    }
  }
  const buildingFacilityIds = new Set(
    loaded.sources.flatMap((source) =>
      source.purpose === 'building' ? [source.facilityId] : [],
    ),
  );
  if (
    configuration.facilityIds.some(
      (facilityId) => !buildingFacilityIds.has(facilityId),
    )
  ) {
    throw new RosterSyncError(
      'SOURCE_CONFIGURATION_INCOMPLETE',
      'Every configured facility requires a building roster source.',
    );
  }
}

interface AccumulatedMember {
  readonly memberKey: string;
  readonly googleSubject: string | null;
  readonly displayName: string;
  readonly email: string;
  readonly groupSourceRefs: Map<string, RosterGroupSourceRef>;
}

function buildRecipients(
  groups: readonly FetchedGroup[],
  localContacts: readonly RosterLocalContact[],
  population: RosterPopulation,
  capturedAt: string,
  uuid: () => string,
): readonly Recipient[] {
  const accumulated = new Map<string, AccumulatedMember>();
  for (const group of groups) {
    for (const member of group.members) {
      const identityKey =
        population === 'staff'
          ? staffRosterEmail().parse(member.email)
          : member.memberKey;
      const existing = accumulated.get(identityKey);
      if (
        existing !== undefined &&
        (existing.googleSubject !== member.googleSubject ||
          existing.displayName !== member.displayName ||
          existing.email !== member.email)
      ) {
        throw new RosterSyncError(
          'ROSTER_MEMBER_CONFLICT',
          'Roster sources disagreed about one member.',
        );
      }
      const entry =
        existing ??
        ({
          memberKey: member.memberKey,
          googleSubject: member.googleSubject,
          displayName: member.displayName,
          email: member.email,
          groupSourceRefs: new Map<string, RosterGroupSourceRef>(),
        } satisfies AccumulatedMember);
      entry.groupSourceRefs.set(sourceRefKey(group.reference), group.reference);
      accumulated.set(identityKey, entry);
    }
  }
  if (accumulated.size > MAX_GROUP_MEMBERS) {
    throw new RosterSyncError(
      'ROSTER_MEMBER_LIMIT_EXCEEDED',
      'The merged roster exceeded the supported member limit.',
    );
  }

  const contacts = new Map<string, RosterLocalContact>();
  const contactSubjects = new Set<string>();
  for (const rawContact of localContacts) {
    const googleSubject = z
      .string()
      .trim()
      .min(1)
      .max(255)
      .parse(rawContact.googleSubject);
    const contact = Object.freeze({
      googleSubject,
      staffEmail: staffRosterEmail().parse(rawContact.staffEmail),
      displayName: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .parse(rawContact.displayName),
      pushEndpoints: Object.freeze(
        rawContact.pushEndpoints.map((endpoint) =>
          Object.freeze({
            id: UuidSchema.parse(endpoint.id),
            platform: z.enum(['ios', 'android']).parse(endpoint.platform),
            provider: z.enum(['expo', 'apns', 'fcm']).parse(endpoint.provider),
            serviceEnvironment: z
              .enum(['development', 'production'])
              .parse(endpoint.serviceEnvironment),
            token: z.string().trim().min(16).max(4_096).parse(endpoint.token),
          }),
        ),
      ),
    });
    if (
      contacts.has(contact.staffEmail) ||
      contactSubjects.has(contact.googleSubject)
    ) {
      throw new RosterSyncError(
        'LOCAL_CONTACT_DUPLICATE',
        'Local contact enrichment returned an ambiguous identity.',
      );
    }
    contacts.set(contact.staffEmail, contact);
    contactSubjects.add(contact.googleSubject);
  }

  const recipients = [...accumulated.values()]
    .sort((left, right) => left.email.localeCompare(right.email))
    .map((member) => {
      const staffEmail =
        population === 'staff'
          ? staffRosterEmail().parse(member.email)
          : undefined;
      const local =
        staffEmail === undefined ? undefined : contacts.get(staffEmail);
      if (
        local !== undefined &&
        member.googleSubject !== null &&
        local.googleSubject !== member.googleSubject
      ) {
        throw new RosterSyncError(
          'LOCAL_CONTACT_IDENTITY_CONFLICT',
          'Local identity evidence conflicted with the roster source.',
        );
      }
      const endpoints = [
        EndpointSchema.parse({
          id: trustedUuid(uuid),
          channel: 'email',
          status: 'active',
          capturedAt,
          email: member.email,
        }),
        ...(local?.pushEndpoints ?? []).map((endpoint) =>
          EndpointSchema.parse({
            id: endpoint.id,
            channel: 'push',
            status: 'active',
            capturedAt,
            platform: endpoint.platform,
            provider: endpoint.provider,
            serviceEnvironment: endpoint.serviceEnvironment,
            token: endpoint.token,
          }),
        ),
      ];
      return RecipientSchema.parse({
        id: trustedUuid(uuid),
        population,
        googleSubject: local?.googleSubject ?? member.googleSubject,
        ...(staffEmail === undefined ? {} : { staffEmail }),
        displayName: local?.displayName ?? member.displayName,
        groupSourceRefs: [...member.groupSourceRefs.values()].sort(
          (left, right) =>
            sourceRefKey(left).localeCompare(sourceRefKey(right)),
        ),
        endpoints,
      });
    });

  return Object.freeze(recipients);
}

function validateSnapshotDraft(
  loaded: LoadedRosterSourceConfiguration,
  recipients: readonly Recipient[],
  startedAt: string,
  capturedAt: string,
  uuid: () => string,
): void {
  const configuration = loaded.configuration;
  RosterSnapshotSchema.parse({
    id: trustedUuid(uuid),
    version: 1,
    population: configuration.population,
    complete: true,
    sourceConfiguration: {
      id: configuration.id,
      version: configuration.version,
    },
    facilityIds: configuration.facilityIds,
    expectedSourceGroupRefs: configuration.groupSourceRefs,
    sourceGroupRefs: configuration.groupSourceRefs,
    recipients,
    syncStartedAt: startedAt,
    capturedAt,
  });
}

function toGroupFailures(
  failures: readonly FailedGroup[],
): readonly RosterGroupFailure[] {
  return Object.freeze(
    failures
      .map((failure) =>
        Object.freeze({
          groupSourceRef: failure.reference,
          errorCode: SafeErrorCodeSchema.parse(failure.errorCode),
          attemptedAt: TimestampSchema.parse(failure.attemptedAt),
        }),
      )
      .sort((left, right) =>
        sourceRefKey(left.groupSourceRef).localeCompare(
          sourceRefKey(right.groupSourceRef),
        ),
      ),
  );
}

async function alertForResult(
  alerts: RosterSyncAlertSink,
  result: RosterSyncResult,
): Promise<void> {
  if (result.outcome === 'complete') {
    return;
  }
  await alerts.notify(
    Object.freeze({
      sourceConfiguration: result.sourceConfiguration,
      population: result.population,
      syncResultId: result.id,
      outcome: result.outcome,
      errorCodes: Object.freeze(
        [
          ...new Set(result.groupFailures.map((failure) => failure.errorCode)),
        ].sort(),
      ),
      occurredAt: result.completedAt,
    }),
  );
}

/**
 * Fetches every expected source before publication. Any failed, malformed, or
 * partial source records a rejected attempt and leaves the last complete
 * snapshot untouched.
 */
export async function syncRoster(
  inputValue: SyncRosterInput,
  context: RosterSyncCapabilityContext,
  dependencies: RosterSyncDependencies,
): Promise<RosterSyncResult> {
  const input = SyncRosterInputSchema.parse(inputValue);
  const actor = ActorSchema.parse(context.actor);
  const idempotencyKey = IdempotencyKeySchema.parse(context.idempotencyKey);
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const startedAt = trustedTimestamp(now);
  const requestDigest = digest(input);
  let reservation: RosterSyncReservation;
  try {
    reservation = await dependencies.store.reserve({
      idempotencyKey,
      principal: actor,
      requestDigest,
      startedAt,
    });
  } catch (error) {
    const occurredAt = trustedTimestamp(now);
    const sanitizedCode = errorCode(error, 'ROSTER_SYNC_FAILED');
    await dependencies.alerts.notify(
      Object.freeze({
        sourceConfiguration: input.sourceConfiguration,
        population: null,
        syncResultId: null,
        outcome: 'execution-failed',
        errorCodes: Object.freeze([sanitizedCode]),
        occurredAt,
      }),
    );
    throw error instanceof RosterSyncError
      ? error
      : new RosterSyncError(
          'ROSTER_SYNC_FAILED',
          'Roster synchronization failed safely.',
        );
  }
  if (reservation.kind === 'replay') {
    await alertForResult(dependencies.alerts, reservation.result);
    return reservation.result;
  }

  let persistedResult: RosterSyncResult | undefined;
  let alertPopulation: RosterPopulation | null = null;
  try {
    const loaded = await dependencies.store.loadSourceConfiguration(
      input.sourceConfiguration,
    );
    if (loaded === null) {
      throw new RosterSyncError(
        'SOURCE_CONFIGURATION_NOT_FOUND',
        'The pinned roster source configuration does not exist.',
      );
    }
    assertLoadedConfiguration(loaded, input.sourceConfiguration);
    alertPopulation = loaded.configuration.population;

    const baseline = await dependencies.store.loadLatestCompleteBaseline(
      loaded.configuration.population,
    );
    if (
      baseline !== null &&
      baseline.population !== loaded.configuration.population
    ) {
      throw new RosterSyncError(
        'ROSTER_BASELINE_INVALID',
        'The prior roster baseline had the wrong population.',
      );
    }
    assertSourceConfigurationIsMonotonic(
      {
        id: loaded.configuration.id,
        version: loaded.configuration.version,
      },
      baseline?.sourceConfiguration ?? null,
    );

    const sources = [...loaded.sources].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const concurrency = z
      .number()
      .int()
      .min(1)
      .max(20)
      .parse(dependencies.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY);
    const attempts = await mapWithConcurrency(
      sources,
      concurrency,
      async (source) => {
        const reference = sourceRef(source);
        const attemptedAt = trustedTimestamp(now);
        try {
          return Object.freeze({
            kind: 'complete' as const,
            group: Object.freeze({
              source,
              reference,
              members: await fetchCompleteGroup(
                dependencies.adapter,
                source,
                loaded.configuration.population,
              ),
            }),
          });
        } catch (error) {
          return Object.freeze({
            kind: 'failed' as const,
            failure: Object.freeze({
              reference,
              errorCode: errorCode(error, 'GROUP_FETCH_FAILED'),
              attemptedAt,
            }),
          });
        }
      },
    );

    const fetchedGroups = attempts.flatMap((attempt) =>
      attempt.kind === 'complete' ? [attempt.group] : [],
    );
    const fetchFailures = attempts.flatMap((attempt) =>
      attempt.kind === 'failed' ? [attempt.failure] : [],
    );
    const groupCountEvidence = fetchedGroups.map((group) =>
      Object.freeze({
        groupSourceRef: group.reference,
        memberCount: group.members.length,
      }),
    );
    const groupDiff = diffRosterGroupCounts(groupCountEvidence, baseline);
    const suspiciousBuildingFailures: readonly FailedGroup[] =
      groupDiff.flatMap((entry) => {
        if (entry.groupSourceRef.purpose !== 'building') {
          return [];
        }
        const removed =
          entry.previousCount === null
            ? 0
            : entry.previousCount - entry.currentCount;
        const errorCode =
          entry.currentCount === 0
            ? 'EMPTY_BUILDING_GROUP'
            : entry.previousCount !== null &&
                removed >= SUSPICIOUS_BUILDING_DROP_MINIMUM_REMOVALS &&
                entry.currentCount * 100 <
                  entry.previousCount *
                    SUSPICIOUS_BUILDING_DROP_REMAINING_PERCENT
              ? 'SUSPICIOUS_BUILDING_GROUP_DROP'
              : null;
        return errorCode === null
          ? []
          : [
              Object.freeze({
                reference: entry.groupSourceRef,
                errorCode,
                attemptedAt: trustedTimestamp(now),
              }),
            ];
      });
    const syncFailures = [...fetchFailures, ...suspiciousBuildingFailures];
    if (syncFailures.length > 0) {
      const failedSourceIds = new Set(
        syncFailures.map((failure) => failure.reference.id),
      );
      persistedResult = await dependencies.store.recordRejected({
        reservationId: reservation.id,
        loadedConfiguration: loaded,
        completedSourceGroupRefs: fetchedGroups
          .filter((group) => !failedSourceIds.has(group.reference.id))
          .map((group) => group.reference),
        groupFailures: toGroupFailures(syncFailures),
        startedAt,
        completedAt: trustedTimestamp(now),
      });
    } else {
      const localIdentityKeys = fetchedGroups.flatMap((group) =>
        group.members.map((member) =>
          loaded.configuration.population === 'staff'
            ? staffRosterEmail().parse(member.email)
            : member.memberKey,
        ),
      );
      const localContacts = await dependencies.store.loadLocalContacts(
        Object.freeze([...new Set(localIdentityKeys)].sort()),
      );
      const capturedAt = trustedTimestamp(now);
      let publication: CompleteRosterSyncPersistenceRequest | null = null;
      try {
        const recipients = buildRecipients(
          fetchedGroups,
          localContacts,
          loaded.configuration.population,
          capturedAt,
          uuid,
        );
        validateSnapshotDraft(loaded, recipients, startedAt, capturedAt, uuid);
        publication = Object.freeze({
          reservationId: reservation.id,
          loadedConfiguration: loaded,
          observedBaselineSnapshotId: baseline?.snapshotId ?? null,
          recipients,
          startedAt,
          capturedAt,
        });
      } catch (error) {
        const rejectedAt = trustedTimestamp(now);
        const rejectionCode = errorCode(error, 'ROSTER_BUILD_FAILED');
        persistedResult = await dependencies.store.recordRejected({
          reservationId: reservation.id,
          loadedConfiguration: loaded,
          completedSourceGroupRefs: [],
          groupFailures: toGroupFailures(
            loaded.configuration.groupSourceRefs.map((reference) => ({
              reference,
              errorCode: rejectionCode,
              attemptedAt: rejectedAt,
            })),
          ),
          startedAt,
          completedAt: rejectedAt,
        });
      }
      if (publication !== null) {
        persistedResult = await dependencies.store.publishComplete(publication);
      }
    }
    if (persistedResult === undefined) {
      throw new RosterSyncError(
        'ROSTER_SYNC_FAILED',
        'Roster synchronization ended without a durable result.',
      );
    }
  } catch (error) {
    const occurredAt = trustedTimestamp(now);
    const sanitizedCode = errorCode(error, 'ROSTER_SYNC_FAILED');
    await dependencies.store
      .failReservation(reservation.id, sanitizedCode, occurredAt)
      .catch(() => undefined);
    await dependencies.alerts.notify(
      Object.freeze({
        sourceConfiguration: input.sourceConfiguration,
        population: alertPopulation,
        syncResultId: null,
        outcome: 'execution-failed',
        errorCodes: Object.freeze([sanitizedCode]),
        occurredAt,
      }),
    );
    throw error instanceof RosterSyncError
      ? error
      : new RosterSyncError(
          'ROSTER_SYNC_FAILED',
          'Roster synchronization failed safely.',
        );
  }

  const parsed = RosterSyncResultSchema.parse(persistedResult);
  await alertForResult(dependencies.alerts, parsed);
  return parsed;
}

/** Registers roster sync under the canonical capability catalog. */
export function createSyncRosterHandler(
  dependencies: RosterSyncDependencies,
): Readonly<
  RegisteredCapabilityHandler<'sync-roster', RosterSyncCapabilityContext>
> {
  return registerCapabilityHandler('sync-roster', (input, context) =>
    syncRoster(input, context, dependencies),
  );
}

/** Deny-by-default authorizer for the authenticated scheduled job surface. */
export function createScheduledRosterSyncAuthorizer(): Readonly<
  CapabilityExecutionAuthorizer<RosterSyncCapabilityContext>
> {
  return Object.freeze({
    authorize(
      request: CapabilityAuthorizationRequest<
        RegisteredCapabilityId,
        RosterSyncCapabilityContext
      >,
    ): void {
      const context = request.context;
      if (
        request.definition.id !== 'sync-roster' ||
        context.actor.kind !== 'system' ||
        context.actor.serviceId !== 'roster-sync-job' ||
        context.source !== 'scheduled-job' ||
        context.transport !== 'scheduled-execution' ||
        context.schedulerAuthenticated !== true ||
        request.humanActionRequirement.actionIds.length !== 0
      ) {
        throw new RosterSyncError(
          'ROSTER_SYNC_UNAUTHORIZED',
          'The roster sync invocation was not authorized.',
        );
      }
      UuidSchema.parse(context.requestId);
      IdempotencyKeySchema.parse(context.idempotencyKey);
    },
  });
}

/** Constant-time bearer comparison used before any request body is parsed. */
export function verifyRosterSyncJobToken(
  authorizationHeader: string | null,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return false;
  }
  const supplied = Buffer.from(authorizationHeader.slice('Bearer '.length));
  const expected = Buffer.from(expectedToken);
  return (
    expected.byteLength >= 32 &&
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
}

const GoogleCloudIdentityGroupSchema = z
  .object({
    name: z.string().regex(/^groups\/[A-Za-z0-9_-]+$/u),
  })
  .strict()
  .readonly();

// Deferred deliberately. `staffRosterEmail()` reads the configured staff
// domain and fails closed when it is absent, and a module-scope schema would
// run that read at import — including during `next build`, which imports every
// route to collect page data. The image is built once and deployed by any
// district, so it cannot require one district's domain to compile.
const GoogleCloudIdentityEntityKeySchema = z.lazy(() =>
  z.object({ id: staffRosterEmail() }).strict().readonly(),
);

const GoogleCloudIdentityTransitiveRoleSchema = z
  .object({
    role: z.enum(['OWNER', 'MANAGER', 'MEMBER']),
  })
  .strict()
  .readonly();

const GoogleCloudIdentityMemberRelationSchema = z
  .object({
    preferredMemberKey: z
      .array(GoogleCloudIdentityEntityKeySchema)
      .length(1)
      .readonly(),
    member: z.string().regex(/^(?:groups\/[A-Za-z0-9_-]+|users\/[0-9]+)$/u),
    roles: z
      .array(GoogleCloudIdentityTransitiveRoleSchema)
      .min(1)
      .max(3)
      .readonly(),
    relationType: z.enum(['DIRECT', 'INDIRECT', 'DIRECT_AND_INDIRECT']),
  })
  .strict()
  .superRefine((relation, context) => {
    const roles = relation.roles.map((role) => role.role);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: 'custom',
        message: 'Cloud Identity membership roles must be unique.',
        path: ['roles'],
      });
    }
  })
  .readonly();

const GoogleCloudIdentityMembersResponseSchema = z
  .object({
    memberships: z
      .array(GoogleCloudIdentityMemberRelationSchema)
      .max(MAX_GROUP_MEMBERS)
      .optional(),
    nextPageToken: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict()
  .readonly();

const GoogleTokenResponseSchema = z
  .object({
    access_token: z.string().trim().min(16).max(8_192),
    expires_in: z.number().int().min(60).max(3_600),
    token_type: z.literal('Bearer'),
    scope: z.literal(GOOGLE_GROUP_MEMBER_SCOPE).optional(),
  })
  .strict()
  .readonly();

const GoogleCloudIdentityCredentialSchema = z
  .object({
    type: z.literal('service_account'),
    project_id: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
    private_key_id: z.string().regex(/^[a-f0-9]{40}$/u),
    private_key: z.string().min(1).max(16_384),
    client_email: z.string().trim().email().max(320),
    client_id: z.string().regex(/^\d+$/u),
    auth_uri: z.literal('https://accounts.google.com/o/oauth2/auth'),
    token_uri: z.literal(GOOGLE_TOKEN_ENDPOINT),
    auth_provider_x509_cert_url: z.literal(
      'https://www.googleapis.com/oauth2/v1/certs',
    ),
    client_x509_cert_url: z.string().url().max(2_048),
    universe_domain: z.literal('googleapis.com'),
    // Required retained-secret provenance only. Runtime source authority comes
    // from the exact versioned database configuration loaded by syncRoster.
    approved_staff_group_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    credential_created_at: TimestampSchema,
    domain_wide_delegation: z.literal(false),
    oauth_scopes: z.tuple([z.literal(GOOGLE_GROUP_MEMBER_SCOPE)]).readonly(),
    workspace_admin_role: z.literal(GOOGLE_ROSTER_WORKSPACE_ROLE),
  })
  .strict()
  .superRefine((credential, context) => {
    const serviceAccountSuffix = `@${credential.project_id}.iam.gserviceaccount.com`;
    const serviceAccountName = credential.client_email.slice(
      0,
      -serviceAccountSuffix.length,
    );
    const expectedCertificateUrl = `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(credential.client_email)}`;
    if (
      !credential.client_email.endsWith(serviceAccountSuffix) ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(serviceAccountName)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The service account email must belong to its GCP project.',
        path: ['client_email'],
      });
    }
    if (credential.client_x509_cert_url !== expectedCertificateUrl) {
      context.addIssue({
        code: 'custom',
        message:
          'The service account certificate URL must identify the same account.',
        path: ['client_x509_cert_url'],
      });
    }
  })
  .readonly();

export interface GoogleCloudIdentityRosterConfiguration {
  readonly serviceAccountEmail: string;
  readonly privateKeyId: string;
  readonly privateKey: string;
  readonly timeoutMilliseconds: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function requiredEnvironmentValue(
  environment: Environment,
  name: string,
  maximumLength: number,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\0\r]/u.test(value)
  ) {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      `${name} must be configured for roster synchronization.`,
    );
  }
  return value;
}

/** Reads the exact non-delegated Cloud Identity credential with no fallback. */
export function readGoogleCloudIdentityRosterConfiguration(
  environment: Environment = process.env,
): GoogleCloudIdentityRosterConfiguration {
  const serialized = requiredEnvironmentValue(
    environment,
    'GOOGLE_ROSTER_CONFIG',
    32_768,
  );
  let rawCredential: unknown;
  try {
    rawCredential = JSON.parse(serialized) as unknown;
  } catch {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'The Google roster credential is not valid JSON.',
    );
  }
  const parsedCredential =
    GoogleCloudIdentityCredentialSchema.safeParse(rawCredential);
  if (!parsedCredential.success) {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'The Google roster credential does not match the approved Cloud Identity contract.',
    );
  }
  const timeoutRaw =
    environment.GOOGLE_ROSTER_HTTP_TIMEOUT_MS ??
    String(DEFAULT_GOOGLE_TIMEOUT_MILLISECONDS);
  const timeoutMilliseconds = Number(timeoutRaw);
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 30_000
  ) {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'Google roster credentials or timeout are invalid.',
    );
  }
  try {
    const signingKey = createPrivateKey(parsedCredential.data.private_key);
    if (
      signingKey.type !== 'private' ||
      signingKey.asymmetricKeyType !== 'rsa'
    ) {
      throw new Error('The roster signing key is not an RSA private key.');
    }
  } catch {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'The Google roster signing key is invalid.',
    );
  }
  return Object.freeze({
    serviceAccountEmail: parsedCredential.data.client_email,
    privateKeyId: parsedCredential.data.private_key_id,
    privateKey: parsedCredential.data.private_key,
    timeoutMilliseconds,
  });
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_GOOGLE_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new RosterSyncError(
      'GOOGLE_RESPONSE_TOO_LARGE',
      'Google returned an oversized roster response.',
    );
  }
  if (response.body === null) {
    throw new RosterSyncError(
      'GOOGLE_RESPONSE_INVALID',
      'Google returned an empty roster response.',
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let abortListener: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () =>
      reject(
        new RosterSyncError(
          'GOOGLE_UNAVAILABLE',
          'Google Groups timed out during roster synchronization.',
        ),
      );
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
    }
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_GOOGLE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RosterSyncError(
          'GOOGLE_RESPONSE_TOO_LARGE',
          'Google returned an oversized roster response.',
        );
      }
      chunks.push(value);
    }
  } finally {
    if (abortListener !== null) {
      signal.removeEventListener('abort', abortListener);
    }
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
    }
    try {
      reader.releaseLock();
    } catch {
      // An aborted read may still own the lock; cancellation remains fail-safe.
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RosterSyncError(
      'GOOGLE_RESPONSE_INVALID',
      'Google returned non-UTF-8 roster data.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RosterSyncError(
      'GOOGLE_RESPONSE_INVALID',
      'Google returned malformed roster data.',
    );
  }
}

/** Creates the non-delegated, read-only Cloud Identity Groups adapter. */
export function createGoogleCloudIdentityRosterAdapter(
  configuration: GoogleCloudIdentityRosterConfiguration,
  options: Readonly<{
    fetch?: typeof fetch;
    now?: () => Date;
  }> = {},
): RosterGroupsAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let cachedToken:
    | Readonly<{ value: string; refreshAfterMilliseconds: number }>
    | undefined;
  const resolvedGroupNames = new Map<
    string,
    Readonly<{ sourceIdentity: string; groupName: string }>
  >();

  async function fetchWithTimeout<Result>(
    input: string | URL,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      configuration.timeoutMilliseconds,
    );
    try {
      const response = await fetchImplementation(input, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      return await consume(response, controller.signal);
    } catch (error) {
      if (error instanceof RosterSyncError) {
        throw error;
      }
      throw new RosterSyncError(
        'GOOGLE_UNAVAILABLE',
        'Google Groups was unavailable during roster synchronization.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function accessToken(): Promise<string> {
    const nowMilliseconds = now().getTime();
    if (!Number.isFinite(nowMilliseconds)) {
      throw new RosterSyncError(
        'GOOGLE_ROSTER_CONFIGURATION_INVALID',
        'The Google roster clock is invalid.',
      );
    }
    if (
      cachedToken !== undefined &&
      cachedToken.refreshAfterMilliseconds > nowMilliseconds
    ) {
      return cachedToken.value;
    }
    let key: CryptoKey;
    try {
      key = await importPKCS8(configuration.privateKey, 'RS256');
    } catch {
      throw new RosterSyncError(
        'GOOGLE_ROSTER_CONFIGURATION_INVALID',
        'The Google roster signing key is invalid.',
      );
    }
    const issuedAt = Math.floor(nowMilliseconds / 1_000);
    const assertion = await new SignJWT({
      scope: GOOGLE_GROUP_MEMBER_SCOPE,
    })
      .setProtectedHeader({
        alg: 'RS256',
        kid: configuration.privateKeyId,
        typ: 'JWT',
      })
      .setIssuer(configuration.serviceAccountEmail)
      .setAudience(GOOGLE_TOKEN_ENDPOINT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(key);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const parsed = await fetchWithTimeout(
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      async (response, signal) => {
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new RosterSyncError(
            'GOOGLE_TOKEN_REJECTED',
            'Google rejected the Cloud Identity roster credential.',
          );
        }
        return GoogleTokenResponseSchema.safeParse(
          await boundedJson(response, signal),
        );
      },
    );
    if (!parsed.success) {
      throw new RosterSyncError(
        'GOOGLE_TOKEN_RESPONSE_INVALID',
        'Google returned an invalid Cloud Identity token response.',
      );
    }
    cachedToken = Object.freeze({
      value: parsed.data.access_token,
      refreshAfterMilliseconds:
        nowMilliseconds + Math.max(parsed.data.expires_in - 60, 30) * 1_000,
    });
    return cachedToken.value;
  }

  async function resolveConfiguredGroup(
    source: Extract<GroupSource, { kind: 'google-group' }>,
  ): Promise<string> {
    const groupEmail = staffRosterEmail().parse(source.email);
    if (!/^[A-Za-z0-9_-]+$/u.test(source.googleGroupId)) {
      throw new RosterSyncError(
        'GOOGLE_GROUP_SOURCE_INVALID',
        'The configured Google roster group ID is invalid.',
      );
    }
    const sourceIdentity = `${source.googleGroupId}:${groupEmail}`;
    const cached = resolvedGroupNames.get(source.id);
    if (cached !== undefined) {
      if (cached.sourceIdentity !== sourceIdentity) {
        throw new RosterSyncError(
          'GOOGLE_GROUP_SOURCE_CHANGED',
          'A configured Google roster source changed during synchronization.',
        );
      }
      return cached.groupName;
    }

    const lookupUrl = new URL(
      `${GOOGLE_CLOUD_IDENTITY_ENDPOINT}/groups:lookup`,
    );
    lookupUrl.searchParams.set('groupKey.id', groupEmail);
    lookupUrl.searchParams.set('fields', 'name');
    const parsed = await fetchWithTimeout(
      lookupUrl,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          Accept: 'application/json',
        },
      },
      async (response, signal) => {
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new RosterSyncError(
            'GOOGLE_GROUP_LOOKUP_REJECTED',
            'Google rejected a configured roster-group lookup.',
          );
        }
        return GoogleCloudIdentityGroupSchema.safeParse(
          await boundedJson(response, signal),
        );
      },
    );
    if (!parsed.success) {
      throw new RosterSyncError(
        'GOOGLE_GROUP_LOOKUP_INVALID',
        'Google returned an invalid configured roster-group lookup.',
      );
    }
    const expectedName = `groups/${source.googleGroupId}`;
    if (parsed.data.name !== expectedName) {
      throw new RosterSyncError(
        'GOOGLE_GROUP_IDENTITY_MISMATCH',
        'The configured roster-group email and ID did not identify the same Google group.',
      );
    }
    resolvedGroupNames.set(
      source.id,
      Object.freeze({ sourceIdentity, groupName: parsed.data.name }),
    );
    return parsed.data.name;
  }

  return Object.freeze({
    truthLabel: 'configured-unverified' as const,
    async fetchPage(
      source: GroupSource,
      pageToken: string | null,
    ): Promise<RosterGroupPage> {
      if (source.kind !== 'google-group' || source.purpose === 'access') {
        throw new RosterSyncError(
          'GOOGLE_GROUP_SOURCE_INVALID',
          'The Google roster adapter received a non-roster source.',
        );
      }
      const groupEmail = staffRosterEmail().safeParse(source.email);
      if (!groupEmail.success) {
        throw new RosterSyncError(
          'GOOGLE_GROUP_DOMAIN_INVALID',
          'The configured roster group is outside the approved domain.',
        );
      }
      const groupName = await resolveConfiguredGroup(source);
      const url = new URL(
        `${GOOGLE_CLOUD_IDENTITY_ENDPOINT}/${groupName}/memberships:searchTransitiveMemberships`,
      );
      url.searchParams.set('pageSize', '200');
      url.searchParams.set(
        'fields',
        'memberships(member,preferredMemberKey,relationType,roles),nextPageToken',
      );
      if (pageToken !== null) {
        url.searchParams.set('pageToken', pageToken);
      }
      const parsed = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            Accept: 'application/json',
          },
        },
        async (response, signal) => {
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            throw new RosterSyncError(
              'GOOGLE_GROUP_FETCH_REJECTED',
              'Google rejected a roster group read.',
            );
          }
          return GoogleCloudIdentityMembersResponseSchema.safeParse(
            await boundedJson(response, signal),
          );
        },
      );
      if (!parsed.success) {
        throw new RosterSyncError(
          'GOOGLE_GROUP_RESPONSE_INVALID',
          'Google returned invalid roster group data.',
        );
      }
      return RosterGroupPageSchema.parse({
        members: (parsed.data.memberships ?? []).flatMap((member) => {
          if (!member.member.startsWith('users/')) {
            return [];
          }
          const [preferredMemberKey] = member.preferredMemberKey;
          if (preferredMemberKey === undefined) {
            throw new RosterSyncError(
              'GOOGLE_GROUP_RESPONSE_INVALID',
              'Google returned a member without a preferred identity key.',
            );
          }
          return [
            {
              memberKey: preferredMemberKey.id,
              googleSubject: null,
              displayName: 'Staff member',
              email: preferredMemberKey.id,
            },
          ];
        }),
        nextPageToken: parsed.data.nextPageToken ?? null,
      });
    },
  });
}

/** Creates an isolated, network-free adapter for development and CI. */
export function createMockGoogleGroupsAdapter(
  fixtures: Readonly<Record<string, readonly RosterGroupMember[]>>,
  pageSize = 200,
  options: Readonly<{
    runtimeMode?: string;
  }> = {},
): RosterGroupsAdapter {
  const runtimeMode = options.runtimeMode ?? process.env.NODE_ENV;
  if (runtimeMode !== 'development' && runtimeMode !== 'test') {
    throw new RosterSyncError(
      'MOCK_ROSTER_DISABLED',
      'The mock Google Groups adapter requires an explicitly non-production runtime.',
    );
  }
  const parsedPageSize = z.number().int().min(1).max(200).parse(pageSize);
  const isolated = new Map<string, readonly RosterGroupMember[]>();
  for (const [sourceId, members] of Object.entries(fixtures)) {
    UuidSchema.parse(sourceId);
    isolated.set(
      sourceId,
      Object.freeze(
        members.map((member) => RosterGroupMemberSchema.parse(member)),
      ),
    );
  }
  return Object.freeze({
    truthLabel: 'mocked' as const,
    fetchPage(
      source: GroupSource,
      pageToken: string | null,
    ): Promise<RosterGroupPage> {
      const members = isolated.get(source.id);
      if (members === undefined) {
        throw new RosterSyncError(
          'MOCK_GROUP_NOT_FOUND',
          'The requested synthetic roster fixture does not exist.',
        );
      }
      const offset =
        pageToken === null
          ? 0
          : z.coerce.number().int().nonnegative().parse(pageToken);
      if (offset > members.length) {
        throw new RosterSyncError(
          'MOCK_PAGE_TOKEN_INVALID',
          'The synthetic roster fixture page token is invalid.',
        );
      }
      const nextOffset = offset + parsedPageSize;
      return Promise.resolve(
        RosterGroupPageSchema.parse({
          members: members.slice(offset, nextOffset),
          nextPageToken:
            nextOffset < members.length ? String(nextOffset) : null,
        }),
      );
    },
  });
}

/**
 * Reads the staff list an administrator curates inside this application.
 *
 * A manual source names specific people rather than delegating the audience to
 * a directory group, which is what a deployment needs when only some staff are
 * enrolled. Membership is already retained in `group_members`, so this adapter
 * only pages over it; every downstream boundary — snapshot versioning,
 * recipient identity, the device-registration endpoint join, completeness, and
 * retained evidence — is the same code the Google path uses.
 *
 * There is no provider and no credential here, so a fetch cannot fail for an
 * external reason. The adapter still refuses a source that is not an active
 * manual building source rather than silently returning an empty page, because
 * an empty page would publish a complete snapshot that reaches nobody.
 */
export function createManualRosterAdapter(
  database: Database,
  pageSize = 200,
): RosterGroupsAdapter {
  const parsedPageSize = z.number().int().min(1).max(200).parse(pageSize);
  return Object.freeze({
    truthLabel: 'configured-unverified' as const,
    async fetchPage(
      source: GroupSource,
      pageToken: string | null,
    ): Promise<RosterGroupPage> {
      if (source.kind !== 'manual') {
        throw new RosterSyncError(
          'MANUAL_SOURCE_KIND_INVALID',
          'The manual roster adapter only reads manual sources.',
        );
      }
      const offset =
        pageToken === null
          ? 0
          : z.coerce.number().int().nonnegative().parse(pageToken);
      const rows = await database
        .select({ email: groupMembers.email })
        .from(groupMembers)
        .where(eq(groupMembers.groupSourceId, source.id))
        .orderBy(asc(groupMembers.email))
        .limit(parsedPageSize + 1)
        .offset(offset);
      const page = rows.slice(0, parsedPageSize);
      return RosterGroupPageSchema.parse({
        members: page.map(({ email }) => {
          const canonical = email.trim().toLowerCase();
          const localPart = canonical.slice(0, canonical.indexOf('@'));
          return {
            // A manual source has no provider identifier, so the canonical
            // address is the stable key and the only retained identity.
            memberKey: canonical,
            googleSubject: null,
            displayName: localPart.length > 0 ? localPart : canonical,
            email: canonical,
          };
        }),
        nextPageToken:
          rows.length > parsedPageSize ? String(offset + parsedPageSize) : null,
      });
    },
  });
}

/**
 * Routes each source to the adapter that owns its kind.
 *
 * One roster source configuration may mix a directory-backed building group
 * with a manually curated one, so the sync cannot assume a single provider.
 * Dispatching on the retained `kind` keeps that decision with the source
 * record rather than with deployment configuration, and refuses a kind no
 * adapter claims instead of silently returning no members.
 *
 * The composite reports the weaker of its adapters' truth labels: a roster
 * that draws on an unverified provider is not more trustworthy than that
 * provider.
 */
export function createRoutingRosterAdapter(
  adapters: Readonly<Partial<Record<GroupSourceKind, RosterGroupsAdapter>>>,
): RosterGroupsAdapter {
  const claimed = Object.values(adapters).filter(
    (adapter): adapter is RosterGroupsAdapter => adapter !== undefined,
  );
  if (claimed.length === 0) {
    throw new RosterSyncError(
      'ROSTER_ADAPTER_MISSING',
      'A routing roster adapter needs at least one source adapter.',
    );
  }
  return Object.freeze({
    truthLabel: claimed.some((adapter) => adapter.truthLabel === 'mocked')
      ? ('mocked' as const)
      : ('configured-unverified' as const),
    fetchPage(
      source: GroupSource,
      pageToken: string | null,
    ): Promise<RosterGroupPage> {
      const adapter = adapters[source.kind];
      if (adapter === undefined) {
        return Promise.reject(
          new RosterSyncError(
            'ROSTER_ADAPTER_MISSING',
            'No roster adapter is configured for this source kind.',
          ),
        );
      }
      return adapter.fetchPage(source, pageToken);
    },
  });
}

/** Safe structured-log alert; CloudWatch alarm wiring remains issue #29. */
export function createStructuredRosterSyncAlertSink(
  write: (value: string) => void = console.error,
): RosterSyncAlertSink {
  return Object.freeze({
    notify(alert: RosterSyncAlert): void {
      write(
        JSON.stringify({
          event: 'roster-sync-alert',
          sourceConfiguration: alert.sourceConfiguration,
          population: alert.population,
          syncResultId: alert.syncResultId,
          outcome: alert.outcome,
          errorCodes: alert.errorCodes,
          occurredAt: alert.occurredAt,
        }),
      );
    },
  });
}

interface ConfigurationHeaderRow {
  readonly id: string;
  readonly version: number;
  readonly population: RosterPopulation;
  readonly createdAt: Date;
}

interface ConfiguredSourceRow {
  readonly id: string;
  readonly kind: GroupSourceKind;
  readonly purpose: 'access' | 'building' | 'others';
  readonly facilityId: string | null;
  readonly displayName: string;
  readonly active: boolean;
  readonly grantedRole: 'staff' | 'admin' | null;
  readonly membersCapturedAt: Date | null;
  readonly googleGroupId: string | null;
  readonly email: string | null;
  readonly fixtureKey: string | null;
  readonly createdAt: Date;
}

function parseConfiguredSource(row: ConfiguredSourceRow): GroupSource {
  const common = {
    id: row.id,
    kind: row.kind,
    purpose: row.purpose,
    facilityId: row.facilityId,
    displayName: row.displayName,
    active: row.active,
    // Access sources carry the role they grant; roster purposes never do.
    grantedRole: row.grantedRole,
    membersCapturedAt: row.membersCapturedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
  return GroupSourceSchema.parse(
    row.kind === 'google-group'
      ? {
          ...common,
          googleGroupId: row.googleGroupId,
          email: row.email,
        }
      : { ...common, fixtureKey: row.fixtureKey },
  );
}

/** Hashes roster configuration while excluding volatile membership-read evidence. */
export function rosterSourceConfigurationRevisionDigest(
  configuration: RosterSourceConfiguration,
  sources: readonly GroupSource[],
): string {
  const configurationSources = sources.map((source) => {
    const { membersCapturedAt, ...configuredSource } = source;
    void membersCapturedAt;
    return configuredSource;
  });
  return digest({ configuration, sources: configurationSources });
}

function assembleLoadedConfiguration(
  header: ConfigurationHeaderRow | undefined,
  facilityIds: readonly string[],
  sourceRows: readonly ConfiguredSourceRow[],
): LoadedRosterSourceConfiguration | null {
  if (header === undefined) {
    return null;
  }
  const sources = Object.freeze(
    sourceRows
      .map(parseConfiguredSource)
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  const configuration = RosterSourceConfigurationSchema.parse({
    id: header.id,
    version: header.version,
    population: header.population,
    facilityIds: [...facilityIds].sort(),
    groupSourceRefs: sources.map(sourceRef),
    createdAt: header.createdAt.toISOString(),
  });
  return Object.freeze({
    configuration,
    sources,
    // Membership reads are liveness evidence, not source configuration. A
    // scheduled read may update this stamp while a roster sync is in flight.
    revisionDigest: rosterSourceConfigurationRevisionDigest(
      configuration,
      sources,
    ),
  });
}

function syncResultReference(id: string): string {
  return `roster-sync-result:${UuidSchema.parse(id)}`;
}

function syncResultIdFromReference(reference: string | null): string {
  const match = /^roster-sync-result:([0-9a-f-]{36})$/u.exec(reference ?? '');
  if (match?.[1] === undefined) {
    throw new RosterSyncError(
      'IDEMPOTENCY_RESULT_INVALID',
      'The roster-sync replay result reference is invalid.',
    );
  }
  return UuidSchema.parse(match[1]);
}

async function loadPersistedSyncResult(
  database: Database,
  id: string,
): Promise<RosterSyncResult> {
  const [row] = await database
    .select()
    .from(rosterSyncResults)
    .where(eq(rosterSyncResults.id, UuidSchema.parse(id)))
    .limit(1);
  if (row === undefined) {
    throw new RosterSyncError(
      'IDEMPOTENCY_RESULT_MISSING',
      'The roster-sync replay result is unavailable.',
    );
  }
  const sourceRows = await database
    .select({
      setKind: rosterSyncResultSources.setKind,
      id: rosterSyncResultSources.groupSourceId,
      kind: rosterSyncResultSources.groupSourceKind,
      purpose: rosterSyncResultSources.groupPurpose,
      facilityId: groupSources.facilityId,
    })
    .from(rosterSyncResultSources)
    .innerJoin(
      groupSources,
      eq(rosterSyncResultSources.groupSourceId, groupSources.id),
    )
    .where(eq(rosterSyncResultSources.syncResultId, row.id));
  const failureRows = await database
    .select({
      id: rosterSyncGroupFailures.groupSourceId,
      kind: rosterSyncGroupFailures.groupSourceKind,
      purpose: rosterSyncGroupFailures.groupPurpose,
      facilityId: groupSources.facilityId,
      errorCode: rosterSyncGroupFailures.errorCode,
      attemptedAt: rosterSyncGroupFailures.attemptedAt,
    })
    .from(rosterSyncGroupFailures)
    .innerJoin(
      groupSources,
      eq(rosterSyncGroupFailures.groupSourceId, groupSources.id),
    )
    .where(eq(rosterSyncGroupFailures.syncResultId, row.id));
  const references = sourceRows.map((source) =>
    RosterGroupSourceRefSchema.parse({
      id: source.id,
      kind: source.kind,
      purpose: source.purpose,
      facilityId: source.facilityId,
    }),
  );
  return RosterSyncResultSchema.parse({
    id: row.id,
    sourceConfiguration: {
      id: row.sourceConfigurationId,
      version: row.sourceConfigurationVersion,
    },
    population: row.population,
    outcome: row.outcome,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    expectedSourceGroupRefs: references.filter(
      (_, index) => sourceRows[index]?.setKind === 'expected',
    ),
    completedSourceGroupRefs: references.filter(
      (_, index) => sourceRows[index]?.setKind === 'completed',
    ),
    publishedSnapshotId: row.publishedSnapshotId,
    groupFailures: failureRows.map((failure) => ({
      groupSourceRef: {
        id: failure.id,
        kind: failure.kind,
        purpose: failure.purpose,
        facilityId: failure.facilityId,
      },
      errorCode: failure.errorCode,
      attemptedAt: failure.attemptedAt.toISOString(),
    })),
  });
}

function resultSourceRows(
  syncResultId: string,
  population: RosterPopulation,
  references: readonly RosterGroupSourceRef[],
  setKind: GroupCompletionKind,
) {
  return references.map((reference) => ({
    syncResultId,
    population,
    groupSourceId: reference.id,
    groupSourceKind: reference.kind,
    groupPurpose: reference.purpose,
    setKind,
    expectedSetKind: 'expected' as const,
  }));
}

function snapshotSourceRows(
  rosterSnapshotId: string,
  population: RosterPopulation,
  references: readonly RosterGroupSourceRef[],
  completionKind: GroupCompletionKind,
) {
  return references.map((reference) => ({
    rosterSnapshotId,
    population,
    groupSourceId: reference.id,
    groupSourceKind: reference.kind,
    groupPurpose: reference.purpose,
    completionKind,
  }));
}

function endpointInsertValue(
  snapshotId: string,
  recipient: Recipient,
  endpoint: Recipient['endpoints'][number],
): typeof rosterEndpoints.$inferInsert {
  const common = {
    id: endpoint.id,
    rosterSnapshotId: snapshotId,
    recipientId: recipient.id,
    population: recipient.population,
    channel: endpoint.channel,
    status: endpoint.status,
    capturedAt: new Date(endpoint.capturedAt),
  };
  switch (endpoint.channel) {
    case 'push':
      return {
        ...common,
        platform: endpoint.platform,
        provider: endpoint.provider,
        serviceEnvironment: endpoint.serviceEnvironment,
        token: endpoint.token,
        email: null,
        phoneNumber: null,
      };
    case 'email':
      return {
        ...common,
        platform: null,
        provider: null,
        serviceEnvironment: null,
        token: null,
        email: endpoint.email,
        phoneNumber: null,
      };
    case 'sms':
      return {
        ...common,
        platform: null,
        provider: null,
        serviceEnvironment: null,
        token: null,
        email: null,
        phoneNumber: endpoint.phoneNumber,
      };
  }
}

/** Production Drizzle persistence adapter with atomic snapshot publication. */
export function createDrizzleRosterSyncStore(
  database: Database,
  pushProviderCutover: PushProviderCutover | null = parsePushProviderCutover(
    process.env[PUSH_PROVIDER_CUTOVER_ENV],
  ),
): RosterSyncStore {
  async function loadConfiguration(
    reference: RosterSourceConfigurationRef,
  ): Promise<LoadedRosterSourceConfiguration | null> {
    const [header] = await database
      .select()
      .from(rosterSourceConfigurations)
      .where(
        and(
          eq(rosterSourceConfigurations.id, reference.id),
          eq(rosterSourceConfigurations.version, reference.version),
        ),
      )
      .limit(1);
    if (header === undefined) {
      return null;
    }
    const facilityRows = await database
      .select({ facilityId: rosterSourceConfigurationFacilities.facilityId })
      .from(rosterSourceConfigurationFacilities)
      .where(
        and(
          eq(rosterSourceConfigurationFacilities.configurationId, reference.id),
          eq(
            rosterSourceConfigurationFacilities.configurationVersion,
            reference.version,
          ),
        ),
      );
    const sourceRows = await database
      .select({
        id: groupSources.id,
        kind: groupSources.kind,
        purpose: groupSources.purpose,
        facilityId: groupSources.facilityId,
        displayName: groupSources.displayName,
        active: groupSources.active,
        grantedRole: groupSources.grantedRole,
        membersCapturedAt: groupSources.membersCapturedAt,
        googleGroupId: groupSources.googleGroupId,
        email: groupSources.email,
        fixtureKey: groupSources.fixtureKey,
        createdAt: groupSources.createdAt,
      })
      .from(rosterSourceConfigurationGroups)
      .innerJoin(
        groupSources,
        eq(rosterSourceConfigurationGroups.groupSourceId, groupSources.id),
      )
      .where(
        and(
          eq(rosterSourceConfigurationGroups.configurationId, reference.id),
          eq(
            rosterSourceConfigurationGroups.configurationVersion,
            reference.version,
          ),
        ),
      );
    return assembleLoadedConfiguration(
      header,
      facilityRows.map((row) => row.facilityId),
      sourceRows,
    );
  }

  async function completeReservation(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    reservationId: string,
    resultId: string,
    completedAt: Date,
  ): Promise<void> {
    const updated = await transaction
      .update(idempotencyRecords)
      .set({
        status: 'completed',
        completedAt,
        resultReference: syncResultReference(resultId),
      })
      .where(
        and(
          eq(idempotencyRecords.id, reservationId),
          eq(idempotencyRecords.status, 'in-progress'),
        ),
      )
      .returning();
    if (updated.length !== 1) {
      throw new RosterSyncError(
        'IDEMPOTENCY_RESERVATION_LOST',
        'The roster-sync idempotency reservation was unavailable.',
      );
    }
  }

  async function assertPushEndpointCaptureIsCurrent(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    recipients: readonly Recipient[],
  ): Promise<void> {
    const expected = new Map<
      string,
      Readonly<{
        googleSubject: string;
        platform: 'ios' | 'android';
        provider: 'expo' | 'apns' | 'fcm';
        serviceEnvironment: 'development' | 'production';
        token: string;
      }>
    >();
    for (const recipient of recipients) {
      for (const endpoint of recipient.endpoints) {
        if (endpoint.channel !== 'push') {
          continue;
        }
        if (recipient.googleSubject === null) {
          throw new RosterSyncError(
            'LOCAL_CONTACT_CAPTURE_INVALID',
            'A push endpoint lacked staff identity provenance.',
          );
        }
        expected.set(
          endpoint.id,
          Object.freeze({
            googleSubject: recipient.googleSubject,
            platform: endpoint.platform,
            provider: endpoint.provider,
            serviceEnvironment: endpoint.serviceEnvironment,
            token: endpoint.token,
          }),
        );
      }
    }
    if (expected.size === 0) {
      return;
    }

    const registrationIds = [...expected.keys()].sort();
    const discoveredRegistrations = new Map<
      string,
      Readonly<{ deviceEnrollmentId: string; userId: string }>
    >();
    for (let offset = 0; offset < registrationIds.length; offset += 500) {
      const batch = registrationIds.slice(offset, offset + 500);
      const rows = await transaction
        .select({
          id: devicePushTokenRegistrations.id,
          deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
          userId: deviceEnrollments.userId,
        })
        .from(devicePushTokenRegistrations)
        .innerJoin(
          deviceEnrollments,
          eq(
            devicePushTokenRegistrations.deviceEnrollmentId,
            deviceEnrollments.id,
          ),
        )
        .where(inArray(devicePushTokenRegistrations.id, batch))
        .orderBy(asc(devicePushTokenRegistrations.id));
      rows.forEach((row) =>
        discoveredRegistrations.set(
          row.id,
          Object.freeze({
            deviceEnrollmentId: row.deviceEnrollmentId,
            userId: row.userId,
          }),
        ),
      );
    }
    if (discoveredRegistrations.size !== expected.size) {
      throw new RosterSyncError(
        'LOCAL_CONTACT_CAPTURE_CHANGED',
        'Local endpoint status changed during roster synchronization.',
      );
    }

    const userIds = [
      ...new Set(
        [...discoveredRegistrations.values()].map((row) => row.userId),
      ),
    ].sort();
    const googleSubjects = new Map<string, string>();
    for (let offset = 0; offset < userIds.length; offset += 500) {
      const batch = userIds.slice(offset, offset + 500);
      const rows = await transaction
        .select({ id: users.id, googleSubject: users.googleSubject })
        .from(users)
        .where(inArray(users.id, batch))
        .orderBy(asc(users.id))
        .for('share');
      rows.forEach((row) => googleSubjects.set(row.id, row.googleSubject));
    }

    const enrollmentIds = [
      ...new Set(
        [...discoveredRegistrations.values()].map(
          (row) => row.deviceEnrollmentId,
        ),
      ),
    ].sort();
    const lockedEnrollments = new Map<
      string,
      Readonly<{
        userId: string;
        revokedAt: Date | null;
      }>
    >();
    for (let offset = 0; offset < enrollmentIds.length; offset += 500) {
      const batch = enrollmentIds.slice(offset, offset + 500);
      const rows = await transaction
        .select({
          id: deviceEnrollments.id,
          userId: deviceEnrollments.userId,
          revokedAt: deviceEnrollments.revokedAt,
        })
        .from(deviceEnrollments)
        .where(inArray(deviceEnrollments.id, batch))
        .orderBy(asc(deviceEnrollments.id))
        .for('share');
      rows.forEach((row) =>
        lockedEnrollments.set(
          row.id,
          Object.freeze({ userId: row.userId, revokedAt: row.revokedAt }),
        ),
      );
    }

    const lockedRegistrations = new Map<
      string,
      Readonly<{
        deviceEnrollmentId: string;
        platform: 'ios' | 'android' | 'web';
        provider: string;
        serviceEnvironment: string;
        token: string;
      }>
    >();
    for (let offset = 0; offset < registrationIds.length; offset += 500) {
      const batch = registrationIds.slice(offset, offset + 500);
      const rows = await transaction
        .select({
          id: devicePushTokenRegistrations.id,
          deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
          platform: devicePushTokenRegistrations.platform,
          provider: devicePushTokenRegistrations.provider,
          serviceEnvironment: devicePushTokenRegistrations.serviceEnvironment,
          token: devicePushTokenRegistrations.token,
        })
        .from(devicePushTokenRegistrations)
        .where(inArray(devicePushTokenRegistrations.id, batch))
        .orderBy(asc(devicePushTokenRegistrations.id))
        .for('update');
      rows.forEach((row) =>
        lockedRegistrations.set(
          row.id,
          Object.freeze({
            deviceEnrollmentId: row.deviceEnrollmentId,
            platform: row.platform,
            provider: row.provider,
            serviceEnvironment: row.serviceEnvironment,
            token: row.token,
          }),
        ),
      );
    }

    const unregisteredIds = new Set<string>();
    for (let offset = 0; offset < registrationIds.length; offset += 500) {
      const batch = registrationIds.slice(offset, offset + 500);
      const rows = await transaction
        .select({
          registrationId: devicePushTokenUnregistrations.registrationId,
        })
        .from(devicePushTokenUnregistrations)
        .where(inArray(devicePushTokenUnregistrations.registrationId, batch));
      rows.forEach((row) => unregisteredIds.add(row.registrationId));
    }

    const captureChanged =
      lockedRegistrations.size !== expected.size ||
      lockedEnrollments.size !== enrollmentIds.length ||
      googleSubjects.size !== userIds.length ||
      [...expected].some(([id, endpoint]) => {
        const discoveredRegistration = discoveredRegistrations.get(id);
        const registration = lockedRegistrations.get(id);
        const enrollment =
          registration === undefined
            ? undefined
            : lockedEnrollments.get(registration.deviceEnrollmentId);
        return (
          discoveredRegistration === undefined ||
          registration === undefined ||
          registration.deviceEnrollmentId !==
            discoveredRegistration.deviceEnrollmentId ||
          enrollment === undefined ||
          enrollment.userId !== discoveredRegistration.userId ||
          enrollment.revokedAt !== null ||
          googleSubjects.get(enrollment.userId) !== endpoint.googleSubject ||
          registration.platform !== endpoint.platform ||
          registration.provider !== endpoint.provider ||
          registration.serviceEnvironment !== endpoint.serviceEnvironment ||
          registration.token !== endpoint.token ||
          unregisteredIds.has(id)
        );
      });
    if (captureChanged) {
      throw new RosterSyncError(
        'LOCAL_CONTACT_CAPTURE_CHANGED',
        'Local endpoint status changed during roster synchronization.',
      );
    }
  }

  return Object.freeze({
    async reserve(
      request: RosterSyncReservationRequest,
    ): Promise<RosterSyncReservation> {
      const key = IdempotencyKeySchema.parse(request.idempotencyKey);
      const principal = ActorSchema.parse(request.principal);
      const requestDigest = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(request.requestDigest);
      const principalDigest = digest(principal);
      const startedAtDate = new Date(TimestampSchema.parse(request.startedAt));
      const [created] = await database
        .insert(idempotencyRecords)
        .values({
          key,
          capabilityId: 'sync-roster',
          principal,
          principalDigest,
          requestDigest,
          status: 'in-progress',
          createdAt: startedAtDate,
        })
        .onConflictDoNothing({
          target: [
            idempotencyRecords.capabilityId,
            idempotencyRecords.principalDigest,
            idempotencyRecords.key,
          ],
        })
        .returning();
      if (created !== undefined) {
        return Object.freeze({ kind: 'reserved' as const, id: created.id });
      }
      let [existing] = await database
        .select()
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'sync-roster'),
            eq(idempotencyRecords.principalDigest, principalDigest),
            eq(idempotencyRecords.key, key),
          ),
        )
        .limit(1);
      if (existing === undefined || existing.requestDigest !== requestDigest) {
        throw new RosterSyncError(
          'IDEMPOTENCY_CONFLICT',
          'The roster-sync idempotency key was reused for another request.',
        );
      }
      if (
        existing.status === 'in-progress' &&
        startedAtDate.getTime() - existing.createdAt.getTime() >=
          IDEMPOTENCY_IN_PROGRESS_MAX_AGE_MILLISECONDS
      ) {
        await database
          .update(idempotencyRecords)
          .set({
            status: 'failed',
            completedAt: startedAtDate,
            resultReference: 'error:ROSTER_SYNC_ABANDONED',
          })
          .where(
            and(
              eq(idempotencyRecords.id, existing.id),
              eq(idempotencyRecords.status, 'in-progress'),
            ),
          );
        [existing] = await database
          .select()
          .from(idempotencyRecords)
          .where(eq(idempotencyRecords.id, existing.id))
          .limit(1);
        if (existing === undefined) {
          throw new RosterSyncError(
            'IDEMPOTENCY_CONFLICT',
            'The roster-sync idempotency reservation disappeared.',
          );
        }
      }
      if (existing.status === 'in-progress') {
        throw new RosterSyncError(
          'ROSTER_SYNC_IN_PROGRESS',
          'The roster sync is already in progress.',
        );
      }
      if (existing.status === 'failed') {
        throw new RosterSyncError(
          'ROSTER_SYNC_REPLAY_FAILED',
          'The prior roster-sync execution failed safely.',
        );
      }
      return Object.freeze({
        kind: 'replay' as const,
        result: await loadPersistedSyncResult(
          database,
          syncResultIdFromReference(existing.resultReference),
        ),
      });
    },

    loadSourceConfiguration: loadConfiguration,

    async loadLocalContacts(
      identityKeys: readonly string[],
    ): Promise<readonly RosterLocalContact[]> {
      if (pushProviderCutover === null) {
        throw new RosterSyncError(
          'LOCAL_CONTACT_CAPTURE_INVALID',
          'Roster publication requires an exact push-provider cutover.',
        );
      }
      if (identityKeys.length === 0) {
        return Object.freeze([]);
      }
      const uniqueIdentityKeys = Object.freeze(
        [
          ...new Set(
            identityKeys.map((identityKey) => {
              if (identityKey.includes('@')) {
                const parsed = staffRosterEmail().safeParse(identityKey);
                if (!parsed.success) {
                  throw new RosterSyncError(
                    'LOCAL_CONTACT_IDENTITY_INVALID',
                    'A local contact lookup key was not an approved staff identity.',
                  );
                }
                return parsed.data;
              }
              return z.string().trim().min(1).max(255).parse(identityKey);
            }),
          ),
        ].sort(),
      );
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`set transaction isolation level repeatable read, read only`,
        );
        const contactMap = new Map<
          string,
          {
            googleSubject: string;
            staffEmail: string;
            displayName: string;
            pushEndpoints: RosterLocalPushEndpoint[];
          }
        >();
        for (
          let offset = 0;
          offset < uniqueIdentityKeys.length;
          offset += 500
        ) {
          const identityBatch = uniqueIdentityKeys.slice(offset, offset + 500);
          const staffEmailBatch = identityBatch.filter((identityKey) =>
            identityKey.includes('@'),
          );
          const subjectBatch = identityBatch.filter(
            (identityKey) => !identityKey.includes('@'),
          );
          const identityPredicate =
            staffEmailBatch.length > 0 && subjectBatch.length > 0
              ? or(
                  inArray(users.googleSubject, subjectBatch),
                  inArray(sql<string>`lower(${users.email})`, staffEmailBatch),
                )
              : staffEmailBatch.length > 0
                ? inArray(sql<string>`lower(${users.email})`, staffEmailBatch)
                : inArray(users.googleSubject, subjectBatch);
          const userRows = await transaction
            .select({
              googleSubject: users.googleSubject,
              staffEmail: users.email,
              displayName: users.displayName,
            })
            .from(users)
            .where(and(identityPredicate, isNull(users.disabledAt)));
          for (const row of userRows) {
            const staffEmail = staffRosterEmail().parse(row.staffEmail);
            const existing = contactMap.get(row.googleSubject);
            if (
              existing !== undefined &&
              (existing.staffEmail !== staffEmail ||
                existing.displayName !== row.displayName)
            ) {
              throw new RosterSyncError(
                'LOCAL_CONTACT_IDENTITY_CONFLICT',
                'Local identity keys resolved to conflicting staff records.',
              );
            }
            contactMap.set(row.googleSubject, {
              googleSubject: row.googleSubject,
              staffEmail,
              displayName: row.displayName,
              pushEndpoints: [],
            });
          }
          const pushRows = await transaction
            .select({
              id: devicePushTokenRegistrations.id,
              deviceEnrollmentId:
                devicePushTokenRegistrations.deviceEnrollmentId,
              googleSubject: users.googleSubject,
              platform: devicePushTokenRegistrations.platform,
              provider: devicePushTokenRegistrations.provider,
              serviceEnvironment:
                devicePushTokenRegistrations.serviceEnvironment,
              token: devicePushTokenRegistrations.token,
            })
            .from(devicePushTokenRegistrations)
            .innerJoin(
              deviceEnrollments,
              eq(
                devicePushTokenRegistrations.deviceEnrollmentId,
                deviceEnrollments.id,
              ),
            )
            .innerJoin(users, eq(deviceEnrollments.userId, users.id))
            .leftJoin(
              devicePushTokenUnregistrations,
              eq(
                devicePushTokenUnregistrations.registrationId,
                devicePushTokenRegistrations.id,
              ),
            )
            .where(
              and(
                identityPredicate,
                isNull(deviceEnrollments.revokedAt),
                isNull(devicePushTokenUnregistrations.id),
                isNull(users.disabledAt),
              ),
            );
          const registrationsByDevicePlatform = new Map<
            string,
            typeof pushRows
          >();
          for (const row of pushRows) {
            const contact = contactMap.get(row.googleSubject);
            if (contact !== undefined && row.platform !== 'web') {
              const selectionKey = `${row.deviceEnrollmentId}:${row.platform}`;
              const registrations =
                registrationsByDevicePlatform.get(selectionKey) ?? [];
              registrationsByDevicePlatform.set(selectionKey, [
                ...registrations,
                row,
              ]);
            }
          }
          for (const registrations of registrationsByDevicePlatform.values()) {
            const first = registrations[0];
            if (first === undefined || first.platform === 'web') continue;
            if (pushProviderCutover === null) {
              throw new RosterSyncError(
                'LOCAL_CONTACT_CAPTURE_INVALID',
                'Push registrations require an exact provider cutover.',
              );
            }
            const platform = first.platform;
            const selectedProvider = selectedPushProvider(
              pushProviderCutover,
              platform,
            );
            const selected = registrations.filter(
              (registration) => registration.provider === selectedProvider,
            );
            if (selected.length > 1) {
              throw new RosterSyncError(
                'LOCAL_CONTACT_CAPTURE_INVALID',
                'A device had ambiguous active push-provider registrations.',
              );
            }
            if (selected.length === 0) {
              throw new RosterSyncError(
                'DIRECT_PUSH_COVERAGE_INCOMPLETE',
                'Push-provider cutover requires complete paired endpoint coverage.',
              );
            }
            const row = selected[0];
            if (row !== undefined) {
              const contact = contactMap.get(row.googleSubject);
              if (contact === undefined) continue;
              if (
                contact.pushEndpoints.some((endpoint) => endpoint.id === row.id)
              ) {
                throw new RosterSyncError(
                  'LOCAL_CONTACT_CAPTURE_INVALID',
                  'A device had ambiguous active push-provider registrations.',
                );
              }
              contact.pushEndpoints.push({
                id: row.id,
                platform,
                provider: z.enum(['expo', 'apns', 'fcm']).parse(row.provider),
                serviceEnvironment: z
                  .enum(['development', 'production'])
                  .parse(row.serviceEnvironment),
                token: row.token,
              });
            }
          }
        }
        return Object.freeze(
          [...contactMap.values()]
            .sort((left, right) =>
              left.staffEmail.localeCompare(right.staffEmail),
            )
            .map((contact) =>
              Object.freeze({
                ...contact,
                pushEndpoints: Object.freeze(
                  contact.pushEndpoints.sort((left, right) =>
                    left.id.localeCompare(right.id),
                  ),
                ),
              }),
            ),
        );
      });
    },

    async loadLatestCompleteBaseline(
      rawPopulation: RosterPopulation,
    ): Promise<RosterSyncBaseline | null> {
      const population = RosterPopulationSchema.parse(rawPopulation);
      const [latestSnapshot] = await database
        .select({
          id: rosterSnapshots.id,
          version: rosterSnapshots.version,
          population: rosterSnapshots.population,
          sourceConfigurationId: rosterSnapshots.sourceConfigurationId,
          sourceConfigurationVersion:
            rosterSnapshots.sourceConfigurationVersion,
        })
        .from(rosterSnapshots)
        .where(eq(rosterSnapshots.population, population))
        .orderBy(desc(rosterSnapshots.version))
        .limit(1);
      if (latestSnapshot === undefined) {
        return null;
      }
      const [sourceRows, countRows] = await Promise.all([
        database
          .select({ groupSourceId: rosterSnapshotSources.groupSourceId })
          .from(rosterSnapshotSources)
          .where(
            and(
              eq(rosterSnapshotSources.rosterSnapshotId, latestSnapshot.id),
              eq(rosterSnapshotSources.completionKind, 'completed'),
            ),
          ),
        database
          .select({
            groupSourceId: rosterRecipientGroupSources.groupSourceId,
            memberCount: sql<number>`count(*)::integer`,
          })
          .from(rosterRecipientGroupSources)
          .where(
            eq(rosterRecipientGroupSources.rosterSnapshotId, latestSnapshot.id),
          )
          .groupBy(rosterRecipientGroupSources.groupSourceId),
      ]);
      const counts = new Map(
        countRows.map((row) => [row.groupSourceId, row.memberCount]),
      );
      return RosterSyncBaselineSchema.parse({
        snapshotId: latestSnapshot.id,
        version: latestSnapshot.version,
        population: latestSnapshot.population,
        sourceConfiguration: {
          id: latestSnapshot.sourceConfigurationId,
          version: latestSnapshot.sourceConfigurationVersion,
        },
        groupMemberCounts: sourceRows
          .map((row) => ({
            groupSourceId: row.groupSourceId,
            memberCount: counts.get(row.groupSourceId) ?? 0,
          }))
          .sort((left, right) =>
            left.groupSourceId.localeCompare(right.groupSourceId),
          ),
      });
    },

    async publishComplete(
      request: CompleteRosterSyncPersistenceRequest,
    ): Promise<RosterSyncResult> {
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`set transaction isolation level read committed`,
        );
        const population = request.loadedConfiguration.configuration.population;
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`psd-eoc-roster-${population}`}, 0))`,
        );

        const reference = {
          id: request.loadedConfiguration.configuration.id,
          version: request.loadedConfiguration.configuration.version,
        };
        const [header] = await transaction
          .select()
          .from(rosterSourceConfigurations)
          .where(
            and(
              eq(rosterSourceConfigurations.id, reference.id),
              eq(rosterSourceConfigurations.version, reference.version),
            ),
          )
          .limit(1);
        const facilityRows = await transaction
          .select({
            facilityId: rosterSourceConfigurationFacilities.facilityId,
          })
          .from(rosterSourceConfigurationFacilities)
          .where(
            and(
              eq(
                rosterSourceConfigurationFacilities.configurationId,
                reference.id,
              ),
              eq(
                rosterSourceConfigurationFacilities.configurationVersion,
                reference.version,
              ),
            ),
          )
          .for('share');
        const sourceRows = await transaction
          .select({
            id: groupSources.id,
            kind: groupSources.kind,
            purpose: groupSources.purpose,
            facilityId: groupSources.facilityId,
            displayName: groupSources.displayName,
            active: groupSources.active,
            grantedRole: groupSources.grantedRole,
            membersCapturedAt: groupSources.membersCapturedAt,
            googleGroupId: groupSources.googleGroupId,
            email: groupSources.email,
            fixtureKey: groupSources.fixtureKey,
            createdAt: groupSources.createdAt,
          })
          .from(rosterSourceConfigurationGroups)
          .innerJoin(
            groupSources,
            eq(rosterSourceConfigurationGroups.groupSourceId, groupSources.id),
          )
          .where(
            and(
              eq(rosterSourceConfigurationGroups.configurationId, reference.id),
              eq(
                rosterSourceConfigurationGroups.configurationVersion,
                reference.version,
              ),
            ),
          )
          .for('share');
        const currentConfiguration = assembleLoadedConfiguration(
          header,
          facilityRows.map((row) => row.facilityId),
          sourceRows,
        );
        if (
          currentConfiguration === null ||
          currentConfiguration.revisionDigest !==
            request.loadedConfiguration.revisionDigest
        ) {
          throw new RosterSyncError(
            'SOURCE_CONFIGURATION_CHANGED',
            'Roster source configuration changed during synchronization.',
          );
        }

        await assertPushEndpointCaptureIsCurrent(
          transaction,
          request.recipients,
        );

        const [latestSnapshot] = await transaction
          .select({
            id: rosterSnapshots.id,
            version: rosterSnapshots.version,
            sourceConfigurationId: rosterSnapshots.sourceConfigurationId,
            sourceConfigurationVersion:
              rosterSnapshots.sourceConfigurationVersion,
          })
          .from(rosterSnapshots)
          .where(eq(rosterSnapshots.population, population))
          .orderBy(desc(rosterSnapshots.version))
          .limit(1);
        assertSourceConfigurationIsMonotonic(
          reference,
          latestSnapshot === undefined
            ? null
            : {
                id: latestSnapshot.sourceConfigurationId,
                version: latestSnapshot.sourceConfigurationVersion,
              },
        );
        if (
          (latestSnapshot?.id ?? null) !== request.observedBaselineSnapshotId
        ) {
          throw new RosterSyncError(
            'ROSTER_BASELINE_CHANGED',
            'A newer roster snapshot was published during synchronization.',
          );
        }
        const version = (latestSnapshot?.version ?? 0) + 1;
        const snapshotId = randomUUID();
        const snapshot = RosterSnapshotSchema.parse({
          id: snapshotId,
          version,
          population,
          complete: true,
          sourceConfiguration: reference,
          facilityIds: currentConfiguration.configuration.facilityIds,
          expectedSourceGroupRefs:
            currentConfiguration.configuration.groupSourceRefs,
          sourceGroupRefs: currentConfiguration.configuration.groupSourceRefs,
          recipients: request.recipients,
          syncStartedAt: request.startedAt,
          capturedAt: request.capturedAt,
        });
        await transaction.insert(rosterSnapshots).values({
          id: snapshot.id,
          version: snapshot.version,
          population: snapshot.population,
          complete: true,
          sourceConfigurationId: snapshot.sourceConfiguration.id,
          sourceConfigurationVersion: snapshot.sourceConfiguration.version,
          syncStartedAt: new Date(snapshot.syncStartedAt),
          capturedAt: new Date(snapshot.capturedAt),
        });
        await transaction.insert(rosterSnapshotFacilities).values(
          snapshot.facilityIds.map((facilityId) => ({
            rosterSnapshotId: snapshot.id,
            facilityId,
          })),
        );
        await transaction
          .insert(rosterSnapshotSources)
          .values([
            ...snapshotSourceRows(
              snapshot.id,
              population,
              snapshot.expectedSourceGroupRefs,
              'expected',
            ),
            ...snapshotSourceRows(
              snapshot.id,
              population,
              snapshot.sourceGroupRefs,
              'completed',
            ),
          ]);
        for (
          let offset = 0;
          offset < snapshot.recipients.length;
          offset += 200
        ) {
          const batch = snapshot.recipients.slice(offset, offset + 200);
          await transaction.insert(rosterRecipients).values(
            batch.map((recipient) => ({
              id: recipient.id,
              rosterSnapshotId: snapshot.id,
              population: recipient.population,
              googleSubject: recipient.googleSubject,
              staffEmail: recipient.staffEmail,
              displayName: recipient.displayName,
            })),
          );
        }
        const provenanceRows = snapshot.recipients.flatMap((recipient) =>
          recipient.groupSourceRefs.map((groupSource) => ({
            rosterSnapshotId: snapshot.id,
            recipientId: recipient.id,
            population: recipient.population,
            groupSourceId: groupSource.id,
            groupSourceKind: groupSource.kind,
            groupPurpose: groupSource.purpose,
          })),
        );
        for (let offset = 0; offset < provenanceRows.length; offset += 500) {
          await transaction
            .insert(rosterRecipientGroupSources)
            .values(provenanceRows.slice(offset, offset + 500));
        }
        const endpointRows = snapshot.recipients.flatMap((recipient) =>
          recipient.endpoints.map((endpoint) =>
            endpointInsertValue(snapshot.id, recipient, endpoint),
          ),
        );
        for (let offset = 0; offset < endpointRows.length; offset += 500) {
          await transaction
            .insert(rosterEndpoints)
            .values(endpointRows.slice(offset, offset + 500));
        }

        const completedAt = new Date(snapshot.capturedAt);
        const result = RosterSyncResultSchema.parse({
          id: randomUUID(),
          sourceConfiguration: snapshot.sourceConfiguration,
          population,
          outcome: 'complete',
          startedAt: snapshot.syncStartedAt,
          completedAt: snapshot.capturedAt,
          expectedSourceGroupRefs: snapshot.expectedSourceGroupRefs,
          completedSourceGroupRefs: snapshot.sourceGroupRefs,
          publishedSnapshotId: snapshot.id,
          groupFailures: [],
        });
        await transaction.insert(rosterSyncResults).values({
          id: result.id,
          sourceConfigurationId: result.sourceConfiguration.id,
          sourceConfigurationVersion: result.sourceConfiguration.version,
          population: result.population,
          outcome: result.outcome,
          startedAt: new Date(result.startedAt),
          completedAt,
          expectedSourceCount: result.expectedSourceGroupRefs.length,
          completedSourceCount: result.completedSourceGroupRefs.length,
          groupFailureCount: 0,
          publishedSnapshotId: result.publishedSnapshotId,
        });
        await transaction
          .insert(rosterSyncResultSources)
          .values(
            resultSourceRows(
              result.id,
              population,
              result.expectedSourceGroupRefs,
              'expected',
            ),
          );
        await transaction
          .insert(rosterSyncResultSources)
          .values(
            resultSourceRows(
              result.id,
              population,
              result.completedSourceGroupRefs,
              'completed',
            ),
          );
        await completeReservation(
          transaction,
          request.reservationId,
          result.id,
          completedAt,
        );
        return result;
      });
    },

    async recordRejected(
      request: RejectedRosterSyncPersistenceRequest,
    ): Promise<RosterSyncResult> {
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`set transaction isolation level serializable`,
        );
        const configuration = request.loadedConfiguration.configuration;
        const outcome =
          request.completedSourceGroupRefs.length === 0
            ? 'failed'
            : 'partial-rejected';
        const result = RosterSyncResultSchema.parse({
          id: randomUUID(),
          sourceConfiguration: {
            id: configuration.id,
            version: configuration.version,
          },
          population: configuration.population,
          outcome,
          startedAt: request.startedAt,
          completedAt: request.completedAt,
          expectedSourceGroupRefs: configuration.groupSourceRefs,
          completedSourceGroupRefs: request.completedSourceGroupRefs,
          publishedSnapshotId: null,
          groupFailures: request.groupFailures,
        });
        await transaction.insert(rosterSyncResults).values({
          id: result.id,
          sourceConfigurationId: result.sourceConfiguration.id,
          sourceConfigurationVersion: result.sourceConfiguration.version,
          population: result.population,
          outcome: result.outcome,
          startedAt: new Date(result.startedAt),
          completedAt: new Date(result.completedAt),
          expectedSourceCount: result.expectedSourceGroupRefs.length,
          completedSourceCount: result.completedSourceGroupRefs.length,
          groupFailureCount: result.groupFailures.length,
          publishedSnapshotId: null,
        });
        await transaction
          .insert(rosterSyncResultSources)
          .values(
            resultSourceRows(
              result.id,
              result.population,
              result.expectedSourceGroupRefs,
              'expected',
            ),
          );
        if (result.completedSourceGroupRefs.length > 0) {
          await transaction
            .insert(rosterSyncResultSources)
            .values(
              resultSourceRows(
                result.id,
                result.population,
                result.completedSourceGroupRefs,
                'completed',
              ),
            );
        }
        if (result.groupFailures.length > 0) {
          await transaction.insert(rosterSyncGroupFailures).values(
            result.groupFailures.map((failure) => ({
              syncResultId: result.id,
              population: result.population,
              groupSourceId: failure.groupSourceRef.id,
              groupSourceKind: failure.groupSourceRef.kind,
              groupPurpose: failure.groupSourceRef.purpose,
              expectedSetKind: 'expected' as const,
              errorCode: failure.errorCode,
              attemptedAt: new Date(failure.attemptedAt),
            })),
          );
        }
        await completeReservation(
          transaction,
          request.reservationId,
          result.id,
          new Date(result.completedAt),
        );
        return result;
      });
    },

    async failReservation(
      reservationId: string,
      rawErrorCode: string,
      completedAt: string,
    ): Promise<void> {
      const safeCode = SafeErrorCodeSchema.parse(rawErrorCode);
      await database
        .update(idempotencyRecords)
        .set({
          status: 'failed',
          completedAt: new Date(TimestampSchema.parse(completedAt)),
          resultReference: `error:${safeCode}`,
        })
        .where(
          and(
            eq(idempotencyRecords.id, UuidSchema.parse(reservationId)),
            eq(idempotencyRecords.status, 'in-progress'),
          ),
        );
    },
  });
}
