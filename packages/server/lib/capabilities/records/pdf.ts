import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVENT_CLASSIFICATION_PRESENTATIONS,
  JournalEntryReadProjectionSchema,
  OrganizationNameSchema,
  getEventClassificationPresentation,
  type AttemptDeliveryTruthState,
  type EventClassificationLabel,
  type JournalEntryReadProjection,
  type MediaContentType,
  type NotificationChannel,
  type NotificationPurpose,
} from '@psd-eoc/contracts';
import PDFDocument from 'pdfkit';

export const EVENT_SUMMARY_PDF_MAX_BYTES = 25 * 1_024 * 1_024;
export const EVENT_SUMMARY_PDF_MAX_PAGES = 250;
export const EVENT_SUMMARY_PDF_MAX_SNAPSHOT_BYTES = 8 * 1_024 * 1_024;
export const EVENT_SUMMARY_PDF_MAX_JOURNAL_ENTRIES = 10_000;
export const EVENT_SUMMARY_PDF_MAX_PHOTOS = 10_000;
export const EVENT_SUMMARY_PDF_MAX_DELIVERY_INTENTS = 1_000;

export const EVENT_SUMMARY_ATTEMPT_STATES = Object.freeze([
  'attempted',
  'provider-accepted',
  'delivered',
  'failed',
  'expired',
  'unknown',
] as const satisfies readonly AttemptDeliveryTruthState[]);

export type EventSummaryClassification = EventClassificationLabel;

export interface EventSummaryEventSnapshot {
  readonly id: string;
  readonly kind: 'incident' | 'drill' | 'test';
  readonly templateMode: 'real' | 'drill';
  readonly status: 'draft' | 'active' | 'all-clear' | 'closed';
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly allClearAt: string | null;
  readonly reactivatedAt: string | null;
  readonly closedAt: string | null;
  readonly correctionOfEventId: string | null;
  readonly correctionReason: string | null;
}

export interface EventSummaryPhotoSnapshot {
  readonly journalEntryId: string;
  readonly mediaId: string;
  readonly sanitizedContentSha256: string;
  readonly sanitizedByteLength: number;
  readonly detectedContentType: MediaContentType;
}

export interface EventSummaryDeliveryStateCount {
  readonly state: AttemptDeliveryTruthState;
  readonly count: number;
}

export interface EventSummaryDeliveryChannelSnapshot {
  readonly channel: NotificationChannel;
  readonly plannedEndpointCount: number;
  readonly noAttemptRecordCount: number;
  readonly noEvidenceCount: number;
  /** Exactly one row for each state in EVENT_SUMMARY_ATTEMPT_STATES. */
  readonly stateCounts: readonly EventSummaryDeliveryStateCount[];
}

export interface EventSummaryDeliveryIntentSnapshot {
  readonly purpose: NotificationPurpose;
  readonly createdAt: string;
  readonly explicitIntentState: 'accepted' | 'recorded' | null;
  readonly channels: readonly EventSummaryDeliveryChannelSnapshot[];
}

/**
 * Server-internal, destination-free snapshot consumed by the pure PDF
 * renderer. Database reads and facility authorization happen before this
 * shape is assembled; the renderer performs no network, database, clock, or
 * random operations.
 */
export interface EventSummarySnapshot {
  readonly generatedAt: string;
  readonly event: EventSummaryEventSnapshot;
  readonly facility: Readonly<{ code: string; name: string }>;
  readonly eventType: Readonly<{ id: string; name: string }>;
  readonly recordedParticipantCount: number;
  readonly journal: readonly JournalEntryReadProjection[];
  readonly photos: readonly EventSummaryPhotoSnapshot[];
  readonly delivery: readonly EventSummaryDeliveryIntentSnapshot[];
}

export type EventSummaryPdfErrorCode =
  | 'INVALID_SNAPSHOT'
  | 'INPUT_LIMIT_EXCEEDED'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'BYTE_LIMIT_EXCEEDED'
  | 'RENDER_FAILED';

/** Public-safe PDF failure without journal content or storage identifiers. */
export class EventSummaryPdfError extends Error {
  public constructor(
    public readonly code: EventSummaryPdfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventSummaryPdfError';
  }
}

const FONT_NAME = 'NotoSans';
const FONT_SHA256 =
  'b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5';

/** Resolves a Next-emitted asset from any nested server route chunk. */
export function resolveBundledFontFilePath(
  serverChunkDirectory: string,
  bundledAssetPath: string,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const bundledAssetPrefix = '/_next/static/media/';
  if (
    !bundledAssetPath.startsWith(bundledAssetPrefix) ||
    bundledAssetPath.includes('..')
  ) {
    throw new Error('The embedded Noto Sans PDF font path is invalid.');
  }
  const relativeAssetPath = bundledAssetPath.slice('/_next/'.length);
  let candidateDirectory = serverChunkDirectory;
  while (true) {
    const candidate = join(candidateDirectory, relativeAssetPath);
    if (fileExists(candidate)) return candidate;
    if (
      basename(candidateDirectory) === 'server' ||
      dirname(candidateDirectory) === candidateDirectory
    ) {
      break;
    }
    candidateDirectory = dirname(candidateDirectory);
  }
  throw new Error('The emitted Noto Sans PDF font is unavailable.');
}

/**
 * Finds the font Next actually emitted, when it is not where it said it was.
 *
 * Next traces `./assets/NotoSans-Regular.ttf` as a relative dependency of every
 * route chunk that reaches this module, but it emits the bytes once, into the
 * server output's content-hashed media directory. Nothing is written beside the
 * route chunk, so reading the traced path raises `ENOENT` at module load and
 * every PDF export fails -- which is exactly what production was doing.
 *
 * The search is bounded to the media directories of each ancestor up to the
 * server root, and the caller verifies the bytes against `FONT_SHA256`, so a
 * wrong file cannot be accepted quietly.
 */
export function findEmittedFontFilePath(
  startDirectory: string,
  directoryEntries: (path: string) => readonly string[] = (path) =>
    existsSync(path) ? readdirSync(path) : [],
): string | null {
  let candidateDirectory = startDirectory;
  for (;;) {
    for (const mediaDirectory of [
      join(candidateDirectory, 'static', 'media'),
      join(candidateDirectory, 'chunks', 'static', 'media'),
    ]) {
      const match = directoryEntries(mediaDirectory)
        .filter(
          (entry) =>
            entry.startsWith(`${FONT_NAME}-Regular`) && entry.endsWith('.ttf'),
        )
        .sort()
        .at(0);
      if (match !== undefined) return join(mediaDirectory, match);
    }
    if (
      basename(candidateDirectory) === 'server' ||
      dirname(candidateDirectory) === candidateDirectory
    ) {
      return null;
    }
    candidateDirectory = dirname(candidateDirectory);
  }
}

function readFontBytes(): Uint8Array {
  const fontAssetUrl = new URL(
    './assets/NotoSans-Regular.ttf',
    import.meta.url,
  );
  if (fontAssetUrl.protocol === 'file:') {
    const tracedPath = fileURLToPath(fontAssetUrl);
    if (existsSync(tracedPath)) return readFileSync(tracedPath);
    const emittedPath = findEmittedFontFilePath(dirname(tracedPath));
    if (emittedPath !== null) return readFileSync(emittedPath);
    throw new Error('The emitted Noto Sans PDF font is unavailable.');
  }

  // Next's server compiler emits a URL-compatible asset object whose path is
  // rooted at /_next/. Convert that narrowly validated path to the colocated
  // server chunk asset; Node's fs API intentionally rejects the foreign URL.
  if (
    fontAssetUrl.protocol !== '' ||
    !fontAssetUrl.pathname.startsWith('/_next/static/media/')
  ) {
    throw new Error('The embedded Noto Sans PDF font path is invalid.');
  }
  return readFileSync(
    resolveBundledFontFilePath(__dirname, fontAssetUrl.pathname),
  );
}

const FONT_BYTES = readFontBytes();

interface FontGlyphCoverage {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

const require = createRequire(import.meta.url);
const fontkit = require('fontkit') as Readonly<{
  create(bytes: Uint8Array): FontGlyphCoverage;
}>;
const FONT_GLYPH_COVERAGE = fontkit.create(FONT_BYTES);

if (createHash('sha256').update(FONT_BYTES).digest('hex') !== FONT_SHA256) {
  throw new Error(
    'The embedded Noto Sans PDF font failed its integrity check.',
  );
}

const PAGE_SIZE = 'LETTER';
const PAGE_MARGIN_LEFT = 54;
const PAGE_MARGIN_RIGHT = 54;
const PAGE_MARGIN_TOP = 80;
const PAGE_MARGIN_BOTTOM = 54;
const HEADER_HEIGHT = 54;
const CONTENT_TOP = 80;
const BODY_FONT_SIZE = 9.5;
const SMALL_FONT_SIZE = 8;
const MAX_SAFE_COUNT = 100_000;
const MAX_OBJECT_KEYS = 100;
const MAX_MEASURE_DEPTH = 24;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const COLORS = Object.freeze({
  ink: '#172033',
  muted: '#526176',
  rule: '#CDD5DF',
  pale: '#F5F7FA',
  red: '#8F1D18',
  blue: '#175CD3',
  amber: '#765A00',
  supersession: '#9A3412',
  redaction: '#991B1B',
  white: '#FFFFFF',
});

interface PreparedSnapshot extends EventSummarySnapshot {
  readonly journal: readonly JournalEntryReadProjection[];
  readonly classification: EventSummaryClassification;
  readonly photosByJournalEntryId: ReadonlyMap<
    string,
    EventSummaryPhotoSnapshot
  >;
}

function invalid(message: string): EventSummaryPdfError {
  return new EventSummaryPdfError('INVALID_SNAPSHOT', message);
}

function inputLimit(message: string): EventSummaryPdfError {
  return new EventSummaryPdfError('INPUT_LIMIT_EXCEEDED', message);
}

function assertString(
  value: string,
  field: string,
  maximumBytes: number,
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw invalid(`${field} is missing or exceeds its safe length.`);
  }
}

function assertTimestamp(value: string | null, field: string): void {
  if (
    value !== null &&
    (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
  ) {
    throw invalid(`${field} is not a valid retained timestamp.`);
  }
}

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_COUNT) {
    throw invalid(`${field} is outside the safe count range.`);
  }
}

function measureSnapshotValue(
  value: unknown,
  state: { bytes: number; readonly seen: WeakSet<object> },
  depth = 0,
): void {
  if (depth > MAX_MEASURE_DEPTH) {
    throw inputLimit('The event summary snapshot is nested too deeply.');
  }
  if (typeof value === 'string') {
    state.bytes += Buffer.byteLength(value, 'utf8');
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    state.bytes += 16;
  } else if (value !== null && typeof value === 'object') {
    if (state.seen.has(value)) {
      throw invalid('The event summary snapshot cannot contain cycles.');
    }
    state.seen.add(value);
    const children = Array.isArray(value)
      ? value
      : Object.entries(value).flatMap(([key, child]) => [key, child]);
    if (!Array.isArray(value) && Object.keys(value).length > MAX_OBJECT_KEYS) {
      throw inputLimit('The event summary snapshot contains too many fields.');
    }
    for (const child of children) {
      measureSnapshotValue(child, state, depth + 1);
      if (state.bytes > EVENT_SUMMARY_PDF_MAX_SNAPSHOT_BYTES) {
        throw inputLimit('The event summary snapshot exceeds the byte limit.');
      }
    }
    state.seen.delete(value);
  }
  if (state.bytes > EVENT_SUMMARY_PDF_MAX_SNAPSHOT_BYTES) {
    throw inputLimit('The event summary snapshot exceeds the byte limit.');
  }
}

function classificationFor(
  event: EventSummaryEventSnapshot,
): EventSummaryClassification {
  try {
    return getEventClassificationPresentation({
      kind: event.kind,
      templateMode: event.templateMode,
    }).label as EventSummaryClassification;
  } catch {
    throw invalid(
      'The event real-versus-drill classification is inconsistent.',
    );
  }
}

function prepareSnapshot(snapshot: EventSummarySnapshot): PreparedSnapshot {
  if (snapshot.journal.length > EVENT_SUMMARY_PDF_MAX_JOURNAL_ENTRIES) {
    throw inputLimit('The event journal exceeds the entry limit.');
  }
  if (snapshot.photos.length > EVENT_SUMMARY_PDF_MAX_PHOTOS) {
    throw inputLimit('The event photo projection exceeds the entry limit.');
  }
  if (snapshot.delivery.length > EVENT_SUMMARY_PDF_MAX_DELIVERY_INTENTS) {
    throw inputLimit('The delivery projection exceeds the intent limit.');
  }
  measureSnapshotValue(snapshot, { bytes: 0, seen: new WeakSet<object>() });

  assertString(snapshot.event.id, 'event.id', 200);
  assertString(snapshot.facility.code, 'facility.code', 100);
  assertString(snapshot.facility.name, 'facility.name', 500);
  assertString(snapshot.eventType.id, 'eventType.id', 200);
  assertString(snapshot.eventType.name, 'eventType.name', 500);
  assertTimestamp(snapshot.generatedAt, 'generatedAt');
  assertTimestamp(snapshot.event.createdAt, 'event.createdAt');
  assertTimestamp(snapshot.event.activatedAt, 'event.activatedAt');
  assertTimestamp(snapshot.event.allClearAt, 'event.allClearAt');
  assertTimestamp(snapshot.event.reactivatedAt, 'event.reactivatedAt');
  assertTimestamp(snapshot.event.closedAt, 'event.closedAt');
  if (
    (snapshot.event.correctionOfEventId === null) !==
      (snapshot.event.correctionReason === null) ||
    snapshot.event.correctionOfEventId === snapshot.event.id
  ) {
    throw invalid('The event correction provenance is inconsistent.');
  }
  if (
    snapshot.event.correctionOfEventId !== null &&
    snapshot.event.correctionReason !== null
  ) {
    assertString(
      snapshot.event.correctionOfEventId,
      'event.correctionOfEventId',
      200,
    );
    assertString(
      snapshot.event.correctionReason,
      'event.correctionReason',
      4_000,
    );
  }
  assertCount(snapshot.recordedParticipantCount, 'recordedParticipantCount');

  const journal = snapshot.journal.map((projection) => {
    const parsed = JournalEntryReadProjectionSchema.safeParse(projection);
    if (!parsed.success) {
      throw invalid('The journal contains an invalid outward projection.');
    }
    return parsed.data;
  });
  const journalById = new Map<string, JournalEntryReadProjection>();
  for (const [index, projection] of journal.entries()) {
    const expectedSequence = index + 1;
    if (
      projection.entry.eventId !== snapshot.event.id ||
      projection.entry.sequence !== expectedSequence ||
      journalById.has(projection.entry.id)
    ) {
      throw invalid(
        'The full journal must be event-bound, contiguous, and unique.',
      );
    }
    const supersedes = projection.entry.supersedes;
    if (supersedes !== null) {
      const target = journalById.get(supersedes.entryId);
      if (
        target === undefined ||
        target.entry.sequence !== supersedes.entrySequence
      ) {
        throw invalid('Journal supersession provenance is incomplete.');
      }
    }
    journalById.set(projection.entry.id, projection);
  }

  const photosByJournalEntryId = new Map<string, EventSummaryPhotoSnapshot>();
  for (const photo of snapshot.photos) {
    assertString(photo.journalEntryId, 'photo.journalEntryId', 200);
    assertString(photo.mediaId, 'photo.mediaId', 200);
    if (!SHA256_PATTERN.test(photo.sanitizedContentSha256)) {
      throw invalid('A photo checksum is not a lowercase SHA-256 digest.');
    }
    if (
      !Number.isSafeInteger(photo.sanitizedByteLength) ||
      photo.sanitizedByteLength < 1 ||
      photo.sanitizedByteLength > EVENT_SUMMARY_PDF_MAX_BYTES ||
      photosByJournalEntryId.has(photo.journalEntryId)
    ) {
      throw invalid('Photo checksum metadata is invalid or duplicated.');
    }
    const projection = journalById.get(photo.journalEntryId);
    if (
      projection === undefined ||
      projection.visibility !== 'visible' ||
      projection.entry.kind !== 'photo' ||
      projection.entry.payload.mediaId !== photo.mediaId
    ) {
      throw invalid(
        'Photo checksum metadata must reference one visible photo entry.',
      );
    }
    photosByJournalEntryId.set(photo.journalEntryId, photo);
  }
  for (const projection of journal) {
    if (
      projection.visibility === 'visible' &&
      projection.entry.kind === 'photo' &&
      !photosByJournalEntryId.has(projection.entry.id)
    ) {
      throw invalid(
        'A visible photo entry is missing sanitized checksum data.',
      );
    }
  }

  for (const intent of snapshot.delivery) {
    assertTimestamp(intent.createdAt, 'delivery.createdAt');
    if (intent.channels.length > 3) {
      throw inputLimit('A delivery intent contains too many channels.');
    }
    const channelNames = new Set<NotificationChannel>();
    for (const channel of intent.channels) {
      if (channelNames.has(channel.channel)) {
        throw invalid('A delivery intent contains a duplicate channel.');
      }
      channelNames.add(channel.channel);
      assertCount(channel.plannedEndpointCount, 'plannedEndpointCount');
      assertCount(channel.noAttemptRecordCount, 'noAttemptRecordCount');
      assertCount(channel.noEvidenceCount, 'noEvidenceCount');
      const stateCounts = new Map<AttemptDeliveryTruthState, number>();
      for (const row of channel.stateCounts) {
        if (
          !EVENT_SUMMARY_ATTEMPT_STATES.includes(row.state) ||
          stateCounts.has(row.state)
        ) {
          throw invalid('Delivery state rows must use each exact state once.');
        }
        assertCount(row.count, 'delivery.stateCount');
        stateCounts.set(row.state, row.count);
      }
      if (
        EVENT_SUMMARY_ATTEMPT_STATES.some((state) => !stateCounts.has(state))
      ) {
        throw invalid('Delivery state rows must include all six truth states.');
      }
      const accounted =
        channel.noAttemptRecordCount +
        channel.noEvidenceCount +
        [...stateCounts.values()].reduce((total, count) => total + count, 0);
      if (accounted !== channel.plannedEndpointCount) {
        throw invalid(
          'Delivery state and evidence gaps must equal the planned endpoint count.',
        );
      }
    }
  }

  return Object.freeze({
    ...snapshot,
    journal: Object.freeze(journal),
    classification: classificationFor(snapshot.event),
    photosByJournalEntryId,
  });
}

function safePdfText(value: string): string {
  let output = '';
  const characters = Array.from(value);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? '';
    const codePoint = character.codePointAt(0) ?? 0xfffd;
    if (codePoint === 13) {
      if (characters[index + 1] === '\n') index += 1;
      output += '\n';
    } else if (codePoint === 9) {
      output += '    ';
    } else if (
      (codePoint < 32 && codePoint !== 10) ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      output += unicodeMarker(codePoint);
    } else if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      output += '\uFFFD';
    } else if (!FONT_GLYPH_COVERAGE.hasGlyphForCodePoint(codePoint)) {
      output += unicodeMarker(codePoint);
    } else {
      output += character;
    }
  }
  return output;
}

function unicodeMarker(codePoint: number): string {
  return `[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}]`;
}

function classificationColor(
  classification: EventSummaryClassification,
): string {
  switch (classification) {
    case EVENT_CLASSIFICATION_PRESENTATIONS.incident.label:
      return EVENT_CLASSIFICATION_PRESENTATIONS.incident.colors
        .bannerBackground;
    case EVENT_CLASSIFICATION_PRESENTATIONS.drill.label:
      return EVENT_CLASSIFICATION_PRESENTATIONS.drill.colors.bannerBackground;
    case EVENT_CLASSIFICATION_PRESENTATIONS.test.label:
      return EVENT_CLASSIFICATION_PRESENTATIONS.test.colors.bannerBackground;
  }
}

function contentWidth(document: PDFKit.PDFDocument): number {
  return document.page.width - PAGE_MARGIN_LEFT - PAGE_MARGIN_RIGHT;
}

function drawPageHeader(
  document: PDFKit.PDFDocument,
  snapshot: PreparedSnapshot,
): void {
  document
    .save()
    .rect(0, 0, document.page.width, HEADER_HEIGHT)
    .fill(classificationColor(snapshot.classification));
  document
    .font(FONT_NAME)
    .fontSize(13)
    .fillColor(COLORS.white)
    .text(snapshot.classification, PAGE_MARGIN_LEFT, 17, {
      align: 'left',
      lineBreak: false,
      width: contentWidth(document),
    });
  document
    .fontSize(7.5)
    .text('PSD EOC EVENT SUMMARY', PAGE_MARGIN_LEFT, 35, {
      align: 'left',
      lineBreak: false,
      width: contentWidth(document),
    })
    .restore();
  document.x = PAGE_MARGIN_LEFT;
  document.y = CONTENT_TOP;
}

function drawPageFooters(
  document: PDFKit.PDFDocument,
  snapshot: PreparedSnapshot,
): void {
  const range = document.bufferedPageRange();
  for (let offset = 0; offset < range.count; offset += 1) {
    document.switchToPage(range.start + offset);
    const footerY = document.page.height - 35;
    const bottomMargin = document.page.margins.bottom;
    // PDFKit otherwise treats text placed in the physical footer as body text
    // below maxY() and silently creates extra pages. Content is complete at
    // this point, so temporarily open only the footer's bottom margin.
    document.page.margins.bottom = 0;
    try {
      document
        .save()
        .strokeColor(COLORS.rule)
        .lineWidth(0.5)
        .moveTo(PAGE_MARGIN_LEFT, footerY - 7)
        .lineTo(document.page.width - PAGE_MARGIN_RIGHT, footerY - 7)
        .stroke()
        .font(FONT_NAME)
        .fontSize(7)
        .fillColor(COLORS.muted)
        .text(`Generated ${snapshot.generatedAt}`, PAGE_MARGIN_LEFT, footerY, {
          lineBreak: false,
          width: contentWidth(document) / 2,
        })
        .text(
          `Page ${offset + 1} of ${range.count}`,
          PAGE_MARGIN_LEFT + contentWidth(document) / 2,
          footerY,
          {
            align: 'right',
            lineBreak: false,
            width: contentWidth(document) / 2,
          },
        )
        .restore();
    } finally {
      document.page.margins.bottom = bottomMargin;
    }
  }
}

function ensureSpace(document: PDFKit.PDFDocument, points: number): void {
  if (document.y + points > document.page.maxY()) document.addPage();
}

function writeSectionHeading(
  document: PDFKit.PDFDocument,
  heading: string,
): void {
  ensureSpace(document, 34);
  document
    .font(FONT_NAME)
    .fontSize(14)
    .fillColor(COLORS.ink)
    .text(heading, { width: contentWidth(document) });
  document
    .moveDown(0.25)
    .strokeColor(COLORS.rule)
    .lineWidth(0.75)
    .moveTo(PAGE_MARGIN_LEFT, document.y)
    .lineTo(document.page.width - PAGE_MARGIN_RIGHT, document.y)
    .stroke()
    .moveDown(0.55);
}

function writeBody(
  document: PDFKit.PDFDocument,
  value: string,
  options: Readonly<{
    color?: string;
    indent?: number;
    size?: number;
    gap?: number;
  }> = {},
): void {
  const indent = options.indent ?? 0;
  document
    .font(FONT_NAME)
    .fontSize(options.size ?? BODY_FONT_SIZE)
    .fillColor(options.color ?? COLORS.ink)
    .text(safePdfText(value), PAGE_MARGIN_LEFT + indent, document.y, {
      lineGap: 2,
      width: contentWidth(document) - indent,
    });
  document.moveDown(options.gap ?? 0.45);
}

function writeLabelValue(
  document: PDFKit.PDFDocument,
  label: string,
  value: string,
): void {
  writeBody(document, `${label}: ${value}`, { gap: 0.25 });
}

function nullableTimestamp(value: string | null): string {
  return value ?? 'not recorded';
}

function authorProvenance(projection: JournalEntryReadProjection): string {
  const author = projection.entry.author;
  switch (author.kind) {
    case 'human':
      return `human user ${author.userId}, session ${author.sessionId}`;
    case 'agent':
      return `agent ${author.agentId}, API key ${author.apiKeyId}`;
    case 'system':
      return `system service ${author.serviceId}`;
  }
}

function writeOverview(
  document: PDFKit.PDFDocument,
  snapshot: PreparedSnapshot,
): void {
  document
    .font(FONT_NAME)
    .fontSize(22)
    .fillColor(COLORS.ink)
    .text('Operational event record', { width: contentWidth(document) })
    .moveDown(0.35);
  writeBody(
    document,
    'This export is a retained event summary. It does not rewrite or replace the append-only journal.',
    { color: COLORS.muted },
  );

  writeSectionHeading(document, 'Event details');
  writeLabelValue(
    document,
    'Facility',
    `${snapshot.facility.name} (${snapshot.facility.code})`,
  );
  writeLabelValue(document, 'Event type', snapshot.eventType.name);
  writeLabelValue(document, 'Event type version ID', snapshot.eventType.id);
  writeLabelValue(document, 'Event ID', snapshot.event.id);
  writeLabelValue(document, 'Classification', snapshot.classification);
  writeLabelValue(document, 'Status', snapshot.event.status);
  writeLabelValue(document, 'Created', snapshot.event.createdAt);
  writeLabelValue(
    document,
    'Activated',
    nullableTimestamp(snapshot.event.activatedAt),
  );
  writeLabelValue(
    document,
    'All-clear',
    nullableTimestamp(snapshot.event.allClearAt),
  );
  writeLabelValue(
    document,
    'Reactivated',
    nullableTimestamp(snapshot.event.reactivatedAt),
  );
  writeLabelValue(
    document,
    'Closed',
    nullableTimestamp(snapshot.event.closedAt),
  );
  if (
    snapshot.event.correctionOfEventId !== null &&
    snapshot.event.correctionReason !== null
  ) {
    writeLabelValue(
      document,
      'Correction of event ID',
      snapshot.event.correctionOfEventId,
    );
    writeLabelValue(
      document,
      'Correction reason',
      snapshot.event.correctionReason,
    );
  }
  writeLabelValue(
    document,
    'Recorded participant joins',
    String(snapshot.recordedParticipantCount),
  );
}

function writeSupersession(
  document: PDFKit.PDFDocument,
  projection: JournalEntryReadProjection,
): void {
  const supersedes = projection.entry.supersedes;
  if (supersedes === null) return;
  ensureSpace(document, 44);
  document
    .save()
    .rect(PAGE_MARGIN_LEFT, document.y, contentWidth(document), 2)
    .fill(COLORS.supersession)
    .restore();
  document.y += 7;
  writeBody(
    document,
    `${supersedes.kind.toUpperCase()} - supersedes journal entry #${supersedes.entrySequence} (${supersedes.entryId}).`,
    { color: COLORS.supersession, gap: 0.2 },
  );
  writeBody(document, `Reason: ${supersedes.reason}`, {
    color: COLORS.supersession,
    gap: 0.35,
  });
}

function writeVisibleJournalPayload(
  document: PDFKit.PDFDocument,
  projection: Extract<
    JournalEntryReadProjection,
    { readonly visibility: 'visible' }
  >,
  snapshot: PreparedSnapshot,
): void {
  const entry = projection.entry;
  switch (entry.kind) {
    case 'text':
      writeBody(document, entry.payload.text);
      return;
    case 'photo': {
      const photo = snapshot.photosByJournalEntryId.get(entry.id);
      if (photo === undefined) {
        throw invalid('A visible photo entry is missing checksum metadata.');
      }
      writeBody(document, 'Sanitized photo reference', {
        color: COLORS.muted,
        gap: 0.2,
      });
      writeLabelValue(document, 'Media ID', entry.payload.mediaId);
      writeLabelValue(document, 'Alternative text', entry.payload.altText);
      writeLabelValue(
        document,
        'Caption',
        entry.payload.caption ?? 'not recorded',
      );
      writeLabelValue(document, 'SHA-256', photo.sanitizedContentSha256);
      writeLabelValue(
        document,
        'Sanitized byte length',
        String(photo.sanitizedByteLength),
      );
      writeLabelValue(
        document,
        'Detected content type',
        photo.detectedContentType,
      );
      return;
    }
    case 'location':
      if (entry.payload.state === 'known') {
        writeBody(
          document,
          `Known location: ${entry.payload.latitude}, ${entry.payload.longitude}; accuracy ${entry.payload.accuracyMeters} meters; label ${entry.payload.label ?? 'not recorded'}.`,
        );
        return;
      }
      if (entry.payload.state === 'ambiguous') {
        writeBody(
          document,
          `Ambiguous location: ${entry.payload.label}. Reason: ${entry.payload.reason}`,
        );
        return;
      }
      writeBody(document, `Unknown location. Reason: ${entry.payload.reason}`);
      return;
    case 'system':
      writeBody(document, `${entry.payload.code}: ${entry.payload.summary}`);
      if ('transition' in entry.payload) {
        const transition = entry.payload.transition;
        writeBody(
          document,
          `Lifecycle transition: ${transition.transition}; ${transition.from} -> ${transition.to}; occurred ${transition.occurredAt}.`,
          { color: COLORS.muted },
        );
        writeBody(
          document,
          `Complete transition evidence: ${JSON.stringify(transition)}`,
          { color: COLORS.muted, size: SMALL_FONT_SIZE },
        );
      } else {
        writeLabelValue(
          document,
          'Related record ID',
          entry.payload.relatedRecordId ?? 'not recorded',
        );
      }
  }
}

function writeJournal(
  document: PDFKit.PDFDocument,
  snapshot: PreparedSnapshot,
): void {
  writeSectionHeading(document, 'Append-only journal');
  writeBody(
    document,
    'Entries are shown once in authoritative sequence order. Corrections and redactions remain separate superseding entries with provenance.',
    { color: COLORS.muted },
  );
  if (snapshot.journal.length === 0) {
    writeBody(document, 'No journal entries were recorded.');
    return;
  }
  for (const projection of snapshot.journal) {
    ensureSpace(document, 82);
    document
      .font(FONT_NAME)
      .fontSize(11)
      .fillColor(COLORS.ink)
      .text(
        `Journal entry #${projection.entry.sequence} - ${projection.entry.kind.toUpperCase()}`,
        { width: contentWidth(document) },
      )
      .moveDown(0.25);
    writeBody(
      document,
      `Server time: ${projection.entry.serverTime} | Source: ${projection.entry.source} | Author: ${authorProvenance(projection)}`,
      { color: COLORS.muted, size: SMALL_FONT_SIZE, gap: 0.15 },
    );
    writeBody(document, `Journal entry ID: ${projection.entry.id}`, {
      color: COLORS.muted,
      size: SMALL_FONT_SIZE,
      gap: 0.15,
    });
    if (projection.entry.clientTime !== null) {
      writeBody(document, `Client time: ${projection.entry.clientTime}`, {
        color: COLORS.muted,
        size: SMALL_FONT_SIZE,
        gap: 0.2,
      });
    }
    writeSupersession(document, projection);
    if (projection.visibility === 'redacted') {
      ensureSpace(document, 28);
      writeBody(document, '[REDACTED - ORIGINAL CONTENT WITHHELD]', {
        color: COLORS.redaction,
      });
    } else {
      writeVisibleJournalPayload(document, projection, snapshot);
    }
    document
      .strokeColor(COLORS.rule)
      .lineWidth(0.4)
      .moveTo(PAGE_MARGIN_LEFT, document.y)
      .lineTo(document.page.width - PAGE_MARGIN_RIGHT, document.y)
      .stroke();
    document.y += 10;
  }
}

function stateCount(
  channel: EventSummaryDeliveryChannelSnapshot,
  state: AttemptDeliveryTruthState,
): number {
  return channel.stateCounts.find((row) => row.state === state)?.count ?? 0;
}

function writeDelivery(
  document: PDFKit.PDFDocument,
  snapshot: PreparedSnapshot,
): void {
  writeSectionHeading(document, 'Delivery evidence - separate from journal');
  writeBody(
    document,
    'Provider acceptance is not delivery or human receipt. Counts below reproduce the exact retained truth-state vocabulary; evidence gaps are shown separately and never promoted to success.',
    { color: COLORS.muted },
  );
  if (snapshot.delivery.length === 0) {
    writeBody(
      document,
      'No notification intent or endpoint delivery evidence was recorded for this event.',
    );
    return;
  }
  snapshot.delivery.forEach((intent, intentIndex) => {
    ensureSpace(document, 72);
    document
      .font(FONT_NAME)
      .fontSize(11)
      .fillColor(COLORS.ink)
      .text(`Notification intent ${intentIndex + 1} - ${intent.purpose}`, {
        width: contentWidth(document),
      })
      .moveDown(0.25);
    writeBody(document, `Created: ${intent.createdAt}`, {
      color: COLORS.muted,
      size: SMALL_FONT_SIZE,
      gap: 0.15,
    });
    writeBody(
      document,
      `Explicit intent state: ${intent.explicitIntentState ?? 'none recorded'}`,
      { color: COLORS.muted, size: SMALL_FONT_SIZE },
    );
    if (intent.channels.length === 0) {
      writeBody(document, 'No notification channels were planned.', {
        indent: 12,
      });
    }
    for (const channel of intent.channels) {
      ensureSpace(document, 126);
      writeBody(
        document,
        `${channel.channel.toUpperCase()} - planned endpoint count: ${channel.plannedEndpointCount}`,
        { indent: 12, gap: 0.2 },
      );
      for (const state of EVENT_SUMMARY_ATTEMPT_STATES) {
        writeBody(document, `${state}: ${stateCount(channel, state)}`, {
          indent: 28,
          size: SMALL_FONT_SIZE,
          gap: 0.05,
        });
      }
      writeBody(
        document,
        `no-attempt-record gap: ${channel.noAttemptRecordCount}`,
        { indent: 28, size: SMALL_FONT_SIZE, gap: 0.05 },
      );
      writeBody(
        document,
        `attempt-with-no-evidence gap: ${channel.noEvidenceCount}`,
        { indent: 28, size: SMALL_FONT_SIZE, gap: 0.35 },
      );
    }
  });
}

function renderDocument(
  document: PDFKit.PDFDocument,
  snapshot: PreparedSnapshot,
): number {
  let pageCount = 0;
  document.on('pageAdded', () => {
    pageCount += 1;
    if (pageCount > EVENT_SUMMARY_PDF_MAX_PAGES) {
      throw new EventSummaryPdfError(
        'PAGE_LIMIT_EXCEEDED',
        'The event summary exceeds the PDF page limit.',
      );
    }
    drawPageHeader(document, snapshot);
  });
  document.addPage();
  writeOverview(document, snapshot);
  writeJournal(document, snapshot);
  writeDelivery(document, snapshot);
  drawPageFooters(document, snapshot);
  return pageCount;
}

function collectPdf(
  document: PDFKit.PDFDocument,
  pageCount: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let exceeded = false;
    document.on('data', (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > EVENT_SUMMARY_PDF_MAX_BYTES) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    document.once('error', () => {
      reject(
        new EventSummaryPdfError(
          'RENDER_FAILED',
          'The event summary PDF could not be rendered.',
        ),
      );
    });
    document.once('end', () => {
      if (exceeded) {
        reject(
          new EventSummaryPdfError(
            'BYTE_LIMIT_EXCEEDED',
            'The event summary exceeds the PDF byte limit.',
          ),
        );
        return;
      }
      if (pageCount < 1 || pageCount > EVENT_SUMMARY_PDF_MAX_PAGES) {
        reject(
          new EventSummaryPdfError(
            'PAGE_LIMIT_EXCEEDED',
            'The event summary exceeds the PDF page limit.',
          ),
        );
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks, byteLength)));
    });
    document.end();
  });
}

/**
 * Deterministically renders one complete, already-authorized event snapshot.
 * Any input, page, or output limit fails the whole operation; content is never
 * silently truncated and no live provider or storage operation occurs here.
 */
export async function renderEventSummaryPdf(
  snapshot: EventSummarySnapshot,
  organizationName: string,
): Promise<Uint8Array> {
  const prepared = prepareSnapshot(snapshot);
  const parsedOrganizationName =
    OrganizationNameSchema.safeParse(organizationName);
  if (!parsedOrganizationName.success) {
    throw invalid(
      'organizationName is not printable or exceeds its safe length.',
    );
  }
  const generatedAt = new Date(prepared.generatedAt);
  const document = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    displayTitle: true,
    fontLayoutCache: false,
    info: {
      Author: parsedOrganizationName.data,
      CreationDate: generatedAt,
      Creator: 'PSD EOC',
      ModDate: generatedAt,
      Producer: 'PSD EOC',
      Subject: prepared.classification,
      Title: `PSD EOC Event Summary ${prepared.event.id}`,
    },
    lang: 'en-US',
    margins: {
      bottom: PAGE_MARGIN_BOTTOM,
      left: PAGE_MARGIN_LEFT,
      right: PAGE_MARGIN_RIGHT,
      top: PAGE_MARGIN_TOP,
    },
    pdfVersion: '1.7',
    size: PAGE_SIZE,
    tagged: true,
  });
  document.registerFont(FONT_NAME, FONT_BYTES);

  let pageCount: number;
  try {
    pageCount = renderDocument(document, prepared);
  } catch (error) {
    document.destroy();
    if (error instanceof EventSummaryPdfError) throw error;
    throw new EventSummaryPdfError(
      'RENDER_FAILED',
      'The event summary PDF could not be rendered.',
    );
  }
  return collectPdf(document, pageCount);
}
