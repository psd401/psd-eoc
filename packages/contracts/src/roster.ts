import { z } from 'zod';

import { PaginationCursorSchema } from './api';
import { NotificationChannelSchema } from './event-type';
import { FacilityIdSchema } from './facility';
import { type RosterGroupSourceRef, RosterGroupSourceRefSchema } from './group';
import {
  hasUniqueStrings,
  TimestampSchema,
  UuidSchema,
  VersionSchema,
} from './shared';

export {
  AccessGroupSourceRefSchema,
  BuildingGroupSourceRefSchema,
  GroupPurposeSchema,
  GroupSourceIdSchema,
  GroupSourceKindSchema,
  GroupSourceRefSchema,
  GroupSourceSchema,
  OthersGroupSourceRefSchema,
  RosterGroupSourceRefSchema,
} from './group';
export type {
  AccessGroupSourceRef,
  BuildingGroupSourceRef,
  GroupPurpose,
  GroupSource,
  GroupSourceId,
  GroupSourceKind,
  GroupSourceRef,
  OthersGroupSourceRef,
  RosterGroupSourceRef,
} from './group';

const rosterGroupSourceRefKey = (source: RosterGroupSourceRef): string =>
  `${source.id}:${source.kind}:${source.purpose}:${source.facilityId ?? ''}`;

const hasUniqueGroupSourceIds = (
  sources: readonly RosterGroupSourceRef[],
): boolean => hasUniqueStrings(sources.map((source) => source.id));

const groupSourceMatchesPopulation = (
  source: RosterGroupSourceRef,
  population: z.infer<typeof RosterPopulationSchema>,
): boolean =>
  population === 'staff'
    ? source.kind === 'google-group'
    : source.kind === 'synthetic';

/**
 * Owns the population boundary for immutable roster snapshots. Production
 * staff and synthetic training recipients are intentionally disjoint so test
 * paths can never silently resolve real endpoints.
 */
export const RosterPopulationSchema = z.enum(['staff', 'synthetic']);

/** Roster population inferred from {@link RosterPopulationSchema}. */
export type RosterPopulation = z.infer<typeof RosterPopulationSchema>;

/**
 * Owns the lifecycle state of a snapshotted contact endpoint. Invalid and
 * disabled endpoints remain reconstructable and are excluded during resolve.
 */
export const EndpointStatusSchema = z.enum(['active', 'invalid', 'disabled']);

/** Contact endpoint lifecycle state inferred from its schema. */
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>;

/**
 * Owns the stable identifier for an endpoint snapshot. Each roster version
 * retains the exact contact destination used for fan-out reconstruction.
 */
export const EndpointIdSchema = UuidSchema;

/** Stable endpoint identifier inferred from its schema. */
export type EndpointId = z.infer<typeof EndpointIdSchema>;

/**
 * Owns native push platforms persisted with endpoint snapshots. Web push is
 * not a release-one endpoint and cannot enter this enum accidentally.
 */
export const PushPlatformSchema = z.enum(['ios', 'android']);

/** Native push platform inferred from its schema. */
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

const endpointCommonShape = {
  id: EndpointIdSchema,
  status: EndpointStatusSchema,
  capturedAt: TimestampSchema,
};

/**
 * Owns an immutable native push endpoint snapshot. Tokens are internal staff
 * contact data and must never be logged or exposed through an unscoped read.
 */
export const PushEndpointSchema = z
  .object({
    ...endpointCommonShape,
    channel: z.literal('push'),
    platform: PushPlatformSchema,
    token: z.string().trim().min(16).max(4096),
  })
  .strict()
  .readonly();

/** Immutable push endpoint snapshot inferred from its schema. */
export type PushEndpoint = z.infer<typeof PushEndpointSchema>;

/**
 * Owns an immutable email endpoint snapshot. Live fixtures never belong in
 * source control; synthetic seed addresses use reserved `.invalid` domains.
 */
export const EmailEndpointSchema = z
  .object({
    ...endpointCommonShape,
    channel: z.literal('email'),
    email: z.string().trim().email().max(320),
  })
  .strict()
  .readonly();

/** Immutable email endpoint snapshot inferred from its schema. */
export type EmailEndpoint = z.infer<typeof EmailEndpointSchema>;

/**
 * Owns an immutable SMS endpoint snapshot in E.164 form. Endpoint state does
 * not imply carrier delivery or human receipt.
 */
export const SmsEndpointSchema = z
  .object({
    ...endpointCommonShape,
    channel: z.literal('sms'),
    phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/u),
  })
  .strict()
  .readonly();

/** Immutable SMS endpoint snapshot inferred from its schema. */
export type SmsEndpoint = z.infer<typeof SmsEndpointSchema>;

/**
 * Owns the channel-discriminated endpoint snapshot used during roster
 * resolution. Channel-specific payloads cannot be interchanged.
 */
export const EndpointSchema = z
  .discriminatedUnion('channel', [
    PushEndpointSchema,
    EmailEndpointSchema,
    SmsEndpointSchema,
  ])
  .readonly();

/** Immutable contact endpoint snapshot inferred from its schema. */
export type Endpoint = z.infer<typeof EndpointSchema>;

/**
 * Owns the stable identifier for a recipient snapshot entry. It identifies a
 * staff or synthetic person only within immutable operational records.
 */
export const RecipientIdSchema = UuidSchema;

/** Stable recipient identifier inferred from its schema. */
export type RecipientId = z.infer<typeof RecipientIdSchema>;

/**
 * Owns a minimized immutable recipient snapshot with group provenance and
 * zero or more endpoint snapshots. Missing valid endpoints remain
 * representable for stale-roster reporting.
 */
export const RecipientSchema = z
  .object({
    id: RecipientIdSchema,
    population: RosterPopulationSchema,
    googleSubject: z.string().trim().min(1).max(255).nullable(),
    displayName: z.string().trim().min(1).max(160),
    groupSourceRefs: z
      .array(RosterGroupSourceRefSchema)
      .min(1)
      .max(50)
      .readonly(),
    endpoints: z.array(EndpointSchema).max(10).readonly(),
  })
  .strict()
  .superRefine((recipient, context) => {
    if (!hasUniqueGroupSourceIds(recipient.groupSourceRefs)) {
      context.addIssue({
        code: 'custom',
        message: 'Recipient group provenance references must be unique.',
        path: ['groupSourceRefs'],
      });
    }
    recipient.groupSourceRefs.forEach((source, index) => {
      if (!groupSourceMatchesPopulation(source, recipient.population)) {
        context.addIssue({
          code: 'custom',
          message:
            'Recipient group source kind must match its roster population.',
          path: ['groupSourceRefs', index, 'kind'],
        });
      }
    });
    if (
      (recipient.population === 'synthetic') !==
      (recipient.googleSubject === null)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Staff recipients require a Google subject; synthetic recipients cannot carry one.',
        path: ['googleSubject'],
      });
    }
    const endpointIds = recipient.endpoints.map((endpoint) => endpoint.id);
    if (!hasUniqueStrings(endpointIds)) {
      context.addIssue({
        code: 'custom',
        message: 'Recipient endpoint IDs must be unique.',
        path: ['endpoints'],
      });
    }
  })
  .readonly();

/** Minimized immutable recipient snapshot inferred from its schema. */
export type Recipient = z.infer<typeof RecipientSchema>;

/** Stable identifier for one versioned roster-source configuration. */
export const RosterSourceConfigurationIdSchema = UuidSchema;

/** Roster-source configuration identifier inferred from its schema. */
export type RosterSourceConfigurationId = z.infer<
  typeof RosterSourceConfigurationIdSchema
>;

/**
 * Owns the exact roster-source configuration pinned by sync results and
 * complete snapshots so later group configuration edits cannot rewrite truth.
 */
export const RosterSourceConfigurationRefSchema = z
  .object({
    id: RosterSourceConfigurationIdSchema,
    version: VersionSchema,
  })
  .strict()
  .readonly();

/** Exact roster-source configuration reference inferred from its schema. */
export type RosterSourceConfigurationRef = z.infer<
  typeof RosterSourceConfigurationRefSchema
>;

/**
 * Owns one immutable expected source set for a staff or synthetic roster.
 * A sync is complete only when every configured source appears in its
 * completed set; edits create a new version.
 */
export const RosterSourceConfigurationSchema = z
  .object({
    id: RosterSourceConfigurationIdSchema,
    version: VersionSchema,
    population: RosterPopulationSchema,
    facilityIds: z.array(FacilityIdSchema).min(1).max(200).readonly(),
    groupSourceRefs: z
      .array(RosterGroupSourceRefSchema)
      .min(1)
      .max(500)
      .readonly(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((configuration, context) => {
    if (!hasUniqueStrings(configuration.facilityIds)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster configuration facilities must be unique.',
        path: ['facilityIds'],
      });
    }
    if (!hasUniqueGroupSourceIds(configuration.groupSourceRefs)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster configuration sources must be unique by ID.',
        path: ['groupSourceRefs'],
      });
    }
    const facilityIds = new Set(configuration.facilityIds);
    configuration.groupSourceRefs.forEach((source, index) => {
      if (!groupSourceMatchesPopulation(source, configuration.population)) {
        context.addIssue({
          code: 'custom',
          message:
            'Roster configuration source kind must match its population.',
          path: ['groupSourceRefs', index, 'kind'],
        });
      }
      if (
        source.purpose === 'building' &&
        !facilityIds.has(source.facilityId)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Building roster sources must belong to a configured facility.',
          path: ['groupSourceRefs', index, 'facilityId'],
        });
      }
    });
  })
  .readonly();

/** Immutable expected roster-source set inferred from its schema. */
export type RosterSourceConfiguration = z.infer<
  typeof RosterSourceConfigurationSchema
>;

/**
 * Owns the stable identifier for a complete roster snapshot. Activations pin
 * this ID and never call Google in their critical path.
 */
export const RosterSnapshotIdSchema = UuidSchema;

/** Stable roster snapshot identifier inferred from its schema. */
export type RosterSnapshotId = z.infer<typeof RosterSnapshotIdSchema>;

/**
 * Owns one complete, immutable, versioned roster snapshot. Partial or failed
 * sync results cannot parse as a snapshot; the last complete version remains
 * authoritative. Synthetic snapshots cannot contain Google subjects.
 */
export const RosterSnapshotSchema = z
  .object({
    id: RosterSnapshotIdSchema,
    version: VersionSchema,
    population: RosterPopulationSchema,
    complete: z.literal(true),
    sourceConfiguration: RosterSourceConfigurationRefSchema,
    facilityIds: z.array(FacilityIdSchema).min(1).max(200).readonly(),
    expectedSourceGroupRefs: z
      .array(RosterGroupSourceRefSchema)
      .min(1)
      .max(500)
      .readonly(),
    sourceGroupRefs: z
      .array(RosterGroupSourceRefSchema)
      .min(1)
      .max(500)
      .readonly(),
    recipients: z.array(RecipientSchema).max(1_200).readonly(),
    syncStartedAt: TimestampSchema,
    capturedAt: TimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (!hasUniqueStrings(snapshot.facilityIds)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster snapshot facility IDs must be unique.',
        path: ['facilityIds'],
      });
    }
    if (!hasUniqueGroupSourceIds(snapshot.sourceGroupRefs)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster snapshot source references must be unique by ID.',
        path: ['sourceGroupRefs'],
      });
    }
    const expectedSourceIds = snapshot.expectedSourceGroupRefs.map(
      (source) => source.id,
    );
    const completedSourceIds = snapshot.sourceGroupRefs.map(
      (source) => source.id,
    );
    const expectedSourceKeys = snapshot.expectedSourceGroupRefs
      .map(rosterGroupSourceRefKey)
      .sort();
    const completedSourceKeys = snapshot.sourceGroupRefs
      .map(rosterGroupSourceRefKey)
      .sort();
    if (
      !hasUniqueStrings(expectedSourceIds) ||
      !hasUniqueStrings(completedSourceIds) ||
      expectedSourceKeys.length !== completedSourceKeys.length ||
      expectedSourceKeys.some(
        (sourceKey, index) => sourceKey !== completedSourceKeys[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A complete roster snapshot must include every expected source.',
        path: ['sourceGroupRefs'],
      });
    }
    const facilityIds = new Set(snapshot.facilityIds);
    snapshot.sourceGroupRefs.forEach((source, index) => {
      if (!groupSourceMatchesPopulation(source, snapshot.population)) {
        context.addIssue({
          code: 'custom',
          message: 'Roster snapshot source kind must match its population.',
          path: ['sourceGroupRefs', index, 'kind'],
        });
      }
      if (
        source.purpose === 'building' &&
        !facilityIds.has(source.facilityId)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Building snapshot sources must belong to a snapshotted facility.',
          path: ['sourceGroupRefs', index, 'facilityId'],
        });
      }
    });
    const recipientIds = snapshot.recipients.map((recipient) => recipient.id);
    if (!hasUniqueStrings(recipientIds)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster snapshot recipient IDs must be unique.',
        path: ['recipients'],
      });
    }
    const sourceGroupKeys = new Set(
      snapshot.sourceGroupRefs.map(rosterGroupSourceRefKey),
    );
    snapshot.recipients.forEach((recipient, recipientIndex) => {
      if (recipient.population !== snapshot.population) {
        context.addIssue({
          code: 'custom',
          message: 'Recipient population must match its roster snapshot.',
          path: ['recipients', recipientIndex, 'population'],
        });
      }
      recipient.groupSourceRefs.forEach((groupSource, groupIndex) => {
        if (!sourceGroupKeys.has(rosterGroupSourceRefKey(groupSource))) {
          context.addIssue({
            code: 'custom',
            message:
              'Recipient group provenance must belong to the snapshot sources.',
            path: ['recipients', recipientIndex, 'groupSourceRefs', groupIndex],
          });
        }
      });
    });
    const googleSubjects = snapshot.recipients.flatMap((recipient) =>
      recipient.googleSubject === null ? [] : [recipient.googleSubject],
    );
    if (!hasUniqueStrings(googleSubjects)) {
      context.addIssue({
        code: 'custom',
        message: 'Google subjects must be deduplicated across a snapshot.',
        path: ['recipients'],
      });
    }
    if (
      snapshot.population === 'synthetic' &&
      snapshot.recipients.some((recipient) => recipient.googleSubject !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Synthetic recipients cannot carry Google subjects.',
        path: ['recipients'],
      });
    }
    if (snapshot.population === 'synthetic') {
      snapshot.recipients.forEach((recipient, recipientIndex) => {
        recipient.endpoints.forEach((endpoint, endpointIndex) => {
          const isProvablyUnroutable = (() => {
            switch (endpoint.channel) {
              case 'email':
                return endpoint.email.toLowerCase().endsWith('.invalid');
              case 'sms':
                return (
                  /^\+120255501\d{2}$/u.test(endpoint.phoneNumber) ||
                  /^\+999\d{12}$/u.test(endpoint.phoneNumber)
                );
              case 'push':
                return endpoint.token.startsWith('synthetic-unroutable:');
            }
          })();
          if (!isProvablyUnroutable) {
            context.addIssue({
              code: 'custom',
              message:
                'Synthetic roster endpoints must be reserved and provably unroutable.',
              path: ['recipients', recipientIndex, 'endpoints', endpointIndex],
            });
          }
        });
      });
    }
    const allEndpointIds = snapshot.recipients.flatMap((recipient) =>
      recipient.endpoints.map((endpoint) => endpoint.id),
    );
    if (!hasUniqueStrings(allEndpointIds)) {
      context.addIssue({
        code: 'custom',
        message: 'Endpoint IDs must be unique across a roster snapshot.',
        path: ['recipients'],
      });
    }
    const endpointDestinations = snapshot.recipients.flatMap((recipient) =>
      recipient.endpoints.map((endpoint) => {
        switch (endpoint.channel) {
          case 'email':
            return `email:${endpoint.email.toLowerCase()}`;
          case 'sms':
            return `sms:${endpoint.phoneNumber}`;
          case 'push':
            return `push:${endpoint.token}`;
        }
      }),
    );
    if (!hasUniqueStrings(endpointDestinations)) {
      context.addIssue({
        code: 'custom',
        message:
          'Endpoint destinations must be deduplicated across a snapshot.',
        path: ['recipients'],
      });
    }
    if (Date.parse(snapshot.capturedAt) < Date.parse(snapshot.syncStartedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster capture cannot precede sync start.',
        path: ['capturedAt'],
      });
    }
  })
  .readonly();

/** Complete immutable roster snapshot inferred from its schema. */
export type RosterSnapshot = z.infer<typeof RosterSnapshotSchema>;

/**
 * Owns the fail-closed outcome of one Google Groups or synthetic roster sync.
 * Partial input is rejected rather than published as a truncated snapshot.
 */
export const RosterSyncOutcomeSchema = z.enum([
  'complete',
  'failed',
  'partial-rejected',
]);

/** Fail-closed roster sync outcome inferred from its schema. */
export type RosterSyncOutcome = z.infer<typeof RosterSyncOutcomeSchema>;

/**
 * Owns one bounded group-source failure in sync and stale reports. Error codes
 * are sanitized taxonomy values, never raw Google response payloads.
 */
export const RosterGroupFailureSchema = z
  .object({
    groupSourceRef: RosterGroupSourceRefSchema,
    errorCode: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/u),
    attemptedAt: TimestampSchema,
  })
  .strict()
  .readonly();

/** Sanitized roster group-source failure inferred from its schema. */
export type RosterGroupFailure = z.infer<typeof RosterGroupFailureSchema>;

/**
 * Owns one immutable roster sync result. Only complete outcomes may publish a
 * new snapshot; failed or partial results preserve the last complete version.
 */
export const RosterSyncResultSchema = z
  .object({
    id: UuidSchema,
    sourceConfiguration: RosterSourceConfigurationRefSchema,
    population: RosterPopulationSchema,
    outcome: RosterSyncOutcomeSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    expectedSourceGroupRefs: z
      .array(RosterGroupSourceRefSchema)
      .min(1)
      .max(500)
      .readonly(),
    completedSourceGroupRefs: z
      .array(RosterGroupSourceRefSchema)
      .max(500)
      .readonly(),
    publishedSnapshotId: RosterSnapshotIdSchema.nullable(),
    groupFailures: z.array(RosterGroupFailureSchema).max(500).readonly(),
  })
  .strict()
  .superRefine((result, context) => {
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster sync completion cannot precede its start.',
        path: ['completedAt'],
      });
    }
    if (
      (result.outcome === 'complete') !==
      (result.publishedSnapshotId !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only complete syncs publish a roster snapshot.',
        path: ['publishedSnapshotId'],
      });
    }
    if (result.outcome === 'complete' && result.groupFailures.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'A complete roster sync cannot contain group failures.',
        path: ['groupFailures'],
      });
    }
    const expectedIds = result.expectedSourceGroupRefs.map(
      (source) => source.id,
    );
    const completedIds = result.completedSourceGroupRefs.map(
      (source) => source.id,
    );
    const expected = result.expectedSourceGroupRefs
      .map(rosterGroupSourceRefKey)
      .sort();
    const completed = result.completedSourceGroupRefs
      .map(rosterGroupSourceRefKey)
      .sort();
    if (
      !hasUniqueStrings(expectedIds) ||
      !hasUniqueStrings(completedIds) ||
      !hasUniqueStrings(expected) ||
      !hasUniqueStrings(completed)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Roster sync source sets must be unique.',
        path: ['completedSourceGroupRefs'],
      });
    }
    const allExpectedCompleted =
      expected.length === completed.length &&
      expected.every((sourceId, index) => sourceId === completed[index]);
    if ((result.outcome === 'complete') !== allExpectedCompleted) {
      context.addIssue({
        code: 'custom',
        message:
          'Only a sync that completed every expected source may publish complete.',
        path: ['completedSourceGroupRefs'],
      });
    }
    const expectedSet = new Set(expected);
    if (completed.some((sourceKey) => !expectedSet.has(sourceKey))) {
      context.addIssue({
        code: 'custom',
        message: 'Completed sync sources must belong to the expected set.',
        path: ['completedSourceGroupRefs'],
      });
    }
    result.expectedSourceGroupRefs.forEach((source, index) => {
      if (!groupSourceMatchesPopulation(source, result.population)) {
        context.addIssue({
          code: 'custom',
          message: 'Roster sync source kind must match its population.',
          path: ['expectedSourceGroupRefs', index, 'kind'],
        });
      }
    });
    result.groupFailures.forEach((failure, index) => {
      if (!expectedSet.has(rosterGroupSourceRefKey(failure.groupSourceRef))) {
        context.addIssue({
          code: 'custom',
          message: 'Roster sync failures must identify an expected source.',
          path: ['groupFailures', index, 'groupSourceRef'],
        });
      }
    });
  })
  .readonly();

/** Immutable fail-closed roster sync result inferred from its schema. */
export type RosterSyncResult = z.infer<typeof RosterSyncResultSchema>;

/**
 * Owns the operational health state of the latest complete roster. `unknown`
 * is explicit before the first successful sync; stale and failed remain
 * visible rather than silently truncating recipients.
 */
export const RosterHealthStatusSchema = z.enum([
  'current',
  'stale',
  'failed',
  'unknown',
]);

/** Roster operational health state inferred from its schema. */
export type RosterHealthStatus = z.infer<typeof RosterHealthStatusSchema>;

/**
 * Owns a minimized stale-recipient result. It identifies the immutable
 * recipient entry and reason without copying contact destinations into reports.
 */
export const StaleRosterRecipientSchema = z
  .object({
    recipientId: RecipientIdSchema,
    reason: z.enum(['no-endpoint', 'no-active-endpoint']),
  })
  .strict()
  .readonly();

/** Minimized stale-recipient result inferred from its schema. */
export type StaleRosterRecipient = z.infer<typeof StaleRosterRecipientSchema>;

/**
 * Owns one PII-free unusable endpoint in a stale-roster report. Destination
 * values never enter this projection; SMS opt-outs remain explicit even when
 * the recipient still has another active channel.
 */
export const StaleRosterEndpointSchema = z
  .object({
    recipientId: RecipientIdSchema,
    endpointId: EndpointIdSchema,
    channel: NotificationChannelSchema,
    reason: z.enum(['invalid', 'disabled', 'sms-opted-out']),
  })
  .strict()
  .superRefine((endpoint, context) => {
    if (endpoint.reason === 'sms-opted-out' && endpoint.channel !== 'sms') {
      context.addIssue({
        code: 'custom',
        message: 'SMS opt-out evidence must identify an SMS endpoint.',
        path: ['channel'],
      });
    }
  })
  .readonly();

/** PII-free stale endpoint inferred from {@link StaleRosterEndpointSchema}. */
export type StaleRosterEndpoint = z.infer<typeof StaleRosterEndpointSchema>;

/**
 * Owns the bounded stale-roster report returned by a read capability. It
 * carries latest-success age, failed sources, and recipients lacking usable
 * endpoints without exposing endpoint values or raw external errors.
 */
export const StaleRosterReportSchema = z
  .object({
    generatedAt: TimestampSchema,
    status: RosterHealthStatusSchema,
    latestCompleteSnapshotId: RosterSnapshotIdSchema.nullable(),
    latestCompleteCapturedAt: TimestampSchema.nullable(),
    latestCompleteAgeSeconds: z.number().int().nonnegative().nullable(),
    failedGroups: z.array(RosterGroupFailureSchema).max(500).readonly(),
    staleRecipients: z.array(StaleRosterRecipientSchema).max(1_200).readonly(),
    staleEndpoints: z
      .array(StaleRosterEndpointSchema)
      .max(12_000)
      .default([])
      .readonly(),
  })
  .strict()
  .superRefine((report, context) => {
    const latestFields = [
      report.latestCompleteSnapshotId,
      report.latestCompleteCapturedAt,
      report.latestCompleteAgeSeconds,
    ];
    const populated = latestFields.filter((value) => value !== null).length;
    if (populated !== 0 && populated !== latestFields.length) {
      context.addIssue({
        code: 'custom',
        message:
          'Latest complete roster evidence must be all present or absent.',
        path: ['latestCompleteSnapshotId'],
      });
    }
    if (['current', 'stale'].includes(report.status) && populated === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Current or stale health requires latest complete evidence.',
        path: ['status'],
      });
    }
    if (report.status === 'unknown' && populated !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'Unknown roster health cannot claim complete evidence.',
        path: ['status'],
      });
    }
    if (report.status === 'failed' && report.failedGroups.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Failed roster health requires failed group evidence.',
        path: ['failedGroups'],
      });
    }
    if (
      report.status === 'current' &&
      (report.failedGroups.length > 0 ||
        report.staleRecipients.length > 0 ||
        report.staleEndpoints.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Current roster health cannot carry stale or failed evidence.',
        path: ['status'],
      });
    }
    if (
      report.status === 'unknown' &&
      (report.failedGroups.length > 0 ||
        report.staleRecipients.length > 0 ||
        report.staleEndpoints.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unknown health precedes any stale or failure evidence.',
        path: ['status'],
      });
    }
  })
  .readonly();

/** Bounded stale-roster capability result inferred from its schema. */
export type StaleRosterReport = z.infer<typeof StaleRosterReportSchema>;

/**
 * Owns a fail-closed roster-sync request by immutable source-configuration
 * reference. The capability resolves untrusted Google or synthetic source
 * data server-side and never accepts a caller-constructed snapshot.
 */
export const SyncRosterInputSchema = z
  .object({
    sourceConfiguration: RosterSourceConfigurationRefSchema,
  })
  .strict()
  .readonly();

/** Roster-sync request inferred from its schema. */
export type SyncRosterInput = z.infer<typeof SyncRosterInputSchema>;

/** Owns a scoped read of one immutable roster snapshot. */
export const GetRosterSnapshotInputSchema = z
  .object({
    rosterSnapshotId: RosterSnapshotIdSchema,
  })
  .strict()
  .readonly();

/** Immutable roster-snapshot read input inferred from its schema. */
export type GetRosterSnapshotInput = z.infer<
  typeof GetRosterSnapshotInputSchema
>;

/**
 * Owns bounded roster-health filters. Facility authorization is still applied
 * server-side; this input cannot widen the authenticated principal's scope.
 */
export const RosterHealthQuerySchema = z
  .object({
    population: RosterPopulationSchema,
    facilityId: FacilityIdSchema.nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .readonly();

/** Bounded roster-health query inferred from its schema. */
export type RosterHealthQuery = z.infer<typeof RosterHealthQuerySchema>;
