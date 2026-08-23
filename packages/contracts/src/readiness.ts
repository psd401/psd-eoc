import { z } from 'zod';

import { GroupSourceIdSchema } from './group';
import { RoleSchema, TimestampSchema } from './shared';

/** Three intentionally distinct outcomes for one administrative readiness check. */
export const AdminReadinessStatusSchema = z.enum([
  'ready',
  'action-required',
  'unavailable',
]);

/** Administrative readiness status inferred from its closed vocabulary. */
export type AdminReadinessStatus = z.infer<typeof AdminReadinessStatusSchema>;

/** Issue #289's exact liveness boundary; exactly 24 hours remains fresh. */
export const ADMIN_READINESS_FRESHNESS_WINDOW_SECONDS = 24 * 60 * 60;

/** Empty, server-observed administrative readiness query. */
export const GetAdminReadinessInputSchema = z.object({}).strict().readonly();

/** Administrative readiness query inferred from its schema. */
export type GetAdminReadinessInput = z.infer<
  typeof GetAdminReadinessInputSchema
>;

export const AccessMembershipReadStateSchema = z.enum([
  'fresh',
  'never-read',
  'stale',
]);

/** One active access group's minimized membership-read evidence. */
export const AccessMembershipReadinessEntrySchema = z
  .object({
    id: GroupSourceIdSchema,
    displayName: z.string().trim().min(1).max(160),
    grantedRole: RoleSchema,
    membersCapturedAt: TimestampSchema.nullable(),
    status: AccessMembershipReadStateSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      (entry.membersCapturedAt === null) !==
      (entry.status === 'never-read')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only a never-read access group may omit its read timestamp.',
        path: ['membersCapturedAt'],
      });
    }
  })
  .readonly();

/** Access-group presence and liveness at one authoritative observation time. */
export const AccessMembershipReadinessSchema = z
  .object({
    status: z.enum(['ready', 'action-required']),
    freshnessWindowSeconds: z.literal(ADMIN_READINESS_FRESHNESS_WINDOW_SECONDS),
    groups: z.array(AccessMembershipReadinessEntrySchema).max(100).readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.groups.map(({ id }) => id)).size !== value.groups.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Access readiness groups must be unique.',
        path: ['groups'],
      });
    }
    const expected =
      value.groups.length > 0 &&
      value.groups.every((group) => group.status === 'fresh')
        ? 'ready'
        : 'action-required';
    if (value.status !== expected) {
      context.addIssue({
        code: 'custom',
        message: 'Access readiness status must match the group-read evidence.',
        path: ['status'],
      });
    }
  })
  .readonly();

/** Facility coverage needed for a consequence preview on every active site. */
export const FacilityConfigurationReadinessSchema = z
  .object({
    status: z.enum(['ready', 'action-required']),
    activeFacilityCount: z.number().int().nonnegative(),
    facilitiesWithoutNeighborhoodCount: z.number().int().nonnegative(),
    facilitiesWithoutAudienceCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.activeFacilityCount > 0 &&
      value.facilitiesWithoutNeighborhoodCount === 0 &&
      value.facilitiesWithoutAudienceCount === 0
        ? 'ready'
        : 'action-required';
    if (
      value.facilitiesWithoutNeighborhoodCount > value.activeFacilityCount ||
      value.facilitiesWithoutAudienceCount > value.activeFacilityCount
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Missing configuration counts cannot exceed active facilities.',
        path: ['activeFacilityCount'],
      });
    }
    if (value.status !== expected) {
      context.addIssue({
        code: 'custom',
        message: 'Facility readiness status must match the coverage evidence.',
        path: ['status'],
      });
    }
  })
  .readonly();

/** Latest staff-roster attempt and last publishable snapshot evidence. */
export const RosterReadinessSchema = z
  .object({
    status: z.enum(['ready', 'action-required']),
    freshnessWindowSeconds: z.literal(ADMIN_READINESS_FRESHNESS_WINDOW_SECONDS),
    latestAttemptCompletedAt: TimestampSchema.nullable(),
    latestAttemptOutcome: z
      .enum(['complete', 'failed', 'partial-rejected'])
      .nullable(),
    latestCompleteSnapshotCapturedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.latestAttemptCompletedAt === null) !==
      (value.latestAttemptOutcome === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A roster attempt timestamp and outcome must appear together.',
        path: ['latestAttemptCompletedAt'],
      });
    }
  })
  .readonly();

/** Provider-observed confirmation state for one bounded alarm topic. */
export const AlarmTopicReadinessSchema = z
  .object({
    kind: z.enum(['operations', 'critical']),
    status: AdminReadinessStatusSchema,
    confirmedSubscriberCount: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.confirmedSubscriberCount === null
        ? 'unavailable'
        : value.confirmedSubscriberCount > 0
          ? 'ready'
          : 'action-required';
    if (value.status !== expected) {
      context.addIssue({
        code: 'custom',
        message:
          'Alarm readiness status must match confirmed subscriber evidence.',
        path: ['status'],
      });
    }
  })
  .readonly();

/** Complete, credential-free readiness projection for the administrator UI. */
export const AdminReadinessSchema = z
  .object({
    observedAt: TimestampSchema,
    overallStatus: AdminReadinessStatusSchema,
    accessMembership: AccessMembershipReadinessSchema,
    facilityConfiguration: FacilityConfigurationReadinessSchema,
    roster: RosterReadinessSchema,
    alarmTopics: z.array(AlarmTopicReadinessSchema).length(2).readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    const observedAt = Date.parse(value.observedAt);
    for (const [index, group] of value.accessMembership.groups.entries()) {
      if (group.membersCapturedAt === null) continue;
      const capturedAt = Date.parse(group.membersCapturedAt);
      if (capturedAt > observedAt) {
        context.addIssue({
          code: 'custom',
          message: 'Membership read evidence cannot be in the future.',
          path: ['accessMembership', 'groups', index, 'membersCapturedAt'],
        });
        continue;
      }
      const expected =
        observedAt - capturedAt <=
        value.accessMembership.freshnessWindowSeconds * 1_000
          ? 'fresh'
          : 'stale';
      if (group.status !== expected) {
        context.addIssue({
          code: 'custom',
          message: 'Membership read state must match the freshness window.',
          path: ['accessMembership', 'groups', index, 'status'],
        });
      }
    }

    const rosterTimes = [
      value.roster.latestAttemptCompletedAt,
      value.roster.latestCompleteSnapshotCapturedAt,
    ].filter((timestamp): timestamp is string => timestamp !== null);
    if (rosterTimes.some((timestamp) => Date.parse(timestamp) > observedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Roster readiness evidence cannot be in the future.',
        path: ['roster'],
      });
    }
    const rosterReady =
      value.roster.latestAttemptOutcome === 'complete' &&
      value.roster.latestAttemptCompletedAt !== null &&
      value.roster.latestCompleteSnapshotCapturedAt !== null &&
      observedAt - Date.parse(value.roster.latestAttemptCompletedAt) <=
        value.roster.freshnessWindowSeconds * 1_000 &&
      observedAt - Date.parse(value.roster.latestCompleteSnapshotCapturedAt) <=
        value.roster.freshnessWindowSeconds * 1_000;
    if (value.roster.status !== (rosterReady ? 'ready' : 'action-required')) {
      context.addIssue({
        code: 'custom',
        message:
          'Roster readiness status must match the latest retained evidence.',
        path: ['roster', 'status'],
      });
    }

    if (
      new Set(value.alarmTopics.map(({ kind }) => kind)).size !== 2 ||
      !value.alarmTopics.some(({ kind }) => kind === 'operations') ||
      !value.alarmTopics.some(({ kind }) => kind === 'critical')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Readiness must report each alarm topic exactly once.',
        path: ['alarmTopics'],
      });
    }
    const statuses = [
      value.accessMembership.status,
      value.facilityConfiguration.status,
      value.roster.status,
      ...value.alarmTopics.map(({ status }) => status),
    ];
    const expectedOverall = statuses.includes('action-required')
      ? 'action-required'
      : statuses.includes('unavailable')
        ? 'unavailable'
        : 'ready';
    if (value.overallStatus !== expectedOverall) {
      context.addIssue({
        code: 'custom',
        message: 'Overall readiness must match the individual checks.',
        path: ['overallStatus'],
      });
    }
  })
  .readonly();

/** Administrative readiness projection inferred from its schema. */
export type AdminReadiness = z.infer<typeof AdminReadinessSchema>;
