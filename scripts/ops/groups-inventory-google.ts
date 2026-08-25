import { lstat, rm } from 'node:fs/promises';

import { userInfo } from 'node:os';

import { dirname, join } from 'node:path';

import {
  CLOUD_IDENTITY_ORIGIN,
  CLOUD_IDENTITY_SCOPE,
  MAX_ADC_FILE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_PAGES,
  MAX_GROUPS,
  MAX_GROUPS_PER_PAGE,
  type CloudGroup,
  isRecord,
  requireString,
  isHostedGroupEmail,
  hasUnsafeDisplayControl,
  compareText,
  sortedUnique,
} from './groups-inventory-model';

import {
  statIfPresent,
  requirePathOutsideGitRepository,
  createIsolatedGcloudConfigPath,
  readPrivateJson,
} from './groups-inventory-files';
interface GroupPage {
  readonly groups: readonly CloudGroup[];
  readonly nextPageToken: string | null;
}

interface InventoryResult {
  readonly groups: readonly CloudGroup[];
  readonly pageCount: number;
}
type PageFetcher = (pageToken: string | null) => Promise<unknown>;
type HttpFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export const parseCloudGroupForDomain = (
  value: unknown,
  expectedParent: string,
  hostedDomain: string,
): CloudGroup => {
  if (!isRecord(value)) throw new Error('Google returned a malformed group.');
  const name = requireString(value.name, 'Google group resource name', 255);
  if (!/^groups\/[A-Za-z0-9_-]{1,248}$/u.test(name)) {
    throw new Error('Google returned an invalid group resource name.');
  }
  if (value.parent !== expectedParent) {
    throw new Error('Google returned a group from an unexpected customer.');
  }
  if (!isRecord(value.groupKey)) {
    throw new Error('Google returned a group without a valid primary key.');
  }
  const email = requireString(
    value.groupKey.id,
    'Google group email',
    320,
  ).toLocaleLowerCase('en-US');
  if (!isHostedGroupEmail(email, hostedDomain)) {
    throw new Error(
      'Google returned a group outside the configured hosted domain.',
    );
  }
  const displayName =
    value.displayName === undefined ||
    value.displayName === null ||
    value.displayName === ''
      ? null
      : requireString(value.displayName, 'Google group display name', 160);
  if (displayName !== null && hasUnsafeDisplayControl(displayName)) {
    throw new Error('Google returned an unsafe group display name.');
  }
  return {
    displayName,
    email,
    googleGroupId: name,
  };
};

export const parseGroupPage = (
  value: unknown,
  expectedParent: string,
  hostedDomain: string,
): GroupPage => {
  if (!isRecord(value)) {
    throw new Error('Google returned a malformed groups page.');
  }
  const rawGroups = value.groups === undefined ? [] : value.groups;
  if (!Array.isArray(rawGroups) || rawGroups.length > MAX_GROUPS_PER_PAGE) {
    throw new Error('Google returned a malformed groups page.');
  }
  const groups = rawGroups.map((group) =>
    parseCloudGroupForDomain(group, expectedParent, hostedDomain),
  );
  const rawToken = value.nextPageToken;
  const nextPageToken =
    rawToken === undefined || rawToken === null || rawToken === ''
      ? null
      : requireString(rawToken, 'Google next-page token', 2_048);
  return { groups, nextPageToken };
};

export const inventoryAllGroups = async (
  fetchPage: PageFetcher,
  customerId: string,
  hostedDomain: string,
): Promise<InventoryResult> => {
  const groups: CloudGroup[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;
  let pageCount = 0;

  while (true) {
    if (pageCount >= MAX_PAGES) {
      throw new Error('Google Groups pagination exceeded its page limit.');
    }
    const page = parseGroupPage(
      await fetchPage(pageToken),
      `customers/${customerId}`,
      hostedDomain,
    );
    pageCount += 1;
    groups.push(...page.groups);
    if (groups.length > MAX_GROUPS) {
      throw new Error('Google returned more groups than the safety limit.');
    }
    if (page.nextPageToken === null) break;
    if (seenTokens.has(page.nextPageToken)) {
      throw new Error('Google Groups pagination repeated a page token.');
    }
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }

  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.googleGroupId) || emails.has(group.email)) {
      throw new Error('Google returned duplicate group identity metadata.');
    }
    ids.add(group.googleGroupId);
    emails.add(group.email);
  }
  return {
    groups: [...groups].sort((left, right) =>
      compareText(left.email, right.email),
    ),
    pageCount,
  };
};

export const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the fixed, sanitized size-limit failure.
        }
        throw new Error(`${label} exceeded its size limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
};

const cancelResponseBodySafely = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup diagnostics are untrusted and must not replace fixed errors.
  }
};

export const readBoundedResponseJson = async (
  response: Response,
): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await cancelResponseBodySafely(response);
    throw new Error('Google response exceeded its size limit.');
  }
  if (response.body === null)
    throw new Error('Google returned an empty response.');
  const text = await readBoundedStream(
    response.body,
    MAX_RESPONSE_BYTES,
    'Google response',
  );
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error('Google returned invalid JSON.', { cause: error });
  }
};

export const createCloudIdentityFetcher =
  (
    accessToken: string,
    customerId: string,
    quotaProject: string,
    fetchImplementation: HttpFetch = fetch,
  ): PageFetcher =>
  async (pageToken) => {
    const url = new URL('/v1/groups:search', CLOUD_IDENTITY_ORIGIN);
    url.searchParams.set('query', `parent == 'customers/${customerId}'`);
    url.searchParams.set('view', 'FULL');
    url.searchParams.set(
      'fields',
      'groups(name,parent,groupKey(id),displayName),nextPageToken',
    );
    url.searchParams.set('pageSize', '500');
    if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
    if (url.origin !== CLOUD_IDENTITY_ORIGIN) {
      throw new Error(
        'Refusing to send Google credentials to an unexpected URL.',
      );
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Goog-User-Project': quotaProject,
          },
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt === 3) {
          throw new Error('The read-only Google Groups request failed.', {
            cause: error,
          });
        }
        await Bun.sleep(attempt * 500);
        continue;
      }
      if (response.ok) {
        try {
          return await readBoundedResponseJson(response);
        } catch (error) {
          if (attempt === 3) {
            throw new Error(
              'Google repeatedly returned an unreadable groups response.',
              { cause: error },
            );
          }
          await Bun.sleep(attempt * 500);
          continue;
        }
      }
      const retryable =
        (response.status === 429 || response.status >= 500) && attempt < 3;
      if (retryable) {
        await cancelResponseBodySafely(response);
        await Bun.sleep(attempt * 500);
        continue;
      }
      await cancelResponseBodySafely(response);
      throw new Error(
        `The read-only Google Groups request failed with HTTP ${response.status}.`,
      );
    }
    throw new Error(
      'The read-only Google Groups request exhausted its retries.',
    );
  };

export const gcloudTokenArguments = (
  gcloudExecutable: string,
  serviceAccount: string,
): string[] => [
  gcloudExecutable,
  'auth',
  'application-default',
  'print-access-token',
  `--impersonate-service-account=${serviceAccount}`,
  `--scopes=${CLOUD_IDENTITY_SCOPE}`,
  '--lifetime=900s',
  '--quiet',
];

export const UNSAFE_AUTH_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'BUN_OPTIONS',
  'BUN_CONFIG_CA',
  'BUN_CONFIG_CAFILE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NO_PROXY',
  'SSLKEYLOGFILE',
  'VIRTUAL_ENV',
  'XDG_CONFIG_HOME',
]);

const UNSAFE_AUTH_ENVIRONMENT_PREFIXES = [
  'CLOUDSDK_',
  'CURL_',
  'DYLD_',
  'GCE_',
  'GCLOUD_',
  'GOOGLE_',
  'GRPC_',
  'LD_',
  'OPENSSL_',
  'PYTHON',
  'REQUESTS_',
  'SSL_',
] as const;

export const assertSafeAuthenticationEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    if ((value ?? '').trim() === '') continue;
    const normalizedKey = key.toUpperCase();
    if (
      UNSAFE_AUTH_ENVIRONMENT_KEYS.has(normalizedKey) ||
      UNSAFE_AUTH_ENVIRONMENT_PREFIXES.some((prefix) =>
        normalizedKey.startsWith(prefix),
      )
    ) {
      throw new Error(
        `Refusing ${key}; authentication and TLS execution settings may not be overridden.`,
      );
    }
  }
};

export const createHumanAdcEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  verifiedAdcPath: string,
  isolatedGcloudConfigPath: string,
  gcloudExecutable: string,
  operatingSystemHome: string,
): Record<string, string> => {
  assertSafeAuthenticationEnvironment(source);
  if (
    !verifiedAdcPath.startsWith('/') ||
    !isolatedGcloudConfigPath.startsWith('/') ||
    !gcloudExecutable.startsWith('/') ||
    !operatingSystemHome.startsWith('/')
  ) {
    throw new Error(
      'Credential, configuration, and gcloud paths must be absolute.',
    );
  }
  return {
    CLOUDSDK_API_ENDPOINT_OVERRIDES_IAMCREDENTIALS:
      'https://iamcredentials.googleapis.com/',
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: verifiedAdcPath,
    CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION: 'false',
    CLOUDSDK_AUTH_MTLS_TOKEN_HOST: 'https://oauth2.mtls.googleapis.com/token',
    CLOUDSDK_AUTH_TOKEN_HOST: 'https://oauth2.googleapis.com/token',
    CLOUDSDK_CONFIG: isolatedGcloudConfigPath,
    CLOUDSDK_CONTEXT_AWARE_USE_CLIENT_CERTIFICATE: 'false',
    CLOUDSDK_CORE_UNIVERSE_DOMAIN: 'googleapis.com',
    GOOGLE_APPLICATION_CREDENTIALS: verifiedAdcPath,
    GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'googleapis.com',
    HOME: operatingSystemHome,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: sortedUnique([
      dirname(gcloudExecutable),
      '/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/usr/sbin',
      '/sbin',
    ]).join(':'),
    TERM: 'dumb',
    TMPDIR: isolatedGcloudConfigPath,
  };
};

export const parseInteractiveUserAdc = (value: unknown): void => {
  if (!isRecord(value) || value.type !== 'authorized_user') {
    throw new Error(
      'Application Default Credentials must come from an interactive user login.',
    );
  }
  for (const key of ['client_id', 'client_secret', 'refresh_token'] as const) {
    requireString(value[key], 'Interactive user ADC field', 16_384);
  }
  if (
    'service_account_impersonation_url' in value ||
    'credential_source' in value ||
    'subject_token_type' in value ||
    (value.token_uri !== undefined &&
      value.token_uri !== 'https://oauth2.googleapis.com/token') ||
    (value.universe_domain !== undefined &&
      value.universe_domain !== 'googleapis.com')
  ) {
    throw new Error(
      'Application Default Credentials may not embed non-user credential provenance.',
    );
  }
};

const verifyInteractiveUserAdc = async (
  operatingSystemHome: string,
): Promise<string> => {
  const adcPath = await requirePathOutsideGitRepository(
    join(
      operatingSystemHome,
      '.config',
      'gcloud',
      'application_default_credentials.json',
    ),
    'Interactive Application Default Credentials',
  );
  parseInteractiveUserAdc(
    await readPrivateJson(
      adcPath,
      'Interactive Application Default Credentials',
      MAX_ADC_FILE_BYTES,
    ),
  );
  return adcPath;
};

export interface GcloudPathMetadata {
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

const hasTrustedGcloudOwner = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean => metadata.uid === 0 || metadata.uid === currentUid;

export const isTrustedGcloudExecutableMetadata = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean =>
  metadata.isFile() &&
  hasTrustedGcloudOwner(metadata, currentUid) &&
  (metadata.mode & 0o111) !== 0 &&
  (metadata.mode & 0o022) === 0;

export const isTrustedGcloudAncestorMetadata = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean =>
  metadata.isDirectory() &&
  hasTrustedGcloudOwner(metadata, currentUid) &&
  (metadata.mode & 0o022) === 0;

const isTrustedGcloudExecutablePath = async (
  actualPath: string,
): Promise<boolean> => {
  const currentUid = userInfo().uid;
  const executableMetadata = await lstat(actualPath);
  if (!isTrustedGcloudExecutableMetadata(executableMetadata, currentUid)) {
    return false;
  }

  let ancestor = dirname(actualPath);
  while (true) {
    const metadata = await lstat(ancestor);
    if (!isTrustedGcloudAncestorMetadata(metadata, currentUid)) return false;
    const parent = dirname(ancestor);
    if (parent === ancestor) return true;
    ancestor = parent;
  }
};

const resolveGcloudExecutable = async (
  operatingSystemHome: string,
): Promise<string> => {
  const approvedInstallLocations = [
    '/opt/homebrew/bin/gcloud',
    '/snap/bin/gcloud',
    '/usr/bin/gcloud',
    '/usr/local/bin/gcloud',
    join(operatingSystemHome, 'google-cloud-sdk', 'bin', 'gcloud'),
    join(operatingSystemHome, 'Library', 'google-cloud-sdk', 'bin', 'gcloud'),
  ];
  for (const candidate of approvedInstallLocations) {
    if ((await statIfPresent(candidate)) === null) continue;
    const actualPath = await requirePathOutsideGitRepository(
      candidate,
      'gcloud executable',
    );
    if (await isTrustedGcloudExecutablePath(actualPath)) {
      return actualPath;
    }
  }
  throw new Error(
    'gcloud was not found in an approved installation location or its ownership and permission chain was not trusted.',
  );
};

export const obtainImpersonatedToken = async (
  serviceAccount: string,
): Promise<string> => {
  assertSafeAuthenticationEnvironment(process.env);
  const operatingSystemHome = userInfo().homedir;
  const adcPath = await verifyInteractiveUserAdc(operatingSystemHome);
  const isolatedGcloudConfigPath = await createIsolatedGcloudConfigPath();
  try {
    // Resolve and verify immediately before the synchronous spawn call. Bun
    // cannot execute an already-open file descriptor on every supported OS;
    // the trusted, non-writable ownership chain prevents an untrusted actor
    // from replacing the resolved executable in this remaining interval.
    const gcloudExecutable = await resolveGcloudExecutable(operatingSystemHome);
    const environment = createHumanAdcEnvironment(
      process.env,
      adcPath,
      isolatedGcloudConfigPath,
      gcloudExecutable,
      operatingSystemHome,
    );
    const subprocess = Bun.spawn(
      gcloudTokenArguments(gcloudExecutable, serviceAccount),
      {
        env: environment,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const stdout = readBoundedStream(
      subprocess.stdout,
      16_000,
      'gcloud token output',
    );
    const stderr = readBoundedStream(
      subprocess.stderr,
      64_000,
      'gcloud diagnostic output',
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => {
        try {
          subprocess.kill(9);
        } catch {
          // A process that exited on the timeout boundary needs no signal.
        }
        resolve({ kind: 'timeout' });
      }, 30_000);
    });
    const completion = await Promise.race([
      subprocess.exited.then((exitCode) => ({
        exitCode,
        kind: 'exited' as const,
      })),
      timedOut,
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (completion.kind === 'timeout') {
      await Promise.race([
        Promise.allSettled([stdout, stderr, subprocess.exited]),
        Bun.sleep(2_000),
      ]);
      throw new Error('gcloud token generation timed out.');
    }
    const [tokenOutput] = await Promise.all([stdout, stderr]);
    if (completion.exitCode !== 0) {
      throw new Error(
        'gcloud could not issue the impersonated read-only token. Complete the documented human ADC login and IAM grants.',
      );
    }
    const token = tokenOutput.trim();
    if (!/^[\x21-\x7E]{20,8192}$/u.test(token)) {
      throw new Error('gcloud returned a malformed access token.');
    }
    return token;
  } finally {
    await rm(isolatedGcloudConfigPath, { force: true, recursive: true });
  }
};
