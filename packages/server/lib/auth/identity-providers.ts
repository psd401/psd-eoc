import {
  GOOGLE_IDENTITY_ISSUER,
  isPartnerIssuer,
  PartnerIdentityIssuerSchema,
} from '@psd-eoc/contracts';

/**
 * The registry of identity providers this deployment trusts.
 *
 * Two issuers sign people in, and each one has exactly one sign-in path:
 * district Google for staff, and one Amazon Cognito user pool for partner
 * (first-responder) accounts. Every verifier resolves the issuer here first
 * and then asserts the kind it is willing to accept, so a Cognito token can
 * never complete the Google callback and a Google token can never complete
 * partner sign-in. Nothing else is trusted: an issuer this module does not
 * recognize has no path at all.
 *
 * Partner access is configuration. When the pool parameters read
 * `UNCONFIGURED` — the state every deployment starts in — the registry holds
 * Google alone and partner sign-in does not exist on that deployment.
 */

const UNCONFIGURED = 'UNCONFIGURED';

/** The synthetic partner pool used by browser tests and local development. */
export const SYNTHETIC_PARTNER_USER_POOL_ID = 'SYNTHETIC';

/**
 * The synthetic partner issuer. `.invalid` is reserved by RFC 2606 and
 * resolves nowhere, so a synthetic run that tried to reach a real pool would
 * fail rather than succeed quietly against someone else's directory.
 */
export const SYNTHETIC_PARTNER_ISSUER =
  'https://cognito-idp.example.invalid/synthetic-partner-pool';

export type Environment = Readonly<Record<string, string | undefined>>;

/** One partner user pool, as the server addresses it. */
export interface PartnerPoolConfiguration {
  /** `SYNTHETIC` selects the stand-in provider; never a deployed value. */
  readonly userPoolId: string;
  readonly clientId: string;
  /** The ARN of the app-client credential, read at sign-in time. */
  readonly clientSecretArn: string | null;
  readonly issuer: string;
  readonly jwksUri: string;
  readonly synthetic: boolean;
}

export type TrustedIdentityProvider =
  | Readonly<{ kind: 'google'; issuer: typeof GOOGLE_IDENTITY_ISSUER }>
  | Readonly<{ kind: 'partner'; configuration: PartnerPoolConfiguration }>;

/** A configuration problem a deployment owner can act on; never a secret. */
export class PartnerPoolConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PartnerPoolConfigurationError';
  }
}

function boundedValue(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 || trimmed === UNCONFIGURED ? null : trimmed;
}

/**
 * The partner pool this deployment is configured for, or null when partner
 * access is off. A pool id without its app-client id is a half-configured
 * deployment, which is a configuration error rather than a silent fallback to
 * staff-only: the stack's own parameter rule already refuses the pair, so
 * reaching this is a deployment that bypassed it.
 */
export function readPartnerPoolConfiguration(
  environment: Environment = process.env,
): PartnerPoolConfiguration | null {
  const userPoolId = boundedValue(environment.PSD_EOC_PARTNER_USER_POOL_ID);
  if (userPoolId === null) {
    return null;
  }
  const clientId = boundedValue(
    environment.PSD_EOC_PARTNER_USER_POOL_CLIENT_ID,
  );
  const clientSecretArn = boundedValue(
    environment.PSD_EOC_PARTNER_USER_POOL_CLIENT_SECRET_ARN,
  );
  if (userPoolId === SYNTHETIC_PARTNER_USER_POOL_ID) {
    return Object.freeze({
      userPoolId,
      clientId: clientId ?? SYNTHETIC_PARTNER_USER_POOL_ID,
      clientSecretArn: null,
      issuer: SYNTHETIC_PARTNER_ISSUER,
      jwksUri: `${SYNTHETIC_PARTNER_ISSUER}/.well-known/jwks.json`,
      synthetic: true,
    });
  }
  if (clientId === null) {
    throw new PartnerPoolConfigurationError(
      'PSD_EOC_PARTNER_USER_POOL_CLIENT_ID is required with a partner user pool.',
    );
  }
  // A Cognito pool id is `<region>_<suffix>`, and its issuer is derived from
  // the pool id alone. Deriving rather than configuring the issuer means the
  // token verifier and the directory client can never name different pools.
  const region = userPoolId.split('_', 1)[0] ?? '';
  if (!/^[a-z0-9-]{1,40}$/u.test(region) || region === userPoolId) {
    throw new PartnerPoolConfigurationError(
      'PSD_EOC_PARTNER_USER_POOL_ID must be a region-prefixed Cognito pool id.',
    );
  }
  const issuer = PartnerIdentityIssuerSchema.safeParse(
    `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
  );
  if (!issuer.success) {
    throw new PartnerPoolConfigurationError(
      'PSD_EOC_PARTNER_USER_POOL_ID does not name an addressable Cognito pool.',
    );
  }
  return Object.freeze({
    userPoolId,
    clientId,
    clientSecretArn,
    issuer: issuer.data,
    jwksUri: `${issuer.data}/.well-known/jwks.json`,
    synthetic: false,
  });
}

/** True when this deployment has a partner sign-in path at all. */
export function partnerSignInConfigured(
  environment: Environment = process.env,
): boolean {
  try {
    return readPartnerPoolConfiguration(environment) !== null;
  } catch {
    // A half-configured deployment has no usable partner path either. The
    // sign-in routes surface the configuration error; the sign-in page only
    // needs to know not to offer the option.
    return false;
  }
}

/**
 * The provider that signs the given issuer's identities in, or null when this
 * deployment trusts no such issuer. This is the only place an issuer becomes
 * a sign-in path.
 */
export function resolveTrustedIdentityProvider(
  issuer: string,
  environment: Environment = process.env,
): TrustedIdentityProvider | null {
  if (issuer === GOOGLE_IDENTITY_ISSUER) {
    return Object.freeze({
      kind: 'google' as const,
      issuer: GOOGLE_IDENTITY_ISSUER,
    });
  }
  if (!isPartnerIssuer(issuer)) {
    return null;
  }
  let configuration: PartnerPoolConfiguration | null;
  try {
    configuration = readPartnerPoolConfiguration(environment);
  } catch {
    return null;
  }
  return configuration === null || configuration.issuer !== issuer
    ? null
    : Object.freeze({ kind: 'partner' as const, configuration });
}

/** True when the issuer is the district staff provider on this deployment. */
export function isTrustedStaffIssuer(
  issuer: string,
  environment: Environment = process.env,
): boolean {
  return resolveTrustedIdentityProvider(issuer, environment)?.kind === 'google';
}
