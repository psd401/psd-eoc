import { Buffer } from 'node:buffer';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { createHash, sign as signBytes } from 'node:crypto';
import { exit as exitProcess } from 'node:process';
import { isProxy } from 'node:util/types';

const API_ORIGIN = 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = 'net.psd401.eoc';
const APP_NAME = 'PSD EOC';
const APP_SKU = 'PSD-EOC-IOS';
const INTERNAL_GROUP_NAME = 'District Technology';
const EXTERNAL_GROUP_NAME = 'Staff';
const MAX_PAGES = 100;
const MAX_RESOURCES = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_GET_ATTEMPTS = 3;
const MAX_GROUPS = 200;
const MAX_APP_LOCALIZATIONS = 200;
const MAX_APP_BUILDS = 1_000;
const MAX_APP_TESTERS = 10_100;
const MAX_GROUP_BUILDS = 200;
const MAX_TESTERS_PER_GROUP = 10_000;
const MAX_INDIVIDUAL_TESTERS_PER_BUILD = 10_000;
const MAX_TESTER_RELATIONSHIPS = 1_000;
const MAX_APPROVED_TESTERS = 1_200;
const MAX_INTERNAL_TESTERS = 100;
const MAX_TESTER_WRITES_PER_APPLY = 100;
const MAX_TESTER_WRITE_REQUEST_COST_PER_APPLY = 2_500;
const EXTERNAL_CREATE_REQUEST_COST = 55;
const EXTERNAL_LINK_REQUEST_COST = 220;
const INTERNAL_TESTER_WRITE_REQUEST_COST = 265;
const RATE_LIMIT_GROUP_SETUP_RESERVE = 66;
const MAX_APPLY_REQUEST_COST = 2_950;
const MIN_FINAL_AUDIT_REQUEST_RESERVE = 400;
const FILE_READ_CHUNK_BYTES = 64 * 1_024;
const PLAN_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BETA_BUILD_LOCALIZATION_LOCALES = new Set([
  'da',
  'de-DE',
  'el',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-US',
  'es-ES',
  'es-MX',
  'fi',
  'fr-CA',
  'fr-FR',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl-NL',
  'no',
  'pt-BR',
  'pt-PT',
  'ru',
  'sv',
  'th',
  'tr',
  'vi',
  'zh-Hans',
  'zh-Hant',
]);

type JsonObject = Record<string, unknown>;
type MutationMethod = 'PATCH' | 'POST';

export interface JsonApiResource {
  readonly type: string;
  readonly id: string;
  readonly attributes?: Readonly<JsonObject>;
}

export interface JsonApiPageSummary {
  readonly resources: readonly JsonApiResource[];
  readonly total: number;
}

export interface AscClient {
  first(path: string): Promise<JsonApiResource | null>;
  list(path: string): Promise<readonly JsonApiResource[]>;
  pageSummary(path: string): Promise<JsonApiPageSummary>;
  rateLimitRemaining(): number | null;
  get(path: string, expectedType: string): Promise<JsonApiResource>;
  mutate(
    method: MutationMethod,
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null>;
}

export interface Tester {
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
}

export interface BetaReviewInfo {
  readonly contactFirstName: string;
  readonly contactLastName: string;
  readonly contactPhone: string;
  readonly contactEmail: string;
  readonly demoAccountRequired: boolean;
  readonly demoAccountName?: string;
  readonly demoAccountPassword?: string;
  readonly notes?: string;
  readonly locale: string;
  readonly betaDescription: string;
  readonly feedbackEmail: string;
  readonly whatsNew: string;
}

interface SyncOptionsBase {
  readonly internalTesters: readonly Tester[];
  readonly externalTesters: readonly Tester[];
  readonly reviewInfo?: BetaReviewInfo;
  readonly build?: string;
  readonly submitBetaReview: boolean;
}

export type SyncOptions =
  | (SyncOptionsBase & {
      readonly apply: false;
      readonly confirmPlanDigest?: never;
    })
  | (SyncOptionsBase & {
      readonly apply: true;
      readonly confirmPlanDigest: string;
    });

export interface SyncAction {
  readonly kind:
    | 'beta-localization'
    | 'beta-build-localization'
    | 'beta-review-details'
    | 'beta-review-submission'
    | 'build-notification-safety'
    | 'build-distribution'
    | 'group'
    | 'tester'
    | 'verification';
  readonly status: 'applied' | 'deferred' | 'planned' | 'unchanged';
  readonly detail: string;
}

export interface SyncResult {
  readonly mode: 'apply' | 'plan';
  readonly appId: string;
  readonly actions: readonly SyncAction[];
  readonly planDigest: string;
  readonly selectedBuild?: {
    readonly audienceType?: string;
    readonly externalBuildState: string;
    readonly id: string;
    readonly internalBuildState: string;
    readonly platform: 'IOS';
    readonly uploadedDate?: string;
    readonly usesNonExemptEncryption: boolean;
    readonly version?: string;
  };
}

type ReconcileResult = Omit<SyncResult, 'planDigest'>;

interface ReconcileOptions extends SyncOptionsBase {
  readonly apply: boolean;
}

interface AscCredentials {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKey: string;
}

interface CliOptions {
  readonly apply: boolean;
  readonly build?: string;
  readonly confirmApply?: string;
  readonly confirmPlanDigest?: string;
  readonly externalTestersPath?: string;
  readonly internalTestersPath?: string;
  readonly reviewInfoPath?: string;
  readonly submitBetaReview: boolean;
}

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type CanonicalValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const canonicalValue = (
  value: unknown,
  ancestors = new Set<object>(),
): CanonicalValue => {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)) {
    throw new Error('Plan material contained a non-JSON value.');
  }
  if (ancestors.has(value)) {
    throw new Error('Plan material contained a cycle.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error('Plan material contained a non-plain array.');
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        typeof lengthDescriptor.value !== 'number'
      ) {
        throw new Error('Plan material contained a malformed array.');
      }
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol')) {
        throw new Error('Plan material contained a symbol property.');
      }
      const result: CanonicalValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        ) {
          throw new Error(
            'Plan material contained a sparse or accessor array.',
          );
        }
        result.push(canonicalValue(descriptor.value, ancestors));
      }
      if (
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' ||
              !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
              Number(key) >= length),
        )
      ) {
        throw new Error('Plan material contained an extra array property.');
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Plan material contained a non-plain object.');
    }
    const result = Object.create(null) as Record<string, CanonicalValue>;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
      throw new Error('Plan material contained a symbol property.');
    }
    const stringKeys = keys as string[];
    stringKeys.sort();
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        throw new Error(
          'Plan material contained a non-enumerable or accessor property.',
        );
      }
      if (descriptor.value !== undefined) {
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: canonicalValue(descriptor.value, ancestors),
          writable: true,
        });
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
};

const serializeCanonical = (value: CanonicalValue): string => {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    let result = '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) result += ',';
      result += serializeCanonical(value[index] as CanonicalValue);
    }
    return `${result}]`;
  }
  let result = '{';
  const keys = Reflect.ownKeys(value) as string[];
  keys.sort();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error('Canonical plan material was malformed.');
    }
    if (index > 0) result += ',';
    result += `${JSON.stringify(key)}:${serializeCanonical(descriptor.value as CanonicalValue)}`;
  }
  return `${result}}`;
};

const canonicalJson = (value: unknown): string =>
  serializeCanonical(canonicalValue(value));

const deepFreezeCanonical = <Value extends CanonicalValue>(
  value: Value,
): Value => {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      deepFreezeCanonical(value[index] as CanonicalValue);
    }
    return Object.freeze(value) as Value;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) {
        deepFreezeCanonical(descriptor.value as CanonicalValue);
      }
    }
    return Object.freeze(value) as Value;
  }
  return value;
};

const requireString = (
  value: unknown,
  label: string,
  maximumLength = 4_096,
): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
};

const optionalString = (
  value: unknown,
  label: string,
  maximumLength = 4_096,
): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, label, maximumLength);
};

const optionalSecretString = (
  value: unknown,
  label: string,
  maximumLength: number,
): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const isEmail = (value: string): boolean =>
  value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);

const requireOpaqueIdentifier = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9._-]{1,255}$/u.test(value)
  ) {
    throw new Error(`${label} was malformed.`);
  }
  return value;
};

const resourceFromUnknown = (
  value: unknown,
  expectedType?: string,
): JsonApiResource => {
  const canonical = canonicalValue(value);
  if (!isRecord(canonical))
    throw new Error('Apple returned a malformed resource.');
  const type = requireOpaqueIdentifier(canonical.type, 'Apple resource type');
  requireOpaqueIdentifier(canonical.id, 'Apple resource ID');
  if (expectedType !== undefined && type !== expectedType) {
    throw new Error('Apple returned an unexpected resource type.');
  }
  if (canonical.attributes !== undefined && !isRecord(canonical.attributes)) {
    throw new Error('Apple returned malformed resource attributes.');
  }
  return canonical as unknown as JsonApiResource;
};

const EMPTY_JSON_OBJECT = Object.freeze(
  Object.create(null) as JsonObject,
) as Readonly<JsonObject>;

const attributesOf = (resource: JsonApiResource): Readonly<JsonObject> => {
  const descriptor = Object.getOwnPropertyDescriptor(resource, 'attributes');
  if (
    descriptor === undefined ||
    ('value' in descriptor && descriptor.value === undefined)
  ) {
    return EMPTY_JSON_OBJECT;
  }
  if (!('value' in descriptor) || !isRecord(descriptor.value)) {
    throw new Error('Apple returned malformed resource attributes.');
  }
  return descriptor.value;
};

const appendQuery = (
  path: string,
  values: Readonly<Record<string, string>>,
): string => {
  const query = new URLSearchParams(values);
  return `${path}?${query.toString()}`;
};

const isOpaquePaginationCursor = (value: string | undefined): value is string =>
  value !== undefined &&
  value.length > 0 &&
  value.length <= 1_024 &&
  /^[A-Za-z0-9._~-]+$/u.test(value);

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export const createAscJwt = (
  credentials: AscCredentials,
  now = new Date(),
): string => {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 5;
  const expiresAt = issuedAt + 1_195;
  const encodedHeader = base64UrlJson({
    alg: 'ES256',
    kid: credentials.keyId,
    typ: 'JWT',
  });
  const encodedPayload = base64UrlJson({
    aud: 'appstoreconnect-v1',
    exp: expiresAt,
    iat: issuedAt,
    iss: credentials.issuerId,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signBytes('sha256', Buffer.from(signingInput), {
    dsaEncoding: 'ieee-p1363',
    key: credentials.privateKey,
  });
  return `${signingInput}.${signature.toString('base64url')}`;
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The static size-limit error remains authoritative.
  }
};

const readBoundedResponseJson = async (
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
        selfLink.length > 4_096
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
      candidate.length > 4_096
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
          signal: AbortSignal.timeout(30_000),
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
          ? Math.min(Math.max(retryAfter * 1_000, attempt * 500), 10_000)
          : attempt * 500;
        await Bun.sleep(delay);
        continue;
      }
      throw new Error(`Apple ${method} failed with HTTP ${response.status}.`);
    }
    throw new Error('Apple request exhausted its retry limit.');
  }
}

export const parseCsvRows = (input: string): readonly (readonly string[])[] => {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const rows: string[][] = [[]];
  let field = '';
  let state: 'after-quote' | 'quoted' | 'unquoted' = 'unquoted';

  const finishField = (): void => {
    rows.at(-1)?.push(field);
    field = '';
    state = 'unquoted';
  };

  const finishRow = (): void => {
    finishField();
    rows.push([]);
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = 'after-quote';
        }
      } else {
        field += character;
      }
      continue;
    }

    if (state === 'after-quote') {
      if (character === ',') {
        finishField();
        continue;
      }
      if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        finishRow();
        continue;
      }
      throw new Error('Tester CSV contains characters after a closing quote.');
    }

    if (character === '"') {
      if (field.length !== 0) {
        throw new Error(
          'Tester CSV contains a quote inside an unquoted field.',
        );
      }
      state = 'quoted';
    } else if (character === ',') {
      finishField();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      field += character;
    }
  }
  if (state === 'quoted')
    throw new Error('Tester CSV contains an unterminated quote.');
  finishField();

  return rows.filter((row) => row.some((value) => value.trim().length > 0));
};

const normalizeHeader = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]/gu, '');

const findHeader = (
  headers: readonly string[],
  aliases: readonly string[],
  label: string,
): number => {
  const matches: number[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    if (aliases.includes(headers[index] as string)) matches.push(index);
  }
  if (matches.length > 1) {
    throw new Error(`Tester CSV has duplicate ${label} headers.`);
  }
  return matches[0] ?? -1;
};

export const parseTesterCsv = (input: string): readonly Tester[] => {
  const rows = parseCsvRows(input);
  if (rows.length < 2)
    throw new Error('Tester CSV must have a header and data.');
  const headers = (rows[0] ?? []).map(normalizeHeader);
  if (headers.some((header) => header === '')) {
    throw new Error('Tester CSV contains a blank header.');
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error('Tester CSV contains duplicate headers.');
  }
  const emailIndex = findHeader(
    headers,
    ['email', 'emailaddress', 'memberemail', 'memberemailaddress'],
    'email',
  );
  if (emailIndex < 0)
    throw new Error('Tester CSV has no supported email header.');
  const firstNameIndex = findHeader(
    headers,
    ['firstname', 'givenname'],
    'first-name',
  );
  const lastNameIndex = findHeader(
    headers,
    ['lastname', 'familyname', 'surname'],
    'last-name',
  );
  const memberTypeIndex = findHeader(
    headers,
    ['membertype', 'type'],
    'member-type',
  );
  const testers: Tester[] = [];
  const seen = new Set<string>();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    if (row.length !== headers.length) {
      throw new Error(
        `Tester CSV row ${rowIndex + 1} does not match the header width.`,
      );
    }
    if (
      memberTypeIndex >= 0 &&
      row[memberTypeIndex]?.trim().toLocaleUpperCase('en-US') !== 'USER'
    ) {
      throw new Error(
        `Tester CSV row ${rowIndex + 1} is not an explicit USER member.`,
      );
    }
    const rawEmail = row[emailIndex]?.trim() ?? '';
    if (rawEmail === '') {
      throw new Error(`Tester CSV row ${rowIndex + 1} has no user email.`);
    }
    const email = rawEmail.toLocaleLowerCase('en-US');
    if (!isEmail(email))
      throw new Error(`Tester CSV row ${rowIndex + 1} has an invalid email.`);
    if (seen.has(email)) {
      throw new Error(
        `Tester CSV row ${rowIndex + 1} duplicates a tester identity.`,
      );
    }
    seen.add(email);
    const firstName =
      firstNameIndex < 0 ? undefined : row[firstNameIndex]?.trim();
    const lastName = lastNameIndex < 0 ? undefined : row[lastNameIndex]?.trim();
    if ((firstName?.length ?? 0) > 255 || (lastName?.length ?? 0) > 255) {
      throw new Error(`Tester CSV row ${rowIndex + 1} has an overlong name.`);
    }
    testers.push({
      email,
      ...(firstName === undefined || firstName === '' ? {} : { firstName }),
      ...(lastName === undefined || lastName === '' ? {} : { lastName }),
    });
  }
  if (testers.length === 0)
    throw new Error('Tester CSV contains no user email rows.');
  if (testers.length > MAX_APPROVED_TESTERS) {
    throw new Error('Tester CSV exceeds the approved PSD roster limit.');
  }
  return testers;
};

const REVIEW_INFO_FIELDS = new Set([
  'betaDescription',
  'contactEmail',
  'contactFirstName',
  'contactLastName',
  'contactPhone',
  'demoAccountName',
  'demoAccountPassword',
  'demoAccountRequired',
  'feedbackEmail',
  'locale',
  'notes',
  'whatsNew',
]);

const snapshotReviewInput = (input: unknown): JsonObject => {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new Error('Beta-review input must be a JSON object.');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new Error('Beta-review input has an unsupported field.');
  }
  const descriptors: Array<{
    descriptor: PropertyDescriptor;
    key: string;
  }> = [];
  for (const key of keys as string[]) {
    if (!REVIEW_INFO_FIELDS.has(key)) {
      throw new Error('Beta-review input has an unsupported field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      throw new Error('Beta-review input has an unsupported field.');
    }
    descriptors.push({ descriptor, key });
  }
  const snapshot = Object.create(null) as JsonObject;
  for (const { descriptor, key } of descriptors) {
    let value: unknown;
    if ('value' in descriptor) {
      value = descriptor.value;
    } else if (typeof descriptor.get === 'function') {
      value = descriptor.get.call(input) as unknown;
    } else {
      throw new Error('Beta-review input has an unreadable field.');
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return snapshot;
};

export const parseReviewInfo = (input: unknown): BetaReviewInfo => {
  const snapshot = snapshotReviewInput(input);
  const contactEmail = requireString(
    snapshot.contactEmail,
    'contactEmail',
    320,
  );
  const feedbackEmail = requireString(
    snapshot.feedbackEmail,
    'feedbackEmail',
    320,
  );
  if (!isEmail(contactEmail) || !isEmail(feedbackEmail)) {
    throw new Error('Beta-review email fields must be valid email addresses.');
  }
  const demoAccountRequired = snapshot.demoAccountRequired;
  if (typeof demoAccountRequired !== 'boolean') {
    throw new Error('demoAccountRequired must be a boolean.');
  }
  const demoAccountName = optionalString(
    snapshot.demoAccountName,
    'demoAccountName',
    255,
  );
  const demoAccountPassword = optionalSecretString(
    snapshot.demoAccountPassword,
    'demoAccountPassword',
    255,
  );
  if (
    demoAccountRequired &&
    (demoAccountName === undefined || demoAccountPassword === undefined)
  ) {
    throw new Error('A required demo account needs both name and password.');
  }
  if (
    !demoAccountRequired &&
    (demoAccountName !== undefined || demoAccountPassword !== undefined)
  ) {
    throw new Error(
      'Demo account credentials are forbidden when no demo account is required.',
    );
  }
  const notes = optionalString(snapshot.notes, 'notes', 4_000);
  const locale = snapshot.locale === undefined ? 'en-US' : snapshot.locale;
  if (
    typeof locale !== 'string' ||
    !BETA_BUILD_LOCALIZATION_LOCALES.has(locale)
  ) {
    throw new Error(
      'Beta-review locale is not supported by Apple BetaBuildLocalization.',
    );
  }
  return deepFreezeCanonical(
    canonicalValue({
      betaDescription: requireString(
        snapshot.betaDescription,
        'betaDescription',
        4_000,
      ),
      contactEmail,
      contactFirstName: requireString(
        snapshot.contactFirstName,
        'contactFirstName',
        255,
      ),
      contactLastName: requireString(
        snapshot.contactLastName,
        'contactLastName',
        255,
      ),
      contactPhone: requireString(snapshot.contactPhone, 'contactPhone', 50),
      demoAccountRequired,
      feedbackEmail,
      locale,
      whatsNew: requireString(snapshot.whatsNew, 'whatsNew', 4_000),
      ...(demoAccountName === undefined ? {} : { demoAccountName }),
      ...(demoAccountPassword === undefined ? {} : { demoAccountPassword }),
      ...(notes === undefined ? {} : { notes }),
    }),
  ) as unknown as BetaReviewInfo;
};

export const isPathInside = (candidate: string, parent: string): boolean => {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const isNodeErrorWithCode = (
  error: unknown,
): error is Error & { readonly code: string } =>
  error instanceof Error &&
  'code' in error &&
  typeof (error as { readonly code?: unknown }).code === 'string';

const statIfPresent = async (
  path: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> => {
  try {
    return await stat(path);
  } catch (error) {
    if (
      isNodeErrorWithCode(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  }
};

const isInsideGitRepository = async (path: string): Promise<boolean> => {
  const metadata = await stat(path);
  let current = metadata.isDirectory() ? path : dirname(path);
  while (true) {
    if ((await statIfPresent(join(current, '.git'))) !== null) return true;
    const [head, objects, refs] = await Promise.all([
      statIfPresent(join(current, 'HEAD')),
      statIfPresent(join(current, 'objects')),
      statIfPresent(join(current, 'refs')),
    ]);
    if (head?.isFile() && objects?.isDirectory() && refs?.isDirectory()) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

const sameFileMetadata = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

class PrivateFileValidationError extends Error {}

const privateFileValidationError = (message: string): Error =>
  new PrivateFileValidationError(message);

const readValidatedPrivateFile = async (
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  const requestedPath = resolve(path);
  const initialMetadata = await lstat(requestedPath);
  if (
    !initialMetadata.isFile() ||
    initialMetadata.nlink !== 1 ||
    initialMetadata.size > maximumBytes
  ) {
    throw privateFileValidationError(
      `${label} must be a regular file within its size limit.`,
    );
  }
  if (
    initialMetadata.uid !== userInfo().uid ||
    (initialMetadata.mode & 0o077) !== 0
  ) {
    throw privateFileValidationError(`${label} must be an owner-private file.`);
  }
  if (await isInsideGitRepository(requestedPath)) {
    throw privateFileValidationError(
      `${label} must be stored outside every Git repository.`,
    );
  }
  const actualParent = await realpath(dirname(requestedPath));
  if (await isInsideGitRepository(actualParent)) {
    throw privateFileValidationError(
      `${label} must be stored outside every Git repository.`,
    );
  }
  const parentMetadata = await stat(actualParent);
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.uid !== userInfo().uid ||
    (parentMetadata.mode & 0o077) !== 0
  ) {
    throw privateFileValidationError(
      `${label} must be stored in an owner-private directory.`,
    );
  }
  const safePath = join(actualParent, basename(requestedPath));
  const resolvedMetadata = await lstat(safePath);
  if (
    !resolvedMetadata.isFile() ||
    resolvedMetadata.nlink !== 1 ||
    resolvedMetadata.dev !== initialMetadata.dev ||
    resolvedMetadata.ino !== initialMetadata.ino
  ) {
    throw privateFileValidationError(`${label} changed while being opened.`);
  }
  const handle = await open(
    safePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let contents: string | undefined;
  let readError: unknown;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maximumBytes ||
      before.dev !== resolvedMetadata.dev ||
      before.ino !== resolvedMetadata.ino
    ) {
      throw privateFileValidationError(
        `${label} must be a regular file within its size limit.`,
      );
    }
    if (before.uid !== userInfo().uid || (before.mode & 0o077) !== 0) {
      throw privateFileValidationError(
        `${label} must be an owner-private file.`,
      );
    }
    const chunks: Buffer[] = [];
    let totalBytesRead = 0;
    while (totalBytesRead <= maximumBytes) {
      const bytes = Buffer.allocUnsafe(
        Math.min(FILE_READ_CHUNK_BYTES, maximumBytes + 1 - totalBytesRead),
      );
      const result = await handle.read(bytes, 0, bytes.length, totalBytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(bytes.subarray(0, result.bytesRead));
      totalBytesRead += result.bytesRead;
    }
    if (totalBytesRead > maximumBytes) {
      throw privateFileValidationError(
        `${label} exceeded its size limit while being read.`,
      );
    }
    const after = await handle.stat();
    if (!sameFileMetadata(before, after) || totalBytesRead !== after.size) {
      throw privateFileValidationError(`${label} changed while being read.`);
    }
    try {
      contents = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, totalBytesRead),
      );
    } catch {
      throw privateFileValidationError(
        `${label} must contain valid UTF-8 text.`,
      );
    }
  } catch (error) {
    readError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (readError === undefined) readError = error;
  }
  if (readError !== undefined) throw readError;
  if (contents === undefined) {
    throw new Error('Private file read did not complete.');
  }
  return contents;
};

export const readPrivateFile = async (
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  try {
    return await readValidatedPrivateFile(path, maximumBytes, label);
  } catch (error) {
    if (error instanceof PrivateFileValidationError) {
      throw new Error(error.message);
    }
    throw new Error(`${label} could not be read safely.`);
  }
};

export const parseReviewInfoJson = (text: string): BetaReviewInfo => {
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Beta-review input is not valid JSON.');
  }
  return parseReviewInfo(input);
};

const sameSelectedAttributes = (
  current: Readonly<JsonObject>,
  expected: Readonly<JsonObject>,
): boolean =>
  Object.entries(expected).every(([key, value]) => current[key] === value);

const actionStatus = (apply: boolean): 'applied' | 'planned' =>
  apply ? 'applied' : 'planned';

const createGroupBody = (
  appId: string,
  name: string,
  internal: boolean,
): JsonObject => ({
  data: {
    attributes: {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: internal,
      name,
      ...(internal ? {} : { publicLinkEnabled: false }),
    },
    relationships: { app: { data: { id: appId, type: 'apps' } } },
    type: 'betaGroups',
  },
});

interface GroupTarget {
  readonly existedInSnapshot: boolean;
  readonly id: string | null;
  readonly internal: boolean;
  readonly name: string;
}

interface BetaGroupInventoryState {
  current: readonly JsonApiResource[];
}

const appIdentityPath = (): string =>
  appendQuery('/v1/apps', {
    'fields[apps]': 'name,bundleId,sku',
    'filter[bundleId]': BUNDLE_ID,
    limit: '2',
  });

const appGroupsPath = (appId: string): string =>
  appendQuery(`/v1/apps/${encodeURIComponent(appId)}/betaGroups`, {
    'fields[betaGroups]':
      'name,isInternalGroup,hasAccessToAllBuilds,feedbackEnabled,publicLinkEnabled',
    limit: '200',
  });

const groupTestersPath = (groupId: string): string =>
  appendQuery(`/v1/betaGroups/${encodeURIComponent(groupId)}/betaTesters`, {
    'fields[betaTesters]': 'email',
    limit: '200',
  });

const groupBuildsPath = (groupId: string): string =>
  appendQuery(`/v1/betaGroups/${encodeURIComponent(groupId)}/builds`, {
    'fields[builds]': 'version,uploadedDate',
    limit: '200',
  });

const betaLocalizationsPath = (appId: string): string =>
  appendQuery(`/v1/apps/${encodeURIComponent(appId)}/betaAppLocalizations`, {
    limit: '200',
  });

const betaBuildLocalizationsPath = (buildId: string): string =>
  appendQuery(
    `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations`,
    { limit: '200' },
  );

const validateBoundedResourceInventory = (
  resources: readonly JsonApiResource[],
  expectedType: string,
  label: string,
  maximum: number,
): readonly JsonApiResource[] => {
  if (resources.length > maximum) {
    throw new Error(`Apple returned too many ${label} resources.`);
  }
  const verified = resources.map((resource) =>
    resourceFromUnknown(resource, expectedType),
  );
  if (new Set(verified.map(({ id }) => id)).size !== verified.length) {
    throw new Error(`Apple returned duplicate ${label} identities.`);
  }
  return verified;
};

const resourceIds = (
  resources: readonly JsonApiResource[],
): readonly string[] => resources.map(({ id }) => id).sort();

const assertSameResourceIds = (
  related: readonly JsonApiResource[],
  linkage: readonly JsonApiResource[],
  mismatchMessage: string,
): void => {
  if (
    canonicalJson(resourceIds(related)) !== canonicalJson(resourceIds(linkage))
  ) {
    throw new Error(mismatchMessage);
  }
};

const assertExactParent = async (
  client: AscClient,
  path: string,
  expectedType: string,
  expectedId: string,
  mismatchMessage: string,
): Promise<void> => {
  const parent = resourceFromUnknown(
    await client.get(path, expectedType),
    expectedType,
  );
  if (parent.id !== expectedId) throw new Error(mismatchMessage);
};

const assertBetaGroupBelongsToApp = async (
  client: AscClient,
  groupId: string,
  appId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/betaGroups/${encodeURIComponent(groupId)}/app`,
    'apps',
    appId,
    'Beta group does not belong to the exact PSD EOC app.',
  );

const listVerifiedBetaGroupsForApp = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const groups = await client.list(appGroupsPath(appId));
  const verifiedGroups = validateBoundedResourceInventory(
    groups,
    'betaGroups',
    'beta-group',
    MAX_GROUPS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/apps/${encodeURIComponent(appId)}/relationships/betaGroups`,
        { limit: '200' },
      ),
    ),
    'betaGroups',
    'app beta-group relationship',
    MAX_GROUPS,
  );
  assertSameResourceIds(
    verifiedGroups,
    linkage,
    'App beta-group related resources did not match their relationship linkage.',
  );
  return groups;
};

const betaGroupInventoryFingerprint = (
  groups: readonly JsonApiResource[],
): readonly JsonObject[] =>
  groups
    .map((group) => ({
      attributes: attributesOf(group),
      id: group.id,
      type: group.type,
    }))
    .sort((left, right) => {
      const leftIdentity = `${String(left.type)}:${String(left.id)}`;
      const rightIdentity = `${String(right.type)}:${String(right.id)}`;
      return leftIdentity < rightIdentity
        ? -1
        : leftIdentity > rightIdentity
          ? 1
          : 0;
    });

const assertSameBetaGroupInventory = (
  current: readonly JsonApiResource[],
  expected: readonly JsonApiResource[],
  message: string,
): void => {
  if (
    canonicalJson(betaGroupInventoryFingerprint(current)) !==
    canonicalJson(betaGroupInventoryFingerprint(expected))
  ) {
    throw new Error(message);
  }
};

const assertEquivalentBetaGroupInventory = async (
  client: AscClient,
  appId: string,
  expected: readonly JsonApiResource[],
): Promise<readonly JsonApiResource[]> => {
  const current = await listVerifiedBetaGroupsForApp(client, appId);
  assertSameBetaGroupInventory(
    current,
    expected,
    'App beta-group inventory or settings changed after confirmation; no mutations were attempted.',
  );
  return current;
};

const assertBetaAppReviewDetailBelongsToApp = async (
  client: AscClient,
  detailId: string,
  appId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/betaAppReviewDetails/${encodeURIComponent(detailId)}/app`,
    'apps',
    appId,
    'Beta App Review details do not belong to the exact PSD EOC app.',
  );

const assertBetaAppLocalizationBelongsToApp = async (
  client: AscClient,
  localizationId: string,
  appId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/betaAppLocalizations/${encodeURIComponent(localizationId)}/app`,
    'apps',
    appId,
    'Beta app localization does not belong to the exact PSD EOC app.',
  );

const listVerifiedBetaAppLocalizationsForApp = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const localizations = await client.list(betaLocalizationsPath(appId));
  const verifiedLocalizations = validateBoundedResourceInventory(
    localizations,
    'betaAppLocalizations',
    'beta app localization',
    MAX_APP_LOCALIZATIONS,
  );
  for (const verified of verifiedLocalizations) {
    await assertBetaAppLocalizationBelongsToApp(client, verified.id, appId);
  }
  return localizations;
};

const assertBuildBetaDetailBelongsToBuild = async (
  client: AscClient,
  detailId: string,
  buildId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/buildBetaDetails/${encodeURIComponent(detailId)}/build`,
    'builds',
    buildId,
    'Build beta details do not belong to the selected exact build.',
  );

const assertBuildBelongsToApp = async (
  client: AscClient,
  buildId: string,
  appId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/builds/${encodeURIComponent(buildId)}/app`,
    'apps',
    appId,
    'Build does not belong to the exact PSD EOC app.',
  );

const listBetaTesterRelationshipSnapshot = async (
  client: AscClient,
  testerId: string,
  relationship: 'apps' | 'betaGroups' | 'builds',
  expectedType: 'apps' | 'betaGroups' | 'builds',
): Promise<readonly JsonApiResource[]> => {
  const label = `beta tester ${relationship}`;
  const relatedQuery: Record<string, string> = { limit: '200' };
  if (relationship === 'betaGroups') {
    relatedQuery['fields[betaGroups]'] = 'isInternalGroup';
  }
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaTesters/${encodeURIComponent(testerId)}/${relationship}`,
        relatedQuery,
      ),
    ),
    expectedType,
    label,
    MAX_TESTER_RELATIONSHIPS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaTesters/${encodeURIComponent(testerId)}/relationships/${relationship}`,
        { limit: '200' },
      ),
    ),
    expectedType,
    `${label} relationship`,
    MAX_TESTER_RELATIONSHIPS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Beta tester related resources did not match their relationship linkage.',
  );
  return related;
};

const assertCreatedBetaTesterHasExactRelationships = async (
  client: AscClient,
  testerId: string,
  groupId: string,
  appId: string,
  internal: boolean,
): Promise<void> => {
  const groups = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'betaGroups',
    'betaGroups',
  );
  if (
    groups.length !== 1 ||
    groups[0]?.id !== groupId ||
    attributesOf(groups[0]).isInternalGroup !== internal
  ) {
    throw new Error(
      'Apple returned unexpected relationships for the created beta tester.',
    );
  }
  const apps = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'apps',
    'apps',
  );
  if (apps.length !== 1 || apps[0]?.id !== appId) {
    throw new Error(
      'Apple returned unexpected relationships for the created beta tester.',
    );
  }
  const builds = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'builds',
    'builds',
  );
  if (builds.length !== 0) {
    throw new Error(
      'Apple returned unexpected relationships for the created beta tester.',
    );
  }
};

const listGroupTesterSnapshot = async (
  client: AscClient,
  groupId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(groupTestersPath(groupId)),
    'betaTesters',
    'group tester',
    MAX_TESTERS_PER_GROUP,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        { limit: '200' },
      ),
    ),
    'betaTesters',
    'group tester relationship',
    MAX_TESTERS_PER_GROUP,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Group tester relationship linkage did not match its related inventory.',
  );
  return related;
};

const assertGroupTesterRosterTotal = async (
  client: AscClient,
  groupId: string,
  expectedTotal: number,
): Promise<void> => {
  if (
    !Number.isInteger(expectedTotal) ||
    expectedTotal < 0 ||
    expectedTotal > MAX_TESTERS_PER_GROUP
  ) {
    throw new Error('Projected managed-group tester total is unsafe.');
  }
  const related = await client.pageSummary(
    appendQuery(`/v1/betaGroups/${encodeURIComponent(groupId)}/betaTesters`, {
      'fields[betaTesters]': 'email',
      limit: '1',
    }),
  );
  const linkage = await client.pageSummary(
    appendQuery(
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
      { limit: '1' },
    ),
  );
  const relatedResources = validateBoundedResourceInventory(
    related.resources,
    'betaTesters',
    'group tester page-summary',
    1,
  );
  const linkageResources = validateBoundedResourceInventory(
    linkage.resources,
    'betaTesters',
    'group tester relationship page-summary',
    1,
  );
  for (const tester of relatedResources) testerEmail(tester);
  if (
    relatedResources.length !== Math.min(related.total, 1) ||
    linkageResources.length !== Math.min(linkage.total, 1) ||
    related.total !== linkage.total ||
    related.total !== expectedTotal
  ) {
    throw new Error(
      'Managed group tester total changed around the risky write.',
    );
  }
};

const listVerifiedGroupTesters = async (
  client: AscClient,
  groupId: string,
): Promise<readonly JsonApiResource[]> =>
  listGroupTesterSnapshot(client, groupId);

const listVerifiedAppTesters = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const testers = validateBoundedResourceInventory(
    await client.list(
      appendQuery('/v1/betaTesters', {
        'fields[betaTesters]': 'email',
        'filter[apps]': appId,
        limit: '200',
      }),
    ),
    'betaTesters',
    'app tester',
    MAX_APP_TESTERS,
  );
  return testers;
};

const listVerifiedIndividualBuildTesters = async (
  client: AscClient,
  buildId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/builds/${encodeURIComponent(buildId)}/individualTesters`,
        { 'fields[betaTesters]': 'email', limit: '200' },
      ),
    ),
    'betaTesters',
    'individual build tester',
    MAX_INDIVIDUAL_TESTERS_PER_BUILD,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/builds/${encodeURIComponent(buildId)}/relationships/individualTesters`,
        { limit: '200' },
      ),
    ),
    'betaTesters',
    'individual build tester relationship',
    MAX_INDIVIDUAL_TESTERS_PER_BUILD,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Individual build tester relationship linkage did not match its related inventory.',
  );
  return related;
};

const listVerifiedAppBuilds = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(`/v1/apps/${encodeURIComponent(appId)}/builds`, {
        'fields[builds]': 'version',
        limit: '200',
      }),
    ),
    'builds',
    'app build',
    MAX_APP_BUILDS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/apps/${encodeURIComponent(appId)}/relationships/builds`,
        { limit: '200' },
      ),
    ),
    'builds',
    'app build relationship',
    MAX_APP_BUILDS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'App build related resources did not match their relationship linkage.',
  );
  return related;
};

const listGroupBuildSnapshot = async (
  client: AscClient,
  groupId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(groupBuildsPath(groupId)),
    'builds',
    'group build',
    MAX_GROUP_BUILDS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
        { limit: '200' },
      ),
    ),
    'builds',
    'group build relationship',
    MAX_GROUP_BUILDS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Group build relationship linkage did not match its related inventory.',
  );
  return related;
};

const listVerifiedGroupBuilds = async (
  client: AscClient,
  appId: string,
  groupId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = await listGroupBuildSnapshot(client, groupId);
  for (const build of related) {
    await assertBuildBelongsToApp(client, build.id, appId);
  }
  return related;
};

const readExactBetaTester = async (
  client: AscClient,
  testerId: string,
  expectedEmail: string,
): Promise<JsonApiResource> => {
  const tester = resourceFromUnknown(
    await client.get(
      appendQuery(`/v1/betaTesters/${encodeURIComponent(testerId)}`, {
        'fields[betaTesters]': 'email',
      }),
      'betaTesters',
    ),
    'betaTesters',
  );
  if (tester.id !== testerId || testerEmail(tester) !== expectedEmail) {
    throw new Error('Apple returned an unexpected exact beta tester identity.');
  }
  return tester;
};

const assertPreReleaseVersionScope = async (
  client: AscClient,
  preReleaseVersionId: string,
  appId: string,
  buildId: string,
): Promise<void> => {
  await assertExactParent(
    client,
    `/v1/preReleaseVersions/${encodeURIComponent(preReleaseVersionId)}/app`,
    'apps',
    appId,
    'Pre-release version does not belong to the exact PSD EOC app.',
  );
  const verifiedBuilds = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/preReleaseVersions/${encodeURIComponent(preReleaseVersionId)}/builds`,
        { limit: '200' },
      ),
    ),
    'builds',
    'pre-release version build',
    MAX_APP_BUILDS,
  );
  if (verifiedBuilds.filter(({ id }) => id === buildId).length !== 1) {
    throw new Error(
      'The selected build is not in the exact pre-release version inventory.',
    );
  }
};

const hasSafeGroupSettings = (
  group: JsonApiResource,
  name: string,
  internal: boolean,
): boolean => {
  const attributes = attributesOf(group);
  return (
    group.type === 'betaGroups' &&
    attributes.name === name &&
    attributes.isInternalGroup === internal &&
    attributes.hasAccessToAllBuilds === false &&
    attributes.feedbackEnabled === true &&
    (internal || attributes.publicLinkEnabled === false)
  );
};

const isManagedGroupIdentity = (group: JsonApiResource): boolean => {
  const attributes = attributesOf(group);
  return (
    (attributes.name === INTERNAL_GROUP_NAME &&
      attributes.isInternalGroup === true) ||
    (attributes.name === EXTERNAL_GROUP_NAME &&
      attributes.isInternalGroup === false)
  );
};

const hasExactManagedGroupInventory = (
  groups: readonly JsonApiResource[],
): boolean =>
  groups.length === 2 &&
  groups.filter((group) =>
    hasSafeGroupSettings(group, INTERNAL_GROUP_NAME, true),
  ).length === 1 &&
  groups.filter((group) =>
    hasSafeGroupSettings(group, EXTERNAL_GROUP_NAME, false),
  ).length === 1;

const verifyCreatedGroupBeforeUse = async (
  client: AscClient,
  appId: string,
  createdId: string,
  name: string,
  internal: boolean,
  expectedBefore: readonly JsonApiResource[],
): Promise<readonly JsonApiResource[]> => {
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  if (
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups')
  ) {
    throw new Error('Apple returned an unsafe beta-group inventory.');
  }
  const named = groups.filter((group) => attributesOf(group).name === name);
  if (
    named.length !== 1 ||
    named[0]?.id !== createdId ||
    !hasSafeGroupSettings(named[0], name, internal)
  ) {
    throw new Error(
      'Apple did not verify the created group in the expected app scope.',
    );
  }
  assertSameBetaGroupInventory(
    groups.filter(({ id }) => id !== createdId),
    expectedBefore,
    'App beta-group inventory changed during group creation; mutation outcome is indeterminate.',
  );
  await assertBetaGroupBelongsToApp(client, createdId, appId);
  const testers = await listVerifiedGroupTesters(client, createdId);
  const builds = await listVerifiedGroupBuilds(client, appId, createdId);
  if (
    testers.length !== 0 ||
    builds.length !== 0 ||
    testers.some(({ type }) => type !== 'betaTesters') ||
    builds.some(({ type }) => type !== 'builds')
  ) {
    throw new Error(
      'Apple returned a nonempty created group; refusing follow-on writes.',
    );
  }
  return groups;
};

const ensureGroup = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  groups: readonly JsonApiResource[],
  groupInventoryState: BetaGroupInventoryState,
  rateBudget: ApplyRateBudget | undefined,
  name: string,
  internal: boolean,
  apply: boolean,
  actions: SyncAction[],
): Promise<GroupTarget> => {
  const rateStage: ApplyRateStage = internal
    ? 'group-internal'
    : 'group-external';
  const named = groups.filter(
    (group) => group.type === 'betaGroups' && attributesOf(group).name === name,
  );
  if (named.length > 1)
    throw new Error(`Apple has duplicate ${name} beta groups.`);
  const existing = named[0];
  if (existing === undefined) {
    actions.push({
      detail: `Create ${internal ? 'internal' : 'external'} group ${name}.`,
      kind: 'group',
      status: actionStatus(apply),
    });
    if (!apply) {
      return { existedInSnapshot: false, id: null, internal, name };
    }
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its live assertion client.');
    }
    rateBudget.assertStageStart(assertionClient, rateStage);
    groupInventoryState.current = await assertEquivalentBetaGroupInventory(
      assertionClient,
      appId,
      groupInventoryState.current,
    );
    const expectedBefore = groupInventoryState.current;
    await assertExactAppIdentity(assertionClient, appId);
    rateBudget.assertBeforeMutation(assertionClient, rateStage);
    const created = await client.mutate(
      'POST',
      '/v1/betaGroups',
      createGroupBody(appId, name, internal),
      'betaGroups',
    );
    if (created === null)
      throw new Error('Apple did not return the created group.');
    const createdGroup = resourceFromUnknown(created, 'betaGroups');
    groupInventoryState.current = await verifyCreatedGroupBeforeUse(
      assertionClient,
      appId,
      createdGroup.id,
      name,
      internal,
      expectedBefore,
    );
    rateBudget.complete(rateStage);
    return {
      existedInSnapshot: false,
      id: createdGroup.id,
      internal,
      name,
    };
  }
  if (attributesOf(existing).isInternalGroup !== internal) {
    throw new Error(`${name} exists with the wrong TestFlight group type.`);
  }
  if (attributesOf(existing).hasAccessToAllBuilds !== false) {
    throw new Error(
      `${name} must explicitly use manual build assignment; no changes were made.`,
    );
  }
  const mutableDesired: JsonObject = {
    feedbackEnabled: true,
    ...(internal ? {} : { publicLinkEnabled: false }),
  };
  if (sameSelectedAttributes(attributesOf(existing), mutableDesired)) {
    actions.push({
      detail: `${name} group already matches.`,
      kind: 'group',
      status: 'unchanged',
    });
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete(rateStage);
    }
    return {
      existedInSnapshot: true,
      id: existing.id,
      internal,
      name,
    };
  }
  actions.push({
    detail: `Make ${name} private after verifying manual build assignment.`,
    kind: 'group',
    status: actionStatus(apply),
  });
  if (apply) {
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its live assertion client.');
    }
    rateBudget.assertStageStart(assertionClient, rateStage);
    groupInventoryState.current = await assertEquivalentBetaGroupInventory(
      assertionClient,
      appId,
      groupInventoryState.current,
    );
    const expectedBefore = groupInventoryState.current;
    await assertBetaGroupBelongsToApp(assertionClient, existing.id, appId);
    await assertExactAppIdentity(assertionClient, appId);
    rateBudget.assertBeforeMutation(assertionClient, rateStage);
    const updated = await client.mutate(
      'PATCH',
      `/v1/betaGroups/${encodeURIComponent(existing.id)}`,
      {
        data: {
          attributes: mutableDesired,
          id: existing.id,
          type: 'betaGroups',
        },
      },
      'betaGroups',
    );
    if (updated === null || updated.id !== existing.id) {
      throw new Error('Apple did not return the updated beta group.');
    }
    await assertBetaGroupBelongsToApp(assertionClient, updated.id, appId);
    const currentAfter = await listVerifiedBetaGroupsForApp(
      assertionClient,
      appId,
    );
    const updatedMatches = currentAfter.filter(({ id }) => id === existing.id);
    if (
      updatedMatches.length !== 1 ||
      !hasSafeGroupSettings(
        updatedMatches[0] as JsonApiResource,
        name,
        internal,
      )
    ) {
      throw new Error(
        'Apple did not verify the updated beta group; mutation outcome is indeterminate.',
      );
    }
    assertSameBetaGroupInventory(
      currentAfter.filter(({ id }) => id !== existing.id),
      expectedBefore.filter(({ id }) => id !== existing.id),
      'App beta-group inventory changed during group update; mutation outcome is indeterminate.',
    );
    groupInventoryState.current = currentAfter;
    rateBudget.complete(rateStage);
  }
  return {
    existedInSnapshot: true,
    id: existing.id,
    internal,
    name,
  };
};

const testerEmail = (resource: JsonApiResource): string => {
  if (resource.type !== 'betaTesters') {
    throw new Error('Apple returned an unexpected tester resource.');
  }
  const value = attributesOf(resource).email;
  if (typeof value !== 'string' || !isEmail(value)) {
    throw new Error('Apple returned a tester without a valid email identity.');
  }
  return value.toLocaleLowerCase('en-US');
};

const ACCOUNT_USERS_PATH = appendQuery('/v1/users', {
  'fields[users]': 'username,roles,allAppsVisible',
  limit: '200',
});

const ACCOUNT_BETA_TESTERS_PATH = appendQuery('/v1/betaTesters', {
  'fields[betaTesters]': 'email',
  limit: '200',
});

const ELIGIBLE_INTERNAL_USER_ROLES = new Set([
  'ACCOUNT_HOLDER',
  'ADMIN',
  'APP_MANAGER',
  'DEVELOPER',
  'MARKETING',
]);

const accountUserAccess = (
  user: JsonApiResource,
): {
  readonly allAppsVisible: boolean;
  readonly roles: readonly string[];
  readonly username: string;
} => {
  const attributes = attributesOf(user);
  const username = attributes.username;
  const roles = attributes.roles;
  const allAppsVisible = attributes.allAppsVisible;
  if (
    user.type !== 'users' ||
    typeof username !== 'string' ||
    !isEmail(username) ||
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some(
      (role) =>
        typeof role !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/u.test(role),
    ) ||
    new Set(roles).size !== roles.length ||
    typeof allAppsVisible !== 'boolean'
  ) {
    throw new Error('Apple returned malformed account-user access data.');
  }
  return {
    allAppsVisible,
    roles: roles as readonly string[],
    username: username.toLocaleLowerCase('en-US'),
  };
};

const listVerifiedVisibleAppsForUser = async (
  client: AscClient,
  userId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(`/v1/users/${encodeURIComponent(userId)}/visibleApps`, {
        limit: '200',
      }),
    ),
    'apps',
    'visible app',
    MAX_TESTER_RELATIONSHIPS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/users/${encodeURIComponent(userId)}/relationships/visibleApps`,
        { limit: '200' },
      ),
    ),
    'apps',
    'visible app relationship',
    MAX_TESTER_RELATIONSHIPS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'User visible-app relationship linkage did not match its related inventory.',
  );
  return related;
};

const readExactAccountUser = async (
  client: AscClient,
  userId: string,
  expectedUsername: string,
): Promise<JsonApiResource> => {
  const user = resourceFromUnknown(
    await client.get(
      appendQuery(`/v1/users/${encodeURIComponent(userId)}`, {
        'fields[users]': 'username,roles,allAppsVisible',
      }),
      'users',
    ),
    'users',
  );
  if (
    user.id !== userId ||
    accountUserAccess(user).username !== expectedUsername
  ) {
    throw new Error(
      'Apple returned an unexpected exact account-user identity.',
    );
  }
  return user;
};

const collectEligibleInternalTesterUsers = async (
  client: AscClient,
  desired: readonly Tester[],
): Promise<ReadonlyMap<string, JsonApiResource>> => {
  if (desired.length === 0) return new Map<string, JsonApiResource>();
  const users = validateBoundedResourceInventory(
    await client.list(ACCOUNT_USERS_PATH),
    'users',
    'account user',
    MAX_RESOURCES,
  );
  const desiredEmails = new Set(desired.map(({ email }) => email));
  const eligible = new Map<string, JsonApiResource>();
  const seenUsernames = new Set<string>();
  for (const user of users) {
    const access = accountUserAccess(user);
    if (seenUsernames.has(access.username)) {
      throw new Error('Apple returned duplicate account-user identities.');
    }
    seenUsernames.add(access.username);
    if (
      desiredEmails.has(access.username) &&
      access.roles.some((role) => ELIGIBLE_INTERNAL_USER_ROLES.has(role))
    ) {
      eligible.set(access.username, user);
    }
  }
  const missingCount = desired.filter(
    ({ email }) => !eligible.has(email),
  ).length;
  if (missingCount > 0) {
    throw new Error(
      `${missingCount} internal tester(s) are not eligible App Store Connect users; no changes were made.`,
    );
  }
  return eligible;
};

const assertExactInternalTesterEligibility = async (
  client: AscClient,
  appId: string,
  tester: Tester,
  candidate: JsonApiResource | undefined,
): Promise<number> => {
  if (candidate === undefined) {
    throw new Error(
      'An internal tester is no longer an eligible App Store Connect user; no changes were made.',
    );
  }
  const user = await readExactAccountUser(client, candidate.id, tester.email);
  const access = accountUserAccess(user);
  if (!access.roles.some((role) => ELIGIBLE_INTERNAL_USER_ROLES.has(role))) {
    throw new Error(
      'An internal tester is no longer an eligible App Store Connect user; no changes were made.',
    );
  }
  if (!access.allAppsVisible) {
    const visibleApps = await listVerifiedVisibleAppsForUser(client, user.id);
    if (!visibleApps.some(({ id }) => id === appId)) {
      throw new Error(
        'An internal tester lacks access to the PSD EOC app; no changes were made.',
      );
    }
    return 1 + 2 * Math.max(1, Math.ceil(visibleApps.length / 200));
  }
  return 1;
};

const assertEligibleInternalTesters = async (
  client: AscClient,
  appId: string,
  desired: readonly Tester[],
): Promise<void> => {
  const eligible = await collectEligibleInternalTesterUsers(client, desired);
  for (const tester of desired) {
    await assertExactInternalTesterEligibility(
      client,
      appId,
      tester,
      eligible.get(tester.email),
    );
  }
};

const preflightInternalTesters = async (
  client: AscClient,
  appId: string,
  desired: readonly Tester[],
  actions: SyncAction[],
): Promise<void> => {
  if (desired.length === 0) return;
  await assertEligibleInternalTesters(client, appId, desired);
  actions.push({
    detail: `${desired.length} internal tester(s) are eligible App Store Connect users.`,
    kind: 'tester',
    status: 'unchanged',
  });
};

type TesterAudience = 'external' | 'internal';

interface AppWideTesterInventory {
  readonly appTesters: readonly {
    readonly audience: TesterAudience;
    readonly email?: string;
    readonly id: string;
  }[];
  readonly buildIds: readonly string[];
  readonly groupMemberships: readonly {
    readonly audience: TesterAudience;
    readonly email?: string;
    readonly groupId: string;
    readonly id: string;
  }[];
  readonly individualTesters: readonly {
    readonly audience: TesterAudience;
    readonly buildId: string;
    readonly email: string;
    readonly id: string;
  }[];
}

const sortByCanonicalJson = <Value>(values: readonly Value[]): Value[] =>
  [...values].sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });

const canonicalAppWideTesterInventory = (
  inventory: AppWideTesterInventory,
): AppWideTesterInventory =>
  deepFreezeCanonical(
    canonicalValue({
      appTesters: sortByCanonicalJson(inventory.appTesters),
      buildIds: [...inventory.buildIds].sort(),
      groupMemberships: sortByCanonicalJson(inventory.groupMemberships),
      individualTesters: sortByCanonicalJson(inventory.individualTesters),
    }),
  ) as unknown as AppWideTesterInventory;

const inventoryAppTesterCapacity = async (
  client: AscClient,
  appId: string,
  groups: readonly JsonApiResource[],
  internalDesired: readonly Tester[],
  externalDesired: readonly Tester[],
): Promise<AppWideTesterInventory> => {
  const groupIds = new Set<string>();
  const idToEmail = new Map<string, string>();
  const emailToId = new Map<string, string>();
  const memberships: Array<{
    audience: TesterAudience;
    email?: string;
    groupId: string;
    id: string;
  }> = [];
  const membershipsById = new Map<
    string,
    Array<{ audience: TesterAudience; email?: string; groupId: string }>
  >();

  const captureTester = (
    tester: JsonApiResource,
    label: string,
    requireEmail: boolean,
  ): { email?: string; id: string } => {
    if (tester.type !== 'betaTesters') {
      throw new Error(`Apple returned an unexpected ${label} resource.`);
    }
    const rawEmail = attributesOf(tester).email;
    let email: string | undefined;
    if (rawEmail === undefined || rawEmail === null) {
      if (requireEmail) {
        throw new Error(
          `Apple returned an ${label} without an email identity.`,
        );
      }
    } else if (typeof rawEmail !== 'string' || !isEmail(rawEmail)) {
      throw new Error(`Apple returned an ${label} with an invalid identity.`);
    } else {
      email = rawEmail.toLocaleLowerCase('en-US');
    }
    const priorEmail = idToEmail.get(tester.id);
    const priorId = email === undefined ? undefined : emailToId.get(email);
    if (
      (priorEmail !== undefined &&
        email !== undefined &&
        priorEmail !== email) ||
      (priorId !== undefined && priorId !== tester.id)
    ) {
      throw new Error(
        'Apple returned conflicting beta tester IDs or email identities.',
      );
    }
    if (email !== undefined) {
      idToEmail.set(tester.id, email);
      emailToId.set(email, tester.id);
    }
    return { ...(email === undefined ? {} : { email }), id: tester.id };
  };

  for (const group of groups) {
    if (group.type !== 'betaGroups') {
      throw new Error('Apple returned a non-group in the beta-group list.');
    }
    if (groupIds.has(group.id)) {
      throw new Error('Apple returned duplicate beta-group IDs.');
    }
    groupIds.add(group.id);
    const groupIsInternal = attributesOf(group).isInternalGroup;
    if (typeof groupIsInternal !== 'boolean') {
      throw new Error('Apple returned a beta group without an audience type.');
    }
    const audience: TesterAudience = groupIsInternal ? 'internal' : 'external';
    const seenInGroup = new Set<string>();
    const testers = await listVerifiedGroupTesters(client, group.id);
    for (const tester of testers) {
      const identity = captureTester(tester, 'tester', false);
      if (seenInGroup.has(identity.id)) {
        throw new Error('Apple returned a duplicate tester in a beta group.');
      }
      seenInGroup.add(identity.id);
      memberships.push({
        audience,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        groupId: group.id,
        id: identity.id,
      });
      if (memberships.length > MAX_RESOURCES) {
        throw new Error(
          'Apple returned more app tester memberships than the safety limit.',
        );
      }
      const existing = membershipsById.get(identity.id) ?? [];
      existing.push({
        audience,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        groupId: group.id,
      });
      membershipsById.set(identity.id, existing);
    }
  }

  const requireConsistentAudience = (
    identity: { email?: string; id: string },
    label: string,
  ): TesterAudience => {
    const matching = membershipsById.get(identity.id) ?? [];
    const audience = matching[0]?.audience;
    if (
      audience === undefined ||
      matching.some((membership) => membership.audience !== audience) ||
      (identity.email !== undefined &&
        matching.some(
          (membership) =>
            membership.email !== undefined &&
            membership.email !== identity.email,
        ))
    ) {
      throw new Error(
        `Apple returned an ${label} that is not classifiable through one consistent typed app beta-group audience.`,
      );
    }
    return audience;
  };

  const rawAppTesters = await listVerifiedAppTesters(client, appId);
  const seenAppTesterIds = new Set<string>();
  const appTesters: Array<{
    audience: TesterAudience;
    email?: string;
    id: string;
  }> = [];
  for (const tester of rawAppTesters) {
    const identity = captureTester(tester, 'app tester', false);
    if (seenAppTesterIds.has(identity.id)) {
      throw new Error('Apple returned a duplicate app tester.');
    }
    seenAppTesterIds.add(identity.id);
    appTesters.push({
      ...identity,
      audience: requireConsistentAudience(identity, 'app tester'),
    });
    if (appTesters.length > MAX_RESOURCES) {
      throw new Error('Apple returned more app testers than the safety limit.');
    }
  }
  for (const testerId of membershipsById.keys()) {
    if (!seenAppTesterIds.has(testerId)) {
      throw new Error(
        'Apple app tester inventory omitted a typed beta-group member.',
      );
    }
  }

  const builds = await listVerifiedAppBuilds(client, appId);
  const buildIds = new Set<string>();
  const individualTesters: Array<{
    audience: TesterAudience;
    buildId: string;
    email: string;
    id: string;
  }> = [];
  for (const build of builds) {
    if (build.type !== 'builds') {
      throw new Error('Apple returned a non-build in the app build inventory.');
    }
    if (buildIds.has(build.id)) {
      throw new Error('Apple returned duplicate app build IDs.');
    }
    buildIds.add(build.id);
    const individuals = await listVerifiedIndividualBuildTesters(
      client,
      build.id,
    );
    const seenInBuild = new Set<string>();
    for (const tester of individuals) {
      const identity = captureTester(
        tester,
        'individual build tester',
        true,
      ) as { email: string; id: string };
      if (seenInBuild.has(identity.id)) {
        throw new Error('Apple returned a duplicate individual build tester.');
      }
      seenInBuild.add(identity.id);
      individualTesters.push({
        ...identity,
        audience: requireConsistentAudience(
          identity,
          'individual build tester',
        ),
        buildId: build.id,
      });
      if (individualTesters.length > MAX_RESOURCES) {
        throw new Error(
          'Apple returned more individual build assignments than the safety limit.',
        );
      }
    }
  }

  for (const id of membershipsById.keys()) {
    requireConsistentAudience(
      {
        id,
        ...(idToEmail.has(id) ? { email: idToEmail.get(id) as string } : {}),
      },
      'beta tester',
    );
  }

  const audienceByEmail = new Map<string, TesterAudience>();
  const idsByAudience: Record<TesterAudience, Set<string>> = {
    external: new Set<string>(),
    internal: new Set<string>(),
  };
  for (const membership of memberships) {
    const email = idToEmail.get(membership.id) ?? membership.email;
    if (email !== undefined) audienceByEmail.set(email, membership.audience);
    idsByAudience[membership.audience].add(membership.id);
  }
  const desiredByAudience: Readonly<Record<TesterAudience, readonly Tester[]>> =
    { external: externalDesired, internal: internalDesired };
  const maximumByAudience: Readonly<Record<TesterAudience, number>> = {
    external: 10_000,
    internal: 100,
  };
  for (const audience of ['internal', 'external'] as const) {
    const opposite: TesterAudience =
      audience === 'internal' ? 'external' : 'internal';
    let additions = 0;
    for (const tester of desiredByAudience[audience]) {
      const currentAudience = audienceByEmail.get(tester.email);
      if (currentAudience === opposite) {
        throw new Error(
          `A desired ${audience} tester already belongs to the opposite app audience; no changes were made.`,
        );
      }
      if (currentAudience === undefined) additions += 1;
    }
    const maximum = maximumByAudience[audience];
    if (idsByAudience[audience].size + additions > maximum) {
      throw new Error(
        `App-wide ${audience} membership plus proposed additions exceeds Apple's ${maximum.toLocaleString('en-US')}-tester limit; no changes were made.`,
      );
    }
  }

  return canonicalAppWideTesterInventory({
    appTesters,
    buildIds: [...buildIds],
    groupMemberships: memberships,
    individualTesters,
  });
};

class TesterIdentityAudienceRegistry {
  readonly #byId = new Map<
    string,
    { audience: TesterAudience; email?: string }
  >();
  readonly #idByEmail = new Map<string, string>();

  constructor(inventory: AppWideTesterInventory) {
    for (const membership of inventory.groupMemberships) {
      this.#register(membership.id, membership.email, membership.audience);
    }
    for (const tester of inventory.appTesters) {
      this.#register(tester.id, tester.email, tester.audience);
    }
    for (const tester of inventory.individualTesters) {
      this.#register(tester.id, tester.email, tester.audience);
    }
  }

  registerResolvedTester(
    tester: JsonApiResource,
    audience: TesterAudience,
    approvedEmails?: ReadonlySet<string>,
  ): string {
    const email = this.validateResolvedTesterIdentity(tester);
    if (approvedEmails !== undefined && !approvedEmails.has(email)) {
      throw new Error(
        'Apple returned a beta tester outside the approved local roster.',
      );
    }
    this.#register(tester.id, email, audience);
    return email;
  }

  validateResolvedTesterIdentity(tester: JsonApiResource): string {
    const email = testerEmail(tester);
    const existing = this.#byId.get(tester.id);
    const existingId = this.#idByEmail.get(email);
    if (
      (existing?.email !== undefined && existing.email !== email) ||
      (existingId !== undefined && existingId !== tester.id)
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    return email;
  }

  registerCreatedTester(
    tester: JsonApiResource,
    audience: TesterAudience,
  ): string {
    const email = testerEmail(tester);
    if (this.#byId.has(tester.id) || this.#idByEmail.has(email)) {
      throw new Error(
        'Apple returned a reused beta tester identity after creation.',
      );
    }
    this.#register(tester.id, email, audience);
    return email;
  }

  #register(
    id: string,
    email: string | undefined,
    audience: TesterAudience,
  ): void {
    const existing = this.#byId.get(id);
    const existingId =
      email === undefined ? undefined : this.#idByEmail.get(email);
    if (
      (existing !== undefined && existing.audience !== audience) ||
      (existing?.email !== undefined &&
        email !== undefined &&
        existing.email !== email) ||
      (existingId !== undefined && existingId !== id)
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    const knownEmail = existing?.email ?? email;
    this.#byId.set(id, {
      audience,
      ...(knownEmail === undefined ? {} : { email: knownEmail }),
    });
    if (knownEmail !== undefined) this.#idByEmail.set(knownEmail, id);
  }
}

const collectAccountBetaTesters = async (
  client: AscClient,
  identityRegistry: TesterIdentityAudienceRegistry,
  needed: boolean,
): Promise<ReadonlyMap<string, JsonApiResource>> => {
  if (!needed) return new Map<string, JsonApiResource>();
  const accountTesters = await client.list(ACCOUNT_BETA_TESTERS_PATH);
  if (accountTesters.length > MAX_RESOURCES) {
    throw new Error(
      'Apple returned more account beta testers than the safety limit.',
    );
  }
  const accountTesterByEmail = new Map<string, JsonApiResource>();
  const emailById = new Map<string, string>();
  for (const resource of accountTesters) {
    const email = identityRegistry.validateResolvedTesterIdentity(resource);
    const priorEmail = emailById.get(resource.id);
    if (accountTesterByEmail.has(email) || priorEmail !== undefined) {
      throw new Error(
        'Apple returned duplicate account beta tester identities.',
      );
    }
    accountTesterByEmail.set(email, resource);
    emailById.set(resource.id, email);
  }
  return accountTesterByEmail;
};

interface AppWideTesterInventoryState {
  current: AppWideTesterInventory;
}

interface TesterRelationshipSnapshot {
  readonly apps: readonly JsonApiResource[];
  readonly builds: readonly JsonApiResource[];
  readonly groups: readonly JsonApiResource[];
}

const evolveAppWideTesterInventory = (
  current: AppWideTesterInventory,
  target: GroupTarget,
  testers: readonly JsonApiResource[],
): AppWideTesterInventory => {
  if (target.id === null) {
    throw new Error('Apply has no verified beta-group ID.');
  }
  const audience: TesterAudience = target.internal ? 'internal' : 'external';
  const appTesters = [...current.appTesters];
  const groupMemberships = [...current.groupMemberships];
  for (const tester of testers) {
    const email = testerEmail(tester);
    const appIndex = appTesters.findIndex(({ id }) => id === tester.id);
    const existingAppTester = appTesters[appIndex];
    if (
      existingAppTester !== undefined &&
      (existingAppTester.audience !== audience ||
        (existingAppTester.email !== undefined &&
          existingAppTester.email !== email))
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    const nextAppTester = { audience, email, id: tester.id } as const;
    if (appIndex < 0) appTesters.push(nextAppTester);
    else appTesters.splice(appIndex, 1, nextAppTester);

    const membership = groupMemberships.find(
      ({ groupId, id }) => groupId === target.id && id === tester.id,
    );
    if (
      membership !== undefined &&
      (membership.audience !== audience ||
        (membership.email !== undefined && membership.email !== email))
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    if (membership === undefined) {
      groupMemberships.push({
        audience,
        email,
        groupId: target.id,
        id: tester.id,
      });
    }
  }
  return canonicalAppWideTesterInventory({
    appTesters,
    buildIds: current.buildIds,
    groupMemberships,
    individualTesters: current.individualTesters,
  });
};

const assertCurrentTesterAppAudienceSafety = async (
  client: AscClient,
  appId: string,
  testerId: string,
  audience: TesterAudience,
  expected: AppWideTesterInventory,
): Promise<TesterRelationshipSnapshot> => {
  const expectedMemberships = expected.groupMemberships.filter(
    ({ id }) => id === testerId,
  );
  if (
    expectedMemberships.some((membership) => membership.audience !== audience)
  ) {
    throw new Error(
      'A beta tester belongs to the opposite app audience; no changes were made.',
    );
  }
  const expectedGroupIds = new Set(
    expectedMemberships.map(({ groupId }) => groupId),
  );
  const expectedAppTester = expected.appTesters.find(
    ({ id }) => id === testerId,
  );
  if (
    expectedAppTester !== undefined &&
    expectedAppTester.audience !== audience
  ) {
    throw new Error(
      'A beta tester belongs to the opposite app audience; no changes were made.',
    );
  }
  const apps = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'apps',
    'apps',
  );
  const expectedInApp =
    expectedAppTester !== undefined || expectedMemberships.length > 0;
  const currentInApp = apps.some(({ id }) => id === appId);
  if (currentInApp !== expectedInApp) {
    throw new Error('A beta tester app relationship changed before the write.');
  }
  if (!expectedInApp && apps.length >= MAX_TESTER_RELATIONSHIPS) {
    throw new Error(
      'A beta tester has no safe app-relationship capacity for the additive write.',
    );
  }
  const appGroups = await listVerifiedBetaGroupsForApp(client, appId);
  const appGroupsById = new Map(appGroups.map((group) => [group.id, group]));
  const groups = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'betaGroups',
    'betaGroups',
  );
  if (groups.length >= MAX_TESTER_RELATIONSHIPS) {
    throw new Error(
      'A beta tester has no safe group-relationship capacity for the additive write.',
    );
  }
  const currentAppGroups = groups.filter(({ id }) => appGroupsById.has(id));
  const currentAppGroupIds = new Set(currentAppGroups.map(({ id }) => id));
  if (
    currentAppGroupIds.size !== expectedGroupIds.size ||
    [...expectedGroupIds].some((id) => !currentAppGroupIds.has(id))
  ) {
    throw new Error(
      'A beta tester group relationship changed before the write.',
    );
  }
  for (const group of currentAppGroups) {
    const typedAppGroup = appGroupsById.get(group.id) as JsonApiResource;
    const groupIsInternal = attributesOf(typedAppGroup).isInternalGroup;
    const testerGroupIsInternal = attributesOf(group).isInternalGroup;
    if (
      typeof groupIsInternal !== 'boolean' ||
      testerGroupIsInternal !== groupIsInternal ||
      groupIsInternal !== (audience === 'internal')
    ) {
      throw new Error('A beta tester gained an unsafe group in the exact app.');
    }
  }
  const builds = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'builds',
    'builds',
  );
  return { apps, builds, groups };
};

const assertExactTesterRelationshipDelta = async (
  client: AscClient,
  testerId: string,
  appId: string,
  groupId: string,
  internal: boolean,
  before: TesterRelationshipSnapshot,
): Promise<void> => {
  const currentGroups = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'betaGroups',
    'betaGroups',
  );
  const currentApps = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'apps',
    'apps',
  );
  const currentBuilds = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'builds',
    'builds',
  );
  const assertExactAdditiveSet = (
    prior: readonly JsonApiResource[],
    current: readonly JsonApiResource[],
    addedId: string,
    expectedType: string,
    label: string,
  ): JsonApiResource => {
    const expectedIds = new Set([...prior.map(({ id }) => id), addedId]);
    if (
      current.length !== expectedIds.size ||
      current.some(
        (resource) =>
          resource.type !== expectedType || !expectedIds.has(resource.id),
      )
    ) {
      throw new Error(
        `Apple returned an unexpected beta tester ${label} relationship delta.`,
      );
    }
    for (const previous of prior) {
      const matches = current.filter(({ id }) => id === previous.id);
      if (
        matches.length !== 1 ||
        canonicalJson(matches[0]) !== canonicalJson(previous)
      ) {
        throw new Error(
          `Apple changed an existing beta tester ${label} relationship.`,
        );
      }
    }
    const added = current.filter(({ id }) => id === addedId);
    if (added.length !== 1) {
      throw new Error(
        `Apple omitted the exact beta tester ${label} relationship.`,
      );
    }
    return added[0] as JsonApiResource;
  };
  const addedGroup = assertExactAdditiveSet(
    before.groups,
    currentGroups,
    groupId,
    'betaGroups',
    'group',
  );
  if (attributesOf(addedGroup).isInternalGroup !== internal) {
    throw new Error(
      'Apple returned an unexpected audience for the added beta tester group relationship.',
    );
  }
  assertExactAdditiveSet(before.apps, currentApps, appId, 'apps', 'app');
  const expectedBuildIds = new Set(before.builds.map(({ id }) => id));
  if (
    expectedBuildIds.size > MAX_TESTER_RELATIONSHIPS ||
    currentBuilds.length !== expectedBuildIds.size ||
    currentBuilds.some(
      (resource) =>
        resource.type !== 'builds' || !expectedBuildIds.has(resource.id),
    )
  ) {
    throw new Error(
      'Apple returned an unexpected beta tester build relationship delta.',
    );
  }
  for (const previous of before.builds) {
    const matches = currentBuilds.filter(({ id }) => id === previous.id);
    if (
      matches.length !== 1 ||
      canonicalJson(matches[0]) !== canonicalJson(previous)
    ) {
      throw new Error(
        'Apple changed an existing beta tester build relationship.',
      );
    }
  }
};

const assertEquivalentAppTesterInventory = async (
  client: AscClient,
  appId: string,
  expected: AppWideTesterInventory,
  internalDesired: readonly Tester[],
  externalDesired: readonly Tester[],
): Promise<AppWideTesterInventory> => {
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  if (groups.length > MAX_GROUPS) {
    throw new Error('Apple returned an unsafe beta-group inventory.');
  }
  const current = await inventoryAppTesterCapacity(
    client,
    appId,
    groups,
    internalDesired,
    externalDesired,
  );
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(
      'App-wide tester inventory changed after confirmation; refusing tester writes.',
    );
  }
  return current;
};

const resourceIdentitySet = (
  resources: readonly JsonApiResource[],
  expectedType: string,
  label: string,
): readonly string[] => {
  const identities = resources.map((resource) => {
    if (resource.type !== expectedType) {
      throw new Error(`Apple returned an unexpected ${label} resource.`);
    }
    return expectedType === 'betaTesters'
      ? `${resource.type}:${resource.id}:${testerEmail(resource)}`
      : `${resource.type}:${resource.id}`;
  });
  if (new Set(identities).size !== identities.length) {
    throw new Error(`Apple returned a duplicate ${label} resource.`);
  }
  return identities.sort();
};

const canonicalGroupBuildInventory = (
  resources: readonly JsonApiResource[],
): readonly JsonApiResource[] => {
  resourceIdentitySet(resources, 'builds', 'group build');
  const projected = resources.map(({ id }) =>
    canonicalResource({ id, type: 'builds' }),
  );
  projected.sort((left, right) => {
    const leftIdentity = canonicalJson(left);
    const rightIdentity = canonicalJson(right);
    return leftIdentity < rightIdentity
      ? -1
      : leftIdentity > rightIdentity
        ? 1
        : 0;
  });
  return Object.freeze(projected);
};

const assertSameGroupBuildInventory = (
  current: readonly JsonApiResource[],
  expected: readonly JsonApiResource[],
): void => {
  if (
    canonicalJson(canonicalGroupBuildInventory(current)) !==
    canonicalJson(canonicalGroupBuildInventory(expected))
  ) {
    throw new Error(
      'Managed group build inventory changed after confirmation.',
    );
  }
};

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const assertExactTargetGroupSettingsAndParent = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
): Promise<string> => {
  if (target.id === null) {
    throw new Error('Apply has no verified beta-group ID.');
  }
  const group = resourceFromUnknown(
    await client.get(
      appendQuery(`/v1/betaGroups/${encodeURIComponent(target.id)}`, {
        'fields[betaGroups]':
          'name,isInternalGroup,hasAccessToAllBuilds,feedbackEnabled,publicLinkEnabled',
      }),
      'betaGroups',
    ),
    'betaGroups',
  );
  if (
    group.id !== target.id ||
    !hasSafeGroupSettings(group, target.name, target.internal)
  ) {
    throw new Error(
      'Managed group settings changed immediately before the risky write.',
    );
  }
  await assertBetaGroupBelongsToApp(client, group.id, appId);
  return group.id;
};

const verifyTargetGroupEnvelopeBeforeTesterWrite = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
  expectedTesterTotal: number,
  expectedBuilds: readonly JsonApiResource[],
): Promise<void> => {
  const groupId = await assertExactTargetGroupSettingsAndParent(
    client,
    appId,
    target,
  );
  const currentBuilds = await listGroupBuildSnapshot(client, groupId);
  assertSameGroupBuildInventory(currentBuilds, expectedBuilds);
  await assertGroupTesterRosterTotal(client, groupId, expectedTesterTotal);
};

const verifyTargetGroupSnapshotBeforeBuildWrite = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
  expectedTesters: readonly JsonApiResource[],
  expectedBuilds: readonly JsonApiResource[],
): Promise<void> => {
  const groupId = await assertExactTargetGroupSettingsAndParent(
    client,
    appId,
    target,
  );
  const currentTesters = await listGroupTesterSnapshot(client, groupId);
  const currentBuilds = await listGroupBuildSnapshot(client, groupId);
  if (
    !sameStrings(
      resourceIdentitySet(expectedTesters, 'betaTesters', 'tester'),
      resourceIdentitySet(currentTesters, 'betaTesters', 'tester'),
    ) ||
    !sameStrings(
      resourceIdentitySet(expectedBuilds, 'builds', 'group build'),
      resourceIdentitySet(currentBuilds, 'builds', 'group build'),
    )
  ) {
    throw new Error(
      'Managed group audience or builds changed immediately before the risky write.',
    );
  }
};

interface PlannedTesterWrite {
  readonly audience: TesterAudience;
  readonly email: string;
  readonly existing?: JsonApiResource;
}

interface TesterWritePlan {
  readonly auditReserve: number;
  readonly costByEmail: Map<string, number>;
  deferred: number;
  readonly pendingCount: number;
  remainingRateCost: number;
  readonly selected: readonly PlannedTesterWrite[];
  readonly selectedEmails: ReadonlySet<string>;
}

interface TesterSyncResult {
  readonly deferredWrites: number;
  readonly expectedBuilds: readonly JsonApiResource[];
}

interface ManagedGroupSnapshot {
  readonly builds: readonly JsonApiResource[];
  readonly target: GroupTarget;
  readonly testers: readonly JsonApiResource[];
}

const collectManagedGroupSnapshot = async (
  client: AscClient,
  appId: string,
  groups: readonly JsonApiResource[],
  name: string,
  internal: boolean,
): Promise<ManagedGroupSnapshot> => {
  const named = groups.filter(
    (group) => group.type === 'betaGroups' && attributesOf(group).name === name,
  );
  if (named.length !== 1) {
    return {
      builds: [],
      target: { existedInSnapshot: false, id: null, internal, name },
      testers: [],
    };
  }
  const group = named[0] as JsonApiResource;
  return {
    builds: await listVerifiedGroupBuilds(client, appId, group.id),
    target: {
      existedInSnapshot: true,
      id: group.id,
      internal,
      name,
    },
    testers: await listVerifiedGroupTesters(client, group.id),
  };
};

const assertTesterWriteRateLimitBudget = (
  client: AscClient,
  remainingSelectedRequestCost: number,
  auditReserve: number,
): void => {
  const remaining = client.rateLimitRemaining();
  if (remaining === null || !Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error(
      'Apple rate-limit budget is unavailable; refusing the tester write.',
    );
  }
  const required = remainingSelectedRequestCost + auditReserve;
  if (remaining < required) {
    throw new Error(
      'Apple rate-limit budget is too low for the selected tester chunk and final audit; no further tester writes were attempted.',
    );
  }
};

const pagedRequestCount = (count: number): number =>
  Math.max(1, Math.ceil(count / 200));

const finalAuditRequestReserve = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  internalSnapshot: ManagedGroupSnapshot,
  externalSnapshot: ManagedGroupSnapshot,
  selected: readonly PlannedTesterWrite[],
): number => {
  const groupCounts = new Map<string, number>();
  for (const group of groups) groupCounts.set(group.id, 0);
  for (const membership of inventory.groupMemberships) {
    groupCounts.set(
      membership.groupId,
      (groupCounts.get(membership.groupId) ?? 0) + 1,
    );
  }
  const targetKey = (audience: TesterAudience): string => {
    const snapshot =
      audience === 'internal' ? internalSnapshot : externalSnapshot;
    return snapshot.target.id ?? `planned:${audience}:group`;
  };
  for (const audience of ['internal', 'external'] as const) {
    const key = targetKey(audience);
    if (!groupCounts.has(key)) groupCounts.set(key, 0);
  }
  for (const write of selected) {
    const key = targetKey(write.audience);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  const appTesterIds = new Set(inventory.appTesters.map(({ id }) => id));
  let appTesterCount = inventory.appTesters.length;
  for (const write of selected) {
    if (write.existing === undefined || !appTesterIds.has(write.existing.id)) {
      appTesterCount += 1;
    }
  }
  const individualsByBuild = new Map<string, number>();
  for (const buildId of inventory.buildIds) individualsByBuild.set(buildId, 0);
  for (const tester of inventory.individualTesters) {
    individualsByBuild.set(
      tester.buildId,
      (individualsByBuild.get(tester.buildId) ?? 0) + 1,
    );
  }
  const groupCount = Math.max(groups.length, groupCounts.size);
  let requests = 4 * pagedRequestCount(groupCount);
  for (const count of groupCounts.values()) {
    requests += 2 * pagedRequestCount(count);
  }
  requests += pagedRequestCount(appTesterCount);
  requests += 2 * pagedRequestCount(inventory.buildIds.length);
  for (const count of individualsByBuild.values()) {
    requests += 2 * pagedRequestCount(count);
  }
  for (const snapshot of [internalSnapshot, externalSnapshot]) {
    const rosterCount =
      groupCounts.get(
        targetKey(snapshot.target.internal ? 'internal' : 'external'),
      ) ?? 0;
    requests += 2 * pagedRequestCount(rosterCount);
    requests += 2 * pagedRequestCount(snapshot.builds.length);
    requests += snapshot.builds.length;
  }
  requests += 1;
  return Math.max(MIN_FINAL_AUDIT_REQUEST_RESERVE, requests * MAX_GET_ATTEMPTS);
};

interface DownstreamTopology {
  readonly appLocalizationCount: number;
  readonly buildLocalizationCount: number;
}

type ApplyRateStage =
  | 'app-localization'
  | 'beta-review-submission'
  | 'build-localization'
  | 'external-build'
  | 'external-notification'
  | 'group-external'
  | 'group-internal'
  | 'internal-build'
  | 'review-details';

interface ApplyRateStageReservation {
  readonly guardCost: number;
  readonly totalCost: number;
}

interface ApplyRatePlan {
  readonly finalAuditReserve: number;
  readonly stages: ReadonlyMap<ApplyRateStage, ApplyRateStageReservation>;
  readonly total: number;
}

class ApplyRateBudget {
  readonly #finalAuditReserve: number;
  readonly #stages: Map<ApplyRateStage, ApplyRateStageReservation>;
  #remaining: number;

  constructor(plan: ApplyRatePlan) {
    this.#finalAuditReserve = plan.finalAuditReserve;
    this.#stages = new Map(plan.stages);
    this.#remaining = plan.total;
  }

  assertStageStart(client: AscClient, stage: ApplyRateStage): void {
    this.#reservation(stage);
    this.#assertRemaining(client, this.#remaining);
  }

  assertBeforeMutation(client: AscClient, stage: ApplyRateStage): void {
    const reservation = this.#reservation(stage);
    this.#assertRemaining(client, this.#remaining - reservation.guardCost);
  }

  complete(stage: ApplyRateStage): void {
    const reservation = this.#reservation(stage);
    this.#remaining -= reservation.totalCost;
    this.#stages.delete(stage);
  }

  assertFinalAudit(client: AscClient): void {
    if (
      [...this.#stages.values()].some(({ totalCost }) => totalCost !== 0) ||
      this.#remaining !== this.#finalAuditReserve
    ) {
      throw new Error('Apply rate-limit stage plan is incomplete.');
    }
    this.#assertRemaining(client, this.#finalAuditReserve);
  }

  #reservation(stage: ApplyRateStage): ApplyRateStageReservation {
    const reservation = this.#stages.get(stage);
    if (reservation === undefined) {
      throw new Error('Apply rate-limit stage plan is inconsistent.');
    }
    return reservation;
  }

  #assertRemaining(client: AscClient, required: number): void {
    const remaining = client.rateLimitRemaining();
    if (
      remaining === null ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      remaining < required
    ) {
      throw new Error(
        'Apple request budget changed before a provider mutation; no further mutations were attempted.',
      );
    }
  }
}

const appTesterAuditLogicalRequestCount = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  internalSnapshot: ManagedGroupSnapshot,
  externalSnapshot: ManagedGroupSnapshot,
): number => {
  const groupCounts = new Map(groups.map(({ id }) => [id, 0]));
  for (const membership of inventory.groupMemberships) {
    groupCounts.set(
      membership.groupId,
      (groupCounts.get(membership.groupId) ?? 0) + 1,
    );
  }
  for (const [audience, snapshot] of [
    ['internal', internalSnapshot],
    ['external', externalSnapshot],
  ] as const) {
    const key = snapshot.target.id ?? `planned:${audience}:group`;
    if (!groupCounts.has(key)) groupCounts.set(key, 0);
  }
  const individualsByBuild = new Map(
    inventory.buildIds.map((buildId) => [buildId, 0]),
  );
  for (const tester of inventory.individualTesters) {
    individualsByBuild.set(
      tester.buildId,
      (individualsByBuild.get(tester.buildId) ?? 0) + 1,
    );
  }
  return (
    2 * pagedRequestCount(Math.max(groups.length, groupCounts.size)) +
    2 *
      [...groupCounts.values()].reduce(
        (total, count) => total + pagedRequestCount(count),
        0,
      ) +
    pagedRequestCount(inventory.appTesters.length) +
    2 * pagedRequestCount(inventory.buildIds.length) +
    2 *
      [...individualsByBuild.values()].reduce(
        (total, count) => total + pagedRequestCount(count),
        0,
      )
  );
};

const downstreamRequestReserve = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  internalSnapshot: ManagedGroupSnapshot,
  externalSnapshot: ManagedGroupSnapshot,
  build: JsonApiResource | null,
  reviewInfoPresent: boolean,
  submitBetaReview: boolean,
  topology: DownstreamTopology,
): ApplyRatePlan => {
  const appendBuild = (
    snapshot: ManagedGroupSnapshot,
    shouldAttach: boolean,
  ): ManagedGroupSnapshot => ({
    ...snapshot,
    builds:
      shouldAttach &&
      build !== null &&
      !snapshot.builds.some(({ id }) => id === build.id)
        ? [...snapshot.builds, build]
        : snapshot.builds,
  });
  const attachInternal =
    build !== null &&
    !internalSnapshot.builds.some(({ id }) => id === build.id);
  const attachExternal =
    submitBetaReview &&
    build !== null &&
    !externalSnapshot.builds.some(({ id }) => id === build.id);
  const projectedInternal = appendBuild(internalSnapshot, attachInternal);
  const projectedExternal = appendBuild(externalSnapshot, attachExternal);
  const groupCount = Math.max(
    groups.length,
    new Set([
      ...groups.map(({ id }) => id),
      internalSnapshot.target.id ?? 'planned:internal:group',
      externalSnapshot.target.id ?? 'planned:external:group',
    ]).size,
  );
  const coreAudit = appTesterAuditLogicalRequestCount(
    groups,
    inventory,
    internalSnapshot,
    externalSnapshot,
  );
  const appLocalizationCount = reviewInfoPresent
    ? Math.min(MAX_APP_LOCALIZATIONS, topology.appLocalizationCount + 1)
    : topology.appLocalizationCount;
  const buildLocalizationCount =
    reviewInfoPresent && build !== null
      ? Math.min(
          BETA_BUILD_LOCALIZATION_LOCALES.size,
          topology.buildLocalizationCount + 1,
        )
      : topology.buildLocalizationCount;
  const appLocalizationAudit =
    pagedRequestCount(appLocalizationCount) + appLocalizationCount;
  const buildLocalizationAudit =
    pagedRequestCount(buildLocalizationCount) + buildLocalizationCount;
  const completeLocalizationAudit =
    appLocalizationAudit + (build === null ? 0 : buildLocalizationAudit);
  const buildRefresh = 6 + pagedRequestCount(MAX_APP_BUILDS);
  const groupReadiness = (snapshot: ManagedGroupSnapshot): number =>
    2 * pagedRequestCount(groupCount) +
    2 * pagedRequestCount(snapshot.testers.length) +
    2 * pagedRequestCount(snapshot.builds.length) +
    snapshot.builds.length;
  const exactTargetSnapshot = (snapshot: ManagedGroupSnapshot): number =>
    2 +
    2 * pagedRequestCount(snapshot.testers.length) +
    2 * pagedRequestCount(snapshot.builds.length);
  const buildReadback = (snapshot: ManagedGroupSnapshot): number =>
    2 * pagedRequestCount(snapshot.builds.length) + snapshot.builds.length;
  const attachLogicalCost = (
    before: ManagedGroupSnapshot,
    after: ManagedGroupSnapshot,
    external: boolean,
  ): number =>
    groupReadiness(before) +
    buildLocalizationAudit +
    buildRefresh +
    completeLocalizationAudit +
    coreAudit +
    1 +
    exactTargetSnapshot(before) +
    1 +
    buildReadback(after) +
    (external ? 2 : 0);
  const exactAppIdentityCost = MAX_GET_ATTEMPTS;
  const stages = new Map<ApplyRateStage, ApplyRateStageReservation>([
    ['group-internal', { guardCost: 12, totalCost: 33 }],
    ['group-external', { guardCost: 12, totalCost: 33 }],
  ]);
  if (reviewInfoPresent) {
    stages.set('review-details', { guardCost: 9, totalCost: 18 });
    const appGuardCost =
      6 + exactAppIdentityCost + appLocalizationAudit * MAX_GET_ATTEMPTS;
    stages.set('app-localization', {
      guardCost: appGuardCost,
      totalCost: appGuardCost + 10,
    });
    if (build !== null) {
      const buildGuardCost =
        6 +
        exactAppIdentityCost +
        (appLocalizationAudit + buildLocalizationAudit) * MAX_GET_ATTEMPTS;
      stages.set('build-localization', {
        guardCost: buildGuardCost,
        totalCost: buildGuardCost + 15,
      });
    }
  }
  if (submitBetaReview) {
    stages.set('external-notification', { guardCost: 9, totalCost: 33 });
  }
  if (attachInternal) {
    const totalCost =
      attachLogicalCost(internalSnapshot, projectedInternal, false) *
      MAX_GET_ATTEMPTS;
    stages.set('internal-build', {
      guardCost: Math.max(
        0,
        totalCost - buildReadback(projectedInternal) * MAX_GET_ATTEMPTS - 1,
      ),
      totalCost,
    });
  } else {
    stages.set('internal-build', { guardCost: 0, totalCost: 0 });
  }
  if (attachExternal) {
    const totalCost =
      attachLogicalCost(externalSnapshot, projectedExternal, true) *
      MAX_GET_ATTEMPTS;
    stages.set('external-build', {
      guardCost: Math.max(
        0,
        totalCost - buildReadback(projectedExternal) * MAX_GET_ATTEMPTS - 1,
      ),
      totalCost,
    });
  } else if (submitBetaReview && build !== null) {
    const totalCost =
      (groupReadiness(projectedExternal) + 2) * MAX_GET_ATTEMPTS;
    stages.set('external-build', {
      guardCost: totalCost,
      totalCost,
    });
  }
  if (submitBetaReview && build !== null) {
    const reviewSubmissionLogicalCost =
      buildRefresh +
      groupReadiness(projectedExternal) +
      appLocalizationAudit +
      buildLocalizationAudit +
      completeLocalizationAudit +
      coreAudit +
      10;
    const totalCost = reviewSubmissionLogicalCost * MAX_GET_ATTEMPTS;
    stages.set('beta-review-submission', {
      guardCost: Math.max(0, totalCost - 12),
      totalCost,
    });
  }
  let finalAuditReserve = finalAuditRequestReserve(
    groups,
    inventory,
    projectedInternal,
    projectedExternal,
    [],
  );
  if (reviewInfoPresent) {
    finalAuditReserve += (2 + completeLocalizationAudit) * MAX_GET_ATTEMPTS;
  }
  if (submitBetaReview && build !== null) {
    finalAuditReserve += 4 * MAX_GET_ATTEMPTS;
  }
  return {
    finalAuditReserve,
    stages,
    total:
      finalAuditReserve +
      [...stages.values()].reduce(
        (total, reservation) => total + reservation.totalCost,
        0,
      ),
  };
};

const managedGroupEmails = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  name: string,
  internal: boolean,
): ReadonlySet<string> => {
  const matches = groups.filter(
    (group) =>
      group.type === 'betaGroups' &&
      attributesOf(group).name === name &&
      attributesOf(group).isInternalGroup === internal,
  );
  if (matches.length !== 1) return new Set<string>();
  const groupId = (matches[0] as JsonApiResource).id;
  return new Set(
    inventory.groupMemberships.flatMap((membership) =>
      membership.groupId === groupId && membership.email !== undefined
        ? [membership.email]
        : [],
    ),
  );
};

const planTesterWriteChunk = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  accountTesterByEmail: ReadonlyMap<string, JsonApiResource>,
  internalSnapshot: ManagedGroupSnapshot,
  externalSnapshot: ManagedGroupSnapshot,
  internalDesired: readonly Tester[],
  externalDesired: readonly Tester[],
  availableRateBudget: number | null,
  confirmedMaxWrites?: number,
): TesterWritePlan => {
  const audiences = [
    [
      'internal',
      internalDesired,
      managedGroupEmails(groups, inventory, INTERNAL_GROUP_NAME, true),
    ],
    [
      'external',
      externalDesired,
      managedGroupEmails(groups, inventory, EXTERNAL_GROUP_NAME, false),
    ],
  ] as const;
  const pendingEmails = audiences.flatMap(([, desired, currentEmails]) =>
    desired.flatMap(({ email }) => (currentEmails.has(email) ? [] : [email])),
  );
  if (
    inventory.groupMemberships.length + pendingEmails.length >
    MAX_RESOURCES
  ) {
    throw new Error(
      'Approved tester writes exceed the safe app group-membership capacity.',
    );
  }
  const requiredAccountCreates = pendingEmails.filter(
    (email) => !accountTesterByEmail.has(email),
  ).length;
  if (accountTesterByEmail.size + requiredAccountCreates > MAX_RESOURCES) {
    throw new Error(
      'Approved tester creates exceed the safe account tester capacity.',
    );
  }
  const selected: PlannedTesterWrite[] = [];
  const costByEmail = new Map<string, number>();
  let selectedRequestCost = 0;
  let selectionComplete = false;
  const maxSelectedWrites = confirmedMaxWrites ?? MAX_TESTER_WRITES_PER_APPLY;
  if (
    !Number.isSafeInteger(maxSelectedWrites) ||
    maxSelectedWrites < 0 ||
    maxSelectedWrites > MAX_TESTER_WRITES_PER_APPLY
  ) {
    throw new Error('Confirmed tester-write selection limit is invalid.');
  }
  const effectiveApplyBudget =
    confirmedMaxWrites === undefined
      ? Math.min(MAX_APPLY_REQUEST_COST, availableRateBudget ?? 0)
      : MAX_APPLY_REQUEST_COST;
  for (const [audience, desired, currentEmails] of audiences) {
    for (const tester of desired) {
      if (currentEmails.has(tester.email)) continue;
      const existing = accountTesterByEmail.get(tester.email);
      const requestCost =
        audience === 'internal'
          ? INTERNAL_TESTER_WRITE_REQUEST_COST
          : existing === undefined
            ? EXTERNAL_CREATE_REQUEST_COST
            : EXTERNAL_LINK_REQUEST_COST;
      const candidate = [
        ...selected,
        {
          audience,
          email: tester.email,
          ...(existing === undefined ? {} : { existing }),
        },
      ];
      const candidateAuditReserve = finalAuditRequestReserve(
        groups,
        inventory,
        internalSnapshot,
        externalSnapshot,
        candidate,
      );
      if (
        selected.length >= maxSelectedWrites ||
        selectedRequestCost + requestCost >
          MAX_TESTER_WRITE_REQUEST_COST_PER_APPLY ||
        selectedRequestCost +
          requestCost +
          RATE_LIMIT_GROUP_SETUP_RESERVE +
          candidateAuditReserve >
          effectiveApplyBudget
      ) {
        selectionComplete = true;
        break;
      }
      selected.push({
        audience,
        email: tester.email,
        ...(existing === undefined ? {} : { existing }),
      });
      costByEmail.set(tester.email, requestCost);
      selectedRequestCost += requestCost;
    }
    if (selectionComplete) break;
  }
  const auditReserve = finalAuditRequestReserve(
    groups,
    inventory,
    internalSnapshot,
    externalSnapshot,
    selected,
  );
  return {
    auditReserve,
    costByEmail,
    deferred: 0,
    pendingCount: pendingEmails.length,
    remainingRateCost: selectedRequestCost,
    selected: Object.freeze(selected),
    selectedEmails: new Set(selected.map(({ email }) => email)),
  };
};

const syncTesters = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  identityRegistry: TesterIdentityAudienceRegistry,
  inventoryState: AppWideTesterInventoryState,
  internalDesired: readonly Tester[],
  externalDesired: readonly Tester[],
  accountTesterByEmail: ReadonlyMap<string, JsonApiResource>,
  target: GroupTarget,
  snapshotGroupTesters: readonly JsonApiResource[],
  snapshotGroupBuilds: readonly JsonApiResource[],
  desired: readonly Tester[],
  writePlan: TesterWritePlan,
  preflightInternalUsers: ReadonlyMap<string, JsonApiResource> | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<TesterSyncResult> => {
  const { id: groupId, name: groupName } = target;
  const audience: TesterAudience = target.internal ? 'internal' : 'external';
  const groupTesters = snapshotGroupTesters;
  const groupBuilds = snapshotGroupBuilds;
  const expectedGroupBuilds = canonicalGroupBuildInventory(groupBuilds);
  const approved = new Set(desired.map(({ email }) => email));
  const inGroup = new Set<string>();
  for (const tester of groupTesters) {
    const email = identityRegistry.registerResolvedTester(tester, audience);
    if (inGroup.has(email)) {
      throw new Error(
        'Apple returned duplicate managed-group tester identities.',
      );
    }
    inGroup.add(email);
  }
  if ([...inGroup].some((email) => !approved.has(email))) {
    throw new Error(
      `${groupName} contains tester(s) outside the complete approved roster; no changes were made.`,
    );
  }
  const matchedTesterByEmail = new Map<string, JsonApiResource>();
  for (const tester of desired) {
    const resource = accountTesterByEmail.get(tester.email);
    if (resource !== undefined) {
      identityRegistry.registerResolvedTester(resource, audience, approved);
      matchedTesterByEmail.set(tester.email, resource);
    }
  }
  const pendingWrites: Array<
    | { readonly kind: 'create'; readonly tester: Tester }
    | {
        readonly kind: 'link';
        readonly resource: JsonApiResource;
        readonly tester: Tester;
      }
  > = [];
  let unchanged = 0;
  for (const tester of desired) {
    if (inGroup.has(tester.email)) {
      unchanged += 1;
      continue;
    }
    const existing = matchedTesterByEmail.get(tester.email);
    if (existing === undefined) pendingWrites.push({ kind: 'create', tester });
    else pendingWrites.push({ kind: 'link', resource: existing, tester });
  }
  const selectedWrites = pendingWrites.filter(({ tester }) =>
    writePlan.selectedEmails.has(tester.email),
  );
  const deferredWrites = pendingWrites.length - selectedWrites.length;
  writePlan.deferred += deferredWrites;
  const existingToLink = selectedWrites.filter(
    (
      item,
    ): item is {
      readonly kind: 'link';
      readonly resource: JsonApiResource;
      readonly tester: Tester;
    } => item.kind === 'link',
  );
  const missing = selectedWrites.filter(
    (item): item is { readonly kind: 'create'; readonly tester: Tester } =>
      item.kind === 'create',
  );
  if (unchanged > 0) {
    actions.push({
      detail: `${unchanged} approved tester(s) already belong to ${groupName}.`,
      kind: 'tester',
      status: 'unchanged',
    });
  }
  const invitationConsequence = target.internal
    ? expectedGroupBuilds.length === 0
      ? '; Apple may send a real TestFlight invitation email'
      : `; ${expectedGroupBuilds.length} existing build(s) mean Apple may immediately send invitation email, including a real TestFlight invitation email`
    : '; Apple may send a real TestFlight invitation email';
  if (existingToLink.length > 0) {
    actions.push({
      detail: `Add ${existingToLink.length} approved existing tester(s) to ${groupName}${invitationConsequence}.`,
      kind: 'tester',
      status: actionStatus(apply),
    });
  }
  if (missing.length > 0) {
    actions.push({
      detail: `Create and add ${missing.length} approved tester(s) to ${groupName}${invitationConsequence}.`,
      kind: 'tester',
      status: actionStatus(apply),
    });
  }
  if (deferredWrites > 0) {
    actions.push({
      detail: `Defer ${deferredWrites} approved tester write(s) for ${groupName}; a fresh preview, digest review, and human-confirmed apply are required for the next chunk.`,
      kind: 'tester',
      status: 'deferred',
    });
  }
  let expectedGroupTesters = canonicalResources(groupTesters);
  const hasTesterWrites = existingToLink.length > 0 || missing.length > 0;
  if (!apply || !hasTesterWrites) {
    return { deferredWrites, expectedBuilds: expectedGroupBuilds };
  }
  if (assertionClient === undefined || groupId === null) {
    throw new Error('Apply is missing a verified group assertion.');
  }
  const liveIdentityRegistry = new TesterIdentityAudienceRegistry(
    inventoryState.current,
  );
  const selectedApprovedTesters = selectedWrites.map(({ tester }) => tester);
  const liveInternalUsers = target.internal
    ? (preflightInternalUsers ??
      (await collectEligibleInternalTesterUsers(
        assertionClient,
        selectedApprovedTesters,
      )))
    : undefined;
  const evolveProjectedGlobalInventory = (
    added: readonly JsonApiResource[],
  ): void => {
    inventoryState.current = evolveAppWideTesterInventory(
      inventoryState.current,
      target,
      added,
    );
  };
  const acceptVerifiedTester = async (
    tester: JsonApiResource,
    email: string,
  ): Promise<void> => {
    const expectedAfter = canonicalResources([...expectedGroupTesters, tester]);
    await assertGroupTesterRosterTotal(
      assertionClient,
      groupId,
      expectedAfter.length,
    );
    expectedGroupTesters = expectedAfter;
    evolveProjectedGlobalInventory([tester]);
    const requestCost = writePlan.costByEmail.get(email);
    if (
      requestCost === undefined ||
      requestCost > writePlan.remainingRateCost
    ) {
      throw new Error('Selected tester write rate-limit plan is inconsistent.');
    }
    writePlan.remainingRateCost -= requestCost;
  };
  if (existingToLink.length > 0) {
    for (const { resource: tester, tester: approvedTester } of existingToLink) {
      const expectedEmail = testerEmail(tester);
      assertTesterWriteRateLimitBudget(
        assertionClient,
        writePlan.remainingRateCost,
        writePlan.auditReserve,
      );
      if (target.internal) {
        if (approvedTester.email !== expectedEmail) {
          throw new Error(
            'An existing beta tester is outside the approved internal roster.',
          );
        }
        await assertExactInternalTesterEligibility(
          assertionClient,
          appId,
          approvedTester,
          liveInternalUsers?.get(approvedTester.email),
        );
      }
      await assertExactAppIdentity(assertionClient, appId);
      const relationshipSnapshot = await assertCurrentTesterAppAudienceSafety(
        assertionClient,
        appId,
        tester.id,
        audience,
        inventoryState.current,
      );
      const liveTester = await readExactBetaTester(
        assertionClient,
        tester.id,
        expectedEmail,
      );
      liveIdentityRegistry.registerResolvedTester(
        liveTester,
        audience,
        approved,
      );
      identityRegistry.registerResolvedTester(liveTester, audience, approved);
      await verifyTargetGroupEnvelopeBeforeTesterWrite(
        assertionClient,
        appId,
        target,
        expectedGroupTesters.length,
        expectedGroupBuilds,
      );
      assertTesterWriteRateLimitBudget(
        assertionClient,
        writePlan.remainingRateCost,
        writePlan.auditReserve,
      );
      const relationshipResult = await client.mutate(
        'POST',
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        { data: [{ id: liveTester.id, type: 'betaTesters' }] },
      );
      if (relationshipResult !== null) {
        throw new Error(
          'Apple tester relationship mutation outcome is indeterminate.',
        );
      }
      const linked = await readExactBetaTester(
        assertionClient,
        liveTester.id,
        expectedEmail,
      );
      await assertExactTesterRelationshipDelta(
        assertionClient,
        linked.id,
        appId,
        groupId,
        target.internal,
        relationshipSnapshot,
      );
      liveIdentityRegistry.registerResolvedTester(linked, audience, approved);
      identityRegistry.registerResolvedTester(linked, audience, approved);
      await acceptVerifiedTester(linked, expectedEmail);
    }
  }
  for (const { tester } of missing) {
    assertTesterWriteRateLimitBudget(
      assertionClient,
      writePlan.remainingRateCost,
      writePlan.auditReserve,
    );
    if (target.internal) {
      await assertExactInternalTesterEligibility(
        assertionClient,
        appId,
        tester,
        liveInternalUsers?.get(tester.email),
      );
    }
    await assertExactAppIdentity(assertionClient, appId);
    await verifyTargetGroupEnvelopeBeforeTesterWrite(
      assertionClient,
      appId,
      target,
      expectedGroupTesters.length,
      expectedGroupBuilds,
    );
    assertTesterWriteRateLimitBudget(
      assertionClient,
      writePlan.remainingRateCost,
      writePlan.auditReserve,
    );
    const created = await client.mutate(
      'POST',
      '/v1/betaTesters',
      {
        data: {
          attributes: {
            email: tester.email,
            ...(tester.firstName === undefined
              ? {}
              : { firstName: tester.firstName }),
            ...(tester.lastName === undefined
              ? {}
              : { lastName: tester.lastName }),
          },
          relationships: {
            betaGroups: {
              data: [{ id: groupId, type: 'betaGroups' }],
            },
          },
          type: 'betaTesters',
        },
      },
      'betaTesters',
    );
    if (created === null) {
      throw new Error('Apple did not return the created beta tester.');
    }
    const createdEmailFromResponse = testerEmail(created);
    if (createdEmailFromResponse !== tester.email) {
      throw new Error('Apple returned an unexpected created tester identity.');
    }
    const verifiedCreated = await readExactBetaTester(
      assertionClient,
      created.id,
      tester.email,
    );
    await assertCreatedBetaTesterHasExactRelationships(
      assertionClient,
      verifiedCreated.id,
      groupId,
      appId,
      target.internal,
    );
    const createdEmail = identityRegistry.registerCreatedTester(
      verifiedCreated,
      audience,
    );
    liveIdentityRegistry.registerCreatedTester(verifiedCreated, audience);
    if (createdEmail !== tester.email) {
      throw new Error('Apple returned an unexpected created tester identity.');
    }
    await acceptVerifiedTester(verifiedCreated, tester.email);
  }
  return { deferredWrites, expectedBuilds: expectedGroupBuilds };
};

const reviewAttributes = (review: BetaReviewInfo): JsonObject => ({
  contactEmail: review.contactEmail,
  contactFirstName: review.contactFirstName,
  contactLastName: review.contactLastName,
  contactPhone: review.contactPhone,
  demoAccountName: review.demoAccountName ?? null,
  demoAccountPassword: review.demoAccountPassword ?? null,
  demoAccountRequired: review.demoAccountRequired,
  notes: review.notes ?? null,
});

const localizationAttributes = (review: BetaReviewInfo): JsonObject => ({
  description: review.betaDescription,
  feedbackEmail: review.feedbackEmail,
});

const buildLocalizationAttributes = (review: BetaReviewInfo): JsonObject => ({
  whatsNew: review.whatsNew,
});

interface LocalizationEvidence {
  readonly appLocalizations: readonly JsonApiResource[];
  readonly buildLocalizations?: readonly JsonApiResource[];
}

interface ReviewInfoSyncEvidence {
  readonly appLocalizations: readonly JsonApiResource[];
  readonly details: JsonApiResource;
}

const nullableLocalizationString = (
  value: unknown,
  label: string,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Apple returned a malformed ${label}.`);
  }
  return value;
};

const requiredLocalizationString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Apple returned a malformed ${label}.`);
  }
  return value;
};

const appLocalizationLocale = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value
  ) {
    throw new Error('Apple returned a malformed beta app locale.');
  }
  return value;
};

const supportedBuildLocalizationLocale = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !BETA_BUILD_LOCALIZATION_LOCALES.has(value)
  ) {
    throw new Error('Apple returned an unsupported beta-localization locale.');
  }
  return value;
};

const projectAppLocalization = (
  localization: JsonApiResource,
): JsonApiResource => {
  if (localization.type !== 'betaAppLocalizations') {
    throw new Error('Apple returned an unexpected beta-localization resource.');
  }
  requireOpaqueIdentifier(localization.id, 'Beta app localization ID');
  const attributes = attributesOf(localization);
  return canonicalResource({
    attributes: {
      description: requiredLocalizationString(
        attributes.description,
        'beta app localization description',
      ),
      feedbackEmail: nullableLocalizationString(
        attributes.feedbackEmail,
        'beta app localization feedback email',
      ),
      locale: appLocalizationLocale(attributes.locale),
      marketingUrl: nullableLocalizationString(
        attributes.marketingUrl,
        'beta app localization marketing URL',
      ),
      privacyPolicyUrl: nullableLocalizationString(
        attributes.privacyPolicyUrl,
        'beta app localization privacy-policy URL',
      ),
      tvOsPrivacyPolicy: nullableLocalizationString(
        attributes.tvOsPrivacyPolicy,
        'beta app localization tvOS privacy policy',
      ),
    },
    id: localization.id,
    type: 'betaAppLocalizations',
  });
};

const projectBuildLocalization = (
  localization: JsonApiResource,
): JsonApiResource => {
  if (localization.type !== 'betaBuildLocalizations') {
    throw new Error(
      'Apple returned an unexpected beta-build-localization resource.',
    );
  }
  requireOpaqueIdentifier(localization.id, 'Beta build localization ID');
  const attributes = attributesOf(localization);
  return canonicalResource({
    attributes: {
      locale: supportedBuildLocalizationLocale(attributes.locale),
      whatsNew: requiredLocalizationString(
        attributes.whatsNew,
        'beta build localization What to Test text',
      ),
    },
    id: localization.id,
    type: 'betaBuildLocalizations',
  });
};

const projectLocalizationInventory = (
  localizations: readonly JsonApiResource[],
  kind: 'app' | 'build',
): readonly JsonApiResource[] => {
  const projected = localizations.map((localization) =>
    kind === 'app'
      ? projectAppLocalization(localization)
      : projectBuildLocalization(localization),
  );
  const ids = new Set<string>();
  const locales = new Set<string>();
  for (const localization of projected) {
    const locale = attributesOf(localization).locale;
    if (typeof locale !== 'string') {
      throw new Error('Apple returned a malformed localization locale.');
    }
    if (ids.has(localization.id) || locales.has(locale)) {
      throw new Error(
        `Apple returned duplicate beta ${kind} localization identity evidence.`,
      );
    }
    ids.add(localization.id);
    locales.add(locale);
  }
  return canonicalResources(projected);
};

const expectedAppLocalization = (
  id: string,
  review: BetaReviewInfo,
  previous?: JsonApiResource,
): JsonApiResource => {
  const previousAttributes =
    previous === undefined ? EMPTY_JSON_OBJECT : attributesOf(previous);
  return projectAppLocalization({
    attributes: {
      description: review.betaDescription,
      feedbackEmail: review.feedbackEmail,
      locale: review.locale,
      marketingUrl: previousAttributes.marketingUrl ?? null,
      privacyPolicyUrl: previousAttributes.privacyPolicyUrl ?? null,
      tvOsPrivacyPolicy: previousAttributes.tvOsPrivacyPolicy ?? null,
    },
    id,
    type: 'betaAppLocalizations',
  });
};

const expectedBuildLocalization = (
  id: string,
  review: BetaReviewInfo,
): JsonApiResource =>
  projectBuildLocalization({
    attributes: { locale: review.locale, whatsNew: review.whatsNew },
    id,
    type: 'betaBuildLocalizations',
  });

const plannedLocalizationId = (
  prefix: string,
  current: readonly JsonApiResource[],
): string => {
  const ids = new Set(current.map(({ id }) => id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};

const withLocalization = (
  current: readonly JsonApiResource[],
  replacement: JsonApiResource,
  replacedId?: string,
): readonly JsonApiResource[] =>
  projectLocalizationInventory(
    [...current.filter(({ id }) => id !== replacedId), replacement],
    replacement.type === 'betaAppLocalizations' ? 'app' : 'build',
  );

const assertSameLocalizationInventory = (
  current: readonly JsonApiResource[],
  expected: readonly JsonApiResource[],
  label: string,
): void => {
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(`${label} changed after the confirmed plan.`);
  }
};

const syncReviewInfo = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  review: BetaReviewInfo,
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<ReviewInfoSyncEvidence> => {
  const detailsPath = `/v1/apps/${encodeURIComponent(appId)}/betaAppReviewDetail`;
  const details = await client.get(detailsPath, 'betaAppReviewDetails');
  await assertBetaAppReviewDetailBelongsToApp(client, details.id, appId);
  let expectedLiveDetails = canonicalResource(details);
  const assertExactLiveDetails = async (): Promise<void> => {
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its review-details assertion.');
    }
    const current = canonicalResource(
      await assertionClient.get(detailsPath, 'betaAppReviewDetails'),
    );
    if (canonicalJson(current) !== canonicalJson(expectedLiveDetails)) {
      throw new Error(
        'Beta App Review details changed after the confirmed plan.',
      );
    }
    await assertBetaAppReviewDetailBelongsToApp(
      assertionClient,
      current.id,
      appId,
    );
  };
  const expectedDetails = reviewAttributes(review);
  if (sameSelectedAttributes(attributesOf(details), expectedDetails)) {
    actions.push({
      detail: 'Beta App Review contact and access details already match.',
      kind: 'beta-review-details',
      status: 'unchanged',
    });
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete('review-details');
    }
  } else {
    actions.push({
      detail: 'Update Beta App Review contact and access details.',
      kind: 'beta-review-details',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its review-details assertion.');
      }
      rateBudget.assertStageStart(assertionClient, 'review-details');
      await assertExactLiveDetails();
      await assertExactAppIdentity(assertionClient, appId);
      rateBudget.assertBeforeMutation(assertionClient, 'review-details');
      const updated = await client.mutate(
        'PATCH',
        `/v1/betaAppReviewDetails/${encodeURIComponent(details.id)}`,
        {
          data: {
            attributes: expectedDetails,
            id: details.id,
            type: 'betaAppReviewDetails',
          },
        },
        'betaAppReviewDetails',
      );
      if (updated === null || updated.id !== details.id) {
        throw new Error(
          'Apple did not return the expected Beta App Review details.',
        );
      }
      await assertBetaAppReviewDetailBelongsToApp(
        assertionClient,
        updated.id,
        appId,
      );
      if (!sameSelectedAttributes(attributesOf(updated), expectedDetails)) {
        throw new Error(
          'Apple did not return the expected Beta App Review details.',
        );
      }
      expectedLiveDetails = canonicalResource(updated);
      rateBudget.complete('review-details');
    }
  }

  const localizations = await listVerifiedBetaAppLocalizationsForApp(
    client,
    appId,
  );
  const projected = projectLocalizationInventory(localizations, 'app');
  const assertExactLiveReviewInventory = async (): Promise<void> => {
    await assertExactLiveDetails();
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its app-localization assertion.');
    }
    const current = projectLocalizationInventory(
      await listVerifiedBetaAppLocalizationsForApp(assertionClient, appId),
      'app',
    );
    assertSameLocalizationInventory(
      current,
      projected,
      'Complete beta app localization inventory',
    );
    await assertExactAppIdentity(assertionClient, appId);
  };
  const matching = projected.filter(
    (item) => attributesOf(item).locale === review.locale,
  );
  const expectedLocalization = localizationAttributes(review);
  const existing = matching[0];
  if (existing === undefined) {
    if (projected.length >= MAX_APP_LOCALIZATIONS) {
      throw new Error(
        'Beta app localization inventory has no safe capacity for an additive write.',
      );
    }
    actions.push({
      detail: `Create ${review.locale} TestFlight beta description.`,
      kind: 'beta-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its app-localization assertion.');
      }
      rateBudget.assertStageStart(assertionClient, 'app-localization');
      await assertExactLiveReviewInventory();
      rateBudget.assertBeforeMutation(assertionClient, 'app-localization');
      const created = await client.mutate(
        'POST',
        '/v1/betaAppLocalizations',
        {
          data: {
            attributes: { locale: review.locale, ...expectedLocalization },
            relationships: { app: { data: { id: appId, type: 'apps' } } },
            type: 'betaAppLocalizations',
          },
        },
        'betaAppLocalizations',
      );
      if (created === null) {
        throw new Error('Apple did not return the beta app localization.');
      }
      await assertBetaAppLocalizationBelongsToApp(
        assertionClient,
        created.id,
        appId,
      );
      const expectedCreated = expectedAppLocalization(created.id, review);
      const projectedCreated = projectAppLocalization(created);
      if (canonicalJson(projectedCreated) !== canonicalJson(expectedCreated)) {
        throw new Error(
          'Apple returned unexpected beta app localization attributes.',
        );
      }
      rateBudget.complete('app-localization');
      return {
        appLocalizations: withLocalization(projected, projectedCreated),
        details: expectedLiveDetails,
      };
    }
    const planned = expectedAppLocalization(
      plannedLocalizationId('planned-beta-app-localization', projected),
      review,
    );
    return {
      appLocalizations: withLocalization(projected, planned),
      details: expectedLiveDetails,
    };
  } else if (
    sameSelectedAttributes(attributesOf(existing), expectedLocalization)
  ) {
    actions.push({
      detail: `${review.locale} TestFlight beta description already matches.`,
      kind: 'beta-localization',
      status: 'unchanged',
    });
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete('app-localization');
    }
  } else {
    actions.push({
      detail: `Update ${review.locale} TestFlight beta description.`,
      kind: 'beta-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its app-localization assertion.');
      }
      rateBudget.assertStageStart(assertionClient, 'app-localization');
      await assertExactLiveReviewInventory();
      rateBudget.assertBeforeMutation(assertionClient, 'app-localization');
      const updated = await client.mutate(
        'PATCH',
        `/v1/betaAppLocalizations/${encodeURIComponent(existing.id)}`,
        {
          data: {
            attributes: expectedLocalization,
            id: existing.id,
            type: 'betaAppLocalizations',
          },
        },
        'betaAppLocalizations',
      );
      if (updated === null || updated.id !== existing.id) {
        throw new Error('Apple did not return the beta app localization.');
      }
      await assertBetaAppLocalizationBelongsToApp(
        assertionClient,
        updated.id,
        appId,
      );
      const expectedUpdated = expectedAppLocalization(
        existing.id,
        review,
        existing,
      );
      const projectedUpdated = projectAppLocalization(updated);
      if (canonicalJson(projectedUpdated) !== canonicalJson(expectedUpdated)) {
        throw new Error(
          'Apple returned unexpected beta app localization attributes.',
        );
      }
      rateBudget.complete('app-localization');
      return {
        appLocalizations: withLocalization(
          projected,
          projectedUpdated,
          existing.id,
        ),
        details: expectedLiveDetails,
      };
    }
    return {
      appLocalizations: withLocalization(
        projected,
        expectedAppLocalization(existing.id, review, existing),
        existing.id,
      ),
      details: expectedLiveDetails,
    };
  }
  return { appLocalizations: projected, details: expectedLiveDetails };
};

const assertBuildLocalizationRelationship = async (
  client: AscClient,
  localizationId: string,
  buildId: string,
): Promise<void> => {
  const relatedBuild = await client.get(
    `/v1/betaBuildLocalizations/${encodeURIComponent(localizationId)}/build`,
    'builds',
  );
  if (relatedBuild.id !== buildId) {
    throw new Error(
      'Beta build localization does not belong to the selected exact build.',
    );
  }
};

const listVerifiedBetaBuildLocalizations = async (
  client: AscClient,
  buildId: string,
): Promise<readonly JsonApiResource[]> => {
  const localizations = validateBoundedResourceInventory(
    await client.list(betaBuildLocalizationsPath(buildId)),
    'betaBuildLocalizations',
    'beta build localization',
    BETA_BUILD_LOCALIZATION_LOCALES.size,
  );
  for (const localization of localizations) {
    await assertBuildLocalizationRelationship(client, localization.id, buildId);
  }
  return localizations;
};

const syncBuildLocalization = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  build: JsonApiResource,
  review: BetaReviewInfo,
  expectedReviewDetails: JsonApiResource,
  expectedAppLocalizations: readonly JsonApiResource[],
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<readonly JsonApiResource[]> => {
  const localizations = await listVerifiedBetaBuildLocalizations(
    client,
    build.id,
  );
  const projected = projectLocalizationInventory(localizations, 'build');
  const assertExactLiveLocalizationState = async (): Promise<void> => {
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its build-localization assertion.');
    }
    const currentDetails = canonicalResource(
      await assertionClient.get(
        `/v1/apps/${encodeURIComponent(appId)}/betaAppReviewDetail`,
        'betaAppReviewDetails',
      ),
    );
    if (
      canonicalJson(currentDetails) !== canonicalJson(expectedReviewDetails)
    ) {
      throw new Error(
        'Beta App Review details changed before build localization.',
      );
    }
    await assertBetaAppReviewDetailBelongsToApp(
      assertionClient,
      currentDetails.id,
      appId,
    );
    const currentAppLocalizations = projectLocalizationInventory(
      await listVerifiedBetaAppLocalizationsForApp(assertionClient, appId),
      'app',
    );
    assertSameLocalizationInventory(
      currentAppLocalizations,
      expectedAppLocalizations,
      'Complete beta app localization inventory',
    );
    const currentBuildLocalizations = projectLocalizationInventory(
      await listVerifiedBetaBuildLocalizations(assertionClient, build.id),
      'build',
    );
    assertSameLocalizationInventory(
      currentBuildLocalizations,
      projected,
      'Complete beta build localization inventory',
    );
    await assertExactAppIdentity(assertionClient, appId);
  };
  const matching = projected.filter(
    (localization) => attributesOf(localization).locale === review.locale,
  );
  const expected = buildLocalizationAttributes(review);
  const existing = matching[0];
  if (existing === undefined) {
    if (projected.length >= BETA_BUILD_LOCALIZATION_LOCALES.size) {
      throw new Error(
        'Beta build localization inventory has no safe capacity for an additive write.',
      );
    }
    actions.push({
      detail: `Create ${review.locale} What to Test text for build ${build.id}.`,
      kind: 'beta-build-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its build-localization assertion.');
      }
      rateBudget.assertStageStart(assertionClient, 'build-localization');
      await assertExactLiveLocalizationState();
      rateBudget.assertBeforeMutation(assertionClient, 'build-localization');
      const created = await client.mutate(
        'POST',
        '/v1/betaBuildLocalizations',
        {
          data: {
            attributes: { locale: review.locale, ...expected },
            relationships: {
              build: { data: { id: build.id, type: 'builds' } },
            },
            type: 'betaBuildLocalizations',
          },
        },
        'betaBuildLocalizations',
      );
      if (created === null) {
        throw new Error('Apple did not return the beta build localization.');
      }
      await assertBuildLocalizationRelationship(
        assertionClient,
        created.id,
        build.id,
      );
      const projectedCreated = projectBuildLocalization(created);
      const expectedCreated = expectedBuildLocalization(created.id, review);
      if (canonicalJson(projectedCreated) !== canonicalJson(expectedCreated)) {
        throw new Error(
          'Apple returned unexpected beta build localization attributes.',
        );
      }
      rateBudget.complete('build-localization');
      return withLocalization(projected, projectedCreated);
    }
    return withLocalization(
      projected,
      expectedBuildLocalization(
        plannedLocalizationId('planned-beta-build-localization', projected),
        review,
      ),
    );
  }

  if (sameSelectedAttributes(attributesOf(existing), expected)) {
    actions.push({
      detail: `${review.locale} What to Test text already matches build ${build.id}.`,
      kind: 'beta-build-localization',
      status: 'unchanged',
    });
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete('build-localization');
    }
    return projected;
  }
  actions.push({
    detail: `Update ${review.locale} What to Test text for build ${build.id}.`,
    kind: 'beta-build-localization',
    status: actionStatus(apply),
  });
  if (apply) {
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its build-localization assertion.');
    }
    rateBudget.assertStageStart(assertionClient, 'build-localization');
    await assertExactLiveLocalizationState();
    rateBudget.assertBeforeMutation(assertionClient, 'build-localization');
    const updated = await client.mutate(
      'PATCH',
      `/v1/betaBuildLocalizations/${encodeURIComponent(existing.id)}`,
      {
        data: {
          attributes: expected,
          id: existing.id,
          type: 'betaBuildLocalizations',
        },
      },
      'betaBuildLocalizations',
    );
    if (updated === null || updated.id !== existing.id) {
      throw new Error('Apple did not return the beta build localization.');
    }
    await assertBuildLocalizationRelationship(
      assertionClient,
      updated.id,
      build.id,
    );
    const projectedUpdated = projectBuildLocalization(updated);
    const expectedUpdated = expectedBuildLocalization(existing.id, review);
    if (canonicalJson(projectedUpdated) !== canonicalJson(expectedUpdated)) {
      throw new Error(
        'Apple returned unexpected beta build localization attributes.',
      );
    }
    rateBudget.complete('build-localization');
    return withLocalization(projected, projectedUpdated, existing.id);
  }
  return withLocalization(
    projected,
    expectedBuildLocalization(existing.id, review),
    existing.id,
  );
};

const assertCompleteLocalizationEvidence = async (
  client: AscClient,
  appId: string,
  build: JsonApiResource | null,
  expected: LocalizationEvidence,
): Promise<void> => {
  const currentApp = projectLocalizationInventory(
    await listVerifiedBetaAppLocalizationsForApp(client, appId),
    'app',
  );
  assertSameLocalizationInventory(
    currentApp,
    expected.appLocalizations,
    'Complete beta app localization inventory',
  );
  if (build === null) {
    if (expected.buildLocalizations !== undefined) {
      throw new Error('Unexpected beta build localization evidence.');
    }
    return;
  }
  if (expected.buildLocalizations === undefined) {
    throw new Error('Missing complete beta build localization evidence.');
  }
  const currentBuild = projectLocalizationInventory(
    await listVerifiedBetaBuildLocalizations(client, build.id),
    'build',
  );
  assertSameLocalizationInventory(
    currentBuild,
    expected.buildLocalizations,
    'Complete beta build localization inventory',
  );
};

const assertExpectedBuildLocalization = async (
  client: AscClient,
  build: JsonApiResource,
  review: BetaReviewInfo,
): Promise<void> => {
  const localizations = await listVerifiedBetaBuildLocalizations(
    client,
    build.id,
  );
  const matching = localizations.filter(
    (localization) =>
      localization.type === 'betaBuildLocalizations' &&
      attributesOf(localization).locale === review.locale,
  );
  if (
    localizations.some(({ type }) => type !== 'betaBuildLocalizations') ||
    matching.length !== 1 ||
    !sameSelectedAttributes(
      attributesOf(matching[0] as JsonApiResource),
      buildLocalizationAttributes(review),
    )
  ) {
    throw new Error(
      'Selected build What to Test localization does not match the approved value.',
    );
  }
};

const INTERNAL_BETA_STATES = new Set([
  'PROCESSING',
  'PROCESSING_EXCEPTION',
  'MISSING_EXPORT_COMPLIANCE',
  'READY_FOR_BETA_TESTING',
  'IN_BETA_TESTING',
  'EXPIRED',
  'IN_EXPORT_COMPLIANCE_REVIEW',
]);
const EXTERNAL_BETA_STATES = new Set([
  'PROCESSING',
  'PROCESSING_EXCEPTION',
  'MISSING_EXPORT_COMPLIANCE',
  'READY_FOR_BETA_TESTING',
  'IN_BETA_TESTING',
  'EXPIRED',
  'READY_FOR_BETA_SUBMISSION',
  'IN_EXPORT_COMPLIANCE_REVIEW',
  'WAITING_FOR_BETA_REVIEW',
  'IN_BETA_REVIEW',
  'BETA_REJECTED',
  'BETA_APPROVED',
  'NOT_APPLICABLE',
]);

const requireBuildBetaStates = (
  detail: JsonApiResource,
): { externalBuildState: string; internalBuildState: string } => {
  const attributes = attributesOf(detail);
  const internalBuildState = attributes.internalBuildState;
  const externalBuildState = attributes.externalBuildState;
  if (
    typeof internalBuildState !== 'string' ||
    !INTERNAL_BETA_STATES.has(internalBuildState) ||
    typeof externalBuildState !== 'string' ||
    !EXTERNAL_BETA_STATES.has(externalBuildState)
  ) {
    throw new Error('Apple returned an unknown build beta state.');
  }
  if (
    internalBuildState !== 'READY_FOR_BETA_TESTING' &&
    internalBuildState !== 'IN_BETA_TESTING'
  ) {
    throw new Error(
      'The selected build is not ready for internal beta testing; export-compliance answers remain a human action.',
    );
  }
  return { externalBuildState, internalBuildState };
};

const resolveBuild = async (
  client: AscClient,
  appId: string,
  build: string,
): Promise<JsonApiResource> => {
  const parameters: Record<string, string> = {
    'fields[builds]':
      'version,uploadedDate,expired,processingState,buildAudienceType,usesNonExemptEncryption',
    'filter[app]': appId,
    'filter[expired]': 'false',
    'filter[preReleaseVersion.platform]': 'IOS',
    'filter[processingState]': 'VALID',
    limit: build === 'latest' ? '1' : '2',
  };
  if (build === 'latest') parameters.sort = '-uploadedDate';
  else parameters['filter[id]'] = build;
  const builds =
    build === 'latest'
      ? null
      : await client.list(appendQuery('/v1/builds', parameters));
  const selected =
    build === 'latest'
      ? await client.first(appendQuery('/v1/builds', parameters))
      : builds?.[0];
  if (
    selected === undefined ||
    selected === null ||
    selected.type !== 'builds' ||
    (build !== 'latest' && (builds?.length !== 1 || selected.id !== build)) ||
    attributesOf(selected).expired !== false ||
    attributesOf(selected).processingState !== 'VALID'
  ) {
    throw new Error(
      build === 'latest'
        ? 'No single processed, non-expired TestFlight build is available.'
        : 'The requested processed, non-expired TestFlight build was not found.',
    );
  }
  const selectedAttributes = attributesOf(selected);
  if (
    typeof selectedAttributes.version !== 'string' ||
    !/^[A-Za-z0-9._+-]{1,100}$/u.test(selectedAttributes.version) ||
    typeof selectedAttributes.uploadedDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
      selectedAttributes.uploadedDate,
    ) ||
    typeof selectedAttributes.usesNonExemptEncryption !== 'boolean' ||
    (selectedAttributes.buildAudienceType !== 'APP_STORE_ELIGIBLE' &&
      selectedAttributes.buildAudienceType !== 'INTERNAL_ONLY')
  ) {
    throw new Error('Apple returned malformed selected-build metadata.');
  }
  const selectedApp = await client.get(
    `/v1/builds/${encodeURIComponent(selected.id)}/app`,
    'apps',
  );
  if (selectedApp.id !== appId) {
    throw new Error('The selected build does not belong to the PSD EOC app.');
  }
  const preReleaseVersion = await client.get(
    appendQuery(
      `/v1/builds/${encodeURIComponent(selected.id)}/preReleaseVersion`,
      { 'fields[preReleaseVersions]': 'platform' },
    ),
    'preReleaseVersions',
  );
  await assertPreReleaseVersionScope(
    client,
    preReleaseVersion.id,
    appId,
    selected.id,
  );
  if (attributesOf(preReleaseVersion).platform !== 'IOS') {
    throw new Error('The selected build is not positively identified as iOS.');
  }
  const betaDetail = await client.get(
    appendQuery(
      `/v1/builds/${encodeURIComponent(selected.id)}/buildBetaDetail`,
      {
        'fields[buildBetaDetails]':
          'autoNotifyEnabled,internalBuildState,externalBuildState',
      },
    ),
    'buildBetaDetails',
  );
  await assertBuildBetaDetailBelongsToBuild(client, betaDetail.id, selected.id);
  const states = requireBuildBetaStates(betaDetail);
  return canonicalResource({
    ...selected,
    attributes: { ...selectedAttributes, ...states, platform: 'IOS' },
  });
};

const assertLiveBuildStillMatches = async (
  client: AscClient,
  appId: string,
  expectedBuild: JsonApiResource,
): Promise<JsonApiResource> => {
  const liveBuild = await resolveBuild(client, appId, expectedBuild.id);
  const expected = attributesOf(expectedBuild);
  const live = attributesOf(liveBuild);
  if (
    liveBuild.id !== expectedBuild.id ||
    !sameSelectedAttributes(live, {
      buildAudienceType: expected.buildAudienceType,
      expired: false,
      platform: expected.platform,
      processingState: 'VALID',
      uploadedDate: expected.uploadedDate,
      usesNonExemptEncryption: expected.usesNonExemptEncryption,
      version: expected.version,
    })
  ) {
    throw new Error('Selected build metadata changed before distribution.');
  }
  return liveBuild;
};

const buildSummary = (
  build: JsonApiResource,
): NonNullable<SyncResult['selectedBuild']> => {
  const attributes = attributesOf(build);
  const version = attributes.version;
  const uploadedDate = attributes.uploadedDate;
  const audienceType = attributes.buildAudienceType;
  const externalBuildState = attributes.externalBuildState;
  const internalBuildState = attributes.internalBuildState;
  const platform = attributes.platform;
  const usesNonExemptEncryption = attributes.usesNonExemptEncryption;
  if (
    typeof externalBuildState !== 'string' ||
    typeof internalBuildState !== 'string' ||
    platform !== 'IOS' ||
    typeof usesNonExemptEncryption !== 'boolean'
  ) {
    throw new Error('Selected build readiness metadata was not captured.');
  }
  return {
    externalBuildState,
    id: build.id,
    internalBuildState,
    platform,
    usesNonExemptEncryption,
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof uploadedDate === 'string' ? { uploadedDate } : {}),
    ...(typeof audienceType === 'string' ? { audienceType } : {}),
  };
};

const ensureManualExternalNotification = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  build: JsonApiResource,
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<string> => {
  const path = appendQuery(
    `/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`,
    { 'fields[buildBetaDetails]': 'autoNotifyEnabled' },
  );
  const detail = await client.get(path, 'buildBetaDetails');
  await assertBuildBetaDetailBelongsToBuild(client, detail.id, build.id);
  const autoNotifyEnabled = attributesOf(detail).autoNotifyEnabled;
  if (typeof autoNotifyEnabled !== 'boolean') {
    throw new Error(
      'Apple did not provide the external tester notification setting; no changes were made.',
    );
  }
  if (!autoNotifyEnabled) {
    actions.push({
      detail:
        'Automatic external tester notifications are disabled; notifying testers remains a separate human action.',
      kind: 'build-notification-safety',
      status: 'unchanged',
    });
  } else {
    actions.push({
      detail:
        'Disable automatic external tester notifications before review; notifying testers remains a separate human action.',
      kind: 'build-notification-safety',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its notification assertion client.');
      }
      rateBudget.assertStageStart(assertionClient, 'external-notification');
      const current = canonicalResource(
        await assertionClient.get(path, 'buildBetaDetails'),
      );
      if (canonicalJson(current) !== canonicalJson(detail)) {
        throw new Error(
          'Automatic external tester notification state changed after confirmation.',
        );
      }
      await assertBuildBetaDetailBelongsToBuild(
        assertionClient,
        current.id,
        build.id,
      );
      await assertExactAppIdentity(assertionClient, appId);
      rateBudget.assertBeforeMutation(assertionClient, 'external-notification');
      const updated = await client.mutate(
        'PATCH',
        `/v1/buildBetaDetails/${encodeURIComponent(detail.id)}`,
        {
          data: {
            attributes: { autoNotifyEnabled: false },
            id: detail.id,
            type: 'buildBetaDetails',
          },
        },
        'buildBetaDetails',
      );
      if (updated === null || updated.id !== detail.id) {
        throw new Error('Apple did not return the updated build beta details.');
      }
      await assertBuildBetaDetailBelongsToBuild(
        assertionClient,
        updated.id,
        build.id,
      );
    }
  }
  if (apply) {
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its notification assertion client.');
    }
    const verified = await assertionClient.get(path, 'buildBetaDetails');
    await assertBuildBetaDetailBelongsToBuild(
      assertionClient,
      verified.id,
      build.id,
    );
    if (
      verified.id !== detail.id ||
      attributesOf(verified).autoNotifyEnabled !== false
    ) {
      throw new Error(
        'Automatic external tester notification disablement could not be verified.',
      );
    }
    rateBudget.complete('external-notification');
  }
  return detail.id;
};

const verifyGroupReadyForBuild = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
  approved: readonly Tester[],
  expectedBuilds: readonly JsonApiResource[],
): Promise<readonly JsonApiResource[]> => {
  if (target.id === null) throw new Error('Apply has no verified group ID.');
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  const matches = groups.filter(({ id }) => id === target.id);
  if (
    !hasExactManagedGroupInventory(groups) ||
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups') ||
    matches.length !== 1 ||
    !hasSafeGroupSettings(
      matches[0] as JsonApiResource,
      target.name,
      target.internal,
    )
  ) {
    throw new Error(
      'Managed group settings changed before build distribution.',
    );
  }
  const currentTesters = await listVerifiedGroupTesters(client, target.id);
  const currentBuilds = await listVerifiedGroupBuilds(client, appId, target.id);
  const actualEmails = currentTesters.map(testerEmail).sort();
  const approvedEmails = approved.map(({ email }) => email).sort();
  if (!sameStrings(actualEmails, approvedEmails)) {
    throw new Error(
      'Managed group audience or builds changed before distribution.',
    );
  }
  assertSameGroupBuildInventory(currentBuilds, expectedBuilds);
  return canonicalResources(currentTesters);
};

const verifyExternalNotificationStillDisabled = async (
  client: AscClient,
  build: JsonApiResource,
  expectedDetailId: string,
): Promise<void> => {
  const detail = await client.get(
    appendQuery(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`, {
      'fields[buildBetaDetails]': 'autoNotifyEnabled',
    }),
    'buildBetaDetails',
  );
  await assertBuildBetaDetailBelongsToBuild(client, detail.id, build.id);
  if (
    detail.id !== expectedDetailId ||
    attributesOf(detail).autoNotifyEnabled !== false
  ) {
    throw new Error(
      'Automatic external tester notifications changed before distribution.',
    );
  }
};

const attachBuild = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  target: GroupTarget,
  build: JsonApiResource,
  approvedAudience: readonly Tester[],
  expectedBuilds: readonly JsonApiResource[],
  testerInventoryState: AppWideTesterInventoryState,
  internalDesired: readonly Tester[],
  externalDesired: readonly Tester[],
  review: BetaReviewInfo | undefined,
  localizationEvidence: LocalizationEvidence | undefined,
  external: boolean,
  notificationDetailId: string | undefined,
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<readonly JsonApiResource[]> => {
  const rateStage: ApplyRateStage = external
    ? 'external-build'
    : 'internal-build';
  const { id: groupId, name: groupName } = target;
  const approvedAudienceCount = approvedAudience.length;
  const consequence = external
    ? `grant access to ${approvedAudienceCount} approved external tester(s); automatic notification stays disabled until a fresh human action`
    : `grant access to ${approvedAudienceCount} approved internal tester(s) and may send real TestFlight invitation email`;
  const linked = canonicalGroupBuildInventory(expectedBuilds);
  if (linked.some((item) => item.type === 'builds' && item.id === build.id)) {
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      if (external) {
        if (
          assertionClient === undefined ||
          groupId === null ||
          notificationDetailId === undefined
        ) {
          throw new Error(
            'External review lacks its live distribution assertions.',
          );
        }
        rateBudget.assertStageStart(assertionClient, rateStage);
        await verifyGroupReadyForBuild(
          assertionClient,
          appId,
          target,
          approvedAudience,
          linked,
        );
        await verifyExternalNotificationStillDisabled(
          assertionClient,
          build,
          notificationDetailId,
        );
      }
      rateBudget.complete(rateStage);
    }
    actions.push({
      detail: `Selected build is already distributed to ${groupName}.`,
      kind: 'build-distribution',
      status: 'unchanged',
    });
    return canonicalResources(linked);
  }
  if (linked.length >= MAX_GROUP_BUILDS) {
    throw new Error(
      'Managed group build inventory has no safe capacity for an additive write.',
    );
  }
  actions.push({
    detail: `Distribute build ${build.id} to ${groupName}; ${consequence}.`,
    kind: 'build-distribution',
    status: actionStatus(apply),
  });
  if (apply) {
    if (
      assertionClient === undefined ||
      groupId === null ||
      rateBudget === undefined
    ) {
      throw new Error('Apply is missing its build-distribution assertion.');
    }
    if (review === undefined) {
      throw new Error('Build distribution is missing approved What to Test.');
    }
    if (localizationEvidence === undefined) {
      throw new Error(
        'Build distribution is missing complete localization evidence.',
      );
    }
    rateBudget.assertStageStart(assertionClient, rateStage);
    const expectedTargetTesters = await verifyGroupReadyForBuild(
      assertionClient,
      appId,
      target,
      approvedAudience,
      linked,
    );
    await assertExpectedBuildLocalization(assertionClient, build, review);
    await assertLiveBuildStillMatches(assertionClient, appId, build);
    await assertCompleteLocalizationEvidence(
      assertionClient,
      appId,
      build,
      localizationEvidence,
    );
    testerInventoryState.current = await assertEquivalentAppTesterInventory(
      assertionClient,
      appId,
      testerInventoryState.current,
      internalDesired,
      externalDesired,
    );
    await assertExactAppIdentity(assertionClient, appId);
    if (external) {
      if (notificationDetailId === undefined) {
        throw new Error('External distribution lacks notification evidence.');
      }
      await verifyExternalNotificationStillDisabled(
        assertionClient,
        build,
        notificationDetailId,
      );
    }
    await verifyTargetGroupSnapshotBeforeBuildWrite(
      assertionClient,
      appId,
      target,
      expectedTargetTesters,
      linked,
    );
    rateBudget.assertBeforeMutation(assertionClient, rateStage);
    const relationshipResult = await client.mutate(
      'POST',
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
      { data: [{ id: build.id, type: 'builds' }] },
    );
    if (relationshipResult !== null) {
      throw new Error(
        'Apple build relationship mutation outcome is indeterminate.',
      );
    }
    const expectedAfter = canonicalGroupBuildInventory([...linked, build]);
    const readback = await listVerifiedGroupBuilds(
      assertionClient,
      appId,
      groupId,
    );
    assertSameGroupBuildInventory(readback, expectedAfter);
    rateBudget.complete(rateStage);
    return expectedAfter;
  }
  return canonicalGroupBuildInventory([...linked, build]);
};

const betaReviewSubmissionsPath = (buildId: string): string =>
  appendQuery('/v1/betaAppReviewSubmissions', {
    'fields[betaAppReviewSubmissions]': 'betaReviewState',
    'filter[build]': buildId,
    limit: '200',
  });

const projectBetaReviewSubmission = (
  submission: JsonApiResource,
): JsonApiResource => {
  if (submission.type !== 'betaAppReviewSubmissions') {
    throw new Error(
      'Apple returned an unexpected Beta App Review submission resource.',
    );
  }
  requireOpaqueIdentifier(submission.id, 'Beta App Review submission ID');
  const state = attributesOf(submission).betaReviewState;
  if (state === 'REJECTED') {
    throw new Error(
      'The selected build was rejected by Beta App Review; choose a corrected build.',
    );
  }
  if (
    state !== 'WAITING_FOR_REVIEW' &&
    state !== 'IN_REVIEW' &&
    state !== 'APPROVED'
  ) {
    throw new Error('Apple returned an unknown Beta App Review state.');
  }
  return canonicalResource({
    attributes: { betaReviewState: state },
    id: submission.id,
    type: 'betaAppReviewSubmissions',
  });
};

const assertSubmissionBuildRelationship = async (
  client: AscClient,
  submissionId: string,
  buildId: string,
): Promise<void> => {
  const relatedBuild = await client.get(
    `/v1/betaAppReviewSubmissions/${encodeURIComponent(submissionId)}/build`,
    'builds',
  );
  if (relatedBuild.id !== buildId) {
    throw new Error(
      'Beta App Review submission does not belong to the selected exact build.',
    );
  }
};

const readVerifiedBetaReviewSubmissions = async (
  client: AscClient,
  buildId: string,
): Promise<readonly JsonApiResource[]> => {
  const returned = validateBoundedResourceInventory(
    await client.list(betaReviewSubmissionsPath(buildId)),
    'betaAppReviewSubmissions',
    'Beta App Review submission',
    1,
  );
  const projected: JsonApiResource[] = [];
  for (const submission of returned) {
    await assertSubmissionBuildRelationship(client, submission.id, buildId);
    projected.push(projectBetaReviewSubmission(submission));
  }
  return canonicalResources(projected);
};

const existingSubmissionState = (
  submissions: readonly JsonApiResource[],
): string | null => {
  if (submissions.length === 0) return null;
  if (submissions.length !== 1) {
    throw new Error('Apple returned ambiguous Beta App Review submissions.');
  }
  const state = attributesOf(
    projectBetaReviewSubmission(submissions[0] as JsonApiResource),
  ).betaReviewState as string;
  return state;
};

const assertExpectedReviewInfo = async (
  client: AscClient,
  appId: string,
  review: BetaReviewInfo,
): Promise<void> => {
  const details = await client.get(
    `/v1/apps/${encodeURIComponent(appId)}/betaAppReviewDetail`,
    'betaAppReviewDetails',
  );
  await assertBetaAppReviewDetailBelongsToApp(client, details.id, appId);
  if (
    !sameSelectedAttributes(attributesOf(details), reviewAttributes(review))
  ) {
    throw new Error('Beta App Review details changed before submission.');
  }
  const localizations = await listVerifiedBetaAppLocalizationsForApp(
    client,
    appId,
  );
  if (localizations.some(({ type }) => type !== 'betaAppLocalizations')) {
    throw new Error('Beta app localization changed before submission.');
  }
  for (const localization of localizations) {
    const description = attributesOf(localization).description;
    if (typeof description !== 'string' || description.trim() === '') {
      throw new Error(
        'Every beta localization needs an approved description before review.',
      );
    }
  }
  const matching = localizations.filter(
    (localization) =>
      localization.type === 'betaAppLocalizations' &&
      attributesOf(localization).locale === review.locale,
  );
  if (
    matching.length !== 1 ||
    !sameSelectedAttributes(
      attributesOf(matching[0] as JsonApiResource),
      localizationAttributes(review),
    )
  ) {
    throw new Error('Beta app localization changed before submission.');
  }
};

const assertReadyForNewBetaReview = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
  approvedAudience: readonly Tester[],
  expectedBuilds: readonly JsonApiResource[],
  build: JsonApiResource,
  review: BetaReviewInfo,
  localizationEvidence: LocalizationEvidence,
  testerInventoryState: AppWideTesterInventoryState,
  internalDesired: readonly Tester[],
  externalDesired: readonly Tester[],
  notificationDetailId: string,
): Promise<void> => {
  await assertExactAppIdentity(client, appId);
  const liveBuild = await assertLiveBuildStillMatches(client, appId, build);
  const liveBuildAttributes = attributesOf(liveBuild);
  if (liveBuildAttributes.externalBuildState !== 'READY_FOR_BETA_SUBMISSION') {
    throw new Error(
      'The selected build is not positively ready for a new Beta App Review submission.',
    );
  }
  const detail = await client.get(
    appendQuery(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`, {
      'fields[buildBetaDetails]':
        'autoNotifyEnabled,internalBuildState,externalBuildState',
    }),
    'buildBetaDetails',
  );
  await assertBuildBetaDetailBelongsToBuild(client, detail.id, build.id);
  if (
    detail.id !== notificationDetailId ||
    attributesOf(detail).autoNotifyEnabled !== false
  ) {
    throw new Error(
      'Automatic external tester notifications changed before Beta App Review.',
    );
  }
  const states = requireBuildBetaStates(detail);
  if (
    states.internalBuildState !== liveBuildAttributes.internalBuildState ||
    states.externalBuildState !== liveBuildAttributes.externalBuildState
  ) {
    throw new Error('Selected build beta states changed before review.');
  }
  await verifyGroupReadyForBuild(
    client,
    appId,
    target,
    approvedAudience,
    expectedBuilds,
  );
  await assertExpectedReviewInfo(client, appId, review);
  await assertExpectedBuildLocalization(client, build, review);
  await assertCompleteLocalizationEvidence(
    client,
    appId,
    build,
    localizationEvidence,
  );
  testerInventoryState.current = await assertEquivalentAppTesterInventory(
    client,
    appId,
    testerInventoryState.current,
    internalDesired,
    externalDesired,
  );

  // This relationship-bound inventory must remain the final provider evidence
  // before the submission POST.
  const submissions = await readVerifiedBetaReviewSubmissions(client, build.id);
  if (submissions.length !== 0) {
    throw new Error(
      'Beta App Review submission state changed before the confirmed POST.',
    );
  }
};

const submitForBetaReview = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  target: GroupTarget,
  approvedAudience: readonly Tester[],
  expectedBuilds: readonly JsonApiResource[],
  build: JsonApiResource,
  review: BetaReviewInfo,
  localizationEvidence: LocalizationEvidence,
  testerInventoryState: AppWideTesterInventoryState,
  internalDesired: readonly Tester[],
  externalDesired: readonly Tester[],
  notificationDetailId: string,
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<JsonApiResource | null> => {
  if (apply) {
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its final Beta Review assertions.');
    }
    rateBudget.assertStageStart(assertionClient, 'beta-review-submission');
  }
  const submissions = await readVerifiedBetaReviewSubmissions(client, build.id);
  const state = existingSubmissionState(submissions);
  if (state !== null) {
    actions.push({
      detail: `Selected build Beta App Review state is ${state}.`,
      kind: 'beta-review-submission',
      status: 'unchanged',
    });
    if (apply) {
      (rateBudget as ApplyRateBudget).complete('beta-review-submission');
    }
    return submissions[0] as JsonApiResource;
  }
  if (attributesOf(build).externalBuildState !== 'READY_FOR_BETA_SUBMISSION') {
    throw new Error(
      'A new Beta App Review submission requires external state READY_FOR_BETA_SUBMISSION.',
    );
  }
  actions.push({
    detail: 'Submit the selected build for external Beta App Review.',
    kind: 'beta-review-submission',
    status: actionStatus(apply),
  });
  if (apply) {
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its final Beta Review assertions.');
    }
    await assertReadyForNewBetaReview(
      assertionClient,
      appId,
      target,
      approvedAudience,
      expectedBuilds,
      build,
      review,
      localizationEvidence,
      testerInventoryState,
      internalDesired,
      externalDesired,
      notificationDetailId,
    );
    rateBudget.assertBeforeMutation(assertionClient, 'beta-review-submission');
    const created = await client.mutate(
      'POST',
      '/v1/betaAppReviewSubmissions',
      {
        data: {
          relationships: { build: { data: { id: build.id, type: 'builds' } } },
          type: 'betaAppReviewSubmissions',
        },
      },
      'betaAppReviewSubmissions',
    );
    if (created === null) {
      throw new Error('Apple did not return the Beta App Review submission.');
    }
    const projectedCreated = projectBetaReviewSubmission(created);
    await assertSubmissionBuildRelationship(
      assertionClient,
      projectedCreated.id,
      build.id,
    );
    const readback = await readVerifiedBetaReviewSubmissions(
      assertionClient,
      build.id,
    );
    if (readback.length !== 1 || readback[0]?.id !== projectedCreated.id) {
      throw new Error(
        'Apple did not verify the created Beta App Review submission.',
      );
    }
    rateBudget.complete('beta-review-submission');
    return readback[0];
  }
  return null;
};

const assertApp = (apps: readonly JsonApiResource[]): JsonApiResource => {
  const app = apps[0];
  if (
    apps.length !== 1 ||
    app === undefined ||
    app.type !== 'apps' ||
    attributesOf(app).bundleId !== BUNDLE_ID ||
    attributesOf(app).name !== APP_NAME ||
    attributesOf(app).sku !== APP_SKU
  ) {
    throw new Error(
      `Expected exactly one App Store Connect app named ${APP_NAME} with bundle ID ${BUNDLE_ID} and SKU ${APP_SKU}.`,
    );
  }
  return app;
};

const assertExactAppIdentity = async (
  client: AscClient,
  expectedAppId: string,
): Promise<JsonApiResource> => {
  const app = assertApp(await client.list(appIdentityPath()));
  if (app.id !== expectedAppId) {
    throw new Error('The exact App Store Connect app identity changed.');
  }
  return app;
};

const verifyAppliedState = async (
  client: AscClient,
  appId: string,
  options: ReconcileOptions,
  build: JsonApiResource | null,
  localizationEvidence: LocalizationEvidence | undefined,
  expectedTesterInventory: AppWideTesterInventory,
  expectedInternalBuilds: readonly JsonApiResource[],
  expectedExternalBuilds: readonly JsonApiResource[],
  expectedSubmission: JsonApiResource | null,
  downstreamDeferred: boolean,
): Promise<void> => {
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  if (
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups')
  ) {
    throw new Error('Apply verification found an unsafe group inventory.');
  }
  if (build !== null && !hasExactManagedGroupInventory(groups)) {
    throw new Error(
      'Apply verification found an unmanaged TestFlight group during build distribution.',
    );
  }
  const find = (name: string, internal: boolean): JsonApiResource => {
    const matches = groups.filter(
      (group) =>
        group.type === 'betaGroups' &&
        attributesOf(group).name === name &&
        attributesOf(group).isInternalGroup === internal,
    );
    if (matches.length !== 1)
      throw new Error(`Apply verification failed for ${name}.`);
    const match = matches[0] as JsonApiResource;
    const expected: JsonObject = {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      ...(internal ? {} : { publicLinkEnabled: false }),
    };
    if (!sameSelectedAttributes(attributesOf(match), expected)) {
      throw new Error(`Apply verification found unsafe settings for ${name}.`);
    }
    return match;
  };
  const internal = find(INTERNAL_GROUP_NAME, true);
  const external = find(EXTERNAL_GROUP_NAME, false);

  for (const [group, name] of [
    [internal, INTERNAL_GROUP_NAME],
    [external, EXTERNAL_GROUP_NAME],
  ] as const) {
    const actual = await listVerifiedGroupTesters(client, group.id);
    const expectedMemberships = expectedTesterInventory.groupMemberships
      .filter(({ groupId }) => groupId === group.id)
      .map((membership) => {
        if (membership.email === undefined) {
          throw new Error(
            `Apply verification is missing a tester identity in ${name}.`,
          );
        }
        return `${membership.id}:${membership.email}`;
      })
      .sort();
    const actualMemberships = actual
      .map((tester) => `${tester.id}:${testerEmail(tester)}`)
      .sort();
    if (!sameStrings(actualMemberships, expectedMemberships)) {
      throw new Error(`Apply verification found a roster mismatch in ${name}.`);
    }
  }
  assertSameGroupBuildInventory(
    await listVerifiedGroupBuilds(client, appId, internal.id),
    expectedInternalBuilds,
  );
  assertSameGroupBuildInventory(
    await listVerifiedGroupBuilds(client, appId, external.id),
    expectedExternalBuilds,
  );
  if (downstreamDeferred) {
    if (localizationEvidence !== undefined || expectedSubmission !== null) {
      throw new Error('Deferred downstream work produced unexpected evidence.');
    }
  } else if (options.reviewInfo !== undefined) {
    const details = await client.get(
      `/v1/apps/${encodeURIComponent(appId)}/betaAppReviewDetail`,
      'betaAppReviewDetails',
    );
    await assertBetaAppReviewDetailBelongsToApp(client, details.id, appId);
    if (
      !sameSelectedAttributes(
        attributesOf(details),
        reviewAttributes(options.reviewInfo),
      )
    ) {
      throw new Error(
        'Apply verification found Beta App Review details mismatched.',
      );
    }
    if (localizationEvidence === undefined) {
      throw new Error('Apply verification is missing localization evidence.');
    }
    await assertCompleteLocalizationEvidence(
      client,
      appId,
      build,
      localizationEvidence,
    );
  } else if (localizationEvidence !== undefined) {
    throw new Error(
      'Apply verification found unexpected localization evidence.',
    );
  }
  if (!downstreamDeferred && options.submitBetaReview && build !== null) {
    const notificationDetail = await client.get(
      appendQuery(
        `/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`,
        { 'fields[buildBetaDetails]': 'autoNotifyEnabled' },
      ),
      'buildBetaDetails',
    );
    await assertBuildBetaDetailBelongsToBuild(
      client,
      notificationDetail.id,
      build.id,
    );
    if (attributesOf(notificationDetail).autoNotifyEnabled !== false) {
      throw new Error(
        'Apply verification found automatic external tester notifications enabled.',
      );
    }
    const submissions = await readVerifiedBetaReviewSubmissions(
      client,
      build.id,
    );
    if (
      expectedSubmission === null ||
      submissions.length !== 1 ||
      submissions[0]?.id !== expectedSubmission.id ||
      existingSubmissionState(submissions) === null
    ) {
      throw new Error(
        'Apply verification found no exact Beta App Review submission.',
      );
    }
  } else if (expectedSubmission !== null) {
    throw new Error('Apply verification found unexpected review evidence.');
  }
  await assertEquivalentAppTesterInventory(
    client,
    appId,
    expectedTesterInventory,
    options.internalTesters,
    options.externalTesters,
  );
  await assertExactAppIdentity(client, appId);
};

const verifyManagedGroupInventoryBeforeMutation = async (
  client: AscClient,
  appId: string,
  snapshot: ManagedGroupSnapshot,
): Promise<void> => {
  if (snapshot.target.id === null) return;
  await assertBetaGroupBelongsToApp(client, snapshot.target.id, appId);
  const currentTesters = await listVerifiedGroupTesters(
    client,
    snapshot.target.id,
  );
  const currentBuilds = await listVerifiedGroupBuilds(
    client,
    appId,
    snapshot.target.id,
  );
  if (
    !sameStrings(
      resourceIdentitySet(snapshot.testers, 'betaTesters', 'tester'),
      resourceIdentitySet(currentTesters, 'betaTesters', 'tester'),
    ) ||
    !sameStrings(
      resourceIdentitySet(snapshot.builds, 'builds', 'group build'),
      resourceIdentitySet(currentBuilds, 'builds', 'group build'),
    )
  ) {
    throw new Error(
      'Managed group audience or builds changed after confirmation; no mutations were attempted.',
    );
  }
};

const reconcileTestFlight = async (
  client: AscClient,
  options: ReconcileOptions,
  assertionClient?: AscClient,
  beforeVerification?: () => void,
  confirmedTesterWriteLimit?: number,
  captureTesterWriteLimit?: (limit: number) => void,
): Promise<ReconcileResult> => {
  if (
    options.submitBetaReview &&
    (options.reviewInfo === undefined || options.build === undefined)
  ) {
    throw new Error(
      'Beta App Review submission requires review info and a build.',
    );
  }
  if (options.submitBetaReview && options.build === 'latest') {
    throw new Error(
      'Beta App Review requires an exact build ID reviewed by the operator; latest is discovery-only.',
    );
  }
  if (
    options.build !== undefined &&
    options.build !== 'latest' &&
    options.reviewInfo === undefined
  ) {
    throw new Error(
      'An exact build plan or apply requires approved review info, including What to Test text.',
    );
  }
  if (options.apply && options.build === 'latest') {
    throw new Error(
      'Apply requires the exact build ID returned by a prior latest-build preview.',
    );
  }
  if (options.internalTesters.length > MAX_INTERNAL_TESTERS) {
    throw new Error("Internal tester input exceeds Apple's 100-user limit.");
  }
  if (
    options.internalTesters.length + options.externalTesters.length >
    MAX_APPROVED_TESTERS
  ) {
    throw new Error('Combined tester input exceeds the approved PSD limit.');
  }
  const allTesterEmails = [
    ...options.internalTesters.map(({ email }) => email),
    ...options.externalTesters.map(({ email }) => email),
  ];
  if (new Set(allTesterEmails).size !== allTesterEmails.length) {
    throw new Error(
      'Tester inputs must be unique and cannot cross internal/external groups.',
    );
  }
  const apps = await client.list(appIdentityPath());
  const app = assertApp(apps);
  const build =
    options.build === undefined
      ? null
      : await resolveBuild(client, app.id, options.build);
  if (
    options.submitBetaReview &&
    build !== null &&
    attributesOf(build).buildAudienceType !== 'APP_STORE_ELIGIBLE'
  ) {
    throw new Error(
      'External Beta App Review requires an APP_STORE_ELIGIBLE build.',
    );
  }
  const actions: SyncAction[] = [];
  await preflightInternalTesters(
    client,
    app.id,
    options.internalTesters,
    actions,
  );
  const groups = await listVerifiedBetaGroupsForApp(client, app.id);
  if (
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups')
  ) {
    throw new Error('Apple returned an unsafe beta-group inventory.');
  }
  if (
    build !== null &&
    groups.some((group) => !isManagedGroupIdentity(group))
  ) {
    throw new Error(
      'Build distribution requires an app inventory containing only the two managed TestFlight groups; no changes were made.',
    );
  }
  const groupInventoryState: BetaGroupInventoryState = { current: groups };
  const requiredGroupCreations = (
    [
      [INTERNAL_GROUP_NAME, true],
      [EXTERNAL_GROUP_NAME, false],
    ] as const
  ).filter(
    ([name, internal]) =>
      !groups.some(
        (group) =>
          attributesOf(group).name === name &&
          attributesOf(group).isInternalGroup === internal,
      ),
  ).length;
  if (groups.length + requiredGroupCreations > MAX_GROUPS) {
    throw new Error(
      'App beta-group inventory has no safe capacity for required group creation.',
    );
  }
  const expectedTesterInventory = await inventoryAppTesterCapacity(
    client,
    app.id,
    groups,
    options.internalTesters,
    options.externalTesters,
  );
  const testerIdentityRegistry = new TesterIdentityAudienceRegistry(
    expectedTesterInventory,
  );
  const accountTesterByEmail = await collectAccountBetaTesters(
    client,
    testerIdentityRegistry,
    options.internalTesters.length + options.externalTesters.length > 0,
  );
  const internalGroupSnapshot = await collectManagedGroupSnapshot(
    client,
    app.id,
    groups,
    INTERNAL_GROUP_NAME,
    true,
  );
  const externalGroupSnapshot = await collectManagedGroupSnapshot(
    client,
    app.id,
    groups,
    EXTERNAL_GROUP_NAME,
    false,
  );
  const testerInventoryState: AppWideTesterInventoryState = {
    current: expectedTesterInventory,
  };
  const testerWritePlan = planTesterWriteChunk(
    groups,
    expectedTesterInventory,
    accountTesterByEmail,
    internalGroupSnapshot,
    externalGroupSnapshot,
    options.internalTesters,
    options.externalTesters,
    client.rateLimitRemaining(),
    confirmedTesterWriteLimit,
  );
  captureTesterWriteLimit?.(testerWritePlan.selected.length);
  if (
    testerWritePlan.pendingCount > 0 &&
    testerWritePlan.selected.length === 0
  ) {
    throw new Error(
      'Apple request budget leaves no safe tester chunk to preview; no mutations were attempted.',
    );
  }
  let preflightInternalUsers: ReadonlyMap<string, JsonApiResource> | undefined;
  let applyRateBudget: ApplyRateBudget | undefined;
  let enforceDownstreamRateBudget = false;
  if (options.apply) {
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its app-wide tester assertion.');
    }
    groupInventoryState.current = await assertEquivalentBetaGroupInventory(
      assertionClient,
      app.id,
      groupInventoryState.current,
    );
    testerInventoryState.current = await assertEquivalentAppTesterInventory(
      assertionClient,
      app.id,
      expectedTesterInventory,
      options.internalTesters,
      options.externalTesters,
    );
    assertTesterWriteRateLimitBudget(
      assertionClient,
      0,
      testerWritePlan.auditReserve,
    );
    for (const snapshot of [internalGroupSnapshot, externalGroupSnapshot]) {
      if (!snapshot.target.existedInSnapshot) continue;
      await verifyManagedGroupInventoryBeforeMutation(
        assertionClient,
        app.id,
        snapshot,
      );
    }
    const selectedInternalTesters = options.internalTesters.filter(
      ({ email }) => testerWritePlan.selectedEmails.has(email),
    );
    preflightInternalUsers = await collectEligibleInternalTesterUsers(
      assertionClient,
      selectedInternalTesters,
    );
    for (const tester of selectedInternalTesters) {
      await assertExactInternalTesterEligibility(
        assertionClient,
        app.id,
        tester,
        preflightInternalUsers.get(tester.email),
      );
    }
    for (const selected of testerWritePlan.selected) {
      if (selected.existing === undefined) continue;
      const liveTester = await readExactBetaTester(
        assertionClient,
        selected.existing.id,
        selected.email,
      );
      testerIdentityRegistry.registerResolvedTester(
        liveTester,
        selected.audience,
        new Set(
          (selected.audience === 'internal'
            ? options.internalTesters
            : options.externalTesters
          ).map(({ email }) => email),
        ),
      );
    }
    if (testerWritePlan.pendingCount === 0) {
      const appLocalizations =
        options.reviewInfo === undefined
          ? []
          : await listVerifiedBetaAppLocalizationsForApp(
              assertionClient,
              app.id,
            );
      const buildLocalizations =
        options.reviewInfo === undefined || build === null
          ? []
          : await listVerifiedBetaBuildLocalizations(assertionClient, build.id);
      const ratePlan = downstreamRequestReserve(
        groups,
        testerInventoryState.current,
        internalGroupSnapshot,
        externalGroupSnapshot,
        build,
        options.reviewInfo !== undefined,
        options.submitBetaReview,
        {
          appLocalizationCount: appLocalizations.length,
          buildLocalizationCount: buildLocalizations.length,
        },
      );
      assertTesterWriteRateLimitBudget(assertionClient, 0, ratePlan.total);
      applyRateBudget = new ApplyRateBudget(ratePlan);
      enforceDownstreamRateBudget = true;
    } else {
      assertTesterWriteRateLimitBudget(
        assertionClient,
        testerWritePlan.remainingRateCost + RATE_LIMIT_GROUP_SETUP_RESERVE,
        testerWritePlan.auditReserve,
      );
      const stages = new Map<ApplyRateStage, ApplyRateStageReservation>([
        ['group-internal', { guardCost: 12, totalCost: 33 }],
        ['group-external', { guardCost: 12, totalCost: 33 }],
      ]);
      applyRateBudget = new ApplyRateBudget({
        finalAuditReserve:
          testerWritePlan.remainingRateCost + testerWritePlan.auditReserve,
        stages,
        total:
          RATE_LIMIT_GROUP_SETUP_RESERVE +
          testerWritePlan.remainingRateCost +
          testerWritePlan.auditReserve,
      });
    }
  }
  const internalGroupId = await ensureGroup(
    client,
    assertionClient,
    app.id,
    groups,
    groupInventoryState,
    applyRateBudget,
    INTERNAL_GROUP_NAME,
    true,
    options.apply,
    actions,
  );
  const externalGroupId = await ensureGroup(
    client,
    assertionClient,
    app.id,
    groups,
    groupInventoryState,
    applyRateBudget,
    EXTERNAL_GROUP_NAME,
    false,
    options.apply,
    actions,
  );
  const internalTesterSync = await syncTesters(
    client,
    assertionClient,
    app.id,
    testerIdentityRegistry,
    testerInventoryState,
    options.internalTesters,
    options.externalTesters,
    accountTesterByEmail,
    internalGroupId,
    internalGroupSnapshot.testers,
    internalGroupSnapshot.builds,
    options.internalTesters,
    testerWritePlan,
    preflightInternalUsers,
    options.apply,
    actions,
  );
  let expectedInternalBuilds = internalTesterSync.expectedBuilds;
  const externalTesterSync = await syncTesters(
    client,
    assertionClient,
    app.id,
    testerIdentityRegistry,
    testerInventoryState,
    options.internalTesters,
    options.externalTesters,
    accountTesterByEmail,
    externalGroupId,
    externalGroupSnapshot.testers,
    externalGroupSnapshot.builds,
    options.externalTesters,
    testerWritePlan,
    undefined,
    options.apply,
    actions,
  );
  let expectedExternalBuilds = externalTesterSync.expectedBuilds;
  const selectedTesterWrites = testerWritePlan.selected.length;
  const downstreamDeferred =
    testerWritePlan.deferred > 0 || selectedTesterWrites > 0;
  let localizationEvidence: LocalizationEvidence | undefined;
  if (downstreamDeferred && options.reviewInfo !== undefined) {
    actions.push({
      detail:
        'Defer Beta App Review metadata until every approved tester chunk has been freshly previewed and applied.',
      kind: 'beta-review-details',
      status: 'deferred',
    });
  } else if (options.reviewInfo !== undefined) {
    const reviewInfoEvidence = await syncReviewInfo(
      client,
      assertionClient,
      app.id,
      options.reviewInfo,
      applyRateBudget,
      options.apply,
      actions,
    );
    if (build !== null) {
      const buildLocalizations = await syncBuildLocalization(
        client,
        assertionClient,
        app.id,
        build,
        options.reviewInfo,
        reviewInfoEvidence.details,
        reviewInfoEvidence.appLocalizations,
        applyRateBudget,
        options.apply,
        actions,
      );
      localizationEvidence = {
        appLocalizations: reviewInfoEvidence.appLocalizations,
        buildLocalizations,
      };
    } else {
      localizationEvidence = {
        appLocalizations: reviewInfoEvidence.appLocalizations,
      };
    }
  }
  let notificationDetailId: string | undefined;
  let expectedSubmission: JsonApiResource | null = null;
  if (downstreamDeferred && build !== null) {
    actions.push({
      detail: `Defer build ${build.id} distribution to ${INTERNAL_GROUP_NAME} until a fresh zero-backlog preview confirms the complete approved roster.`,
      kind: 'build-distribution',
      status: 'deferred',
    });
    if (options.submitBetaReview) {
      actions.push({
        detail: `Defer build ${build.id} distribution to ${EXTERNAL_GROUP_NAME} until a fresh zero-backlog preview confirms the complete approved roster.`,
        kind: 'build-distribution',
        status: 'deferred',
      });
      actions.push({
        detail:
          'Defer Beta App Review submission until the complete approved roster is verified in a fresh preview.',
        kind: 'beta-review-submission',
        status: 'deferred',
      });
    }
  } else if (build !== null) {
    if (options.submitBetaReview) {
      notificationDetailId = await ensureManualExternalNotification(
        client,
        assertionClient,
        app.id,
        build,
        applyRateBudget,
        options.apply,
        actions,
      );
    }
    expectedInternalBuilds = await attachBuild(
      client,
      assertionClient,
      app.id,
      internalGroupId,
      build,
      options.internalTesters,
      expectedInternalBuilds,
      testerInventoryState,
      options.internalTesters,
      options.externalTesters,
      options.reviewInfo,
      localizationEvidence,
      false,
      undefined,
      applyRateBudget,
      options.apply,
      actions,
    );
    if (options.submitBetaReview) {
      expectedExternalBuilds = await attachBuild(
        client,
        assertionClient,
        app.id,
        externalGroupId,
        build,
        options.externalTesters,
        expectedExternalBuilds,
        testerInventoryState,
        options.internalTesters,
        options.externalTesters,
        options.reviewInfo,
        localizationEvidence,
        true,
        notificationDetailId,
        applyRateBudget,
        options.apply,
        actions,
      );
      if (
        options.reviewInfo === undefined ||
        localizationEvidence === undefined ||
        notificationDetailId === undefined
      ) {
        throw new Error('Beta App Review is missing approved metadata.');
      }
      expectedSubmission = await submitForBetaReview(
        client,
        assertionClient,
        app.id,
        externalGroupId,
        options.externalTesters,
        expectedExternalBuilds,
        build,
        options.reviewInfo,
        localizationEvidence,
        testerInventoryState,
        options.internalTesters,
        options.externalTesters,
        notificationDetailId,
        applyRateBudget,
        options.apply,
        actions,
      );
    }
  }
  if (options.apply) {
    beforeVerification?.();
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its verification client.');
    }
    if (enforceDownstreamRateBudget) {
      if (applyRateBudget === undefined) {
        throw new Error('Apply is missing its downstream rate-limit budget.');
      }
      applyRateBudget.assertFinalAudit(assertionClient);
    }
    await verifyAppliedState(
      assertionClient,
      app.id,
      options,
      build,
      localizationEvidence,
      testerInventoryState.current,
      expectedInternalBuilds,
      expectedExternalBuilds,
      expectedSubmission,
      downstreamDeferred,
    );
    actions.push({
      detail: 'Read-back verification passed.',
      kind: 'verification',
      status: 'applied',
    });
  }
  return {
    actions,
    appId: app.id,
    mode: options.apply ? 'apply' : 'plan',
    ...(build === null ? {} : { selectedBuild: buildSummary(build) }),
  };
};

const canonicalResource = (resource: JsonApiResource): JsonApiResource =>
  deepFreezeCanonical(
    canonicalValue(resourceFromUnknown(resource)),
  ) as unknown as JsonApiResource;

const canonicalResources = (
  resources: readonly JsonApiResource[],
): readonly JsonApiResource[] => {
  const canonical = canonicalValue(resources);
  if (!Array.isArray(canonical)) {
    throw new Error('Apple returned a malformed resource list.');
  }
  const result: JsonApiResource[] = [];
  for (let index = 0; index < canonical.length; index += 1) {
    result.push(
      deepFreezeCanonical(
        canonicalValue(resourceFromUnknown(canonical[index])),
      ) as unknown as JsonApiResource,
    );
  }
  result.sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  return Object.freeze(result);
};

const canonicalPageSummary = (
  summary: JsonApiPageSummary,
): JsonApiPageSummary => {
  const total = summary?.total;
  if (
    typeof total !== 'number' ||
    !Number.isInteger(total) ||
    total < 0 ||
    total > MAX_TESTERS_PER_GROUP
  ) {
    throw new Error('Apple returned a malformed tester roster total.');
  }
  const resources = canonicalResources(summary.resources);
  if (resources.length !== Math.min(total, 1)) {
    throw new Error('Apple returned an inconsistent tester roster summary.');
  }
  return Object.freeze({ resources, total });
};

type ReadObservation =
  | {
      readonly operation: 'first';
      readonly path: string;
      readonly value: JsonApiResource | null;
    }
  | {
      readonly operation: 'get';
      readonly expectedType: string;
      readonly path: string;
      readonly value: JsonApiResource;
    }
  | {
      readonly operation: 'list';
      readonly path: string;
      readonly value: readonly JsonApiResource[];
    }
  | {
      readonly operation: 'page-summary';
      readonly path: string;
      readonly value: JsonApiPageSummary;
    };

class RecordingReadClient implements AscClient {
  readonly #client: AscClient;
  readonly observations: ReadObservation[] = [];

  constructor(client: AscClient) {
    this.#client = client;
  }

  rateLimitRemaining(): number | null {
    return this.#client.rateLimitRemaining();
  }

  async first(path: string): Promise<JsonApiResource | null> {
    const received = await this.#client.first(path);
    const value = received === null ? null : canonicalResource(received);
    this.observations.push(
      Object.freeze({
        operation: 'first',
        path,
        value,
      }),
    );
    return value;
  }

  async list(path: string): Promise<readonly JsonApiResource[]> {
    const value = canonicalResources(await this.#client.list(path));
    this.observations.push(
      Object.freeze({
        operation: 'list',
        path,
        value,
      }),
    );
    return value;
  }

  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    const value = canonicalPageSummary(await this.#client.pageSummary(path));
    this.observations.push(
      Object.freeze({
        operation: 'page-summary',
        path,
        value,
      }),
    );
    return value;
  }

  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    const value = canonicalResource(await this.#client.get(path, expectedType));
    this.observations.push(
      Object.freeze({
        expectedType,
        operation: 'get',
        path,
        value,
      }),
    );
    return value;
  }

  async mutate(): Promise<JsonApiResource | null> {
    throw new Error('Plan mode attempted an App Store Connect mutation.');
  }
}

class ReplayingApplyClient implements AscClient {
  readonly #client: AscClient;
  readonly #observations: readonly ReadObservation[];
  #index = 0;

  constructor(observations: readonly ReadObservation[], client: AscClient) {
    this.#observations = Object.freeze([...observations]);
    this.#client = client;
  }

  rateLimitRemaining(): number | null {
    return this.#client.rateLimitRemaining();
  }

  #take(
    operation: ReadObservation['operation'],
    path: string,
    expectedType?: string,
  ): ReadObservation {
    const observation = this.#observations[this.#index];
    this.#index += 1;
    if (
      observation === undefined ||
      observation.operation !== operation ||
      observation.path !== path ||
      (operation === 'get' &&
        (observation.operation !== 'get' ||
          observation.expectedType !== expectedType))
    ) {
      throw new Error(
        'Confirmed plan transcript did not match apply execution; refusing further writes.',
      );
    }
    return observation;
  }

  async first(path: string): Promise<JsonApiResource | null> {
    const observation = this.#take('first', path);
    if (observation.operation !== 'first') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }

  async list(path: string): Promise<readonly JsonApiResource[]> {
    const observation = this.#take('list', path);
    if (observation.operation !== 'list') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }

  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    const observation = this.#take('page-summary', path);
    if (observation.operation !== 'page-summary') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }

  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    const observation = this.#take('get', path, expectedType);
    if (observation.operation !== 'get') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }

  mutate(
    method: MutationMethod,
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    return this.#client.mutate(method, path, body, expectedType);
  }

  assertExhausted(): void {
    if (this.#index !== this.#observations.length) {
      throw new Error(
        'Confirmed plan transcript was not fully consumed; refusing success.',
      );
    }
  }
}

class MutationTrackingClient implements AscClient {
  readonly #client: AscClient;
  acceptedMutations = 0;
  attemptedMutations = 0;

  constructor(client: AscClient) {
    this.#client = client;
  }

  rateLimitRemaining(): number | null {
    return this.#client.rateLimitRemaining();
  }

  async first(path: string): Promise<JsonApiResource | null> {
    const value = await this.#client.first(path);
    return value === null ? null : canonicalResource(value);
  }

  async list(path: string): Promise<readonly JsonApiResource[]> {
    return canonicalResources(await this.#client.list(path));
  }

  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    return canonicalPageSummary(await this.#client.pageSummary(path));
  }

  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    return canonicalResource(
      resourceFromUnknown(
        await this.#client.get(path, expectedType),
        expectedType,
      ),
    );
  }

  async mutate(
    method: MutationMethod,
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    this.attemptedMutations += 1;
    const result = await this.#client.mutate(method, path, body, expectedType);
    this.acceptedMutations += 1;
    if (expectedType === undefined) {
      if (result !== null) {
        throw new Error('Apple relationship mutation returned content.');
      }
      return null;
    }
    if (result === null) {
      throw new Error('Apple resource mutation omitted its response.');
    }
    return canonicalResource(resourceFromUnknown(result, expectedType));
  }
}

const snapshotTesterList = (
  value: readonly Tester[],
  label: string,
  maximum: number,
): readonly Tester[] => {
  const lengthDescriptor =
    Array.isArray(value) && !isProxy(value)
      ? Object.getOwnPropertyDescriptor(value, 'length')
      : undefined;
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    lengthDescriptor.value > maximum
  ) {
    throw new Error(`${label} exceeds its safety limit.`);
  }
  const snapshot = canonicalValue(value);
  if (!Array.isArray(snapshot)) {
    throw new Error(`${label} contains invalid data.`);
  }
  const result: Tester[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < snapshot.length; index += 1) {
    const tester = snapshot[index];
    if (!isRecord(tester)) throw new Error(`${label} contains invalid data.`);
    const email = requireString(
      tester.email,
      `${label} email`,
      320,
    ).toLocaleLowerCase('en-US');
    if (!isEmail(email)) throw new Error(`${label} contains an invalid email.`);
    const firstName = optionalString(
      tester.firstName,
      `${label} first name`,
      255,
    );
    const lastName = optionalString(tester.lastName, `${label} last name`, 255);
    if (seen.has(email)) {
      throw new Error(`${label} contains a duplicate tester identity.`);
    }
    seen.add(email);
    result.push(
      deepFreezeCanonical(
        canonicalValue({
          email,
          ...(firstName === undefined ? {} : { firstName }),
          ...(lastName === undefined ? {} : { lastName }),
        }),
      ) as unknown as Tester,
    );
  }
  return Object.freeze(
    result.sort((left, right) =>
      left.email < right.email ? -1 : left.email > right.email ? 1 : 0,
    ),
  );
};

interface SnapshotOptions extends ReconcileOptions {
  readonly confirmPlanDigest?: string;
}

const snapshotSyncOptions = (options: SyncOptions): SnapshotOptions => {
  const apply = options.apply;
  const submitBetaReview = options.submitBetaReview;
  const internalTesterInput = options.internalTesters;
  const externalTesterInput = options.externalTesters;
  const reviewInput = options.reviewInfo;
  const buildInput = options.build;
  const confirmPlanDigest = options.confirmPlanDigest;
  if (
    (apply !== true && apply !== false) ||
    typeof submitBetaReview !== 'boolean'
  ) {
    throw new Error('Sync options are invalid.');
  }
  if (apply && !PLAN_DIGEST_PATTERN.test(confirmPlanDigest ?? '')) {
    throw new Error(
      'Apply requires the sha256 planDigest emitted by a prior preview.',
    );
  }
  if (!apply && confirmPlanDigest !== undefined) {
    throw new Error('Plan mode cannot accept an apply confirmation digest.');
  }
  const internalTesters = snapshotTesterList(
    internalTesterInput,
    'Internal tester input',
    MAX_INTERNAL_TESTERS,
  );
  const externalTesters = snapshotTesterList(
    externalTesterInput,
    'External tester input',
    MAX_APPROVED_TESTERS,
  );
  if (internalTesters.length + externalTesters.length > MAX_APPROVED_TESTERS) {
    throw new Error('Combined tester input exceeds the approved PSD limit.');
  }
  const reviewInfo =
    reviewInput === undefined
      ? undefined
      : Object.freeze(parseReviewInfo(reviewInput));
  const build =
    buildInput === undefined
      ? undefined
      : buildInput === 'latest'
        ? 'latest'
        : requireOpaqueIdentifier(buildInput, 'Build ID');
  return Object.freeze({
    apply,
    externalTesters,
    internalTesters,
    submitBetaReview,
    ...(build === undefined ? {} : { build }),
    ...(confirmPlanDigest === undefined ? {} : { confirmPlanDigest }),
    ...(reviewInfo === undefined ? {} : { reviewInfo }),
  });
};

const digestPlan = (
  options: ReconcileOptions,
  observations: readonly ReadObservation[],
  plan: ReconcileResult,
): string => {
  const material = {
    appIdentity: { bundleId: BUNDLE_ID, name: APP_NAME, sku: APP_SKU },
    observations,
    operations: {
      build: options.build ?? null,
      externalTesters: options.externalTesters,
      internalTesters: options.internalTesters,
      reviewInfo: options.reviewInfo ?? null,
      submitBetaReview: options.submitBetaReview,
    },
    plan,
    schemaVersion: 14,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(material)).digest('hex')}`;
};

export const syncTestFlight = async (
  client: AscClient,
  options: SyncOptions,
): Promise<SyncResult> => {
  const snapshot = snapshotSyncOptions(options);
  if (snapshot.apply && snapshot.build === 'latest') {
    throw new Error(
      'Apply requires the exact build ID returned by a prior latest-build preview.',
    );
  }
  const previewClient = new RecordingReadClient(client);
  let confirmedTesterWriteLimit = 0;
  const preview = await reconcileTestFlight(
    previewClient,
    {
      ...snapshot,
      apply: false,
    },
    undefined,
    undefined,
    undefined,
    (limit) => {
      confirmedTesterWriteLimit = limit;
    },
  );
  const planDigest = digestPlan(snapshot, previewClient.observations, preview);
  if (!snapshot.apply) return { ...preview, planDigest };
  if (planDigest !== snapshot.confirmPlanDigest) {
    throw new Error(
      'Confirmed plan digest does not match the current inputs and Apple state; no changes were made.',
    );
  }
  const trackingClient = new MutationTrackingClient(client);
  const replayClient = new ReplayingApplyClient(
    previewClient.observations,
    trackingClient,
  );
  try {
    const applied = await reconcileTestFlight(
      replayClient,
      { ...snapshot, apply: true },
      trackingClient,
      () => replayClient.assertExhausted(),
      confirmedTesterWriteLimit,
    );
    return { ...applied, planDigest };
  } catch {
    if (trackingClient.attemptedMutations === 0) {
      throw new Error(
        'Apple state changed after plan confirmation; no mutations were attempted. Run a new preview.',
      );
    }
    throw new Error(
      `App Store Connect apply is partial or indeterminate after ${trackingClient.acceptedMutations} provider-accepted mutation(s); stop, inspect App Store Connect, and run a new preview.`,
    );
  }
};

const usage = `Usage:
  bun run scripts/ops/appstore/asc.ts sync [options]

Options:
  --internal-testers PATH   CSV/Google Group export for existing ASC users
  --external-testers PATH   CSV/Google Group export for external staff testers
  --review-info PATH        Beta App Review JSON (kept outside the repository)
  --build ID|latest         Processed build to distribute internally
  --submit-beta-review      Also attach the build externally and request review
  --apply                   Perform the previewed additive writes
  --confirm-apply VALUE     Must equal net.psd401.eoc when --apply is present
  --confirm-plan DIGEST     Must equal the prior preview's sha256 planDigest
  --help                    Show this help

Credentials (environment only): ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH.
Without --apply the command performs authenticated reads and prints a plan.
Tester CSVs are complete approved rosters, not merely additions.`;

export const parseCli = (arguments_: readonly string[]): CliOptions => {
  if (arguments_[0] !== 'sync') throw new Error(usage);
  let apply = false;
  let submitBetaReview = false;
  let build: string | undefined;
  let confirmApply: string | undefined;
  let confirmPlanDigest: string | undefined;
  let externalTestersPath: string | undefined;
  let internalTestersPath: string | undefined;
  let reviewInfoPath: string | undefined;
  const valueFlags = new Map<string, (value: string) => void>([
    ['--build', (value) => (build = value)],
    ['--confirm-apply', (value) => (confirmApply = value)],
    ['--confirm-plan', (value) => (confirmPlanDigest = value)],
    ['--external-testers', (value) => (externalTestersPath = value)],
    ['--internal-testers', (value) => (internalTestersPath = value)],
    ['--review-info', (value) => (reviewInfoPath = value)],
  ]);
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--submit-beta-review') {
      submitBetaReview = true;
      continue;
    }
    const setValue =
      argument === undefined ? undefined : valueFlags.get(argument);
    if (setValue === undefined)
      throw new Error('Unknown command-line argument.');
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('A command-line option requires a value.');
    }
    setValue(value);
    index += 1;
  }
  if (apply && confirmApply !== BUNDLE_ID) {
    throw new Error(`--apply requires --confirm-apply ${BUNDLE_ID}.`);
  }
  if (apply && !PLAN_DIGEST_PATTERN.test(confirmPlanDigest ?? '')) {
    throw new Error(
      '--apply requires --confirm-plan sha256:<64 lowercase hex>.',
    );
  }
  if (!apply && confirmPlanDigest !== undefined) {
    throw new Error('--confirm-plan is only valid with --apply.');
  }
  if (
    submitBetaReview &&
    (reviewInfoPath === undefined || build === undefined)
  ) {
    throw new Error('--submit-beta-review requires --review-info and --build.');
  }
  return {
    apply,
    submitBetaReview,
    ...(build === undefined ? {} : { build }),
    ...(confirmApply === undefined ? {} : { confirmApply }),
    ...(confirmPlanDigest === undefined ? {} : { confirmPlanDigest }),
    ...(externalTestersPath === undefined ? {} : { externalTestersPath }),
    ...(internalTestersPath === undefined ? {} : { internalTestersPath }),
    ...(reviewInfoPath === undefined ? {} : { reviewInfoPath }),
  };
};

const readTesters = async (
  path: string | undefined,
): Promise<readonly Tester[]> => {
  if (path === undefined) return [];
  return parseTesterCsv(await readPrivateFile(path, 5_000_000, 'Tester CSV'));
};

const main = async (arguments_: readonly string[]): Promise<void> => {
  if (arguments_.includes('--help')) {
    console.log(usage);
    return;
  }
  const cli = parseCli(arguments_);
  const keyId = requireString(Bun.env.ASC_KEY_ID, 'ASC_KEY_ID', 255);
  const issuerId = requireString(Bun.env.ASC_ISSUER_ID, 'ASC_ISSUER_ID', 255);
  const keyPath = requireString(Bun.env.ASC_KEY_PATH, 'ASC_KEY_PATH', 4_096);
  const [privateKey, internalTesters, externalTesters, reviewInfo] =
    await Promise.all([
      readPrivateFile(keyPath, 64_000, 'ASC private key'),
      readTesters(cli.internalTestersPath),
      readTesters(cli.externalTestersPath),
      cli.reviewInfoPath === undefined
        ? Promise.resolve(undefined)
        : readPrivateFile(cli.reviewInfoPath, 64_000, 'Beta-review input').then(
            parseReviewInfoJson,
          ),
    ]);
  const client = new AppStoreConnectClient({ issuerId, keyId, privateKey });
  const commonOptions = {
    externalTesters,
    internalTesters,
    submitBetaReview: cli.submitBetaReview,
    ...(cli.build === undefined ? {} : { build: cli.build }),
    ...(reviewInfo === undefined ? {} : { reviewInfo }),
  };
  const result = cli.apply
    ? await syncTestFlight(client, {
        ...commonOptions,
        apply: true,
        confirmPlanDigest: cli.confirmPlanDigest as string,
      })
    : await syncTestFlight(client, { ...commonOptions, apply: false });
  console.log(JSON.stringify(result, null, 2));
};

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'App Store operation failed.',
    );
    exitProcess(1);
  }
}
