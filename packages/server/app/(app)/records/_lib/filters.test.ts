import { describe, expect, test } from 'bun:test';
import type { Facility } from '@psd-eoc/contracts';

import {
  ALL_AUTHORIZED_SITES,
  RecordsFilterError,
  defaultRecordsFacilityId,
  parseRecordsFilters,
  recordsStayInAdmittedSites,
} from './filters';

const TODAY = '2026-08-11';

function facility(id: string, code: string): Facility {
  return Object.freeze({
    id,
    code,
    name: `Synthetic ${code}`,
    active: true,
    isolated: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

const NORTH = facility('10000000-0000-4000-8000-000000000001', 'SYN');
const SOUTH = facility('10000000-0000-4000-8000-000000000002', 'SYS');

describe('records default site', () => {
  test('holds a single authorized site', () => {
    expect(defaultRecordsFacilityId([NORTH])).toBe(NORTH.id);
  });

  test('is every authorized site once more than one is authorized', () => {
    expect(defaultRecordsFacilityId([NORTH, SOUTH])).toBeNull();
  });

  test('is every authorized site when none are authorized', () => {
    expect(defaultRecordsFacilityId([])).toBeNull();
  });
});

describe('records filter parsing', () => {
  test('takes the scope default when no site is named', () => {
    expect(parseRecordsFilters({}, NORTH.id, TODAY).filters).toMatchObject({
      facilityId: NORTH.id,
      from: '2026-07-12',
      through: TODAY,
      eventTypeId: null,
      cursor: null,
    });
    expect(parseRecordsFilters({}, null, TODAY).filters.facilityId).toBeNull();
  });

  test('reads the reserved all-sites value as the scope default', () => {
    expect(
      parseRecordsFilters({ facilityId: ALL_AUTHORIZED_SITES }, null, TODAY)
        .filters.facilityId,
    ).toBeNull();
    // A single-site viewer's menu never offers `all`, so the link lands on
    // their one site, selected.
    expect(
      parseRecordsFilters({ facilityId: ALL_AUTHORIZED_SITES }, NORTH.id, TODAY)
        .filters.facilityId,
    ).toBe(NORTH.id);
  });

  test('keeps one named site, and refuses anything that is not a site', () => {
    expect(
      parseRecordsFilters({ facilityId: SOUTH.id }, NORTH.id, TODAY).filters
        .facilityId,
    ).toBe(SOUTH.id);
    // A near miss of the reserved value is not the reserved value: it has to
    // parse as a facility identifier or be refused.
    expect(() =>
      parseRecordsFilters({ facilityId: 'ALL' }, NORTH.id, TODAY),
    ).toThrow();
    expect(() =>
      parseRecordsFilters({ facilityId: 'not-a-facility' }, null, TODAY),
    ).toThrow();
  });

  test('refuses repeated, unknown, and future parameters', () => {
    expect(() =>
      parseRecordsFilters({ facilityId: [NORTH.id, SOUTH.id] }, null, TODAY),
    ).toThrow(RecordsFilterError);
    expect(() =>
      parseRecordsFilters({ unexpected: 'value' }, null, TODAY),
    ).toThrow(RecordsFilterError);
    expect(() =>
      parseRecordsFilters({ through: '2026-08-12' }, null, TODAY),
    ).toThrow('The through date cannot be in the future.');
  });

  test('carries the named date range through to the capability range', () => {
    const parsed = parseRecordsFilters(
      { from: '2026-08-01', through: '2026-08-10', eventTypeId: '' },
      null,
      TODAY,
    );
    expect(parsed.filters).toMatchObject({
      facilityId: null,
      from: '2026-08-01',
      through: '2026-08-10',
      eventTypeId: null,
    });
    // Pacific midnight to the last millisecond of the through date (PDT).
    expect(parsed.range.startedFrom).toBe('2026-08-01T07:00:00.000Z');
    expect(parsed.range.startedThrough).toBe('2026-08-11T06:59:59.999Z');
  });
});

describe('records site leak guard', () => {
  const WEST = facility('10000000-0000-4000-8000-000000000003', 'SYW');
  const at = (facilityId: string) => ({ facilityId });

  test('admits only the selected site while one is selected', () => {
    expect(
      recordsStayInAdmittedSites([at(NORTH.id)], NORTH.id, [NORTH, SOUTH]),
    ).toBe(true);
    expect(
      recordsStayInAdmittedSites([at(NORTH.id), at(SOUTH.id)], NORTH.id, [
        NORTH,
        SOUTH,
      ]),
    ).toBe(false);
  });

  test('admits exactly the authorized sites across all sites', () => {
    expect(
      recordsStayInAdmittedSites([at(NORTH.id), at(SOUTH.id)], null, [
        NORTH,
        SOUTH,
      ]),
    ).toBe(true);
    expect(
      recordsStayInAdmittedSites([at(NORTH.id), at(WEST.id)], null, [
        NORTH,
        SOUTH,
      ]),
    ).toBe(false);
  });

  test('admits an empty page', () => {
    expect(recordsStayInAdmittedSites([], null, [])).toBe(true);
  });
});
