import { describe, expect, test } from 'bun:test';
import { FacilitySchema } from '@psd-eoc/contracts';

import {
  collectAllOperationalPages,
  prepareAuthorizedFacilities,
} from './data';

describe('operational cursor pagination', () => {
  test('loads every page in order before exposing operational data', async () => {
    const requestedCursors: Array<string | null> = [];
    const pages = new Map<
      string | null,
      Readonly<{
        items: readonly string[];
        pageInfo: Readonly<{
          hasMore: boolean;
          nextCursor: string | null;
        }>;
      }>
    >([
      [
        null,
        {
          items: ['facility-1'],
          pageInfo: { hasMore: true, nextCursor: 'page_2' },
        },
      ],
      [
        'page_2',
        {
          items: ['facility-2'],
          pageInfo: { hasMore: true, nextCursor: 'page_3' },
        },
      ],
      [
        'page_3',
        {
          items: ['facility-3'],
          pageInfo: { hasMore: false, nextCursor: null },
        },
      ],
    ]);

    const items = await collectAllOperationalPages(async (cursor) => {
      requestedCursors.push(cursor);
      const page = pages.get(cursor);
      if (page === undefined) throw new Error('Unexpected synthetic cursor.');
      return page;
    });

    expect(items).toEqual(['facility-1', 'facility-2', 'facility-3']);
    expect(requestedCursors).toEqual([null, 'page_2', 'page_3']);
    expect(Object.isFrozen(items)).toBe(true);
  });

  test('fails closed instead of presenting a partial repeated-cursor result', async () => {
    const requestedCursors: Array<string | null> = [];

    await expect(
      collectAllOperationalPages(async (cursor) => {
        requestedCursors.push(cursor);
        return {
          items: [String(cursor ?? 'first')],
          pageInfo: { hasMore: true, nextCursor: 'repeated' },
        };
      }),
    ).rejects.toThrow('Operational pagination did not advance');
    expect(requestedCursors).toEqual([null, 'repeated']);
  });

  test('fails closed when a cursor chain exceeds the safety bound', async () => {
    let requestCount = 0;

    await expect(
      collectAllOperationalPages(async () => {
        requestCount += 1;
        return {
          items: [requestCount],
          pageInfo: {
            hasMore: true,
            nextCursor: `page_${requestCount}`,
          },
        };
      }),
    ).rejects.toThrow('Operational pagination exceeded its safety bound');
    expect(requestCount).toBe(1_000);
  });
});

describe('authorized facility projection', () => {
  test('retains inactive facility names for active events without offering a new start', () => {
    const active = FacilitySchema.parse({
      id: '18000000-0000-4000-8000-000000000001',
      code: 'OPEN',
      name: 'Synthetic Open Campus',
      active: true,
      createdAt: '2026-08-10T18:00:00.000Z',
    });
    const inactive = FacilitySchema.parse({
      id: '18000000-0000-4000-8000-000000000002',
      code: 'CLOSED',
      name: 'Synthetic Deactivated Campus',
      active: false,
      createdAt: '2026-08-10T18:00:00.000Z',
    });

    const view = prepareAuthorizedFacilities([active, inactive]);

    expect(view.startFacilities).toEqual([active]);
    expect(view.facilityNameById.get(inactive.id)).toBe(inactive.name);
  });
});
