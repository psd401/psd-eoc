import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import {
  readPartnerPoolConfiguration,
  type Environment,
  type PartnerPoolConfiguration,
} from './identity-providers';

/**
 * Partner email one-time-password sign-in, at the dependency boundary.
 *
 * The partner pool has no hosted UI and no browser-facing client: the server
 * asks the pool for a code with its confidential client credential, the
 * partner types the code back, and the pool answers with a signed identity
 * token. Nothing in a browser ever talks to Cognito, so there is no redirect,
 * no PKCE, and no provider callback to secure.
 *
 * Every failure collapses into one refusal. A partner address that is not
 * enrolled, a wrong code, an expired flow, and a provider outage must be
 * indistinguishable to the person typing, or the form becomes a way to ask
 * whether an address has an account.
 */

const MAX_ID_TOKEN_LENGTH = 24 * 1_024;
const CLOCK_TOLERANCE_SECONDS = 60;
const OTP_CODE_PATTERN = /^[0-9]{6,8}$/u;
const SYNTHETIC_FLOW_PREFIX = 'synthetic-partner-otp:';

export type PartnerOtpErrorCode =
  | 'PARTNER_SIGN_IN_UNCONFIGURED'
  | 'PARTNER_SIGN_IN_REFUSED'
  | 'PARTNER_PROVIDER_UNAVAILABLE';

/** A refusal that never carries an address, a code, or a provider payload. */
export class PartnerOtpError extends Error {
  public constructor(
    public readonly code: PartnerOtpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PartnerOtpError';
  }
}

/** The provider's own verified identity claims. Never a raw token. */
export interface PartnerVerifiedClaims {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly email: string;
  /** Digest of the exact identity token these claims were read from. */
  readonly claimsDigest: string;
}

/** The provider's opaque continuation between the two steps of one sign-in. */
export interface PartnerOtpChallenge {
  readonly flowSession: string;
}

export interface PartnerOtpProvider {
  readonly issuer: string;
  readonly audience: string;
  /** Asks the pool to email one code; never reveals whether it did. */
  start(email: string): Promise<PartnerOtpChallenge>;
  /** Answers one challenge and returns the pool's verified claims. */
  verify(
    input: Readonly<{ email: string; flowSession: string; code: string }>,
  ): Promise<PartnerVerifiedClaims>;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function refused(): never {
  throw new PartnerOtpError(
    'PARTNER_SIGN_IN_REFUSED',
    'The partner sign-in details were not accepted.',
  );
}

/**
 * The code the synthetic provider accepts for one address: derived, not
 * fixed, so a browser test computes it the way a partner reads an email and
 * no single constant works against every synthetic address.
 */
export function syntheticPartnerOtpCode(email: string): string {
  const digest = createHash('sha256')
    .update(`synthetic-partner-otp\n${email.trim().toLowerCase()}`, 'utf8')
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** The subject the synthetic directory derives for one partner address. */
export function syntheticPartnerSubject(email: string): string {
  return `synthetic-${sha256Hex(email.trim().toLowerCase()).slice(0, 32)}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies one partner identity token against its pool's published keys.
 *
 * The pool's issuer and the app client's id are both pinned, `token_use` must
 * be `id` so an access token cannot stand in for an identity, and the token
 * must still be inside its own expiry. The pool is named by the configuration
 * passed in, which the registry derived from the pool id, so this cannot be
 * pointed at another directory.
 */
export async function verifyPartnerIdToken(
  configuration: PartnerPoolConfiguration,
  idToken: string,
  dependencies: Readonly<{
    keys?: Parameters<typeof jwtVerify>[1];
  }> = {},
): Promise<PartnerVerifiedClaims> {
  if (
    typeof idToken !== 'string' ||
    idToken.length === 0 ||
    idToken.length > MAX_ID_TOKEN_LENGTH
  ) {
    refused();
  }
  let payload: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    payload = await jwtVerify(
      idToken,
      dependencies.keys ?? partnerJwkSet(configuration),
      {
        algorithms: ['RS256'],
        audience: configuration.clientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        issuer: configuration.issuer,
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'token_use'],
      },
    );
  } catch {
    refused();
  }
  const claims = payload.payload;
  const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  const email =
    typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (
    payload.protectedHeader.alg !== 'RS256' ||
    claims.iss !== configuration.issuer ||
    claims.aud !== configuration.clientId ||
    claims.token_use !== 'id' ||
    subject.length === 0 ||
    subject.length > 255 ||
    email.length === 0 ||
    email.length > 320 ||
    !email.includes('@')
  ) {
    refused();
  }
  return Object.freeze({
    issuer: configuration.issuer,
    audience: configuration.clientId,
    subject,
    email,
    claimsDigest: sha256Hex(idToken),
  });
}

const partnerJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const cognitoPartnerOtpProviders = new Map<string, PartnerOtpProvider>();

function partnerJwkSet(
  configuration: PartnerPoolConfiguration,
): ReturnType<typeof createRemoteJWKSet> {
  const existing = partnerJwkSets.get(configuration.jwksUri);
  if (existing !== undefined) {
    return existing;
  }
  const created = createRemoteJWKSet(new URL(configuration.jwksUri), {
    cacheMaxAge: 10 * 60 * 1_000,
    cooldownDuration: 30_000,
    timeoutDuration: 10_000,
  });
  partnerJwkSets.set(configuration.jwksUri, created);
  return created;
}

/** Reads the app-client credential by complete ARN, once per process. */
function createClientSecretReader(
  clientSecretArn: string,
  client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({
    maxAttempts: 1,
  }),
): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    cached ??= (async () => {
      let value: string | undefined;
      try {
        const response = await client.send(
          new GetSecretValueCommand({ SecretId: clientSecretArn }),
        );
        value = response.SecretString;
      } catch {
        throw new PartnerOtpError(
          'PARTNER_PROVIDER_UNAVAILABLE',
          'The partner app-client credential could not be read.',
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value ?? '') as unknown;
      } catch {
        throw new PartnerOtpError(
          'PARTNER_SIGN_IN_UNCONFIGURED',
          'The partner app-client credential is not the expected document.',
        );
      }
      const secret =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as Readonly<Record<string, unknown>>).clientSecret
          : undefined;
      if (
        typeof secret !== 'string' ||
        secret.trim().length === 0 ||
        secret.length > 2_048
      ) {
        throw new PartnerOtpError(
          'PARTNER_SIGN_IN_UNCONFIGURED',
          'The partner app-client credential has no usable client secret.',
        );
      }
      return secret;
    })();
    // A failed read must not be cached: the next sign-in should retry rather
    // than stay broken until the instance is replaced.
    return cached.catch((error: unknown) => {
      cached = null;
      throw error;
    });
  };
}

function secretHash(
  clientSecret: string,
  email: string,
  clientId: string,
): string {
  return createHmac('sha256', clientSecret)
    .update(`${email}${clientId}`, 'utf8')
    .digest('base64');
}

/** Cognito, at the dependency boundary. SDK retries stay off; a retry is ours. */
export class CognitoPartnerOtpProvider implements PartnerOtpProvider {
  public readonly issuer: string;
  public readonly audience: string;
  private readonly readClientSecret: () => Promise<string>;

  public constructor(
    private readonly configuration: PartnerPoolConfiguration,
    private readonly client: Pick<
      CognitoIdentityProviderClient,
      'send'
    > = new CognitoIdentityProviderClient({ maxAttempts: 1 }),
    readClientSecret?: () => Promise<string>,
  ) {
    if (configuration.clientSecretArn === null) {
      throw new PartnerOtpError(
        'PARTNER_SIGN_IN_UNCONFIGURED',
        'The partner app client has no credential ARN.',
      );
    }
    this.issuer = configuration.issuer;
    this.audience = configuration.clientId;
    this.readClientSecret =
      readClientSecret ??
      createClientSecretReader(configuration.clientSecretArn);
  }

  public async start(email: string): Promise<PartnerOtpChallenge> {
    const clientSecret = await this.readClientSecret();
    let session: string | undefined;
    let challenge: string | undefined;
    try {
      const response = await this.client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.configuration.userPoolId,
          ClientId: this.configuration.clientId,
          // The choice-based flow. The pool's own sign-in policy allows only
          // email one-time passwords and passkeys, so naming the preferred
          // challenge here asks for the one a browser can complete today.
          AuthFlow: 'USER_AUTH',
          AuthParameters: {
            USERNAME: email,
            PREFERRED_CHALLENGE: 'EMAIL_OTP',
            SECRET_HASH: secretHash(
              clientSecret,
              email,
              this.configuration.clientId,
            ),
          },
        }),
      );
      session = response.Session;
      challenge = response.ChallengeName;
    } catch {
      throw new PartnerOtpError(
        'PARTNER_PROVIDER_UNAVAILABLE',
        'The partner identity provider did not answer.',
      );
    }
    // The pool answers an unenrolled address with a challenge too (its
    // user-existence errors are off), so this branch is a provider or policy
    // problem, not a statement about the address.
    if (challenge !== 'EMAIL_OTP' || session === undefined) {
      throw new PartnerOtpError(
        'PARTNER_PROVIDER_UNAVAILABLE',
        'The partner identity provider offered no email code.',
      );
    }
    return Object.freeze({ flowSession: session });
  }

  public async verify(
    input: Readonly<{ email: string; flowSession: string; code: string }>,
  ): Promise<PartnerVerifiedClaims> {
    if (!OTP_CODE_PATTERN.test(input.code)) {
      refused();
    }
    const clientSecret = await this.readClientSecret();
    let idToken: string | undefined;
    try {
      const response = await this.client.send(
        new AdminRespondToAuthChallengeCommand({
          UserPoolId: this.configuration.userPoolId,
          ClientId: this.configuration.clientId,
          ChallengeName: 'EMAIL_OTP',
          Session: input.flowSession,
          ChallengeResponses: {
            USERNAME: input.email,
            EMAIL_OTP_CODE: input.code,
            SECRET_HASH: secretHash(
              clientSecret,
              input.email,
              this.configuration.clientId,
            ),
          },
        }),
      );
      idToken = response.AuthenticationResult?.IdToken;
    } catch {
      // A wrong code, an expired flow, and a disabled account all land here
      // and are all one refusal.
      refused();
    }
    if (idToken === undefined) {
      refused();
    }
    const claims = await verifyPartnerIdToken(this.configuration, idToken);
    if (claims.email !== input.email) {
      refused();
    }
    return claims;
  }
}

/**
 * The stand-in for browser tests and local development: no pool is contacted
 * and no mail is sent. The code is derived from the address, and the subject
 * is the one the synthetic directory hands the invite path, so an invited
 * synthetic partner signs in as the same person.
 */
export function syntheticPartnerOtpProvider(
  configuration: PartnerPoolConfiguration,
): PartnerOtpProvider {
  return Object.freeze({
    issuer: configuration.issuer,
    audience: configuration.clientId,
    start: (email: string) =>
      Promise.resolve(
        Object.freeze({
          flowSession: `${SYNTHETIC_FLOW_PREFIX}${sha256Hex(email)}`,
        }),
      ),
    // Async so a refusal is a rejection, exactly as the Cognito provider's
    // is: the interface promises a Promise, and a caller must not have to
    // guard a synchronous throw from one implementation only.
    verify: async (
      input: Readonly<{ email: string; flowSession: string; code: string }>,
    ) => {
      if (
        input.flowSession !==
          `${SYNTHETIC_FLOW_PREFIX}${sha256Hex(input.email)}` ||
        !OTP_CODE_PATTERN.test(input.code) ||
        !constantTimeEqual(input.code, syntheticPartnerOtpCode(input.email))
      ) {
        refused();
      }
      return Object.freeze({
        issuer: configuration.issuer,
        audience: configuration.clientId,
        subject: syntheticPartnerSubject(input.email),
        email: input.email,
        claimsDigest: sha256Hex(
          `${SYNTHETIC_FLOW_PREFIX}${input.email}\n${input.flowSession}`,
        ),
      });
    },
  });
}

/**
 * The partner one-time-password provider this deployment is configured for.
 *
 * Null means this deployment has no partner sign-in path, which is the state
 * a deployment without the pool parameters is in. Callers answer a null with
 * the same page a staff member sees, never with an error that says partner
 * access exists somewhere.
 */
export function resolvePartnerOtpProvider(
  environment: Environment = process.env,
): PartnerOtpProvider | null {
  const configuration = readPartnerPoolConfiguration(environment);
  if (configuration === null) {
    return null;
  }
  if (configuration.synthetic) {
    return syntheticPartnerOtpProvider(configuration);
  }
  // One provider per configuration, so its credential reader keeps the
  // app-client secret for the life of the process.
  const key = JSON.stringify(configuration);
  const existing = cognitoPartnerOtpProviders.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = new CognitoPartnerOtpProvider(configuration);
  cognitoPartnerOtpProviders.set(key, created);
  return created;
}
