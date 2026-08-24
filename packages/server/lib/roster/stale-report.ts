import {
  EndpointIdSchema,
  EndpointStatusSchema,
  FacilityScopeSchema,
  NotificationChannelSchema,
  RecipientIdSchema,
  RosterGroupFailureSchema,
  RosterHealthQuerySchema,
  RosterSnapshotIdSchema,
  SMS_LIFECYCLE_PROVIDER,
  SMS_OPT_OUT_REASON_CODE,
  SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
  StaleRosterReportSchema,
  TimestampSchema,
  UuidSchema,
  registerCapabilityHandler,
  type FacilityScope,
  type RegisteredCapabilityHandler,
  type RosterHealthQuery,
  type StaleRosterEndpoint,
  type StaleRosterRecipient,
  type StaleRosterReport,
} from '@psd-eoc/contracts';
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { Database, DatabaseQuery } from '../../db/client';
import {
  devicePushTokenUnregistrations,
  endpointStatusRecords,
  groupSources,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSyncGroupFailures,
  rosterSyncResults,
} from '../../db/schema';

const MAX_SCOPED_RECIPIENTS = 200;
const MAX_SCOPED_ENDPOINTS = MAX_SCOPED_RECIPIENTS * 10;

const ScopedRecipientHealthSchema = z
  .object({
    recipientId: RecipientIdSchema,
    endpointStatuses: z.array(EndpointStatusSchema).max(10).readonly(),
    pushEndpointStatuses: z.array(EndpointStatusSchema).max(10).readonly(),
  })
  .strict()
  .readonly();

const ScopedStaleEndpointSchema = z
  .object({
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    channel: NotificationChannelSchema,
    status: EndpointStatusSchema.exclude(['active']),
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u)
      .nullable(),
  })
  .strict()
  .readonly();

const LatestCompleteSnapshotEvidenceSchema = z
  .object({
    id: RosterSnapshotIdSchema,
    capturedAt: TimestampSchema,
    recipientHealth: z
      .array(ScopedRecipientHealthSchema)
      .max(MAX_SCOPED_RECIPIENTS)
      .readonly(),
    staleEndpoints: z
      .array(ScopedStaleEndpointSchema)
      .max(MAX_SCOPED_ENDPOINTS)
      .default([])
      .readonly(),
    /**
     * True when the scoped store omitted one or more stale recipients from
     * this bounded page. It prevents a partial page from claiming `current`.
     */
    hasUnreportedStaleRecipients: z.boolean(),
    hasUnreportedStaleEndpoints: z.boolean().default(false),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const recipientIds = snapshot.recipientHealth.map(
      ({ recipientId }) => recipientId,
    );
    if (new Set(recipientIds).size !== recipientIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Scoped recipient health rows must be unique.',
        path: ['recipientHealth'],
      });
    }
    const endpointIds = snapshot.staleEndpoints.map(
      ({ endpointId }) => endpointId,
    );
    if (new Set(endpointIds).size !== endpointIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Scoped stale endpoint rows must be unique.',
        path: ['staleEndpoints'],
      });
    }
  })
  .readonly();

const LatestFailedSyncEvidenceSchema = z
  .object({
    outcome: z.enum(['failed', 'partial-rejected']),
    completedAt: TimestampSchema,
    groupFailures: z.array(RosterGroupFailureSchema).min(1).max(500).readonly(),
  })
  .strict()
  .readonly();

const ScopedStaleRosterEvidenceSchema = z
  .object({
    latestCompleteSnapshot: LatestCompleteSnapshotEvidenceSchema.nullable(),
    /** Latest failed attempt relevant to this authorized, scoped query. */
    latestFailedSync: LatestFailedSyncEvidenceSchema.nullable(),
  })
  .strict()
  .readonly();

/** Minimized, endpoint-value-free evidence returned by the server store. */
export type ScopedStaleRosterEvidence = z.infer<
  typeof ScopedStaleRosterEvidenceSchema
>;

export type StaleRosterReportErrorCode =
  | 'INVALID_REPORT_CONFIGURATION'
  | 'INVALID_REPORT_EVIDENCE'
  | 'INVALID_REPORT_TIME';

/** Safe failure that never reflects endpoint values or provider responses. */
export class StaleRosterReportError extends Error {
  public readonly code: StaleRosterReportErrorCode;

  public constructor(code: StaleRosterReportErrorCode, message: string) {
    super(message);
    this.name = 'StaleRosterReportError';
    this.code = code;
  }
}

/**
 * Persistence boundary for an already authorized roster-health query.
 *
 * The implementation must apply the caller's facility/population scope and
 * opaque cursor while reading one consistent database view. It returns only
 * recipient IDs, endpoint statuses, and sanitized group-failure evidence;
 * contact destinations and display names never cross this boundary.
 */
export interface StaleRosterReportStore<Context> {
  loadScopedEvidence(
    query: RosterHealthQuery,
    context: Context,
  ): Promise<unknown>;
}

export interface GetStaleRosterReportDependencies<Context> {
  readonly store: StaleRosterReportStore<Context>;
  readonly clock: () => Date;
  readonly staleThresholdSeconds: number;
}

export interface BuildStaleRosterReportOptions {
  readonly generatedAt: Date;
  readonly staleThresholdSeconds: number;
}

function validateThreshold(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_CONFIGURATION',
      'The roster stale threshold must be a non-negative safe integer.',
    );
  }
  return value;
}

function validateGeneratedAt(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_TIME',
      'The roster report clock returned an invalid time.',
    );
  }
  return new Date(value.getTime());
}

function parseScopedEvidence(value: unknown): ScopedStaleRosterEvidence {
  const result = ScopedStaleRosterEvidenceSchema.safeParse(value);
  if (!result.success) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'Scoped roster health evidence was invalid.',
    );
  }
  return result.data;
}

function staleRecipientFor(
  recipient: z.infer<typeof ScopedRecipientHealthSchema>,
): StaleRosterRecipient | null {
  if (recipient.endpointStatuses.length === 0) {
    return Object.freeze({
      recipientId: recipient.recipientId,
      reason: 'no-endpoint',
    });
  }
  if (!recipient.endpointStatuses.includes('active')) {
    return Object.freeze({
      recipientId: recipient.recipientId,
      reason: 'no-active-endpoint',
    });
  }
  if (!recipient.pushEndpointStatuses.includes('active')) {
    return Object.freeze({
      recipientId: recipient.recipientId,
      reason: 'no-active-push-endpoint',
    });
  }
  return null;
}

function assertEvidenceTimes(
  evidence: ScopedStaleRosterEvidence,
  generatedAtMilliseconds: number,
): void {
  const snapshot = evidence.latestCompleteSnapshot;
  if (
    snapshot !== null &&
    Date.parse(snapshot.capturedAt) > generatedAtMilliseconds
  ) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'Roster snapshot evidence cannot be captured in the future.',
    );
  }

  const failure = evidence.latestFailedSync;
  if (failure === null) {
    return;
  }
  const completedAt = Date.parse(failure.completedAt);
  if (completedAt > generatedAtMilliseconds) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'Roster sync failure evidence cannot be completed in the future.',
    );
  }
  if (
    failure.groupFailures.some(
      ({ attemptedAt }) => Date.parse(attemptedAt) > completedAt,
    )
  ) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'Roster group failure evidence cannot follow sync completion.',
    );
  }
}

function buildFromParsedEvidence(
  evidence: ScopedStaleRosterEvidence,
  options: BuildStaleRosterReportOptions,
): StaleRosterReport {
  const staleThresholdSeconds = validateThreshold(
    options.staleThresholdSeconds,
  );
  const generatedAt = validateGeneratedAt(options.generatedAt);
  const generatedAtMilliseconds = generatedAt.getTime();
  assertEvidenceTimes(evidence, generatedAtMilliseconds);

  const snapshot = evidence.latestCompleteSnapshot;
  const staleRecipients =
    snapshot?.recipientHealth
      .map(staleRecipientFor)
      .filter(
        (recipient): recipient is StaleRosterRecipient => recipient !== null,
      )
      .sort((left, right) =>
        left.recipientId.localeCompare(right.recipientId),
      ) ?? [];
  const staleEndpoints =
    snapshot?.staleEndpoints
      .map(
        (endpoint): StaleRosterEndpoint =>
          Object.freeze({
            recipientId: endpoint.recipientId,
            endpointId: endpoint.endpointId,
            channel: endpoint.channel,
            reason:
              endpoint.channel === 'sms' &&
              endpoint.reasonCode === SMS_OPT_OUT_REASON_CODE
                ? 'sms-opted-out'
                : endpoint.status,
          }),
      )
      .sort(
        (left, right) =>
          left.recipientId.localeCompare(right.recipientId) ||
          left.endpointId.localeCompare(right.endpointId),
      ) ?? [];

  const latestCompleteCapturedAt = snapshot?.capturedAt ?? null;
  const latestCompleteAgeSeconds =
    snapshot === null
      ? null
      : Math.floor(
          (generatedAtMilliseconds - Date.parse(snapshot.capturedAt)) / 1_000,
        );

  const failure = evidence.latestFailedSync;
  const failureIsUnresolved =
    failure !== null &&
    (snapshot === null ||
      Date.parse(failure.completedAt) >= Date.parse(snapshot.capturedAt));
  const failedGroups = failureIsUnresolved
    ? [...failure.groupFailures].sort((left, right) => {
        const sourceOrder = left.groupSourceRef.id.localeCompare(
          right.groupSourceRef.id,
        );
        return sourceOrder !== 0
          ? sourceOrder
          : left.errorCode.localeCompare(right.errorCode);
      })
    : [];

  const status = (() => {
    if (failureIsUnresolved) {
      return 'failed' as const;
    }
    if (snapshot === null) {
      return 'unknown' as const;
    }
    if (
      (latestCompleteAgeSeconds ?? 0) > staleThresholdSeconds ||
      staleRecipients.length > 0 ||
      staleEndpoints.length > 0 ||
      snapshot.hasUnreportedStaleRecipients ||
      snapshot.hasUnreportedStaleEndpoints
    ) {
      return 'stale' as const;
    }
    return 'current' as const;
  })();

  const result = StaleRosterReportSchema.safeParse({
    generatedAt: generatedAt.toISOString(),
    status,
    latestCompleteSnapshotId: snapshot?.id ?? null,
    latestCompleteCapturedAt,
    latestCompleteAgeSeconds,
    failedGroups,
    staleRecipients,
    staleEndpoints,
  });
  if (!result.success) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'Scoped roster health evidence could not produce a valid report.',
    );
  }
  return result.data;
}

/** Builds a deterministic report from minimized, already scoped evidence. */
export function buildStaleRosterReport(
  evidence: unknown,
  options: BuildStaleRosterReportOptions,
): StaleRosterReport {
  return buildFromParsedEvidence(parseScopedEvidence(evidence), options);
}

function validateStaleRosterReportDependencies<Context>(
  dependencies: GetStaleRosterReportDependencies<Context>,
): void {
  if (
    typeof dependencies.store?.loadScopedEvidence !== 'function' ||
    typeof dependencies.clock !== 'function'
  ) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_CONFIGURATION',
      'The stale-roster report dependencies are invalid.',
    );
  }
  validateThreshold(dependencies.staleThresholdSeconds);
}

/** Executes the pure, already-authorized stale-roster report operation. */
export async function executeStaleRosterReportQuery<Context>(
  dependencies: GetStaleRosterReportDependencies<Context>,
  input: unknown,
  context: Context,
): Promise<StaleRosterReport> {
  validateStaleRosterReportDependencies(dependencies);
  const queryResult = RosterHealthQuerySchema.safeParse(input);
  if (!queryResult.success) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'The authorized roster-health query was invalid.',
    );
  }
  const query = queryResult.data;
  const evidence = parseScopedEvidence(
    await dependencies.store.loadScopedEvidence(query, context),
  );
  if (
    evidence.latestCompleteSnapshot !== null &&
    new Set([
      ...evidence.latestCompleteSnapshot.recipientHealth.map(
        ({ recipientId }) => recipientId,
      ),
      ...evidence.latestCompleteSnapshot.staleEndpoints.map(
        ({ recipientId }) => recipientId,
      ),
    ]).size > query.limit
  ) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'Scoped roster health evidence exceeded the authorized query limit.',
    );
  }

  let generatedAt: Date;
  try {
    generatedAt = dependencies.clock();
  } catch {
    throw new StaleRosterReportError(
      'INVALID_REPORT_TIME',
      'The roster report clock failed.',
    );
  }
  return buildFromParsedEvidence(evidence, {
    generatedAt,
    staleThresholdSeconds: dependencies.staleThresholdSeconds,
  });
}

/**
 * Registers the canonical stale-roster read capability. Authorization remains
 * mandatory at the capability boundary; the injected store additionally owns
 * all facility filtering and context-bound database reads.
 */
export function createGetStaleRosterReportHandler<Context>(
  dependencies: GetStaleRosterReportDependencies<Context>,
): Readonly<RegisteredCapabilityHandler<'get-stale-roster-report', Context>> {
  validateStaleRosterReportDependencies(dependencies);
  return registerCapabilityHandler(
    'get-stale-roster-report',
    (input, context) =>
      executeStaleRosterReportQuery(dependencies, input, context),
  );
}

/** Defense-in-depth scope required by the production stale-report store. */
export interface StaleRosterAuthorizationContext {
  readonly facilityScope: FacilityScope;
}

function authorizedFacilityId(
  query: RosterHealthQuery,
  context: StaleRosterAuthorizationContext,
): string | null {
  const scopeResult = FacilityScopeSchema.safeParse(context.facilityScope);
  if (!scopeResult.success) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'The roster-health authorization scope is invalid.',
    );
  }
  const facilityScope = scopeResult.data;
  const facilityId = query.facilityId;
  if (facilityScope.kind === 'district') {
    return facilityId;
  }
  if (facilityId === null || !facilityScope.facilityIds.includes(facilityId)) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'The roster-health query is outside the authorized facility scope.',
    );
  }
  return facilityId;
}

function cursorRecipientId(cursor: string | null): string | null {
  if (cursor === null) {
    return null;
  }
  try {
    return UuidSchema.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'The roster-health cursor is invalid.',
    );
  }
}

type StaleRosterQueryDatabase = Pick<
  DatabaseQuery,
  'select' | 'selectDistinct' | 'selectDistinctOn'
>;

interface PreparedScopedStaleRosterQuery {
  readonly query: RosterHealthQuery;
  readonly facilityId: string | null;
  readonly afterRecipientId: string | null;
}

interface ScopedEndpointState {
  readonly endpointId: string;
  readonly channel: z.infer<typeof NotificationChannelSchema>;
  readonly status: z.infer<typeof EndpointStatusSchema>;
  readonly reasonCode: string | null;
  readonly phoneNumber: string | null;
}

function prepareScopedStaleRosterQuery(
  queryValue: RosterHealthQuery,
  context: StaleRosterAuthorizationContext,
): PreparedScopedStaleRosterQuery {
  const queryResult = RosterHealthQuerySchema.safeParse(queryValue);
  if (!queryResult.success) {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'The roster-health query was invalid.',
    );
  }
  const query = queryResult.data;
  return Object.freeze({
    query,
    facilityId: authorizedFacilityId(query, context),
    afterRecipientId: cursorRecipientId(query.cursor),
  });
}

async function loadPreparedScopedStaleRosterEvidence(
  database: StaleRosterQueryDatabase,
  prepared: PreparedScopedStaleRosterQuery,
): Promise<ScopedStaleRosterEvidence> {
  const { query, facilityId, afterRecipientId } = prepared;

  const snapshotRows =
    facilityId === null
      ? await database
          .select({
            id: rosterSnapshots.id,
            capturedAt: rosterSnapshots.capturedAt,
          })
          .from(rosterSnapshots)
          .where(
            and(
              eq(rosterSnapshots.population, query.population),
              eq(rosterSnapshots.complete, true),
            ),
          )
          .orderBy(desc(rosterSnapshots.version))
          .limit(1)
      : await database
          .select({
            id: rosterSnapshots.id,
            capturedAt: rosterSnapshots.capturedAt,
          })
          .from(rosterSnapshots)
          .innerJoin(
            rosterSnapshotFacilities,
            eq(rosterSnapshotFacilities.rosterSnapshotId, rosterSnapshots.id),
          )
          .where(
            and(
              eq(rosterSnapshots.population, query.population),
              eq(rosterSnapshots.complete, true),
              eq(rosterSnapshotFacilities.facilityId, facilityId),
            ),
          )
          .orderBy(desc(rosterSnapshots.version))
          .limit(1);
  const snapshot = snapshotRows[0];

  let latestCompleteSnapshot: ScopedStaleRosterEvidence['latestCompleteSnapshot'] =
    null;
  if (snapshot !== undefined) {
    // A facility ID authorizes recipient identifiers only through that
    // building provenance. Facility-unbound `others` members stay
    // district-scoped unless a future contract supplies an explicit
    // facility-to-others authorization binding.
    const recipientRows =
      facilityId === null
        ? await database
            .select({ id: rosterRecipients.id })
            .from(rosterRecipients)
            .where(eq(rosterRecipients.rosterSnapshotId, snapshot.id))
            .orderBy(rosterRecipients.id)
        : await database
            .selectDistinct({ id: rosterRecipients.id })
            .from(rosterRecipients)
            .innerJoin(
              rosterRecipientGroupSources,
              and(
                eq(
                  rosterRecipientGroupSources.rosterSnapshotId,
                  rosterRecipients.rosterSnapshotId,
                ),
                eq(
                  rosterRecipientGroupSources.recipientId,
                  rosterRecipients.id,
                ),
              ),
            )
            .innerJoin(
              groupSources,
              eq(rosterRecipientGroupSources.groupSourceId, groupSources.id),
            )
            .where(
              and(
                eq(rosterRecipients.rosterSnapshotId, snapshot.id),
                eq(groupSources.purpose, 'building'),
                eq(groupSources.facilityId, facilityId),
              ),
            )
            .orderBy(rosterRecipients.id);
    const recipientIds = recipientRows.map((row) => row.id);
    const statusesByRecipient = new Map<
      string,
      Map<string, ScopedEndpointState>
    >();
    recipientIds.forEach((recipientId) =>
      statusesByRecipient.set(recipientId, new Map()),
    );

    for (let offset = 0; offset < recipientIds.length; offset += 500) {
      const batch = recipientIds.slice(offset, offset + 500);
      if (batch.length === 0) {
        continue;
      }
      const endpointRows = await database
        .select({
          id: rosterEndpoints.id,
          recipientId: rosterEndpoints.recipientId,
          channel: rosterEndpoints.channel,
          status: rosterEndpoints.status,
          phoneNumber: rosterEndpoints.phoneNumber,
        })
        .from(rosterEndpoints)
        .where(
          and(
            eq(rosterEndpoints.rosterSnapshotId, snapshot.id),
            inArray(rosterEndpoints.recipientId, batch),
          ),
        );
      endpointRows.forEach((endpoint) =>
        statusesByRecipient.get(endpoint.recipientId)?.set(
          endpoint.id,
          Object.freeze({
            endpointId: endpoint.id,
            channel: endpoint.channel,
            status: endpoint.status,
            reasonCode: null,
            phoneNumber: endpoint.phoneNumber,
          }),
        ),
      );
      // A roster snapshot remains immutable, so a later sign-out, explicit
      // unregistration, or administrator revocation is projected from its
      // append-only registration fact. Select only opaque IDs: token and
      // contact values never cross the stale-report persistence boundary.
      const pushEndpointIds = endpointRows.flatMap((endpoint) =>
        endpoint.channel === 'push' ? [endpoint.id] : [],
      );
      const pushUnregistrationRows =
        pushEndpointIds.length === 0
          ? []
          : await database
              .select({
                registrationId: devicePushTokenUnregistrations.registrationId,
              })
              .from(devicePushTokenUnregistrations)
              .where(
                inArray(
                  devicePushTokenUnregistrations.registrationId,
                  pushEndpointIds,
                ),
              );
      const unregisteredPushEndpointIds = new Set(
        pushUnregistrationRows.map(({ registrationId }) => registrationId),
      );
      endpointRows.forEach((endpoint) => {
        if (
          endpoint.channel !== 'push' ||
          !unregisteredPushEndpointIds.has(endpoint.id)
        ) {
          return;
        }
        const recipientStatuses = statusesByRecipient.get(endpoint.recipientId);
        const current = recipientStatuses?.get(endpoint.id);
        if (recipientStatuses === undefined || current === undefined) return;
        recipientStatuses.set(
          endpoint.id,
          Object.freeze({
            ...current,
            status: 'disabled',
            reasonCode: 'PUSH_TOKEN_UNREGISTERED',
          }),
        );
      });
      // Provider STOP/START is consent state, not endpoint health. Project
      // only independent invalid/disabled facts onto the snapshotted base;
      // the phone lifecycle overlay below must never revive this state.
      const statusRows = await database
        .selectDistinctOn([endpointStatusRecords.endpointId], {
          id: endpointStatusRecords.id,
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
            eq(endpointStatusRecords.rosterSnapshotId, snapshot.id),
            inArray(endpointStatusRecords.recipientId, batch),
            notInArray(endpointStatusRecords.reasonCode, [
              SMS_OPT_OUT_REASON_CODE,
              SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
            ]),
          ),
        )
        .orderBy(
          endpointStatusRecords.endpointId,
          desc(
            sql`coalesce(${endpointStatusRecords.providerOccurredAt}, ${endpointStatusRecords.recordedAt})`,
          ),
          desc(endpointStatusRecords.sequence),
        );
      statusRows.forEach((status) => {
        const recipientStatuses = statusesByRecipient.get(status.recipientId);
        const endpoint = recipientStatuses?.get(status.endpointId);
        if (recipientStatuses === undefined || endpoint === undefined) {
          return;
        }
        if (
          status.status === 'active' ||
          status.provider !== null ||
          status.providerReference !== null ||
          status.providerOccurredAt !== null
        ) {
          throw new StaleRosterReportError(
            'INVALID_REPORT_EVIDENCE',
            'Persisted non-provider endpoint health evidence was inconsistent.',
          );
        }
        recipientStatuses.set(
          status.endpointId,
          Object.freeze({
            ...endpoint,
            status: status.status,
            reasonCode: status.reasonCode,
          }),
        );
      });

      // SMS STOP/START state follows the destination across immutable roster
      // snapshots. This mirrors send policy: load only lifecycle facts for the
      // bounded current-batch phone set, order by provider occurrence with a
      // database-sequence tie-break, and discard every phone number before
      // evidence leaves the store.
      const phoneNumbers = [
        ...new Set(
          endpointRows.flatMap((endpoint) =>
            endpoint.channel === 'sms' && endpoint.phoneNumber !== null
              ? [endpoint.phoneNumber]
              : [],
          ),
        ),
      ];
      const retainedSmsLifecycleEndpoint = alias(
        rosterEndpoints,
        'stale_report_retained_sms_lifecycle_endpoint',
      );
      const phoneLifecycleRows =
        phoneNumbers.length === 0
          ? []
          : await database
              .selectDistinctOn([retainedSmsLifecycleEndpoint.phoneNumber], {
                phoneNumber: retainedSmsLifecycleEndpoint.phoneNumber,
                status: endpointStatusRecords.status,
                reasonCode: endpointStatusRecords.reasonCode,
                provider: endpointStatusRecords.provider,
                providerReference: endpointStatusRecords.providerReference,
                providerOccurredAt: endpointStatusRecords.providerOccurredAt,
                sequence: endpointStatusRecords.sequence,
              })
              .from(endpointStatusRecords)
              .innerJoin(
                retainedSmsLifecycleEndpoint,
                and(
                  eq(
                    retainedSmsLifecycleEndpoint.rosterSnapshotId,
                    endpointStatusRecords.rosterSnapshotId,
                  ),
                  eq(
                    retainedSmsLifecycleEndpoint.recipientId,
                    endpointStatusRecords.recipientId,
                  ),
                  eq(
                    retainedSmsLifecycleEndpoint.id,
                    endpointStatusRecords.endpointId,
                  ),
                  eq(
                    retainedSmsLifecycleEndpoint.population,
                    endpointStatusRecords.population,
                  ),
                  eq(
                    retainedSmsLifecycleEndpoint.channel,
                    endpointStatusRecords.channel,
                  ),
                ),
              )
              .where(
                and(
                  eq(endpointStatusRecords.channel, 'sms'),
                  inArray(
                    retainedSmsLifecycleEndpoint.phoneNumber,
                    phoneNumbers,
                  ),
                  inArray(endpointStatusRecords.reasonCode, [
                    SMS_OPT_OUT_REASON_CODE,
                    SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE,
                  ]),
                ),
              )
              .orderBy(
                retainedSmsLifecycleEndpoint.phoneNumber,
                desc(
                  sql`coalesce(${endpointStatusRecords.providerOccurredAt}, ${endpointStatusRecords.recordedAt})`,
                ),
                desc(endpointStatusRecords.sequence),
              );
      const effectivePhoneOptOut = new Map<string, boolean>();
      phoneLifecycleRows.forEach((lifecycle) => {
        if (lifecycle.phoneNumber === null) return;
        const hasCanonicalProviderEvidence =
          lifecycle.provider === SMS_LIFECYCLE_PROVIDER &&
          lifecycle.providerReference !== null &&
          lifecycle.providerOccurredAt !== null;
        if (
          lifecycle.reasonCode === SMS_OPT_OUT_REASON_CODE &&
          lifecycle.status === 'disabled' &&
          hasCanonicalProviderEvidence
        ) {
          effectivePhoneOptOut.set(lifecycle.phoneNumber, true);
          return;
        }
        if (
          lifecycle.reasonCode === SMS_PROVIDER_VERIFIED_OPT_IN_REASON_CODE &&
          lifecycle.status === 'active' &&
          hasCanonicalProviderEvidence
        ) {
          effectivePhoneOptOut.set(lifecycle.phoneNumber, false);
          return;
        }
        throw new StaleRosterReportError(
          'INVALID_REPORT_EVIDENCE',
          'Persisted SMS endpoint lifecycle evidence was inconsistent.',
        );
      });
      endpointRows.forEach((endpoint) => {
        if (
          endpoint.channel !== 'sms' ||
          endpoint.phoneNumber === null ||
          effectivePhoneOptOut.get(endpoint.phoneNumber) !== true
        ) {
          return;
        }
        const recipientStatuses = statusesByRecipient.get(endpoint.recipientId);
        const current = recipientStatuses?.get(endpoint.id);
        if (recipientStatuses === undefined || current === undefined) return;
        recipientStatuses.set(
          endpoint.id,
          Object.freeze({
            ...current,
            status: 'disabled',
            reasonCode: SMS_OPT_OUT_REASON_CODE,
          }),
        );
      });
    }

    const staleRecipientRows = [...statusesByRecipient.entries()]
      .map(([recipientId, statuses]) => ({
        recipientId,
        endpointStatuses: [...statuses.values()].map(({ status }) => status),
        pushEndpointStatuses: [...statuses.values()]
          .filter(({ channel }) => channel === 'push')
          .map(({ status }) => status),
      }))
      .filter(
        ({ endpointStatuses, pushEndpointStatuses }) =>
          endpointStatuses.length === 0 ||
          !endpointStatuses.includes('active') ||
          !pushEndpointStatuses.includes('active'),
      )
      .sort((left, right) => left.recipientId.localeCompare(right.recipientId));
    const staleEndpointRows = [...statusesByRecipient.entries()]
      .flatMap(([recipientId, statuses]) =>
        [...statuses.values()].flatMap((endpoint) =>
          endpoint.status === 'active'
            ? []
            : [
                Object.freeze({
                  recipientId,
                  endpointId: endpoint.endpointId,
                  channel: endpoint.channel,
                  status: endpoint.status,
                  reasonCode: endpoint.reasonCode,
                }),
              ],
        ),
      )
      .sort(
        (left, right) =>
          left.recipientId.localeCompare(right.recipientId) ||
          left.endpointId.localeCompare(right.endpointId),
      );
    const remainingRecipientIds = [
      ...new Set([
        ...staleRecipientRows.map(({ recipientId }) => recipientId),
        ...staleEndpointRows.map(({ recipientId }) => recipientId),
      ]),
    ]
      .filter(
        (recipientId) =>
          afterRecipientId === null ||
          recipientId.localeCompare(afterRecipientId) > 0,
      )
      .sort((left, right) => left.localeCompare(right));
    const pageRecipientIds = remainingRecipientIds.slice(0, query.limit);
    const pageRecipientIdSet = new Set(pageRecipientIds);
    const pageRecipientRows = staleRecipientRows.filter(({ recipientId }) =>
      pageRecipientIdSet.has(recipientId),
    );
    const pageEndpointRows = staleEndpointRows.filter(({ recipientId }) =>
      pageRecipientIdSet.has(recipientId),
    );
    latestCompleteSnapshot = Object.freeze({
      id: snapshot.id,
      capturedAt: snapshot.capturedAt.toISOString(),
      recipientHealth: Object.freeze(pageRecipientRows),
      staleEndpoints: Object.freeze(pageEndpointRows),
      hasUnreportedStaleRecipients: staleRecipientRows.some(
        ({ recipientId }) => !pageRecipientIdSet.has(recipientId),
      ),
      hasUnreportedStaleEndpoints: staleEndpointRows.some(
        ({ recipientId }) => !pageRecipientIdSet.has(recipientId),
      ),
    });
  }

  // Failure metadata contains no recipient identity. Keep an unresolved
  // facility-unbound `others` failure visible to every facility so no
  // facility report can claim current health, without broadening which
  // recipient identifiers that facility is authorized to read.
  const scopedFailurePredicate =
    facilityId === null
      ? undefined
      : or(
          and(
            eq(groupSources.purpose, 'building'),
            eq(groupSources.facilityId, facilityId),
          ),
          and(
            eq(groupSources.purpose, 'others'),
            isNull(groupSources.facilityId),
          ),
        );
  const [latestFailedResult] = await database
    .select({
      id: rosterSyncResults.id,
      outcome: rosterSyncResults.outcome,
      completedAt: rosterSyncResults.completedAt,
    })
    .from(rosterSyncResults)
    .innerJoin(
      rosterSyncGroupFailures,
      eq(rosterSyncGroupFailures.syncResultId, rosterSyncResults.id),
    )
    .innerJoin(
      groupSources,
      eq(rosterSyncGroupFailures.groupSourceId, groupSources.id),
    )
    .where(
      and(
        eq(rosterSyncResults.population, query.population),
        or(
          eq(rosterSyncResults.outcome, 'failed'),
          eq(rosterSyncResults.outcome, 'partial-rejected'),
        ),
        scopedFailurePredicate,
      ),
    )
    .orderBy(desc(rosterSyncResults.completedAt), desc(rosterSyncResults.id))
    .limit(1);
  if (latestFailedResult?.outcome === 'complete') {
    throw new StaleRosterReportError(
      'INVALID_REPORT_EVIDENCE',
      'Complete roster sync evidence cannot be reported as failed.',
    );
  }
  const latestFailureRows =
    latestFailedResult === undefined
      ? []
      : await database
          .select({
            sourceId: rosterSyncGroupFailures.groupSourceId,
            sourceKind: rosterSyncGroupFailures.groupSourceKind,
            sourcePurpose: rosterSyncGroupFailures.groupPurpose,
            sourceFacilityId: groupSources.facilityId,
            errorCode: rosterSyncGroupFailures.errorCode,
            attemptedAt: rosterSyncGroupFailures.attemptedAt,
          })
          .from(rosterSyncGroupFailures)
          .innerJoin(
            groupSources,
            eq(rosterSyncGroupFailures.groupSourceId, groupSources.id),
          )
          .where(
            and(
              eq(rosterSyncGroupFailures.syncResultId, latestFailedResult.id),
              scopedFailurePredicate,
            ),
          )
          .orderBy(
            rosterSyncGroupFailures.groupSourceId,
            rosterSyncGroupFailures.errorCode,
            rosterSyncGroupFailures.id,
          )
          .limit(501);
  const latestFailedSync =
    latestFailedResult === undefined
      ? null
      : Object.freeze({
          outcome: latestFailedResult.outcome,
          completedAt: latestFailedResult.completedAt.toISOString(),
          groupFailures: Object.freeze(
            latestFailureRows.map((failure) => ({
              groupSourceRef: {
                id: failure.sourceId,
                kind: failure.sourceKind,
                purpose: failure.sourcePurpose,
                facilityId: failure.sourceFacilityId,
              },
              errorCode: failure.errorCode,
              attemptedAt: failure.attemptedAt.toISOString(),
            })),
          ),
        });

  return parseScopedEvidence({
    latestCompleteSnapshot,
    latestFailedSync,
  });
}

/**
 * Creates an endpoint-value-free evidence store inside a caller-owned database
 * transaction. The caller must provide the coherent snapshot boundary.
 */
export function createDrizzleStaleRosterReportStoreFromTransaction(
  database: StaleRosterQueryDatabase,
): StaleRosterReportStore<StaleRosterAuthorizationContext> {
  return Object.freeze({
    async loadScopedEvidence(
      query: RosterHealthQuery,
      context: StaleRosterAuthorizationContext,
    ): Promise<ScopedStaleRosterEvidence> {
      return loadPreparedScopedStaleRosterEvidence(
        database,
        prepareScopedStaleRosterQuery(query, context),
      );
    },
  });
}

/**
 * Creates a repeatable-read, endpoint-value-free production evidence store.
 * It replays append-only endpoint status facts over the immutable snapshot and
 * applies facility authorization before any recipient IDs are returned.
 */
export function createDrizzleStaleRosterReportStore(
  database: Database,
): StaleRosterReportStore<StaleRosterAuthorizationContext> {
  return Object.freeze({
    async loadScopedEvidence(
      query: RosterHealthQuery,
      context: StaleRosterAuthorizationContext,
    ): Promise<unknown> {
      const prepared = prepareScopedStaleRosterQuery(query, context);
      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`set transaction isolation level repeatable read, read only`,
        );
        return loadPreparedScopedStaleRosterEvidence(transaction, prepared);
      });
    },
  });
}
