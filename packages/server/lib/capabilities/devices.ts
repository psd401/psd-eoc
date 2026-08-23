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
  SecurityAuditEntrySchema,
  type Actor,
  type CapabilityInput,
  type CapabilityOutput,
  type DeviceEnrollmentPage,
  type DeliveryTestNotificationMetadata,
  type DispatchBatch,
  type EndpointStatus,
  type EndpointStatusRecord,
  type PushEndpoint,
  type PushEndpointSendEligibilityInput,
  type PushTokenRegistrationReceipt,
  type PushTokenUnregistrationReceipt,
  type RegisteredCapabilityId,
} from '@psd-eoc/contracts';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../db/client';
import {
  channelAttempts,
  deliveryEvidence,
  deliveryTestCanaryEligibilityFacts,
  deliveryTestTargetEndpoints,
  deliveryTestTargetSetVersions,
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  idempotencyRecords,
  rosterEndpoints,
  securityAuditChainAnchors,
  securityAuditEntries,
  sessionRevocations,
  sessions,
} from '../../db/schema';
import {
  buildSecurityAuditEntry,
  canonicalSecurityAuditJson,
  parseSecurityAuditFact,
  SECURITY_AUDIT_APPEND_LOCK_SQL,
  securityAuditFactFromEntry,
  toSecurityAuditInsertValues,
} from '../audit';
import { resolveAudience, type ResolveAudienceInput } from '../roster/resolve';
import {
  DELIVERY_TEST_TARGET_LOCK_NAMESPACE,
  deliveryTestEndpointReferenceDigest,
  deliveryTestTargetLockIdentity,
} from '../testing/e2e-delivery';

import {
  CapabilityEngineError,
  executeCapability,
  readCapabilityTime,
  type CapabilityAuditEvent,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type CapabilityHandlerContext,
  type ClaimIdempotencyInput,
  type CompleteIdempotencyInput,
  type IdempotencyClaim,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';

/** The one worker identity accepted by the push endpoint-invalidation route. */
export const PUSH_ENDPOINT_INVALIDATION_SERVICE_ID =
  'push-endpoint-invalidation-worker' as const;

/** Provider-terminal reason retained without copying the rejected token. */
export const EXPO_DEVICE_NOT_REGISTERED_REASON =
  'EXPO_DEVICE_NOT_REGISTERED' as const;

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
  /** Required when delivery-test target evidence must be checked. */
  readonly endpointCount?: number;
  /** Omitted for ordinary push-policy reads that have no canary authority. */
  readonly deliveryTest?: DeliveryTestNotificationMetadata | null;
  readonly candidates: readonly PushEndpointPolicyCandidate[];
}

interface NormalizedPushEndpointPolicyQuery extends PushEndpointPolicyQuery {
  readonly endpointCount: number;
  readonly deliveryTest: DeliveryTestNotificationMetadata | null;
}

export interface PushEndpointPolicyEvidence
  extends PushEndpointPolicyCandidate {
  readonly status: EndpointStatus;
  readonly approvedForDeliveryTest?: boolean;
}

interface ParsedPushEndpointPolicyEvidence extends PushEndpointPolicyCandidate {
  readonly status: EndpointStatus;
  readonly approvedForDeliveryTest: boolean;
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

interface PushEndpointSendEligibilityEvidence {
  readonly rosterSnapshotId: string;
  readonly rosterPopulation: 'staff' | 'synthetic';
  readonly recipientId: string;
  readonly endpointId: string;
  readonly platform: 'ios' | 'android';
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
      const propertiesWithApproval =
        slot !== undefined &&
        slot.enumerable === true &&
        Object.hasOwn(slot, 'value')
          ? exactDataRecord(slot.value, [
              'recipientId',
              'endpointId',
              'status',
              'approvedForDeliveryTest',
            ])
          : null;
      const ordinaryProperties =
        propertiesWithApproval === null &&
        query.deliveryTest == null &&
        slot !== undefined &&
        slot.enumerable === true &&
        Object.hasOwn(slot, 'value')
          ? exactDataRecord(slot.value, ['recipientId', 'endpointId', 'status'])
          : null;
      const properties = propertiesWithApproval ?? ordinaryProperties;
      const status = EndpointStatusSchema.safeParse(properties?.status);
      if (
        properties === null ||
        typeof properties.recipientId !== 'string' ||
        typeof properties.endpointId !== 'string' ||
        (propertiesWithApproval !== null &&
          typeof properties.approvedForDeliveryTest !== 'boolean') ||
        (query.deliveryTest != null && propertiesWithApproval === null) ||
        !status.success
      ) {
        throw new TypeError();
      }
      const item = Object.freeze({
        recipientId: properties.recipientId,
        endpointId: properties.endpointId,
        status: status.data,
        approvedForDeliveryTest:
          query.deliveryTest == null
            ? true
            : (properties.approvedForDeliveryTest as boolean),
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
    parsed.data.integrationStatus.integrationId !== 'expo-push'
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
export async function resolvePushEndpoints(
  input: ResolvePushEndpointsInput,
  store: PushEndpointPolicyStore,
): Promise<readonly ResolvedPushEndpoint[]> {
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
  if (batch.deliveryTest == null && candidates.length !== batch.endpointCount) {
    throw new PushEndpointResolutionError('PUSH_ENDPOINT_COUNT_MISMATCH');
  }
  const query = Object.freeze({
    rosterSnapshotId: batch.rosterSnapshotId,
    rosterPopulation: batch.rosterPopulation,
    endpointCount: batch.endpointCount,
    deliveryTest: batch.deliveryTest ?? null,
    candidates: Object.freeze(
      candidates.map(({ recipientId, endpoint }) =>
        Object.freeze({ recipientId, endpointId: endpoint.id }),
      ),
    ),
  });
  let rawPolicy: unknown;
  try {
    rawPolicy = await store.loadEndpointPolicy(query);
  } catch {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const policy = parsePushEndpointPolicyEvidence(rawPolicy, query);
  const approvedCount = [...policy.values()].filter(
    ({ approvedForDeliveryTest }) => approvedForDeliveryTest,
  ).length;
  if (batch.deliveryTest != null && approvedCount !== batch.endpointCount) {
    throw new PushEndpointResolutionError('PUSH_ENDPOINT_COUNT_MISMATCH');
  }
  return Object.freeze(
    candidates.flatMap(({ recipientId, endpoint }) => {
      const evidence = policy.get(
        pushCandidateKey({ recipientId, endpointId: endpoint.id }),
      );
      return evidence?.status === 'active' && evidence.approvedForDeliveryTest
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

async function loadPushDeliveryTestTargets(
  database: DeviceQueryDatabase,
  query: NormalizedPushEndpointPolicyQuery,
): Promise<ReadonlySet<string> | null> {
  if (query.deliveryTest === null) return null;
  if (query.rosterPopulation !== 'staff') {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }

  // Resolve only the facility needed for the shared lineage lock, then reload
  // every target fact after acquiring it. Under READ COMMITTED this makes a
  // successor or revocation that won the lock visible before any token leaves
  // the trusted resolver boundary.
  const [unlockedTarget] = await database
    .select({ facilityId: deliveryTestTargetSetVersions.facilityId })
    .from(deliveryTestTargetSetVersions)
    .where(
      and(
        eq(deliveryTestTargetSetVersions.id, query.deliveryTest.targetSet.id),
        eq(
          deliveryTestTargetSetVersions.version,
          query.deliveryTest.targetSet.version,
        ),
      ),
    )
    .limit(1);
  if (unlockedTarget === undefined) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${deliveryTestTargetLockIdentity(unlockedTarget.facilityId)}, ${DELIVERY_TEST_TARGET_LOCK_NAMESPACE}))`,
  );

  const [target] = await database
    .select({
      id: deliveryTestTargetSetVersions.id,
      version: deliveryTestTargetSetVersions.version,
      facilityId: deliveryTestTargetSetVersions.facilityId,
      rosterSnapshotId: deliveryTestTargetSetVersions.rosterSnapshotId,
      rosterPopulation: deliveryTestTargetSetVersions.rosterPopulation,
      endpointReferenceDigest:
        deliveryTestTargetSetVersions.endpointReferenceDigest,
    })
    .from(deliveryTestTargetSetVersions)
    .where(
      and(
        eq(deliveryTestTargetSetVersions.id, query.deliveryTest.targetSet.id),
        eq(
          deliveryTestTargetSetVersions.version,
          query.deliveryTest.targetSet.version,
        ),
      ),
    )
    .limit(1);
  const [successor] = await database
    .select({ id: deliveryTestTargetSetVersions.id })
    .from(deliveryTestTargetSetVersions)
    .where(
      eq(
        deliveryTestTargetSetVersions.supersedesVersionId,
        query.deliveryTest.targetSet.id,
      ),
    )
    .limit(1);
  if (
    target === undefined ||
    target.facilityId !== unlockedTarget.facilityId ||
    target.rosterSnapshotId !== query.rosterSnapshotId ||
    target.rosterPopulation !== 'staff' ||
    target.endpointReferenceDigest !==
      query.deliveryTest.endpointReferenceDigest ||
    successor !== undefined
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }

  const targetRows = await database
    .select({
      rosterSnapshotId: deliveryTestTargetEndpoints.rosterSnapshotId,
      rosterPopulation: deliveryTestTargetEndpoints.rosterPopulation,
      recipientId: deliveryTestTargetEndpoints.recipientId,
      endpointId: deliveryTestTargetEndpoints.endpointId,
      channel: deliveryTestTargetEndpoints.channel,
      attestation: deliveryTestTargetEndpoints.attestation,
      eligibilityFacilityId: deliveryTestCanaryEligibilityFacts.facilityId,
      eligibilityRosterSnapshotId:
        deliveryTestCanaryEligibilityFacts.rosterSnapshotId,
      eligibilityRosterPopulation:
        deliveryTestCanaryEligibilityFacts.rosterPopulation,
      eligibilityRecipientId: deliveryTestCanaryEligibilityFacts.recipientId,
      eligibilityEndpointId: deliveryTestCanaryEligibilityFacts.endpointId,
      eligibilityChannel: deliveryTestCanaryEligibilityFacts.channel,
      eligibilityCurrent: sql<boolean>`
        ${deliveryTestCanaryEligibilityFacts.decision} = 'approved-synthetic-canary'
        and not exists (
          select 1
          from delivery_test_canary_eligibility_facts successor
          where successor.supersedes_fact_id = ${deliveryTestCanaryEligibilityFacts.id}
        )
      `,
    })
    .from(deliveryTestTargetEndpoints)
    .innerJoin(
      deliveryTestCanaryEligibilityFacts,
      eq(
        deliveryTestTargetEndpoints.eligibilityFactId,
        deliveryTestCanaryEligibilityFacts.id,
      ),
    )
    .where(
      and(
        eq(deliveryTestTargetEndpoints.targetSetVersionId, target.id),
        eq(deliveryTestTargetEndpoints.targetSetVersion, target.version),
      ),
    )
    .orderBy(
      asc(deliveryTestTargetEndpoints.channel),
      asc(deliveryTestTargetEndpoints.recipientId),
      asc(deliveryTestTargetEndpoints.endpointId),
    );
  if (
    targetRows.length === 0 ||
    targetRows.length > MAX_PUSH_ENDPOINTS ||
    targetRows.some(
      (target) =>
        target.rosterSnapshotId !== query.rosterSnapshotId ||
        target.rosterPopulation !== 'staff' ||
        target.attestation !== 'approved-synthetic-canary' ||
        target.eligibilityFacilityId !== unlockedTarget.facilityId ||
        target.eligibilityRosterSnapshotId !== target.rosterSnapshotId ||
        target.eligibilityRosterPopulation !== target.rosterPopulation ||
        target.eligibilityRecipientId !== target.recipientId ||
        target.eligibilityEndpointId !== target.endpointId ||
        target.eligibilityChannel !== target.channel ||
        !target.eligibilityCurrent,
    )
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  let targetDigest: string;
  try {
    targetDigest = deliveryTestEndpointReferenceDigest(targetRows);
  } catch {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  if (
    targetDigest !== target.endpointReferenceDigest ||
    targetDigest !== query.deliveryTest.endpointReferenceDigest
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const pushTargets = targetRows.filter(({ channel }) => channel === 'push');
  const candidateKeys = new Set(query.candidates.map(pushCandidateKey));
  if (
    pushTargets.length !== query.endpointCount ||
    pushTargets.some((target) => !candidateKeys.has(pushCandidateKey(target)))
  ) {
    throw new PushEndpointResolutionError('PUSH_ENDPOINT_COUNT_MISMATCH');
  }
  return new Set(pushTargets.map(pushCandidateKey));
}

function normalizePushEndpointPolicyQuery(
  query: PushEndpointPolicyQuery,
): NormalizedPushEndpointPolicyQuery {
  if (!Array.isArray(query.candidates)) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  const deliveryTest = query.deliveryTest ?? null;
  const endpointCount = query.endpointCount ?? query.candidates.length;
  if (
    !Number.isSafeInteger(endpointCount) ||
    endpointCount < 0 ||
    endpointCount > MAX_PUSH_ENDPOINTS ||
    (deliveryTest !== null && query.endpointCount === undefined) ||
    (deliveryTest === null && endpointCount !== query.candidates.length)
  ) {
    throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
  }
  return Object.freeze({
    rosterSnapshotId: query.rosterSnapshotId,
    rosterPopulation: query.rosterPopulation,
    endpointCount,
    deliveryTest,
    candidates: query.candidates,
  });
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
  const approvedTargets = await loadPushDeliveryTestTargets(database, query);
  if (query.candidates.length === 0) return Object.freeze([]);
  const endpointIds = query.candidates.map(({ endpointId }) => endpointId);
  const endpointRows = await database
    .select({
      endpointId: rosterEndpoints.id,
      recipientId: rosterEndpoints.recipientId,
      status: rosterEndpoints.status,
      registrationId: devicePushTokenRegistrations.id,
      registrationDeviceEnrollmentId:
        devicePushTokenRegistrations.deviceEnrollmentId,
      registrationMatchesEndpoint: sql<boolean | null>`case
        when ${devicePushTokenRegistrations.id} is null then null
        else ${devicePushTokenRegistrations.platform}::text = ${rosterEndpoints.platform}::text
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
    const hasRegistration = endpoint.registrationId !== null;
    const hasUnregistration =
      endpoint.unregisteredRegistrationId !== null ||
      endpoint.unregisteredDeviceEnrollmentId !== null;
    if (
      (query.rosterPopulation === 'staff' && !hasRegistration) ||
      (hasRegistration && endpoint.registrationMatchesEndpoint !== true) ||
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
    if (
      status.status !== 'invalid' ||
      status.reasonCode !== EXPO_DEVICE_NOT_REGISTERED_REASON ||
      status.provider !== null ||
      status.providerReference !== null ||
      status.providerOccurredAt !== null
    ) {
      throw new PushEndpointResolutionError('INVALID_PUSH_ENDPOINT_POLICY');
    }
    effectiveStatuses.set(pushCandidateKey(status), 'invalid');
  });
  return Object.freeze(
    endpointRows
      .map((endpoint) =>
        Object.freeze({
          recipientId: endpoint.recipientId,
          endpointId: endpoint.endpointId,
          status:
            effectiveStatuses.get(pushCandidateKey(endpoint)) ??
            EndpointStatusSchema.parse(endpoint.status),
          ...(approvedTargets === null
            ? {}
            : {
                approvedForDeliveryTest: approvedTargets.has(
                  pushCandidateKey(endpoint),
                ),
              }),
        }),
      )
      .sort(
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
  if (
    (row.platform !== 'ios' && row.platform !== 'android') ||
    typeof row.token !== 'string'
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
    tokenDigest: createHash('sha256').update(row.token, 'utf8').digest('hex'),
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
    input.reasonCode !== EXPO_DEVICE_NOT_REGISTERED_REASON
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
  return `push-registration:${output.deviceEnrollmentId}:${output.platform}`;
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
  return executeCapability(registration, input, invocation, store);
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
}

const MAX_ACTIVE_PUSH_REGISTRATIONS_PER_DEVICE = 100;
const PUSH_TOKEN_ADVISORY_LOCK_NAMESPACE = 12_012;

function pushTokenLockDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Serializes one opaque token without exposing token material to lock telemetry. */
async function lockPushToken(
  database: DeviceQueryDatabase,
  token: string,
): Promise<void> {
  const digest = pushTokenLockDigest(token);
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${digest}, ${PUSH_TOKEN_ADVISORY_LOCK_NAMESPACE}))`,
  );
}

async function assertPushTokenAvailableForDevice(
  database: DeviceQueryDatabase,
  deviceEnrollmentId: string,
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
  token: string,
  registeredAt: Date,
): Promise<PushTokenFailureCutoff | null> {
  const failure = await latestPushTokenFailureCutoff(
    database,
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
  token: string,
  observedThrough: Date,
): Promise<PushTokenFailureCutoff | null> {
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
        eq(deliveryEvidence.reasonCode, EXPO_DEVICE_NOT_REGISTERED_REASON),
        lte(deliveryEvidence.recordedAt, observedThrough),
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
  activeRegistrations: readonly Readonly<{ id: string; token: string }>[],
  requestedToken: string,
): Readonly<{
  keepRegistrationId: string | null;
  registrationRequired: boolean;
  unregisterRegistrationIds: readonly string[];
}> {
  const matching = activeRegistrations.find(
    (registration) => registration.token === requestedToken,
  );
  return Object.freeze({
    keepRegistrationId: matching?.id ?? null,
    registrationRequired: matching === undefined,
    unregisterRegistrationIds: activeRegistrations
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

async function registerPushTokenWithDatabase(
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
  await lockPushToken(database, input.token);
  const priorFailure = await assertPushTokenRegistrationAllowed(
    database,
    device.id,
    input.token,
    registeredAt,
  );
  await assertPushTokenAvailableForDevice(database, device.id, input.token);
  const active = await activePushRegistrations(database, device.id);
  const plan = planPushTokenRegistration(active, input.token);
  const keptRegistration = active.find(
    (registration) => registration.id === plan.keepRegistrationId,
  );
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
      ...(rotateStaleGeneration && plan.keepRegistrationId !== null
        ? [plan.keepRegistrationId]
        : []),
    ],
    registeredAt,
  );
  if (plan.registrationRequired || rotateStaleGeneration) {
    const [inserted] = await database
      .insert(devicePushTokenRegistrations)
      .values({
        deviceEnrollmentId: device.id,
        platform: device.platform,
        token: input.token,
        registeredAt,
      })
      .returning({
        deviceEnrollmentId: devicePushTokenRegistrations.deviceEnrollmentId,
        platform: devicePushTokenRegistrations.platform,
        token: devicePushTokenRegistrations.token,
      });
    if (
      inserted === undefined ||
      inserted.deviceEnrollmentId !== device.id ||
      inserted.platform !== device.platform ||
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
    status: 'registered',
  });
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

async function requireDeviceNotRegisteredAttempt(
  database: DeviceQueryDatabase,
  input: CapabilityInput<'record-endpoint-status'>,
  recordedAt: Date,
): Promise<PushTokenFailureCutoff> {
  const [evidence] = await database
    .select({
      attemptedAt: channelAttempts.attemptedAt,
      evidenceRecordedAt: deliveryEvidence.recordedAt,
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
        eq(deliveryEvidence.reasonCode, EXPO_DEVICE_NOT_REGISTERED_REASON),
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
  return Object.freeze({
    attemptedAt,
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
      registration.token !== endpoint.token
    ) {
      throw deviceConflict(
        'The snapshotted endpoint no longer matches its registration.',
      );
    }
  }

  await lockPushToken(database, endpoint.token);
  const failure = await requireDeviceNotRegisteredAttempt(
    database,
    input,
    recordedAt,
  );
  await appendActivePushTokenUnregistrations(
    database,
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
} | null {
  const match =
    /^push-registration:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(ios|android)$/u.exec(
      reference,
    );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return {
    deviceEnrollmentId: match[1],
    platform: match[2] as NativePlatform,
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

async function readDatabaseTime(database: DeviceQueryDatabase): Promise<Date> {
  const [row] = databaseExecuteRows(
    await database.execute<{ value: Date | string }>(
      sql`select clock_timestamp() as value`,
    ),
  );
  if (row === undefined) {
    throw deviceConflict('The authoritative database clock is unavailable.');
  }
  return new Date(dateIso(row.value));
}

async function claimIdempotency(
  database: DeviceQueryDatabase,
  input: ClaimIdempotencyInput,
): Promise<IdempotencyClaim> {
  const [inserted] = await database
    .insert(idempotencyRecords)
    .values({
      capabilityId: input.capabilityId,
      principal: input.actor,
      principalDigest: input.principalDigest,
      key: input.key,
      requestDigest: input.requestDigest,
      status: 'in-progress',
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        idempotencyRecords.capabilityId,
        idempotencyRecords.principalDigest,
        idempotencyRecords.key,
      ],
    })
    .returning({ id: idempotencyRecords.id });
  if (inserted !== undefined) {
    return { kind: 'new', recordId: inserted.id };
  }
  const [existing] = await database
    .select({
      requestDigest: idempotencyRecords.requestDigest,
      status: idempotencyRecords.status,
      resultReference: idempotencyRecords.resultReference,
    })
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.capabilityId, input.capabilityId),
        eq(idempotencyRecords.principalDigest, input.principalDigest),
        eq(idempotencyRecords.key, input.key),
      ),
    )
    .for('update')
    .limit(1);
  if (existing === undefined) {
    throw deviceConflict('The device request replay could not be resolved.');
  }
  if (existing.status === 'completed' && existing.resultReference !== null) {
    return {
      kind: 'completed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  if (existing.status === 'failed' && existing.resultReference !== null) {
    return {
      kind: 'failed',
      requestDigest: existing.requestDigest,
      resultReference: existing.resultReference,
    };
  }
  return { kind: 'in-progress', requestDigest: existing.requestDigest };
}

async function completeIdempotency(
  database: DeviceQueryDatabase,
  input: CompleteIdempotencyInput,
): Promise<void> {
  const [updated] = await database
    .update(idempotencyRecords)
    .set({
      status: 'completed',
      completedAt: input.completedAt,
      resultReference: input.resultReference,
    })
    .where(
      and(
        eq(idempotencyRecords.id, input.recordId),
        eq(idempotencyRecords.status, 'in-progress'),
      ),
    )
    .returning({ id: idempotencyRecords.id });
  if (updated === undefined) {
    throw deviceConflict('The device request replay could not be completed.');
  }
}

function securityAuditEntryFromRow(
  row: typeof securityAuditEntries.$inferSelect,
) {
  return SecurityAuditEntrySchema.parse({
    id: row.id,
    sequence: row.sequence,
    previousHash: row.previousHash,
    entryHash: row.entryHash,
    category: row.category,
    action: row.action,
    actionIds: row.actionIds,
    confirmationId: row.confirmationId,
    outcome: row.outcome,
    principal: row.principal,
    source: row.source,
    facilityId: row.facilityId,
    target:
      row.targetKind === null || row.targetId === null
        ? null
        : { kind: row.targetKind, id: row.targetId },
    requestId: row.requestId,
    reasonCode: row.reasonCode,
    occurredAt: dateIso(row.occurredAt),
  });
}

async function appendCapabilityAuditEntry(
  database: DeviceQueryDatabase,
  event: CapabilityAuditEvent,
): Promise<void> {
  const fact = parseSecurityAuditFact({
    category: event.category,
    action: event.action,
    actionIds: event.actionIds,
    confirmationId: event.confirmationId,
    outcome: event.outcome,
    principal: event.actor,
    source: event.source,
    facilityId: event.facilityId,
    target: { kind: 'capability', id: event.action },
    requestId: event.requestId,
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt.toISOString(),
  });
  await database.execute(SECURITY_AUDIT_APPEND_LOCK_SQL);
  const [existingRow] = await database
    .select()
    .from(securityAuditEntries)
    .where(eq(securityAuditEntries.requestId, fact.requestId))
    .limit(1)
    .for('share');
  if (existingRow !== undefined) {
    const existing = securityAuditEntryFromRow(existingRow);
    if (
      canonicalSecurityAuditJson(securityAuditFactFromEntry(existing)) ===
      canonicalSecurityAuditJson(fact)
    ) {
      return;
    }
    throw deviceConflict(
      'The audit request is already bound to different evidence.',
    );
  }
  const [anchor] = await database
    .select({
      sequence: securityAuditChainAnchors.sequence,
      entryHash: securityAuditChainAnchors.entryHash,
    })
    .from(securityAuditChainAnchors)
    .orderBy(desc(securityAuditChainAnchors.sequence))
    .limit(1)
    .for('share');
  const entry = buildSecurityAuditEntry(
    fact,
    anchor === undefined ? null : anchor,
  );
  await database
    .insert(securityAuditEntries)
    .values(toSecurityAuditInsertValues(entry));
}

function createDrizzleDeviceTransaction(
  database: DeviceQueryDatabase,
): DeviceCapabilityTransaction {
  return {
    readCurrentTime: () => readDatabaseTime(database),
    claimIdempotency: (input) => claimIdempotency(database, input),
    completeIdempotency: (input) => completeIdempotency(database, input),
    // Device capabilities have no human-confirmation policy by contract.
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) =>
      appendCapabilityAuditEntry(database, event),
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
        appendCapabilityAuditEntry(deviceQueryDatabase(transaction), event),
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
