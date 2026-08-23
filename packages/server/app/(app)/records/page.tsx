import {
  EventTypeIdSchema,
  FacilityIdSchema,
  ListEventRecordsInputSchema,
  PaginationCursorSchema,
} from '@psd-eoc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import {
  RecordsDateRangeError,
  addCalendarDays,
  currentPacificDate,
  parsePacificDateRange,
} from './_lib/date-range';
import { loadEventRecordPage, loadRecordsFilterOptions } from './_lib/data';
import { requireRecordsPageSession } from './_lib/session';
import { RecordsView, type RecordsFilters } from './records-view';
import '../start/styles.css';
import './styles.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = {
  title: { absolute: 'Records' },
  description: 'Authorized retained incident, drill, and test history.',
};

type RawSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

class RecordsFilterError extends Error {
  public constructor(message = 'Check the selected records filters.') {
    super(message);
    this.name = 'RecordsFilterError';
  }
}

function optionalSingle(
  parameters: RawSearchParams,
  name: string,
  allowEmpty = false,
): string | null {
  const value = parameters[name];
  if (Array.isArray(value)) {
    throw new RecordsFilterError();
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || (value.length === 0 && !allowEmpty)) {
    throw new RecordsFilterError();
  }
  return value.length === 0 ? null : value;
}

function recordsReturnTo(parameters: RawSearchParams): string {
  const query = new URLSearchParams();
  for (const [name, rawValue] of Object.entries(parameters)) {
    if (typeof rawValue === 'string') {
      query.append(name, rawValue);
    } else if (Array.isArray(rawValue)) {
      rawValue.forEach((value) => query.append(name, value));
    }
  }
  const serialized = query.toString();
  return serialized.length === 0 ? '/records' : `/records?${serialized}`;
}

function parseFilters(
  parameters: RawSearchParams,
  defaultFacilityId: string,
  today: string,
): Readonly<{
  filters: RecordsFilters;
  range: ReturnType<typeof parsePacificDateRange>;
}> {
  const allowed = new Set([
    'facilityId',
    'from',
    'through',
    'eventTypeId',
    'cursor',
  ]);
  if (Object.keys(parameters).some((name) => !allowed.has(name))) {
    throw new RecordsFilterError();
  }

  const facilityId = FacilityIdSchema.parse(
    optionalSingle(parameters, 'facilityId') ?? defaultFacilityId,
  );
  const from =
    optionalSingle(parameters, 'from') ?? addCalendarDays(today, -30);
  const through = optionalSingle(parameters, 'through') ?? today;
  const eventTypeValue = optionalSingle(parameters, 'eventTypeId', true);
  const eventTypeId =
    eventTypeValue === null ? null : EventTypeIdSchema.parse(eventTypeValue);
  const cursorValue = optionalSingle(parameters, 'cursor');
  const cursor =
    cursorValue === null ? null : PaginationCursorSchema.parse(cursorValue);
  const range = parsePacificDateRange(from, through);
  if (through > today) {
    throw new RecordsFilterError('The through date cannot be in the future.');
  }

  return Object.freeze({
    filters: Object.freeze({
      facilityId,
      from,
      through,
      eventTypeId,
      cursor,
    }),
    range,
  });
}

export default async function RecordsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<RawSearchParams> }>) {
  const parameters = await searchParams;
  const authenticated = await requireRecordsPageSession(
    recordsReturnTo(parameters),
  );
  const options = await loadRecordsFilterOptions(authenticated);
  const today = currentPacificDate();
  const defaultFacilityId = options.facilities[0]?.id;
  if (defaultFacilityId === undefined) {
    return (
      <RecordsView
        errorMessage={null}
        eventTypes={options.eventTypes}
        facilities={options.facilities}
        filters={{
          facilityId: '',
          from: addCalendarDays(today, -30),
          through: today,
          eventTypeId: null,
          cursor: null,
        }}
        hasMore={false}
        nextCursor={null}
        records={[]}
        today={today}
      />
    );
  }

  let parsed: ReturnType<typeof parseFilters>;
  try {
    parsed = parseFilters(parameters, defaultFacilityId, today);
  } catch (error) {
    const message =
      error instanceof RecordsDateRangeError ||
      error instanceof RecordsFilterError
        ? error.message
        : 'Check the selected records filters.';
    return (
      <RecordsView
        errorMessage={message}
        eventTypes={options.eventTypes}
        facilities={options.facilities}
        filters={{
          facilityId: defaultFacilityId,
          from: addCalendarDays(today, -30),
          through: today,
          eventTypeId: null,
          cursor: null,
        }}
        hasMore={false}
        nextCursor={null}
        records={[]}
        today={today}
      />
    );
  }

  if (
    !options.facilities.some(
      (facility) => facility.id === parsed.filters.facilityId,
    ) ||
    (parsed.filters.eventTypeId !== null &&
      !options.eventTypes.some(
        ({ eventType }) => eventType.id === parsed.filters.eventTypeId,
      ))
  ) {
    notFound();
  }

  try {
    const page = await loadEventRecordPage(
      authenticated,
      ListEventRecordsInputSchema.parse({
        facilityId: parsed.filters.facilityId,
        eventTypeId: parsed.filters.eventTypeId,
        startedFrom: parsed.range.startedFrom,
        startedThrough: parsed.range.startedThrough,
        cursor: parsed.filters.cursor,
        limit: 200,
      }),
    );
    if (
      page.items.some(
        (record) => record.facilityId !== parsed.filters.facilityId,
      )
    ) {
      throw new Error('The records result crossed its authorized site filter.');
    }
    return (
      <RecordsView
        errorMessage={null}
        eventTypes={options.eventTypes}
        facilities={options.facilities}
        filters={parsed.filters}
        hasMore={page.pageInfo.hasMore}
        nextCursor={page.pageInfo.nextCursor}
        records={page.items}
        today={today}
      />
    );
  } catch (error) {
    if (
      error instanceof CapabilityEngineError &&
      (error.status === 403 || error.status === 404)
    ) {
      notFound();
    }
    if (error instanceof CapabilityEngineError && error.status === 400) {
      return (
        <RecordsView
          errorMessage="Check the selected records filters."
          eventTypes={options.eventTypes}
          facilities={options.facilities}
          filters={parsed.filters}
          hasMore={false}
          nextCursor={null}
          records={[]}
          today={today}
        />
      );
    }
    throw error;
  }
}
