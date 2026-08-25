import { Buffer } from 'node:buffer';
import { createAscJwt } from './asc-auth';
import {
  API_ORIGIN,
  type AscCredentials,
  canonicalJson,
  isOpaquePaginationCursor,
  MAX_GET_ATTEMPTS,
  MAX_RESPONSE_BYTES,
  type MutationMethod,
} from './asc-model';

export interface AscTransport {
  rateLimitRemaining(): number | null;
  requestJson(
    method: 'GET' | MutationMethod,
    url: URL,
    body?: unknown,
    expectedStatus?: number,
  ): Promise<unknown | null>;
  validatedContinuationUrl(
    initialUrl: URL,
    currentUrl: URL,
    candidate: unknown,
  ): URL;
  validatedUrl(pathOrUrl: string): URL;
}
export const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The static size-limit error remains authoritative.
  }
};
export const readBoundedResponseJson = async (
  response: Response,
): Promise<unknown> => {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error('Apple response exceeded its size limit.');
  }
  if (response.body === null)
    throw new Error('Apple returned an empty JSON response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let sizeExceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        sizeExceeded = true;
        try {
          await reader.cancel();
        } catch {
          // The static size-limit error remains authoritative.
        }
        throw new Error('Apple response exceeded its size limit.');
      }
      chunks.push(value);
    }
  } catch {
    if (sizeExceeded) {
      throw new Error('Apple response exceeded its size limit.');
    }
    try {
      await reader.cancel();
    } catch {
      // The static read error remains authoritative.
    }
    throw new Error('Apple response body could not be read.');
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, byteCount),
    );
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Apple returned invalid JSON.');
  }
};

/** Authenticated, fixed-origin App Store Connect HTTP transport. */
export class AppStoreConnectTransport implements AscTransport {
  readonly #credentials: AscCredentials;
  #rateLimitRemaining: number | null = null;

  public constructor(credentials: AscCredentials) {
    this.#credentials = credentials;
  }

  public rateLimitRemaining(): number | null {
    return this.#rateLimitRemaining;
  }

  public validatedUrl(pathOrUrl: string): URL {
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

  public validatedContinuationUrl(
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
    if (!isOpaquePaginationCursor(cursor)) return unsafePagination();
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

  public async requestJson(
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
