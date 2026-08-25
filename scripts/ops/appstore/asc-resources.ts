import { createAscJwt } from './asc-auth';
import {
  API_ORIGIN,
  type AscClient,
  type AscCredentials,
  canonicalJson,
  isOpaquePaginationCursor,
  isRecord,
  type JsonApiPageSummary,
  type JsonApiResource,
  MAX_GET_ATTEMPTS,
  MAX_PAGES,
  MAX_RESOURCES,
  MAX_TESTERS_PER_GROUP,
  type MutationMethod,
  resourceFromUnknown,
} from './asc-model';
import { cancelResponseBody, readBoundedResponseJson } from './asc-transport';
const pageSummaryFromUnknown = (value: unknown): JsonApiPageSummary => {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Apple returned a malformed page-summary response.');
  }
  if (value.data.length > 1) {
    throw new Error('Apple ignored the page-summary query limit.');
  }
  const meta = value.meta;
  const paging = isRecord(meta) ? meta.paging : undefined;
  const total = isRecord(paging) ? paging.total : undefined;
  const limit = isRecord(paging) ? paging.limit : undefined;
  if (
    limit !== 1 ||
    !Number.isInteger(limit) ||
    typeof total !== 'number' ||
    !Number.isInteger(total) ||
    total < 0 ||
    total > MAX_TESTERS_PER_GROUP
  ) {
    throw new Error('Apple returned a malformed tester roster total.');
  }
  if (value.data.length !== Math.min(total, 1)) {
    throw new Error('Apple returned an inconsistent tester roster summary.');
  }
  return Object.freeze({
    resources: Object.freeze(
      value.data.map((resource) => resourceFromUnknown(resource)),
    ),
    total,
  });
};
export class AppStoreConnectClient implements AscClient {
  readonly #credentials: AscCredentials;
  #rateLimitRemaining: number | null = null;
  constructor(credentials: AscCredentials) {
    this.#credentials = credentials;
  }
  rateLimitRemaining(): number | null {
    return this.#rateLimitRemaining;
  }
  async first(path: string): Promise<JsonApiResource | null> {
    const body = await this.#requestJson('GET', this.#validatedUrl(path));
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new Error('Apple returned a malformed list response.');
    }
    if (body.data.length === 0) return null;
    if (body.data.length !== 1) {
      throw new Error('Apple ignored a single-resource query limit.');
    }
    return resourceFromUnknown(body.data[0]);
  }
  async list(path: string): Promise<readonly JsonApiResource[]> {
    const resources: JsonApiResource[] = [];
    const visited = new Set<string>();
    const trustedUrl = this.#validatedUrl(path);
    const requestedLimits = trustedUrl.searchParams.getAll('limit');
    const requestedLimit = Number(requestedLimits[0]);
    if (
      trustedUrl.searchParams.has('cursor') ||
      requestedLimits.length !== 1 ||
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > 200 ||
      String(requestedLimit) !== requestedLimits[0]
    ) {
      throw new Error(
        'Apple collection reads require one canonical bounded page limit.',
      );
    }
    let nextUrl: URL | null = new URL(trustedUrl.href);
    let expectedTotal: number | null = null;
    for (let page = 0; nextUrl !== null; page += 1) {
      if (page >= MAX_PAGES)
        throw new Error('Apple pagination exceeded its limit.');
      if (visited.has(nextUrl.href)) {
        throw new Error('Apple pagination repeated a page URL.');
      }
      visited.add(nextUrl.href);
      const currentUrl: URL = nextUrl;
      const body = await this.#requestJson('GET', currentUrl);
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new Error('Apple returned a malformed list response.');
      }
      if (body.data.length > requestedLimit) {
        throw new Error('Apple exceeded the requested collection page limit.');
      }
      const paging = isRecord(body.meta) ? body.meta.paging : undefined;
      const total = isRecord(paging) ? paging.total : undefined;
      const limit = isRecord(paging) ? paging.limit : undefined;
      if (
        typeof total !== 'number' ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        total > MAX_RESOURCES ||
        limit !== requestedLimit
      ) {
        throw new Error('Apple returned malformed pagination metadata.');
      }
      if (expectedTotal === null) expectedTotal = total;
      else if (total !== expectedTotal) {
        throw new Error(
          'Apple changed the collection total during pagination.',
        );
      }
      if (page > 0 && body.data.length === 0) {
        throw new Error(
          'Apple returned an empty continuation page; request-cost bounds are unavailable.',
        );
      }
      for (const item of body.data) resources.push(resourceFromUnknown(item));
      if (resources.length > total) {
        throw new Error(
          'Apple returned more resources than its collection total.',
        );
      }
      const links = body.links;
      if (!isRecord(links)) {
        throw new Error('Apple returned malformed pagination links.');
      }
      const selfLink = links.self;
      if (
        typeof selfLink !== 'string' ||
        selfLink.length === 0 ||
        selfLink.length > 4096
      ) {
        throw new Error('Apple returned malformed pagination links.');
      }
      let selfUrl: URL;
      try {
        selfUrl = this.#validatedUrl(new URL(selfLink, currentUrl).href);
      } catch {
        throw new Error('Apple returned malformed pagination links.');
      }
      if (selfUrl.href !== currentUrl.href) {
        throw new Error('Apple returned a mismatched pagination self link.');
      }
      const candidate = links.next;
      nextUrl =
        candidate === undefined || candidate === null
          ? null
          : this.#validatedContinuationUrl(trustedUrl, currentUrl, candidate);
      if (nextUrl !== null && body.data.length !== requestedLimit) {
        throw new Error(
          'Apple returned a sparse non-final collection page; request-cost bounds are unavailable.',
        );
      }
      if (nextUrl !== null && resources.length >= total) {
        throw new Error(
          'Apple returned pagination beyond its collection total.',
        );
      }
      if (nextUrl === null && resources.length !== total) {
        throw new Error('Apple returned an incomplete collection inventory.');
      }
    }
    return resources;
  }
  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    const url = this.#validatedUrl(path);
    if (
      url.searchParams.getAll('limit').length !== 1 ||
      url.searchParams.get('limit') !== '1' ||
      url.searchParams.has('cursor')
    ) {
      throw new Error('Page-summary reads require an exact one-item limit.');
    }
    return pageSummaryFromUnknown(await this.#requestJson('GET', url));
  }
  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    const body = await this.#requestJson('GET', this.#validatedUrl(path));
    if (!isRecord(body))
      throw new Error('Apple returned a malformed response.');
    return resourceFromUnknown(body.data, expectedType);
  }
  async mutate(
    method: MutationMethod,
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    if (method === 'PATCH' && expectedType === undefined) {
      throw new Error('Apple PATCH requires an expected resource type.');
    }
    try {
      const response = await this.#requestJson(
        method,
        this.#validatedUrl(path),
        body,
        method === 'PATCH' ? 200 : expectedType === undefined ? 204 : 201,
      );
      if (response === null) {
        if (expectedType !== undefined) {
          throw new Error('Apple omitted a required mutation response.');
        }
        return null;
      }
      if (expectedType === undefined) {
        throw new Error(
          'Apple returned content for a no-content relationship mutation.',
        );
      }
      if (!isRecord(response))
        throw new Error('Apple returned a malformed response.');
      return resourceFromUnknown(response.data, expectedType);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Apple ') &&
        error.message.includes('failed with HTTP')
      ) {
        throw error;
      }
      throw new Error(
        `Apple ${method} outcome is indeterminate; stop, inspect App Store Connect, and run a new preview.`,
      );
    }
  }
  #validatedUrl(pathOrUrl: string): URL {
    let url: URL;
    try {
      url = pathOrUrl.startsWith('/')
        ? new URL(pathOrUrl, API_ORIGIN)
        : new URL(pathOrUrl);
    } catch {
      throw new Error(
        'Refusing to send Apple credentials to an unexpected URL.',
      );
    }
    if (
      url.origin !== API_ORIGIN ||
      !url.pathname.startsWith('/v1/') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      throw new Error(
        'Refusing to send Apple credentials to an unexpected URL.',
      );
    }
    return url;
  }
  #validatedContinuationUrl(
    initialUrl: URL,
    currentUrl: URL,
    candidate: unknown,
  ): URL {
    const unsafePagination = (): never => {
      throw new Error('Apple returned an unsafe pagination continuation.');
    };
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.length > 4096
    ) {
      return unsafePagination();
    }
    if (
      [...candidate].some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)
        );
      }) ||
      candidate.includes('@') ||
      candidate.includes('\\') ||
      candidate.includes('#')
    ) {
      return unsafePagination();
    }
    let continuation: URL;
    try {
      continuation = new URL(candidate, currentUrl);
    } catch {
      return unsafePagination();
    }
    if (
      continuation.origin !== initialUrl.origin ||
      continuation.pathname !== initialUrl.pathname ||
      continuation.username !== '' ||
      continuation.password !== '' ||
      continuation.hash !== ''
    ) {
      return unsafePagination();
    }
    const cursors = continuation.searchParams.getAll('cursor');
    if (cursors.length !== 1) return unsafePagination();
    const cursor = cursors[0];
    if (!isOpaquePaginationCursor(cursor)) {
      return unsafePagination();
    }
    const trustedValues = new Map<string, string[]>();
    for (const [key, value] of initialUrl.searchParams) {
      const values = trustedValues.get(key);
      if (values === undefined) trustedValues.set(key, [value]);
      else values.push(value);
    }
    const continuationValues = new Map<string, string[]>();
    for (const [key, value] of continuation.searchParams) {
      if (key === 'cursor') continue;
      if (!trustedValues.has(key)) return unsafePagination();
      const values = continuationValues.get(key);
      if (values === undefined) continuationValues.set(key, [value]);
      else values.push(value);
    }
    if (
      continuationValues.size !== 0 &&
      continuationValues.size !== trustedValues.size
    ) {
      return unsafePagination();
    }
    for (const [key, values] of continuationValues) {
      const trusted = trustedValues.get(key);
      if (trusted === undefined || values.length !== trusted.length) {
        return unsafePagination();
      }
      const sortedValues = [...values].sort();
      const sortedTrusted = [...trusted].sort();
      if (sortedValues.some((value, index) => value !== sortedTrusted[index])) {
        return unsafePagination();
      }
    }
    const reconstructed = new URL(initialUrl.href);
    reconstructed.searchParams.append('cursor', cursor);
    return reconstructed;
  }
  async #requestJson(
    method: 'GET' | MutationMethod,
    url: URL,
    body?: unknown,
    expectedStatus = 200,
  ): Promise<unknown | null> {
    const attempts = method === 'GET' ? MAX_GET_ATTEMPTS : 1;
    const encodedBody = body === undefined ? undefined : canonicalJson(body);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          body: encodedBody,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${createAscJwt(this.#credentials)}`,
            ...(encodedBody === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        if (method !== 'GET' || attempt === attempts) {
          const state = method === 'GET' ? 'failed' : 'is indeterminate';
          throw new Error(
            `Apple ${method} ${state}; rerun preview before any further apply.`,
          );
        }
        await Bun.sleep(attempt * 500);
        continue;
      }
      const rateLimit = response.headers.get('x-rate-limit');
      if (rateLimit === null) {
        this.#rateLimitRemaining = null;
      } else {
        const match =
          /^user-hour-lim:([1-9][0-9]*);user-hour-rem:(0|[1-9][0-9]*);?$/u.exec(
            rateLimit,
          );
        const limit = match === null ? Number.NaN : Number(match[1]);
        const remaining = match === null ? Number.NaN : Number(match[2]);
        if (
          !Number.isSafeInteger(limit) ||
          !Number.isSafeInteger(remaining) ||
          remaining < 0 ||
          remaining > limit
        ) {
          await cancelResponseBody(response);
          throw new Error('Apple returned a malformed rate-limit budget.');
        }
        this.#rateLimitRemaining = remaining;
      }
      if (response.status === expectedStatus) {
        if (expectedStatus === 204) {
          await cancelResponseBody(response);
          return null;
        }
        try {
          return await readBoundedResponseJson(response);
        } catch {
          if (method !== 'GET') {
            throw new Error(
              `Apple ${method} outcome is indeterminate; stop, inspect App Store Connect, and run a new preview.`,
            );
          }
          throw new Error('Apple GET returned an unusable response.');
        }
      }
      if (response.ok && method !== 'GET') {
        await cancelResponseBody(response);
        throw new Error(
          `Apple ${method} outcome is indeterminate; stop, inspect App Store Connect, and run a new preview.`,
        );
      }
      try {
        await readBoundedResponseJson(response);
      } catch {
        // Provider response details are untrusted and never enter diagnostics.
      }
      const retryable =
        method === 'GET' &&
        (response.status === 429 || response.status >= 500) &&
        attempt < attempts;
      if (retryable) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        const delay = Number.isFinite(retryAfter)
          ? Math.min(Math.max(retryAfter * 1000, attempt * 500), 10000)
          : attempt * 500;
        await Bun.sleep(delay);
        continue;
      }
      throw new Error(`Apple ${method} failed with HTTP ${response.status}.`);
    }
    throw new Error('Apple request exhausted its retry limit.');
  }
}
