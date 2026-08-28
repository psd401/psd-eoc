import { Buffer } from 'node:buffer';
import { isProxy } from 'node:util/types';
export const API_ORIGIN = 'https://api.appstoreconnect.apple.com';
export const MAX_PAGES = 100;
export const MAX_RESOURCES = 20000;
export const MAX_RESPONSE_BYTES = 2000000;
export const MAX_GET_ATTEMPTS = 3;
export const MAX_GROUPS = 200;
export const MAX_APP_LOCALIZATIONS = 200;
export const MAX_APP_BUILDS = 1000;
export const MAX_APP_TESTERS = 10100;
export const MAX_GROUP_BUILDS = 200;
export const MAX_TESTERS_PER_GROUP = 10000;
export const MAX_INDIVIDUAL_TESTERS_PER_BUILD = 10000;
export const MAX_TESTER_RELATIONSHIPS = 1000;
export const MAX_INTERNAL_TESTERS = 100;
export const MAX_TESTER_WRITES_PER_APPLY = 100;
export const MAX_TESTER_WRITE_REQUEST_COST_PER_APPLY = 2500;
export const INTERNAL_TESTER_WRITE_REQUEST_COST = 265;
export const RATE_LIMIT_GROUP_SETUP_RESERVE = 66;
export const MAX_APPLY_REQUEST_COST = 2950;
export const MIN_FINAL_AUDIT_REQUEST_RESERVE = 400;
export const FILE_READ_CHUNK_BYTES = 64 * 1024;
export const PLAN_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const BETA_BUILD_LOCALIZATION_LOCALES = new Set([
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
export type JsonObject = Record<string, unknown>;
export type MutationMethod = 'PATCH' | 'POST';
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
export interface BetaTestInfo {
  readonly locale: string;
  readonly betaDescription: string;
  readonly feedbackEmail: string;
  readonly whatsNew: string;
}
export interface AscAppConfiguration {
  readonly appName: string;
  readonly appSku: string;
  readonly bundleId: string;
  readonly internalGroupName: string;
}
interface SyncOptionsBase {
  readonly app: AscAppConfiguration;
  readonly internalTesters: readonly Tester[];
  readonly testInfo?: BetaTestInfo;
  readonly build?: string;
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
export type ReconcileResult = Omit<SyncResult, 'planDigest'>;
export interface ReconcileOptions extends SyncOptionsBase {
  readonly apply: boolean;
}
export interface AscCredentials {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKey: string;
}
export interface CliOptions {
  readonly app: AscAppConfiguration;
  readonly apply: boolean;
  readonly build?: string;
  readonly confirmApply?: string;
  readonly confirmPlanDigest?: string;
  readonly internalTestersPath?: string;
  readonly testInfoPath?: string;
}
export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
type CanonicalValue =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalValue[]
  | {
      readonly [key: string]: CanonicalValue;
    };
export const canonicalValue = (
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
export const canonicalJson = (value: unknown): string =>
  serializeCanonical(canonicalValue(value));
export const deepFreezeCanonical = <Value extends CanonicalValue>(
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
export const requireString = (
  value: unknown,
  label: string,
  maximumLength = 4096,
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
export const optionalString = (
  value: unknown,
  label: string,
  maximumLength = 4096,
): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, label, maximumLength);
};
export const isEmail = (value: string): boolean =>
  value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
export const requireOpaqueIdentifier = (
  value: unknown,
  label: string,
): string => {
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
export const resourceFromUnknown = (
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
export const EMPTY_JSON_OBJECT = Object.freeze(
  Object.create(null) as JsonObject,
) as Readonly<JsonObject>;
export const attributesOf = (
  resource: JsonApiResource,
): Readonly<JsonObject> => {
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
export const appendQuery = (
  path: string,
  values: Readonly<Record<string, string>>,
): string => {
  const query = new URLSearchParams(values);
  return `${path}?${query.toString()}`;
};
export const isOpaquePaginationCursor = (
  value: string | undefined,
): value is string =>
  value !== undefined &&
  value.length > 0 &&
  value.length <= 1024 &&
  /^[A-Za-z0-9._~-]+$/u.test(value);
export const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
