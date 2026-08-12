import { describe, expect, test } from 'bun:test';

import {
  RecordsDateRangeError,
  addCalendarDays,
  currentPacificDate,
  pacificStartOfDay,
  parsePacificDateRange,
} from './date-range';

describe('records Pacific date ranges', () => {
  test('resolves Pacific calendar boundaries across daylight-saving changes', () => {
    expect(pacificStartOfDay('2026-03-08').toISOString()).toBe(
      '2026-03-08T08:00:00.000Z',
    );
    expect(pacificStartOfDay('2026-03-09').toISOString()).toBe(
      '2026-03-09T07:00:00.000Z',
    );
    expect(pacificStartOfDay('2026-11-01').toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
    expect(pacificStartOfDay('2026-11-02').toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  test('turns inclusive local dates into absolute filter timestamps', () => {
    expect(parsePacificDateRange('2026-08-10', '2026-08-11')).toEqual({
      from: '2026-08-10',
      through: '2026-08-11',
      startedFrom: '2026-08-10T07:00:00.000Z',
      startedThrough: '2026-08-12T06:59:59.999Z',
    });
    expect(parsePacificDateRange('2024-11-02', '2025-11-02')).toEqual({
      from: '2024-11-02',
      through: '2025-11-02',
      startedFrom: '2024-11-02T07:00:00.000Z',
      startedThrough: '2025-11-03T07:59:59.999Z',
    });
  });

  test('rejects invalid, reversed, and overlong export ranges', () => {
    expect(() => parsePacificDateRange('2026-02-30', '2026-03-01')).toThrow(
      RecordsDateRangeError,
    );
    expect(() => parsePacificDateRange('2026-03-02', '2026-03-01')).toThrow(
      'cannot be before',
    );
    expect(() => parsePacificDateRange('2025-01-01', '2026-01-02')).toThrow(
      '366 days or fewer',
    );
  });

  test('uses date-only arithmetic and the Pacific current date', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(currentPacificDate(new Date('2026-08-11T06:30:00.000Z'))).toBe(
      '2026-08-10',
    );
  });
});
