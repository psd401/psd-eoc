import {
  EndpointStatusSchema,
  FacilityScopeSchema,
  RecipientIdSchema,
  RosterGroupFailureSchema,
  RosterHealthQuerySchema,
  RosterSnapshotIdSchema,
  StaleRosterReportSchema,
  TimestampSchema,
  UuidSchema,
  registerCapabilityHandler,
  type FacilityScope,
  type RegisteredCapabilityHandler,
  type RosterHealthQuery,
  type StaleRosterRecipient,
  type StaleRosterReport,
} from '@psd-eoc/contracts';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../../db/client';
import {
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

const ScopedRecipientHealthSchema = z
  .object({
    recipientId: RecipientIdSchema,
    endpointStatuses: z.array(EndpointStatusSchema).max(10).readonly(),
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
    /**
     * True when the scoped store omitted one or more stale recipients from
     * this bounded page. It prevents a partial page from claiming `current`.
     */
    hasUnreportedStaleRecipients: z.boolean(),
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
      snapshot.hasUnreportedStaleRecipients
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

/**
 * Registers the canonical stale-roster read capability. Authorization remains
 * mandatory in `executeCapability`; the injected store additionally owns all
 * facility filtering and context-bound database reads.
 */
export function createGetStaleRosterReportHandler<Context>(
  dependencies: GetStaleRosterReportDependencies<Context>,
): Readonly<RegisteredCapabilityHandler<'get-stale-roster-report', Context>> {
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

  return registerCapabilityHandler(
    'get-stale-roster-report',
    async (input, context) => {
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
        evidence.latestCompleteSnapshot.recipientHealth.length > query.limit
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
    },
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
      queryValue: RosterHealthQuery,
      context: StaleRosterAuthorizationContext,
    ): Promise<ScopedStaleRosterEvidence> {
      const query = RosterHealthQuerySchema.parse(queryValue);
      const facilityId = authorizedFacilityId(query, context);
      const afterRecipientId = cursorRecipientId(query.cursor);

      return database.transaction(async (transaction) => {
        await transaction.execute(
          sql`set transaction isolation level repeatable read, read only`,
        );

        const snapshotRows =
          facilityId === null
            ? await transaction
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
            : await transaction
                .select({
                  id: rosterSnapshots.id,
                  capturedAt: rosterSnapshots.capturedAt,
                })
                .from(rosterSnapshots)
                .innerJoin(
                  rosterSnapshotFacilities,
                  eq(
                    rosterSnapshotFacilities.rosterSnapshotId,
                    rosterSnapshots.id,
                  ),
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
          const recipientRows =
            facilityId === null
              ? await transaction
                  .select({ id: rosterRecipients.id })
                  .from(rosterRecipients)
                  .where(eq(rosterRecipients.rosterSnapshotId, snapshot.id))
                  .orderBy(rosterRecipients.id)
              : await transaction
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
                    eq(
                      rosterRecipientGroupSources.groupSourceId,
                      groupSources.id,
                    ),
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
            Map<string, z.infer<typeof EndpointStatusSchema>>
          >();
          recipientIds.forEach((recipientId) =>
            statusesByRecipient.set(recipientId, new Map()),
          );

          for (let offset = 0; offset < recipientIds.length; offset += 500) {
            const batch = recipientIds.slice(offset, offset + 500);
            if (batch.length === 0) {
              continue;
            }
            const endpointRows = await transaction
              .select({
                id: rosterEndpoints.id,
                recipientId: rosterEndpoints.recipientId,
                status: rosterEndpoints.status,
              })
              .from(rosterEndpoints)
              .where(
                and(
                  eq(rosterEndpoints.rosterSnapshotId, snapshot.id),
                  inArray(rosterEndpoints.recipientId, batch),
                ),
              );
            endpointRows.forEach((endpoint) =>
              statusesByRecipient
                .get(endpoint.recipientId)
                ?.set(endpoint.id, endpoint.status),
            );
            const statusRows = await transaction
              .select({
                endpointId: endpointStatusRecords.endpointId,
                recipientId: endpointStatusRecords.recipientId,
                status: endpointStatusRecords.status,
                recordedAt: endpointStatusRecords.recordedAt,
              })
              .from(endpointStatusRecords)
              .where(
                and(
                  eq(endpointStatusRecords.rosterSnapshotId, snapshot.id),
                  inArray(endpointStatusRecords.recipientId, batch),
                ),
              )
              .orderBy(endpointStatusRecords.recordedAt);
            statusRows.forEach((status) =>
              statusesByRecipient
                .get(status.recipientId)
                ?.set(status.endpointId, status.status),
            );
          }

          const staleRows = [...statusesByRecipient.entries()]
            .map(([recipientId, statuses]) => ({
              recipientId,
              endpointStatuses: [...statuses.values()],
            }))
            .filter(
              ({ endpointStatuses }) =>
                endpointStatuses.length === 0 ||
                !endpointStatuses.includes('active'),
            )
            .sort((left, right) =>
              left.recipientId.localeCompare(right.recipientId),
            );
          const pageRows = staleRows
            .filter(
              ({ recipientId }) =>
                afterRecipientId === null || recipientId > afterRecipientId,
            )
            .slice(0, query.limit);
          latestCompleteSnapshot = Object.freeze({
            id: snapshot.id,
            capturedAt: snapshot.capturedAt.toISOString(),
            recipientHealth: Object.freeze(pageRows),
            hasUnreportedStaleRecipients: staleRows.length > pageRows.length,
          });
        }

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
        const [latestFailedResult] = await transaction
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
          .orderBy(
            desc(rosterSyncResults.completedAt),
            desc(rosterSyncResults.id),
          )
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
            : await transaction
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
                    eq(
                      rosterSyncGroupFailures.syncResultId,
                      latestFailedResult.id,
                    ),
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
                  latestFailureRows.map((failure) =>
                    RosterGroupFailureSchema.parse({
                      groupSourceRef: {
                        id: failure.sourceId,
                        kind: failure.sourceKind,
                        purpose: failure.sourcePurpose,
                        facilityId: failure.sourceFacilityId,
                      },
                      errorCode: failure.errorCode,
                      attemptedAt: failure.attemptedAt.toISOString(),
                    }),
                  ),
                ),
              });

        return ScopedStaleRosterEvidenceSchema.parse({
          latestCompleteSnapshot,
          latestFailedSync,
        });
      });
    },
  });
}
