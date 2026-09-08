import {
  appendSharedCapabilityAuditEntry,
  claimSharedIdempotency,
  completeSharedIdempotency,
  readSharedDatabaseTime,
} from './persistence';
import { createHash } from 'node:crypto';

import {
  DispatchBatchSchema,
  DeviceEnrollmentPageSchema,
  DeviceEnrollmentSchema,
  EndpointStatusSchema,
  EndpointStatusRecordSchema,
  PushTokenRegistrationReceiptSchema,
  PushTokenUnregistrationReceiptSchema,
  PushEndpointSendEligibilityInputSchema,
  type Actor,
  type CapabilityInput,
  type CapabilityOutput,
  type DeviceEnrollmentPage,
  type DispatchBatch,
  type Endpoint,
  type EndpointStatus,
  type EndpointStatusRecord,
  PushEndpointSchema,
  type PushEndpoint,
  type PushEndpointSendEligibilityInput,
  PushPlatformSchema,
  type PushProviderCutover,
  type PushTokenRegistrationReceipt,
  type PushTokenUnregistrationReceipt,
  type RegisteredCapabilityId,
  type RosterSnapshot,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  gt,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../db/client';
import {
  channelAttempts,
  deliveryEvidence,
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  rosterEndpoints,
  rosterRecipients,
  sessionRevocations,
  sessions,
  users,
} from '../../db/schema';
import {} from '../audit';
import {
  PUSH_PROVIDER_CUTOVER_ENV,
  parsePushProviderCutover,
  selectedPushProvider,
} from '../push-provider-cutover';
import { resolveAudience, type ResolveAudienceInput } from '../roster/resolve';

import {
  CapabilityEngineError,
  executeAuditedCapabilityTransaction,
  readCapabilityTime,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type CapabilityHandlerContext,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';

/** The one worker identity accepted by the push endpoint-invalidation route. */
export const PUSH_ENDPOINT_INVALIDATION_SERVICE_ID =
  'push-endpoint-invalidation-worker' as const;

/** Provider-terminal reason retained without copying the rejected token. */
export const EXPO_DEVICE_NOT_REGISTERED_REASON =
  'EXPO_DEVICE_NOT_REGISTERED' as const;
export const APNS_BAD_DEVICE_TOKEN_REASON = 'APNS_BAD_DEVICE_TOKEN' as const;
export const APNS_UNREGISTERED_REASON = 'APNS_UNREGISTERED' as const;
export const FCM_INVALID_ARGUMENT_REASON = 'FCM_INVALID_ARGUMENT' as const;
export const FCM_UNREGISTERED_REASON = 'FCM_UNREGISTERED' as const;

export const PUSH_ENDPOINT_INVALIDATION_REASONS = Object.freeze([
  EXPO_DEVICE_NOT_REGISTERED_REASON,
  APNS_BAD_DEVICE_TOKEN_REASON,
  APNS_UNREGISTERED_REASON,
  FCM_INVALID_ARGUMENT_REASON,
  FCM_UNREGISTERED_REASON,
]);

export function pushInvalidationReasonMatchesProvider(
  reasonCode: string,
  provider: string,
): boolean {
  return (
    (provider === 'expo' && reasonCode === EXPO_DEVICE_NOT_REGISTERED_REASON) ||
    (provider === 'apns' &&
      (reasonCode === APNS_BAD_DEVICE_TOKEN_REASON ||
        reasonCode === APNS_UNREGISTERED_REASON)) ||
    (provider === 'fcm' &&
      (reasonCode === FCM_INVALID_ARGUMENT_REASON ||
        reasonCode === FCM_UNREGISTERED_REASON))
  );
}

const MAX_PUSH_ENDPOINTS = 12_000;

export type PushEndpointResolutionErrorCode =
  | 'INVALID_PUSH_AUDIENCE'
  | 'INVALID_PUSH_ENDPOINT_POLICY'
  | 'PUSH_AUDIENCE_MISMATCH'
  | 'PUSH_ENDPOINT_COUNT_MISMATCH'
  | 'PUSH_ROSTER_MISMATCH'
  | 'PUSH_BATCH_INVALID';

/** Public-safe resolution error which never reflects a token or recipient. */
export class PushEndpointResolutionError extends Error {
  public constructor(public readonly code: PushEndpointResolutionErrorCode) {
    super('Push endpoint resolution failed safely.');
    this.name = 'PushEndpointResolutionError';
  }
}

export interface PushEndpointPolicyCandidate {
  readonly recipientId: string;
  readonly endpointId: string;
}

export interface PushEndpointPolicyQuery {
  readonly rosterSnapshotId: string;
  readonly rosterPopulation: 'staff' | 'synthetic';
  readonly endpointCount?: number;
  readonly candidates: readonly PushEndpointPolicyCandidate[];
  /**
   * The instant live registrations are read as of, so that every page of one
   * batch, and the policy read behind it, see the same devices. Omitted reads
   * resolve against the present moment.
   */
  readonly asOf?: string;
}

interface NormalizedPushEndpointPolicyQuery extends PushEndpointPolicyQuery {
  readonly endpointCount: number;
}

export interface PushEndpointPolicyEvidence
  extends PushEndpointPolicyCandidate {
  readonly status: EndpointStatus;
}

interface ParsedPushEndpointPolicyEvidence extends PushEndpointPolicyCandidate {
  readonly status: EndpointStatus;
}

/** Token-free read boundary for append-only endpoint lifecycle evidence. */
export interface PushEndpointPolicyStore {
  loadEndpointPolicy(query: PushEndpointPolicyQuery): Promise<unknown>;
}

export interface ResolvePushEndpointsInput {
  readonly batch: unknown;
  readonly audience: ResolveAudienceInput;
}

export interface ResolvedPushEndpoint {
  readonly rosterSnapshotId: string;
  readonly rosterPopulation: 'staff' | 'synthetic';
  readonly recipientId: string;
  readonly endpoint: PushEndpoint;
}

export interface ResolvedPushEndpointPage {
  readonly endpoints: readonly ResolvedPushEndpoint[];
  readonly nextCursor: number | null;
}

interface PushEndpointSendEligibilityEvidence {
  readonly rosterSnapshotId: string;
  readonly rosterPopulation: 'staff' | 'synthetic';
  readonly recipientId: string;
  readonly endpointId: string;
  readonly platform: 'ios' | 'android';
  readonly provider: 'expo' | 'apns' | 'fcm';
  readonly serviceEnvironment: 'development' | 'production';
  readonly tokenDigest: string;
  readonly endpointStatus: EndpointStatus;
  readonly effectiveStatus: EndpointStatus;
}

/** Narrow testable read boundary used by the worker-only eligibility route. */
export interface PushEndpointSendEligibilityStore {
  loadPushEndpointSendEligibility(
    input: PushEndpointSendEligibilityInput,
  ): Promise<unknown>;
}

function parsePushEndpointSendEligibilityEvidence(
  value: unknown,
): PushEndpointSendEligibilityEvidence | null {
  if (value === null) return null;
  const record = exactDataRecord(value, [
    'rosterSnapshotId',
    'rosterPopulation',
    'recipientId',
    'endpointId',
    'platform',
    'provider',
    'serviceEnvironment',
    'tokenDigest',
    'endpointStatus',
    'effectiveStatus',
  ]);
  const endpointStatus = EndpointStatusSchema.safeParse(record?.endpointStatus);
  const effectiveStatus = EndpointStatusSchema.safeParse(
    record?.effectiveStatus,
  );
  if (
    record === null ||
    typeof record.rosterSnapshotId !== 'string' ||
    (record.rosterPopulation !== 'staff' &&
      record.rosterPopulation !== 'synthetic') ||
    typeof record.recipientId !== 'string' ||
    typeof record.endpointId !== 'string' ||
    (record.platform !== 'ios' && record.platform !== 'android') ||
    (record.provider !== 'expo' &&
      record.provider !== 'apns' &&
      record.provider !== 'fcm') ||
    (record.serviceEnvironment !== 'development' &&
      record.serviceEnvironment !== 'production') ||
    typeof record.tokenDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.tokenDigest) ||
    !endpointStatus.success ||
    !effectiveStatus.success
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  return Object.freeze({
    rosterSnapshotId: record.rosterSnapshotId,
    rosterPopulation: record.rosterPopulation,
    recipientId: record.recipientId,
    endpointId: record.endpointId,
    platform: record.platform,
    provider: record.provider,
    serviceEnvironment: record.serviceEnvironment,
    tokenDigest: record.tokenDigest,
    endpointStatus: endpointStatus.data,
    effectiveStatus: effectiveStatus.data,
  });
}

/**
 * Revalidates the full immutable endpoint identity against current append-only
 * lifecycle truth. A well-formed absent or revoked endpoint is ineligible;
 * malformed/store failures throw so callers can fail closed.
 */
export async function checkPushEndpointSendEligibility(
  inputValue: unknown,
  store: PushEndpointSendEligibilityStore,
): Promise<boolean> {
  const parsed = PushEndpointSendEligibilityInputSchema.safeParse(inputValue);
  if (!parsed.success) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  let rawEvidence: unknown;
  try {
    rawEvidence = await store.loadPushEndpointSendEligibility(parsed.data);
  } catch {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const evidence = parsePushEndpointSendEligibilityEvidence(rawEvidence);
  return (
    evidence !== null &&
    evidence.rosterSnapshotId === parsed.data.rosterSnapshotId &&
    evidence.rosterPopulation === parsed.data.rosterPopulation &&
    evidence.recipientId === parsed.data.recipientId &&
    evidence.endpointId === parsed.data.endpointId &&
    evidence.platform === parsed.data.platform &&
    evidence.provider === parsed.data.provider &&
    evidence.serviceEnvironment === parsed.data.serviceEnvironment &&
    evidence.tokenDigest === parsed.data.tokenDigest &&
    evidence.endpointStatus === 'active' &&
    evidence.effectiveStatus === 'active'
  );
}

function pushCandidateKey(candidate: PushEndpointPolicyCandidate): string {
  return `${candidate.recipientId}:${candidate.endpointId}`;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      return null;
    }
    const properties: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      properties[key] = descriptor.value;
    }
    return properties;
  } catch {
    return null;
  }
}

function parsePushEndpointPolicyEvidence(
  value: unknown,
  query: PushEndpointPolicyQuery,
): ReadonlyMap<string, ParsedPushEndpointPolicyEvidence> {
  try {
    if (!Array.isArray(value)) throw new TypeError();
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (
      !Number.isSafeInteger(length) ||
      Number(length) !== query.candidates.length ||
      Number(length) > MAX_PUSH_ENDPOINTS
    ) {
      throw new TypeError();
    }
    const expected = new Set(query.candidates.map(pushCandidateKey));
    if (expected.size !== query.candidates.length) throw new TypeError();
    const evidence = new Map<string, ParsedPushEndpointPolicyEvidence>();
    for (let index = 0; index < Number(length); index += 1) {
      const slot = Object.getOwnPropertyDescriptor(value, String(index));
      const properties =
        slot !== undefined &&
        slot.enumerable === true &&
        Object.hasOwn(slot, 'value')
          ? exactDataRecord(slot.value, ['recipientId', 'endpointId', 'status'])
          : null;
      const status = EndpointStatusSchema.safeParse(properties?.status);
      if (
        properties === null ||
        typeof properties.recipientId !== 'string' ||
        typeof properties.endpointId !== 'string' ||
        !status.success
      ) {
        throw new TypeError();
      }
      const item = Object.freeze({
        recipientId: properties.recipientId,
        endpointId: properties.endpointId,
        status: status.data,
      });
      const key = pushCandidateKey(item);
      if (!expected.has(key) || evidence.has(key)) throw new TypeError();
      evidence.set(key, item);
    }
    if (evidence.size !== expected.size) throw new TypeError();
    return evidence;
  } catch {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
}

function parsePushBatch(value: unknown): DispatchBatch {
  const parsed = DispatchBatchSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.channel !== 'push' ||
    (parsed.data.integrationId !== 'expo-push' &&
      parsed.data.integrationId !== 'mobile-push')
  ) {
    throw new PushEndpointResolutionError('PUSH_BATCH_INVALID');
  }
  return parsed.data;
}

/**
 * Resolves the immutable audience, then overlays append-only lifecycle truth
 * before exposing any push token to worker composition. Invalid or disabled
 * endpoints from the same pinned snapshot are therefore excluded on every
 * later resolution without rewriting that snapshot.
 */
async function resolvePushEndpointContext(
  input: ResolvePushEndpointsInput,
  store: PushEndpointPolicyStore,
): Promise<
  Readonly<{
    batch: DispatchBatch;
    candidates: readonly Readonly<{
      recipientId: string;
      endpoint: PushEndpoint;
    }>[];
    policy: ReadonlyMap<string, ParsedPushEndpointPolicyEvidence>;
  }>
> {
  const batch = parsePushBatch(input.batch);
  let audience: ReturnType<typeof resolveAudience>;
  try {
    audience = resolveAudience(input.audience);
  } catch {
    throw new PushEndpointResolutionError('INVALID_PUSH_AUDIENCE');
  }
  if (
    audience.rosterSnapshot.id !== batch.rosterSnapshotId ||
    audience.rosterSnapshot.population !== batch.rosterPopulation
  ) {
    throw new PushEndpointResolutionError('PUSH_ROSTER_MISMATCH');
  }
  // The audience is the school now, not a versioned configuration object,
  // so the provenance check compares the school the batch was built for.
  if (audience.facilityId !== batch.facilityId) {
    throw new PushEndpointResolutionError('PUSH_AUDIENCE_MISMATCH');
  }

  const candidates = audience.recipients.flatMap((recipient) =>
    recipient.endpoints.flatMap((endpoint) =>
      endpoint.channel === 'push' && endpoint.status === 'active'
        ? [
            Object.freeze({
              recipientId: recipient.recipientId,
              endpoint,
            }),
          ]
        : [],
    ),
  );
  // The batch was planned from the published snapshot. The audience may since
  // have grown by devices people enrolled after the roster was published, and
  // those are reached; it must never have shrunk, because a published endpoint
  // that no longer resolves is still a candidate that the policy disables.
  if (candidates.length < batch.endpointCount) {
    throw new PushEndpointResolutionError('PUSH_ENDPOINT_COUNT_MISMATCH');
  }
  const query = Object.freeze({
    rosterSnapshotId: batch.rosterSnapshotId,
    rosterPopulation: batch.rosterPopulation,
    endpointCount: candidates.length,
    candidates: Object.freeze(
      candidates.map(({ recipientId, endpoint }) =>
        Object.freeze({ recipientId, endpointId: endpoint.id }),
      ),
    ),
    // The same instant the audience was resolved as of, so the policy sees
    // the same devices the audience fanned out.
    asOf: batch.createdAt,
  });
  let rawPolicy: unknown;
  try {
    rawPolicy = await store.loadEndpointPolicy(query);
  } catch {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const policy = parsePushEndpointPolicyEvidence(rawPolicy, query);
  return Object.freeze({
    batch,
    candidates: Object.freeze(candidates),
    policy,
  });
}

function eligiblePushEndpoints(
  batch: DispatchBatch,
  candidates: readonly Readonly<{
    recipientId: string;
    endpoint: PushEndpoint;
  }>[],
  policy: ReadonlyMap<string, ParsedPushEndpointPolicyEvidence>,
): readonly ResolvedPushEndpoint[] {
  return Object.freeze(
    candidates.flatMap(({ recipientId, endpoint }) => {
      const evidence = policy.get(
        pushCandidateKey({ recipientId, endpointId: endpoint.id }),
      );
      return evidence?.status === 'active'
        ? [
            Object.freeze({
              rosterSnapshotId: batch.rosterSnapshotId,
              rosterPopulation: batch.rosterPopulation,
              recipientId,
              endpoint,
            }),
          ]
        : [];
    }),
  );
}

export async function resolvePushEndpoints(
  input: ResolvePushEndpointsInput,
  store: PushEndpointPolicyStore,
): Promise<readonly ResolvedPushEndpoint[]> {
  const { batch, candidates, policy } = await resolvePushEndpointContext(
    input,
    store,
  );
  return eligiblePushEndpoints(batch, candidates, policy);
}

/**
 * Pages the roster candidates before applying mutable endpoint status.
 *
 * The offset is only sound if every page computes the same candidate list.
 * Published endpoints come from the immutable snapshot, and the devices fanned
 * out from live registrations are read as of the batch's creation instant, so
 * neither an endpoint invalidated between pages nor a device unregistered
 * mid-broadcast can shift the next offset and silently skip a later candidate.
 */
export async function resolvePushEndpointPage(
  input: ResolvePushEndpointsInput,
  store: PushEndpointPolicyStore,
  cursor: number,
  limit: number,
): Promise<ResolvedPushEndpointPage> {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > MAX_PUSH_ENDPOINTS ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const { batch, candidates, policy } = await resolvePushEndpointContext(
    input,
    store,
  );
  if (cursor > candidates.length) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const selected = candidates.slice(cursor, cursor + limit);
  return Object.freeze({
    endpoints: eligiblePushEndpoints(batch, selected, policy),
    nextCursor:
      cursor + selected.length < candidates.length
        ? cursor + selected.length
        : null,
  });
}

function normalizePushEndpointPolicyQuery(
  query: PushEndpointPolicyQuery,
): NormalizedPushEndpointPolicyQuery {
  if (!Array.isArray(query.candidates)) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const endpointCount = query.endpointCount ?? query.candidates.length;
  if (
    !Number.isSafeInteger(endpointCount) ||
    endpointCount < 0 ||
    endpointCount > MAX_PUSH_ENDPOINTS ||
    endpointCount !== query.candidates.length
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  return Object.freeze({
    rosterSnapshotId: query.rosterSnapshotId,
    rosterPopulation: query.rosterPopulation,
    endpointCount,
    candidates: query.candidates,
    ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
  });
}

type LivePushRegistration = Readonly<{
  id: string;
  deviceEnrollmentId: string;
  platform: string;
  provider: string;
  serviceEnvironment: string;
  token: string;
}>;

/**
 * Live push truth for one roster snapshot: where each published endpoint should
 * actually deliver, and which of the recipient's live devices no published
 * endpoint covers at all.
 */
type LivePushResolution = Readonly<{
  resolved: ReadonlyMap<string, LivePushRegistration>;
  unclaimed: ReadonlyMap<string, readonly LivePushRegistration[]>;
}>;

const EMPTY_LIVE_PUSH_RESOLUTION: LivePushResolution = Object.freeze({
  resolved: new Map<string, LivePushRegistration>(),
  unclaimed: new Map<string, readonly LivePushRegistration[]>(),
});

/** Matches the per-recipient endpoint ceiling the roster contract enforces. */
const MAX_ENDPOINTS_PER_RECIPIENT = 10;

/**
 * Fits a recipient's endpoints under the contract's ceiling without letting a
 * dead placeholder cost a live device its place.
 *
 * The ceiling counts every channel, so a recipient the snapshot already holds
 * ten endpoints for has no room left, and appending the fanned-out devices
 * last meant they were exactly what got cut. The order is therefore: the
 * stable non-push endpoints, then the push endpoints that resolved to a live
 * registration, then the devices fanned out from live registrations, and only
 * then the published push endpoints with no live registration behind them,
 * which the policy reports disabled regardless and which are the only ones a
 * ceiling should ever cost.
 */
function orderedWithinCap(
  published: readonly Endpoint[],
  fannedOut: readonly PushEndpoint[],
  resolved: ReadonlyMap<string, LivePushRegistration>,
): readonly Endpoint[] {
  const nonPush: Endpoint[] = [];
  const livePush: Endpoint[] = [];
  const deadPush: Endpoint[] = [];
  for (const endpoint of published) {
    if (endpoint.channel !== 'push') nonPush.push(endpoint);
    else if (resolved.has(endpoint.id)) livePush.push(endpoint);
    else deadPush.push(endpoint);
  }
  return [...nonPush, ...livePush, ...fannedOut, ...deadPush].slice(
    0,
    MAX_ENDPOINTS_PER_RECIPIENT,
  );
}

/**
 * Builds push endpoints for the recipient's live devices that no published
 * endpoint covers. Each one carries its own registration id, which is the same
 * identity a published push endpoint carries, so the policy store can resolve
 * it and delivery can record attempts against it exactly as it always has.
 *
 * The recipient's own published endpoints are deliberately not consulted for
 * which devices qualify. Inferring a provider profile from them meant a
 * recipient the snapshot held no push endpoint for was unreachable on every
 * device they owned until somebody republished, and a recipient whose only
 * published endpoint was an iPhone never reached their Android phone at all.
 * Both are the same mistake: a snapshot pins *who* is notified, not which
 * devices that person happened to be carrying when it was published.
 *
 * One endpoint per device, never one per registration. A device registers
 * under a native provider and an Expo fallback at once, so fanning out every
 * registration would send the same person the same notification twice. The
 * tenant's push-provider cutover -- the same rule roster publish applies when
 * it chooses which registration to capture -- decides which of a device's
 * registrations this deployment delivers on. A device already reached through
 * a published endpoint is skipped for the same reason.
 *
 * Anything that does not parse as a push endpoint is dropped rather than
 * raised: an unusable registration must not take down an entire notification.
 * A missing cutover adds nothing, because no registration can be shown to be
 * the one this deployment sends on; roster publish refuses outright on the
 * same condition, and a notification must degrade rather than fail.
 */
function additionalPushEndpoints(
  recipient: RosterSnapshot['recipients'][number],
  registrations: readonly LivePushRegistration[],
  resolved: ReadonlyMap<string, LivePushRegistration>,
  capturedAt: string,
  cutover: PushProviderCutover | null,
): readonly PushEndpoint[] {
  if (registrations.length === 0 || cutover === null) return [];
  const publishedIds = new Set<string>();
  const coveredDevices = new Set<string>();
  for (const endpoint of recipient.endpoints) {
    if (endpoint.channel !== 'push') continue;
    publishedIds.add(endpoint.id);
    const live = resolved.get(endpoint.id);
    if (live !== undefined) coveredDevices.add(live.deviceEnrollmentId);
  }
  // Registrations arrive newest first, so the first one a device offers on the
  // selected provider is the install that replaced the rest.
  const perDevice = new Map<string, PushEndpoint>();
  for (const registration of registrations) {
    if (
      publishedIds.has(registration.id) ||
      coveredDevices.has(registration.deviceEnrollmentId) ||
      perDevice.has(registration.deviceEnrollmentId)
    ) {
      continue;
    }
    const platform = PushPlatformSchema.safeParse(registration.platform);
    if (
      !platform.success ||
      registration.provider !== selectedPushProvider(cutover, platform.data)
    ) {
      continue;
    }
    const parsed = PushEndpointSchema.safeParse({
      id: registration.id,
      status: 'active',
      capturedAt,
      channel: 'push',
      platform: registration.platform,
      provider: registration.provider,
      serviceEnvironment: registration.serviceEnvironment,
      token: registration.token,
    });
    if (parsed.success) {
      perDevice.set(registration.deviceEnrollmentId, parsed.data);
    }
  }
  return [...perDevice.values()];
}

function pushGroupKey(
  row: Readonly<{
    recipientId: string;
    platform: string | null;
    provider: string | null;
    serviceEnvironment: string | null;
  }>,
): string {
  return `${row.recipientId}|${row.platform}|${row.provider}|${row.serviceEnvironment}`;
}

/**
 * Resolves the live push registration behind every push endpoint in a roster
 * snapshot.
 *
 * A roster snapshot pins *who* gets notified. It must not also pin *where*.
 * Each push endpoint used to carry a frozen copy of one registration and was
 * matched back to it by `registration.id = endpoint.id`, so reinstalling the
 * app -- which enrolls a new installation and mints a new registration id and
 * token -- dropped that person out of push entirely until somebody remembered
 * to republish the roster. Nothing surfaced: the endpoint simply resolved to no
 * registration and was skipped. Email was unaffected, because an address is
 * stable, which is exactly how this stayed hidden.
 *
 * Registrations are therefore resolved live, from the recipient's identity
 * rather than from the snapshot. An endpoint keeps its own registration while
 * that registration is live, and only an endpoint whose registration is gone
 * substitutes onto one no other endpoint holds.
 *
 * A recipient can also be carrying a device the snapshot never saw, because
 * publishing is a manual act and installing an app is not. Those registrations
 * are returned separately as `unclaimed`, so the audience can reach a phone and
 * a tablet at once without waiting for someone to republish the roster.
 *
 * Only registrations that can actually be delivered to are considered: the user
 * is not disabled, the enrollment is not revoked, the registration has not been
 * unregistered, and the build identity is complete. An endpoint left with no
 * live registration is disabled by the caller rather than delivered to a token
 * that is known to be dead.
 *
 * When `asOf` is given, "live" means live at that instant: registered by then
 * and not unregistered by then. A batch is paged by numeric offset across
 * separate requests, so the set of fanned-out devices has to be the same on
 * every page or a device that unregisters mid-broadcast shifts every later
 * candidate down one and the one on the page boundary is silently skipped.
 * Pinning the read to the batch's creation instant makes each page compute
 * the identical list. A device that unregisters after that instant is still
 * sent to, and the provider's receipt retires it, exactly as for a published
 * endpoint.
 */
async function loadLivePushRegistrations(
  database: DeviceQueryDatabase,
  rosterSnapshotId: string,
  rosterPopulation: 'staff' | 'synthetic',
  recipientIds: readonly string[],
  asOf?: string,
): Promise<LivePushResolution> {
  const uniqueRecipientIds = [...new Set(recipientIds)];
  if (uniqueRecipientIds.length === 0) return EMPTY_LIVE_PUSH_RESOLUTION;
  const asOfDate = asOf === undefined ? null : new Date(asOf);
  if (asOfDate !== null && Number.isNaN(asOfDate.getTime())) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }

  // Every push endpoint these recipients own in the snapshot, not just the
  // candidates in play, so that paging a batch cannot shift the pairing.
  const endpointRows = await database
    .select({
      endpointId: rosterEndpoints.id,
      recipientId: rosterEndpoints.recipientId,
      platform: rosterEndpoints.platform,
      provider: rosterEndpoints.provider,
      serviceEnvironment: rosterEndpoints.serviceEnvironment,
    })
    .from(rosterEndpoints)
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, rosterSnapshotId),
        eq(rosterEndpoints.population, rosterPopulation),
        eq(rosterEndpoints.channel, 'push'),
        inArray(rosterEndpoints.recipientId, uniqueRecipientIds),
      ),
    )
    .orderBy(asc(rosterEndpoints.recipientId), asc(rosterEndpoints.id));

  const registrationRows = await database
    .select({
      recipientId: rosterRecipients.id,
      id: devicePushTokenRegistrations.id,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
      platform: devicePushTokenRegistrations.platform,
      provider: devicePushTokenRegistrations.provider,
      serviceEnvironment: devicePushTokenRegistrations.serviceEnvironment,
      token: devicePushTokenRegistrations.token,
    })
    .from(rosterRecipients)
    .innerJoin(
      users,
      or(
        eq(users.googleSubject, rosterRecipients.googleSubject),
        sql`lower(${users.email}) = lower(${rosterRecipients.staffEmail})`,
      ),
    )
    .innerJoin(deviceEnrollments, eq(deviceEnrollments.userId, users.id))
    .innerJoin(
      devicePushTokenRegistrations,
      eq(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollments.id),
    )
    .leftJoin(
      devicePushTokenUnregistrations,
      and(
        eq(
          devicePushTokenUnregistrations.registrationId,
          devicePushTokenRegistrations.id,
        ),
        eq(
          devicePushTokenUnregistrations.deviceEnrollmentId,
          devicePushTokenRegistrations.deviceEnrollmentId,
        ),
      ),
    )
    .where(
      and(
        eq(rosterRecipients.rosterSnapshotId, rosterSnapshotId),
        eq(rosterRecipients.population, rosterPopulation),
        inArray(rosterRecipients.id, uniqueRecipientIds),
        isNull(users.disabledAt),
        isNull(deviceEnrollments.revokedAt),
        asOfDate === null
          ? isNull(devicePushTokenUnregistrations.id)
          : or(
              isNull(devicePushTokenUnregistrations.id),
              gt(devicePushTokenUnregistrations.unregisteredAt, asOfDate),
            ),
        asOfDate === null
          ? undefined
          : lte(devicePushTokenRegistrations.registeredAt, asOfDate),
        isNotNull(devicePushTokenRegistrations.applicationId),
        isNotNull(devicePushTokenRegistrations.applicationVersion),
        isNotNull(devicePushTokenRegistrations.nativeBuildVersion),
        isNotNull(devicePushTokenRegistrations.expoProjectId),
        eq(devicePushTokenRegistrations.updateMode, 'embedded-only'),
      ),
    )
    // Newest registration first, so that the substitution pass below reaches
    // for the most recent install when an endpoint's own registration is gone.
    .orderBy(
      asc(rosterRecipients.id),
      desc(devicePushTokenRegistrations.registeredAt),
      desc(devicePushTokenRegistrations.id),
    );

  const seenRegistrationBindings = new Set<string>();
  const available = new Map<string, LivePushRegistration[]>();
  registrationRows.forEach((row) => {
    // A recipient whose Google subject and staff email disagree about which
    // user they are can match twice, and one user can appear behind two
    // recipient rows. Deduplicate per (recipient, registration) rather than
    // per registration, so each recipient sees the device; the claim sets
    // below still ensure one device is delivered to exactly once.
    const binding = `${row.recipientId}:${row.id}`;
    if (seenRegistrationBindings.has(binding)) return;
    seenRegistrationBindings.add(binding);
    const key = pushGroupKey(row);
    const registration: LivePushRegistration = Object.freeze({
      id: row.id,
      deviceEnrollmentId: row.deviceEnrollmentId,
      platform: row.platform,
      provider: row.provider,
      serviceEnvironment: row.serviceEnvironment,
      token: row.token,
    });
    const bucket = available.get(key);
    if (bucket === undefined) available.set(key, [registration]);
    else bucket.push(registration);
  });

  const resolved = new Map<string, LivePushRegistration>();
  const claimed = new Set<string>();

  // A push endpoint is published from one registration and carries its id, so
  // an endpoint whose own registration is still live already points at a real
  // device. It keeps it. Ranking alone did not: a person carrying a phone and
  // a tablet has one endpoint per device, and pairing both endpoints against
  // one newest-first list handed the newest registration to whichever endpoint
  // was read first, leaving the other device unreachable.
  endpointRows.forEach((endpoint) => {
    const own = available
      .get(pushGroupKey(endpoint))
      ?.find((registration) => registration.id === endpoint.endpointId);
    if (own === undefined) return;
    resolved.set(endpoint.endpointId, own);
    claimed.add(own.id);
  });

  // Only an endpoint whose own registration is gone substitutes, and only onto
  // a registration no other endpoint already holds. Reinstalling the app does
  // not unregister the install it replaced -- that install is simply gone --
  // so the superseded registration lingers, active and undeliverable, forever.
  // Taking the newest unclaimed registration reaches the install that replaced
  // it without ever taking a device another endpoint is still delivering to.
  endpointRows.forEach((endpoint) => {
    if (resolved.has(endpoint.endpointId)) return;
    const replacement = available
      .get(pushGroupKey(endpoint))
      ?.find((registration) => !claimed.has(registration.id));
    if (replacement === undefined) return;
    resolved.set(endpoint.endpointId, replacement);
    claimed.add(replacement.id);
  });

  // Whatever is still unclaimed is a device the snapshot never saw: the person
  // installed the app on a second phone or a tablet after the roster was
  // published. Publishing is a manual act and installing an app is not, so
  // waiting for a republish means an emergency reaches one of someone's
  // devices and silently misses the rest.
  const unclaimed = new Map<string, LivePushRegistration[]>();
  registrationRows.forEach((row) => {
    if (claimed.has(row.id)) return;
    claimed.add(row.id);
    const bucket = unclaimed.get(row.recipientId);
    const registration = available
      .get(pushGroupKey(row))
      ?.find((candidate) => candidate.id === row.id);
    if (registration === undefined) return;
    if (bucket === undefined) unclaimed.set(row.recipientId, [registration]);
    else bucket.push(registration);
  });
  return Object.freeze({ resolved, unclaimed });
}

/**
 * Returns the roster snapshot with every push endpoint pointed at the device
 * the recipient is actually reachable on right now.
 *
 * The snapshot's own copy of the token was frozen when the roster was
 * published. Delivery reads the audience, not the policy evidence -- the policy
 * store is a deliberately token-free boundary -- so resolving the policy
 * against live registrations is only half the fix: without this, an endpoint
 * that correctly resolves to a live device would still be sent to the dead
 * token the snapshot remembers.
 *
 * An endpoint with no live registration keeps its frozen token here and is
 * reported `disabled` by the policy, so it is dropped before delivery rather
 * than sent to a token known to be stale.
 *
 * Devices the snapshot never saw are appended as additional push endpoints
 * carrying their own registration id, so a person who installed the app on a
 * second device after the roster was published is reached on both.
 */
export async function rosterSnapshotWithLivePushTokens(
  database: DeviceQueryDatabase,
  snapshot: RosterSnapshot,
  asOf?: string,
  cutover: PushProviderCutover | null = parsePushProviderCutover(
    process.env[PUSH_PROVIDER_CUTOVER_ENV],
  ),
): Promise<RosterSnapshot> {
  const { resolved, unclaimed } = await loadLivePushRegistrations(
    database,
    snapshot.id,
    snapshot.population,
    snapshot.recipients.map((recipient) => recipient.id),
    asOf,
  );
  if (resolved.size === 0 && unclaimed.size === 0) return snapshot;
  return Object.freeze({
    ...snapshot,
    recipients: Object.freeze(
      snapshot.recipients.map((recipient) =>
        Object.freeze({
          ...recipient,
          endpoints: Object.freeze(
            orderedWithinCap(
              recipient.endpoints.map((endpoint) => {
                if (endpoint.channel !== 'push') return endpoint;
                const live = resolved.get(endpoint.id);
                return live === undefined || live.token === endpoint.token
                  ? endpoint
                  : Object.freeze({ ...endpoint, token: live.token });
              }),
              additionalPushEndpoints(
                recipient,
                unclaimed.get(recipient.id) ?? [],
                resolved,
                snapshot.capturedAt,
                cutover,
              ),
              resolved,
            ),
          ),
        }),
      ),
    ),
  }) as RosterSnapshot;
}

async function loadDrizzlePushEndpointPolicy(
  database: DeviceQueryDatabase,
  input: PushEndpointPolicyQuery,
): Promise<readonly PushEndpointPolicyEvidence[]> {
  const query = normalizePushEndpointPolicyQuery(input);
  if (
    query.candidates.length > MAX_PUSH_ENDPOINTS ||
    new Set(query.candidates.map(pushCandidateKey)).size !==
      query.candidates.length
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  if (query.candidates.length === 0) return Object.freeze([]);
  const endpointIds = query.candidates.map(({ endpointId }) => endpointId);
  // Live resolution applies to staff only. The synthetic population is the
  // seeded training roster: its endpoints are deliberately pinned to one exact
  // registration, and its recipients carry no identity to resolve against, so
  // it keeps the original id-bound registration evidence untouched.
  const { resolved: liveRegistrations, unclaimed: liveUnclaimed } =
    query.rosterPopulation === 'staff'
      ? await loadLivePushRegistrations(
          database,
          query.rosterSnapshotId,
          query.rosterPopulation,
          query.candidates.map(({ recipientId }) => recipientId),
          query.asOf,
        )
      : EMPTY_LIVE_PUSH_RESOLUTION;
  // A device enrolled after the roster was published has no endpoint row to
  // read a recipient from. The live query resolves registrations through the
  // snapshot's own recipients, so that binding -- not the caller's claim -- is
  // what makes such a candidate answerable here.
  const liveUnpublished = new Map<string, string>();
  liveUnclaimed.forEach((registrations, recipientId) => {
    registrations.forEach((registration) => {
      liveUnpublished.set(
        pushCandidateKey({ recipientId, endpointId: registration.id }),
        recipientId,
      );
    });
  });
  const endpointRows = await database
    .select({
      endpointId: rosterEndpoints.id,
      recipientId: rosterEndpoints.recipientId,
      status: rosterEndpoints.status,
      rosterProvider: rosterEndpoints.provider,
      registrationId: devicePushTokenRegistrations.id,
      registrationDeviceEnrollmentId:
        devicePushTokenRegistrations.deviceEnrollmentId,
      registrationPlatform: devicePushTokenRegistrations.platform,
      registrationProvider: devicePushTokenRegistrations.provider,
      registrationServiceEnvironment:
        devicePushTokenRegistrations.serviceEnvironment,
      registrationApplicationId: devicePushTokenRegistrations.applicationId,
      registrationApplicationVersion:
        devicePushTokenRegistrations.applicationVersion,
      registrationNativeBuildVersion:
        devicePushTokenRegistrations.nativeBuildVersion,
      registrationExpoProjectId: devicePushTokenRegistrations.expoProjectId,
      registrationUpdateMode: devicePushTokenRegistrations.updateMode,
      registrationMatchesEndpoint: sql<boolean | null>`case
        when ${devicePushTokenRegistrations.id} is null then null
        else ${devicePushTokenRegistrations.platform}::text = ${rosterEndpoints.platform}::text
          and ${devicePushTokenRegistrations.provider} = ${rosterEndpoints.provider}
          and ${devicePushTokenRegistrations.serviceEnvironment} = ${rosterEndpoints.serviceEnvironment}
          and ${devicePushTokenRegistrations.token} = ${rosterEndpoints.token}
      end`,
      unregisteredRegistrationId: devicePushTokenUnregistrations.registrationId,
      unregisteredDeviceEnrollmentId:
        devicePushTokenUnregistrations.deviceEnrollmentId,
    })
    .from(rosterEndpoints)
    .leftJoin(
      devicePushTokenRegistrations,
      eq(devicePushTokenRegistrations.id, rosterEndpoints.id),
    )
    .leftJoin(
      devicePushTokenUnregistrations,
      and(
        eq(
          devicePushTokenUnregistrations.registrationId,
          devicePushTokenRegistrations.id,
        ),
        eq(
          devicePushTokenUnregistrations.deviceEnrollmentId,
          devicePushTokenRegistrations.deviceEnrollmentId,
        ),
      ),
    )
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, query.rosterSnapshotId),
        eq(rosterEndpoints.population, query.rosterPopulation),
        eq(rosterEndpoints.channel, 'push'),
        inArray(rosterEndpoints.id, endpointIds),
      ),
    );
  const statusRows = await database
    .selectDistinctOn([endpointStatusRecords.endpointId], {
      endpointId: endpointStatusRecords.endpointId,
      recipientId: endpointStatusRecords.recipientId,
      status: endpointStatusRecords.status,
      reasonCode: endpointStatusRecords.reasonCode,
      provider: endpointStatusRecords.provider,
      providerReference: endpointStatusRecords.providerReference,
      providerOccurredAt: endpointStatusRecords.providerOccurredAt,
      sequence: endpointStatusRecords.sequence,
    })
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.rosterSnapshotId, query.rosterSnapshotId),
        eq(endpointStatusRecords.population, query.rosterPopulation),
        eq(endpointStatusRecords.channel, 'push'),
        inArray(endpointStatusRecords.endpointId, endpointIds),
      ),
    )
    .orderBy(
      endpointStatusRecords.endpointId,
      desc(endpointStatusRecords.recordedAt),
      desc(endpointStatusRecords.sequence),
    );
  const effectiveStatuses = new Map<string, EndpointStatus>();
  endpointRows.forEach((endpoint) => {
    if (query.rosterPopulation === 'staff') {
      // A staff endpoint with no live registration is reachable by nothing
      // right now: the person reinstalled, re-enrolled, was disabled, or the
      // device was revoked. That is an ordinary state, not corruption, so it
      // disables this one endpoint. Raising here would abort the whole
      // resolution and take an entire notification down because one person
      // uninstalled the app.
      effectiveStatuses.set(
        pushCandidateKey(endpoint),
        liveRegistrations.has(endpoint.endpointId)
          ? EndpointStatusSchema.parse(endpoint.status)
          : 'disabled',
      );
      return;
    }
    // Delivery-test endpoints stay bound to the exact registration they were
    // published from, with every original integrity check intact. This is the
    // path that can be aimed at a chosen device, so it stays strict.
    const hasRegistration = endpoint.registrationId !== null;
    const registrationIsComplete =
      hasRegistration &&
      (endpoint.registrationPlatform === 'ios' ||
        endpoint.registrationPlatform === 'android') &&
      (endpoint.registrationProvider === 'expo' ||
        endpoint.registrationProvider === 'apns' ||
        endpoint.registrationProvider === 'fcm') &&
      (endpoint.registrationServiceEnvironment === 'development' ||
        endpoint.registrationServiceEnvironment === 'production') &&
      endpoint.registrationApplicationId !== null &&
      endpoint.registrationApplicationVersion !== null &&
      endpoint.registrationNativeBuildVersion !== null &&
      endpoint.registrationExpoProjectId !== null &&
      endpoint.registrationUpdateMode === 'embedded-only';
    const hasUnregistration =
      endpoint.unregisteredRegistrationId !== null ||
      endpoint.unregisteredDeviceEnrollmentId !== null;
    if (
      (hasRegistration && endpoint.registrationMatchesEndpoint !== true) ||
      (hasRegistration && !registrationIsComplete && hasUnregistration) ||
      (!hasRegistration &&
        (endpoint.registrationDeviceEnrollmentId !== null ||
          endpoint.registrationMatchesEndpoint !== null ||
          hasUnregistration)) ||
      (hasUnregistration &&
        (endpoint.unregisteredRegistrationId !== endpoint.registrationId ||
          endpoint.unregisteredDeviceEnrollmentId !==
            endpoint.registrationDeviceEnrollmentId))
    ) {
      throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
    }
    effectiveStatuses.set(
      pushCandidateKey(endpoint),
      hasUnregistration
        ? 'disabled'
        : EndpointStatusSchema.parse(endpoint.status),
    );
  });
  statusRows.forEach((status) => {
    const endpoint = endpointRows.find(
      (candidate) => pushCandidateKey(candidate) === pushCandidateKey(status),
    );
    // Lifecycle truth recorded against a device the snapshot never published
    // has no endpoint row to validate its provider against, whether or not that
    // device is still live-bound. A prior send can leave a status record behind
    // for a fanned-out device that has since unregistered. Fail closed for that
    // one endpoint rather than fall through and abort the whole resolution.
    if (endpoint === undefined) {
      effectiveStatuses.set(pushCandidateKey(status), 'disabled');
      return;
    }
    if (
      endpoint === undefined ||
      status.status !== 'invalid' ||
      endpoint.rosterProvider === null ||
      !pushInvalidationReasonMatchesProvider(
        status.reasonCode,
        endpoint.rosterProvider,
      ) ||
      status.provider !== null ||
      status.providerReference !== null ||
      status.providerOccurredAt !== null
    ) {
      throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
    }
    effectiveStatuses.set(pushCandidateKey(status), 'invalid');
  });
  // Every candidate must get exactly one evidence entry, or the caller's
  // length check treats the whole result as invalid and aborts the entire
  // notification. A candidate with a published endpoint row is answered below.
  // One without is answerable only through the live binding: while it is still
  // live-bound its status stands, and if that binding is gone -- the device
  // unregistered between the audience being built and this read -- it fails
  // closed as disabled rather than being omitted. An unpublished device is
  // never approvable for a delivery test: that path is aimed at one explicitly
  // approved device, and an unpublished one cannot have been.
  const publishedKeys = new Set(endpointRows.map(pushCandidateKey));
  const unpublished = query.candidates.flatMap((candidate) => {
    const key = pushCandidateKey(candidate);
    if (publishedKeys.has(key)) return [];
    const boundRecipientId = liveUnpublished.get(key);
    const status: EndpointStatus =
      boundRecipientId === undefined
        ? 'disabled'
        : (effectiveStatuses.get(key) ?? 'active');
    return [
      Object.freeze({
        recipientId: boundRecipientId ?? candidate.recipientId,
        endpointId: candidate.endpointId,
        status,
      }),
    ];
  });
  return Object.freeze(
    [
      ...endpointRows.map((endpoint) =>
        Object.freeze({
          recipientId: endpoint.recipientId,
          endpointId: endpoint.endpointId,
          status:
            effectiveStatuses.get(pushCandidateKey(endpoint)) ??
            EndpointStatusSchema.parse(endpoint.status),
        }),
      ),
      ...unpublished,
    ].sort(
      (left, right) =>
        left.recipientId.localeCompare(right.recipientId) ||
        left.endpointId.localeCompare(right.endpointId),
    ),
  );
}

/** Production token-free status overlay for pinned push endpoint resolution. */
export function createDrizzlePushEndpointPolicyStore(
  database: Database,
): PushEndpointPolicyStore {
  return Object.freeze({
    loadEndpointPolicy: (query: PushEndpointPolicyQuery) =>
      database.transaction((transaction) =>
        loadDrizzlePushEndpointPolicy(deviceQueryDatabase(transaction), query),
      ),
  });
}

async function loadDrizzlePushEndpointSendEligibility(
  database: DeviceQueryDatabase,
  input: PushEndpointSendEligibilityInput,
): Promise<PushEndpointSendEligibilityEvidence | null> {
  const rows = await database
    .select({
      rosterSnapshotId: rosterEndpoints.rosterSnapshotId,
      rosterPopulation: rosterEndpoints.population,
      recipientId: rosterEndpoints.recipientId,
      endpointId: rosterEndpoints.id,
      endpointStatus: rosterEndpoints.status,
      platform: rosterEndpoints.platform,
      provider: rosterEndpoints.provider,
      serviceEnvironment: rosterEndpoints.serviceEnvironment,
      token: rosterEndpoints.token,
    })
    .from(rosterEndpoints)
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, input.rosterSnapshotId),
        eq(rosterEndpoints.population, input.rosterPopulation),
        eq(rosterEndpoints.recipientId, input.recipientId),
        eq(rosterEndpoints.id, input.endpointId),
        eq(rosterEndpoints.channel, 'push'),
      ),
    );
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const row = rows[0]!;
  // The live registration is the authority on where this person's device is
  // reachable. The snapshot's copy of the token is only a fallback for an
  // endpoint whose owner has no resolvable live device, and such an endpoint is
  // reported disabled below, so the stale token is never actually delivered to.
  const { resolved: liveRegistrations } = await loadLivePushRegistrations(
    database,
    input.rosterSnapshotId,
    input.rosterPopulation,
    [input.recipientId],
  );
  const token = liveRegistrations.get(row.endpointId)?.token ?? row.token;
  if (
    (row.platform !== 'ios' && row.platform !== 'android') ||
    (row.provider !== 'expo' &&
      row.provider !== 'apns' &&
      row.provider !== 'fcm') ||
    (row.serviceEnvironment !== 'development' &&
      row.serviceEnvironment !== 'production') ||
    typeof token !== 'string'
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const policy = await loadDrizzlePushEndpointPolicy(database, {
    rosterSnapshotId: input.rosterSnapshotId,
    rosterPopulation: input.rosterPopulation,
    candidates: [
      { recipientId: input.recipientId, endpointId: input.endpointId },
    ],
  });
  if (policy.length !== 1) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  return Object.freeze({
    rosterSnapshotId: row.rosterSnapshotId,
    rosterPopulation: row.rosterPopulation,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    platform: row.platform,
    provider: row.provider,
    serviceEnvironment: row.serviceEnvironment,
    tokenDigest: createHash('sha256').update(token, 'utf8').digest('hex'),
    endpointStatus: EndpointStatusSchema.parse(row.endpointStatus),
    effectiveStatus: policy[0]!.status,
  });
}

/** Production send-time eligibility store backed by current database truth. */
export function createDrizzlePushEndpointSendEligibilityStore(
  database: Database,
): PushEndpointSendEligibilityStore {
  return Object.freeze({
    loadPushEndpointSendEligibility: (
      input: PushEndpointSendEligibilityInput,
    ) =>
      loadDrizzlePushEndpointSendEligibility(
        deviceQueryDatabase(database),
        input,
      ),
  });
}

/** Device-specific persistence added to the canonical capability transaction. */
export interface DeviceCapabilityTransaction
  extends CapabilityEngineTransaction {
  registerPushToken(
    input: CapabilityInput<'register-push-token'>,
    actor: Extract<Actor, { kind: 'human' }>,
    registeredAt: Date,
  ): Promise<PushTokenRegistrationReceipt>;
  unregisterPushToken(
    input: CapabilityInput<'unregister-push-token'>,
    actor: Extract<Actor, { kind: 'human' }>,
    unregisteredAt: Date,
  ): Promise<PushTokenUnregistrationReceipt>;
  listMyDevices(
    input: CapabilityInput<'list-my-devices'>,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<DeviceEnrollmentPage>;
  recordEndpointStatus(
    input: CapabilityInput<'record-endpoint-status'>,
    recordedAt: Date,
  ): Promise<EndpointStatusRecord>;
  loadPushTokenRegistrationReplay(
    resultReference: string,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<PushTokenRegistrationReceipt | null>;
  loadPushTokenUnregistrationReplay(
    resultReference: string,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<PushTokenUnregistrationReceipt | null>;
  loadEndpointStatusReplay(
    resultReference: string,
  ): Promise<EndpointStatusRecord | null>;
}

export type DeviceCapabilityStore =
  CapabilityEngineStore<DeviceCapabilityTransaction>;

type DeviceCapabilityId = Extract<
  RegisteredCapabilityId,
  | 'list-my-devices'
  | 'record-endpoint-status'
  | 'register-push-token'
  | 'unregister-push-token'
>;

function requireHuman(
  context: CapabilityHandlerContext<DeviceCapabilityTransaction>,
): Extract<Actor, { kind: 'human' }> {
  if (context.invocation.actor.kind !== 'human') {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'This device capability requires an authenticated human.',
      403,
    );
  }
  return context.invocation.actor;
}

function replayUnavailable(): CapabilityEngineError {
  return new CapabilityEngineError(
    'INTERNAL_ERROR',
    'IDEMPOTENCY_RESULT_UNAVAILABLE',
    'The original device result is unavailable.',
    500,
  );
}

function requirePushInvalidationWorkerInvocation(
  context: CapabilityHandlerContext<DeviceCapabilityTransaction>,
): void {
  const invocation = context.invocation;
  if (
    invocation.actor.kind !== 'system' ||
    invocation.actor.serviceId !== PUSH_ENDPOINT_INVALIDATION_SERVICE_ID ||
    invocation.source !== 'worker' ||
    invocation.mutation?.transport.kind !== 'worker-execution' ||
    invocation.mutation.humanConfirmationId !== null
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'The endpoint-status invocation was not authorized.',
      403,
    );
  }
}

function requirePushInvalidationWorker(
  input: CapabilityInput<'record-endpoint-status'>,
  context: CapabilityHandlerContext<DeviceCapabilityTransaction>,
): void {
  requirePushInvalidationWorkerInvocation(context);
  if (
    input.status !== 'invalid' ||
    !PUSH_ENDPOINT_INVALIDATION_REASONS.includes(
      input.reasonCode as (typeof PUSH_ENDPOINT_INVALIDATION_REASONS)[number],
    )
  ) {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'The endpoint-status invocation was not authorized.',
      403,
    );
  }
}

function registrationReference(output: PushTokenRegistrationReceipt): string {
  return `push-registration:${output.deviceEnrollmentId}:${output.platform}:${output.provider}:${output.serviceEnvironment}`;
}

function unregistrationReference(
  output: PushTokenUnregistrationReceipt,
): string {
  return `push-unregistration:${output.deviceEnrollmentId}`;
}

function endpointStatusReference(output: EndpointStatusRecord): string {
  return `endpoint-status:${output.id}`;
}

const registerPushTokenRegistration: ServerCapabilityRegistration<
  'register-push-token',
  DeviceCapabilityTransaction
> = {
  id: 'register-push-token',
  resolveFacilityId: () => null,
  async handler(input, context) {
    // Registering a device for push requires an authenticated staff session,
    // which is the control that matters. The build allowlist that used to sit
    // here additionally required every shipped version and native build number
    // to be added to a hand-edited secret before any device on that build
    // could register or receive a send -- a step that had to happen for every
    // release, was invisible until someone installed the app and found push
    // silently broken, and protected only against a staff member running a
    // modified client they could already read everything through.
    return context.transaction.registerPushToken(
      input,
      requireHuman(context),
      await readCapabilityTime(context),
    );
  },
  resultReference: registrationReference,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    const replay = await context.transaction.loadPushTokenRegistrationReplay(
      reference,
      requireHuman(context),
    );
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const unregisterPushTokenRegistration: ServerCapabilityRegistration<
  'unregister-push-token',
  DeviceCapabilityTransaction
> = {
  id: 'unregister-push-token',
  resolveFacilityId: () => null,
  async handler(input, context) {
    return context.transaction.unregisterPushToken(
      input,
      requireHuman(context),
      await readCapabilityTime(context),
    );
  },
  resultReference: unregistrationReference,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    const replay = await context.transaction.loadPushTokenUnregistrationReplay(
      reference,
      requireHuman(context),
    );
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const listMyDevicesRegistration: ServerCapabilityRegistration<
  'list-my-devices',
  DeviceCapabilityTransaction
> = {
  id: 'list-my-devices',
  resolveFacilityId: () => null,
  handler: (input, context) =>
    context.transaction.listMyDevices(input, requireHuman(context)),
};

const recordEndpointStatusRegistration: ServerCapabilityRegistration<
  'record-endpoint-status',
  DeviceCapabilityTransaction
> = {
  id: 'record-endpoint-status',
  resolveFacilityId: () => null,
  async handler(input, context) {
    requirePushInvalidationWorker(input, context);
    return context.transaction.recordEndpointStatus(
      input,
      await readCapabilityTime(context),
    );
  },
  resultReference: endpointStatusReference,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    requirePushInvalidationWorkerInvocation(context);
    const replay =
      await context.transaction.loadEndpointStatusReplay(reference);
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const registrations = Object.freeze({
  'list-my-devices': listMyDevicesRegistration,
  'record-endpoint-status': recordEndpointStatusRegistration,
  'register-push-token': registerPushTokenRegistration,
  'unregister-push-token': unregisterPushTokenRegistration,
});

/** Executes a device capability through the canonical server engine. */
export function executeDeviceCapability<Id extends DeviceCapabilityId>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: DeviceCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, DeviceCapabilityTransaction>;
  return executeAuditedCapabilityTransaction(
    registration,
    input,
    invocation,
    store,
  );
}

type DeviceQueryDatabase = DatabaseQuery;
type NativePlatform = 'ios' | 'android';

interface LockedNativeDevice {
  readonly id: string;
  readonly platform: NativePlatform;
}

function deviceQueryDatabase(database: unknown): DeviceQueryDatabase {
  // Both configured transports expose the shared schema-aware query surface.
  return database as DeviceQueryDatabase;
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw deviceConflict('Persisted device time was invalid.');
  }
  return date.toISOString();
}

function deviceConflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function deviceForbidden(): CapabilityEngineError {
  return new CapabilityEngineError(
    'FORBIDDEN',
    'CAPABILITY_INVOCATION_DENIED',
    'The current session cannot manage this device enrollment.',
    403,
  );
}

function deviceNotFound(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'NOT_FOUND',
    'PERSISTENCE_CONFLICT',
    message,
    404,
  );
}

function invalidCursor(): CapabilityEngineError {
  return new CapabilityEngineError(
    'VALIDATION_ERROR',
    'CAPABILITY_INPUT_INVALID',
    'The device pagination cursor is invalid.',
    400,
  );
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw invalidCursor();
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(decoded)) throw invalidCursor();
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset)) throw invalidCursor();
  return offset;
}

async function lockCurrentNativeDevice(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
  actor: Extract<Actor, { kind: 'human' }>,
  expectedPlatform: NativePlatform | null,
): Promise<LockedNativeDevice> {
  const [row] = await database
    .select({
      id: deviceEnrollments.id,
      platform: deviceEnrollments.platform,
    })
    .from(deviceEnrollments)
    .innerJoin(
      sessions,
      and(
        eq(sessions.deviceEnrollmentId, deviceEnrollments.id),
        eq(sessions.userId, deviceEnrollments.userId),
      ),
    )
    .where(
      and(
        eq(deviceEnrollments.id, deviceEnrollmentId),
        eq(deviceEnrollments.userId, actor.userId),
        eq(sessions.id, actor.sessionId),
        isNull(deviceEnrollments.revokedAt),
        isNull(sessions.revokedAt),
      ),
    )
    .for('update')
    .limit(1);
  if (
    row === undefined ||
    (row.platform !== 'ios' && row.platform !== 'android') ||
    (expectedPlatform !== null && row.platform !== expectedPlatform)
  ) {
    throw deviceForbidden();
  }
  const [revocation] = await database
    .select({ id: sessionRevocations.id })
    .from(sessionRevocations)
    .where(eq(sessionRevocations.sessionId, actor.sessionId))
    .limit(1);
  if (revocation !== undefined) {
    throw deviceForbidden();
  }
  return { id: row.id, platform: row.platform };
}

interface ActivePushRegistration {
  readonly id: string;
  readonly token: string;
  readonly registeredAt: Date | string;
  readonly provider: string;
  readonly serviceEnvironment: string;
  readonly applicationId: string | null;
  readonly applicationVersion: string | null;
  readonly nativeBuildVersion: string | null;
  readonly expoProjectId: string | null;
  readonly updateMode: string | null;
}

const MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE = 100;
const PUSH_TOKEN_ADVISORY_LOCK_NAMESPACE = 12_012;

function pushTokenLockDigest(provider: string, token: string): string {
  return createHash('sha256')
    .update(`${provider}\u0000${token}`, 'utf8')
    .digest('hex');
}

/** Serializes one opaque token without exposing token material to lock telemetry. */
async function lockPushToken(
  database: DeviceQueryDatabase,
  provider: string,
  token: string,
): Promise<void> {
  const digest = pushTokenLockDigest(provider, token);
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${digest}, ${PUSH_TOKEN_ADVISORY_LOCK_NAMESPACE}))`,
  );
}

async function assertPushTokenAvailableForDevice(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
  provider: string,
  token: string,
): Promise<void> {
  const [conflicting] = await database
    .select({ id: devicePushTokenRegistrations.id })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.token, token),
        eq(devicePushTokenRegistrations.provider, provider),
        ne(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollmentId),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .limit(1);
  if (conflicting !== undefined) {
    throw deviceConflict(
      'The push token is already bound to another device enrollment.',
    );
  }
}

async function assertPushTokenRegistrationAllowed(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
  provider: string,
  token: string,
  registeredAt: Date,
): Promise<PushTokenFailureCutoff | null> {
  const failure = await latestPushTokenFailureCutoff(
    database,
    provider,
    token,
    registeredAt,
  );
  if (
    failure !== null &&
    (failure.deviceEnrollmentId === null ||
      failure.deviceEnrollmentId !== deviceEnrollmentId ||
      registeredAt.getTime() <= failure.attemptedAt.getTime())
  ) {
    throw deviceConflict('The push token cannot be registered.');
  }
  return failure;
}

interface PushTokenUnregistrationFact {
  readonly registrationId: string;
  readonly deviceEnrollmentId: string;
}

interface PushTokenFailureCutoff {
  readonly attemptedAt: Date;
  readonly deviceEnrollmentId: string | null;
}

async function latestPushTokenFailureCutoff(
  database: DeviceQueryDatabase,
  registrationProvider: string,
  token: string,
  observedThrough: Date,
): Promise<PushTokenFailureCutoff | null> {
  const providerFailurePredicate =
    registrationProvider === 'expo'
      ? and(
          eq(deliveryEvidence.reasonCode, EXPO_DEVICE_NOT_REGISTERED_REASON),
          or(
            and(
              eq(channelAttempts.rosterPopulation, 'staff'),
              eq(deliveryEvidence.provider, 'expo-push'),
            ),
            and(
              eq(channelAttempts.rosterPopulation, 'synthetic'),
              eq(deliveryEvidence.provider, 'mock-expo-push'),
            ),
          ),
        )
      : registrationProvider === 'apns'
        ? and(
            inArray(deliveryEvidence.reasonCode, [
              APNS_BAD_DEVICE_TOKEN_REASON,
              APNS_UNREGISTERED_REASON,
            ]),
            eq(deliveryEvidence.provider, 'apns-direct'),
          )
        : registrationProvider === 'fcm'
          ? and(
              inArray(deliveryEvidence.reasonCode, [
                FCM_INVALID_ARGUMENT_REASON,
                FCM_UNREGISTERED_REASON,
              ]),
              eq(deliveryEvidence.provider, 'fcm-direct'),
            )
          : sql`false`;
  const [failure] = await database
    .select({
      attemptedAt: channelAttempts.attemptedAt,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
      evidenceRecordedAt: deliveryEvidence.recordedAt,
    })
    .from(channelAttempts)
    .innerJoin(
      deliveryEvidence,
      and(
        eq(deliveryEvidence.subjectKind, 'attempt'),
        eq(deliveryEvidence.subjectId, channelAttempts.id),
        eq(deliveryEvidence.attemptId, channelAttempts.id),
      ),
    )
    .innerJoin(
      rosterEndpoints,
      and(
        eq(rosterEndpoints.rosterSnapshotId, channelAttempts.rosterSnapshotId),
        eq(rosterEndpoints.recipientId, channelAttempts.recipientId),
        eq(rosterEndpoints.id, channelAttempts.endpointId),
        eq(rosterEndpoints.population, channelAttempts.rosterPopulation),
        eq(rosterEndpoints.channel, channelAttempts.channel),
      ),
    )
    .leftJoin(
      devicePushTokenRegistrations,
      and(
        eq(devicePushTokenRegistrations.id, rosterEndpoints.id),
        eq(devicePushTokenRegistrations.token, rosterEndpoints.token),
      ),
    )
    .where(
      and(
        eq(channelAttempts.channel, 'push'),
        eq(rosterEndpoints.token, token),
        eq(deliveryEvidence.state, 'failed'),
        lte(deliveryEvidence.recordedAt, observedThrough),
        providerFailurePredicate,
      ),
    )
    .orderBy(
      desc(channelAttempts.attemptedAt),
      desc(deliveryEvidence.recordedAt),
      desc(deliveryEvidence.id),
    )
    .limit(1);
  if (failure === undefined) return null;
  const attemptedAt = new Date(failure.attemptedAt);
  const evidenceRecordedAt = new Date(failure.evidenceRecordedAt);
  if (
    !Number.isFinite(attemptedAt.getTime()) ||
    !Number.isFinite(evidenceRecordedAt.getTime()) ||
    attemptedAt.getTime() > evidenceRecordedAt.getTime() ||
    evidenceRecordedAt.getTime() > observedThrough.getTime()
  ) {
    throw deviceConflict('Push-token provider evidence has inconsistent time.');
  }
  return Object.freeze({
    attemptedAt,
    deviceEnrollmentId: failure.deviceEnrollmentId,
  });
}

async function appendPushTokenUnregistrationFacts(
  database: DeviceQueryDatabase,
  facts: readonly PushTokenUnregistrationFact[],
  unregisteredAt: Date,
): Promise<void> {
  if (facts.length === 0) return;
  if (new Set(facts.map((fact) => fact.registrationId)).size !== facts.length) {
    throw deviceConflict('Push-token unregistration facts were duplicated.');
  }
  await database
    .insert(devicePushTokenUnregistrations)
    .values(
      facts.map((fact) => ({
        registrationId: fact.registrationId,
        deviceEnrollmentId: fact.deviceEnrollmentId,
        unregisteredAt,
      })),
    )
    .onConflictDoNothing({
      target: devicePushTokenUnregistrations.registrationId,
    });
  const retained = await database
    .select({
      registrationId: devicePushTokenUnregistrations.registrationId,
      deviceEnrollmentId: devicePushTokenUnregistrations.deviceEnrollmentId,
    })
    .from(devicePushTokenUnregistrations)
    .where(
      inArray(
        devicePushTokenUnregistrations.registrationId,
        facts.map((fact) => fact.registrationId),
      ),
    );
  const retainedByRegistration = new Map(
    retained.map((fact) => [fact.registrationId, fact.deviceEnrollmentId]),
  );
  if (
    retained.length !== facts.length ||
    facts.some(
      (fact) =>
        retainedByRegistration.get(fact.registrationId) !==
        fact.deviceEnrollmentId,
    )
  ) {
    throw deviceConflict(
      'Push-token unregistration evidence could not be retained exactly.',
    );
  }
}

async function appendActivePushTokenUnregistrations(
  database: DeviceQueryDatabase,
  provider: string,
  token: string,
  invalidThrough: Date,
  originDeviceEnrollmentId: string | null,
  unregisteredAt: Date,
): Promise<void> {
  const registrations = await database
    .select({
      id: devicePushTokenRegistrations.id,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
      registeredAt: devicePushTokenRegistrations.registeredAt,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.token, token),
        eq(devicePushTokenRegistrations.provider, provider),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .limit(MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE + 1);
  if (registrations.length > MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE) {
    throw deviceConflict(
      'The push token has too many active registrations to reconcile safely.',
    );
  }
  const registrationIds = new Set(
    registrations
      .filter(
        (registration) =>
          originDeviceEnrollmentId === null ||
          registration.deviceEnrollmentId !== originDeviceEnrollmentId ||
          new Date(registration.registeredAt).getTime() <=
            invalidThrough.getTime(),
      )
      .map((registration) => registration.id),
  );
  await appendPushTokenUnregistrationFacts(
    database,
    registrations
      .filter((registration) => registrationIds.has(registration.id))
      .map((registration) => ({
        registrationId: registration.id,
        deviceEnrollmentId: registration.deviceEnrollmentId,
      })),
    unregisteredAt,
  );
}

/**
 * Resolves semantic idempotency without returning or persisting token material.
 * Callers serialize this plan with the device-enrollment row lock.
 */
export function planPushTokenRegistration(
  activeRegistrations: readonly Readonly<{
    id: string;
    provider: string;
    token: string;
  }>[],
  requestedToken: string,
  requestedProvider: 'expo' | 'apns' | 'fcm',
): Readonly<{
  keepRegistrationId: string | null;
  registrationRequired: boolean;
  unregisterRegistrationIds: readonly string[];
}> {
  const providerRegistrations = activeRegistrations.filter(
    (registration) => registration.provider === requestedProvider,
  );
  const matching = providerRegistrations.find(
    (registration) => registration.token === requestedToken,
  );
  return Object.freeze({
    keepRegistrationId: matching?.id ?? null,
    registrationRequired: matching === undefined,
    unregisterRegistrationIds: providerRegistrations
      .filter((registration) => registration.id !== matching?.id)
      .map((registration) => registration.id),
  });
}

async function activePushRegistrations(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
): Promise<readonly ActivePushRegistration[]> {
  const registrations = await database
    .select({
      id: devicePushTokenRegistrations.id,
      token: devicePushTokenRegistrations.token,
      registeredAt: devicePushTokenRegistrations.registeredAt,
      provider: devicePushTokenRegistrations.provider,
      serviceEnvironment: devicePushTokenRegistrations.serviceEnvironment,
      applicationId: devicePushTokenRegistrations.applicationId,
      applicationVersion: devicePushTokenRegistrations.applicationVersion,
      nativeBuildVersion: devicePushTokenRegistrations.nativeBuildVersion,
      expoProjectId: devicePushTokenRegistrations.expoProjectId,
      updateMode: devicePushTokenRegistrations.updateMode,
    })
    .from(devicePushTokenRegistrations)
    .leftJoin(
      devicePushTokenUnregistrations,
      eq(
        devicePushTokenUnregistrations.registrationId,
        devicePushTokenRegistrations.id,
      ),
    )
    .where(
      and(
        eq(devicePushTokenRegistrations.deviceEnrollmentId, deviceEnrollmentId),
        isNull(devicePushTokenUnregistrations.id),
      ),
    )
    .orderBy(
      desc(devicePushTokenRegistrations.registeredAt),
      desc(devicePushTokenRegistrations.id),
    )
    .limit(MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE + 1);
  if (registrations.length > MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE) {
    throw deviceConflict(
      'The device has too many active push registrations to reconcile safely.',
    );
  }
  return registrations;
}

async function appendPushUnregistrations(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
  registrationIds: readonly string[],
  unregisteredAt: Date,
): Promise<void> {
  await appendPushTokenUnregistrationFacts(
    database,
    registrationIds.map((registrationId) => ({
      registrationId,
      deviceEnrollmentId,
    })),
    unregisteredAt,
  );
}

async function registerOnePushTokenWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'register-push-token'>,
  actor: Extract<Actor, { kind: 'human' }>,
  registeredAt: Date,
): Promise<PushTokenRegistrationReceipt> {
  const device = await lockCurrentNativeDevice(
    database,
    input.deviceEnrollmentId,
    actor,
    input.platform,
  );
  await lockPushToken(database, input.provider, input.token);
  const priorFailure = await assertPushTokenRegistrationAllowed(
    database,
    device.id,
    input.provider,
    input.token,
    registeredAt,
  );
  await assertPushTokenAvailableForDevice(
    database,
    device.id,
    input.provider,
    input.token,
  );
  const active = await activePushRegistrations(database, device.id);
  const plan = planPushTokenRegistration(active, input.token, input.provider);
  const keptRegistration = active.find(
    (registration) => registration.id === plan.keepRegistrationId,
  );
  const rotateDifferentBuild =
    keptRegistration !== undefined &&
    (keptRegistration.serviceEnvironment !== input.serviceEnvironment ||
      keptRegistration.applicationId !== input.build.applicationId ||
      keptRegistration.applicationVersion !== input.build.applicationVersion ||
      keptRegistration.nativeBuildVersion !== input.build.nativeBuildVersion ||
      keptRegistration.expoProjectId !== input.build.expoProjectId ||
      keptRegistration.updateMode !== input.build.updateMode);
  const rotateStaleGeneration =
    priorFailure !== null &&
    keptRegistration !== undefined &&
    new Date(keptRegistration.registeredAt).getTime() <=
      priorFailure.attemptedAt.getTime();
  await appendPushUnregistrations(
    database,
    device.id,
    [
      ...plan.unregisterRegistrationIds,
      ...((rotateStaleGeneration || rotateDifferentBuild) &&
      plan.keepRegistrationId !== null
        ? [plan.keepRegistrationId]
        : []),
    ],
    registeredAt,
  );
  if (
    plan.registrationRequired ||
    rotateStaleGeneration ||
    rotateDifferentBuild
  ) {
    const [inserted] = await database
      .insert(devicePushTokenRegistrations)
      .values({
        deviceEnrollmentId: device.id,
        platform: device.platform,
        provider: input.provider,
        serviceEnvironment: input.serviceEnvironment,
        supersedesRegistrationId:
          plan.keepRegistrationId ?? plan.unregisterRegistrationIds[0] ?? null,
        applicationId: input.build.applicationId,
        applicationVersion: input.build.applicationVersion,
        nativeBuildVersion: input.build.nativeBuildVersion,
        expoProjectId: input.build.expoProjectId,
        updateMode: input.build.updateMode,
        token: input.token,
        registeredAt,
      })
      .returning({
        deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
        platform: devicePushTokenRegistrations.platform,
        provider: devicePushTokenRegistrations.provider,
        serviceEnvironment: devicePushTokenRegistrations.serviceEnvironment,
        applicationId: devicePushTokenRegistrations.applicationId,
        applicationVersion: devicePushTokenRegistrations.applicationVersion,
        nativeBuildVersion: devicePushTokenRegistrations.nativeBuildVersion,
        expoProjectId: devicePushTokenRegistrations.expoProjectId,
        updateMode: devicePushTokenRegistrations.updateMode,
        token: devicePushTokenRegistrations.token,
      });
    if (
      inserted === undefined ||
      inserted.deviceEnrollmentId !== device.id ||
      inserted.platform !== device.platform ||
      inserted.provider !== input.provider ||
      inserted.serviceEnvironment !== input.serviceEnvironment ||
      inserted.applicationId !== input.build.applicationId ||
      inserted.applicationVersion !== input.build.applicationVersion ||
      inserted.nativeBuildVersion !== input.build.nativeBuildVersion ||
      inserted.expoProjectId !== input.build.expoProjectId ||
      inserted.updateMode !== input.build.updateMode ||
      inserted.token !== input.token
    ) {
      throw deviceConflict(
        'Push-token registration evidence could not be retained exactly.',
      );
    }
  }
  return PushTokenRegistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    platform: device.platform,
    provider: input.provider,
    serviceEnvironment: input.serviceEnvironment,
    status: 'registered',
  });
}

/** Rotates the Expo fallback and native provider as one capability transaction. */
async function registerPushTokenWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'register-push-token'>,
  actor: Extract<Actor, { kind: 'human' }>,
  registeredAt: Date,
): Promise<PushTokenRegistrationReceipt> {
  const { expoFallbackToken, ...directInput } = input;
  if (expoFallbackToken === undefined) {
    if (directInput.provider !== 'expo') {
      throw deviceConflict(
        'A direct push registration requires its atomic Expo fallback.',
      );
    }
    return registerOnePushTokenWithDatabase(
      database,
      directInput,
      actor,
      registeredAt,
    );
  }
  await registerOnePushTokenWithDatabase(
    database,
    {
      ...directInput,
      provider: 'expo',
      token: expoFallbackToken,
    },
    actor,
    registeredAt,
  );
  return registerOnePushTokenWithDatabase(
    database,
    directInput,
    actor,
    registeredAt,
  );
}

async function unregisterPushTokenWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'unregister-push-token'>,
  actor: Extract<Actor, { kind: 'human' }>,
  unregisteredAt: Date,
): Promise<PushTokenUnregistrationReceipt> {
  const device = await lockCurrentNativeDevice(
    database,
    input.deviceEnrollmentId,
    actor,
    null,
  );
  const active = await activePushRegistrations(database, device.id);
  await appendPushUnregistrations(
    database,
    device.id,
    active.map((registration) => registration.id),
    unregisteredAt,
  );
  return PushTokenUnregistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    status: 'unregistered',
  });
}

async function listMyDevicesWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'list-my-devices'>,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<DeviceEnrollmentPage> {
  const offset = decodeCursor(input.cursor);
  const rows = await database
    .select()
    .from(deviceEnrollments)
    .where(
      input.includeRevoked
        ? eq(deviceEnrollments.userId, actor.userId)
        : and(
            eq(deviceEnrollments.userId, actor.userId),
            isNull(deviceEnrollments.revokedAt),
          ),
    )
    .orderBy(asc(deviceEnrollments.id))
    .offset(offset)
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit).map((row) =>
    DeviceEnrollmentSchema.parse({
      id: row.id,
      userId: row.userId,
      platform: row.platform,
      unlockMethod: row.unlockMethod,
      installationId: row.installationId,
      enrolledAt: dateIso(row.enrolledAt),
      lastSeenAt: dateIso(row.lastSeenAt),
      revokedAt: row.revokedAt === null ? null : dateIso(row.revokedAt),
    }),
  );
  const nextOffset = offset + items.length;
  return DeviceEnrollmentPageSchema.parse({
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeCursor(nextOffset) : null,
    },
  });
}

function endpointStatusFromRow(
  row: typeof endpointStatusRecords.$inferSelect,
): EndpointStatusRecord {
  return EndpointStatusRecordSchema.parse({
    id: row.id,
    rosterSnapshotId: row.rosterSnapshotId,
    recipientId: row.recipientId,
    endpointId: row.endpointId,
    status: row.status,
    reasonCode: row.reasonCode,
    recordedAt: dateIso(row.recordedAt),
  });
}

async function requirePushEndpointInvalidationAttempt(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'record-endpoint-status'>,
  registrationProvider: string,
  recordedAt: Date,
): Promise<PushTokenFailureCutoff> {
  if (
    !pushInvalidationReasonMatchesProvider(
      input.reasonCode,
      registrationProvider,
    )
  ) {
    throw deviceConflict(
      'Endpoint invalidation reason does not match its retained provider.',
    );
  }
  const deliveryProviderPredicate =
    registrationProvider === 'expo'
      ? or(
          and(
            eq(channelAttempts.rosterPopulation, 'staff'),
            eq(deliveryEvidence.provider, 'expo-push'),
          ),
          and(
            eq(channelAttempts.rosterPopulation, 'synthetic'),
            eq(deliveryEvidence.provider, 'mock-expo-push'),
          ),
        )
      : eq(
          deliveryEvidence.provider,
          registrationProvider === 'apns' ? 'apns-direct' : 'fcm-direct',
        );
  const [evidence] = await database
    .select({
      attemptedAt: channelAttempts.attemptedAt,
      evidenceRecordedAt: deliveryEvidence.recordedAt,
      providerOccurredAt: deliveryEvidence.providerOccurredAt,
      deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
    })
    .from(channelAttempts)
    .innerJoin(
      deliveryEvidence,
      and(
        eq(deliveryEvidence.subjectKind, 'attempt'),
        eq(deliveryEvidence.subjectId, channelAttempts.id),
        eq(deliveryEvidence.attemptId, channelAttempts.id),
      ),
    )
    .leftJoin(
      devicePushTokenRegistrations,
      eq(devicePushTokenRegistrations.id, channelAttempts.endpointId),
    )
    .where(
      and(
        eq(channelAttempts.rosterSnapshotId, input.rosterSnapshotId),
        eq(channelAttempts.recipientId, input.recipientId),
        eq(channelAttempts.endpointId, input.endpointId),
        eq(channelAttempts.channel, 'push'),
        eq(deliveryEvidence.state, 'failed'),
        deliveryProviderPredicate,
        eq(deliveryEvidence.reasonCode, input.reasonCode),
        lte(deliveryEvidence.recordedAt, recordedAt),
      ),
    )
    .orderBy(
      desc(channelAttempts.attemptedAt),
      desc(deliveryEvidence.recordedAt),
      desc(deliveryEvidence.id),
    )
    .limit(1);
  if (evidence === undefined) {
    throw deviceConflict(
      'Endpoint invalidation requires retained provider failure evidence.',
    );
  }
  const attemptedAt = new Date(evidence.attemptedAt);
  const evidenceRecordedAt = new Date(evidence.evidenceRecordedAt);
  const providerOccurredAt =
    evidence.providerOccurredAt === null
      ? null
      : new Date(evidence.providerOccurredAt);
  if (
    !Number.isFinite(attemptedAt.getTime()) ||
    !Number.isFinite(evidenceRecordedAt.getTime()) ||
    attemptedAt.getTime() > evidenceRecordedAt.getTime() ||
    evidenceRecordedAt.getTime() > recordedAt.getTime()
  ) {
    throw deviceConflict(
      'Endpoint invalidation provider evidence has inconsistent time.',
    );
  }
  if (input.reasonCode === 'APNS_UNREGISTERED') {
    if (
      input.providerOccurredAt === undefined ||
      providerOccurredAt === null ||
      !Number.isFinite(providerOccurredAt.getTime()) ||
      providerOccurredAt.toISOString() !== input.providerOccurredAt ||
      providerOccurredAt.getTime() > evidenceRecordedAt.getTime() + 300_000
    ) {
      throw deviceConflict(
        'APNs invalidation requires matching provider occurrence evidence.',
      );
    }
  } else if (providerOccurredAt !== null) {
    throw deviceConflict(
      'Endpoint invalidation provider occurrence evidence is inconsistent.',
    );
  }
  return Object.freeze({
    attemptedAt: providerOccurredAt ?? attemptedAt,
    deviceEnrollmentId: evidence.deviceEnrollmentId,
  });
}

async function recordEndpointStatusWithDatabase(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'record-endpoint-status'>,
  recordedAt: Date,
): Promise<EndpointStatusRecord> {
  const [endpoint] = await database
    .select()
    .from(rosterEndpoints)
    .where(
      and(
        eq(rosterEndpoints.rosterSnapshotId, input.rosterSnapshotId),
        eq(rosterEndpoints.recipientId, input.recipientId),
        eq(rosterEndpoints.id, input.endpointId),
      ),
    )
    .limit(1);
  if (endpoint === undefined) {
    throw deviceNotFound('The snapshotted endpoint was not found.');
  }
  if (
    endpoint.channel !== 'push' ||
    endpoint.platform === null ||
    endpoint.provider === null ||
    endpoint.serviceEnvironment === null ||
    endpoint.token === null
  ) {
    throw deviceConflict('The endpoint is not a push registration.');
  }

  const [registration] = await database
    .select()
    .from(devicePushTokenRegistrations)
    .where(eq(devicePushTokenRegistrations.id, endpoint.id))
    .limit(1);
  if (registration !== undefined) {
    if (
      registration.platform !== endpoint.platform ||
      registration.provider !== endpoint.provider ||
      registration.serviceEnvironment !== endpoint.serviceEnvironment ||
      registration.token !== endpoint.token
    ) {
      throw deviceConflict(
        'The snapshotted endpoint no longer matches its registration.',
      );
    }
  }

  await lockPushToken(database, endpoint.provider, endpoint.token);
  const failure = await requirePushEndpointInvalidationAttempt(
    database,
    input,
    endpoint.provider,
    recordedAt,
  );
  await appendActivePushTokenUnregistrations(
    database,
    endpoint.provider,
    endpoint.token,
    failure.attemptedAt,
    failure.deviceEnrollmentId,
    recordedAt,
  );

  const [existing] = await database
    .select()
    .from(endpointStatusRecords)
    .where(
      and(
        eq(endpointStatusRecords.rosterSnapshotId, input.rosterSnapshotId),
        eq(endpointStatusRecords.recipientId, input.recipientId),
        eq(endpointStatusRecords.endpointId, input.endpointId),
        eq(endpointStatusRecords.status, input.status),
        eq(endpointStatusRecords.reasonCode, input.reasonCode),
      ),
    )
    .orderBy(
      asc(endpointStatusRecords.recordedAt),
      asc(endpointStatusRecords.id),
    )
    .limit(1);
  if (existing !== undefined) return endpointStatusFromRow(existing);

  const [inserted] = await database
    .insert(endpointStatusRecords)
    .values({
      rosterSnapshotId: endpoint.rosterSnapshotId,
      recipientId: endpoint.recipientId,
      endpointId: endpoint.id,
      population: endpoint.population,
      channel: endpoint.channel,
      status: input.status,
      reasonCode: input.reasonCode,
      recordedAt,
    })
    .returning();
  if (inserted === undefined) {
    throw deviceConflict('Endpoint status evidence could not be appended.');
  }
  return endpointStatusFromRow(inserted);
}

function parseRegistrationReference(reference: string): {
  readonly deviceEnrollmentId: string;
  readonly platform: NativePlatform;
  readonly provider: 'expo' | 'apns' | 'fcm';
  readonly serviceEnvironment: 'development' | 'production';
} | null {
  const match =
    /^push-registration:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(ios|android):(expo|apns|fcm):(development|production)$/u.exec(
      reference,
    );
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    return null;
  }
  return {
    deviceEnrollmentId: match[1],
    platform: match[2] as NativePlatform,
    provider: match[3] as 'expo' | 'apns' | 'fcm',
    serviceEnvironment: match[4] as 'development' | 'production',
  };
}

function parseUnregistrationReference(
  reference: string,
): { readonly deviceEnrollmentId: string } | null {
  const match =
    /^push-unregistration:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
      reference,
    );
  return match?.[1] === undefined ? null : { deviceEnrollmentId: match[1] };
}

function parseEndpointStatusReference(reference: string): string | null {
  const match =
    /^endpoint-status:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
      reference,
    );
  return match?.[1] ?? null;
}

async function loadPushTokenRegistrationReplayFromDatabase(
  database: DeviceQueryDatabase,
  reference: string,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<PushTokenRegistrationReceipt | null> {
  const parsed = parseRegistrationReference(reference);
  if (parsed === null) return null;
  const device = await lockCurrentNativeDevice(
    database,
    parsed.deviceEnrollmentId,
    actor,
    parsed.platform,
  );
  return PushTokenRegistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    platform: device.platform,
    provider: parsed.provider,
    serviceEnvironment: parsed.serviceEnvironment,
    status: 'registered',
  });
}

async function loadPushTokenUnregistrationReplayFromDatabase(
  database: DeviceQueryDatabase,
  reference: string,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<PushTokenUnregistrationReceipt | null> {
  const parsed = parseUnregistrationReference(reference);
  if (parsed === null) return null;
  const device = await lockCurrentNativeDevice(
    database,
    parsed.deviceEnrollmentId,
    actor,
    null,
  );
  return PushTokenUnregistrationReceiptSchema.parse({
    deviceEnrollmentId: device.id,
    status: 'unregistered',
  });
}

async function loadEndpointStatusReplayFromDatabase(
  database: DeviceQueryDatabase,
  reference: string,
): Promise<EndpointStatusRecord | null> {
  const id = parseEndpointStatusReference(reference);
  if (id === null) return null;
  const [row] = await database
    .select()
    .from(endpointStatusRecords)
    .where(eq(endpointStatusRecords.id, id))
    .limit(1);
  return row === undefined ? null : endpointStatusFromRow(row);
}

const PERSISTENCE = Object.freeze({ subject: 'Device' });

function createDrizzleDeviceTransaction(
  database: DeviceQueryDatabase,
): DeviceCapabilityTransaction {
  return {
    readCurrentTime: () => readSharedDatabaseTime(database, PERSISTENCE),
    claimIdempotency: (input) =>
      claimSharedIdempotency(database, input, PERSISTENCE),
    completeIdempotency: (input) =>
      completeSharedIdempotency(database, input, PERSISTENCE),
    // Device capabilities have no human-confirmation policy by contract.
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) =>
      appendSharedCapabilityAuditEntry(database, event, PERSISTENCE),
    registerPushToken: (input, actor, registeredAt) =>
      registerPushTokenWithDatabase(database, input, actor, registeredAt),
    unregisterPushToken: (input, actor, unregisteredAt) =>
      unregisterPushTokenWithDatabase(database, input, actor, unregisteredAt),
    listMyDevices: (input, actor) =>
      listMyDevicesWithDatabase(database, input, actor),
    recordEndpointStatus: (input, recordedAt) =>
      recordEndpointStatusWithDatabase(database, input, recordedAt),
    loadPushTokenRegistrationReplay: (reference, actor) =>
      loadPushTokenRegistrationReplayFromDatabase(database, reference, actor),
    loadPushTokenUnregistrationReplay: (reference, actor) =>
      loadPushTokenUnregistrationReplayFromDatabase(database, reference, actor),
    loadEndpointStatusReplay: (reference) =>
      loadEndpointStatusReplayFromDatabase(database, reference),
  };
}

/** Creates the production one-transaction device capability persistence. */
export function createDrizzleDeviceCapabilityStore(
  database: Database,
): DeviceCapabilityStore {
  return {
    transaction<Result>(
      operation: (transaction: DeviceCapabilityTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) =>
        operation(
          createDrizzleDeviceTransaction(deviceQueryDatabase(transaction)),
        ),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction(async (transaction) =>
        appendSharedCapabilityAuditEntry(
          deviceQueryDatabase(transaction),
          event,
          PERSISTENCE,
        ),
      );
    },
  };
}

/** Runtime shared by authenticated device routes and the push worker route. */
export interface DeviceCapabilityRuntime {
  readonly store: DeviceCapabilityStore;
  execute<Id extends DeviceCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  checkPushEndpointSendEligibility(input: unknown): Promise<boolean>;
  close(): Promise<void>;
}

/** Builds a device capability runtime around one managed DB connection. */
export function createDeviceCapabilityRuntime(
  connection: DatabaseConnection,
): DeviceCapabilityRuntime {
  const store = createDrizzleDeviceCapabilityStore(connection.db);
  const eligibilityStore = createDrizzlePushEndpointSendEligibilityStore(
    connection.db,
  );
  return {
    store,
    execute: (capabilityId, input, invocation) =>
      executeDeviceCapability(capabilityId, input, invocation, store),
    checkPushEndpointSendEligibility: (input) =>
      checkPushEndpointSendEligibility(input, eligibilityStore),
    close: () => connection.close(),
  };
}

let defaultDeviceCapabilityRuntime: DeviceCapabilityRuntime | undefined;

/** Lazily creates the database-backed runtime used by device REST routes. */
export function getDefaultDeviceCapabilityRuntime(): DeviceCapabilityRuntime {
  defaultDeviceCapabilityRuntime ??= createDeviceCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultDeviceCapabilityRuntime;
}

/** Closes and clears the lazily created default device runtime. */
export async function closeDefaultDeviceCapabilityRuntime(): Promise<void> {
  const runtime = defaultDeviceCapabilityRuntime;
  defaultDeviceCapabilityRuntime = undefined;
  await runtime?.close();
}
