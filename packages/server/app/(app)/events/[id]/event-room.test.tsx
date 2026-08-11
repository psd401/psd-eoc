import { describe, expect, test } from 'bun:test';
import {
  EventSchema,
  JournalEntrySchema,
  projectJournalEntryForRead,
  type Event,
  type JournalEntry,
} from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import { EventRoom, eventRoomPollDelay } from './event-room';

const IDS = {
  event: '10000000-0000-4000-8000-000000000001',
  facility: '10000000-0000-4000-8000-000000000002',
  eventType: '10000000-0000-4000-8000-000000000003',
  roster: '10000000-0000-4000-8000-000000000004',
  user: '10000000-0000-4000-8000-000000000005',
  session: '10000000-0000-4000-8000-000000000006',
  activationPreview: '10000000-0000-4000-8000-000000000007',
  confirmation: '10000000-0000-4000-8000-000000000008',
  request: '10000000-0000-4000-8000-000000000009',
  original: '10000000-0000-4000-8000-000000000010',
  correction: '10000000-0000-4000-8000-000000000011',
  redactedOriginal: '10000000-0000-4000-8000-000000000012',
  redaction: '10000000-0000-4000-8000-000000000013',
} as const;

const ACTOR = {
  kind: 'human' as const,
  userId: IDS.user,
  sessionId: IDS.session,
};

function activeEvent(templateMode: 'real' | 'drill'): Event {
  const real = templateMode === 'real';
  return EventSchema.parse({
    id: IDS.event,
    facilityId: IDS.facility,
    kind: real ? 'incident' : 'drill',
    templateMode,
    eventTypeVersion: { id: IDS.eventType, templateMode },
    status: 'active',
    rosterSnapshotId: IDS.roster,
    rosterPopulation: real ? 'staff' : 'synthetic',
    createdBy: ACTOR,
    createdAt: '2026-08-10T16:00:00.000Z',
    activatedAt: '2026-08-10T16:01:00.000Z',
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: real
      ? {
          kind: 'human-confirmed',
          activationPreviewId: IDS.activationPreview,
          preparedActivationId: null,
          confirmationId: IDS.confirmation,
          consequenceDigest: 'a'.repeat(64),
          requestId: IDS.request,
        }
      : {
          kind: 'synthetic-training',
          activationPreviewId: IDS.activationPreview,
          consequenceDigest: 'b'.repeat(64),
          requestId: IDS.request,
        },
  });
}

function textEntry(
  input: Readonly<{
    id: string;
    sequence: number;
    text: string;
    serverTime: string;
    clientTime: string | null;
    supersedes: JournalEntry['supersedes'];
  }>,
): JournalEntry {
  return JournalEntrySchema.parse({
    id: input.id,
    eventId: IDS.event,
    sequence: input.sequence,
    author: ACTOR,
    source: 'web',
    serverTime: input.serverTime,
    clientTime: input.clientTime,
    supersedes: input.supersedes,
    kind: 'text',
    payload: { text: input.text },
  });
}

const ENTRIES = [
  textEntry({
    id: IDS.original,
    sequence: 1,
    text: 'Original operational update',
    serverTime: '2026-08-10T16:02:00.000Z',
    clientTime: '2026-08-10T16:20:00.000Z',
    supersedes: null,
  }),
  textEntry({
    id: IDS.correction,
    sequence: 2,
    text: 'Corrected operational update',
    serverTime: '2026-08-10T15:59:00.000Z',
    clientTime: '2026-08-10T15:30:00.000Z',
    supersedes: {
      entryId: IDS.original,
      entrySequence: 1,
      kind: 'correction',
      reason: 'Clarified the verified location.',
    },
  }),
  textEntry({
    id: IDS.redactedOriginal,
    sequence: 3,
    text: 'Sensitive staff-only detail',
    serverTime: '2026-08-10T16:04:00.000Z',
    clientTime: null,
    supersedes: null,
  }),
  textEntry({
    id: IDS.redaction,
    sequence: 4,
    text: '[Content redacted — original retained in journal]',
    serverTime: '2026-08-10T16:05:00.000Z',
    clientTime: null,
    supersedes: {
      entryId: IDS.redactedOriginal,
      entrySequence: 3,
      kind: 'redaction',
      reason: 'Removed unneeded personal information.',
    },
  }),
] as const;

function render(event: Event, entries: readonly JournalEntry[] = ENTRIES) {
  return renderToStaticMarkup(
    <EventRoom
      apiUrl={`/events/${event.id}/api`}
      csrfCookieName="__Host-psd-eoc-csrf"
      event={event}
      eventTypeLabel={
        event.templateMode === 'real' ? 'Lockdown' : 'Lockdown Drill'
      }
      facilityLabel="Synthetic North Campus"
      initialCursor="eyJ2IjoxfQ"
      initialEntries={entries.map((entry) =>
        projectJournalEntryForRead(entry, false),
      )}
      initialHasMore={false}
      initialSnapshotSequence={entries.at(-1)?.sequence ?? 0}
      sessionId={IDS.session}
    />,
  );
}

describe('event room server-rendered safety and history state', () => {
  test('keeps healthy polling in the 3–5 second window with bounded backoff', () => {
    expect(eventRoomPollDelay(0, 0)).toBe(3_000);
    expect(eventRoomPollDelay(0, 1)).toBe(5_000);
    expect(eventRoomPollDelay(1, 0)).toBe(6_000);
    expect(eventRoomPollDelay(1, 1)).toBe(10_000);
    expect(eventRoomPollDelay(99, 1)).toBe(30_000);
  });

  test('renders real and drill classification with words and symbols, not color alone', () => {
    const real = render(activeEvent('real'), []);
    const drill = render(activeEvent('drill'), []);

    expect(real).toContain('REAL INCIDENT');
    expect(real).toContain('Lockdown');
    expect(real).not.toContain('DRILL — TRAINING ONLY');
    expect(drill).toContain('DRILL — TRAINING ONLY');
    expect(drill).toContain('Lockdown Drill');
    expect(drill).not.toContain('REAL INCIDENT');
    expect(real).toContain('aria-hidden="true"');
    expect(drill).toContain('aria-hidden="true"');
  });

  test('renders immutable correction and redaction provenance without deleting originals', () => {
    const html = render(activeEvent('real'));

    expect(html.indexOf('Entry 1:')).toBeLessThan(html.indexOf('Entry 2:'));
    expect(html.indexOf('Entry 2:')).toBeLessThan(html.indexOf('Entry 3:'));
    expect(html.indexOf('Entry 3:')).toBeLessThan(html.indexOf('Entry 4:'));
    expect(html).toContain('This original entry was superseded, not deleted.');
    expect(html).toContain('Clarified the verified location.');
    expect(html).toContain('Removed unneeded personal information.');
    expect(html).toContain(
      'Original content is hidden because a later append-only redaction',
    );
    expect(html).toContain('Client-reported time:');
    expect(html).toContain(
      'Server-assigned sequence determines receipt order. Server-recorded and client-reported times are shown as supporting evidence.',
    );
    expect(html).toContain('Redact entry 1');
    expect(html).not.toContain('Correct entry 1');
    expect(html).not.toContain('Redact entry 3');
  });

  test('labels a draft as created without presenting a running timer', () => {
    const draft = EventSchema.parse({
      ...activeEvent('real'),
      status: 'draft',
      rosterSnapshotId: null,
      rosterPopulation: null,
      activatedAt: null,
      activationAuthorization: null,
    });
    const html = render(draft, []);

    expect(html).toContain('<dt>Created</dt>');
    expect(html).not.toContain('<dt>Started</dt>');
    expect(html).not.toContain('<dt>Elapsed</dt>');
  });

  test('offers only the lifecycle action valid for the current append-only state', () => {
    const active = render(activeEvent('real'), []);
    const allClear = EventSchema.parse({
      ...activeEvent('real'),
      status: 'all-clear',
      allClearAt: '2026-08-10T16:10:00.000Z',
    });
    const allClearHtml = render(allClear, []);
    const closed = EventSchema.parse({
      ...allClear,
      status: 'closed',
      closedAt: '2026-08-10T16:15:00.000Z',
    });
    const closedHtml = render(closed, []);

    expect(active).toContain('Review all-clear');
    expect(active).not.toContain('Review event close');
    expect(allClearHtml).toContain('Review event close');
    expect(allClearHtml).not.toContain('Review all-clear');
    expect(closedHtml).toContain('14 minutes');
    expect(closedHtml).toContain(
      'The event is closed. Its complete journal remains retained.',
    );
  });
});
