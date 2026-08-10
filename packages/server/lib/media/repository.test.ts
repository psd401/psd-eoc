import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';

import * as relations from '../../db/relations';
import * as tables from '../../db/schema';
import { journalEntries, mediaRecords } from '../../db/schema';
import { buildPhotoChecksumExportQuery } from './repository';

const EVENT_ID = '00000000-0000-4000-8000-000000000701';

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
