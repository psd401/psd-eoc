import { describe, expect, test } from 'bun:test';
import {
  EventSchema,
  JournalEntrySchema,
  projectJournalEntryForRead,
  type Event,
  type JournalEntry,
  type LocationPayload,
} from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  EventRoom,
  type LocationDraft,
  PrivatePhotoLoadCoordinator,
  eventRoomPollDelay,
  locationPayloadFromDraft,
  webLifecycleCommandBody,
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
  knownLocation: '10000000-0000-4000-8000-000000000017',
  ambiguousLocation: '10000000-0000-4000-8000-000000000018',
  unknownLocation: '10000000-0000-4000-8000-000000000019',
  correctedLocation: '10000000-0000-4000-8000-000000000020',
} as const;

const ACTOR = {
  kind: 'human' as const,
  userId: IDS.user,
  sessionId: IDS.session,
};

function activeEvent(
  templateMode: 'real' | 'drill',
  kind: 'incident' | 'drill' | 'test' = templateMode === 'real'
    ? 'incident'
    : 'drill',
): Event {
  const real = templateMode === 'real';
  return EventSchema.parse({
    id: IDS.event,
    facilityId: IDS.facility,
    kind,
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
    authorDisplayName: null,
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
    authorDisplayName: null,
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
    authorDisplayName: null,
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

function locationEntry(
  input: Readonly<{
    id: string;
    sequence: number;
    payload: LocationPayload;
    supersedes?: JournalEntry['supersedes'];
  }>,
): JournalEntry {
  return JournalEntrySchema.parse({
    id: input.id,
    eventId: IDS.event,
    sequence: input.sequence,
    author: ACTOR,
    authorDisplayName: null,
    source: 'web',
    serverTime: new Date(
      Date.parse('2026-08-10T16:00:00.000Z') + input.sequence * 60_000,
    ).toISOString(),
    clientTime: '2026-08-10T16:00:30.000Z',
    supersedes: input.supersedes ?? null,
    kind: 'location',
    payload: input.payload,
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

function systemEntry(
  input: Readonly<{
    id: string;
    sequence: number;
    code: string;
    summary: string;
    serverTime: string;
    displayName?: string | null;
    userId?: string;
  }>,
): JournalEntry {
  return JournalEntrySchema.parse({
    id: input.id,
    eventId: IDS.event,
    sequence: input.sequence,
    author: {
      kind: 'human',
      userId: input.userId ?? IDS.user,
      sessionId: IDS.session,
    },
    authorDisplayName: input.displayName ?? null,
    source: 'web',
    serverTime: input.serverTime,
    clientTime: null,
    supersedes: null,
    kind: 'system',
    payload: {
      code: input.code,
      summary: input.summary,
      relatedRecordId: null,
    },
  });
}

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
      displayTimeZone="America/New_York"
      event={event}
      eventTypeLabel={
        event.templateMode === 'real' ? 'Lockdown' : 'Lockdown Drill'
      }
      exportSummaryPath={`/records/export/events/${encodeURIComponent(event.id)}`}
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
  test('builds web lifecycle requests without typed acknowledgement fields', () => {
    expect(
      webLifecycleCommandBody({
        operation: 'all-clear',
        lifecyclePreviewId: IDS.activationPreview,
      }),
    ).toEqual({
      operation: 'all-clear',
      lifecyclePreviewId: IDS.activationPreview,
    });
    expect(webLifecycleCommandBody({ operation: 'close' })).toEqual({
      operation: 'close',
    });
  });

  test('keeps private-photo dimensions aspect-neutral', async () => {
    const styles = await Bun.file(
      new URL('./styles.css', import.meta.url),
    ).text();
    expect(styles).toMatch(
      /\.timeline-photo\s*\{[^}]*width:\s*auto;[^}]*height:\s*auto;/u,
    );
  });

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

  test('builds only canonical explicit location states from editor drafts', () => {
    expect(
      locationPayloadFromDraft({
        state: 'known',
        latitude: '47.385612',
        longitude: '-122.622407',
        accuracyMeters: '23.4',
        label: ' North staff entrance ',
        reason: '',
      } satisfies LocationDraft),
    ).toEqual({
      state: 'known',
      latitude: 47.385612,
      longitude: -122.622407,
      accuracyMeters: 23.4,
      label: 'North staff entrance',
    });
    expect(
      locationPayloadFromDraft({
        state: 'known',
        latitude: '47.385612',
        longitude: '-122.622407',
        accuracyMeters: '',
        label: '',
        reason: '',
      }),
    ).toBeNull();
    expect(
      locationPayloadFromDraft({
        state: 'ambiguous',
        latitude: '',
        longitude: '',
        accuracyMeters: '',
        label: ' Near the west field ',
        reason: ' Two possible assembly points ',
      }),
    ).toEqual({
      state: 'ambiguous',
      label: 'Near the west field',
      reason: 'Two possible assembly points',
    });
    expect(
      locationPayloadFromDraft({
        state: 'unknown',
        latitude: '',
        longitude: '',
        accuracyMeters: '',
        label: '',
        reason: ' Reporter could not verify a location ',
      }),
    ).toEqual({
      state: 'unknown',
      reason: 'Reporter could not verify a location',
    });
  });

  test('renders permanent text equivalents for known, ambiguous, and unknown locations', () => {
    const known = locationEntry({
      id: IDS.knownLocation,
      sequence: 5,
      payload: {
        state: 'known',
        latitude: 47.385612,
        longitude: -122.622407,
        accuracyMeters: 23.4,
        label: 'North staff entrance',
      },
    });
    const ambiguous = locationEntry({
      id: IDS.ambiguousLocation,
      sequence: 6,
      payload: {
        state: 'ambiguous',
        label: 'Near the west field',
        reason: 'Two possible assembly points',
      },
    });
    const unknown = locationEntry({
      id: IDS.unknownLocation,
      sequence: 7,
      payload: {
        state: 'unknown',
        reason: 'Reporter could not verify a location',
      },
    });
    const secondKnown = locationEntry({
      id: IDS.correctedLocation,
      sequence: 8,
      payload: {
        state: 'known',
        latitude: 47.386,
        longitude: -122.623,
        accuracyMeters: 40,
        label: null,
      },
    });
    const html = render(activeEvent('real'), [
      known,
      ambiguous,
      unknown,
      secondKnown,
    ]);

    expect(html).toContain(
      'North staff entrance: latitude 47.385612, longitude -122.622407; GPS accuracy radius ±23.4 meters.',
    );
    expect(html).toContain(
      'Browser GPS does not establish room-level location.',
    );
    expect(
      html.match(/<time dateTime="2026-08-10T16:05:00\.000Z">[^<]+<\/time>/gu),
    ).toHaveLength(1);
    expect(html).not.toContain('Server-recorded time:');
    expect(html).toContain('Ambiguous location: Near the west field.');
    expect(html).toContain('Reason: Two possible assembly points.');
    expect(html).toContain('Location unknown.');
    expect(html).toContain('Reason: Reporter could not verify a location.');
    expect(
      html.match(/Coordinates and accuracy are unavailable\./gu),
    ).toHaveLength(2);
    expect(html).toContain('Show map for entry 5');
    expect(html).toContain('Show map for entry 8');
    expect(html.match(/Show map for entry/gu)).toHaveLength(2);
    expect(html).not.toContain('location-map-frame');
    expect(html).not.toContain('Posted location pin and accuracy radius');
  });

  test('keeps posted locations immutable and offers append-only correction', () => {
    const known = locationEntry({
      id: IDS.knownLocation,
      sequence: 5,
      payload: {
        state: 'known',
        latitude: 47.385612,
        longitude: -122.622407,
        accuracyMeters: 23.4,
        label: 'North staff entrance',
      },
    });
    const correction = locationEntry({
      id: IDS.correctedLocation,
      sequence: 6,
      payload: {
        state: 'ambiguous',
        label: 'North side of campus',
        reason: 'Device evidence did not distinguish two entrances',
      },
      supersedes: {
        entryId: IDS.knownLocation,
        entrySequence: 5,
        kind: 'correction',
        reason: 'Reduced precision to match verified evidence.',
      },
    });

    const originalHtml = render(activeEvent('real'), [known]);
    expect(originalHtml).toContain('Correct entry 5');
    expect(originalHtml).toContain('Post a location');
    expect(originalHtml).toContain('Known coordinates');
    expect(originalHtml).toContain('Ambiguous location');
    expect(originalHtml).toContain('Unknown location');

    const correctedHtml = render(activeEvent('real'), [known, correction]);
    expect(correctedHtml).toContain('Edited later — see');
    expect(correctedHtml).toContain(
      'Reduced precision to match verified evidence.',
    );
    expect(correctedHtml).toContain(
      'Device evidence did not distinguish two entrances',
    );
    expect(correctedHtml).not.toContain('Correct entry 5');
  });

  test('renders real, drill, and test classification with words and symbols, not color alone', () => {
    const real = render(activeEvent('real'), []);
    const drill = render(activeEvent('drill'), []);
    const testEvent = render(activeEvent('drill', 'test'), []);

    expect(real).toContain('REAL INCIDENT');
    expect(real).toContain('Lockdown');
    expect(real).not.toContain('DRILL — TRAINING ONLY');
    expect(drill).toContain('DRILL — TRAINING ONLY');
    expect(drill).toContain('Lockdown Drill');
    expect(drill).not.toContain('REAL INCIDENT');
    expect(testEvent).toContain('TEST — NOT A REAL INCIDENT');
    expect(testEvent).not.toContain('DRILL — TRAINING ONLY');
    expect(testEvent).not.toContain('>REAL INCIDENT<');
    expect(real).toContain('aria-hidden="true"');
    expect(drill).toContain('aria-hidden="true"');
    expect(testEvent).toContain('aria-hidden="true"');
    expect(real).toContain('Download PDF summary');
    expect(real).toContain(
      `/records/export/events/${encodeURIComponent(IDS.event)}`,
    );
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
      'Updates appear once the whole timeline has loaded',
    );
  });

  test('renders immutable correction and redaction provenance without deleting originals', () => {
    const html = render(activeEvent('real'));

    expect(html.indexOf('Entry 1:')).toBeLessThan(html.indexOf('Entry 2:'));
    expect(html.indexOf('Entry 2:')).toBeLessThan(html.indexOf('Entry 3:'));
    expect(html.indexOf('Entry 3:')).toBeLessThan(html.indexOf('Entry 4:'));
    expect(html).toContain('Edited later — see');
    expect(html).toContain('Clarified the verified location.');
    expect(html).toContain('Removed unneeded personal information.');
    expect(html).toContain('This content was hidden later.');
    // Sequence and client-reported time are record-keeping, not reading
    // material during an incident; the entry card no longer carries them.
    expect(html).not.toContain('Client-reported time:');
    expect(html).not.toContain('Server-assigned sequence');
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

    // Ending an event is one action from the room, whatever half-finished
    // state a previous attempt left behind.
    expect(active).toContain('End event');
    expect(active).not.toContain('Finish ending the event');
    expect(active.indexOf('End event')).toBeLessThan(
      active.indexOf('Post an update'),
    );
    expect(allClearHtml).toContain('Finish ending the event');
    expect(allClearHtml).toContain('Staff have the all-clear');
    expect(closedHtml).toContain('14 minutes');
    expect(closedHtml).toContain('This event is closed.');
    expect(closedHtml).not.toContain('End event');
  });

  test('keeps routine system bookkeeping out of the timeline', () => {
    const html = render(activeEvent('drill'), [
      systemEntry({
        id: '10000000-0000-4000-8000-000000000030',
        sequence: 1,
        code: 'event-created',
        summary: 'Event record created.',
        serverTime: '2026-08-10T16:01:00.000Z',
        displayName: 'Robin Vega',
      }),
      systemEntry({
        id: '10000000-0000-4000-8000-000000000031',
        sequence: 2,
        code: 'notification-intent-recorded',
        summary: 'Notification send intent recorded.',
        serverTime: '2026-08-10T16:01:01.000Z',
        displayName: 'Robin Vega',
      }),
      systemEntry({
        id: '10000000-0000-4000-8000-000000000032',
        sequence: 3,
        code: 'participant-joined',
        summary: 'Authenticated participant joined the event.',
        serverTime: '2026-08-10T16:02:00.000Z',
        displayName: 'Sam Okonkwo',
        userId: '10000000-0000-4000-8000-000000000040',
      }),
      systemEntry({
        id: '10000000-0000-4000-8000-000000000033',
        sequence: 4,
        code: 'participant-joined',
        summary: 'Authenticated participant joined the event.',
        serverTime: '2026-08-10T16:02:40.000Z',
        displayName: 'Sam Okonkwo',
        userId: '10000000-0000-4000-8000-000000000040',
      }),
      textEntry({
        id: IDS.original,
        sequence: 5,
        text: 'Synthetic drill update.',
        serverTime: '2026-08-10T16:03:00.000Z',
        clientTime: null,
        supersedes: null,
      }),
    ]);

    expect(html).not.toContain('Event record created.');
    expect(html).not.toContain('Notification send intent recorded.');
    expect(html).not.toContain('Authenticated participant joined the event.');
    expect(html).toContain('Synthetic drill update.');
    // One card for the one thing a person wrote.
    expect(html.match(/class="timeline-entry/gu)).toHaveLength(1);
  });

  test('shows who is in the event once each, however often they joined', () => {
    const html = render(activeEvent('drill'), [
      systemEntry({
        id: '10000000-0000-4000-8000-000000000030',
        sequence: 1,
        code: 'event-created',
        summary: 'Event record created.',
        serverTime: '2026-08-10T16:01:00.000Z',
        displayName: 'Robin Vega',
      }),
      systemEntry({
        id: '10000000-0000-4000-8000-000000000032',
        sequence: 2,
        code: 'participant-joined',
        summary: 'Authenticated participant joined the event.',
        serverTime: '2026-08-10T16:02:00.000Z',
        displayName: 'Sam Okonkwo',
        userId: '10000000-0000-4000-8000-000000000040',
      }),
      systemEntry({
        id: '10000000-0000-4000-8000-000000000033',
        sequence: 3,
        code: 'participant-joined',
        summary: 'Authenticated participant joined the event.',
        serverTime: '2026-08-10T16:02:40.000Z',
        displayName: 'Sam Okonkwo',
        userId: '10000000-0000-4000-8000-000000000040',
      }),
    ]);

    expect(html).toContain('In this event');
    expect(html.match(/class="participant-chip"/gu)).toHaveLength(2);
    expect(html).toContain('>RV<');
    expect(html).toContain('>SO<');
    expect(html.match(/>SO</gu)).toHaveLength(1);
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
    expect(html.match(/dialog-classification mode-real/gu)).toHaveLength(3);
    expect(html.match(/REAL INCIDENT/gu)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
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

    expect(html).toContain('This content was hidden later.');
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
        displayTimeZone="America/New_York"
        event={activeEvent('real')}
        eventTypeLabel="Lockdown"
        exportSummaryPath={`/records/export/events/${encodeURIComponent(IDS.event)}`}
        facilityLabel="Synthetic North Campus"
        initialCursor="eyJ2IjoxfQ"
        initialEntries={[redactedProjection]}
        initialHasMore={false}
        initialSnapshotSequence={original.sequence}
        sessionId={IDS.session}
      />,
    );

    expect(html).toContain('This content was hidden later.');
    expect(html).not.toContain(IDS.media);
    expect(html).not.toContain('Load private photo');
    expect(html).not.toContain('<img');
  });
});
