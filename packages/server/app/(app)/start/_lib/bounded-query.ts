/** Default page size for the start flow's small, fixed-width database rows. */
export const START_FLOW_DATABASE_PAGE_SIZE = 100;

/**
 * Push tokens can contain 4,096 Unicode code units. Twenty-five worst-case
 * escaped tokens plus row overhead remain conservatively below the Aurora
 * Data API's one-megabyte response ceiling.
 */
export const START_FLOW_ENDPOINT_PAGE_SIZE = 25;

/** A bounded database page violated the query helper's transport contract. */
export class BoundedDatabaseQueryError extends Error {
  public constructor() {
    super('A bounded database query returned an invalid page.');
    this.name = 'BoundedDatabaseQueryError';
  }
}

export interface BoundedDatabaseQueryOptions {
  /** Maximum rows the owning contract permits for this collection. */
  readonly maxRows: number;
  /** Maximum rows requested in any one transport response. */
  readonly pageSize?: number;
}

/**
 * Collects an immutable result set through sequential, response-bounded reads.
 *
 * The start flow runs inside one database transaction. Aurora's Data API
 * rejects concurrent statements for the same transaction ID, so every page is
 * awaited before the next statement begins.
 */
export async function collectBoundedDatabaseRows<Row>(
  fetchPage: (offset: number, limit: number) => PromiseLike<readonly Row[]>,
  options: BoundedDatabaseQueryOptions,
): Promise<readonly Row[]> {
  const pageSize = options.pageSize ?? START_FLOW_DATABASE_PAGE_SIZE;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    !Number.isSafeInteger(options.maxRows) ||
    options.maxRows < 0
  ) {
    throw new BoundedDatabaseQueryError();
  }

  const collected: Row[] = [];
  let offset = 0;

  for (;;) {
    // Reserve one final row to prove a corrupt persisted collection does not
    // exceed its contract cap before loading it into memory.
    const limit = Math.min(pageSize, options.maxRows - collected.length + 1);
    const page = await fetchPage(offset, limit);
    if (
      page.length > limit ||
      collected.length + page.length > options.maxRows
    ) {
      throw new BoundedDatabaseQueryError();
    }

    collected.push(...page);
    if (page.length < limit) {
      return collected;
    }

    offset += page.length;
    if (!Number.isSafeInteger(offset)) {
      throw new BoundedDatabaseQueryError();
    }
  }
}
