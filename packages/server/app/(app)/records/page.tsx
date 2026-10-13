import { ListEventRecordsInputSchema } from '@psd-eoc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import {
  RecordsDateRangeError,
  addCalendarDays,
  currentPacificDate,
} from './_lib/date-range';
import {
  RecordsFilterError,
  defaultRecordsFacilityId,
  parseRecordsFilters,
  type RawSearchParams,
} from './_lib/filters';
import { loadEventRecordPage, loadRecordsFilterOptions } from './_lib/data';
import { requireRecordsPageSession } from './_lib/session';
import { RecordsView } from './records-view';
import '../start/styles.css';
import './styles.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = {
  title: { absolute: 'Records' },
  description: 'Authorized retained incident, drill, and test history.',
};

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

export default async function RecordsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<RawSearchParams> }>) {
  const parameters = await searchParams;
  const authenticated = await requireRecordsPageSession(
    recordsReturnTo(parameters),
  );
  const options = await loadRecordsFilterOptions(authenticated);
  const today = currentPacificDate();
  const defaultFacilityId = defaultRecordsFacilityId(options.facilities);
  /** The page with no rows: an unauthorized scope, or filters to correct. */
  const emptyView = (errorMessage: string | null) => (
    <RecordsView
      errorMessage={errorMessage}
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
  if (options.facilities.length === 0) {
    return emptyView(null);
  }

  let parsed: ReturnType<typeof parseRecordsFilters>;
  try {
    parsed = parseRecordsFilters(parameters, defaultFacilityId, today);
  } catch (error) {
    return emptyView(
      error instanceof RecordsDateRangeError ||
        error instanceof RecordsFilterError
        ? error.message
        : 'Check the selected records filters.',
    );
  }

  if (
    (parsed.filters.facilityId !== null &&
      !options.facilities.some(
        (facility) => facility.id === parsed.filters.facilityId,
      )) ||
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
    // One selected site admits that site alone; every authorized site admits
    // exactly the sites this viewer's scope listed. Either way a row from
    // anywhere else is a leak, and the page refuses to render it.
    const admittedFacilityIds = new Set(
      parsed.filters.facilityId === null
        ? options.facilities.map((facility) => facility.id)
        : [parsed.filters.facilityId],
    );
    if (
      page.items.some((record) => !admittedFacilityIds.has(record.facilityId))
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
