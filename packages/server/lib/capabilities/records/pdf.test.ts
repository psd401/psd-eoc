import { createHash } from 'node:crypto';

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { JournalEntryReadProjection } from '@psd-eoc/contracts';

import {
  EVENT_SUMMARY_ATTEMPT_STATES,
  EVENT_SUMMARY_PDF_MAX_JOURNAL_ENTRIES,
  EVENT_SUMMARY_PDF_MAX_SNAPSHOT_BYTES,
  renderEventSummaryPdf as renderEventSummaryPdfWithOrganization,
  type EventSummaryDeliveryChannelSnapshot,
  type EventSummaryEventSnapshot,
  type EventSummarySnapshot,
} from './pdf';

setDefaultTimeout(30_000);

const EVENT_ID = '10000000-0000-4000-8000-000000000001';
const PHOTO_MEDIA_ID = '10000000-0000-4000-8000-000000000090';
const PHOTO_CHECKSUM = 'a'.repeat(64);
const REDACTED_SECRET = 'redacted-original-secret-must-never-render';
const PHOTO_ALT_TEXT = 'Synthetic photo alternative text';
const PHOTO_CAPTION = 'Synthetic photo caption';
const PROVIDER_REFERENCE_SECRET = 'provider-reference-must-never-render';
const RECIPIENT_SECRET = 'synthetic-recipient@example.invalid';
const UNICODE_TEXT = 'José Nguyễn - Ελληνικά - Кириллица';
const ORGANIZATION_NAME = 'Example School District';

function renderEventSummaryPdf(
  source: EventSummarySnapshot,
): Promise<Uint8Array> {
  return renderEventSummaryPdfWithOrganization(source, ORGANIZATION_NAME);
}

const HUMAN_ACTOR = Object.freeze({
  kind: 'human' as const,
  userId: '10000000-0000-4000-8000-000000000010',
  sessionId: '10000000-0000-4000-8000-000000000011',
});

function uuid(sequence: number): string {
  return `10000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

function serverTime(sequence: number): string {
  return new Date(Date.UTC(2026, 7, 11, 16, sequence)).toISOString();
}

function visibleText(
  sequence: number,
  text: string,
  supersedes: Readonly<{
    entryId: string;
    entrySequence: number;
    kind: 'correction' | 'redaction';
    reason: string;
  }> | null = null,
): JournalEntryReadProjection {
  return {
    visibility: 'visible',
    entry: {
      id: uuid(sequence),
      eventId: EVENT_ID,
      sequence,
      kind: 'text',
      author: HUMAN_ACTOR,
      source: 'web',
      serverTime: serverTime(sequence),
      clientTime: null,
      supersedes,
      payload: { text },
    },
  };
}

function baseJournal(): readonly JournalEntryReadProjection[] {
  return Object.freeze([
    visibleText(
      1,
      `${UNICODE_TEXT}\nHostile PDF syntax: ) >> endobj /OpenAction << /S /JavaScript >> % and a control \u0000 marker.`,
    ),
    {
      visibility: 'visible',
      entry: {
        id: uuid(2),
        eventId: EVENT_ID,
        sequence: 2,
        kind: 'photo',
        author: HUMAN_ACTOR,
        source: 'web',
        serverTime: serverTime(2),
        clientTime: null,
        supersedes: null,
        payload: {
          mediaId: PHOTO_MEDIA_ID,
          altText: PHOTO_ALT_TEXT,
          caption: PHOTO_CAPTION,
        },
      },
    },
    {
      visibility: 'visible',
      entry: {
        id: uuid(3),
        eventId: EVENT_ID,
        sequence: 3,
        kind: 'location',
        author: HUMAN_ACTOR,
        source: 'web',
        serverTime: serverTime(3),
        clientTime: serverTime(2),
        supersedes: null,
        payload: {
          state: 'known',
          latitude: 47.389,
          longitude: -122.589,
          accuracyMeters: 5,
          label: 'Synthetic assembly point',
        },
      },
    },
    visibleText(4, 'Corrected operational note.', {
      entryId: uuid(1),
      entrySequence: 1,
      kind: 'correction',
      reason: 'Corrected a synthetic wording error.',
    }),
    {
      visibility: 'redacted',
      entry: {
        id: uuid(5),
        eventId: EVENT_ID,
        sequence: 5,
        kind: 'text',
        author: HUMAN_ACTOR,
        source: 'web',
        serverTime: serverTime(5),
        clientTime: null,
        supersedes: null,
      },
    },
    visibleText(6, '[Content redacted - original retained in journal]', {
      entryId: uuid(5),
      entrySequence: 5,
      kind: 'redaction',
      reason: 'Removed synthetic sensitive content from outward reads.',
    }),
    {
      visibility: 'visible',
      entry: {
        id: uuid(7),
        eventId: EVENT_ID,
        sequence: 7,
        kind: 'system',
        author: { kind: 'system', serviceId: 'event-capability' },
        source: 'worker',
        serverTime: serverTime(7),
        clientTime: null,
        supersedes: null,
        payload: {
          code: 'participant-joined',
          summary: 'Authenticated participant joined the synthetic event.',
          relatedRecordId: uuid(70),
        },
      },
    },
  ]);
}

function stateCounts() {
  return EVENT_SUMMARY_ATTEMPT_STATES.map((state, index) => ({
    state,
    count: index + 1,
  }));
}

function deliveryChannel(
  channel: 'push' | 'email' | 'sms' = 'push',
): EventSummaryDeliveryChannelSnapshot {
  return {
    channel,
    plannedEndpointCount: 36,
    noAttemptRecordCount: 7,
    noEvidenceCount: 8,
    stateCounts: stateCounts(),
    // Extra runtime data models a hostile assembler accidentally retaining
    // provider/recipient fields. The renderer never reads or serializes it.
    providerReference: PROVIDER_REFERENCE_SECRET,
    recipientAddress: RECIPIENT_SECRET,
  } as EventSummaryDeliveryChannelSnapshot;
}

function event(
  kind: EventSummaryEventSnapshot['kind'] = 'drill',
): EventSummaryEventSnapshot {
  return {
    id: EVENT_ID,
    kind,
    templateMode: kind === 'incident' ? 'real' : 'drill',
    status: 'closed',
    createdAt: '2026-08-11T15:59:00.000Z',
    activatedAt: '2026-08-11T16:00:00.000Z',
    allClearAt: '2026-08-11T16:20:00.000Z',
    reactivatedAt: null,
    closedAt: '2026-08-11T16:22:00.000Z',
    correctionOfEventId: null,
    correctionReason: null,
  };
}

function snapshot(
  options: Readonly<{
    kind?: EventSummaryEventSnapshot['kind'];
    journal?: readonly JournalEntryReadProjection[];
  }> = {},
): EventSummarySnapshot {
  return {
    generatedAt: '2026-08-11T17:00:00.000Z',
    event: event(options.kind),
    facility: { code: 'SYN-01', name: 'Synthetic Peninsula School' },
    eventType: {
      id: '10000000-0000-4000-8000-000000000020',
      name: 'Synthetic lockdown drill',
    },
    recordedParticipantCount: 17,
    journal: options.journal ?? baseJournal(),
    photos: [
      {
        journalEntryId: uuid(2),
        mediaId: PHOTO_MEDIA_ID,
        sanitizedContentSha256: PHOTO_CHECKSUM,
        sanitizedByteLength: 12_345,
        detectedContentType: 'image/jpeg',
      },
    ],
    delivery: [
      {
        purpose: 'activation',
        createdAt: '2026-08-11T16:00:01.000Z',
        explicitIntentState: 'recorded',
        channels: [deliveryChannel()],
      },
    ],
  };
}

function pageCount(bytes: Uint8Array): number {
  return (
    Buffer.from(bytes)
      .toString('latin1')
      .match(/\/Type\s*\/Page\b/gu)?.length ?? 0
  );
}

async function extractText(bytes: Uint8Array): Promise<string> {
  const executable = Bun.which('pdftotext');
  if (executable === null) throw new Error('pdftotext is unavailable.');
  const process = Bun.spawn([executable, '-', '-'], {
    stderr: 'pipe',
    stdin: bytes,
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0 || stderr.trim().length > 0) {
    throw new Error(`pdftotext failed: ${stderr}`);
  }
  return stdout;
}

const testWithPoppler = Bun.which('pdftotext') === null ? test.skip : test;

describe('event summary PDF renderer', () => {
  test('creates deterministic PDF 1.7 bytes with an embedded Noto Sans font', async () => {
    const first = await renderEventSummaryPdf(snapshot());
    const second = await renderEventSummaryPdf(snapshot());
    const raw = Buffer.from(first).toString('latin1');

    expect(Buffer.from(first.subarray(0, 8)).toString('ascii')).toBe(
      '%PDF-1.7',
    );
    expect(first).toEqual(second);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex'),
    );
    expect(pageCount(first)).toBeGreaterThan(0);
    expect(raw).toContain('/FontFile2');
    expect(raw).toContain('NotoSans');
  });

  for (const [kind, classification] of [
    ['incident', 'REAL INCIDENT'],
    ['drill', 'DRILL - TRAINING ONLY'],
    ['test', 'TEST - NOT A REAL INCIDENT'],
  ] as const) {
    testWithPoppler(`renders the exact ${kind} classification`, async () => {
      const text = await extractText(
        await renderEventSummaryPdf(snapshot({ kind })),
      );
      expect(text).toContain(classification);
    });
  }

  testWithPoppler(
    'renders hostile Unicode content across pages without losing journal or delivery truth',
    async () => {
      const repeated =
        'A long synthetic update wraps safely across the retained page width. ';
      const journal = [
        ...baseJournal(),
        ...Array.from({ length: 24 }, (_, index) =>
          visibleText(8 + index, `${UNICODE_TEXT} ${repeated.repeat(28)}`),
        ),
      ];
      const source = snapshot({ journal });
      const bytes = await renderEventSummaryPdf(source);
      const text = await extractText(bytes);
      const pages = text.split('\f').filter((page) => page.trim().length > 0);
      const renderedSequences = [
        ...text.matchAll(/Journal entry #(\d+)/gu),
      ].map((match) => Number(match[1]));
      const renderedFooters = [...text.matchAll(/Page (\d+) of (\d+)/gu)].map(
        (match) => [Number(match[1]), Number(match[2])],
      );

      expect(pages.length).toBeGreaterThan(2);
      expect(pages).toHaveLength(pageCount(bytes));
      for (const [index, page] of pages.entries()) {
        expect(page).toContain('DRILL - TRAINING ONLY');
        expect(renderedFooters[index]).toEqual([index + 1, pages.length]);
      }
      expect(renderedSequences).toEqual(
        Array.from({ length: journal.length }, (_, index) => index + 1),
      );
      expect(text).toContain(`Journal entry ID: ${uuid(3)}`);
      expect(text).toContain(`Journal entry ID: ${uuid(4)}`);
      expect(text).toContain(`Journal entry ID: ${uuid(6)}`);
      expect(text).toContain(UNICODE_TEXT);
      expect(text).toContain(HUMAN_ACTOR.sessionId);
      expect(text).toContain('CORRECTION - supersedes journal entry #1');
      expect(text).toContain('REDACTION - supersedes journal entry #5');
      expect(text).toContain('[REDACTED - ORIGINAL CONTENT WITHHELD]');
      expect(text.replaceAll(/\s/gu, '')).toContain(PHOTO_CHECKSUM);
      expect(text).toContain(PHOTO_ALT_TEXT);
      expect(text).toContain(PHOTO_CAPTION);
      expect(text).toContain(PHOTO_MEDIA_ID);
      expect(text).toContain(uuid(70));
      expect(text).not.toContain(REDACTED_SECRET);
      expect(text).not.toContain(PROVIDER_REFERENCE_SECRET);
      expect(text).not.toContain(RECIPIENT_SECRET);
      expect(text).toContain(
        'Provider acceptance is not delivery or human receipt.',
      );
      for (const state of EVENT_SUMMARY_ATTEMPT_STATES) {
        expect(text).toContain(`${state}:`);
      }
      expect(text).toContain('no-attempt-record gap: 7');
      expect(text).toContain('attempt-with-no-evidence gap: 8');
    },
  );

  testWithPoppler(
    'renders visible Unicode markers for every code point absent from the embedded font',
    async () => {
      const source = snapshot({
        journal: [visibleText(1, 'ASCII BEFORE 中文 العربية 🚨 ASCII AFTER')],
      });
      const text = await extractText(
        await renderEventSummaryPdf({ ...source, photos: [] }),
      );

      expect(text).toContain('ASCII BEFORE');
      expect(text).toContain('[U+4E2D][U+6587]');
      expect(text).toContain(
        '[U+0627][U+0644][U+0639][U+0631][U+0628][U+064A][U+0629]',
      );
      expect(text).toContain('[U+1F6A8]');
      expect(text).toContain('ASCII AFTER');
    },
  );

  test('rejects inconsistent real-versus-drill classification before rendering', async () => {
    const invalid = snapshot();
    await expect(
      renderEventSummaryPdf({
        ...invalid,
        event: { ...invalid.event, templateMode: 'real' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });

  test('rejects unsafe organization metadata before rendering', async () => {
    for (const invalidOrganizationName of [
      'Example District\nInjected metadata',
      'Example District\u202eSpoofed metadata',
      'Example District\u2028Injected metadata',
      '😀'.repeat(81),
      '界'.repeat(107),
    ]) {
      await expect(
        renderEventSummaryPdfWithOrganization(
          snapshot(),
          invalidOrganizationName,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    }
  });

  testWithPoppler(
    'renders event correction links and complete transition payload provenance',
    async () => {
      const source = snapshot();
      const correctionSourceId = uuid(80);
      const correctionReason = 'Corrected retained synthetic event details.';
      const transition = {
        id: uuid(81),
        sequence: 1,
        actor: HUMAN_ACTOR,
        source: 'web' as const,
        occurredAt: serverTime(8),
        requestId: uuid(82),
        confirmationId: null,
        consequenceDigest: null,
        targeting: {
          kind: 'drill' as const,
          templateMode: 'drill' as const,
          rosterPopulation: 'staff' as const,
        },
        idempotencyKey: 'synthetic-correction-transition',
        transition: 'reopen-as-correction' as const,
        sourceEventId: correctionSourceId,
        correctionEventId: EVENT_ID,
        from: 'closed' as const,
        to: 'draft' as const,
        reason: correctionReason,
      };
      const text = await extractText(
        await renderEventSummaryPdf({
          ...source,
          event: {
            ...source.event,
            status: 'draft',
            activatedAt: null,
            allClearAt: null,
            closedAt: null,
            correctionOfEventId: correctionSourceId,
            correctionReason,
          },
          journal: [
            {
              visibility: 'visible',
              entry: {
                id: uuid(1),
                eventId: EVENT_ID,
                sequence: 1,
                kind: 'system',
                author: HUMAN_ACTOR,
                source: 'web',
                serverTime: serverTime(8),
                clientTime: null,
                supersedes: null,
                payload: {
                  code: 'correction-opened',
                  summary: 'Synthetic correction opened.',
                  transition,
                },
              },
            },
          ],
          photos: [],
        }),
      );

      expect(text).toContain(`Correction of event ID: ${correctionSourceId}`);
      expect(text).toContain(`Correction reason: ${correctionReason}`);
      expect(text).toContain('Complete transition evidence:');
      expect(text.replaceAll(/[\s-]/gu, '')).toContain(
        JSON.stringify(transition).replaceAll(/[\s-]/gu, ''),
      );
    },
  );

  test('rejects journal gaps, duplicate sequences, and incomplete provenance', async () => {
    const source = snapshot();
    await expect(
      renderEventSummaryPdf({
        ...source,
        journal: [source.journal[0]!, source.journal[2]!],
        photos: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });

    const badCorrection = visibleText(2, 'Invalid correction.', {
      entryId: uuid(99),
      entrySequence: 1,
      kind: 'correction',
      reason: 'The target is absent.',
    });
    await expect(
      renderEventSummaryPdf({
        ...source,
        journal: [source.journal[0]!, badCorrection],
        photos: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });

  test('rejects hidden redacted payloads and redacted photo checksum metadata', async () => {
    const source = snapshot();
    const redacted = source.journal[4]!;
    await expect(
      renderEventSummaryPdf({
        ...source,
        journal: source.journal.map((projection, index) =>
          index === 4
            ? ({
                ...redacted,
                entry: {
                  ...redacted.entry,
                  payload: { text: REDACTED_SECRET },
                },
              } as unknown as JournalEntryReadProjection)
            : projection,
        ),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });

    const photo = source.journal[1]!;
    if (photo.visibility !== 'visible' || photo.entry.kind !== 'photo') {
      throw new Error('The photo fixture is invalid.');
    }
    await expect(
      renderEventSummaryPdf({
        ...source,
        journal: source.journal.map((projection, index) =>
          index === 1
            ? {
                visibility: 'redacted' as const,
                entry: {
                  id: photo.entry.id,
                  eventId: photo.entry.eventId,
                  sequence: photo.entry.sequence,
                  kind: photo.entry.kind,
                  author: photo.entry.author,
                  source: photo.entry.source,
                  serverTime: photo.entry.serverTime,
                  clientTime: photo.entry.clientTime,
                  supersedes: photo.entry.supersedes,
                },
              }
            : projection,
        ),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });

  test('requires all six exact delivery states and accounts for both evidence gaps', async () => {
    const source = snapshot();
    const intent = source.delivery[0]!;
    const channel = intent.channels[0]!;
    await expect(
      renderEventSummaryPdf({
        ...source,
        delivery: [
          {
            ...intent,
            channels: [
              {
                ...channel,
                stateCounts: channel.stateCounts.slice(0, -1),
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });

    await expect(
      renderEventSummaryPdf({
        ...source,
        delivery: [
          {
            ...intent,
            channels: [{ ...channel, noAttemptRecordCount: 0 }],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });

  test('fails closed at journal, input-byte, and rendered-page bounds', async () => {
    const source = snapshot();
    await expect(
      renderEventSummaryPdf({
        ...source,
        journal: Array.from(
          { length: EVENT_SUMMARY_PDF_MAX_JOURNAL_ENTRIES + 1 },
          () => source.journal[0]!,
        ),
        photos: [],
      }),
    ).rejects.toMatchObject({ code: 'INPUT_LIMIT_EXCEEDED' });

    await expect(
      renderEventSummaryPdf({
        ...source,
        eventType: {
          ...source.eventType,
          name: 'x'.repeat(EVENT_SUMMARY_PDF_MAX_SNAPSHOT_BYTES + 1),
        },
      }),
    ).rejects.toMatchObject({ code: 'INPUT_LIMIT_EXCEEDED' });

    const pageBoundText = 'bounded pagination evidence '
      .repeat(360)
      .slice(0, 9_900)
      .trim();
    const pageBoundJournal = Array.from({ length: 180 }, (_, index) =>
      visibleText(index + 1, pageBoundText),
    );
    await expect(
      renderEventSummaryPdf({
        ...source,
        journal: pageBoundJournal,
        photos: [],
        delivery: [],
      }),
    ).rejects.toMatchObject({ code: 'PAGE_LIMIT_EXCEEDED' });
  });
});
