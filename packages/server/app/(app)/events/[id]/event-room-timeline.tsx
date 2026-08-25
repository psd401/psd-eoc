'use client';

import {
  type JournalEntry,
  type JournalEntryReadProjection,
} from '@psd-eoc/contracts';

import { LocationEntryContent } from './event-room-location';
import {
  AuthorizedPhoto,
  DeferredPrivatePhoto,
  type PrivatePhotoLoadCoordinator,
  type PrivatePhotoMountMode,
} from './event-room-media';

export function readableDateTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(value));
}

type JournalReadMetadata = JournalEntryReadProjection['entry'];

function actorLabel(entry: JournalReadMetadata): string {
  switch (entry.author.kind) {
    case 'human':
      return 'Authenticated staff member';
    case 'agent':
      return 'Authorized district agent';
    case 'system':
      return 'PSD EOC system';
  }
}

function entryKindLabel(entry: JournalReadMetadata): string {
  switch (entry.kind) {
    case 'text':
      return 'Text update';
    case 'photo':
      return 'Photo update';
    case 'location':
      return 'Location update';
    case 'system':
      return 'System update';
  }
}

function EntryContent({
  projection,
  redacted,
  loadCoordinator,
  scrollRootRef,
  photoMountMode,
  onActivateOlderPhoto,
  classificationLabel,
  realEvent,
  locationMapVisible,
  onToggleLocationMap,
}: Readonly<{
  projection: JournalEntryReadProjection;
  redacted: boolean;
  loadCoordinator: PrivatePhotoLoadCoordinator;
  scrollRootRef: Readonly<{ current: HTMLDivElement | null }>;
  photoMountMode: PrivatePhotoMountMode;
  onActivateOlderPhoto: () => void;
  classificationLabel: string;
  realEvent: boolean;
  locationMapVisible: boolean;
  onToggleLocationMap: () => void;
}>) {
  if (redacted || projection.visibility === 'redacted') {
    return (
      <p className="entry-content redacted-content">
        Original content is hidden because a later append-only redaction
        supersedes this entry. Its sequence, timing, and provenance remain in
        the journal.
      </p>
    );
  }
  const { entry } = projection;
  switch (entry.kind) {
    case 'text':
      return <p className="entry-content">{entry.payload.text}</p>;
    case 'photo':
      if (photoMountMode === 'deferred-older') {
        return (
          <DeferredPrivatePhoto
            altText={entry.payload.altText}
            caption={entry.payload.caption}
            entryId={entry.id}
            entrySequence={entry.sequence}
            onActivate={onActivateOlderPhoto}
            classificationLabel={classificationLabel}
            realEvent={realEvent}
          />
        );
      }
      return (
        <AuthorizedPhoto
          altText={entry.payload.altText}
          caption={entry.payload.caption}
          entryId={entry.id}
          entrySequence={entry.sequence}
          eventId={entry.eventId}
          loadExplicitlyOnMount={photoMountMode === 'selected-older'}
          loadCoordinator={loadCoordinator}
          mediaId={entry.payload.mediaId}
          observeViewport={photoMountMode === 'recent'}
          classificationLabel={classificationLabel}
          realEvent={realEvent}
          scrollRootRef={scrollRootRef}
        />
      );
    case 'location':
      return (
        <LocationEntryContent
          entryId={entry.id}
          entrySequence={entry.sequence}
          mapVisible={locationMapVisible}
          onToggleMap={onToggleLocationMap}
          payload={entry.payload}
        />
      );
    case 'system':
      return <p className="entry-content">{entry.payload.summary}</p>;
  }
}

interface TimelineEntryProps {
  readonly displayTimeZone: string;
  readonly projection: JournalEntryReadProjection;
  readonly supersededBy: readonly JournalEntryReadProjection[];
  readonly commandsBlocked: boolean;
  readonly photoMountMode: PrivatePhotoMountMode;
  readonly photoLoadCoordinator: PrivatePhotoLoadCoordinator;
  readonly timelineScrollRef: Readonly<{
    current: HTMLDivElement | null;
  }>;
  readonly onCorrect: (entry: JournalEntry, opener: HTMLElement) => void;
  readonly onRedact: (entry: JournalEntry, opener: HTMLElement) => void;
  readonly onActivateOlderPhoto: (entryId: string) => void;
  readonly classificationLabel: string;
  readonly realEvent: boolean;
  readonly locationMapVisible: boolean;
  readonly onToggleLocationMap: () => void;
}

export function TimelineEntry({
  displayTimeZone,
  projection,
  supersededBy,
  commandsBlocked,
  photoMountMode,
  photoLoadCoordinator,
  timelineScrollRef,
  onCorrect,
  onRedact,
  onActivateOlderPhoto,
  classificationLabel,
  realEvent,
  locationMapVisible,
  onToggleLocationMap,
}: TimelineEntryProps) {
  const { entry } = projection;
  const latestSupersession = supersededBy.at(-1) ?? null;
  const redacted =
    projection.visibility === 'redacted' ||
    supersededBy.some(
      (candidate) => candidate.entry.supersedes?.kind === 'redaction',
    );
  const visibleEntry =
    projection.visibility === 'visible' ? projection.entry : null;
  const mayCorrect =
    (visibleEntry?.kind === 'text' || visibleEntry?.kind === 'location') &&
    latestSupersession === null;
  const mayRedact =
    visibleEntry !== null && entry.kind !== 'system' && !redacted;
  const ownSupersession = entry.supersedes;
  const classes = [
    'timeline-entry',
    `entry-${entry.kind}`,
    ownSupersession === null ? '' : `entry-${ownSupersession.kind}`,
    latestSupersession === null ? '' : 'entry-superseded',
  ]
    .filter(Boolean)
    .join(' ');
  const headingId = `entry-${entry.id}-heading`;
  return (
    <article
      aria-labelledby={headingId}
      className={classes}
      id={`entry-${entry.id}`}
    >
      <div className="entry-heading">
        <h3 id={headingId}>
          Entry {entry.sequence}: {entryKindLabel(entry)}
        </h3>
        <time dateTime={entry.serverTime}>
          {readableDateTime(entry.serverTime, displayTimeZone)}
        </time>
      </div>

      {ownSupersession === null ? null : (
        <p className="supersession-notice">
          This entry is an appended {ownSupersession.kind} of{' '}
          <a href={`#entry-${ownSupersession.entryId}`}>
            entry {ownSupersession.entrySequence}
          </a>
          . Reason: {ownSupersession.reason}
        </p>
      )}

      {latestSupersession === null ? null : (
        <p className="supersession-notice">
          This original entry was superseded, not deleted. Latest:{' '}
          <a href={`#entry-${latestSupersession.entry.id}`}>
            {latestSupersession.entry.supersedes?.kind ?? 'update'} entry{' '}
            {latestSupersession.entry.sequence}
          </a>
          .
        </p>
      )}

      <EntryContent
        loadCoordinator={photoLoadCoordinator}
        onActivateOlderPhoto={() => onActivateOlderPhoto(entry.id)}
        photoMountMode={photoMountMode}
        projection={projection}
        classificationLabel={classificationLabel}
        realEvent={realEvent}
        locationMapVisible={locationMapVisible}
        onToggleLocationMap={onToggleLocationMap}
        redacted={redacted}
        scrollRootRef={timelineScrollRef}
      />
      <p className="entry-meta">
        <span>{actorLabel(entry)}</span>
        <span>Source: {entry.source}</span>
        <span>
          Client-reported time:{' '}
          {entry.clientTime === null
            ? 'not supplied'
            : readableDateTime(entry.clientTime, displayTimeZone)}
        </span>
      </p>

      {!mayCorrect && !mayRedact ? null : (
        <div className="entry-actions">
          {mayCorrect && visibleEntry !== null ? (
            <button
              aria-haspopup="dialog"
              className="secondary"
              disabled={commandsBlocked}
              onClick={(event) => onCorrect(visibleEntry, event.currentTarget)}
              type="button"
            >
              Correct entry {entry.sequence}
            </button>
          ) : null}
          {mayRedact && visibleEntry !== null ? (
            <button
              aria-haspopup="dialog"
              className="secondary"
              disabled={commandsBlocked}
              onClick={(event) => onRedact(visibleEntry, event.currentTarget)}
              type="button"
            >
              Redact entry {entry.sequence}
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}
