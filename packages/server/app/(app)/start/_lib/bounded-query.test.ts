import { describe, expect, test } from 'bun:test';

import {
  BoundedDatabaseQueryError,
  collectBoundedDatabaseRows,
  START_FLOW_DATABASE_PAGE_SIZE,
  START_FLOW_ENDPOINT_PAGE_SIZE,
} from '../../../../lib/capabilities/start-bounded-query';

describe('start-flow bounded database reads', () => {
  test('loads every page in stable order without concurrent statements', async () => {
    const expected = Array.from(
      { length: START_FLOW_DATABASE_PAGE_SIZE * 2 + 7 },
      (_, index) => index,
    );
    const calls: Array<Readonly<{ offset: number; limit: number }>> = [];
    let activeStatements = 0;
    let maximumConcurrency = 0;

    const actual = await collectBoundedDatabaseRows(
      async (offset, limit) => {
        calls.push({ offset, limit });
        activeStatements += 1;
        maximumConcurrency = Math.max(maximumConcurrency, activeStatements);
        await Promise.resolve();
        const page = expected.slice(offset, offset + limit);
        activeStatements -= 1;
        return page;
      },
      { maxRows: expected.length },
    );

    expect(actual).toEqual(expected);
    expect(calls).toEqual([
      { offset: 0, limit: START_FLOW_DATABASE_PAGE_SIZE },
      {
        offset: START_FLOW_DATABASE_PAGE_SIZE,
        limit: START_FLOW_DATABASE_PAGE_SIZE,
      },
      {
        offset: START_FLOW_DATABASE_PAGE_SIZE * 2,
        limit: 8,
      },
    ]);
    expect(maximumConcurrency).toBe(1);
  });

  test('uses an empty sentinel page for an exact page-sized result', async () => {
    const expected = Array.from(
      { length: START_FLOW_DATABASE_PAGE_SIZE },
      (_, index) => index,
    );
    const offsets: number[] = [];

    const actual = await collectBoundedDatabaseRows(
      (offset, limit) => {
        offsets.push(offset);
        return Promise.resolve(expected.slice(offset, offset + limit));
      },
      { maxRows: expected.length },
    );

    expect(actual).toEqual(expected);
    expect(offsets).toEqual([0, START_FLOW_DATABASE_PAGE_SIZE]);
  });

  test('fails closed when a query violates its requested page size', async () => {
    expect(
      collectBoundedDatabaseRows(
        () =>
          Promise.resolve(
            Array.from(
              { length: START_FLOW_DATABASE_PAGE_SIZE + 1 },
              (_, index) => index,
            ),
          ),
        { maxRows: START_FLOW_DATABASE_PAGE_SIZE * 2 },
      ),
    ).rejects.toBeInstanceOf(BoundedDatabaseQueryError);
  });

  test('fails closed at the complete collection contract cap', async () => {
    const rows = Array.from(
      { length: START_FLOW_DATABASE_PAGE_SIZE + 1 },
      (_, index) => index,
    );

    expect(
      collectBoundedDatabaseRows(
        (offset, limit) => Promise.resolve(rows.slice(offset, offset + limit)),
        { maxRows: START_FLOW_DATABASE_PAGE_SIZE },
      ),
    ).rejects.toBeInstanceOf(BoundedDatabaseQueryError);
  });

  test('supports the smaller response bound required for endpoint payloads', async () => {
    const limits: number[] = [];
    const rows = Array.from(
      { length: START_FLOW_ENDPOINT_PAGE_SIZE + 1 },
      (_, index) => index,
    );

    const actual = await collectBoundedDatabaseRows(
      (offset, limit) => {
        limits.push(limit);
        return Promise.resolve(rows.slice(offset, offset + limit));
      },
      {
        maxRows: rows.length,
        pageSize: START_FLOW_ENDPOINT_PAGE_SIZE,
      },
    );

    expect(actual).toEqual(rows);
    expect(limits).toEqual([START_FLOW_ENDPOINT_PAGE_SIZE, 2]);
  });
});
