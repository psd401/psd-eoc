import { describe, expect, test } from 'bun:test';

import { formatConsentDate } from './text-alerts-view';

const PACIFIC = 'America/Los_Angeles';

describe('consent date rendering', () => {
  test('shows the district-local date, not the UTC one', () => {
    // 8:52pm Pacific on 5 September is already 6 September in UTC. Formatting
    // the stored instant as UTC put tomorrow's date on the consent record --
    // observed in production before this fix.
    const instant = '2026-09-06T03:52:00.000Z';

    expect(formatConsentDate(instant, PACIFIC)).toBe('Sep 5, 2026');
    expect(new Date(instant).toISOString().slice(0, 10)).toBe('2026-09-06');
  });

  test.each([
    ['2026-09-06T06:59:59.999Z', 'Sep 5, 2026', 'one second before midnight'],
    ['2026-09-06T07:00:00.000Z', 'Sep 6, 2026', 'exactly midnight'],
  ])('%s renders %s (%s Pacific)', (instant, expected) => {
    expect(formatConsentDate(instant, PACIFIC)).toBe(expected);
  });

  test('honours a different configured zone', () => {
    // The zone is deployment configuration, so this must not be Pacific-only.
    expect(
      formatConsentDate('2026-09-06T03:52:00.000Z', 'America/New_York'),
    ).toBe('Sep 5, 2026');
    expect(
      formatConsentDate('2026-09-06T05:30:00.000Z', 'America/New_York'),
    ).toBe('Sep 6, 2026');
  });
});
