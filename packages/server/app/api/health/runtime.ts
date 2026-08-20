import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  EventTypeVersionIdSchema,
  FacilityIdSchema,
  type ActivationPreview,
  type AgentGrantableCapabilityId,
  type EventLifecycleMutationResult,
  type LifecycleConsequencePreview,
} from '@psd-eoc/contracts';
import { S3Client } from '@aws-sdk/client-s3';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
  type DatabaseConnection,
  type PostgresDatabaseConfig,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  AgentGatewayError,
  type AuthorizedAgentGatewayCall,
  type PreparedAgentGatewayRequest,
} from '../../../lib/agents/gateway';
import { AgentApiKeyError } from '../../../lib/agents/keys';
import {
  createAgentRestRuntime,
  type AgentRestRuntime,
} from '../../../lib/agents/runtime';
import { readGoogleOidcConfiguration } from '../../../lib/auth/oidc';
import {
  getDefaultSessionService,
  SessionAccessError,
} from '../../../lib/auth/sessions';
import { getDefaultAdminDatabase } from '../../(admin)/facilities/admin-core';

const DEFAULT_HEALTH_TIMEOUT_MILLISECONDS = 4_000;
const MAX_HEALTH_TIMEOUT_MILLISECONDS = 5_000;
const MAX_AWS_RESPONSE_BYTES = 64 * 1_024;
const AWS_REQUEST_TERMINATOR = 'aws4_request';
const SQS_JSON_CONTENT_TYPE = 'application/x-amz-json-1.0';
const SECRETS_JSON_CONTENT_TYPE = 'application/x-amz-json-1.1';
const SQS_GET_ATTRIBUTES_TARGET = 'AmazonSQS.GetQueueAttributes';
const SECRETS_DESCRIBE_TARGET = 'secretsmanager.DescribeSecret';
const CANARY_TOTAL_DEADLINE_MILLISECONDS = 12_000;
export const CANARY_TRANSACTION_CONFIGURATION_SQL =
  "select set_config('statement_timeout', '1500ms', true), set_config('lock_timeout', '1000ms', true), set_config('idle_in_transaction_session_timeout', '5000ms', true)";
const CANARY_CAPABILITY_IDS = Object.freeze([
  'create-activation-preview',
  'start-event',
  'create-lifecycle-consequence-preview',
  'all-clear-event',
  'close-event',
] as const satisfies readonly AgentGrantableCapabilityId[]);

const CanaryConfigurationSchema = z
  .object({
    facilityId: FacilityIdSchema,
    eventTypeVersionId: EventTypeVersionIdSchema,
  })
  .strict()
  .readonly();

type CanaryConfiguration = z.infer<typeof CanaryConfigurationSchema>;

/** Database transaction surface used to fence the entire synthetic lifecycle. */
export interface CanaryTransactionDatabase {
  transaction<Result>(
    operation: (transaction: unknown) => Promise<Result>,
  ): Promise<Result>;
}

/** Narrow gateway surface retained for deterministic rollback tests. */
export interface CanaryAgentGateway {
  authorize(
    input: Readonly<{
      credential: string;
      capabilityId: string;
      requestId: string;
      serverTime: Date;
    }>,
  ): Promise<AuthorizedAgentGatewayCall>;
  executeAuthorized(
    call: AuthorizedAgentGatewayCall,
    prepare: () => Promise<PreparedAgentGatewayRequest>,
  ): Promise<unknown>;
}

/** Runtime used only while the outer database transaction is open. */
export interface TransactionalCanaryRuntime {
  readonly gateway: CanaryAgentGateway;
  close(): Promise<void>;
}

export interface CanaryRouteDependencies {
  readonly database: CanaryTransactionDatabase;
  readonly gateway: CanaryAgentGateway;
  configureTransaction(transaction: unknown): Promise<void>;
  createRequestId(): string;
  createTransactionalRuntime(transaction: unknown): TransactionalCanaryRuntime;
  now(): Date;
  reportFailure(stage: CanaryFailureStage): void;
}

export type CanaryRouteHandler = (request: Request) => Promise<Response>;

export type CanaryFailureStage =
  | 'request-validation'
  | 'authorization'
  | 'credential-authority'
  | 'transaction-open'
  | 'transaction-configuration'
  | 'runtime-create'
  | 'activation-preview'
  | 'start-event'
  | 'lifecycle-preview'
  | 'all-clear-event'
  | 'close-event'
  | 'runtime-close'
  | 'rollback-proof';

const HEALTH_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  Expires: '0',
  Pragma: 'no-cache',
  'Surrogate-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

const HEALTHY_BODY = JSON.stringify({ status: 'ok' });
const UNAVAILABLE_BODY = JSON.stringify({ status: 'unavailable' });

type HealthEnvironment = Readonly<Record<string, string | undefined>>;

interface NativeDatabaseHealthResult {
  readonly value: number;
  readonly ssl: boolean;
  readonly tlsVersion: string;
}

type HealthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Temporary role credentials used only to sign read-only AWS probes. */
export interface HealthAwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}

/** Injectable read-only boundaries for the production health dependencies. */
export interface RuntimeHealthAdapters {
  readonly authenticateSharedSession?: (credential: string) => Promise<void>;
  readonly querySharedAdminDatabase?: () => Promise<NativeDatabaseHealthResult>;
  readonly resolveAwsCredentials?: (
    region: string,
    signal: AbortSignal,
  ) => Promise<HealthAwsCredentials>;
  readonly fetch?: HealthFetch;
  readonly now?: () => Date;
}

/** The three independent, side-effect-free checks required by deep health. */
export interface DeepHealthDependencies {
  checkDatabase(signal: AbortSignal): Promise<void>;
  checkDeliveryQueue(signal: AbortSignal): Promise<void>;
  checkRuntimeSecrets(signal: AbortSignal): Promise<void>;
}

export interface HealthRouteOptions {
  readonly timeoutMilliseconds?: number;
}

export type HealthRouteHandler = () => Promise<Response>;

interface QueueConfiguration {
  readonly endpoint: string;
  readonly queueArn: string;
  readonly queueUrl: string;
  readonly region: string;
}

interface SecretConfiguration {
  readonly endpoint: string;
  readonly region: string;
  readonly secretArn: string;
}

interface AwsJsonRequest {
  readonly body: string;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
}

function healthResponse(healthy: boolean, status?: number): Response {
  return new Response(healthy ? HEALTHY_BODY : UNAVAILABLE_BODY, {
    headers: HEALTH_RESPONSE_HEADERS,
    status: healthy ? 200 : (status ?? 503),
  });
}

function readCanaryConfiguration(
  environment: HealthEnvironment,
): CanaryConfiguration {
  const parsed = CanaryConfigurationSchema.safeParse({
    facilityId: environment.CANARY_FACILITY_ID,
    eventTypeVersionId: environment.CANARY_EVENT_TYPE_VERSION_ID,
  });
  if (!parsed.success) {
    throw new Error('Canary configuration is unavailable.');
  }
  return parsed.data;
}

function readBearerCredential(request: Request): string {
  return (
    /^Bearer (psd_eoc_agent_v1_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43})$/u.exec(
      request.headers.get('authorization') ?? '',
    )?.[1] ?? ''
  );
}

function assertCanaryRequestShape(request: Request): void {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw new SyntaxError('Canary requests do not accept query parameters.');
  }
  if (request.body !== null) {
    throw new SyntaxError('Canary requests do not accept a request body.');
  }
  if (request.headers.has('human-confirmation-id')) {
    throw new AgentGatewayError(
      'HUMAN_ONLY_REQUIRED',
      'Agent credentials cannot present human confirmation.',
    );
  }
}

function responseStatusForCanaryFailure(error: unknown): number {
  if (error instanceof AgentApiKeyError) {
    return error.status === 401 ? 401 : 403;
  }
  if (error instanceof AgentGatewayError) return 403;
  if (error instanceof SyntaxError || error instanceof TypeError) return 400;
  return 503;
}

function assertTimeoutMilliseconds(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_HEALTH_TIMEOUT_MILLISECONDS
  ) {
    throw new TypeError('The health timeout is outside its safe range.');
  }
  return value;
}

function requiredEnvironmentValue(
  environment: HealthEnvironment,
  name: string,
  maximumLength: number,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('Health dependency configuration is unavailable.');
  }
  return value;
}

function readRegion(environment: HealthEnvironment): string {
  const region = requiredEnvironmentValue(environment, 'AWS_REGION', 32);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/u.test(region)) {
    throw new Error('Health dependency configuration is unavailable.');
  }
  return region;
}

function partitionForRegion(region: string): string {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  return 'aws';
}

function dnsSuffixForRegion(region: string): string {
  return region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
}

export const NATIVE_DATABASE_HEALTH_SQL = `SELECT
  1::integer AS "value",
  ssl AS "ssl",
  version AS "tlsVersion"
FROM pg_catalog.pg_stat_ssl
WHERE pid = pg_backend_pid()`;

function readNativeDatabaseConfiguration(
  environment: HealthEnvironment,
): PostgresDatabaseConfig {
  const config = readDatabaseConfig(environment);
  if (config.driver !== 'postgres') {
    throw new Error('Health dependency configuration is unavailable.');
  }
  return config;
}

function readQueueConfiguration(
  environment: HealthEnvironment,
): QueueConfiguration {
  const region = readRegion(environment);
  const queueUrlValue = requiredEnvironmentValue(
    environment,
    'DELIVERY_QUEUE_URL',
    2_048,
  );
  let queueUrl: URL;
  try {
    queueUrl = new URL(queueUrlValue);
  } catch {
    throw new Error('Health dependency configuration is unavailable.');
  }
  const dnsSuffix = dnsSuffixForRegion(region);
  const pathMatch = /^\/(\d{12})\/([A-Za-z0-9_-]{1,80})\/?$/u.exec(
    queueUrl.pathname,
  );
  if (
    queueUrl.protocol !== 'https:' ||
    queueUrl.hostname !== `sqs.${region}.${dnsSuffix}` ||
    queueUrl.port !== '' ||
    queueUrl.username !== '' ||
    queueUrl.password !== '' ||
    queueUrl.search !== '' ||
    queueUrl.hash !== '' ||
    pathMatch === null
  ) {
    throw new Error('Health dependency configuration is unavailable.');
  }
  const accountId = pathMatch[1];
  const queueName = pathMatch[2];
  if (accountId === undefined || queueName === undefined) {
    throw new Error('Health dependency configuration is unavailable.');
  }
  return Object.freeze({
    endpoint: `${queueUrl.origin}/`,
    queueArn: `arn:${partitionForRegion(region)}:sqs:${region}:${accountId}:${queueName}`,
    queueUrl: queueUrl.toString(),
    region,
  });
}

function readSecretConfiguration(
  environment: HealthEnvironment,
): SecretConfiguration {
  const region = readRegion(environment);
  const secretArn = requiredEnvironmentValue(
    environment,
    'RUNTIME_SECRET_ARN',
    2_048,
  );
  const pattern = new RegExp(
    `^arn:${partitionForRegion(region)}:secretsmanager:${region}:\\d{12}:secret:[A-Za-z0-9/_+=.@-]+$`,
    'u',
  );
  if (!pattern.test(secretArn)) {
    throw new Error('Health dependency configuration is unavailable.');
  }
  return Object.freeze({
    endpoint: `https://secretsmanager.${region}.${dnsSuffixForRegion(region)}/`,
    region,
    secretArn,
  });
}

function assertInjectedRuntimeSecrets(environment: HealthEnvironment): void {
  const apiSalt = requiredEnvironmentValue(environment, 'API_SALT', 65_536);
  if (apiSalt.length < 32 || apiSalt.startsWith('arn:')) {
    throw new Error('Health dependency configuration is unavailable.');
  }
  try {
    readGoogleOidcConfiguration(environment);
  } catch {
    throw new Error('Health dependency configuration is unavailable.');
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Health dependency check was cancelled.');
  }
}

/** Waits for shared work without cancelling or closing its owning resource. */
function awaitWithoutCancellation<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  assertNotAborted(signal);
  return new Promise<Result>((resolve, reject) => {
    let completed = false;
    const removeAbortListener = () => {
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (completed) return;
      completed = true;
      removeAbortListener();
      reject(new Error('Health dependency check was cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      (result) => {
        if (completed) return;
        completed = true;
        removeAbortListener();
        resolve(result);
      },
      (error: unknown) => {
        if (completed) return;
        completed = true;
        removeAbortListener();
        reject(error);
      },
    );
  });
}

function validateCredentials(
  value: HealthAwsCredentials,
  now: Date,
): Readonly<Required<Omit<HealthAwsCredentials, 'expiration'>>> {
  const sessionToken = value.sessionToken;
  if (
    !/^ASIA[A-Z0-9]{16}$/u.test(value.accessKeyId) ||
    value.secretAccessKey.length < 16 ||
    value.secretAccessKey.length > 256 ||
    sessionToken === undefined ||
    sessionToken.length < 16 ||
    sessionToken.length > 4_096 ||
    /[\0\r\n]/u.test(value.secretAccessKey) ||
    /[\0\r\n]/u.test(sessionToken) ||
    (value.expiration !== undefined &&
      (!Number.isFinite(value.expiration.getTime()) ||
        value.expiration.getTime() <= now.getTime()))
  ) {
    throw new Error('Temporary runtime credentials are unavailable.');
  }
  return Object.freeze({
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    sessionToken,
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signAwsJsonRequest(
  input: Readonly<{
    body: string;
    contentType:
      | typeof SQS_JSON_CONTENT_TYPE
      | typeof SECRETS_JSON_CONTENT_TYPE;
    credentials: Readonly<Required<Omit<HealthAwsCredentials, 'expiration'>>>;
    endpoint: string;
    now: Date;
    region: string;
    service: string;
    target: string;
  }>,
): AwsJsonRequest {
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    throw new Error('Health dependency configuration is unavailable.');
  }
  const amzDate = input.now
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/u, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders =
    `content-type:${input.contentType}\n` +
    `host:${endpoint.host}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${input.credentials.sessionToken}\n` +
    `x-amz-target:${input.target}\n`;
  const signedHeaders =
    'content-type;host;x-amz-date;x-amz-security-token;x-amz-target';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join('\n');
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/${AWS_REQUEST_TERMINATOR}`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const dateKey = hmacSha256(
    `AWS4${input.credentials.secretAccessKey}`,
    dateStamp,
  );
  const regionKey = hmacSha256(dateKey, input.region);
  const serviceKey = hmacSha256(regionKey, input.service);
  const signingKey = hmacSha256(serviceKey, AWS_REQUEST_TERMINATOR);
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');
  return Object.freeze({
    body: input.body,
    endpoint: endpoint.toString(),
    headers: Object.freeze({
      authorization:
        `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'content-type': input.contentType,
      'x-amz-date': amzDate,
      'x-amz-security-token': input.credentials.sessionToken,
      'x-amz-target': input.target,
    }),
  });
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_AWS_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Health dependency returned an invalid response.');
  }
  if (response.body === null) {
    throw new Error('Health dependency returned an invalid response.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      assertNotAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > MAX_AWS_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Health dependency returned an invalid response.');
      }
      chunks.push(result.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An aborted stream may retain its lock; the probe still fails closed.
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Health dependency returned an invalid response.');
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

async function sendAwsReadProbe(
  fetchImplementation: HealthFetch,
  request: AwsJsonRequest,
  signal: AbortSignal,
): Promise<unknown> {
  assertNotAborted(signal);
  const response = await fetchImplementation(request.endpoint, {
    body: request.body,
    headers: request.headers,
    method: 'POST',
    signal,
  });
  const body = await readBoundedJson(response, signal);
  if (!response.ok) {
    throw new Error('Health dependency is unavailable.');
  }
  return body;
}

/**
 * Creates the production deep checks with injectable shared-route-pool and
 * network seams. Every operation is a read: an unknown session credential,
 * SELECT 1 plus TLS state, GetQueueAttributes, and DescribeSecret. Runtime
 * secret values are checked only in memory.
 */
export function createRuntimeDeepHealthDependencies(
  environment: HealthEnvironment = process.env,
  adapters: RuntimeHealthAdapters = {},
): DeepHealthDependencies {
  const fetchImplementation = adapters.fetch ?? globalThis.fetch;
  const now = adapters.now ?? (() => new Date());
  const sessionProbeCredential = `health-${randomUUID()}-${randomUUID()}`;
  let credentialsClient: S3Client | undefined;
  let sharedDatabaseProbe: Promise<NativeDatabaseHealthResult> | undefined;

  function credentialProvider(region: string): S3Client {
    credentialsClient ??= new S3Client({ maxAttempts: 1, region });
    return credentialsClient;
  }

  const authenticateSharedSession =
    adapters.authenticateSharedSession ??
    (async (credential: string): Promise<void> => {
      await getDefaultSessionService().authenticate(credential, 'web');
    });
  const querySharedAdminDatabase =
    adapters.querySharedAdminDatabase ??
    (async (): Promise<NativeDatabaseHealthResult> => {
      const rows = databaseExecuteRows<
        NativeDatabaseHealthResult & Record<string, unknown>
      >(
        await getDefaultAdminDatabase().execute<
          NativeDatabaseHealthResult & Record<string, unknown>
        >(sql.raw(NATIVE_DATABASE_HEALTH_SQL)),
      );
      const row = rows[0];
      if (
        rows.length !== 1 ||
        typeof row?.value !== 'number' ||
        typeof row.ssl !== 'boolean' ||
        typeof row.tlsVersion !== 'string'
      ) {
        throw new Error('Database health query returned an invalid result.');
      }
      return Object.freeze({
        value: row.value,
        ssl: row.ssl,
        tlsVersion: row.tlsVersion,
      });
    });

  async function probeSharedSessionDatabase(): Promise<void> {
    try {
      await authenticateSharedSession(sessionProbeCredential);
    } catch (error) {
      if (
        error instanceof SessionAccessError &&
        error.code === 'INVALID_CREDENTIAL'
      ) {
        return;
      }
      throw error;
    }
    throw new Error('Session health credential was unexpectedly accepted.');
  }

  function sharedRouteDatabaseProbe(): Promise<NativeDatabaseHealthResult> {
    if (sharedDatabaseProbe === undefined) {
      readNativeDatabaseConfiguration(environment);
      const current = Promise.allSettled([
        probeSharedSessionDatabase(),
        querySharedAdminDatabase(),
      ]).then(([sessionResult, adminResult]) => {
        if (sessionResult?.status === 'rejected') throw sessionResult.reason;
        if (adminResult?.status === 'rejected') throw adminResult.reason;
        if (adminResult === undefined) {
          throw new Error('Admin database health result was unavailable.');
        }
        return adminResult.value;
      });
      const shared = current.finally(() => {
        if (sharedDatabaseProbe === shared) sharedDatabaseProbe = undefined;
      });
      sharedDatabaseProbe = shared;
    }
    return sharedDatabaseProbe;
  }
  const resolveAwsCredentials =
    adapters.resolveAwsCredentials ??
    (async (region: string, signal: AbortSignal) => {
      assertNotAborted(signal);
      const credentials = await credentialProvider(region).config.credentials();
      assertNotAborted(signal);
      return credentials;
    });

  async function credentialsFor(
    region: string,
    signal: AbortSignal,
  ): Promise<Readonly<Required<Omit<HealthAwsCredentials, 'expiration'>>>> {
    const currentTime = now();
    if (!Number.isFinite(currentTime.getTime())) {
      throw new Error('Health dependency clock is unavailable.');
    }
    const credentials = await resolveAwsCredentials(region, signal);
    assertNotAborted(signal);
    return validateCredentials(credentials, currentTime);
  }

  return Object.freeze({
    async checkDatabase(signal: AbortSignal): Promise<void> {
      assertNotAborted(signal);
      const result = await awaitWithoutCancellation(
        sharedRouteDatabaseProbe(),
        signal,
      );
      assertNotAborted(signal);
      if (
        result.value !== 1 ||
        result.ssl !== true ||
        !/^TLSv1[.][23]$/u.test(result.tlsVersion)
      ) {
        throw new Error('Database health query returned an invalid result.');
      }
    },

    async checkDeliveryQueue(signal: AbortSignal): Promise<void> {
      assertNotAborted(signal);
      const configuration = readQueueConfiguration(environment);
      const credentials = await credentialsFor(configuration.region, signal);
      const body = JSON.stringify({
        AttributeNames: ['QueueArn'],
        QueueUrl: configuration.queueUrl,
      });
      const request = signAwsJsonRequest({
        body,
        contentType: SQS_JSON_CONTENT_TYPE,
        credentials,
        endpoint: configuration.endpoint,
        now: now(),
        region: configuration.region,
        service: 'sqs',
        target: SQS_GET_ATTRIBUTES_TARGET,
      });
      const response = asRecord(
        await sendAwsReadProbe(fetchImplementation, request, signal),
      );
      const attributes = asRecord(response?.Attributes);
      if (attributes?.QueueArn !== configuration.queueArn) {
        throw new Error('Delivery queue health response was invalid.');
      }
    },

    async checkRuntimeSecrets(signal: AbortSignal): Promise<void> {
      assertNotAborted(signal);
      assertInjectedRuntimeSecrets(environment);
      const configuration = readSecretConfiguration(environment);
      const credentials = await credentialsFor(configuration.region, signal);
      const body = JSON.stringify({ SecretId: configuration.secretArn });
      const request = signAwsJsonRequest({
        body,
        contentType: SECRETS_JSON_CONTENT_TYPE,
        credentials,
        endpoint: configuration.endpoint,
        now: now(),
        region: configuration.region,
        service: 'secretsmanager',
        target: SECRETS_DESCRIBE_TARGET,
      });
      const response = asRecord(
        await sendAwsReadProbe(fetchImplementation, request, signal),
      );
      if (response?.ARN !== configuration.secretArn) {
        throw new Error('Runtime secret health response was invalid.');
      }
    },
  });
}

/** Creates the unauthenticated, fail-closed GET handler used by App Runner. */
export function createHealthRouteHandler(
  dependencies: DeepHealthDependencies,
  options: HealthRouteOptions = {},
): HealthRouteHandler {
  const timeoutMilliseconds = assertTimeoutMilliseconds(
    options.timeoutMilliseconds ?? DEFAULT_HEALTH_TIMEOUT_MILLISECONDS,
  );
  let inFlight: Promise<boolean> | undefined;

  async function runDeepHealth(): Promise<boolean> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Deep health deadline exceeded.'));
      }, timeoutMilliseconds);
    });
    const checks = Promise.all([
      Promise.resolve().then(() =>
        dependencies.checkDatabase(controller.signal),
      ),
      Promise.resolve().then(() =>
        dependencies.checkDeliveryQueue(controller.signal),
      ),
      Promise.resolve().then(() =>
        dependencies.checkRuntimeSecrets(controller.signal),
      ),
    ]);

    try {
      await Promise.race([checks, deadline]);
      return true;
    } catch {
      controller.abort();
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  return async function healthGet(): Promise<Response> {
    if (inFlight === undefined) {
      const current = runDeepHealth();
      const shared = current.finally(() => {
        if (inFlight === shared) inFlight = undefined;
      });
      inFlight = shared;
    }
    return healthResponse(await inFlight);
  };
}

const CANARY_ROLLBACK_SENTINEL = Object.freeze({
  kind: 'psd-eoc-private-canary-rollback',
});

interface CanaryAuthorizedCalls {
  readonly calls: Readonly<
    Record<(typeof CANARY_CAPABILITY_IDS)[number], AuthorizedAgentGatewayCall>
  >;
  readonly requestIds: Readonly<
    Record<(typeof CANARY_CAPABILITY_IDS)[number], string>
  >;
  readonly serverTime: Date;
}

function hasExactCanaryCapabilities(
  capabilityIds: readonly AgentGrantableCapabilityId[],
): boolean {
  return (
    capabilityIds.length === CANARY_CAPABILITY_IDS.length &&
    CANARY_CAPABILITY_IDS.every(
      (capabilityId) =>
        capabilityIds.filter((candidate) => candidate === capabilityId)
          .length === 1,
    )
  );
}

function hasExactCanaryFacilityScope(
  scope: AuthorizedAgentGatewayCall['authenticated']['scope']['facilityScope'],
  facilityId: string,
): boolean {
  return (
    scope.kind === 'facilities' &&
    scope.facilityIds.length === 1 &&
    scope.facilityIds[0] === facilityId
  );
}

function assertCanaryAuthority(
  authorized: readonly (readonly [
    (typeof CANARY_CAPABILITY_IDS)[number],
    AuthorizedAgentGatewayCall,
  ])[],
  configuration: CanaryConfiguration,
): void {
  const first = authorized[0]?.[1].authenticated;
  if (first === undefined) {
    throw new AgentGatewayError(
      'CAPABILITY_NOT_GRANTED',
      'The rollback canary credential has no authority.',
    );
  }
  for (const [capabilityId, call] of authorized) {
    const authenticated = call.authenticated;
    if (
      call.capabilityId !== capabilityId ||
      authenticated.actor.apiKeyId !== authenticated.key.id ||
      authenticated.actor.agentId !== authenticated.key.agentId ||
      authenticated.actor.apiKeyId !== first.actor.apiKeyId ||
      authenticated.actor.agentId !== first.actor.agentId ||
      !hasExactCanaryFacilityScope(
        authenticated.scope.facilityScope,
        configuration.facilityId,
      ) ||
      !hasExactCanaryFacilityScope(
        authenticated.key.facilityScope,
        configuration.facilityId,
      ) ||
      !hasExactCanaryCapabilities(authenticated.capabilityIds) ||
      !hasExactCanaryCapabilities(authenticated.key.capabilityIds)
    ) {
      throw new AgentGatewayError(
        'CAPABILITY_NOT_GRANTED',
        'The rollback canary credential authority is not exact.',
      );
    }
  }
}

async function authorizeCanaryCapabilities(
  credential: string,
  dependencies: CanaryRouteDependencies,
): Promise<CanaryAuthorizedCalls> {
  const serverTime = new Date(dependencies.now().getTime());
  if (!Number.isFinite(serverTime.getTime())) {
    throw new Error('The canary clock is unavailable.');
  }
  const requestIds = Object.fromEntries(
    CANARY_CAPABILITY_IDS.map((capabilityId) => [
      capabilityId,
      dependencies.createRequestId(),
    ]),
  ) as Record<(typeof CANARY_CAPABILITY_IDS)[number], string>;
  const authorized: Array<
    readonly [
      (typeof CANARY_CAPABILITY_IDS)[number],
      AuthorizedAgentGatewayCall,
    ]
  > = [];
  for (const capabilityId of CANARY_CAPABILITY_IDS) {
    authorized.push([
      capabilityId,
      await dependencies.gateway.authorize({
        credential,
        capabilityId,
        requestId: requestIds[capabilityId],
        serverTime,
      }),
    ]);
  }
  return Object.freeze({
    calls: Object.freeze(Object.fromEntries(authorized)) as Readonly<
      Record<(typeof CANARY_CAPABILITY_IDS)[number], AuthorizedAgentGatewayCall>
    >,
    requestIds: Object.freeze(requestIds),
    serverTime,
  });
}

function mutationRequest(
  input: unknown,
  capabilityId: Exclude<
    (typeof CANARY_CAPABILITY_IDS)[number],
    'create-activation-preview'
  >,
  requestId: string,
): PreparedAgentGatewayRequest {
  return Object.freeze({
    input,
    idempotencyKey: `health-canary:${capabilityId}:${requestId}`,
  });
}

async function executeCanaryLifecycle(
  runtime: TransactionalCanaryRuntime,
  authorized: CanaryAuthorizedCalls,
  configuration: CanaryConfiguration,
  beforeStage: (
    stage: Extract<
      CanaryFailureStage,
      | 'activation-preview'
      | 'start-event'
      | 'lifecycle-preview'
      | 'all-clear-event'
      | 'close-event'
    >,
  ) => void,
): Promise<void> {
  // The production gateway parses every output against the canonical contract
  // before returning. The assertion only adapts its intentionally unknown seam.
  beforeStage('activation-preview');
  const activationPreview = (await runtime.gateway.executeAuthorized(
    authorized.calls['create-activation-preview'],
    async () => ({
      input: {
        facilityId: configuration.facilityId,
        kind: 'test',
        templateMode: 'drill',
        eventTypeVersion: {
          id: configuration.eventTypeVersionId,
          templateMode: 'drill',
        },
        rosterPopulation: 'synthetic',
      },
      idempotencyKey: null,
    }),
  )) as ActivationPreview;
  if (
    activationPreview.facilityId !== configuration.facilityId ||
    activationPreview.kind !== 'test' ||
    activationPreview.templateMode !== 'drill' ||
    activationPreview.rosterPopulation !== 'synthetic' ||
    activationPreview.sendReadiness !== 'ready' ||
    activationPreview.eventTypeVersion.id !==
      configuration.eventTypeVersionId ||
    activationPreview.eventTypeVersion.templateMode !== 'drill'
  ) {
    throw new Error('The synthetic canary preview targeted another facility.');
  }

  beforeStage('start-event');
  const started = (await runtime.gateway.executeAuthorized(
    authorized.calls['start-event'],
    async () =>
      mutationRequest(
        {
          source: 'activation-preview',
          activationPreviewId: activationPreview.id,
          activeEventDecision: {
            decision: 'start-new',
            activeEventIdsSeen: activationPreview.activeEventIds,
          },
        },
        'start-event',
        authorized.requestIds['start-event'],
      ),
  )) as EventLifecycleMutationResult;
  if (
    started.event.facilityId !== configuration.facilityId ||
    started.event.kind !== 'test' ||
    started.event.templateMode !== 'drill' ||
    started.event.rosterPopulation !== 'synthetic' ||
    started.event.eventTypeVersion.id !== configuration.eventTypeVersionId ||
    started.event.eventTypeVersion.templateMode !== 'drill' ||
    started.event.status !== 'active' ||
    started.notificationIntent?.eventId !== started.event.id ||
    started.notificationIntent.purpose !== 'activation' ||
    started.notificationIntent.eventKind !== 'test' ||
    started.notificationIntent.templateMode !== 'drill' ||
    started.notificationIntent.rosterPopulation !== 'synthetic' ||
    started.notificationIntent.eventTypeVersion.id !==
      configuration.eventTypeVersionId ||
    started.notificationIntent.eventTypeVersion.templateMode !== 'drill'
  ) {
    throw new Error('The canary lifecycle lost its synthetic classification.');
  }

  beforeStage('lifecycle-preview');
  const lifecyclePreview = (await runtime.gateway.executeAuthorized(
    authorized.calls['create-lifecycle-consequence-preview'],
    async () =>
      mutationRequest(
        { eventId: started.event.id, purpose: 'all-clear' },
        'create-lifecycle-consequence-preview',
        authorized.requestIds['create-lifecycle-consequence-preview'],
      ),
  )) as LifecycleConsequencePreview;
  if (
    lifecyclePreview.eventId !== started.event.id ||
    lifecyclePreview.purpose !== 'all-clear' ||
    lifecyclePreview.kind !== 'test' ||
    lifecyclePreview.templateMode !== 'drill' ||
    lifecyclePreview.rosterPopulation !== 'synthetic' ||
    lifecyclePreview.sendReadiness !== 'ready' ||
    lifecyclePreview.eventTypeVersion.id !== configuration.eventTypeVersionId ||
    lifecyclePreview.eventTypeVersion.templateMode !== 'drill'
  ) {
    throw new Error('The canary all-clear preview is not synthetic and ready.');
  }

  beforeStage('all-clear-event');
  const allClear = (await runtime.gateway.executeAuthorized(
    authorized.calls['all-clear-event'],
    async () =>
      mutationRequest(
        {
          eventId: started.event.id,
          lifecyclePreviewId: lifecyclePreview.id,
        },
        'all-clear-event',
        authorized.requestIds['all-clear-event'],
      ),
  )) as EventLifecycleMutationResult;
  if (
    allClear.event.id !== started.event.id ||
    allClear.event.facilityId !== configuration.facilityId ||
    allClear.event.kind !== 'test' ||
    allClear.event.templateMode !== 'drill' ||
    allClear.event.rosterPopulation !== 'synthetic' ||
    allClear.event.eventTypeVersion.id !== configuration.eventTypeVersionId ||
    allClear.event.eventTypeVersion.templateMode !== 'drill' ||
    allClear.event.status !== 'all-clear' ||
    allClear.notificationIntent?.eventId !== started.event.id ||
    allClear.notificationIntent.purpose !== 'all-clear' ||
    allClear.notificationIntent.eventKind !== 'test' ||
    allClear.notificationIntent.templateMode !== 'drill' ||
    allClear.notificationIntent.rosterPopulation !== 'synthetic' ||
    allClear.notificationIntent.eventTypeVersion.id !==
      configuration.eventTypeVersionId ||
    allClear.notificationIntent.eventTypeVersion.templateMode !== 'drill'
  ) {
    throw new Error('The canary all-clear result is invalid.');
  }

  beforeStage('close-event');
  const closed = (await runtime.gateway.executeAuthorized(
    authorized.calls['close-event'],
    async () =>
      mutationRequest(
        { eventId: started.event.id },
        'close-event',
        authorized.requestIds['close-event'],
      ),
  )) as EventLifecycleMutationResult;
  if (
    closed.event.id !== started.event.id ||
    closed.event.facilityId !== configuration.facilityId ||
    closed.event.kind !== 'test' ||
    closed.event.templateMode !== 'drill' ||
    closed.event.rosterPopulation !== 'synthetic' ||
    closed.event.eventTypeVersion.id !== configuration.eventTypeVersionId ||
    closed.event.eventTypeVersion.templateMode !== 'drill' ||
    closed.event.status !== 'closed' ||
    closed.notificationIntent !== null
  ) {
    throw new Error('The canary close result is invalid.');
  }
}

interface CanaryTransactionExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

/** Applies transaction-local PostgreSQL limits before any lifecycle handler. */
export async function configureCanaryTransaction(
  transaction: unknown,
): Promise<void> {
  if (
    typeof transaction !== 'object' ||
    transaction === null ||
    typeof Reflect.get(transaction, 'execute') !== 'function'
  ) {
    throw new TypeError('The canary transaction executor is unavailable.');
  }
  await (transaction as CanaryTransactionExecutor).execute(
    sql.raw(CANARY_TRANSACTION_CONFIGURATION_SQL),
  );
}

function assertCanaryDeadline(
  transactionStartedAt: Date,
  currentTime: Date,
): void {
  const elapsed = currentTime.getTime() - transactionStartedAt.getTime();
  if (
    !Number.isFinite(currentTime.getTime()) ||
    elapsed < 0 ||
    elapsed > CANARY_TOTAL_DEADLINE_MILLISECONDS
  ) {
    throw new Error('The canary transaction deadline was exceeded.');
  }
}

/**
 * Creates the authenticated one-minute canary. All five grants authenticate
 * before any lifecycle handler runs. The canonical chain then executes inside
 * one outer transaction and returns success only after the identity sentinel
 * proves every event, journal, intent, outbox, idempotency, and audit write was
 * rolled back.
 */
export function createCanaryRouteHandler(
  dependencies: CanaryRouteDependencies,
  environment: HealthEnvironment = process.env,
): CanaryRouteHandler {
  return async function canaryPost(request: Request): Promise<Response> {
    let stage: CanaryFailureStage = 'request-validation';
    try {
      assertCanaryRequestShape(request);
      const configuration = readCanaryConfiguration(environment);
      stage = 'authorization';
      const authorized = await authorizeCanaryCapabilities(
        readBearerCredential(request),
        dependencies,
      );
      stage = 'credential-authority';
      assertCanaryAuthority(
        CANARY_CAPABILITY_IDS.map(
          (capabilityId) =>
            [capabilityId, authorized.calls[capabilityId]] as const,
        ),
        configuration,
      );
      const transactionStartedAt = new Date(dependencies.now().getTime());
      if (!Number.isFinite(transactionStartedAt.getTime())) {
        throw new Error('The canary transaction clock is unavailable.');
      }
      let sentinelObserved = false;
      try {
        stage = 'transaction-open';
        await dependencies.database.transaction(async (transaction) => {
          stage = 'transaction-configuration';
          await dependencies.configureTransaction(transaction);
          assertCanaryDeadline(transactionStartedAt, dependencies.now());
          stage = 'runtime-create';
          const runtime = dependencies.createTransactionalRuntime(transaction);
          try {
            await executeCanaryLifecycle(
              runtime,
              authorized,
              configuration,
              (nextStage) => {
                stage = nextStage;
                assertCanaryDeadline(transactionStartedAt, dependencies.now());
              },
            );
          } finally {
            const precedingStage = stage;
            stage = 'runtime-close';
            await runtime.close();
            stage = precedingStage;
          }
          stage = 'rollback-proof';
          assertCanaryDeadline(transactionStartedAt, dependencies.now());
          throw CANARY_ROLLBACK_SENTINEL;
        });
      } catch (error) {
        if (error !== CANARY_ROLLBACK_SENTINEL) throw error;
        sentinelObserved = true;
      }
      if (!sentinelObserved) {
        stage = 'rollback-proof';
        throw new Error('The rollback canary did not prove rollback.');
      }
      return healthResponse(true);
    } catch (error) {
      try {
        dependencies.reportFailure(stage);
      } catch {
        // Telemetry must never replace the generic fail-closed response.
      }
      return healthResponse(false, responseStatusForCanaryFailure(error));
    }
  };
}

function transactionConnection(
  transaction: unknown,
): PostgresDatabaseConnection {
  const close = () => Promise.resolve();
  return {
    driver: 'postgres',
    db: transaction as PostgresDatabaseConnection['db'],
    close,
  } satisfies PostgresDatabaseConnection;
}

/** Builds the production base gateway and transaction-bound runtime seam. */
export function createRuntimeCanaryRouteDependencies(
  connection: DatabaseConnection = createDatabaseClient(readDatabaseConfig()),
): CanaryRouteDependencies {
  if (connection.driver !== 'postgres') {
    throw new Error(
      'The exploration health canary requires native PostgreSQL.',
    );
  }
  const baseRuntime = createAgentRestRuntime(connection);
  return Object.freeze({
    database: connection.db as CanaryTransactionDatabase,
    gateway: baseRuntime.gateway,
    configureTransaction: configureCanaryTransaction,
    createRequestId: randomUUID,
    createTransactionalRuntime(transaction: unknown): AgentRestRuntime {
      return createAgentRestRuntime(transactionConnection(transaction));
    },
    now: () => new Date(),
    reportFailure(stage: CanaryFailureStage): void {
      console.error(JSON.stringify({ event: 'health-canary-failure', stage }));
    },
  });
}

const runtimeHealthHandler = createHealthRouteHandler(
  createRuntimeDeepHealthDependencies(),
);
let runtimeCanaryHandler: CanaryRouteHandler | undefined;

/** Side-effect-free, unauthenticated deep health read. */
export function handleHealthGet(): Promise<Response> {
  return runtimeHealthHandler();
}

/** Authenticated TEST/drill/synthetic lifecycle, deliberately rolled back. */
export function handleHealthPost(request: Request): Promise<Response> {
  runtimeCanaryHandler ??= createCanaryRouteHandler(
    createRuntimeCanaryRouteDependencies(),
  );
  return runtimeCanaryHandler(request);
}
