import { describe, expect, test } from 'bun:test';
import type { DrillRecord, Facility } from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DrillRecordsView,
  drillCsvExportPath,
  type RecordsFilters,
} from './records-view';

const FACILITY: Facility = Object.freeze({
  id: '10000000-0000-4000-8000-000000000001',
  code: 'SYN',
  name: 'Synthetic North Campus',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const FILTERS: RecordsFilters = Object.freeze({
  facilityId: FACILITY.id,
  from: '2026-08-01',
  through: '2026-08-11',
  eventTypeId: null,
  cursor: null,
});

function record(kind: 'drill' | 'test'): DrillRecord {
  return Object.freeze({
    id:
      kind === 'drill'
        ? '20000000-0000-4000-8000-000000000001'
        : '20000000-0000-4000-8000-000000000002',
    eventId:
      kind === 'drill'
        ? '30000000-0000-4000-8000-000000000001'
        : '30000000-0000-4000-8000-000000000002',
    facilityId: FACILITY.id,
    kind,
    eventTypeVersion: {
      id: '40000000-0000-4000-8000-000000000001',
      templateMode: 'drill' as const,
    },
    eventTypeName: kind === 'drill' ? 'Earthquake Drill' : 'System Test',
    status: 'closed',
    startedAt: '2026-08-10T16:00:00.000Z',
    allClearAt: '2026-08-10T16:14:00.000Z',
    reactivatedAt: null,
    closedAt: '2026-08-10T16:15:30.000Z',
  });
}

describe('drill records view', () => {
  test('shows explicit drill labels and the RCW date, time, and type columns', () => {
    const html = renderToStaticMarkup(
      <DrillRecordsView
        errorMessage={null}
        eventTypes={[]}
        facilities={[FACILITY]}
        filters={FILTERS}
        hasMore={false}
        nextCursor={null}
        records={[record('drill'), record('test')]}
        today="2026-08-11"
      />,
    );

    expect(html).toContain('DRILL RECORDS — TRAINING EVIDENCE');
    expect(html).toContain('No real incidents appear in this log.');
    expect(html).toContain('<th scope="col">Date</th>');
    expect(html).toContain('<th scope="col">Time</th>');
    expect(html).toContain('<th scope="col">Type</th>');
    expect(html).toContain('August 10, 2026');
    expect(html).toContain('9:00:00 AM PDT');
    expect(html).toContain('DRILL — TRAINING ONLY');
    expect(html).toContain('TEST — TRAINING ONLY');
    expect(html).toContain('Earthquake Drill');
    expect(html).toContain('14 min 0 sec');
    expect(html).toContain('participant count');
    expect(html).toContain('/events/30000000-0000-4000-8000-000000000001');
  });

  test('builds a site- and date-bound CSV route with explicit event type', () => {
    expect(drillCsvExportPath(FILTERS)).toBe(
      '/records/export/drills?facilityId=10000000-0000-4000-8000-000000000001&startedFrom=2026-08-01&startedThrough=2026-08-11&eventTypeId=',
    );
  });

  test('does not expose an export link when filters are invalid', () => {
    const html = renderToStaticMarkup(
      <DrillRecordsView
        errorMessage="Check the selected records filters."
        eventTypes={[]}
        facilities={[FACILITY]}
        filters={FILTERS}
        hasMore={false}
        nextCursor={null}
        records={[]}
        today="2026-08-11"
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('/records/export/drills?');
  });
});
