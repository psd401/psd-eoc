import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const gcpRoot = fileURLToPath(new URL('..', import.meta.url));

const trustedHome = '/Users/hagelk';
const trustedUsername = 'hagelk';
const trustedPath = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const commandPaths = {
  aws: '/opt/homebrew/bin/aws',
  gcloud: '/opt/homebrew/bin/gcloud',
  terraform: '/opt/homebrew/bin/terraform',
} as const;
type CloudCommand = keyof typeof commandPaths;

const AWS_ACCOUNT_ID = '338414773271';
const AWS_PROFILE = 'psd401-prr-prod';
const AWS_REGION = 'us-west-2';
const AWS_SSO_SESSION = 'macbookpro';
const AWS_SSO_START_URL = 'https://psd401.awsapps.com/start';

export const APPLICATION_DEFAULT_IDENTITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

export function isPathOutsideDirectory(
  directory: string,
  candidate: string,
): boolean {
  const candidateRelative = relative(resolve(directory), resolve(candidate));
  return (
    candidateRelative === '..' ||
    candidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelative)
  );
}

const gcsEmulatorOverrides = [
  'STORAGE_EMULATOR_HOST',
  'STORAGE_EMULATOR_HOST_GRPC',
] as const;

const ambientTransportOverrides = [
  'ALL_PROXY',
  'all_proxy',
  'AWS_CA_BUNDLE',
  'AWS_CLI_AUTO_PROMPT',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_DATA_PATH',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'AWS_SECURITY_TOKEN',
  'BUN_OPTIONS',
  'BUN_CONFIG_VERBOSE_FETCH',
  'BOTO_CONFIG',
  'BROWSER',
  'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION',
  'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE',
  'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PASSWORD',
  'CLOUDSDK_PROXY_PORT',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_USERNAME',
  'CURL_CA_BUNDLE',
  'ENABLE_ENTERPRISE_CERTIFICATE_LOGS',
  'EXPERIMENTAL_GOOGLE_API_USE_S2A',
  'GODEBUG',
  'GOTRACEBACK',
  'GOOGLE_SDK_GO_LOGGING_LEVEL',
  'GOOGLE_API_CERTIFICATE_CONFIG',
  'GOOGLE_CLOUD_DISABLE_DIRECT_PATH',
  'GOOGLE_CLOUD_ENABLE_DIRECT_PATH_XDS',
  'GOOGLE_API_USE_CLIENT_CERTIFICATE',
  'GOOGLE_API_USE_MTLS',
  'GOOGLE_API_USE_MTLS_ENDPOINT',
  'GRPC_BINARY_LOG_FILTER',
  'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
  'GRPC_GO_LOG_FORMATTER',
  'GRPC_GO_LOG_SEVERITY_LEVEL',
  'GRPC_GO_LOG_VERBOSITY_LEVEL',
  'GRPC_PROXY',
  'grpc_proxy',
  'GRPC_TRACE',
  'GRPC_VERBOSITY',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NODE_EXTRA_CA_CERTS',
  'NODE_DEBUG',
  'NODE_DEBUG_NATIVE',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'PYTHONBREAKPOINT',
  'PYTHONCASEOK',
  'PYTHONDEBUG',
  'PYTHONEXECUTABLE',
  'PYTHONFAULTHANDLER',
  'PYTHONHOME',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'PYTHONPLATLIBDIR',
  'PYTHONPROFILEIMPORTTIME',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PYTHONVERBOSE',
  'PYTHONWARNINGS',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SSLKEYLOGFILE',
  'TF_TEMP_LOG_PATH',
  'VIRTUAL_ENV',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const;

const noProxyOverrides = ['NO_PROXY', 'no_proxy'] as const;

const terraformProviderOverrides = [
  'TERRAFORM_CONFIG',
  'TF_CLI_CONFIG_FILE',
  'TF_PLUGIN_CACHE_DIR',
  'TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE',
  'TF_REATTACH_PROVIDERS',
] as const;

const dangerousBunArguments = [
  '-i',
  '-r',
  '--env-file',
  '--fetch-preconnect',
  '--import',
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
  '--install',
  '--preload',
  '--redis-preconnect',
  '--require',
  '--sql-preconnect',
  '--tls-keylog',
  '--use-env-proxy',
  '--use-openssl-ca',
  '--use-system-ca',
  '--verbose-fetch',
] as const;

export function assertNoAmbientTransportOverrides(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
  execArguments: readonly string[] = process.execArgv,
): void {
  const configured: string[] = ambientTransportOverrides.filter(
    (name) => source[name] !== undefined,
  );
  for (const name of Object.keys(source)) {
    if (
      (name.startsWith('TF_LOG') ||
        name.startsWith('BUN_INSPECT') ||
        name.startsWith('PYTHON') ||
        name.startsWith('AWS_CSM_') ||
        name.startsWith('GOOGLE_API_GO_EXPERIMENTAL_') ||
        name.startsWith('GOOGLE_EXTERNAL_ACCOUNT_') ||
        name.startsWith('GRPC_GCP_OBSERVABILITY_') ||
        name.startsWith('GRPC_XDS_BOOTSTRAP') ||
        name.startsWith('DYLD_') ||
        name === 'LD_AUDIT' ||
        name === 'LD_LIBRARY_PATH' ||
        name === 'LD_PRELOAD') &&
      !configured.includes(name)
    ) {
      configured.push(name);
    }
  }
  const configuredBunArguments = dangerousBunArguments.filter((name) =>
    execArguments.some(
      (argument) =>
        argument === name ||
        argument.startsWith(`${name}=`) ||
        (name === '-r' && argument.startsWith('-r') && argument.length > 2),
    ),
  );
  if (configured.length > 0 || configuredBunArguments.length > 0) {
    const rejected = [...configured, ...configuredBunArguments];
    throw new Error(
      `Guarded cloud operations reject ambient proxy, custom-CA, TLS-keylog, TLS-validation, debugger, and verbose-fetch settings; unset or omit ${rejected.join(', ')}.`,
    );
  }
  validateGuardedBunInvocation(
    execArguments,
    process.argv[1],
    process.cwd(),
    source.PSD_EOC_GUARDED_LAUNCHER,
  );
}

export function validateGuardedBunInvocation(
  execArguments: readonly string[],
  scriptPath: string | undefined,
  cwd: string,
  launcherMarker: string | undefined,
): void {
  if (scriptPath === undefined) {
    return;
  }
  const scriptsRoot = join(gcpRoot, 'scripts');
  const resolvedScript = resolve(cwd, scriptPath);
  let canonicalScript: string | null = null;
  try {
    canonicalScript = realpathSync(resolvedScript);
  } catch {
    // A lexical path inside scripts still fails closed below even if missing.
  }
  const resolvedInsideScripts =
    resolvedScript !== scriptsRoot &&
    !isPathOutsideDirectory(scriptsRoot, resolvedScript);
  const canonicalInsideScripts =
    canonicalScript !== null &&
    canonicalScript !== scriptsRoot &&
    !isPathOutsideDirectory(scriptsRoot, canonicalScript);
  if (!resolvedInsideScripts && !canonicalInsideScripts) {
    return;
  }
  if (
    canonicalScript !== null &&
    resolvedInsideScripts &&
    !canonicalInsideScripts
  ) {
    throw new Error(
      'Guarded cloud helpers must start through ./scripts/run-guarded.sh.',
    );
  }
  const guardedScript =
    canonicalInsideScripts && canonicalScript !== null
      ? canonicalScript
      : resolvedScript;
  const scriptRelative = relative(scriptsRoot, guardedScript);

  const expectedConfig = join(gcpRoot, 'bunfig.toml');
  const expectedArguments = [
    `--config=${expectedConfig}`,
    '--no-env-file',
    '--no-install',
  ];
  const guardedEntrypoints = new Set([
    'apply.ts',
    'configure-workspace-role.ts',
    'operator-access.ts',
    'provision-groups-credential.ts',
    'revoke-groups-credential.ts',
    'store-oauth-client.ts',
    'verify-groups-readonly.ts',
  ]);
  if (
    launcherMarker !== '1' ||
    resolve(cwd) !== resolve(gcpRoot) ||
    !guardedEntrypoints.has(scriptRelative) ||
    execArguments.length !== expectedArguments.length ||
    execArguments.some(
      (argument, index) => argument !== expectedArguments[index],
    )
  ) {
    throw new Error(
      'Guarded cloud scripts must be started by infra/gcp/scripts/run-guarded.sh.',
    );
  }
}

export function assertTrustedHome(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): void {
  if (
    (source.HOME !== undefined && source.HOME !== trustedHome) ||
    (source.USER !== undefined && source.USER !== trustedUsername) ||
    (source.LOGNAME !== undefined && source.LOGNAME !== trustedUsername)
  ) {
    throw new Error(
      `Guarded cloud operations require the fixed ${trustedUsername} account and home directory ${trustedHome}; unset HOME, USER, and LOGNAME overrides.`,
    );
  }
}

function assertTrustedExecutable(command: CloudCommand): string {
  const path = commandPaths[command];
  try {
    const resolved = realpathSync(path);
    const metadata = statSync(resolved);
    if (
      !resolved.startsWith('/opt/homebrew/') ||
      !metadata.isFile() ||
      (metadata.mode & 0o111) === 0
    ) {
      throw new Error('invalid executable');
    }
  } catch {
    throw new Error(
      `Guarded cloud operations require the reviewed ${command} installation at ${path}.`,
    );
  }
  return path;
}

function baseChildEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: trustedHome,
    LANG: 'C',
    LC_ALL: 'C',
    LOGNAME: trustedUsername,
    PATH: trustedPath,
    TERM: 'dumb',
    TMPDIR: '/private/tmp',
    USER: trustedUsername,
  };
}

type ParsedIni = ReadonlyMap<string, ReadonlyMap<string, string>>;

function parseCliIni(contents: string, label: string): ParsedIni {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sectionMatch = /^\[([^\]\r\n]+)\]$/u.exec(line);
    if (sectionMatch !== null && sectionMatch[1] !== undefined) {
      const sectionName = sectionMatch[1].trim();
      if (sectionName.length === 0 || sections.has(sectionName)) {
        throw new Error(`${label} is invalid.`);
      }
      current = new Map();
      sections.set(sectionName, current);
      continue;
    }
    const propertyMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (
      current === undefined ||
      propertyMatch === null ||
      propertyMatch[1] === undefined ||
      propertyMatch[2] === undefined ||
      current.has(propertyMatch[1])
    ) {
      throw new Error(`${label} is invalid.`);
    }
    current.set(propertyMatch[1], propertyMatch[2].trim());
  }
  return sections;
}

function requireExactIniSection(
  section: ReadonlyMap<string, string> | undefined,
  expected: Readonly<Record<string, string>>,
  label: string,
): void {
  if (
    section === undefined ||
    section.size !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => section.get(key) !== value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

export function validateAwsSsoConfigurationFiles(
  configContents: string,
  credentialsContents: string,
): void {
  const config = parseCliIni(configContents, 'AWS configuration');
  if (
    config.size !== 2 ||
    [...config.keys()].some(
      (section) =>
        section === 'DEFAULT' || section.trim().toLowerCase() === 'plugins',
    )
  ) {
    throw new Error(
      'AWS configuration must not load CLI plugins or inherited defaults.',
    );
  }
  requireExactIniSection(
    config.get(`profile ${AWS_PROFILE}`),
    {
      region: AWS_REGION,
      sso_account_id: AWS_ACCOUNT_ID,
      sso_role_name: 'AWSAdministratorAccess',
      sso_session: AWS_SSO_SESSION,
    },
    `AWS profile ${AWS_PROFILE}`,
  );
  requireExactIniSection(
    config.get(`sso-session ${AWS_SSO_SESSION}`),
    {
      sso_region: AWS_REGION,
      sso_registration_scopes: 'sso:account:access',
      sso_start_url: AWS_SSO_START_URL,
    },
    `AWS SSO session ${AWS_SSO_SESSION}`,
  );

  const credentials = parseCliIni(
    credentialsContents,
    'AWS shared credentials configuration',
  );
  if (
    credentials.has(AWS_PROFILE) ||
    credentials.has(`profile ${AWS_PROFILE}`)
  ) {
    throw new Error(
      `AWS profile ${AWS_PROFILE} must not have a static shared-credentials entry.`,
    );
  }
}

export function validateGcloudLocalConfiguration(contents: string): void {
  const configuration = parseCliIni(contents, 'gcloud configuration');
  if (
    configuration.size !== 1 ||
    !configuration.has('core') ||
    [...(configuration.get('core')?.keys() ?? [])].some(
      (key) => key !== 'account' && key !== 'project',
    )
  ) {
    throw new Error(
      'gcloud local configuration may contain only the core account and project.',
    );
  }
  const core = configuration.get('core');
  const account = core?.get('account');
  const project = core?.get('project');
  if (
    (account !== undefined && !/^[a-z0-9._%+-]+@[a-z0-9.-]+$/u.test(account)) ||
    (project !== undefined && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project))
  ) {
    throw new Error('gcloud local core account or project is invalid.');
  }
}

function readLocalConfigurationFile(
  path: string,
  label: string,
  maximumSize: number,
  required: boolean,
  requirePrivateMode = false,
): string {
  if (!existsSync(path)) {
    if (required) {
      throw new Error(`${label} is missing.`);
    }
    return '';
  }
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.size > maximumSize ||
      (requirePrivateMode && (metadata.mode & 0o077) !== 0)
    ) {
      throw new Error('invalid metadata');
    }
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${label} could not be read safely.`);
  }
}

function assertAwsLocalConfiguration(): void {
  assertTrustedHome();
  const awsDirectory = join(trustedHome, '.aws');
  const aliasPath = join(awsDirectory, 'cli', 'alias');
  const modelsPath = join(awsDirectory, 'models');
  if (
    readLocalConfigurationFile(
      aliasPath,
      'AWS CLI alias file',
      64 * 1024,
      false,
    ).trim().length > 0
  ) {
    throw new Error('AWS CLI aliases must be absent or empty.');
  }
  if (existsSync(modelsPath)) {
    throw new Error('AWS CLI model overrides must be absent.');
  }
  validateAwsSsoConfigurationFiles(
    readLocalConfigurationFile(
      join(gcpRoot, 'aws.config'),
      'Reviewed AWS configuration',
      256 * 1024,
      true,
    ),
    '',
  );
}

function assertGcloudLocalConfiguration(): void {
  assertTrustedHome();
  const configurationRoot = join(trustedHome, '.config', 'gcloud');
  const activeConfiguration = readLocalConfigurationFile(
    join(configurationRoot, 'active_config'),
    'Active gcloud configuration selector',
    128,
    true,
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(activeConfiguration)) {
    throw new Error('Active gcloud configuration selector is invalid.');
  }
  validateGcloudLocalConfiguration(
    readLocalConfigurationFile(
      join(
        configurationRoot,
        'configurations',
        `config_${activeConfiguration}`,
      ),
      'Active gcloud configuration',
      64 * 1024,
      true,
    ),
  );
}

function forceDirectTransport(environment: NodeJS.ProcessEnv): void {
  for (const name of [...ambientTransportOverrides, ...noProxyOverrides]) {
    delete environment[name];
  }
  // Prevent Python, Go, and AWS SDK clients from falling back to an operating-
  // system proxy after the ambient environment has been proved clean.
  environment.NO_PROXY = '*';
  environment.no_proxy = '*';
  environment.PYTHONNOUSERSITE = '1';
}

function assertNoTerraformProviderOverrides(
  source: Readonly<NodeJS.ProcessEnv>,
): void {
  const configured = terraformProviderOverrides.filter(
    (name) => source[name] !== undefined,
  );
  if (configured.length > 0) {
    throw new Error(
      `Guarded Terraform operations reject ambient CLI configuration and provider-plugin overrides; unset ${configured.join(', ')}.`,
    );
  }
}

function assertNoGcsEmulatorOverrides(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): void {
  if (gcsEmulatorOverrides.some((name) => source[name] !== undefined)) {
    throw new Error(
      'Guarded Google Cloud runs require real Google Cloud Storage endpoints; unset STORAGE_EMULATOR_HOST and STORAGE_EMULATOR_HOST_GRPC.',
    );
  }
}

interface RunOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly redactFailureOutput?: boolean;
}

interface CloudCommandResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export function sanitizedTerraformEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  assertNoGcsEmulatorOverrides(source);
  assertNoAmbientTransportOverrides(source);
  assertNoTerraformProviderOverrides(source);
  const environment = baseChildEnvironment();
  environment.CLOUDSDK_CORE_DISABLE_FILE_LOGGING = '1';
  environment.CLOUDSDK_CORE_LOG_HTTP = '0';
  environment.TF_CLI_CONFIG_FILE = join(gcpRoot, 'terraform.tfrc');
  forceDirectTransport(environment);
  return environment;
}

export function sanitizedGcloudEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  assertNoGcsEmulatorOverrides(source);
  assertNoAmbientTransportOverrides(source);
  const environment = baseChildEnvironment();
  environment.CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK = '1';
  environment.CLOUDSDK_CORE_CHECK_GCE_METADATA = '0';
  environment.CLOUDSDK_CORE_DISABLE_FILE_LOGGING = '1';
  environment.CLOUDSDK_CORE_DISABLE_USAGE_REPORTING = '1';
  environment.CLOUDSDK_CORE_LOG_HTTP = '0';
  environment.CLOUDSDK_CORE_LOG_HTTP_REDACT_TOKEN = '1';
  environment.CLOUDSDK_CORE_VERBOSITY = 'warning';
  environment.CLOUDSDK_PYTHON = '/opt/homebrew/bin/python3';
  environment.CLOUDSDK_PYTHON_ARGS = '-I -S';
  environment.CLOUDSDK_SURVEY_DISABLE_PROMPTS = '1';
  forceDirectTransport(environment);
  return environment;
}

export function sanitizedAwsEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  assertNoAmbientTransportOverrides(source);
  const environment = baseChildEnvironment();
  forceDirectTransport(environment);
  environment.AWS_CLI_AUTO_PROMPT = 'off';
  environment.AWS_CONFIG_FILE = join(gcpRoot, 'aws.config');
  environment.AWS_EC2_METADATA_DISABLED = 'true';
  environment.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
  environment.AWS_PAGER = '';
  environment.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
  environment.PAGER = '';
  return environment;
}

function commandEnvironment(command: CloudCommand): NodeJS.ProcessEnv {
  if (command === 'terraform') {
    return sanitizedTerraformEnvironment();
  }
  if (command === 'gcloud') {
    return sanitizedGcloudEnvironment();
  }
  if (command === 'aws') {
    return sanitizedAwsEnvironment();
  }
  throw new Error(`Unsupported guarded cloud command: ${command}.`);
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

export type GoogleFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const MAX_GOOGLE_RESPONSE_BYTES = 512 * 1024;

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the sanitized provider error without exposing response details.
  }
}

export async function guardedGoogleFetch(
  fetcher: GoogleFetcher,
  input: string | URL,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  assertNoAmbientTransportOverrides();
  try {
    return await fetcher(input, {
      ...init,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`${operation} could not reach Google.`);
  }
}

export async function boundedGoogleJsonObject(
  response: Response,
  operation: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`${operation} failed with HTTP ${response.status}.`);
  }

  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_GOOGLE_RESPONSE_BYTES)
  ) {
    await cancelResponseBody(response);
    throw new Error(`${operation} returned an invalid or oversized response.`);
  }
  if (response.body === null) {
    throw new Error(`${operation} returned an invalid or oversized response.`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        throw new Error('Google returned an invalid response chunk.');
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_GOOGLE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Google returned an oversized response.');
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Preserve the bounded, sanitized response error.
    }
    throw new Error(`${operation} returned an invalid or oversized response.`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed or cancelled stream can retain the reader lock safely.
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${operation} returned an invalid or oversized response.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned an invalid or oversized response.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function prepareCloudCommand(
  command: CloudCommand,
  args: readonly string[],
): { readonly args: readonly string[]; readonly executable: string } {
  assertTrustedHome();
  assertNoAmbientTransportOverrides();
  const executable = assertTrustedExecutable(command);
  if (command === 'gcloud') {
    assertGcloudLocalConfiguration();
  }
  if (command === 'aws') {
    assertAwsLocalConfiguration();
    const profileIndexes = args.flatMap((argument, index) =>
      argument === '--profile' ? [index] : [],
    );
    if (
      profileIndexes.length !== 1 ||
      args[(profileIndexes[0] ?? -1) + 1] !== AWS_PROFILE
    ) {
      throw new Error(
        `Guarded AWS commands require the exact ${AWS_PROFILE} profile.`,
      );
    }
    return { args: [...args, '--no-cli-pager'], executable };
  }
  return { args, executable };
}

export function runCommand(
  command: CloudCommand,
  args: readonly string[],
  options: RunOptions = {},
): string {
  const result = runCommandForStatus(command, args, options);

  if (result.status !== 0) {
    const detail = options.redactFailureOutput
      ? ''
      : `: ${(result.stderr || result.stdout).trim().slice(0, 2_000)}`;
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }

  return result.stdout.trim();
}

export function runCommandForStatus(
  command: CloudCommand,
  args: readonly string[],
  options: RunOptions = {},
): CloudCommandResult {
  const prepared = prepareCloudCommand(command, args);
  const result = spawnSync(prepared.executable, prepared.args, {
    cwd: options.cwd ?? gcpRoot,
    encoding: 'utf8',
    env: commandEnvironment(command),
    input: options.input,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

export function validateTerraformWorkspace(workspace: string): void {
  if (workspace !== 'default') {
    throw new Error(
      `Terraform workspace must be default; refusing to use ${JSON.stringify(workspace)}.`,
    );
  }
}

export function assertDefaultTerraformWorkspace(cwd = gcpRoot): void {
  validateTerraformWorkspace(
    runCommand('terraform', ['workspace', 'show'], { cwd }),
  );
}

export function runInteractive(
  command: CloudCommand,
  args: readonly string[],
  cwd = gcpRoot,
): void {
  const prepared = prepareCloudCommand(command, args);
  const result = spawnSync(prepared.executable, prepared.args, {
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

export function assertSafeGcloudConfiguration(): void {
  let configuration: unknown;
  try {
    configuration = JSON.parse(
      runCommand('gcloud', ['config', 'list', '--format=json']),
    );
  } catch {
    throw new Error('The active gcloud configuration is invalid.');
  }
  validateGcloudTransportConfiguration(configuration);
}

export function validateGcloudTransportConfiguration(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The active gcloud configuration is invalid.');
  }
  const configuration = value as Readonly<Record<string, unknown>>;
  const core = configuration.core;
  if (typeof core !== 'object' || core === null || Array.isArray(core)) {
    throw new Error('The active gcloud configuration is invalid.');
  }
  const coreValues = core as Readonly<Record<string, unknown>>;
  const allowedCoreKeys = new Set([
    'account',
    'check_gce_metadata',
    'disable_file_logging',
    'disable_usage_reporting',
    'log_http',
    'log_http_redact_token',
    'project',
    'universe_domain',
    'verbosity',
  ]);
  const componentManager = configuration.component_manager;
  const survey = configuration.survey;
  if (
    Object.keys(configuration).some(
      (key) =>
        key !== 'component_manager' && key !== 'core' && key !== 'survey',
    ) ||
    Object.keys(coreValues).some((key) => !allowedCoreKeys.has(key)) ||
    (coreValues.check_gce_metadata !== undefined &&
      coreValues.check_gce_metadata !== '0') ||
    (coreValues.disable_file_logging !== undefined &&
      coreValues.disable_file_logging !== '1') ||
    (coreValues.disable_usage_reporting !== undefined &&
      coreValues.disable_usage_reporting !== '1') ||
    (coreValues.log_http !== undefined && coreValues.log_http !== '0') ||
    (coreValues.log_http_redact_token !== undefined &&
      coreValues.log_http_redact_token !== '1') ||
    (coreValues.verbosity !== undefined &&
      coreValues.verbosity !== 'warning') ||
    (coreValues.universe_domain !== undefined &&
      coreValues.universe_domain !== 'googleapis.com') ||
    (componentManager !== undefined &&
      (typeof componentManager !== 'object' ||
        componentManager === null ||
        Array.isArray(componentManager) ||
        Object.keys(componentManager).length !== 1 ||
        (componentManager as Readonly<Record<string, unknown>>)
          .disable_update_check !== '1')) ||
    (survey !== undefined &&
      (typeof survey !== 'object' ||
        survey === null ||
        Array.isArray(survey) ||
        Object.keys(survey).length !== 1 ||
        (survey as Readonly<Record<string, unknown>>).disable_prompts !== '1'))
  ) {
    throw new Error(
      'gcloud must run without impersonation, billing/quota, token-file, endpoint, proxy, or custom-CA overrides.',
    );
  }
}

export function validateGcloudConfiguration(
  value: unknown,
  expectedEmail: string,
): void {
  validateGcloudTransportConfiguration(value);
  const configuration = value as Readonly<Record<string, unknown>>;
  const coreValues = configuration.core as Readonly<Record<string, unknown>>;
  if (coreValues.account !== expectedEmail) {
    throw new Error(
      `gcloud must use ${expectedEmail} without impersonation, billing/quota, token-file, endpoint, proxy, or custom-CA overrides.`,
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

export function validateApplicationDefaultCredentialMetadata(
  value: unknown,
  expectedQuotaProject: string,
  expectedEmail: string,
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(expectedQuotaProject) ||
    !/^[a-z0-9._%+-]+@psd401\.net$/u.test(expectedEmail)
  ) {
    throw new Error('Application Default Credential metadata is invalid.');
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  const allowedFields = new Set([
    'account',
    'client_id',
    'client_secret',
    'quota_project_id',
    'refresh_token',
    'type',
    'universe_domain',
  ]);
  const quotaProject = metadata.quota_project_id;
  if (
    Object.keys(metadata).some((field) => !allowedFields.has(field)) ||
    metadata.type !== 'authorized_user' ||
    metadata.account !== expectedEmail ||
    typeof metadata.client_id !== 'string' ||
    !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(
      metadata.client_id,
    ) ||
    typeof metadata.client_secret !== 'string' ||
    metadata.client_secret.length === 0 ||
    typeof metadata.refresh_token !== 'string' ||
    metadata.refresh_token.length === 0 ||
    (metadata.universe_domain !== undefined &&
      metadata.universe_domain !== 'googleapis.com') ||
    (quotaProject !== undefined && quotaProject !== expectedQuotaProject)
  ) {
    throw new Error(
      `Application Default Credentials must be the fixed ${expectedEmail} Google authorized-user contract, omit alternate endpoint fields, and omit the quota project during bootstrap or bind it to ${expectedQuotaProject}; revoke and re-login with --disable-quota-project.`,
    );
  }
}

function assertApplicationDefaultCredentialMetadata(
  expectedQuotaProject: string,
  expectedEmail: string,
): void {
  const configDirectory = runCommand(
    'gcloud',
    ['info', '--format=value(config.paths.global_config_dir)'],
    { redactFailureOutput: true },
  );
  const expectedConfigDirectory = join(trustedHome, '.config', 'gcloud');
  if (configDirectory !== expectedConfigDirectory) {
    throw new Error(
      'Application Default Credential configuration location is invalid.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(
      readLocalConfigurationFile(
        join(configDirectory, 'application_default_credentials.json'),
        'Application Default Credential metadata',
        64 * 1024,
        true,
        true,
      ),
    );
  } catch {
    throw new Error(
      'Application Default Credential metadata could not be read safely.',
    );
  }
  validateApplicationDefaultCredentialMetadata(
    value,
    expectedQuotaProject,
    expectedEmail,
  );
}

export async function assertApplicationDefaultIdentity(
  expectedEmail: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  assertNoAmbientTransportOverrides();
  assertApplicationDefaultCredentialMetadata('psd401-eoc', expectedEmail);
  const accessToken = runCommand(
    'gcloud',
    [
      'auth',
      'application-default',
      'print-access-token',
      `--scopes=${APPLICATION_DEFAULT_IDENTITY_SCOPES.join(',')}`,
    ],
    { redactFailureOutput: true },
  );
  const response = await guardedGoogleFetch(
    fetcher,
    'https://www.googleapis.com/oauth2/v2/userinfo',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    'Application Default Credential identity verification',
  );
  const value = await boundedGoogleJsonObject(
    response,
    'Application Default Credential identity verification',
  );
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

export function validateAwsSsoProfile(
  accountId: string,
  roleName: string,
  region: string,
  sessionName: string,
  expectedAccountId: string,
  expectedRegion: string,
): void {
  if (
    accountId !== expectedAccountId ||
    roleName !== 'AWSAdministratorAccess' ||
    region !== expectedRegion ||
    sessionName !== AWS_SSO_SESSION
  ) {
    throw new Error(
      `AWS SSO profile must select AWSAdministratorAccess in account ${expectedAccountId}, Region ${expectedRegion}, through one named SSO session.`,
    );
  }
}

export function assertAwsSsoLoginConfiguration(
  profile: string,
  expectedAccountId: string,
  expectedRegion: string,
): void {
  if (
    profile !== AWS_PROFILE ||
    expectedAccountId !== AWS_ACCOUNT_ID ||
    expectedRegion !== AWS_REGION
  ) {
    throw new Error('AWS SSO login target is invalid.');
  }
  assertAwsLocalConfiguration();
}

export function assertAwsAccount(
  profile: string,
  expectedAccountId: string,
  region: string,
): void {
  if (
    profile !== AWS_PROFILE ||
    expectedAccountId !== AWS_ACCOUNT_ID ||
    region !== AWS_REGION
  ) {
    throw new Error('AWS account verification target is invalid.');
  }
  assertAwsLocalConfiguration();
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

export async function reconcileIdempotentSecretWrite(options: {
  readonly attemptWrite: () => string;
  readonly clientRequestToken: string;
  readonly versionIsCurrent: () => boolean;
  readonly wait?: (delayMs: number) => Promise<void>;
}): Promise<boolean> {
  const wait =
    options.wait ??
    (async (delayMs: number) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)));
  const retryDelays = [500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      if (options.attemptWrite() !== options.clientRequestToken) {
        throw new Error('AWS returned an unexpected secret version.');
      }
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
    const retryDelay = retryDelays[attempt];
    if (retryDelay !== undefined) {
      await wait(retryDelay);
    }
  }
  return false;
}

export function awsSecretExists(options: {
  readonly expectedAccountId: string;
  readonly profile: string;
  readonly region: string;
  readonly secretName: string;
}): boolean {
  const prepared = prepareCloudCommand('aws', [
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
  ]);
  const result = spawnSync(prepared.executable, prepared.args, {
    cwd: gcpRoot,
    encoding: 'utf8',
    env: commandEnvironment('aws'),
    maxBuffer: 1024 * 1024,
  });

  if (result.error !== undefined) {
    throw new Error(`aws could not start: ${result.error.message}`);
  }

  if (result.status === 0) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `AWS returned invalid metadata for ${options.secretName}.`,
      );
    }
    validateAwsSecretMetadata(metadata, options);
    let policy: unknown;
    try {
      policy = JSON.parse(
        runCommand(
          'aws',
          [
            'secretsmanager',
            'get-resource-policy',
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
          { redactFailureOutput: true },
        ),
      );
    } catch {
      throw new Error(
        `AWS could not verify the resource policy for ${options.secretName}.`,
      );
    }
    validateAwsSecretResourcePolicy(policy, options);
    return true;
  }
  if (result.stderr?.includes('ResourceNotFoundException') === true) {
    return false;
  }
  throw new Error(
    `AWS could not inspect ${options.secretName}: ${(result.stderr ?? result.stdout ?? '').trim().slice(0, 2_000)}`,
  );
}

interface AwsSecretContract {
  readonly expectedAccountId: string;
  readonly region: string;
  readonly secretName: string;
}

function secretArnMatches(
  value: unknown,
  contract: AwsSecretContract,
): boolean {
  const escapedName = contract.secretName.replace(
    /[.*+?^${}()|[\]\\]/gu,
    '\\$&',
  );
  return (
    typeof value === 'string' &&
    new RegExp(
      `^arn:aws:secretsmanager:${contract.region}:${contract.expectedAccountId}:secret:${escapedName}-[A-Za-z0-9]{6}$`,
      'u',
    ).test(value)
  );
}

function validateSecretTags(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('AWS secret ownership tags are invalid.');
  }
  const tags = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('AWS secret ownership tags are invalid.');
    }
    const tag = item as Readonly<Record<string, unknown>>;
    if (
      typeof tag.Key !== 'string' ||
      typeof tag.Value !== 'string' ||
      tags.has(tag.Key)
    ) {
      throw new Error('AWS secret ownership tags are invalid.');
    }
    tags.set(tag.Key, tag.Value);
  }
  if (
    tags.get('Application') !== 'PSD EOC' ||
    !['infra/gcp', 'AWS CDK'].includes(tags.get('ManagedBy') ?? '') ||
    (tags.has('DataScope') && tags.get('DataScope') !== 'staff-minimized')
  ) {
    throw new Error('AWS secret ownership tags are invalid.');
  }
}

export function validateAwsSecretMetadata(
  value: unknown,
  contract: AwsSecretContract,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AWS secret metadata is invalid.');
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  const replicationStatus = metadata.ReplicationStatus;
  const externalRotationMetadata = metadata.ExternalSecretRotationMetadata;
  if (
    metadata.Name !== contract.secretName ||
    !secretArnMatches(metadata.ARN, contract) ||
    metadata.DeletedDate !== undefined ||
    metadata.KmsKeyId !== undefined ||
    metadata.OwningService !== undefined ||
    metadata.PrimaryRegion !== undefined ||
    (replicationStatus !== undefined &&
      (!Array.isArray(replicationStatus) || replicationStatus.length > 0)) ||
    (metadata.RotationEnabled !== undefined &&
      metadata.RotationEnabled !== false) ||
    metadata.RotationLambdaARN !== undefined ||
    metadata.NextRotationDate !== undefined ||
    metadata.ExternalSecretRotationRoleArn !== undefined ||
    metadata.Type !== undefined ||
    (externalRotationMetadata !== undefined &&
      (!Array.isArray(externalRotationMetadata) ||
        externalRotationMetadata.length > 0))
  ) {
    throw new Error(
      'AWS secret must be local, AWS-managed encrypted, unrotated, and retained in the fixed account and region.',
    );
  }
  validateSecretTags(metadata.Tags);
}

export function validateAwsSecretResourcePolicy(
  value: unknown,
  contract: AwsSecretContract,
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Readonly<Record<string, unknown>>).Name !== contract.secretName ||
    !secretArnMatches(
      (value as Readonly<Record<string, unknown>>).ARN,
      contract,
    ) ||
    ((value as Readonly<Record<string, unknown>>).ResourcePolicy !==
      undefined &&
      (value as Readonly<Record<string, unknown>>).ResourcePolicy !== null)
  ) {
    throw new Error(
      'AWS secret must have no resource-based policy or cross-account access.',
    );
  }
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
  const raw = runCommand(
    'aws',
    [
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      options.secretName,
      '--version-id',
      options.clientRequestToken,
      '--version-stage',
      'AWSCURRENT',
      '--region',
      options.region,
      '--profile',
      options.profile,
      '--endpoint-url',
      awsServiceEndpoint('secretsmanager', options.region),
      '--query',
      '{VersionId:VersionId,VersionStages:VersionStages}',
      '--output',
      'json',
    ],
    { redactFailureOutput: true },
  );
  return parseCurrentSecretVersionMetadata(raw, options.clientRequestToken);
}

export function parseCurrentSecretVersionMetadata(
  raw: string,
  expectedVersionId: string,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('AWS current secret version metadata is invalid.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('AWS current secret version metadata is invalid.');
  }
  const metadata = value as Readonly<Record<string, unknown>>;
  const versionStages = metadata.VersionStages;
  if (
    Object.keys(metadata).sort().join(',') !== 'VersionId,VersionStages' ||
    typeof metadata.VersionId !== 'string' ||
    !Array.isArray(versionStages) ||
    versionStages.length === 0 ||
    versionStages.some((stage) => typeof stage !== 'string') ||
    new Set(versionStages).size !== versionStages.length
  ) {
    throw new Error('AWS current secret version metadata is invalid.');
  }
  return (
    metadata.VersionId === expectedVersionId &&
    versionStages.includes('AWSCURRENT')
  );
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
