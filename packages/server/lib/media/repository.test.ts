import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';

import * as relations from '../../db/relations';
import * as tables from '../../db/schema';
import {
  events,
  journalEntries,
  mediaRecords,
  mediaUploadIntents,
} from '../../db/schema';
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
  buildAuthorizedReadyMediaQuery,
  buildBoundedMediaUploadUsageQueries,
  buildMediaReadEventLockQuery,
  buildPhotoChecksumExportQuery,
  MEDIA_UNATTRIBUTED_USAGE_QUERY_ROW_LIMIT,
  MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS,
  mediaUploadBudgetViolation,
  type MediaUploadResourceUsage,
} from './repository';

const EVENT_ID = '00000000-0000-4000-8000-000000000701';
const FACILITY_ID = '00000000-0000-4000-8000-000000000702';
const USER_ID = '00000000-0000-4000-8000-000000000703';
const MEDIA_ID = '00000000-0000-4000-8000-000000000704';

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
    const config = getTableConfig(journalEntries);
    const foreignKey = config.foreignKeys
      .map((candidate) => candidate.reference())
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
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        'journal_entries_event_media_idx',
        'journal_entries_event_redaction_target_idx',
      ]),
    );
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

describe('redaction-aware private media reads', () => {
  test('locks the exact event in a separate statement before visibility is read', () => {
    const database = drizzle.mock({ schema: { ...tables, ...relations } });
    const lock = buildMediaReadEventLockQuery(database, EVENT_ID).toSQL();
    const visibility = buildAuthorizedReadyMediaQuery(
      database,
      EVENT_ID,
      MEDIA_ID,
    ).toSQL();

    expect(lock.sql).toContain('from "events"');
    expect(lock.sql).toContain('where "events"."id" = $1');
    expect(lock.sql).toContain('for share of "events"');
    expect(lock.sql).not.toContain('journal_entries');
    expect(lock.params).toContain(EVENT_ID);

    expect(visibility.sql).not.toContain('for share');
    expect(visibility.sql).toContain('from "media_records"');
    expect(visibility.sql).toContain('"media_records"."id" = $1');
    expect(visibility.sql).toContain('"media_records"."event_id" = $2');
    expect(visibility.params).toEqual(
      expect.arrayContaining([MEDIA_ID, EVENT_ID, 'photo', 'redaction']),
    );
  });

  test('requires one same-event photo binding without an exact redaction', () => {
    const database = drizzle.mock({ schema: { ...tables, ...relations } });
    const query = buildAuthorizedReadyMediaQuery(
      database,
      EVENT_ID,
      MEDIA_ID,
    ).toSQL();

    expect(query.sql).toContain('exists (select');
    expect(query.sql).toContain(
      '"journal_entries"."event_id" = "media_records"."event_id"',
    );
    expect(query.sql).toContain(
      '"journal_entries"."media_id" = "media_records"."id"',
    );
    expect(query.sql).toContain('"journal_entries"."kind" = $3');
    expect(query.sql).toContain('not exists (select');
    expect(query.sql).toContain(
      '"media_read_redactions"."event_id" = "journal_entries"."event_id"',
    );
    expect(query.sql).toContain(
      '"media_read_redactions"."supersedes_entry_id" = "journal_entries"."id"',
    );
    expect(query.sql).toContain(
      '"media_read_redactions"."supersedes_entry_sequence" = "journal_entries"."sequence"',
    );
    expect(query.sql).toContain(
      '"media_read_redactions"."supersession_kind" = $4',
    );
  });
});

describe('bounded media upload usage reads', () => {
  test('persists the trusted event/facility anchor and all admission indexes', () => {
    const config = getTableConfig(mediaUploadIntents);
    const foreignKey = config.foreignKeys
      .map((candidate) => candidate.reference())
      .find(
        (candidate) =>
          candidate.name === 'media_upload_intents_event_facility_fk',
      );

    expect(foreignKey).toBeDefined();
    expect(foreignKey?.columns.map((column) => column.name)).toEqual([
      'event_id',
      'facility_id',
    ]);
    expect(foreignKey?.foreignColumns.map((column) => column.name)).toEqual([
      'id',
      'facility_id',
    ]);
    expect(foreignKey?.foreignTable).toBe(events);
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual(
      [
        'media_upload_intents_budget_principal_created_idx',
        'media_upload_intents_event_active_idx',
        'media_upload_intents_event_created_idx',
        'media_upload_intents_facility_active_idx',
        'media_upload_intents_facility_created_idx',
        'media_upload_intents_storage_key_uq',
        'media_upload_intents_unattributed_created_idx',
      ].sort(),
    );
  });

  test('caps every indexed history read at its allocation ceiling plus one', () => {
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
      unattributedRecent: queries.unattributedRecent.toSQL(),
      eventActive: queries.eventActive.toSQL(),
      eventRolling: queries.eventRolling.toSQL(),
      facilityActive: queries.facilityActive.toSQL(),
      facilityRolling: queries.facilityRolling.toSQL(),
    };

    for (const name of [
      'principalRolling',
      'eventActive',
      'eventRolling',
      'facilityActive',
      'facilityRolling',
    ] as const) {
      const query = compiled[name];
      expect(query.sql).not.toMatch(/\b(?:count|sum)\s*\(/iu);
      expect(query.sql).toContain('order by');
      expect(query.sql).toContain('limit');
      expect(query.params.at(-1)).toBe(
        MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS[
          name as keyof typeof MEDIA_UPLOAD_USAGE_QUERY_ROW_LIMITS
        ],
      );
    }
    expect(compiled.principalRolling.sql).toContain(
      '"media_upload_intents"."budget_principal_digest" = $1',
    );
    expect(compiled.principalRolling.sql).not.toContain('idempotency_records');
    expect(compiled.unattributedRecent.sql).toContain(
      '"media_upload_intents"."budget_principal_attributed" = $1',
    );
    expect(compiled.unattributedRecent.params.at(-1)).toBe(
      MEDIA_UNATTRIBUTED_USAGE_QUERY_ROW_LIMIT,
    );
    expect(compiled.eventActive.sql).toContain(
      `"media_upload_intents"."status" = 'pending-upload'`,
    );
    expect(compiled.facilityActive.sql).toContain(
      '"media_upload_intents"."facility_id" = $1',
    );
    expect(compiled.facilityRolling.sql).toContain(
      '"media_upload_intents"."facility_id" = $1',
    );
    expect(compiled.facilityActive.sql).not.toContain('join "events"');
    expect(compiled.facilityRolling.sql).not.toContain('join "events"');
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
