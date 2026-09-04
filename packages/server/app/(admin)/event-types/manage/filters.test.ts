import { describe, expect, test } from 'bun:test';

import { parseResponseListFilters, responseListHref } from './filters';

describe('responses admin list filters', () => {
  test('hides retired responses until someone asks for them', () => {
    // A retired response is never deleted, so without a default filter the
    // picker grows forever with entries no operator can choose.
    expect(parseResponseListFilters({})).toEqual({
      templateMode: null,
      enabled: true,
      showRetired: false,
    });
    expect(parseResponseListFilters({ show: 'all' })).toEqual({
      templateMode: null,
      enabled: null,
      showRetired: true,
    });
  });

  test('keeps the existing mode filter and ignores anything else', () => {
    expect(parseResponseListFilters({ mode: 'real' }).templateMode).toBe(
      'real',
    );
    expect(parseResponseListFilters({ mode: 'drill' }).templateMode).toBe(
      'drill',
    );
    for (const mode of ['REAL', 'test', '', 'drill drill']) {
      expect(parseResponseListFilters({ mode }).templateMode).toBeNull();
    }
    for (const show of ['ALL', 'true', 'retired', '']) {
      expect(parseResponseListFilters({ show }).showRetired).toBe(false);
    }
  });

  test('builds the canonical URL for each filter combination', () => {
    expect(responseListHref({ showRetired: false })).toBe(
      '/event-types/manage',
    );
    expect(responseListHref({ showRetired: true })).toBe(
      '/event-types/manage?show=all',
    );
    expect(
      responseListHref({ templateMode: 'drill', showRetired: false }),
    ).toBe('/event-types/manage?mode=drill');
    expect(responseListHref({ templateMode: 'real', showRetired: true })).toBe(
      '/event-types/manage?mode=real&show=all',
    );
    expect(responseListHref({ templateMode: null, showRetired: false })).toBe(
      '/event-types/manage',
    );
  });

  test('round-trips every URL it builds', () => {
    for (const templateMode of ['real', 'drill', null] as const) {
      for (const showRetired of [true, false]) {
        const href = responseListHref({ templateMode, showRetired });
        const query = new URLSearchParams(href.split('?')[1] ?? '');
        expect(
          parseResponseListFilters({
            ...(query.get('mode') === null ? {} : { mode: query.get('mode')! }),
            ...(query.get('show') === null ? {} : { show: query.get('show')! }),
          }),
        ).toEqual({
          templateMode,
          enabled: showRetired ? null : true,
          showRetired,
        });
      }
    }
  });
});
