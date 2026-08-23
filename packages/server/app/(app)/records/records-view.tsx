import type {
  DrillRecord,
  EventTypeListItem,
  Facility,
} from '@psd-eoc/contracts';
import Link from 'next/link';

export interface RecordsFilters {
  readonly facilityId: string;
  readonly from: string;
  readonly through: string;
  readonly eventTypeId: string | null;
  readonly cursor: string | null;
}

export interface DrillRecordsViewProps {
  readonly errorMessage: string | null;
  readonly eventTypes: readonly EventTypeListItem[];
  readonly facilities: readonly Facility[];
  readonly filters: RecordsFilters;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly records: readonly DrillRecord[];
  readonly today: string;
}

const PACIFIC_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const PACIFIC_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

function recordClassification(record: DrillRecord): string {
  return record.kind === 'test'
    ? 'TEST — TRAINING ONLY'
    : 'DRILL — TRAINING ONLY';
}

function recordStatus(record: DrillRecord): string {
  switch (record.status) {
    case 'active':
      return 'Active';
    case 'all-clear':
      return 'All-clear issued';
    case 'closed':
      return 'Closed';
    case 'draft':
      return 'Draft';
  }
}

function recordDuration(record: DrillRecord): string {
  if (record.status === 'active') {
    return 'In progress';
  }
  const endedAt = record.allClearAt;
  if (endedAt === null) {
    return 'Unknown';
  }
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(endedAt) - Date.parse(record.startedAt)) / 1_000),
  );
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return hours > 0
    ? `${hours} hr ${minutes} min ${remainingSeconds} sec`
    : `${minutes} min ${remainingSeconds} sec`;
}

function filterQuery(filters: RecordsFilters, cursor: string | null): string {
  const query = new URLSearchParams({
    facilityId: filters.facilityId,
    from: filters.from,
    through: filters.through,
    eventTypeId: filters.eventTypeId ?? '',
  });
  if (cursor !== null) {
    query.set('cursor', cursor);
  }
  return query.toString();
}

export function drillCsvExportPath(filters: RecordsFilters): string {
  const query = new URLSearchParams({
    facilityId: filters.facilityId,
    startedFrom: filters.from,
    startedThrough: filters.through,
    eventTypeId: filters.eventTypeId ?? '',
  });
  return `/records/export/drills?${query.toString()}`;
}

export function DrillRecordsView({
  errorMessage,
  eventTypes,
  facilities,
  filters,
  hasMore,
  nextCursor,
  records,
  today,
}: DrillRecordsViewProps) {
  const facilityNameById = new Map(
    facilities.map((facility) => [facility.id, facility.name]),
  );
  const canQuery = facilities.length > 0;

  return (
    <main className="page-shell records-page" id="main-content" tabIndex={-1}>
      <header className="page-heading records-heading">
        <div className="page-heading__copy">
          <p className="eyebrow">Retained training evidence</p>
          <h1>Drill records</h1>
          <p className="lede">
            Review authorized drill and test history. This page never starts an
            event or sends a notification.
          </p>
        </div>
        <Link className="button button--secondary" href="/">
          Back to active events
        </Link>
      </header>

      <div className="records-classification" role="note">
        <span aria-hidden="true">◆</span>
        <strong>DRILL RECORDS — TRAINING EVIDENCE</strong>
        <span>No real incidents appear in this log.</span>
      </div>

      {canQuery ? (
        <form action="/records" className="records-filters" method="get">
          <div className="filter-field">
            <label htmlFor="records-facility">Site</label>
            <select
              defaultValue={filters.facilityId}
              id="records-facility"
              name="facilityId"
              required
            >
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name} ({facility.code})
                  {facility.active ? '' : ' — inactive'}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="records-from">From date</label>
            <input
              defaultValue={filters.from}
              id="records-from"
              max={today}
              name="from"
              required
              type="date"
            />
          </div>
          <div className="filter-field">
            <label htmlFor="records-through">Through date</label>
            <input
              defaultValue={filters.through}
              id="records-through"
              max={today}
              name="through"
              required
              type="date"
            />
          </div>
          <div className="filter-field">
            <label htmlFor="records-event-type">Event type</label>
            <select
              defaultValue={filters.eventTypeId ?? ''}
              id="records-event-type"
              name="eventTypeId"
            >
              <option value="">All drill types</option>
              {eventTypes.map(({ eventType, latestVersion }) => (
                <option key={eventType.id} value={eventType.id}>
                  {latestVersion.name}
                  {latestVersion.enabled ? '' : ' — disabled'}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Apply filters</button>
        </form>
      ) : (
        <p className="status-message" role="status">
          No facilities are available in your authorized scope.
        </p>
      )}

      {errorMessage === null ? null : (
        <section className="records-error" role="alert">
          <h2>Records could not be shown</h2>
          <p>{errorMessage}</p>
        </section>
      )}

      {errorMessage !== null || !canQuery ? null : (
        <section aria-labelledby="drill-log-heading">
          <div className="section-heading records-results-heading">
            <div>
              <h2 id="drill-log-heading">Authorized drill log</h2>
              <p className="muted">
                Dates and times use Pacific time. Records come from retained,
                append-only event history.
              </p>
            </div>
            <a
              className="button button--drill"
              href={drillCsvExportPath(filters)}
            >
              Download CSV
            </a>
          </div>
          <p className="export-note">
            The CSV includes site, date, time, drill type, duration, and
            participant count for this explicit site and date range.
          </p>

          {records.length === 0 ? (
            <p className="status-message" role="status">
              No drill or test records match these filters.
            </p>
          ) : (
            <div
              aria-label="Authorized drill records"
              className="records-table-scroll"
              role="region"
              tabIndex={0}
            >
              <table className="records-table">
                <caption>
                  Drill and test history for the selected site and date range
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Site</th>
                    <th scope="col">Date</th>
                    <th scope="col">Time</th>
                    <th scope="col">Type</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Status</th>
                    <th scope="col">Event</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => {
                    const startedAt = new Date(record.startedAt);
                    return (
                      <tr key={record.id}>
                        <td>
                          {facilityNameById.get(record.facilityId) ??
                            'Authorized facility'}
                        </td>
                        <td>
                          <time dateTime={record.startedAt}>
                            {PACIFIC_DATE_FORMATTER.format(startedAt)}
                          </time>
                        </td>
                        <td>
                          <time dateTime={record.startedAt}>
                            {PACIFIC_TIME_FORMATTER.format(startedAt)}
                          </time>
                        </td>
                        <td>
                          <span className="record-kind">
                            {recordClassification(record)}
                          </span>
                          <span>{record.eventTypeName}</span>
                        </td>
                        <td>{recordDuration(record)}</td>
                        <td>{recordStatus(record)}</td>
                        <td>
                          <a
                            href={`/events/${encodeURIComponent(record.eventId)}`}
                          >
                            Open event
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {hasMore && nextCursor !== null ? (
            <nav aria-label="Drill-record pages" className="records-pagination">
              <a
                className="button button--secondary"
                href={`/records?${filterQuery(filters, nextCursor)}`}
                rel="next"
              >
                Next page
              </a>
            </nav>
          ) : null}
        </section>
      )}
    </main>
  );
}
