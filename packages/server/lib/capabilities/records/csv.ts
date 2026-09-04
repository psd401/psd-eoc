const CSV_HEADER = [
  'site',
  'date',
  'time',
  'threat',
  'type',
  'duration',
  'participants_count',
] as const;

const LOS_ANGELES_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const LOS_ANGELES_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

const FORMULA_PREFIX = /^[\s\uFEFF]*[=+\-@]/u;
const ABSOLUTE_TIMESTAMP_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/u;

/** Rendering-only input derived from an authorized drill-record projection. */
export interface DrillRecordCsvRow {
  readonly facilityName: string;
  readonly facilityCode: string;
  readonly eventType: string;
  /** Null for a drill that predates the threat catalog. */
  readonly threatName: string | null;
  readonly threatDetail: string | null;
  readonly responseDetail: string | null;
  readonly kind: 'drill' | 'test';
  readonly startedAt: string;
  /** Null while the event is active or when a completed duration is unknown. */
  readonly durationSeconds: number | null;
  readonly participantCount: number;
}

function requiredPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new Error(`Missing ${type} while formatting drill CSV timestamp.`);
  }
  return value;
}

function formatLosAngelesDate(startedAt: Date): string {
  const parts = LOS_ANGELES_DATE_FORMATTER.formatToParts(startedAt);
  return `${requiredPart(parts, 'year')}-${requiredPart(parts, 'month')}-${requiredPart(parts, 'day')}`;
}

function formatLosAngelesTime(startedAt: Date): string {
  const parts = LOS_ANGELES_TIME_FORMATTER.formatToParts(startedAt);
  return `${requiredPart(parts, 'hour')}:${requiredPart(parts, 'minute')}:${requiredPart(parts, 'second')} ${requiredPart(parts, 'timeZoneName')}`;
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?|\n/gu, '\r\n');
}

function neutralizeFormula(value: string): string {
  const normalized = normalizeLineBreaks(value);
  return FORMULA_PREFIX.test(normalized) ? `'${normalized}` : normalized;
}

function escapeCsvField(value: string): string {
  if (/[",\r\n]/u.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function assertNonempty(value: string, fieldName: string): void {
  if (value.length === 0) {
    throw new TypeError(`${fieldName} must not be empty.`);
  }
}

function assertNonnegativeInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a nonnegative safe integer.`);
  }
}

function durationCell(durationSeconds: number | null): string {
  if (durationSeconds === null) {
    return '';
  }
  assertNonnegativeInteger(durationSeconds, 'durationSeconds');
  const hours = Math.floor(durationSeconds / 3_600);
  const minutes = Math.floor((durationSeconds % 3_600) / 60);
  const seconds = durationSeconds % 60;
  return [hours, minutes, seconds]
    .map((part) => part.toString().padStart(2, '0'))
    .join(':');
}

function serializeRow(row: DrillRecordCsvRow): string {
  assertNonempty(row.facilityName, 'facilityName');
  assertNonempty(row.facilityCode, 'facilityCode');
  assertNonempty(row.eventType, 'eventType');
  assertNonnegativeInteger(row.participantCount, 'participantCount');
  if (row.kind !== 'drill' && row.kind !== 'test') {
    throw new TypeError('Drill CSV rows must be classified as drill or test.');
  }

  const startedAt = new Date(row.startedAt);
  if (
    !ABSOLUTE_TIMESTAMP_SUFFIX.test(row.startedAt) ||
    Number.isNaN(startedAt.getTime())
  ) {
    throw new TypeError('startedAt must be a valid absolute timestamp.');
  }

  const site = `${neutralizeFormula(row.facilityName)} [${neutralizeFormula(row.facilityCode)}]`;
  const eventType = `[${row.kind.toUpperCase()}] ${neutralizeFormula(row.eventType)}${
    row.responseDetail === null
      ? ''
      : ` — ${neutralizeFormula(row.responseDetail)}`
  }`;
  // A drill from before the threat catalog has no threat to report; the cell
  // stays empty rather than inventing one.
  const threat =
    row.threatName === null
      ? ''
      : `${neutralizeFormula(row.threatName)}${
          row.threatDetail === null
            ? ''
            : ` — ${neutralizeFormula(row.threatDetail)}`
        }`;
  return [
    site,
    formatLosAngelesDate(startedAt),
    formatLosAngelesTime(startedAt),
    threat,
    eventType,
    durationCell(row.durationSeconds),
    row.participantCount.toString(),
  ]
    .map(escapeCsvField)
    .join(',');
}

/**
 * Serializes authorized drill records as deterministic UTF-8 RFC 4180 bytes.
 * Every row carries an unmistakable non-real kind label, and untrusted text is
 * formula-neutralized before CSV escaping.
 */
export function serializeDrillRecordsCsv(
  rows: readonly DrillRecordCsvRow[],
): Uint8Array {
  const lines = [CSV_HEADER.join(','), ...rows.map(serializeRow)];
  return new TextEncoder().encode(`${lines.join('\r\n')}\r\n`);
}
