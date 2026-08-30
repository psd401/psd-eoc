import { JournalEntrySchema } from '@psd-eoc/contracts';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { parseIgnoringNewServerFields } from './forward-compatible-parse';

const uuid = (suffix: number): string =>
  `16000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

function textEntry(): Record<string, unknown> {
  return {
    id: uuid(1),
    eventId: uuid(2),
    sequence: 1,
    kind: 'text',
    author: { kind: 'human', userId: uuid(3), sessionId: uuid(4) },
    authorDisplayName: 'Casey Rivera',
    source: 'mobile',
    serverTime: '2026-08-30T22:04:56.000Z',
    clientTime: null,
    supersedes: null,
    payload: { text: 'Synthetic drill update.' },
  };
}

describe('parseIgnoringNewServerFields', () => {
  test('accepts a journal entry carrying a field this build never shipped', () => {
    const entry = parseIgnoringNewServerFields(JournalEntrySchema, {
      ...textEntry(),
      acknowledgedByCount: 3,
    });
    expect(entry.id).toBe(uuid(1));
    expect('acknowledgedByCount' in entry).toBe(false);
  });

  test('still rejects an entry that is missing a field this build needs', () => {
    const withoutPayload = textEntry();
    delete withoutPayload.payload;
    expect(() =>
      parseIgnoringNewServerFields(JournalEntrySchema, withoutPayload),
    ).toThrow();
  });

  test('still rejects an entry whose known field has the wrong type', () => {
    expect(() =>
      parseIgnoringNewServerFields(JournalEntrySchema, {
        ...textEntry(),
        sequence: 'first',
      }),
    ).toThrow();
  });

  test('drops unknown fields at every depth of a response envelope', () => {
    const envelope = z
      .object({
        cursor: z.string().nullable(),
        entries: z.array(
          z.object({ id: z.string(), label: z.string() }).strict(),
        ),
      })
      .strict();

    expect(
      parseIgnoringNewServerFields(envelope, {
        cursor: null,
        entries: [{ id: 'a', label: 'one', pinned: true }],
        serverRegion: 'us-west-2',
      }),
    ).toEqual({ cursor: null, entries: [{ id: 'a', label: 'one' }] });
  });

  test('leaves the caller payload untouched', () => {
    const payload = { ...textEntry(), acknowledgedByCount: 3 };
    parseIgnoringNewServerFields(JournalEntrySchema, payload);
    expect(payload.acknowledgedByCount).toBe(3);
  });
});
