import { describe, expect, test } from 'bun:test';
import {
  EventSchema,
  JournalEntrySchema,
  projectJournalEntryForRead,
  type Event,
  type JournalEntry,
} from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  EventRoom,
  PrivatePhotoLoadCoordinator,
  eventRoomPollDelay,
} from './event-room';

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
  photo: '10000000-0000-4000-8000-000000000014',
  media: '10000000-0000-4000-8000-000000000015',
  photoRedaction: '10000000-0000-4000-8000-000000000016',
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

function photoEntry(): JournalEntry {
  return JournalEntrySchema.parse({
    id: IDS.photo,
    eventId: IDS.event,
    sequence: 5,
    author: ACTOR,
    source: 'web',
    serverTime: '2026-08-10T16:06:00.000Z',
    clientTime: '2026-08-10T16:05:30.000Z',
    supersedes: null,
    kind: 'photo',
    payload: {
      mediaId: IDS.media,
      altText: 'Exterior assembly area with staff accountability teams',
      caption: 'Synthetic exercise photo',
    },
  });
}

function historicalPhotoEntry(sequence: number): JournalEntry {
  const suffix = String(sequence).padStart(12, '0');
  return JournalEntrySchema.parse({
    id: `20000000-0000-4000-8000-${suffix}`,
    eventId: IDS.event,
    sequence,
    author: ACTOR,
    source: 'web',
    serverTime: new Date(
      Date.parse('2026-08-10T16:00:00.000Z') + sequence * 1_000,
    ).toISOString(),
    clientTime: null,
    supersedes: null,
    kind: 'photo',
    payload: {
      mediaId: `30000000-0000-4000-8000-${suffix}`,
      altText: `Synthetic historical photo ${sequence}`,
      caption: `Retained synthetic caption ${sequence}`,
    },
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

function render(
  event: Event,
  entries: readonly JournalEntry[] = ENTRIES,
  initialHasMore = false,
) {
  return renderToStaticMarkup(
    <EventRoom
      apiUrl={`/events/${event.id}/api`}
      authorDisplayName="Synthetic Event Room Operator"
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
      initialHasMore={initialHasMore}
      initialSnapshotSequence={entries.at(-1)?.sequence ?? 0}
      sessionId={IDS.session}
    />,
  );
}

describe('event room server-rendered safety and history state', () => {
  test('keeps private-photo coordination reusable across StrictMode-style cleanup and setup', () => {
    const coordinator = new PrivatePhotoLoadCoordinator();
    let cleanupCancelled = false;
    let automaticStarted = false;
    let explicitStarted = false;
    let finishAutomatic: (() => void) | null = null;

    const cleanup = coordinator.enqueue({
      key: 'strict-mode-initial-effect',
      mode: 'explicit',
      onAutomaticLimit: () => undefined,
      onStartError: () => undefined,
      start: () => () => {
        cleanupCancelled = true;
      },
    });
    cleanup();
    expect(cleanupCancelled).toBe(true);

    coordinator.enqueue({
      key: 'strict-mode-viewport-demand',
      mode: 'automatic',
      onAutomaticLimit: () => undefined,
      onStartError: () => undefined,
      start: (complete) => {
        automaticStarted = true;
        finishAutomatic = complete;
        return () => undefined;
      },
    });
    expect(automaticStarted).toBe(true);
    if (finishAutomatic === null) {
      throw new Error('The remounted automatic load did not start.');
    }
    (finishAutomatic as () => void)();

    coordinator.enqueue({
      key: 'strict-mode-explicit-demand',
      mode: 'explicit',
      onAutomaticLimit: () => undefined,
      onStartError: () => undefined,
      start: () => {
        explicitStarted = true;
        return () => undefined;
      },
    });
    expect(explicitStarted).toBe(true);
  });

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

  test('announces complete SSR history as connected and paginated history as loading', () => {
    const complete = render(activeEvent('drill'), []);
    const paginated = render(activeEvent('drill'), ENTRIES, true);

    expect(complete).toContain('connection-line connection-connected');
    expect(complete).toContain('<span>Connected</span>');
    expect(complete).toContain('aria-busy="false"');
    expect(complete).not.toContain('Loading event history');
    expect(paginated).toContain('connection-line connection-loading');
    expect(paginated).toContain('<span>Loading event history</span>');
    expect(paginated).toContain('aria-busy="true"');
    expect(paginated).toContain(
      'Timeline content remains hidden until all authorized history',
    );
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

  test('renders private photo description without embedding a public URL', () => {
    const html = render(activeEvent('real'), [photoEntry()]);

    expect(html).toContain(
      'Exterior assembly area with staff accountability teams',
    );
    expect(html).toContain('Synthetic exercise photo');
    expect(html).toContain(
      'This private photo is not loaded. Load it explicitly if it is operationally needed.',
    );
    expect(html).toContain('Load private photo for entry 5');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://');
  });

  test('mounts stateful controls only for ten recent photos while retaining every older description and caption', () => {
    const photos = Array.from({ length: 12 }, (_, index) =>
      historicalPhotoEntry(index + 1),
    );
    const html = render(activeEvent('real'), photos);

    expect(html.match(/data-private-photo-mount="stateful"/gu)).toHaveLength(
      10,
    );
    expect(html.match(/data-private-photo-observer="enabled"/gu)).toHaveLength(
      10,
    );
    expect(html.match(/data-private-photo-mount="deferred"/gu)).toHaveLength(2);
    expect(html).toContain('Load older private photo for entry 1');
    expect(html).toContain('Load older private photo for entry 2');
    expect(html).not.toContain('Load older private photo for entry 3');
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      expect(html).toContain(`Synthetic historical photo ${sequence}`);
      expect(html).toContain(`Retained synthetic caption ${sequence}`);
    }
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://');
  });

  test('never mounts private photo rendering for an append-only redacted photo', () => {
    const redaction = textEntry({
      id: IDS.photoRedaction,
      sequence: 6,
      text: '[Content redacted — original retained in journal]',
      serverTime: '2026-08-10T16:07:00.000Z',
      clientTime: null,
      supersedes: {
        entryId: IDS.photo,
        entrySequence: 5,
        kind: 'redaction',
        reason: 'Synthetic photo no longer needed for operations.',
      },
    });
    const html = render(activeEvent('real'), [photoEntry(), redaction]);

    expect(html).toContain(
      'Original content is hidden because a later append-only redaction',
    );
    expect(html).not.toContain(
      'Exterior assembly area with staff accountability teams',
    );
    expect(html).not.toContain('Load private photo for entry 5');
    expect(html).not.toContain('<img');
  });

  test('renders a redacted photo projection without ever receiving its media payload', () => {
    const original = photoEntry();
    const redactedProjection = projectJournalEntryForRead(original, true);
    const serializedProjection = JSON.stringify(redactedProjection);

    expect(redactedProjection.visibility).toBe('redacted');
    expect(serializedProjection).not.toContain(IDS.media);
    expect(serializedProjection).not.toContain(
      'Exterior assembly area with staff accountability teams',
    );
    expect(serializedProjection).not.toContain('Synthetic exercise photo');

    const html = renderToStaticMarkup(
      <EventRoom
        apiUrl={`/events/${IDS.event}/api`}
        authorDisplayName="Synthetic Event Room Operator"
        csrfCookieName="__Host-psd-eoc-csrf"
        event={activeEvent('real')}
        eventTypeLabel="Lockdown"
        facilityLabel="Synthetic North Campus"
        initialCursor="eyJ2IjoxfQ"
        initialEntries={[redactedProjection]}
        initialHasMore={false}
        initialSnapshotSequence={original.sequence}
        sessionId={IDS.session}
      />,
    );

    expect(html).toContain(
      'Original content is hidden because a later append-only redaction',
    );
    expect(html).not.toContain(IDS.media);
    expect(html).not.toContain('Load private photo');
    expect(html).not.toContain('<img');
  });
});
