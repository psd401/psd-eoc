import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';

import * as relations from '../../db/relations';
import * as tables from '../../db/schema';
import { journalEntries, mediaRecords } from '../../db/schema';
import {
  MEDIA_EVENT_ACTIVE_BYTE_LIMIT,
  MEDIA_EVENT_ACTIVE_INTENT_LIMIT,
  MEDIA_EVENT_ROLLING_BYTE_LIMIT,
  MEDIA_EVENT_ROLLING_INTENT_LIMIT,
  MEDIA_FACILITY_ACTIVE_BYTE_LIMIT,
  MEDIA_FACILITY_ACTIVE_INTENT_LIMIT,
  MEDIA_FACILITY_ROLLING_BYTE_LIMIT,
  MEDIA_FACILITY_ROLLING_INTENT_LIMIT,
  MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT,
  MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT,
} from './model';
import {
  buildBoundedMediaUploadUsageQueries,
  buildPhotoChecksumExportQuery,
  MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS,
  mediaUploadBudgetViolation,
  type MediaUploadResourceUsage,
} from './repository';

const EVENT_ID = '00000000-0000-4000-8000-000000000701';
const FACILITY_ID = '00000000-0000-4000-8000-000000000702';
const USER_ID = '00000000-0000-4000-8000-000000000703';

const EMPTY_USAGE: MediaUploadResourceUsage = Object.freeze({
  principalRollingIntents: 0,
  principalRollingBytes: 0,
  eventActiveIntents: 0,
  eventActiveBytes: 0,
  eventRollingIntents: 0,
  eventRollingBytes: 0,
  facilityActiveIntents: 0,
  facilityActiveBytes: 0,
  facilityRollingIntents: 0,
  facilityRollingBytes: 0,
});

describe('photo checksum journal/export binding', () => {
  test('binds every photo media reference to the same event at the schema boundary', () => {
    const foreignKey = getTableConfig(journalEntries)
      .foreignKeys.map((candidate) => candidate.reference())
      .find((candidate) => candidate.name === 'journal_entries_media_event_fk');

    expect(foreignKey).toBeDefined();
    expect(foreignKey?.columns.map((column) => column.name)).toEqual([
      'media_id',
      'event_id',
    ]);
    expect(foreignKey?.foreignColumns.map((column) => column.name)).toEqual([
      'id',
      'event_id',
    ]);
    expect(foreignKey?.foreignTable).toBe(mediaRecords);
  });

  test('exports the sanitized checksum through that exact same-event join', () => {
    const database = drizzle.mock({ schema: { ...tables, ...relations } });
    const query = buildPhotoChecksumExportQuery(database, EVENT_ID).toSQL();

    expect(query.sql).toContain('"media_records"."sanitized_content_sha256"');
    expect(query.sql).toContain(
      'inner join "media_records" on ("media_records"."id" = "journal_entries"."media_id" and "media_records"."event_id" = "journal_entries"."event_id")',
    );
    expect(query.sql).toContain('"journal_entries"."kind" = $2');
    expect(query.sql).toContain('order by "journal_entries"."sequence"');
    expect(query.params).toEqual([EVENT_ID, 'photo']);
  });
});

describe('bounded media upload usage reads', () => {
  test('caps every history read at its allocation ceiling plus one', () => {
    const database = drizzle.mock({ schema: { ...tables, ...relations } });
    const queries = buildBoundedMediaUploadUsageQueries(
      database,
      {
        eventId: EVENT_ID,
        facilityId: FACILITY_ID,
        budgetPrincipal: {
          kind: 'human',
          userId: USER_ID,
          digest: 'a'.repeat(64),
        },
      },
      new Date('2026-08-10T12:00:00.000Z'),
    );
    const compiled = {
      principalRolling: queries.principalRolling.toSQL(),
      eventActive: queries.eventActive.toSQL(),
      eventRolling: queries.eventRolling.toSQL(),
      facilityActive: queries.facilityActive.toSQL(),
      facilityRolling: queries.facilityRolling.toSQL(),
    };

    for (const [name, query] of Object.entries(compiled)) {
      expect(query.sql).not.toMatch(/\b(?:count|sum)\s*\(/iu);
      expect(query.sql).toContain('order by');
      expect(query.sql).toContain('limit');
      expect(query.params.at(-1)).toBe(
        MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS[
          name as keyof typeof MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS
        ],
      );
    }
    expect(compiled.principalRolling.sql).toContain('coalesce(');
    expect(compiled.principalRolling.sql).toContain(
      `"idempotency_records"."capability_id" = 'create-media-upload-intent'`,
    );
    expect(compiled.eventActive.sql).toContain(
      `"media_upload_intents"."status" = 'pending-upload'`,
    );
    expect(compiled.facilityActive.sql).toContain('inner join "events"');
    expect(compiled.facilityRolling.sql).toContain('inner join "events"');
  });
});

describe('media upload allocation budgets', () => {
  test('allows the exact inclusive boundary at every scope', () => {
    expect(
      mediaUploadBudgetViolation(
        {
          principalRollingIntents: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT - 1,
          principalRollingBytes: MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT - 1,
          eventActiveIntents: MEDIA_EVENT_ACTIVE_INTENT_LIMIT - 1,
          eventActiveBytes: MEDIA_EVENT_ACTIVE_BYTE_LIMIT - 1,
          eventRollingIntents: MEDIA_EVENT_ROLLING_INTENT_LIMIT - 1,
          eventRollingBytes: MEDIA_EVENT_ROLLING_BYTE_LIMIT - 1,
          facilityActiveIntents: MEDIA_FACILITY_ACTIVE_INTENT_LIMIT - 1,
          facilityActiveBytes: MEDIA_FACILITY_ACTIVE_BYTE_LIMIT - 1,
          facilityRollingIntents: MEDIA_FACILITY_ROLLING_INTENT_LIMIT - 1,
          facilityRollingBytes: MEDIA_FACILITY_ROLLING_BYTE_LIMIT - 1,
        },
        1,
      ),
    ).toBeNull();
  });

  const blockedCases = [
    [
      'principal-rolling-intents',
      { principalRollingIntents: MEDIA_PRINCIPAL_ROLLING_INTENT_LIMIT },
      1,
    ],
    [
      'principal-rolling-bytes',
      { principalRollingBytes: MEDIA_PRINCIPAL_ROLLING_BYTE_LIMIT },
      1,
    ],
    [
      'event-active-intents',
      { eventActiveIntents: MEDIA_EVENT_ACTIVE_INTENT_LIMIT },
      1,
    ],
    [
      'event-active-bytes',
      { eventActiveBytes: MEDIA_EVENT_ACTIVE_BYTE_LIMIT },
      1,
    ],
    [
      'event-rolling-intents',
      { eventRollingIntents: MEDIA_EVENT_ROLLING_INTENT_LIMIT },
      1,
    ],
    [
      'event-rolling-bytes',
      { eventRollingBytes: MEDIA_EVENT_ROLLING_BYTE_LIMIT },
      1,
    ],
    [
      'facility-active-intents',
      { facilityActiveIntents: MEDIA_FACILITY_ACTIVE_INTENT_LIMIT },
      1,
    ],
    [
      'facility-active-bytes',
      { facilityActiveBytes: MEDIA_FACILITY_ACTIVE_BYTE_LIMIT },
      1,
    ],
    [
      'facility-rolling-intents',
      { facilityRollingIntents: MEDIA_FACILITY_ROLLING_INTENT_LIMIT },
      1,
    ],
    [
      'facility-rolling-bytes',
      { facilityRollingBytes: MEDIA_FACILITY_ROLLING_BYTE_LIMIT },
      1,
    ],
  ] as const;

  for (const [dimension, usage, proposedBytes] of blockedCases) {
    test(`blocks ${dimension} before reserving the proposed grant`, () => {
      expect(
        mediaUploadBudgetViolation({ ...EMPTY_USAGE, ...usage }, proposedBytes),
      ).toBe(dimension);
    });
  }
});
