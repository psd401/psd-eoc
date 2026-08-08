import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const gcpRoot = fileURLToPath(new URL('..', import.meta.url));

const googleCredentialOverrides = new Set([
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GCLOUD_KEYFILE_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_BACKEND_ACCESS_TOKEN',
  'GOOGLE_BACKEND_CREDENTIALS',
  'GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT',
  'GOOGLE_CLOUD_KEYFILE_JSON',
  'GOOGLE_CREDENTIALS',
  'GOOGLE_IMPERSONATE_SERVICE_ACCOUNT',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_UNIVERSE_DOMAIN',
]);

function isGoogleEndpointOverride(name: string): boolean {
  return (
    name.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') ||
    (name.startsWith('GOOGLE_') && name.endsWith('_CUSTOM_ENDPOINT'))
  );
}

function isParentOnlyValue(name: string): boolean {
  return (
    name === 'PSD_EOC_APPROVED_TEST_GROUP' ||
    name.startsWith('PSD_EOC_CONFIRM_')
  );
}

interface RunOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly redactFailureOutput?: boolean;
}

export function sanitizedTerraformEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (
      name === 'TF_WORKSPACE' ||
      name === 'TF_CLI_CONFIG_FILE' ||
      name === 'TF_DATA_DIR' ||
      name === 'TF_LOG' ||
      name === 'TF_LOG_PATH' ||
      name === 'TF_REATTACH_PROVIDERS' ||
      name === 'CLOUDSDK_CONFIG' ||
      name === 'CLOUDSDK_CORE_ACCOUNT' ||
      name === 'CLOUDSDK_CORE_PROJECT' ||
      name.startsWith('TF_CLI_ARGS') ||
      name.startsWith('TF_VAR_') ||
      googleCredentialOverrides.has(name) ||
      isGoogleEndpointOverride(name) ||
      name.startsWith('CLOUDSDK_') ||
      isParentOnlyValue(name)
    ) {
      delete environment[name];
    }
  }
  environment.CLOUDSDK_CORE_DISABLE_FILE_LOGGING = '1';
  return environment;
}

export function sanitizedGcloudEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const name of Object.keys(environment)) {
    if (
      googleCredentialOverrides.has(name) ||
      isGoogleEndpointOverride(name) ||
      name.startsWith('CLOUDSDK_') ||
      isParentOnlyValue(name)
    ) {
      delete environment[name];
    }
  }
  environment.CLOUDSDK_CORE_DISABLE_FILE_LOGGING = '1';
  return environment;
}

export function sanitizedAwsEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  const exactOverrides = new Set([
    'AWS_ACCESS_KEY_ID',
    'AWS_CA_BUNDLE',
    'AWS_CLI_HISTORY_FILE',
    'AWS_CONFIG_FILE',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_DEFAULT_PROFILE',
    'AWS_DEFAULT_REGION',
    'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_ROLE_ARN',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_SESSION_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
  ]);
  for (const name of Object.keys(environment)) {
    if (
      exactOverrides.has(name) ||
      name.startsWith('AWS_ENDPOINT_URL') ||
      isParentOnlyValue(name)
    ) {
      delete environment[name];
    }
  }
  return environment;
}

function commandEnvironment(command: string): NodeJS.ProcessEnv {
  if (command === 'terraform') {
    return sanitizedTerraformEnvironment();
  }
  if (command === 'gcloud') {
    return sanitizedGcloudEnvironment();
  }
  if (command === 'aws') {
    return sanitizedAwsEnvironment();
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CLOUDSDK_CORE_DISABLE_FILE_LOGGING: '1',
  };
  return environment;
}

export function awsServiceEndpoint(
  service: 'secretsmanager' | 'sts',
  region: string,
): string {
  if (!/^[a-z]{2}-[a-z]+-\d+$/u.test(region)) {
    throw new Error('AWS region is invalid.');
  }
  return `https://${service}.${region}.amazonaws.com`;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? gcpRoot,
    encoding: 'utf8',
    env: commandEnvironment(command),
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = options.redactFailureOutput
      ? ''
      : `: ${(result.stderr || result.stdout).trim().slice(0, 2_000)}`;
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }

  return result.stdout.trim();
}

export function runInteractive(
  command: string,
  args: readonly string[],
  cwd = gcpRoot,
): void {
  const result = spawnSync(command, args, {
    cwd,
    env: commandEnvironment(command),
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

export async function requireExactConfirmation(
  preview: string,
  expected: string,
): Promise<void> {
  console.log(preview);
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let answer: string;
  try {
    answer = await terminal.question(`Type ${expected} to continue: `);
  } finally {
    terminal.close();
  }
  if (answer !== expected) {
    throw new Error('Confirmation did not match; no apply was started.');
  }
}

export function assertActiveGcloudAccount(expectedEmail: string): void {
  let configuration: unknown;
  try {
    configuration = JSON.parse(
      runCommand('gcloud', ['config', 'list', '--format=json']),
    );
  } catch {
    throw new Error('The active gcloud configuration is invalid.');
  }
  validateGcloudConfiguration(configuration, expectedEmail);
}

export function validateGcloudConfiguration(
  value: unknown,
  expectedEmail: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The active gcloud configuration is invalid.');
  }
  const configuration = value as Readonly<Record<string, unknown>>;
  const core = configuration.core;
  if (typeof core !== 'object' || core === null || Array.isArray(core)) {
    throw new Error('The active gcloud configuration is invalid.');
  }
  const coreValues = core as Readonly<Record<string, unknown>>;
  const forbiddenSections = [
    configuration.api_endpoint_overrides,
    configuration.auth,
    configuration.context_aware,
    configuration.proxy,
    configuration.storage,
  ];
  if (
    coreValues.account !== expectedEmail ||
    coreValues.custom_ca_certs_file !== undefined ||
    coreValues.disable_ssl_validation !== undefined ||
    (coreValues.universe_domain !== undefined &&
      coreValues.universe_domain !== 'googleapis.com') ||
    forbiddenSections.some(
      (section) =>
        section !== undefined &&
        section !== null &&
        (typeof section !== 'object' ||
          Array.isArray(section) ||
          Object.keys(section as Readonly<Record<string, unknown>>).length > 0),
    )
  ) {
    throw new Error(
      `gcloud must use ${expectedEmail} without impersonation, token-file, endpoint, proxy, or custom-CA overrides.`,
    );
  }
}

export function validateGoogleUserIdentity(
  value: unknown,
  expectedEmail: string,
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Readonly<Record<string, unknown>>).email !== expectedEmail ||
    (value as Readonly<Record<string, unknown>>).verified_email !== true
  ) {
    throw new Error(
      `Application Default Credentials must identify as the verified ${expectedEmail} user.`,
    );
  }
}

export async function assertApplicationDefaultIdentity(
  expectedEmail: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const accessToken = runCommand(
    'gcloud',
    ['auth', 'application-default', 'print-access-token'],
    { redactFailureOutput: true },
  );
  let response: Response;
  try {
    response = await fetcher('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      'Application Default Credential identity verification could not reach Google.',
    );
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Keep credential and response details out of the error path.
    }
    throw new Error(
      `Application Default Credential identity verification failed with HTTP ${response.status}.`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      'Application Default Credential identity verification returned invalid JSON.',
    );
  }
  validateGoogleUserIdentity(value, expectedEmail);
}

export function validateAwsSsoIdentity(
  value: unknown,
  expectedAccountId: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AWS caller identity is invalid.');
  }
  const identity = value as Readonly<Record<string, unknown>>;
  if (
    identity.Account !== expectedAccountId ||
    typeof identity.Arn !== 'string' ||
    !new RegExp(
      `^arn:aws:sts::${expectedAccountId}:assumed-role/AWSReservedSSO_AWSAdministratorAccess_[a-f0-9]{16}/kjh_admin$`,
      'u',
    ).test(identity.Arn)
  ) {
    throw new Error(
      `AWS must use the kjh_admin psd401-prr-prod SSO administrator role in account ${expectedAccountId}.`,
    );
  }
}

export function assertAwsAccount(
  profile: string,
  expectedAccountId: string,
  region: string,
): void {
  assertAwsCliHistoryDisabled(profile);
  let identity: unknown;
  try {
    identity = JSON.parse(
      runCommand('aws', [
        'sts',
        'get-caller-identity',
        '--profile',
        profile,
        '--region',
        region,
        '--endpoint-url',
        awsServiceEndpoint('sts', region),
        '--output',
        'json',
      ]),
    );
  } catch {
    throw new Error(`AWS profile ${profile} returned an invalid identity.`);
  }
  validateAwsSsoIdentity(identity, expectedAccountId);
}

function assertAwsCliHistoryDisabled(profile: string): void {
  const result = spawnSync(
    'aws',
    ['configure', 'get', 'cli_history', '--profile', profile],
    {
      encoding: 'utf8',
      env: commandEnvironment('aws'),
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    throw new Error(`aws could not start: ${result.error.message}`);
  }
  validateAwsCliHistoryResult(result.status, result.stdout, result.stderr);
}

export function validateAwsCliHistoryResult(
  status: number | null,
  stdout: string,
  stderr: string,
): void {
  const value = stdout.trim().toLowerCase();
  const detail = `${stderr}${stdout}`.trim();
  if (
    !(
      (status === 1 && detail.length === 0) ||
      (status === 0 && (value === '' || value === 'disabled'))
    )
  ) {
    throw new Error(
      'AWS CLI history must be disabled before any PSD EOC secret operation.',
    );
  }
}

export async function reconcileIdempotentSecretWrite(options: {
  readonly attemptWrite: () => string;
  readonly clientRequestToken: string;
  readonly versionIsCurrent: () => boolean;
  readonly wait?: () => Promise<void>;
}): Promise<boolean> {
  const wait =
    options.wait ??
    (async () => new Promise((resolve) => setTimeout(resolve, 500)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      options.attemptWrite();
    } catch {
      // Reconcile the idempotency token without exposing provider output.
    }
    try {
      if (options.versionIsCurrent()) {
        return true;
      }
    } catch {
      // A failed read is still ambiguous and must never authorize cleanup.
    }
    if (attempt < 2) {
      await wait();
    }
  }
  return false;
}

export function awsSecretExists(options: {
  readonly profile: string;
  readonly region: string;
  readonly secretName: string;
}): boolean {
  const result = spawnSync(
    'aws',
    [
      'secretsmanager',
      'describe-secret',
      '--secret-id',
      options.secretName,
      '--region',
      options.region,
      '--profile',
      options.profile,
      '--endpoint-url',
      awsServiceEndpoint('secretsmanager', options.region),
      '--output',
      'json',
    ],
    {
      encoding: 'utf8',
      env: commandEnvironment('aws'),
      maxBuffer: 1024 * 1024,
    },
  );

  if (result.error !== undefined) {
    throw new Error(`aws could not start: ${result.error.message}`);
  }

  if (result.status === 0) {
    return true;
  }
  if (result.stderr?.includes('ResourceNotFoundException') === true) {
    return false;
  }
  throw new Error(
    `AWS could not inspect ${options.secretName}: ${(result.stderr ?? result.stdout ?? '').trim().slice(0, 2_000)}`,
  );
}

export function putSecretValue(options: {
  readonly clientRequestToken: string;
  readonly profile: string;
  readonly region: string;
  readonly secretName: string;
  readonly secretValue: Readonly<Record<string, unknown>>;
}): string {
  return runCommand(
    'aws',
    [
      'secretsmanager',
      'put-secret-value',
      '--region',
      options.region,
      '--profile',
      options.profile,
      '--endpoint-url',
      awsServiceEndpoint('secretsmanager', options.region),
      '--cli-input-json',
      'file:///dev/stdin',
      '--query',
      'VersionId',
      '--output',
      'text',
    ],
    {
      input: JSON.stringify({
        ClientRequestToken: options.clientRequestToken,
        SecretId: options.secretName,
        SecretString: JSON.stringify(options.secretValue),
      }),
      redactFailureOutput: true,
    },
  );
}

export function secretVersionIsCurrent(options: {
  readonly clientRequestToken: string;
  readonly profile: string;
  readonly region: string;
  readonly secretName: string;
}): boolean {
  const raw = runCommand('aws', [
    'secretsmanager',
    'list-secret-version-ids',
    '--secret-id',
    options.secretName,
    '--include-deprecated',
    '--region',
    options.region,
    '--profile',
    options.profile,
    '--endpoint-url',
    awsServiceEndpoint('secretsmanager', options.region),
    '--output',
    'json',
  ]);
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AWS secret version metadata is invalid.');
  }
  const versions = (value as Readonly<Record<string, unknown>>).Versions;
  if (!Array.isArray(versions)) {
    throw new Error('AWS secret version metadata has no Versions array.');
  }
  return versions.some((version) => {
    if (
      typeof version !== 'object' ||
      version === null ||
      Array.isArray(version)
    ) {
      throw new Error(
        'AWS secret version metadata contains an invalid version.',
      );
    }
    const record = version as Readonly<Record<string, unknown>>;
    return (
      record.VersionId === options.clientRequestToken &&
      Array.isArray(record.VersionStages) &&
      record.VersionStages.includes('AWSCURRENT')
    );
  });
}

export function readSecretValue(options: {
  readonly profile: string;
  readonly region: string;
  readonly secretName: string;
}): Readonly<Record<string, unknown>> {
  const raw = runCommand(
    'aws',
    [
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      options.secretName,
      '--region',
      options.region,
      '--profile',
      options.profile,
      '--endpoint-url',
      awsServiceEndpoint('secretsmanager', options.region),
      '--query',
      'SecretString',
      '--output',
      'text',
    ],
    { redactFailureOutput: true },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${options.secretName} did not contain valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${options.secretName} must contain one JSON object.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function requiredString(
  record: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Required field ${name} is missing or invalid.`);
  }
  return value;
}
