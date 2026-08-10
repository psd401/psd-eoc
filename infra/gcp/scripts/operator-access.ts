import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGroupsReaderContract } from './groups-contract';
import {
  APPLICATION_DEFAULT_IDENTITY_SCOPES,
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  assertAwsAccount,
  assertAwsSsoLoginConfiguration,
  assertSafeGcloudConfiguration,
  isPathOutsideDirectory,
  runCommandForStatus,
  runInteractive,
} from './runtime';

const ADMIN_EMAIL = 'kjh_admin@psd401.net';
const AWS_ACCOUNT_ID = '338414773271';
const AWS_PROFILE = 'psd401-prr-prod';
const AWS_REGION = 'us-west-2';
const WORKSPACE_ROLE_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.rolemanagement';
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function validateWorkspaceAdminClient(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Workspace administrator OAuth client is invalid.');
  }
  const document = value as Readonly<Record<string, unknown>>;
  const installed = document.installed;
  if (
    !exactKeys(document, new Set(['installed'])) ||
    typeof installed !== 'object' ||
    installed === null ||
    Array.isArray(installed)
  ) {
    throw new Error('Workspace administrator OAuth client is invalid.');
  }
  const client = installed as Readonly<Record<string, unknown>>;
  const redirectUris = client.redirect_uris;
  if (
    !exactKeys(
      client,
      new Set([
        'auth_provider_x509_cert_url',
        'auth_uri',
        'client_id',
        'client_secret',
        'project_id',
        'redirect_uris',
        'token_uri',
      ]),
    ) ||
    client.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
    client.token_uri !== 'https://oauth2.googleapis.com/token' ||
    (client.auth_provider_x509_cert_url !== undefined &&
      client.auth_provider_x509_cert_url !==
        'https://www.googleapis.com/oauth2/v1/certs') ||
    typeof client.client_id !== 'string' ||
    !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(
      client.client_id,
    ) ||
    typeof client.client_secret !== 'string' ||
    client.client_secret.length === 0 ||
    typeof client.project_id !== 'string' ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(client.project_id) ||
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.some(
      (uri) =>
        typeof uri !== 'string' ||
        !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/u.test(uri),
    )
  ) {
    throw new Error('Workspace administrator OAuth client is invalid.');
  }
}

function secureWorkspaceClientPath(path: string): string {
  let resolved: string;
  let contents: string;
  try {
    const requested = resolve(path);
    resolved = realpathSync(requested);
    const metadata = statSync(resolved);
    if (
      !isPathOutsideDirectory(repositoryRoot, requested) ||
      !isPathOutsideDirectory(repositoryRoot, resolved) ||
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > 64 * 1024 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error('invalid metadata');
    }
    contents = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(
      'Workspace administrator OAuth client must be one mode-0600 file outside the repository and under 64 KiB.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Workspace administrator OAuth client is invalid.');
  }
  validateWorkspaceAdminClient(value);
  return resolved;
}

function ordinaryAdcLogin(): void {
  runInteractive('gcloud', [
    'auth',
    'application-default',
    'login',
    ADMIN_EMAIL,
    '--disable-quota-project',
    '--no-launch-browser',
    `--scopes=${APPLICATION_DEFAULT_IDENTITY_SCOPES.join(',')}`,
  ]);
}

function revokeApplicationDefaultCredentials(): void {
  const result = runCommandForStatus('gcloud', [
    'auth',
    'application-default',
    'revoke',
    '--quiet',
  ]);
  const detail = `${result.stderr}\n${result.stdout}`;
  if (
    result.status !== 0 ||
    /cannot be revoked|could not revoke|failed to revoke|not revocable/iu.test(
      detail,
    )
  ) {
    throw new Error(
      'Existing Application Default Credentials could not be revoked safely.',
    );
  }
}

function replaceWithOrdinaryAdc(): void {
  revokeApplicationDefaultCredentials();
  ordinaryAdcLogin();
}

async function authenticate(): Promise<void> {
  assertSafeGcloudConfiguration();
  runInteractive('gcloud', [
    'auth',
    'login',
    ADMIN_EMAIL,
    '--force',
    '--no-launch-browser',
  ]);
  assertActiveGcloudAccount(ADMIN_EMAIL);
  replaceWithOrdinaryAdc();
  await assertApplicationDefaultIdentity(ADMIN_EMAIL);

  assertAwsSsoLoginConfiguration(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION);
  runInteractive('aws', [
    'sso',
    'login',
    '--profile',
    AWS_PROFILE,
    '--no-browser',
  ]);
  assertAwsAccount(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION);
}

async function authorizeWorkspaceAdc(clientPath: string): Promise<void> {
  assertActiveGcloudAccount(ADMIN_EMAIL);
  const secureClientPath = secureWorkspaceClientPath(clientPath);
  revokeApplicationDefaultCredentials();
  runInteractive('gcloud', [
    'auth',
    'application-default',
    'login',
    ADMIN_EMAIL,
    `--client-id-file=${secureClientPath}`,
    '--no-browser',
    `--scopes=${[
      ...APPLICATION_DEFAULT_IDENTITY_SCOPES,
      WORKSPACE_ROLE_SCOPE,
    ].join(',')}`,
  ]);
  await assertApplicationDefaultIdentity(ADMIN_EMAIL);
}

async function restoreOrdinaryAdc(): Promise<void> {
  assertActiveGcloudAccount(ADMIN_EMAIL);
  replaceWithOrdinaryAdc();
  await assertApplicationDefaultIdentity(ADMIN_EMAIL);
}

async function showGroupsReaderClientId(): Promise<void> {
  assertActiveGcloudAccount(ADMIN_EMAIL);
  await assertApplicationDefaultIdentity(ADMIN_EMAIL);
  console.log(readGroupsReaderContract().oauthClientId);
}

async function main(): Promise<void> {
  const [operation, ...arguments_] = process.argv.slice(2);
  if (operation === 'authenticate' && arguments_.length === 0) {
    await authenticate();
    return;
  }
  if (
    operation === 'authorize-workspace-adc' &&
    arguments_.length === 1 &&
    arguments_[0] !== undefined
  ) {
    await authorizeWorkspaceAdc(arguments_[0]);
    return;
  }
  if (operation === 'restore-adc' && arguments_.length === 0) {
    await restoreOrdinaryAdc();
    return;
  }
  if (operation === 'show-groups-reader-client-id' && arguments_.length === 0) {
    await showGroupsReaderClientId();
    return;
  }
  throw new Error(
    'Usage: ./scripts/run-guarded.sh {authenticate|authorize-workspace-adc|restore-adc|show-groups-reader-client-id} [secure-client-file]',
  );
}

if (import.meta.main) {
  await main();
}
