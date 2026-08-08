import { Buffer } from 'node:buffer';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { sign as signBytes } from 'node:crypto';
import { exit as exitProcess } from 'node:process';

const API_ORIGIN = 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = 'net.psd401.eoc';
const APP_NAME = 'PSD EOC';
const APP_SKU = 'PSD-EOC-IOS';
const INTERNAL_GROUP_NAME = 'District Technology';
const EXTERNAL_GROUP_NAME = 'Staff';
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const MAX_PAGES = 100;
const MAX_RESOURCES = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;

type JsonObject = Record<string, unknown>;
type MutationMethod = 'PATCH' | 'POST';

export interface JsonApiResource {
  readonly type: string;
  readonly id: string;
  readonly attributes?: Readonly<JsonObject>;
}

export interface AscClient {
  first(path: string): Promise<JsonApiResource | null>;
  list(path: string): Promise<readonly JsonApiResource[]>;
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
}

export interface SyncOptions {
  readonly apply: boolean;
  readonly internalTesters: readonly Tester[];
  readonly externalTesters: readonly Tester[];
  readonly reviewInfo?: BetaReviewInfo;
  readonly build?: string;
  readonly submitBetaReview: boolean;
}

export interface SyncAction {
  readonly kind:
    | 'beta-localization'
    | 'beta-review-details'
    | 'beta-review-submission'
    | 'build-distribution'
    | 'group'
    | 'tester'
    | 'verification';
  readonly status: 'applied' | 'planned' | 'unchanged';
  readonly detail: string;
}

export interface SyncResult {
  readonly mode: 'apply' | 'plan';
  readonly appId: string;
  readonly actions: readonly SyncAction[];
  readonly selectedBuild?: {
    readonly audienceType?: string;
    readonly id: string;
    readonly uploadedDate?: string;
    readonly version?: string;
  };
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
  readonly externalTestersPath?: string;
  readonly internalTestersPath?: string;
  readonly reviewInfoPath?: string;
  readonly submitBetaReview: boolean;
}

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const resourceFromUnknown = (
  value: unknown,
  expectedType?: string,
): JsonApiResource => {
  if (!isRecord(value)) throw new Error('Apple returned a malformed resource.');
  const type = requireString(value.type, 'Apple resource type', 100);
  const id = requireString(value.id, 'Apple resource ID', 255);
  if (expectedType !== undefined && type !== expectedType) {
    throw new Error(
      `Apple returned ${type} where ${expectedType} was required.`,
    );
  }
  if (value.attributes !== undefined && !isRecord(value.attributes)) {
    throw new Error('Apple returned malformed resource attributes.');
  }
  return value.attributes === undefined
    ? { type, id }
    : { type, id, attributes: value.attributes };
};

const attributesOf = (resource: JsonApiResource): Readonly<JsonObject> =>
  resource.attributes ?? {};

const appendQuery = (
  path: string,
  values: Readonly<Record<string, string>>,
): string => {
  const query = new URLSearchParams(values);
  return `${path}?${query.toString()}`;
};

const chunksOf = <Value>(
  values: readonly Value[],
  size: number,
): readonly (readonly Value[])[] => {
  const chunks: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

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

const safeAppleError = (body: unknown): string => {
  if (!isRecord(body) || !Array.isArray(body.errors)) return 'no error code';
  const summaries = body.errors.slice(0, 5).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const code = typeof entry.code === 'string' ? entry.code : 'UNKNOWN';
    const title = typeof entry.title === 'string' ? entry.title : 'Apple error';
    return [`${code}: ${title}`];
  });
  return summaries.length === 0 ? 'no error code' : summaries.join('; ');
};

const readBoundedResponseJson = async (
  response: Response,
): Promise<unknown> => {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('Apple response exceeded its size limit.');
  }
  if (response.body === null)
    throw new Error('Apple returned an empty JSON response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Apple response exceeded its size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Apple returned invalid JSON.', { cause: error });
  }
};

export class AppStoreConnectClient implements AscClient {
  readonly #credentials: AscCredentials;

  constructor(credentials: AscCredentials) {
    this.#credentials = credentials;
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
    let next: string | null = path;

    for (let page = 0; next !== null; page += 1) {
      if (page >= MAX_PAGES)
        throw new Error('Apple pagination exceeded its limit.');
      const url = this.#validatedUrl(next);
      if (visited.has(url.href)) {
        throw new Error('Apple pagination repeated a page URL.');
      }
      visited.add(url.href);
      const body = await this.#requestJson('GET', url);
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw new Error('Apple returned a malformed list response.');
      }
      for (const item of body.data) resources.push(resourceFromUnknown(item));
      if (resources.length > MAX_RESOURCES) {
        throw new Error('Apple returned more resources than the safety limit.');
      }
      const links = body.links;
      if (links === undefined) {
        next = null;
      } else if (!isRecord(links)) {
        throw new Error('Apple returned malformed pagination links.');
      } else {
        const candidate = links.next;
        if (candidate === undefined || candidate === null) next = null;
        else next = requireString(candidate, 'Apple next-page URL', 4_096);
      }
    }
    return resources;
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
    const response = await this.#requestJson(
      method,
      this.#validatedUrl(path),
      body,
    );
    if (response === null) return null;
    if (!isRecord(response))
      throw new Error('Apple returned a malformed response.');
    return resourceFromUnknown(response.data, expectedType);
  }

  #validatedUrl(pathOrUrl: string): URL {
    const url = pathOrUrl.startsWith('/')
      ? new URL(pathOrUrl, API_ORIGIN)
      : new URL(pathOrUrl);
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/v1/')) {
      throw new Error(
        'Refusing to send Apple credentials to an unexpected URL.',
      );
    }
    return url;
  }

  async #requestJson(
    method: 'GET' | MutationMethod,
    url: URL,
    body?: unknown,
  ): Promise<unknown | null> {
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${createAscJwt(this.#credentials)}`,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          method,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (method !== 'GET' || attempt === attempts) {
          const state = method === 'GET' ? 'failed' : 'is indeterminate';
          throw new Error(
            `Apple ${method} ${state}; rerun preview before any further apply.`,
            { cause: error },
          );
        }
        await Bun.sleep(attempt * 500);
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        return readBoundedResponseJson(response);
      }

      let errorBody: unknown;
      try {
        errorBody = await readBoundedResponseJson(response);
      } catch {
        errorBody = null;
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
      throw new Error(
        `Apple ${method} failed with HTTP ${response.status} (${safeAppleError(errorBody)}).`,
      );
    }
    throw new Error('Apple request exhausted its retry limit.');
  }
}

export const parseCsvRows = (input: string): readonly (readonly string[])[] => {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const rows: string[][] = [[]];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      rows.at(-1)?.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      rows.at(-1)?.push(field);
      field = '';
      rows.push([]);
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Tester CSV contains an unterminated quote.');
  rows.at(-1)?.push(field);

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
): number => headers.findIndex((header) => aliases.includes(header));

export const parseTesterCsv = (input: string): readonly Tester[] => {
  const rows = parseCsvRows(input);
  if (rows.length < 2)
    throw new Error('Tester CSV must have a header and data.');
  const headers = (rows[0] ?? []).map(normalizeHeader);
  const emailIndex = findHeader(headers, [
    'email',
    'emailaddress',
    'memberemail',
    'memberemailaddress',
  ]);
  if (emailIndex < 0)
    throw new Error('Tester CSV has no supported email header.');
  const firstNameIndex = findHeader(headers, ['firstname', 'givenname']);
  const lastNameIndex = findHeader(headers, [
    'lastname',
    'familyname',
    'surname',
  ]);
  const memberTypeIndex = findHeader(headers, ['membertype', 'type']);
  const testers: Tester[] = [];
  const seen = new Set<string>();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const memberType =
      memberTypeIndex < 0
        ? undefined
        : row[memberTypeIndex]?.trim().toLowerCase();
    if (
      memberType !== undefined &&
      memberType !== '' &&
      memberType !== 'user'
    ) {
      continue;
    }
    const rawEmail = row[emailIndex]?.trim() ?? '';
    if (rawEmail === '') continue;
    const email = rawEmail.toLocaleLowerCase('en-US');
    if (!isEmail(email))
      throw new Error(`Tester CSV row ${rowIndex + 1} has an invalid email.`);
    if (seen.has(email)) continue;
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
  if (testers.length > 10_000)
    throw new Error('Tester CSV exceeds TestFlight capacity.');
  return testers;
};

export const parseReviewInfo = (input: unknown): BetaReviewInfo => {
  if (!isRecord(input))
    throw new Error('Beta-review input must be a JSON object.');
  const allowed = new Set([
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
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new Error(`Beta-review input has unsupported field ${key}.`);
  }
  const contactEmail = requireString(input.contactEmail, 'contactEmail', 320);
  const feedbackEmail = requireString(
    input.feedbackEmail,
    'feedbackEmail',
    320,
  );
  if (!isEmail(contactEmail) || !isEmail(feedbackEmail)) {
    throw new Error('Beta-review email fields must be valid email addresses.');
  }
  if (typeof input.demoAccountRequired !== 'boolean') {
    throw new Error('demoAccountRequired must be a boolean.');
  }
  const demoAccountName = optionalString(
    input.demoAccountName,
    'demoAccountName',
    255,
  );
  const demoAccountPassword = optionalSecretString(
    input.demoAccountPassword,
    'demoAccountPassword',
    255,
  );
  if (
    input.demoAccountRequired &&
    (demoAccountName === undefined || demoAccountPassword === undefined)
  ) {
    throw new Error('A required demo account needs both name and password.');
  }
  if (
    !input.demoAccountRequired &&
    (demoAccountName !== undefined || demoAccountPassword !== undefined)
  ) {
    throw new Error(
      'Demo account credentials are forbidden when no demo account is required.',
    );
  }
  const notes = optionalString(input.notes, 'notes', 4_000);
  return {
    betaDescription: requireString(
      input.betaDescription,
      'betaDescription',
      4_000,
    ),
    contactEmail,
    contactFirstName: requireString(
      input.contactFirstName,
      'contactFirstName',
      255,
    ),
    contactLastName: requireString(
      input.contactLastName,
      'contactLastName',
      255,
    ),
    contactPhone: requireString(input.contactPhone, 'contactPhone', 50),
    demoAccountRequired: input.demoAccountRequired,
    feedbackEmail,
    locale: optionalString(input.locale, 'locale', 20) ?? 'en-US',
    ...(demoAccountName === undefined ? {} : { demoAccountName }),
    ...(demoAccountPassword === undefined ? {} : { demoAccountPassword }),
    ...(notes === undefined ? {} : { notes }),
  };
};

export const isPathInside = (candidate: string, parent: string): boolean => {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const requireExternalPath = async (
  path: string,
  label: string,
): Promise<string> => {
  const [actualPath, actualRoot] = await Promise.all([
    realpath(resolve(path)),
    realpath(REPOSITORY_ROOT),
  ]);
  if (isPathInside(actualPath, actualRoot)) {
    throw new Error(`${label} must be stored outside the repository.`);
  }
  return actualPath;
};

const readBoundedFile = async (
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error(`${label} is not a regular file within its size limit.`);
  }
  return readFile(path, 'utf8');
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

const ensureGroup = async (
  client: AscClient,
  appId: string,
  groups: readonly JsonApiResource[],
  name: string,
  internal: boolean,
  apply: boolean,
  actions: SyncAction[],
): Promise<string | null> => {
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
    if (!apply) return null;
    const created = await client.mutate(
      'POST',
      '/v1/betaGroups',
      createGroupBody(appId, name, internal),
      'betaGroups',
    );
    if (created === null)
      throw new Error('Apple did not return the created group.');
    return created.id;
  }
  if (attributesOf(existing).isInternalGroup !== internal) {
    throw new Error(`${name} exists with the wrong TestFlight group type.`);
  }
  const desired: JsonObject = {
    feedbackEnabled: true,
    hasAccessToAllBuilds: false,
    ...(internal ? {} : { publicLinkEnabled: false }),
  };
  if (sameSelectedAttributes(attributesOf(existing), desired)) {
    actions.push({
      detail: `${name} group already matches.`,
      kind: 'group',
      status: 'unchanged',
    });
    return existing.id;
  }
  actions.push({
    detail: `Make ${name} private and explicitly build-scoped.`,
    kind: 'group',
    status: actionStatus(apply),
  });
  if (apply) {
    await client.mutate(
      'PATCH',
      `/v1/betaGroups/${encodeURIComponent(existing.id)}`,
      { data: { attributes: desired, id: existing.id, type: 'betaGroups' } },
      'betaGroups',
    );
  }
  return existing.id;
};

const testerEmail = (resource: JsonApiResource): string | null => {
  const value = attributesOf(resource).email;
  return typeof value === 'string' && isEmail(value)
    ? value.toLocaleLowerCase('en-US')
    : null;
};

const preflightInternalTesters = async (
  client: AscClient,
  appId: string,
  desired: readonly Tester[],
  actions: SyncAction[],
): Promise<void> => {
  if (desired.length === 0) return;
  const userPages = await Promise.all(
    chunksOf(desired, 25).map((batch) =>
      client.list(
        appendQuery('/v1/users', {
          'fields[users]': 'username,roles,allAppsVisible',
          'filter[username]': batch.map(({ email }) => email).join(','),
          limit: '200',
        }),
      ),
    ),
  );
  const users = userPages.flat();
  const eligibleRoles = new Set([
    'ACCOUNT_HOLDER',
    'ADMIN',
    'APP_MANAGER',
    'CUSTOMER_SUPPORT',
    'DEVELOPER',
    'MARKETING',
  ]);
  const eligible = new Map<string, JsonApiResource>();
  for (const user of users) {
    if (user.type !== 'users') continue;
    const username = attributesOf(user).username;
    const roles = attributesOf(user).roles;
    if (
      typeof username === 'string' &&
      Array.isArray(roles) &&
      roles.some((role) => typeof role === 'string' && eligibleRoles.has(role))
    ) {
      eligible.set(username.toLocaleLowerCase('en-US'), user);
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
  const restrictedUsers = desired
    .map(({ email }) => eligible.get(email))
    .filter(
      (user): user is JsonApiResource =>
        user !== undefined && attributesOf(user).allAppsVisible !== true,
    );
  const visibleAppLists = await Promise.all(
    restrictedUsers.map((user) =>
      client.list(
        appendQuery(`/v1/users/${encodeURIComponent(user.id)}/visibleApps`, {
          limit: '200',
        }),
      ),
    ),
  );
  const withoutAccess = visibleAppLists.filter(
    (apps) => !apps.some((app) => app.type === 'apps' && app.id === appId),
  ).length;
  if (withoutAccess > 0) {
    throw new Error(
      `${withoutAccess} internal tester(s) lack access to the PSD EOC app; no changes were made.`,
    );
  }
  actions.push({
    detail: `${desired.length} internal tester(s) are eligible App Store Connect users.`,
    kind: 'tester',
    status: 'unchanged',
  });
};

const preflightAppCapacity = async (
  client: AscClient,
  groups: readonly JsonApiResource[],
  internal: boolean,
  desired: readonly Tester[],
  maximum: number,
): Promise<void> => {
  const categoryGroups = groups.filter((group) => {
    if (group.type !== 'betaGroups') {
      throw new Error('Apple returned a non-group in the beta-group list.');
    }
    const groupIsInternal = attributesOf(group).isInternalGroup;
    if (typeof groupIsInternal !== 'boolean') {
      throw new Error('Apple returned a beta group without an audience type.');
    }
    return groupIsInternal === internal;
  });
  const memberships = await Promise.all(
    categoryGroups.map((group) =>
      client.list(
        appendQuery(
          `/v1/betaGroups/${encodeURIComponent(group.id)}/betaTesters`,
          {
            'fields[betaTesters]': 'email',
            limit: '200',
          },
        ),
      ),
    ),
  );
  const current = memberships.flat();
  const existingIds = new Set(current.map(({ id }) => id));
  const existingEmails = new Set(
    current.map(testerEmail).filter((email) => email !== null),
  );
  const additions = desired.filter(
    ({ email }) => !existingEmails.has(email),
  ).length;
  if (existingIds.size + additions > maximum) {
    const audience = internal ? 'internal' : 'external';
    throw new Error(
      `App-wide ${audience} membership plus proposed additions exceeds Apple's ${maximum}-tester limit; no changes were made.`,
    );
  }
};

const syncTesters = async (
  client: AscClient,
  groupId: string | null,
  groupName: string,
  desired: readonly Tester[],
  apply: boolean,
  actions: SyncAction[],
): Promise<void> => {
  if (desired.length === 0) return;
  if (groupId === null) {
    actions.push({
      detail: `Add ${desired.length} approved tester(s) to ${groupName} after group creation.`,
      kind: 'tester',
      status: 'planned',
    });
    return;
  }
  const [groupTesters, appTesterPages] = await Promise.all([
    client.list(
      appendQuery(`/v1/betaGroups/${encodeURIComponent(groupId)}/betaTesters`, {
        'fields[betaTesters]': 'email',
        limit: '200',
      }),
    ),
    Promise.all(
      chunksOf(desired, 50).map((batch) =>
        client.list(
          appendQuery('/v1/betaTesters', {
            'fields[betaTesters]': 'email',
            'filter[email]': batch.map(({ email }) => email).join(','),
            limit: '200',
          }),
        ),
      ),
    ),
  ]);
  const appTesters = appTesterPages.flat();
  const inGroup = new Set(
    groupTesters.map(testerEmail).filter((email) => email !== null),
  );
  const byEmail = new Map<string, JsonApiResource>();
  for (const tester of appTesters) {
    const email = testerEmail(tester);
    if (email !== null) {
      if (byEmail.has(email)) {
        throw new Error('Apple returned duplicate beta tester identities.');
      }
      byEmail.set(email, tester);
    }
  }
  const existingToLink: JsonApiResource[] = [];
  const missing: Tester[] = [];
  let unchanged = 0;
  for (const tester of desired) {
    if (inGroup.has(tester.email)) {
      unchanged += 1;
      continue;
    }
    const existing = byEmail.get(tester.email);
    if (existing === undefined) missing.push(tester);
    else existingToLink.push(existing);
  }
  if (unchanged > 0) {
    actions.push({
      detail: `${unchanged} tester(s) already belong to ${groupName}.`,
      kind: 'tester',
      status: 'unchanged',
    });
  }
  if (existingToLink.length > 0) {
    actions.push({
      detail: `Add ${existingToLink.length} existing tester(s) to ${groupName}.`,
      kind: 'tester',
      status: actionStatus(apply),
    });
    if (apply) {
      await client.mutate(
        'POST',
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        { data: existingToLink.map(({ id }) => ({ id, type: 'betaTesters' })) },
      );
    }
  }
  if (missing.length > 0) {
    actions.push({
      detail: `Create and add ${missing.length} tester(s) to ${groupName}.`,
      kind: 'tester',
      status: actionStatus(apply),
    });
    if (apply) {
      for (const tester of missing) {
        await client.mutate(
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
                betaGroups: { data: [{ id: groupId, type: 'betaGroups' }] },
              },
              type: 'betaTesters',
            },
          },
          'betaTesters',
        );
      }
    }
  }
};

const reviewAttributes = (review: BetaReviewInfo): JsonObject => ({
  contactEmail: review.contactEmail,
  contactFirstName: review.contactFirstName,
  contactLastName: review.contactLastName,
  contactPhone: review.contactPhone,
  demoAccountRequired: review.demoAccountRequired,
  ...(review.demoAccountName === undefined
    ? {}
    : { demoAccountName: review.demoAccountName }),
  ...(review.demoAccountPassword === undefined
    ? {}
    : { demoAccountPassword: review.demoAccountPassword }),
  ...(review.notes === undefined ? {} : { notes: review.notes }),
});

const localizationAttributes = (review: BetaReviewInfo): JsonObject => ({
  description: review.betaDescription,
  feedbackEmail: review.feedbackEmail,
});

const syncReviewInfo = async (
  client: AscClient,
  appId: string,
  review: BetaReviewInfo,
  apply: boolean,
  actions: SyncAction[],
): Promise<void> => {
  const details = await client.get(
    `/v1/apps/${encodeURIComponent(appId)}/betaAppReviewDetail`,
    'betaAppReviewDetails',
  );
  const expectedDetails = reviewAttributes(review);
  if (sameSelectedAttributes(attributesOf(details), expectedDetails)) {
    actions.push({
      detail: 'Beta App Review contact and access details already match.',
      kind: 'beta-review-details',
      status: 'unchanged',
    });
  } else {
    actions.push({
      detail: 'Update Beta App Review contact and access details.',
      kind: 'beta-review-details',
      status: actionStatus(apply),
    });
    if (apply) {
      await client.mutate(
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
    }
  }

  const localizations = await client.list(
    appendQuery('/v1/betaAppLocalizations', {
      'filter[app]': appId,
      limit: '200',
    }),
  );
  const matching = localizations.filter(
    (item) =>
      item.type === 'betaAppLocalizations' &&
      attributesOf(item).locale === review.locale,
  );
  if (matching.length > 1)
    throw new Error(`Apple has duplicate ${review.locale} beta localizations.`);
  const expectedLocalization = localizationAttributes(review);
  const existing = matching[0];
  if (existing === undefined) {
    actions.push({
      detail: `Create ${review.locale} TestFlight beta description.`,
      kind: 'beta-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      await client.mutate(
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
    }
  } else if (
    sameSelectedAttributes(attributesOf(existing), expectedLocalization)
  ) {
    actions.push({
      detail: `${review.locale} TestFlight beta description already matches.`,
      kind: 'beta-localization',
      status: 'unchanged',
    });
  } else {
    actions.push({
      detail: `Update ${review.locale} TestFlight beta description.`,
      kind: 'beta-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      await client.mutate(
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
    }
  }
  for (const localization of localizations) {
    if (localization.id === existing?.id) continue;
    const locale = attributesOf(localization).locale;
    const description = attributesOf(localization).description;
    if (typeof description !== 'string' || description.trim() === '') {
      throw new Error(
        `Beta localization ${typeof locale === 'string' ? locale : '(unknown)'} needs an approved description before review.`,
      );
    }
  }
};

const resolveBuild = async (
  client: AscClient,
  appId: string,
  build: string,
): Promise<JsonApiResource> => {
  const parameters: Record<string, string> = {
    'fields[builds]':
      'version,uploadedDate,expired,processingState,buildAudienceType',
    'filter[app]': appId,
    'filter[expired]': 'false',
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
  return selected;
};

const buildSummary = (
  build: JsonApiResource,
): NonNullable<SyncResult['selectedBuild']> => {
  const attributes = attributesOf(build);
  const version = attributes.version;
  const uploadedDate = attributes.uploadedDate;
  const audienceType = attributes.buildAudienceType;
  return {
    id: build.id,
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof uploadedDate === 'string' ? { uploadedDate } : {}),
    ...(typeof audienceType === 'string' ? { audienceType } : {}),
  };
};

const attachBuild = async (
  client: AscClient,
  groupId: string | null,
  groupName: string,
  build: JsonApiResource,
  apply: boolean,
  actions: SyncAction[],
): Promise<void> => {
  if (groupId === null) {
    actions.push({
      detail: `Distribute build ${build.id} to ${groupName} after group creation.`,
      kind: 'build-distribution',
      status: 'planned',
    });
    return;
  }
  const linked = await client.list(
    appendQuery(
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
      {
        limit: '200',
      },
    ),
  );
  if (linked.some((item) => item.type === 'builds' && item.id === build.id)) {
    actions.push({
      detail: `Selected build is already distributed to ${groupName}.`,
      kind: 'build-distribution',
      status: 'unchanged',
    });
    return;
  }
  actions.push({
    detail: `Distribute build ${build.id} to ${groupName}.`,
    kind: 'build-distribution',
    status: actionStatus(apply),
  });
  if (apply) {
    await client.mutate(
      'POST',
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
      { data: [{ id: build.id, type: 'builds' }] },
    );
  }
};

const existingSubmissionState = (
  submissions: readonly JsonApiResource[],
): string | null => {
  if (submissions.length === 0) return null;
  if (
    submissions.length !== 1 ||
    submissions[0]?.type !== 'betaAppReviewSubmissions'
  ) {
    throw new Error('Apple returned ambiguous Beta App Review submissions.');
  }
  const state = attributesOf(submissions[0]).betaReviewState;
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
  return state;
};

const submitForBetaReview = async (
  client: AscClient,
  build: JsonApiResource,
  apply: boolean,
  actions: SyncAction[],
): Promise<void> => {
  const submissions = await client.list(
    appendQuery('/v1/betaAppReviewSubmissions', {
      'fields[betaAppReviewSubmissions]': 'betaReviewState',
      'filter[build]': build.id,
      limit: '200',
    }),
  );
  const state = existingSubmissionState(submissions);
  if (state !== null) {
    actions.push({
      detail: `Selected build Beta App Review state is ${state}.`,
      kind: 'beta-review-submission',
      status: 'unchanged',
    });
    return;
  }
  actions.push({
    detail: 'Submit the selected build for external Beta App Review.',
    kind: 'beta-review-submission',
    status: actionStatus(apply),
  });
  if (apply) {
    await client.mutate(
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
  }
};

const assertApp = (apps: readonly JsonApiResource[]): JsonApiResource => {
  const exact = apps.filter(
    (app) =>
      app.type === 'apps' &&
      attributesOf(app).bundleId === BUNDLE_ID &&
      attributesOf(app).name === APP_NAME &&
      attributesOf(app).sku === APP_SKU,
  );
  if (exact.length !== 1) {
    throw new Error(
      `Expected exactly one App Store Connect app named ${APP_NAME} with bundle ID ${BUNDLE_ID} and SKU ${APP_SKU}.`,
    );
  }
  return exact[0] as JsonApiResource;
};

const verifyAppliedState = async (
  client: AscClient,
  appId: string,
  options: SyncOptions,
  build: JsonApiResource | null,
): Promise<void> => {
  const groups = await client.list(
    appendQuery('/v1/betaGroups', { 'filter[app]': appId, limit: '200' }),
  );
  const find = (name: string, internal: boolean): JsonApiResource => {
    const matches = groups.filter(
      (group) =>
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

  for (const [group, desired, name] of [
    [internal, options.internalTesters, INTERNAL_GROUP_NAME],
    [external, options.externalTesters, EXTERNAL_GROUP_NAME],
  ] as const) {
    if (desired.length === 0) continue;
    const actual = await client.list(
      appendQuery(
        `/v1/betaGroups/${encodeURIComponent(group.id)}/betaTesters`,
        {
          'fields[betaTesters]': 'email',
          limit: '200',
        },
      ),
    );
    const emails = new Set(
      actual.map(testerEmail).filter((email) => email !== null),
    );
    if (!desired.every((tester) => emails.has(tester.email))) {
      throw new Error(`Apply verification found missing tester(s) in ${name}.`);
    }
  }
  if (build !== null) {
    const internalBuilds = await client.list(
      appendQuery(
        `/v1/betaGroups/${encodeURIComponent(internal.id)}/relationships/builds`,
        {
          limit: '200',
        },
      ),
    );
    if (
      !internalBuilds.some(
        (item) => item.id === build.id && item.type === 'builds',
      )
    ) {
      throw new Error(
        'Apply verification found the internal build distribution missing.',
      );
    }
    if (options.submitBetaReview) {
      const externalBuilds = await client.list(
        appendQuery(
          `/v1/betaGroups/${encodeURIComponent(external.id)}/relationships/builds`,
          { limit: '200' },
        ),
      );
      if (
        !externalBuilds.some(
          (item) => item.id === build.id && item.type === 'builds',
        )
      ) {
        throw new Error(
          'Apply verification found the external build distribution missing.',
        );
      }
    }
  }
  if (options.reviewInfo !== undefined) {
    const details = await client.get(
      `/v1/apps/${encodeURIComponent(appId)}/betaAppReviewDetail`,
      'betaAppReviewDetails',
    );
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
    const localizations = await client.list(
      appendQuery('/v1/betaAppLocalizations', {
        'filter[app]': appId,
        'filter[locale]': options.reviewInfo.locale,
        limit: '2',
      }),
    );
    if (
      localizations.length !== 1 ||
      !sameSelectedAttributes(
        attributesOf(localizations[0] as JsonApiResource),
        localizationAttributes(options.reviewInfo),
      )
    ) {
      throw new Error(
        'Apply verification found TestFlight beta metadata mismatched.',
      );
    }
  }
  if (options.submitBetaReview && build !== null) {
    const submissions = await client.list(
      appendQuery('/v1/betaAppReviewSubmissions', {
        'fields[betaAppReviewSubmissions]': 'betaReviewState',
        'filter[build]': build.id,
        limit: '200',
      }),
    );
    if (existingSubmissionState(submissions) === null) {
      throw new Error(
        'Apply verification found no Beta App Review submission.',
      );
    }
  }
};

export const syncTestFlight = async (
  client: AscClient,
  options: SyncOptions,
): Promise<SyncResult> => {
  if (
    options.submitBetaReview &&
    (options.reviewInfo === undefined || options.build === undefined)
  ) {
    throw new Error(
      'Beta App Review submission requires review info and a build.',
    );
  }
  if (options.apply && options.build === 'latest') {
    throw new Error(
      'Apply requires the exact build ID returned by a prior latest-build preview.',
    );
  }
  if (options.internalTesters.length > 100) {
    throw new Error("Internal tester input exceeds Apple's 100-user limit.");
  }
  if (options.externalTesters.length > 10_000) {
    throw new Error("External tester input exceeds Apple's 10,000-user limit.");
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
  const apps = await client.list(
    appendQuery('/v1/apps', {
      'fields[apps]': 'name,bundleId,sku',
      'filter[bundleId]': BUNDLE_ID,
      limit: '2',
    }),
  );
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
  const groups = await client.list(
    appendQuery('/v1/betaGroups', { 'filter[app]': app.id, limit: '200' }),
  );
  await Promise.all([
    preflightAppCapacity(client, groups, true, options.internalTesters, 100),
    preflightAppCapacity(
      client,
      groups,
      false,
      options.externalTesters,
      10_000,
    ),
  ]);
  const internalGroupId = await ensureGroup(
    client,
    app.id,
    groups,
    INTERNAL_GROUP_NAME,
    true,
    options.apply,
    actions,
  );
  const externalGroupId = await ensureGroup(
    client,
    app.id,
    groups,
    EXTERNAL_GROUP_NAME,
    false,
    options.apply,
    actions,
  );
  await syncTesters(
    client,
    internalGroupId,
    INTERNAL_GROUP_NAME,
    options.internalTesters,
    options.apply,
    actions,
  );
  await syncTesters(
    client,
    externalGroupId,
    EXTERNAL_GROUP_NAME,
    options.externalTesters,
    options.apply,
    actions,
  );
  if (options.reviewInfo !== undefined) {
    await syncReviewInfo(
      client,
      app.id,
      options.reviewInfo,
      options.apply,
      actions,
    );
  }
  if (build !== null) {
    await attachBuild(
      client,
      internalGroupId,
      INTERNAL_GROUP_NAME,
      build,
      options.apply,
      actions,
    );
    if (options.submitBetaReview) {
      await attachBuild(
        client,
        externalGroupId,
        EXTERNAL_GROUP_NAME,
        build,
        options.apply,
        actions,
      );
      await submitForBetaReview(client, build, options.apply, actions);
    }
  }
  if (options.apply) {
    await verifyAppliedState(client, app.id, options, build);
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
  --help                    Show this help

Credentials (environment only): ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH.
Without --apply the command performs authenticated reads and prints a plan.`;

export const parseCli = (arguments_: readonly string[]): CliOptions => {
  if (arguments_[0] !== 'sync') throw new Error(usage);
  let apply = false;
  let submitBetaReview = false;
  let build: string | undefined;
  let confirmApply: string | undefined;
  let externalTestersPath: string | undefined;
  let internalTestersPath: string | undefined;
  let reviewInfoPath: string | undefined;
  const valueFlags = new Map<string, (value: string) => void>([
    ['--build', (value) => (build = value)],
    ['--confirm-apply', (value) => (confirmApply = value)],
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
      throw new Error(`Unknown argument: ${argument ?? ''}`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value.`);
    }
    setValue(value);
    index += 1;
  }
  if (apply && confirmApply !== BUNDLE_ID) {
    throw new Error(`--apply requires --confirm-apply ${BUNDLE_ID}.`);
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
    ...(externalTestersPath === undefined ? {} : { externalTestersPath }),
    ...(internalTestersPath === undefined ? {} : { internalTestersPath }),
    ...(reviewInfoPath === undefined ? {} : { reviewInfoPath }),
  };
};

const readTesters = async (
  path: string | undefined,
): Promise<readonly Tester[]> => {
  if (path === undefined) return [];
  const safePath = await requireExternalPath(path, 'Tester CSV');
  return parseTesterCsv(
    await readBoundedFile(safePath, 5_000_000, 'Tester CSV'),
  );
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
  const safeKeyPath = await requireExternalPath(keyPath, 'ASC private key');
  const [privateKey, internalTesters, externalTesters, reviewInfo] =
    await Promise.all([
      readBoundedFile(safeKeyPath, 64_000, 'ASC private key'),
      readTesters(cli.internalTestersPath),
      readTesters(cli.externalTestersPath),
      cli.reviewInfoPath === undefined
        ? Promise.resolve(undefined)
        : requireExternalPath(cli.reviewInfoPath, 'Beta-review input').then(
            async (path) =>
              parseReviewInfo(
                JSON.parse(
                  await readBoundedFile(path, 64_000, 'Beta-review input'),
                ) as unknown,
              ),
          ),
    ]);
  const client = new AppStoreConnectClient({ issuerId, keyId, privateKey });
  const result = await syncTestFlight(client, {
    apply: cli.apply,
    externalTesters,
    internalTesters,
    submitBetaReview: cli.submitBetaReview,
    ...(cli.build === undefined ? {} : { build: cli.build }),
    ...(reviewInfo === undefined ? {} : { reviewInfo }),
  });
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
