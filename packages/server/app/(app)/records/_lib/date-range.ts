const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MAX_EXPORT_CALENDAR_DAYS = 366;

const PACIFIC_DATE_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const PACIFIC_OFFSET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TIME_ZONE,
  timeZoneName: 'longOffset',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export class RecordsDateRangeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecordsDateRangeError';
  }
}

interface DateOnlyParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function requiredPart(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new RecordsDateRangeError(
      'The Pacific time-zone date could not be resolved.',
    );
  }
  return value;
}

function parseDateOnly(value: string): DateOnlyParts {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (match === null) {
    throw new RecordsDateRangeError('Dates must use YYYY-MM-DD.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RecordsDateRangeError('Choose a valid calendar date.');
  }
  return { year, month, day };
}

function dateOnlyEpoch(value: string): number {
  const { year, month, day } = parseDateOnly(value);
  return Date.UTC(year, month - 1, day);
}

function formatUtcDateOnly(epochMilliseconds: number): string {
  const date = new Date(epochMilliseconds);
  return [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
  ].join('-');
}

function offsetMilliseconds(at: Date): number {
  const parts = PACIFIC_OFFSET_PARTS.formatToParts(at);
  const offset = requiredPart(parts, 'timeZoneName');
  if (offset === 'GMT') {
    return 0;
  }
  const match = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(offset);
  if (match === null) {
    throw new RecordsDateRangeError(
      'The Pacific time-zone offset could not be resolved.',
    );
  }
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60 * 1_000;
}

/** Resolves a local Pacific midnight without depending on the server locale. */
export function pacificStartOfDay(dateOnly: string): Date {
  const nominalUtcMidnight = dateOnlyEpoch(dateOnly);
  const firstCandidate = new Date(
    nominalUtcMidnight - offsetMilliseconds(new Date(nominalUtcMidnight)),
  );
  const candidate = new Date(
    nominalUtcMidnight - offsetMilliseconds(firstCandidate),
  );
  const local = PACIFIC_OFFSET_PARTS.formatToParts(candidate);
  const localDate = `${requiredPart(local, 'year')}-${requiredPart(
    local,
    'month',
  )}-${requiredPart(local, 'day')}`;
  if (
    localDate !== dateOnly ||
    requiredPart(local, 'hour') !== '00' ||
    requiredPart(local, 'minute') !== '00' ||
    requiredPart(local, 'second') !== '00'
  ) {
    throw new RecordsDateRangeError(
      'The Pacific time-zone date could not be resolved.',
    );
  }
  return candidate;
}

export function addCalendarDays(dateOnly: string, days: number): string {
  if (!Number.isSafeInteger(days)) {
    throw new RecordsDateRangeError('The date adjustment is invalid.');
  }
  return formatUtcDateOnly(dateOnlyEpoch(dateOnly) + days * 86_400_000);
}

export function currentPacificDate(now = new Date()): string {
  const parts = PACIFIC_DATE_PARTS.formatToParts(now);
  return `${requiredPart(parts, 'year')}-${requiredPart(
    parts,
    'month',
  )}-${requiredPart(parts, 'day')}`;
}

export interface PacificDateRange {
  readonly from: string;
  readonly through: string;
  readonly startedFrom: string;
  readonly startedThrough: string;
}

/** Converts an inclusive Pacific calendar range into absolute timestamps. */
export function parsePacificDateRange(
  from: string,
  through: string,
): PacificDateRange {
  const fromEpoch = dateOnlyEpoch(from);
  const throughEpoch = dateOnlyEpoch(through);
  const calendarDays = (throughEpoch - fromEpoch) / 86_400_000 + 1;
  if (calendarDays < 1) {
    throw new RecordsDateRangeError(
      'The through date cannot be before the from date.',
    );
  }
  if (calendarDays > MAX_EXPORT_CALENDAR_DAYS) {
    throw new RecordsDateRangeError(
      'Choose a date range of 366 days or fewer.',
    );
  }

  const startedFrom = pacificStartOfDay(from);
  const nextDay = pacificStartOfDay(addCalendarDays(through, 1));
  return Object.freeze({
    from,
    through,
    startedFrom: startedFrom.toISOString(),
    startedThrough: new Date(nextDay.getTime() - 1).toISOString(),
  });
}
