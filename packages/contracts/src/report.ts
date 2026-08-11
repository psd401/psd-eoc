import { z } from 'zod';

import { PaginationCursorSchema, paginatedSchema } from './api';
import { EventIdSchema, EventStatusSchema } from './event';
import {
  EventTypeIdSchema,
  EventTypeVersionRefSchema,
  NotificationChannelSchema,
} from './event-type';
import { FacilityIdSchema } from './facility';
import {
  AttemptDeliveryTruthStateSchema,
  NotificationIntentIdSchema,
  NotificationStatusSchema,
} from './notification';
import {
  HttpsUrlSchema,
  isAtOrAfter,
  TimestampSchema,
  UuidSchema,
} from './shared';

/** Owns a delivery report request for one immutable notification intent. */
export const RunDeliveryReportInputSchema = z
  .object({
    intentId: NotificationIntentIdSchema,
  })
  .strict()
  .readonly();

/** Notification delivery-report input inferred from its schema. */
export type RunDeliveryReportInput = z.infer<
  typeof RunDeliveryReportInputSchema
>;

/**
 * Owns evidence-honest delivery counts for one channel. Provider acceptance,
 * verified delivery, and unknown remain separate; no percentage implies human
 * receipt and no endpoint destinations appear.
 */
export const DeliveryChannelReportSchema = z
  .object({
    channel: NotificationChannelSchema,
    latestStateCounts: z
      .array(
        z
          .object({
            state: AttemptDeliveryTruthStateSchema,
            count: z.number().int().nonnegative().max(12_000),
          })
          .strict()
          .readonly(),
      )
      .max(8)
      .readonly(),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      new Set(report.latestStateCounts.map((row) => row.state)).size !==
      report.latestStateCounts.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery report state rows must be unique.',
        path: ['latestStateCounts'],
      });
    }
  })
  .readonly();

/** Evidence-honest per-channel delivery report inferred from its schema. */
export type DeliveryChannelReport = z.infer<typeof DeliveryChannelReportSchema>;

/** Owns a destination-free delivery report for one notification intent. */
export const DeliveryReportSchema = z
  .object({
    notification: NotificationStatusSchema,
    channels: z.array(DeliveryChannelReportSchema).min(2).max(3).readonly(),
    generatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (
      new Set(report.channels.map((channel) => channel.channel)).size !==
      report.channels.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery report channels must be unique.',
        path: ['channels'],
      });
    }
    const plannedChannels = report.notification.intent.channels;
    const reportChannelNames = report.channels.map((row) => row.channel);
    const plannedChannelNames = plannedChannels.map((row) => row.channel);
    if (
      reportChannelNames.length !== plannedChannelNames.length ||
      reportChannelNames.some(
        (channel) => !plannedChannelNames.includes(channel),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Delivery reports require exactly one row for every planned notification channel.',
        path: ['channels'],
      });
    }
    report.channels.forEach((channel, index) => {
      const plannedChannel = plannedChannels.find(
        (candidate) => candidate.channel === channel.channel,
      );
      const countedEndpoints = channel.latestStateCounts.reduce(
        (total, row) => total + row.count,
        0,
      );
      if (
        plannedChannel === undefined ||
        countedEndpoints > plannedChannel.endpointCount
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Per-channel latest-state counts cannot exceed planned recipient endpoints.',
          path: ['channels', index, 'latestStateCounts'],
        });
      }
    });
    if (report.notification.generatedAt !== report.generatedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Delivery report projections must share one generation time.',
        path: ['notification', 'generatedAt'],
      });
    }
  })
  .readonly();

/** Destination-free delivery report inferred from its schema. */
export type DeliveryReport = z.infer<typeof DeliveryReportSchema>;

/**
 * Owns a retained drill record derived from append-only event history. It
 * supplies the date/time/type evidence needed by downstream records exports
 * without adding compliance-calendar or student-level data.
 */
export const DrillRecordSchema = z
  .object({
    id: UuidSchema,
    eventId: EventIdSchema,
    facilityId: FacilityIdSchema,
    kind: z.enum(['drill', 'test']),
    eventTypeVersion: EventTypeVersionRefSchema,
    eventTypeName: z.string().trim().min(1).max(160),
    status: EventStatusSchema,
    startedAt: TimestampSchema,
    allClearAt: TimestampSchema.nullable(),
    reactivatedAt: TimestampSchema.nullable(),
    closedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.eventTypeVersion.templateMode !== 'drill') {
      context.addIssue({
        code: 'custom',
        message: 'Drill records must reference drill-mode event types.',
        path: ['eventTypeVersion', 'templateMode'],
      });
    }
    if (record.status === 'draft') {
      context.addIssue({
        code: 'custom',
        message: 'A drill record exists only after activation.',
        path: ['status'],
      });
    }
    if (record.status === 'active') {
      const isInitialActivation =
        record.allClearAt === null && record.reactivatedAt === null;
      const isReactivation =
        record.allClearAt !== null && record.reactivatedAt !== null;
      if (
        (!isInitialActivation && !isReactivation) ||
        record.closedAt !== null
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Active drill records carry either no prior all-clear or a complete reactivation pair.',
          path: ['reactivatedAt'],
        });
      }
    }
    if (
      record.status === 'all-clear' &&
      (record.allClearAt === null || record.closedAt !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'All-clear drill records require an all-clear and no close.',
        path: ['allClearAt'],
      });
    }
    if (
      record.status === 'closed' &&
      (record.allClearAt === null || record.closedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Closed drill records require all-clear and close times.',
        path: ['closedAt'],
      });
    }
    if (record.reactivatedAt !== null && record.allClearAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'Drill reactivation requires retained all-clear history.',
        path: ['allClearAt'],
      });
    }
    if (
      record.allClearAt &&
      !isAtOrAfter(record.allClearAt, record.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Drill all-clear cannot precede its start.',
        path: ['allClearAt'],
      });
    }
    const lifecycleTimes = (
      record.status === 'active' && record.reactivatedAt !== null
        ? [record.allClearAt, record.reactivatedAt]
        : [record.reactivatedAt, record.allClearAt, record.closedAt]
    ).filter((value): value is string => value !== null);
    let previous = record.startedAt;
    lifecycleTimes.forEach((time) => {
      if (!isAtOrAfter(time, previous)) {
        context.addIssue({
          code: 'custom',
          message: 'Drill record lifecycle times must be chronological.',
          path: ['status'],
        });
      }
      previous = time;
    });
  })
  .readonly();

/** Retained append-only-derived drill record inferred from its schema. */
export type DrillRecord = z.infer<typeof DrillRecordSchema>;

/** Owns bounded drill-record list filters within authorized facilities. */
export const ListDrillRecordsInputSchema = z
  .object({
    facilityId: FacilityIdSchema.nullable(),
    eventTypeId: EventTypeIdSchema.nullable(),
    startedFrom: TimestampSchema.nullable(),
    startedThrough: TimestampSchema.nullable(),
    cursor: PaginationCursorSchema.nullable(),
    limit: z.number().int().positive().max(200),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.startedFrom &&
      input.startedThrough &&
      !isAtOrAfter(input.startedThrough, input.startedFrom)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Drill-record end filter cannot precede its start.',
        path: ['startedThrough'],
      });
    }
  })
  .readonly();

/** Drill-record list input inferred from its schema. */
export type ListDrillRecordsInput = z.infer<typeof ListDrillRecordsInputSchema>;

/** Owns a bounded page of retained drill records. */
export const DrillRecordPageSchema = paginatedSchema(DrillRecordSchema);

/** Retained drill-record page inferred from its schema. */
export type DrillRecordPage = z.infer<typeof DrillRecordPageSchema>;

/** Owns supported records-export artifact formats. */
export const RecordsExportFormatSchema = z.enum(['csv', 'pdf']);

/** Records-export artifact format inferred from its schema. */
export type RecordsExportFormat = z.infer<typeof RecordsExportFormatSchema>;

// An inclusive 366-day Pacific calendar range can span one extra absolute
// hour when it crosses the fall daylight-saving transition.
const MAX_DRILL_EXPORT_RANGE_MILLISECONDS = (366 * 24 + 1) * 60 * 60 * 1_000;

/** Owns a bounded export request for authorized drill records. */
export const ExportDrillRecordsInputSchema = z
  .object({
    facilityId: FacilityIdSchema,
    eventTypeId: EventTypeIdSchema.nullable(),
    startedFrom: TimestampSchema,
    startedThrough: TimestampSchema,
    format: z.literal('csv'),
  })
  .strict()
  .superRefine((input, context) => {
    if (!isAtOrAfter(input.startedThrough, input.startedFrom)) {
      context.addIssue({
        code: 'custom',
        message: 'Drill export end filter cannot precede its start.',
        path: ['startedThrough'],
      });
      return;
    }
    if (
      Date.parse(input.startedThrough) - Date.parse(input.startedFrom) >
      MAX_DRILL_EXPORT_RANGE_MILLISECONDS
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Drill exports cannot span more than 366 days.',
        path: ['startedThrough'],
      });
    }
  })
  .readonly();

/** Drill-record export input inferred from its schema. */
export type ExportDrillRecordsInput = z.infer<
  typeof ExportDrillRecordsInputSchema
>;

/** Owns an export request for one authorized operational event summary. */
export const ExportEventSummaryInputSchema = z
  .object({
    eventId: EventIdSchema,
    format: z.literal('pdf'),
  })
  .strict()
  .readonly();

/** Event-summary export input inferred from its schema. */
export type ExportEventSummaryInput = z.infer<
  typeof ExportEventSummaryInputSchema
>;

/** Owns the exact media types available for records-export artifacts. */
export const RecordsExportContentTypeSchema = z.enum([
  'text/csv; charset=utf-8',
  'application/pdf',
]);

/** Records-export artifact media type inferred from its schema. */
export type RecordsExportContentType = z.infer<
  typeof RecordsExportContentTypeSchema
>;

const RecordsExportFileNameSchema = z
  .string()
  .min(5)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,195}\.(?:csv|pdf)$/u);

/**
 * Owns a short-lived private records-export grant. The content digest and row
 * count support verification; exact content metadata prevents format
 * confusion. The capability authorizes every read and never turns export URLs
 * into permanent public links.
 */
export const RecordsExportSchema = z
  .object({
    id: UuidSchema,
    format: RecordsExportFormatSchema,
    contentType: RecordsExportContentTypeSchema,
    fileName: RecordsExportFileNameSchema,
    byteLength: z.number().int().positive(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    rowCount: z.number().int().nonnegative().max(100_000),
    downloadUrl: HttpsUrlSchema,
    generatedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    const expected =
      artifact.format === 'csv'
        ? { contentType: 'text/csv; charset=utf-8', extension: '.csv' }
        : { contentType: 'application/pdf', extension: '.pdf' };
    if (artifact.contentType !== expected.contentType) {
      context.addIssue({
        code: 'custom',
        message: 'Records export content type must match its format.',
        path: ['contentType'],
      });
    }
    if (!artifact.fileName.endsWith(expected.extension)) {
      context.addIssue({
        code: 'custom',
        message: 'Records export filename extension must match its format.',
        path: ['fileName'],
      });
    }
    if (
      !isAtOrAfter(artifact.expiresAt, artifact.generatedAt) ||
      Date.parse(artifact.expiresAt) - Date.parse(artifact.generatedAt) >
        15 * 60 * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Records export grants must expire within fifteen minutes.',
        path: ['expiresAt'],
      });
    }
  })
  .readonly();

/** Short-lived private records-export grant inferred from its schema. */
export type RecordsExport = z.infer<typeof RecordsExportSchema>;

/**
 * Owns one event-summary export result, binding the private artifact to the
 * exact event whose retained append-only history was rendered.
 */
export const EventSummaryExportSchema = z
  .object({
    eventId: EventIdSchema,
    artifact: RecordsExportSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.artifact.format !== 'pdf') {
      context.addIssue({
        code: 'custom',
        message: 'Event summaries must reference PDF artifacts.',
        path: ['artifact', 'format'],
      });
    }
  })
  .readonly();

/** Event-summary export result inferred from its schema. */
export type EventSummaryExport = z.infer<typeof EventSummaryExportSchema>;
