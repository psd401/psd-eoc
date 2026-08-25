import {
  type AscClient,
  type AscCredentials,
  isRecord,
  type JsonApiPageSummary,
  type JsonApiResource,
  MAX_PAGES,
  MAX_RESOURCES,
  MAX_TESTERS_PER_GROUP,
  type MutationMethod,
  resourceFromUnknown,
} from './asc-model';
import { type AscTransport, AppStoreConnectTransport } from './asc-transport';
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
  readonly #transport: AscTransport;
  constructor(credentials: AscCredentials, transport?: AscTransport) {
    this.#transport = transport ?? new AppStoreConnectTransport(credentials);
  }
  rateLimitRemaining(): number | null {
    return this.#transport.rateLimitRemaining();
  }
  async first(path: string): Promise<JsonApiResource | null> {
    const body = await this.#transport.requestJson(
      'GET',
      this.#transport.validatedUrl(path),
    );
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
    const trustedUrl = this.#transport.validatedUrl(path);
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
      const body = await this.#transport.requestJson('GET', currentUrl);
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
        selfUrl = this.#transport.validatedUrl(
          new URL(selfLink, currentUrl).href,
        );
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
          : this.#transport.validatedContinuationUrl(
              trustedUrl,
              currentUrl,
              candidate,
            );
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
    const url = this.#transport.validatedUrl(path);
    if (
      url.searchParams.getAll('limit').length !== 1 ||
      url.searchParams.get('limit') !== '1' ||
      url.searchParams.has('cursor')
    ) {
      throw new Error('Page-summary reads require an exact one-item limit.');
    }
    return pageSummaryFromUnknown(
      await this.#transport.requestJson('GET', url),
    );
  }
  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    const body = await this.#transport.requestJson(
      'GET',
      this.#transport.validatedUrl(path),
    );
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
      const response = await this.#transport.requestJson(
        method,
        this.#transport.validatedUrl(path),
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
}
