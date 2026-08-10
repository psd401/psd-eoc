import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertAwsAccount,
  assertDefaultTerraformWorkspace,
  assertNoAmbientTransportOverrides,
  awsServiceEndpoint,
  awsSecretExists,
  isPathOutsideDirectory,
  putSecretValue,
  readSecretValue,
  reconcileIdempotentSecretWrite,
  requireExactConfirmation,
  requiredString,
  runCommand,
  secretVersionIsCurrent,
} from './runtime';

const AWS_ACCOUNT_ID = '<aws-account-id>';
const AWS_PROFILE = 'psd401-prr-prod';
const AWS_REGION = 'us-west-2';
const SECRET_NAME = '/psd-eoc/google-oauth';
const PROJECT_ID = 'psd401-eoc';
const MOBILE_APPLICATION_ID = 'net.psd401.eoc';
const EXPECTED_ORIGIN = 'https://eoc.psd401.net';
const EXPECTED_REDIRECT = 'https://eoc.psd401.net/auth/callback';
const MAX_OAUTH_DOWNLOAD_BYTES = 64 * 1024;
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const standardPlistDoctype =
  /<!DOCTYPE\s+plist\s+PUBLIC\s+"-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"\s+"http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"\s*>/giu;

interface GoogleWebClientDownload {
  readonly web?: Readonly<Record<string, unknown>>;
}

export interface SecureFileReadOperations {
  readonly afterInitialValidation: () => void | Promise<void>;
}

export function terraformProjectNumber(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Terraform project output is invalid.');
  }
  const output = value as Readonly<Record<string, unknown>>;
  if (
    output.id !== PROJECT_ID ||
    output.name !== 'PSD EOC' ||
    output.parent !== 'organizations/482073499306' ||
    typeof output.number !== 'string' ||
    !/^\d+$/u.test(output.number)
  ) {
    throw new Error('Terraform project output is invalid.');
  }
  return output.number;
}

function readLiveTerraformProjectNumber(): string {
  let liveProject: unknown;
  try {
    assertDefaultTerraformWorkspace();
    liveProject = JSON.parse(
      runCommand('terraform', ['output', '-json', 'project']),
    );
  } catch {
    throw new Error('Terraform project output did not contain valid JSON.');
  }
  return terraformProjectNumber(liveProject);
}

function exactStringArray(value: unknown, expected: string): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === 'string' &&
    value[0] === expected
  );
}

function oauthClientId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/u.test(value)
  );
}

function oauthClientProjectNumber(value: string): string {
  return value.slice(0, value.indexOf('-'));
}

function decodeXmlText(value: string): string {
  if (/&(?!(?:amp|apos|gt|lt|quot);)/u.test(value)) {
    throw new Error('iOS OAuth plist contains an unsupported XML entity.');
  }
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&quot;', '"');
}

export function parsePlistStrings(
  value: string,
): Readonly<Record<string, string>> {
  const withoutStandardDoctype = value.replace(standardPlistDoctype, '');
  if (/<!DOCTYPE|<!ENTITY/iu.test(withoutStandardDoctype)) {
    throw new Error(
      'iOS OAuth plist must not declare a document type or entity.',
    );
  }
  const parsed: Record<string, string> = {};
  const entries = value.matchAll(
    /<key>\s*([^<]+?)\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/gu,
  );
  for (const entry of entries) {
    const encodedName = entry[1];
    const encodedValue = entry[2];
    if (encodedName === undefined || encodedValue === undefined) {
      throw new Error('iOS OAuth plist contains an invalid string entry.');
    }
    const name = decodeXmlText(encodedName.trim());
    if (Object.hasOwn(parsed, name)) {
      throw new Error('iOS OAuth plist contains a duplicate key.');
    }
    parsed[name] = decodeXmlText(encodedValue.trim());
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error('iOS OAuth plist has no string entries.');
  }
  return parsed;
}

async function descriptorRealpath(handle: FileHandle): Promise<string> {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    return realpath(`/dev/fd/${handle.fd}`);
  }
}

async function readBoundedDescriptor(handle: FileHandle): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_OAUTH_DOWNLOAD_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return Buffer.from(buffer.subarray(0, offset));
}

export async function readSecureFileBytes(
  path: string,
  operations?: SecureFileReadOperations,
): Promise<Buffer> {
  assertNoAmbientTransportOverrides();
  const requested = resolve(path);
  if (!isPathOutsideDirectory(repositoryRoot, requested)) {
    throw new Error('OAuth downloads must remain outside the repository.');
  }
  const preflightResolved = await realpath(requested);
  if (!isPathOutsideDirectory(repositoryRoot, preflightResolved)) {
    throw new Error('OAuth downloads must remain outside the repository.');
  }

  const handle = await open(
    requested,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const resolved = await descriptorRealpath(handle);
    if (!isPathOutsideDirectory(repositoryRoot, resolved)) {
      throw new Error('OAuth downloads must remain outside the repository.');
    }

    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size === 0n ||
      before.size > BigInt(MAX_OAUTH_DOWNLOAD_BYTES)
    ) {
      throw new Error('OAuth download must be one regular file under 64 KiB.');
    }
    if ((before.mode & 0o077n) !== 0n) {
      throw new Error(
        'OAuth download permissions must deny all group and other access (for example, chmod 600).',
      );
    }

    await operations?.afterInitialValidation();
    const contents = await readBoundedDescriptor(handle);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(contents.length) !== before.size
    ) {
      throw new Error('OAuth download changed while it was being read.');
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function readSecureFile(path: string): Promise<string> {
  return (await readSecureFileBytes(path)).toString('utf8');
}

export async function readWebClientDownload(
  path: string,
): Promise<GoogleWebClientDownload> {
  const contents = await readSecureFile(path);
  try {
    return JSON.parse(contents) as GoogleWebClientDownload;
  } catch {
    throw new Error('Web OAuth client download did not contain valid JSON.');
  }
}

function createOauthSecretPlaceholder(): void {
  runCommand('aws', [
    'secretsmanager',
    'create-secret',
    '--name',
    SECRET_NAME,
    '--description',
    'PSD EOC Google OAuth web secret and native public client IDs.',
    '--region',
    AWS_REGION,
    '--profile',
    AWS_PROFILE,
    '--endpoint-url',
    awsServiceEndpoint('secretsmanager', AWS_REGION),
    '--tags',
    'Key=Application,Value=PSD EOC',
    'Key=ManagedBy,Value=infra/gcp',
    '--query',
    'ARN',
    '--output',
    'text',
  ]);
}

function inspectOauthSecretDestination(): boolean {
  assertAwsAccount(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION);
  return awsSecretExists({
    expectedAccountId: AWS_ACCOUNT_ID,
    profile: AWS_PROFILE,
    region: AWS_REGION,
    secretName: SECRET_NAME,
  });
}

function assertOauthSecretDestination(): void {
  if (!inspectOauthSecretDestination()) {
    throw new Error('The expected OAuth secret is unavailable.');
  }
}

function assertStoredValues(expected: Readonly<Record<string, unknown>>): void {
  const stored = readSecretValue({
    profile: AWS_PROFILE,
    region: AWS_REGION,
    secretName: SECRET_NAME,
  });
  if (
    JSON.stringify(Object.keys(stored).sort()) !==
      JSON.stringify(Object.keys(expected).sort()) ||
    stored.clientId !== expected.clientId ||
    stored.clientSecret !== expected.clientSecret ||
    stored.webClientId !== expected.webClientId ||
    stored.iosClientId !== expected.iosClientId ||
    stored.iosBundleId !== MOBILE_APPLICATION_ID
  ) {
    throw new Error('AWS did not read back the exact OAuth client contract.');
  }
}

async function main(): Promise<void> {
  const [webClientPath, iosClientPath, ...extraArguments] =
    process.argv.slice(2);
  if (
    webClientPath === undefined ||
    iosClientPath === undefined ||
    extraArguments.length > 0
  ) {
    throw new Error(
      'Usage: ./scripts/run-guarded.sh store-oauth-client /secure/web-client.json /secure/ios-client.plist',
    );
  }

  const downloaded = await readWebClientDownload(webClientPath);
  if (
    downloaded.web === undefined ||
    downloaded.web.project_id !== PROJECT_ID ||
    downloaded.web.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
    downloaded.web.token_uri !== 'https://oauth2.googleapis.com/token' ||
    !exactStringArray(downloaded.web.javascript_origins, EXPECTED_ORIGIN) ||
    !exactStringArray(downloaded.web.redirect_uris, EXPECTED_REDIRECT)
  ) {
    throw new Error(
      'Web OAuth client does not match the fixed psd401-eoc production contract.',
    );
  }
  const webClientId = requiredString(downloaded.web, 'client_id');
  const webClientSecret = requiredString(downloaded.web, 'client_secret');
  if (!oauthClientId(webClientId)) {
    throw new Error('Web OAuth client ID has an invalid format.');
  }
  const liveProjectNumber = readLiveTerraformProjectNumber();
  if (oauthClientProjectNumber(webClientId) !== liveProjectNumber) {
    throw new Error(
      'Web OAuth client ID does not belong to the Terraform-managed project.',
    );
  }

  const iosClient = parsePlistStrings(await readSecureFile(iosClientPath));
  const iosClientId = iosClient.CLIENT_ID;
  if (
    (iosClient.PROJECT_ID !== undefined &&
      iosClient.PROJECT_ID !== PROJECT_ID) ||
    iosClient.PLIST_VERSION !== '1' ||
    iosClient.BUNDLE_ID !== MOBILE_APPLICATION_ID ||
    iosClient.REVERSED_CLIENT_ID !==
      `com.googleusercontent.apps.${iosClientId?.replace('.apps.googleusercontent.com', '')}` ||
    !oauthClientId(iosClientId) ||
    oauthClientProjectNumber(iosClientId) !==
      oauthClientProjectNumber(webClientId) ||
    iosClientId === webClientId
  ) {
    throw new Error(
      'iOS OAuth client does not match the fixed psd401-eoc bundle contract.',
    );
  }

  inspectOauthSecretDestination();
  await requireExactConfirmation(
    'OAuth credential consequence preview: create or replace the live PSD EOC Google web credential in the retained AWS secret and add the public iOS client ID. This configures sign-in credentials but does not deploy the app, send a notification, or authorize any human-only action.',
    'store-psd-eoc-google-oauth',
  );
  if (!inspectOauthSecretDestination()) {
    createOauthSecretPlaceholder();
    assertOauthSecretDestination();
  }
  const confirmedProjectNumber = readLiveTerraformProjectNumber();
  if (
    oauthClientProjectNumber(webClientId) !== confirmedProjectNumber ||
    oauthClientProjectNumber(iosClientId) !== confirmedProjectNumber
  ) {
    throw new Error(
      'OAuth client IDs no longer belong to the Terraform-managed project.',
    );
  }

  const secretValue = {
    clientId: webClientId,
    clientSecret: webClientSecret,
    iosBundleId: MOBILE_APPLICATION_ID,
    iosClientId,
    webClientId,
  } as const;
  const clientRequestToken = randomUUID();
  const versionStored = await reconcileIdempotentSecretWrite({
    attemptWrite: () => {
      assertOauthSecretDestination();
      return putSecretValue({
        clientRequestToken,
        profile: AWS_PROFILE,
        region: AWS_REGION,
        secretName: SECRET_NAME,
        secretValue,
      });
    },
    clientRequestToken,
    versionIsCurrent: () => {
      assertOauthSecretDestination();
      return secretVersionIsCurrent({
        clientRequestToken,
        profile: AWS_PROFILE,
        region: AWS_REGION,
        secretName: SECRET_NAME,
      });
    },
  });
  if (!versionStored) {
    throw new Error('AWS did not store the expected OAuth credential version.');
  }
  assertOauthSecretDestination();
  assertStoredValues(secretValue);
  assertOauthSecretDestination();
  console.log(
    `Stored and read back the web credential plus iOS public client ID in ${SECRET_NAME}; no credential value was printed. Securely delete both source downloads now.`,
  );
}

if (import.meta.main) {
  await main();
}
