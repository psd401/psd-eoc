import {
  AuthenticationCapabilityEnvelopeSchema,
  CompleteOidcSignInInputSchema,
  OidcCallbackTransportSchema,
  PreSessionOidcPrincipalSchema,
  type AuthenticationCapabilityEnvelope,
  type CompleteOidcSignInInput,
  type OidcCallbackTransport,
  type PreSessionOidcPrincipal,
} from '@psd-eoc/contracts';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_ISSUER = 'https://accounts.google.com' as const;
const PSD_HOSTED_DOMAIN = 'psd401.net' as const;
const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

const TRANSIENT_COOKIE_LIFETIME_SECONDS = 10 * 60;
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_TOKEN_RESPONSE_LENGTH = 64 * 1024;
const MAX_ID_TOKEN_LENGTH = 24 * 1024;
const DEFAULT_HTTP_TIMEOUT_MILLISECONDS = 10_000;
const COOKIE_FORMAT_VERSION = 'v1';
const TRANSIENT_STATE_VERSION = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

type RuntimeMode = 'development' | 'production' | 'test';
type Environment = Readonly<Record<string, string | undefined>>;

interface PrivateGoogleOidcConfiguration {
  readonly clientSecret: string;
  readonly cookieKeyMaterial: Uint8Array;
}

/**
 * Public, non-secret Google OIDC configuration. Secret values are retained in
 * module-private storage so accidental serialization cannot expose them.
 */
export interface GoogleOidcConfiguration {
  readonly mode: RuntimeMode;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly transientCookieName: string;
  readonly secureCookies: boolean;
  readonly httpTimeoutMilliseconds: number;
}

const privateConfigurations = new WeakMap<
  GoogleOidcConfiguration,
  PrivateGoogleOidcConfiguration
>();

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type GoogleOidcConfigurationErrorCode =
  | 'OIDC_CONFIGURATION_INVALID'
  | 'OIDC_CRYPTO_UNAVAILABLE';

/** A configuration error whose message never contains a supplied secret. */
export class GoogleOidcConfigurationError extends Error {
  public readonly code: GoogleOidcConfigurationErrorCode;

  public constructor(code: GoogleOidcConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'GoogleOidcConfigurationError';
    this.code = code;
  }
}

export type GoogleOidcCallbackErrorCode =
  | 'OIDC_CALLBACK_INVALID'
  | 'OIDC_ID_TOKEN_INVALID'
  | 'OIDC_PROVIDER_DENIED'
  | 'OIDC_PROVIDER_LOGIN_REQUIRED'
  | 'OIDC_PROVIDER_REJECTED'
  | 'OIDC_PROVIDER_UNAVAILABLE'
  | 'OIDC_STATE_MISMATCH'
  | 'OIDC_TOKEN_EXCHANGE_FAILED'
  | 'OIDC_TOKEN_RESPONSE_INVALID'
  | 'OIDC_TRANSIENT_COOKIE_INVALID'
  | 'OIDC_TRANSIENT_COOKIE_MISSING';

const CALLBACK_ERROR_MESSAGES: Readonly<
  Record<GoogleOidcCallbackErrorCode, string>
> = Object.freeze({
  OIDC_CALLBACK_INVALID: 'The sign-in callback was invalid.',
  OIDC_ID_TOKEN_INVALID: 'Google identity verification failed.',
  OIDC_PROVIDER_DENIED: 'Google sign-in was denied.',
  OIDC_PROVIDER_LOGIN_REQUIRED: 'Google requires a new sign-in.',
  OIDC_PROVIDER_REJECTED: 'Google could not complete sign-in.',
  OIDC_PROVIDER_UNAVAILABLE: 'Google sign-in is temporarily unavailable.',
  OIDC_STATE_MISMATCH: 'The sign-in request could not be verified.',
  OIDC_TOKEN_EXCHANGE_FAILED: 'Google rejected the sign-in response.',
  OIDC_TOKEN_RESPONSE_INVALID: 'Google returned an invalid sign-in response.',
  OIDC_TRANSIENT_COOKIE_INVALID: 'The sign-in request could not be verified.',
  OIDC_TRANSIENT_COOKIE_MISSING: 'The sign-in request has expired.',
});

/**
 * Safe callback failure for a denied page and minimized audit record. Raw
 * authorization codes, provider descriptions, tokens, and claims are omitted.
 */
export class GoogleOidcCallbackError extends Error {
  public readonly code: GoogleOidcCallbackErrorCode;
  public readonly clearCookieHeader: string;
  public readonly stateVerified: boolean;
  public readonly responseDigest: string | null;

  public constructor(options: {
    readonly code: GoogleOidcCallbackErrorCode;
    readonly clearCookieHeader: string;
    readonly stateVerified: boolean;
    readonly responseDigest: string | null;
  }) {
    super(CALLBACK_ERROR_MESSAGES[options.code]);
    this.name = 'GoogleOidcCallbackError';
    this.code = options.code;
    this.clearCookieHeader = options.clearCookieHeader;
    this.stateVerified = options.stateVerified;
    this.responseDigest = options.responseDigest;
  }
}

export interface BeginGoogleOidcSignInInput {
  /** Existing opaque web installation identifier, when one is available. */
  readonly installationId?: string;
}

export interface BeginGoogleOidcSignInResult {
  readonly authorizationUrl: string;
  readonly setCookieHeader: string;
  readonly expiresAt: string;
}

export interface CompleteGoogleOidcCallbackInput {
  readonly method: string;
  readonly callbackUrl: string | URL;
  readonly cookieHeader: string | null;
}

/** Verified adapter output ready for the canonical sign-in capability. */
export interface CompleteGoogleOidcCallbackResult {
  readonly capabilityInput: CompleteOidcSignInInput;
  readonly principal: PreSessionOidcPrincipal;
  readonly transport: OidcCallbackTransport;
  readonly idempotencyKey: string;
  readonly responseDigest: string;
  readonly clearCookieHeader: string;
}

export interface CompleteOidcEnvelopeContext {
  readonly requestId: string;
  readonly serverTime: string;
}

interface TransientOidcState {
  readonly version: typeof TRANSIENT_STATE_VERSION;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly installationId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function configurationError(message: string): never {
  throw new GoogleOidcConfigurationError('OIDC_CONFIGURATION_INVALID', message);
}

function requiredEnvironmentValue(
  environment: Environment,
  name: string,
  maximumLength: number,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maximumLength ||
    /[\r\n\0]/u.test(value)
  ) {
    return configurationError(`${name} must be set to a valid value.`);
  }
  return value;
}

function optionalEnvironmentValue(
  environment: Environment,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (value !== value.trim() || /[\r\n\0]/u.test(value)) {
    return configurationError(`${name} must be a valid value when set.`);
  }
  return value;
}

function readRuntimeMode(environment: Environment): RuntimeMode {
  const value = environment.NODE_ENV ?? 'development';
  if (value === 'development' || value === 'production' || value === 'test') {
    return value;
  }
  return configurationError(
    'NODE_ENV must be development, production, or test for Google OIDC.',
  );
}

function parseBase64UrlSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return configurationError(
      'GOOGLE_OIDC_COOKIE_SECRET must be unpadded base64url.',
    );
  }

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(value);
  } catch {
    return configurationError(
      'GOOGLE_OIDC_COOKIE_SECRET must be unpadded base64url.',
    );
  }

  if (decoded.byteLength < 32 || decoded.byteLength > 64) {
    return configurationError(
      'GOOGLE_OIDC_COOKIE_SECRET must decode to 32 through 64 bytes.',
    );
  }
  return decoded;
}

function parseHttpTimeout(environment: Environment): number {
  const value = optionalEnvironmentValue(
    environment,
    'GOOGLE_OIDC_HTTP_TIMEOUT_MS',
  );
  if (value === undefined) {
    return DEFAULT_HTTP_TIMEOUT_MILLISECONDS;
  }
  if (!/^\d+$/u.test(value)) {
    return configurationError(
      'GOOGLE_OIDC_HTTP_TIMEOUT_MS must be an integer from 1000 through 30000.',
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 30_000) {
    return configurationError(
      'GOOGLE_OIDC_HTTP_TIMEOUT_MS must be an integer from 1000 through 30000.',
    );
  }
  return parsed;
}

function parseAbsoluteUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configurationError(`${name} must be an absolute URL.`);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    return configurationError(`${name} must be a safe absolute HTTP URL.`);
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function parseProviderEndpoints(
  environment: Environment,
  mode: RuntimeMode,
): Readonly<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}> {
  const names = [
    'GOOGLE_OIDC_AUTHORIZATION_ENDPOINT',
    'GOOGLE_OIDC_TOKEN_ENDPOINT',
    'GOOGLE_OIDC_JWKS_URI',
  ] as const;
  const values = names.map((name) =>
    optionalEnvironmentValue(environment, name),
  );
  const suppliedCount = values.filter((value) => value !== undefined).length;

  if (mode === 'production' && suppliedCount > 0) {
    return configurationError(
      'Google OIDC provider endpoint overrides are forbidden in production.',
    );
  }
  if (suppliedCount !== 0 && suppliedCount !== names.length) {
    return configurationError(
      'All Google OIDC provider endpoint overrides must be set together.',
    );
  }
  if (mode === 'test' && suppliedCount === 0) {
    return configurationError(
      'Tests must configure local Google OIDC mock-provider endpoints.',
    );
  }
  if (suppliedCount === 0) {
    return Object.freeze({
      authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
      jwksUri: GOOGLE_JWKS_URI,
    });
  }

  const parsed = values.map((value, index) =>
    parseAbsoluteUrl(names[index] ?? 'Google OIDC endpoint', value ?? ''),
  );
  parsed.forEach((url, index) => {
    if (!isLoopbackHostname(url.hostname)) {
      configurationError(
        `${names[index] ?? 'Google OIDC endpoint'} overrides must use a loopback host.`,
      );
    }
    if (url.search.length > 0) {
      configurationError(
        `${names[index] ?? 'Google OIDC endpoint'} overrides cannot contain a query.`,
      );
    }
  });

  return Object.freeze({
    authorizationEndpoint: parsed[0]?.toString() ?? '',
    tokenEndpoint: parsed[1]?.toString() ?? '',
    jwksUri: parsed[2]?.toString() ?? '',
  });
}

/**
 * Parses Google OIDC configuration without performing discovery or any other
 * network request. Test endpoint overrides must be complete and loopback-only;
 * production is pinned to Google's fixed endpoints.
 */
export function readGoogleOidcConfiguration(
  environment: Environment = process.env,
): GoogleOidcConfiguration {
  const mode = readRuntimeMode(environment);
  const clientId = requiredEnvironmentValue(
    environment,
    'GOOGLE_OIDC_CLIENT_ID',
    255,
  );
  const clientSecret = requiredEnvironmentValue(
    environment,
    'GOOGLE_OIDC_CLIENT_SECRET',
    2_048,
  );
  const redirectUriValue = requiredEnvironmentValue(
    environment,
    'GOOGLE_OIDC_REDIRECT_URI',
    2_048,
  );
  const cookieSecretValue = requiredEnvironmentValue(
    environment,
    'GOOGLE_OIDC_COOKIE_SECRET',
    128,
  );

  if (
    mode === 'production' &&
    !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(clientId)
  ) {
    return configurationError(
      'GOOGLE_OIDC_CLIENT_ID must be a Google OAuth client ID in production.',
    );
  }

  const redirectUri = parseAbsoluteUrl(
    'GOOGLE_OIDC_REDIRECT_URI',
    redirectUriValue,
  );
  if (redirectUri.search.length > 0) {
    return configurationError(
      'GOOGLE_OIDC_REDIRECT_URI cannot contain a query or fragment.',
    );
  }
  if (mode === 'production' && redirectUri.protocol !== 'https:') {
    return configurationError(
      'GOOGLE_OIDC_REDIRECT_URI must use HTTPS in production.',
    );
  }
  if (
    redirectUri.protocol === 'http:' &&
    !isLoopbackHostname(redirectUri.hostname)
  ) {
    return configurationError(
      'An HTTP GOOGLE_OIDC_REDIRECT_URI must use a loopback host.',
    );
  }

  const endpoints = parseProviderEndpoints(environment, mode);
  const secureCookies = redirectUri.protocol === 'https:';
  const configuration: GoogleOidcConfiguration = Object.freeze({
    mode,
    clientId,
    redirectUri: redirectUri.toString(),
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
    jwksUri: endpoints.jwksUri,
    transientCookieName: secureCookies ? '__Host-psd-eoc-oidc' : 'psd-eoc-oidc',
    secureCookies,
    httpTimeoutMilliseconds: parseHttpTimeout(environment),
  });

  privateConfigurations.set(configuration, {
    clientSecret,
    cookieKeyMaterial: parseBase64UrlSecret(cookieSecretValue),
  });
  return configuration;
}

function getPrivateConfiguration(
  configuration: GoogleOidcConfiguration,
): PrivateGoogleOidcConfiguration {
  const privateConfiguration = privateConfigurations.get(configuration);
  if (privateConfiguration === undefined) {
    return configurationError(
      'Google OIDC configuration must come from readGoogleOidcConfiguration.',
    );
  }
  return privateConfiguration;
}

function requireWebCrypto(): Crypto {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.subtle === undefined) {
    throw new GoogleOidcConfigurationError(
      'OIDC_CRYPTO_UNAVAILABLE',
      'Google OIDC requires the Web Crypto API.',
    );
  }
  return webCrypto;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  requireWebCrypto().getRandomValues(bytes);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('Invalid base64url.');
  }
  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(paddingLength);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64Url(bytes) !== value) {
    throw new Error('Non-canonical base64url.');
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, '0');
  }
  return value;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Bytes(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
  const digest = await requireWebCrypto().subtle.digest(
    'SHA-256',
    copyToArrayBuffer(bytes),
  );
  return new Uint8Array(digest);
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function deriveCookieKey(
  configuration: GoogleOidcConfiguration,
): Promise<CryptoKey> {
  const privateConfiguration = getPrivateConfiguration(configuration);
  const context = textEncoder.encode(
    'psd-eoc/google-oidc/transient-cookie/aes-256-gcm/v1',
  );
  const combined = new Uint8Array(
    privateConfiguration.cookieKeyMaterial.byteLength + context.byteLength,
  );
  combined.set(privateConfiguration.cookieKeyMaterial, 0);
  combined.set(context, privateConfiguration.cookieKeyMaterial.byteLength);
  const keyBytes = await sha256Bytes(combined);
  return requireWebCrypto().subtle.importKey(
    'raw',
    copyToArrayBuffer(keyBytes),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function cookieAdditionalData(
  configuration: GoogleOidcConfiguration,
): Uint8Array {
  return textEncoder.encode(
    [
      COOKIE_FORMAT_VERSION,
      configuration.transientCookieName,
      configuration.clientId,
      configuration.redirectUri,
      configuration.authorizationEndpoint,
      configuration.tokenEndpoint,
      configuration.jwksUri,
    ].join('\n'),
  );
}

async function encryptTransientState(
  configuration: GoogleOidcConfiguration,
  transientState: TransientOidcState,
): Promise<string> {
  const initializationVector = randomBytes(12);
  const additionalData = cookieAdditionalData(configuration);
  const plaintext = textEncoder.encode(JSON.stringify(transientState));
  const ciphertext = await requireWebCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: copyToArrayBuffer(initializationVector),
      additionalData: copyToArrayBuffer(additionalData),
      tagLength: 128,
    },
    await deriveCookieKey(configuration),
    copyToArrayBuffer(plaintext),
  );
  return [
    COOKIE_FORMAT_VERSION,
    encodeBase64Url(initializationVector),
    encodeBase64Url(new Uint8Array(ciphertext)),
  ].join('.');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTransientState(
  value: unknown,
  nowInSeconds: number,
): TransientOidcState | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'codeVerifier',
    'expiresAt',
    'installationId',
    'issuedAt',
    'nonce',
    'state',
    'version',
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.version !== TRANSIENT_STATE_VERSION ||
    typeof value.state !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.state) ||
    typeof value.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.nonce) ||
    typeof value.codeVerifier !== 'string' ||
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(value.codeVerifier) ||
    typeof value.installationId !== 'string' ||
    value.installationId.length < 16 ||
    value.installationId.length > 255 ||
    value.installationId !== value.installationId.trim() ||
    typeof value.issuedAt !== 'number' ||
    !Number.isSafeInteger(value.issuedAt) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt - value.issuedAt !== TRANSIENT_COOKIE_LIFETIME_SECONDS ||
    value.issuedAt > nowInSeconds + CLOCK_TOLERANCE_SECONDS ||
    value.expiresAt <= nowInSeconds
  ) {
    return null;
  }
  return {
    version: TRANSIENT_STATE_VERSION,
    state: value.state,
    nonce: value.nonce,
    codeVerifier: value.codeVerifier,
    installationId: value.installationId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

async function decryptTransientState(
  configuration: GoogleOidcConfiguration,
  cookieValue: string,
  nowInSeconds: number,
): Promise<TransientOidcState | null> {
  if (cookieValue.length === 0 || cookieValue.length > 4_096) {
    return null;
  }
  const parts = cookieValue.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== COOKIE_FORMAT_VERSION ||
    parts[1] === undefined ||
    parts[2] === undefined
  ) {
    return null;
  }

  try {
    const initializationVector = decodeBase64Url(parts[1]);
    const ciphertext = decodeBase64Url(parts[2]);
    if (
      initializationVector.byteLength !== 12 ||
      ciphertext.byteLength < 17 ||
      ciphertext.byteLength > 4_096
    ) {
      return null;
    }
    const plaintext = await requireWebCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: copyToArrayBuffer(initializationVector),
        additionalData: copyToArrayBuffer(cookieAdditionalData(configuration)),
        tagLength: 128,
      },
      await deriveCookieKey(configuration),
      copyToArrayBuffer(ciphertext),
    );
    return parseTransientState(
      JSON.parse(textDecoder.decode(plaintext)) as unknown,
      nowInSeconds,
    );
  } catch {
    return null;
  }
}

function serializeTransientCookie(
  configuration: GoogleOidcConfiguration,
  value: string,
): string {
  const attributes = [
    `${configuration.transientCookieName}=${value}`,
    `Max-Age=${TRANSIENT_COOKIE_LIFETIME_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (configuration.secureCookies) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

function serializeClearedTransientCookie(
  configuration: GoogleOidcConfiguration,
): string {
  const attributes = [
    `${configuration.transientCookieName}=`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (configuration.secureCookies) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

function readCookieValue(
  cookieHeader: string | null,
  cookieName: string,
): string | null {
  if (cookieHeader === null || cookieHeader.length > 16_384) {
    return null;
  }
  const matches: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    if (name === cookieName) {
      matches.push(part.slice(separatorIndex + 1).trim());
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function validateInstallationId(installationId: string | undefined): string {
  if (installationId === undefined) {
    return `web.${encodeBase64Url(randomBytes(32))}`;
  }
  if (
    installationId.length < 16 ||
    installationId.length > 255 ||
    installationId !== installationId.trim() ||
    /[\r\n\0]/u.test(installationId)
  ) {
    return configurationError(
      'The web installation identifier must be an opaque 16-255 character value.',
    );
  }
  return installationId;
}

/** Starts a code+PKCE request and returns the redirect plus transient cookie. */
export async function beginGoogleOidcSignIn(
  configuration: GoogleOidcConfiguration,
  input: BeginGoogleOidcSignInInput = {},
): Promise<BeginGoogleOidcSignInResult> {
  getPrivateConfiguration(configuration);
  const state = encodeBase64Url(randomBytes(32));
  const nonce = encodeBase64Url(randomBytes(32));
  const codeVerifier = encodeBase64Url(randomBytes(64));
  const codeChallenge = encodeBase64Url(await sha256Bytes(codeVerifier));
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + TRANSIENT_COOKIE_LIFETIME_SECONDS;
  const transientState: TransientOidcState = {
    version: TRANSIENT_STATE_VERSION,
    state,
    nonce,
    codeVerifier,
    installationId: validateInstallationId(input.installationId),
    issuedAt,
    expiresAt,
  };
  const encryptedCookie = await encryptTransientState(
    configuration,
    transientState,
  );

  const authorizationUrl = new URL(configuration.authorizationEndpoint);
  authorizationUrl.searchParams.set('client_id', configuration.clientId);
  authorizationUrl.searchParams.set('redirect_uri', configuration.redirectUri);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', 'openid email profile');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('nonce', nonce);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('hd', PSD_HOSTED_DOMAIN);

  return Object.freeze({
    authorizationUrl: authorizationUrl.toString(),
    setCookieHeader: serializeTransientCookie(configuration, encryptedCookie),
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  });
}

function callbackError(options: {
  readonly configuration: GoogleOidcConfiguration;
  readonly code: GoogleOidcCallbackErrorCode;
  readonly stateVerified?: boolean;
  readonly responseDigest?: string | null;
}): never {
  throw new GoogleOidcCallbackError({
    code: options.code,
    clearCookieHeader: serializeClearedTransientCookie(options.configuration),
    stateVerified: options.stateVerified ?? false,
    responseDigest: options.responseDigest ?? null,
  });
}

function parseCallbackUrl(
  configuration: GoogleOidcConfiguration,
  callbackUrl: string | URL,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl.toString());
  } catch {
    return callbackError({
      configuration,
      code: 'OIDC_CALLBACK_INVALID',
    });
  }
  const configuredRedirect = new URL(configuration.redirectUri);
  if (
    parsed.protocol !== configuredRedirect.protocol ||
    parsed.host !== configuredRedirect.host ||
    parsed.pathname !== configuredRedirect.pathname ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    return callbackError({
      configuration,
      code: 'OIDC_CALLBACK_INVALID',
    });
  }
  return parsed;
}

function singleQueryValue(
  searchParams: URLSearchParams,
  name: string,
  maximumLength: number,
): string | null | undefined {
  const values = searchParams.getAll(name);
  if (values.length === 0) {
    return undefined;
  }
  if (
    values.length !== 1 ||
    (values[0]?.length ?? 0) === 0 ||
    (values[0]?.length ?? 0) > maximumLength ||
    /[\r\n\0]/u.test(values[0] ?? '')
  ) {
    return null;
  }
  return values[0];
}

async function callbackResponseDigest(callbackUrl: URL): Promise<string> {
  return sha256Hex(callbackUrl.search);
}

async function exchangeAuthorizationCode(
  configuration: GoogleOidcConfiguration,
  code: string,
  codeVerifier: string,
  responseDigest: string,
): Promise<string> {
  const privateConfiguration = getPrivateConfiguration(configuration);
  const requestBody = new URLSearchParams({
    client_id: configuration.clientId,
    client_secret: privateConfiguration.clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: configuration.redirectUri,
  });
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    configuration.httpTimeoutMilliseconds,
  );

  let response: Response;
  let responseText: string;
  try {
    response = await fetch(configuration.tokenEndpoint, {
      method: 'POST',
      body: requestBody,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: abortController.signal,
    });
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      /^\d+$/u.test(declaredLength) &&
      Number(declaredLength) > MAX_TOKEN_RESPONSE_LENGTH
    ) {
      return callbackError({
        configuration,
        code: 'OIDC_TOKEN_RESPONSE_INVALID',
        stateVerified: true,
        responseDigest,
      });
    }
    responseText = await response.text();
  } catch (error) {
    if (error instanceof GoogleOidcCallbackError) {
      throw error;
    }
    return callbackError({
      configuration,
      code: 'OIDC_PROVIDER_UNAVAILABLE',
      stateVerified: true,
      responseDigest,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return callbackError({
      configuration,
      code: 'OIDC_TOKEN_EXCHANGE_FAILED',
      stateVerified: true,
      responseDigest,
    });
  }
  const responseContentType = response.headers
    .get('content-type')
    ?.toLowerCase();
  if (
    responseText.length === 0 ||
    responseText.length > MAX_TOKEN_RESPONSE_LENGTH ||
    responseContentType === undefined ||
    !/^application\/json(?:\s*;|$)/u.test(responseContentType)
  ) {
    return callbackError({
      configuration,
      code: 'OIDC_TOKEN_RESPONSE_INVALID',
      stateVerified: true,
      responseDigest,
    });
  }

  let tokenResponse: unknown;
  try {
    tokenResponse = JSON.parse(responseText) as unknown;
  } catch {
    return callbackError({
      configuration,
      code: 'OIDC_TOKEN_RESPONSE_INVALID',
      stateVerified: true,
      responseDigest,
    });
  }
  if (
    !isRecord(tokenResponse) ||
    typeof tokenResponse.id_token !== 'string' ||
    tokenResponse.id_token.length === 0 ||
    tokenResponse.id_token.length > MAX_ID_TOKEN_LENGTH
  ) {
    return callbackError({
      configuration,
      code: 'OIDC_TOKEN_RESPONSE_INVALID',
      stateVerified: true,
      responseDigest,
    });
  }
  return tokenResponse.id_token;
}

function remoteJwkSet(
  configuration: GoogleOidcConfiguration,
): ReturnType<typeof createRemoteJWKSet> {
  const existing = remoteJwkSets.get(configuration.jwksUri);
  if (existing !== undefined) {
    return existing;
  }
  const created = createRemoteJWKSet(new URL(configuration.jwksUri), {
    cacheMaxAge: 10 * 60 * 1_000,
    cooldownDuration: 30_000,
    timeoutDuration: configuration.httpTimeoutMilliseconds,
  });
  remoteJwkSets.set(configuration.jwksUri, created);
  return created;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function boundedClaimString(
  value: unknown,
  maximumLength: number,
): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    hasAsciiControlCharacter(value)
  ) {
    return null;
  }
  return value;
}

async function verifyIdToken(
  configuration: GoogleOidcConfiguration,
  idToken: string,
  expectedNonce: string,
  responseDigest: string,
): Promise<
  Readonly<{
    claims: CompleteOidcSignInInput['claims'];
    principal: PreSessionOidcPrincipal;
  }>
> {
  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    verified = await jwtVerify(idToken, remoteJwkSet(configuration), {
      algorithms: ['RS256'],
      audience: configuration.clientId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      issuer: GOOGLE_ISSUER,
      maxTokenAge: `${TRANSIENT_COOKIE_LIFETIME_SECONDS} seconds`,
      requiredClaims: [
        'iss',
        'sub',
        'aud',
        'exp',
        'iat',
        'nonce',
        'hd',
        'email',
        'email_verified',
      ],
    });
  } catch {
    return callbackError({
      configuration,
      code: 'OIDC_ID_TOKEN_INVALID',
      stateVerified: true,
      responseDigest,
    });
  }

  const { payload, protectedHeader } = verified;
  const subject = boundedClaimString(payload.sub, 255);
  const displayName = boundedClaimString(payload.name, 160);
  const rawEmail = boundedClaimString(payload.email, 320);
  const email = rawEmail?.toLowerCase() ?? null;
  if (
    protectedHeader.alg !== 'RS256' ||
    boundedClaimString(protectedHeader.kid, 255) === null ||
    (protectedHeader.typ !== undefined && protectedHeader.typ !== 'JWT') ||
    payload.iss !== GOOGLE_ISSUER ||
    payload.aud !== configuration.clientId ||
    subject === null ||
    payload.hd !== PSD_HOSTED_DOMAIN ||
    payload.email_verified !== true ||
    email === null ||
    !email.endsWith(`@${PSD_HOSTED_DOMAIN}`) ||
    displayName === null ||
    typeof payload.nonce !== 'string' ||
    !constantTimeEqual(payload.nonce, expectedNonce)
  ) {
    return callbackError({
      configuration,
      code: 'OIDC_ID_TOKEN_INVALID',
      stateVerified: true,
      responseDigest,
    });
  }

  const subjectDigest = await sha256Hex(subject);
  const claimsDigest = await sha256Hex(idToken);
  const claims: CompleteOidcSignInInput['claims'] = {
    issuer: GOOGLE_ISSUER,
    audience: configuration.clientId,
    subject,
    subjectDigest,
    claimsDigest,
    hostedDomain: PSD_HOSTED_DOMAIN,
    email,
    emailVerified: true,
    displayName,
  };
  const principal = PreSessionOidcPrincipalSchema.parse({
    kind: 'verified-oidc-claims',
    ...claims,
    audienceVerified: true,
  });
  return Object.freeze({ claims, principal });
}

/**
 * Completes a verified GET callback. A successful result proves Google
 * identity only; callers must still enforce the synced Group gate before any
 * user, role, facility scope, or session is established.
 */
export async function completeGoogleOidcCallback(
  configuration: GoogleOidcConfiguration,
  input: CompleteGoogleOidcCallbackInput,
): Promise<CompleteGoogleOidcCallbackResult> {
  getPrivateConfiguration(configuration);
  if (input.method.toUpperCase() !== 'GET') {
    return callbackError({
      configuration,
      code: 'OIDC_CALLBACK_INVALID',
    });
  }

  const callbackUrl = parseCallbackUrl(configuration, input.callbackUrl);
  const responseDigest = await callbackResponseDigest(callbackUrl);
  const state = singleQueryValue(callbackUrl.searchParams, 'state', 512);
  const code = singleQueryValue(callbackUrl.searchParams, 'code', 4_096);
  const providerError = singleQueryValue(
    callbackUrl.searchParams,
    'error',
    128,
  );
  if (state === null || code === null || providerError === null) {
    return callbackError({
      configuration,
      code: 'OIDC_CALLBACK_INVALID',
      responseDigest,
    });
  }
  if (code !== undefined && providerError !== undefined) {
    return callbackError({
      configuration,
      code: 'OIDC_CALLBACK_INVALID',
      responseDigest,
    });
  }

  const encryptedCookie = readCookieValue(
    input.cookieHeader,
    configuration.transientCookieName,
  );
  if (encryptedCookie === null) {
    return callbackError({
      configuration,
      code: 'OIDC_TRANSIENT_COOKIE_MISSING',
      responseDigest,
    });
  }
  const transientState = await decryptTransientState(
    configuration,
    encryptedCookie,
    Math.floor(Date.now() / 1_000),
  );
  if (transientState === null) {
    return callbackError({
      configuration,
      code: 'OIDC_TRANSIENT_COOKIE_INVALID',
      responseDigest,
    });
  }
  if (state === undefined || !constantTimeEqual(state, transientState.state)) {
    return callbackError({
      configuration,
      code: 'OIDC_STATE_MISMATCH',
      responseDigest,
    });
  }

  if (providerError !== undefined) {
    const errorCode =
      providerError === 'access_denied'
        ? 'OIDC_PROVIDER_DENIED'
        : providerError === 'login_required'
          ? 'OIDC_PROVIDER_LOGIN_REQUIRED'
          : 'OIDC_PROVIDER_REJECTED';
    return callbackError({
      configuration,
      code: errorCode,
      stateVerified: true,
      responseDigest,
    });
  }
  if (code === undefined) {
    return callbackError({
      configuration,
      code: 'OIDC_CALLBACK_INVALID',
      stateVerified: true,
      responseDigest,
    });
  }

  const idToken = await exchangeAuthorizationCode(
    configuration,
    code,
    transientState.codeVerifier,
    responseDigest,
  );
  const verified = await verifyIdToken(
    configuration,
    idToken,
    transientState.nonce,
    responseDigest,
  );
  const capabilityInput = CompleteOidcSignInInputSchema.parse({
    claims: verified.claims,
    device: {
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: transientState.installationId,
    },
  });
  const transport = OidcCallbackTransportSchema.parse({
    kind: 'oidc-code-callback',
    method: 'GET',
    stateVerified: true,
    nonceVerified: true,
    pkceVerified: true,
    signatureVerified: true,
  });

  return Object.freeze({
    capabilityInput,
    principal: verified.principal,
    transport,
    idempotencyKey: `oidc:${responseDigest}`,
    responseDigest,
    clearCookieHeader: serializeClearedTransientCookie(configuration),
  });
}

/** Builds the sole canonical pre-session capability envelope for a callback. */
export function createCompleteOidcSignInEnvelope(
  callback: CompleteGoogleOidcCallbackResult,
  context: CompleteOidcEnvelopeContext,
): AuthenticationCapabilityEnvelope {
  return AuthenticationCapabilityEnvelopeSchema.parse({
    capabilityId: 'complete-oidc-sign-in',
    operation: 'mutation',
    principal: callback.principal,
    source: 'web',
    requestId: context.requestId,
    serverTime: context.serverTime,
    input: callback.capabilityInput,
    idempotencyKey: callback.idempotencyKey,
    transport: callback.transport,
  });
}
