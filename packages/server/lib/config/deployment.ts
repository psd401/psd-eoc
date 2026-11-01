import { OrganizationNameSchema } from '@psd-eoc/contracts';
import { isIP } from 'node:net';

/**
 * The values that differ between one district's deployment and another's.
 *
 * This repository is meant to be cloned and run by any district, so nothing
 * that identifies the operating district — its domain, its AWS account, its
 * region, its bundle identifier, its public origin — belongs in source. Each of
 * those is read here, from the environment, once.
 *
 * Every reader fails closed. A deployment that has not been configured refuses
 * to start rather than falling back to somebody else's domain, which is the
 * failure mode a default would create.
 */

export type DeploymentEnvironment = Readonly<
  Record<string, string | undefined>
>;

export class DeploymentConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DeploymentConfigurationError';
  }
}

function required(environment: DeploymentEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new DeploymentConfigurationError(`${name} must be configured.`);
  }
  return value;
}

const HOSTED_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/**
 * The email domain a staff member must be in to appear on a roster.
 *
 * The same domain Google OIDC pins sign-in to, because they answer the same
 * question — is this person staff at this district — and configuring them
 * separately would let them disagree.
 */
export function staffHostedDomain(
  environment: DeploymentEnvironment = process.env,
): string {
  const domain = required(environment, 'GOOGLE_OIDC_HOSTED_DOMAIN')
    .toLowerCase()
    .replace(/^@/u, '');
  if (!HOSTED_DOMAIN_PATTERN.test(domain)) {
    throw new DeploymentConfigurationError(
      'GOOGLE_OIDC_HOSTED_DOMAIN must be a bare domain name.',
    );
  }
  return domain;
}

const ORIGIN_PATTERN = /^https:\/\/[^\s/?#]+$/u;

/** Human-readable name of the organization operating this deployment. */
export function organizationName(
  environment: DeploymentEnvironment = process.env,
): string {
  const result = OrganizationNameSchema.safeParse(
    environment.PSD_EOC_ORGANIZATION_NAME,
  );
  if (!result.success) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_ORGANIZATION_NAME must be a printable name of at most 160 characters.',
    );
  }
  return result.data;
}

/** Public, non-secret channel for privacy questions and data requests. */
export function privacyContactUrl(
  environment: DeploymentEnvironment = process.env,
): string {
  const value = required(environment, 'PSD_EOC_PRIVACY_CONTACT_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DeploymentConfigurationError(
      'PSD_EOC_PRIVACY_CONTACT_URL must be a public HTTPS URL.',
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    !HOSTED_DOMAIN_PATTERN.test(hostname) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_PRIVACY_CONTACT_URL must be a public HTTPS URL without credentials, query, or fragment.',
    );
  }
  return parsed.href;
}

/**
 * Customer-care email named in the SMS consent disclosure.
 *
 * A carrier reviewing a messaging program requires a reachable contact, and it
 * appears in the text a staff member agrees to, so it is deployment
 * configuration rather than an application literal.
 */
export function smsSupportEmail(
  environment: DeploymentEnvironment = process.env,
): string {
  const value = required(environment, 'PSD_EOC_SMS_SUPPORT_EMAIL');
  if (!/^[^\s@]+@[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u.test(value)) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_SMS_SUPPORT_EMAIL must be a support mailbox address.',
    );
  }
  return value;
}

/** Customer-care phone in E.164, named in the SMS consent disclosure. */
export function smsSupportPhone(
  environment: DeploymentEnvironment = process.env,
): string {
  const value = required(environment, 'PSD_EOC_SMS_SUPPORT_PHONE');
  if (!/^\+[1-9]\d{7,14}$/u.test(value)) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_SMS_SUPPORT_PHONE must be an E.164 telephone number.',
    );
  }
  return value;
}

/** IANA time zone used for stable server- and client-rendered timestamps. */
export function displayTimeZone(
  environment: DeploymentEnvironment = process.env,
): string {
  const timeZone = required(environment, 'PSD_EOC_DISPLAY_TIME_ZONE');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw new DeploymentConfigurationError(
      'PSD_EOC_DISPLAY_TIME_ZONE must be a valid IANA time zone.',
    );
  }
  return timeZone;
}

/**
 * The browser-visible origin this deployment serves, used wherever a redirect
 * must not trust a proxy header.
 */
export function applicationOrigin(
  environment: DeploymentEnvironment = process.env,
): string {
  const origin = required(environment, 'GOOGLE_OIDC_APPLICATION_ORIGIN');
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new DeploymentConfigurationError(
      'GOOGLE_OIDC_APPLICATION_ORIGIN must be an https origin with no path.',
    );
  }
  return origin;
}

const BUNDLE_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/u;

/**
 * The iOS application identifier this deployment ships, checked against the
 * iOS OAuth client so a configuration mix-up is caught at startup rather than
 * at somebody's first sign-in attempt.
 */
export function iosBundleId(
  environment: DeploymentEnvironment = process.env,
): string {
  const bundleId = required(environment, 'PSD_EOC_IOS_BUNDLE_ID');
  if (bundleId.length > 155 || !BUNDLE_ID_PATTERN.test(bundleId)) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_IOS_BUNDLE_ID must be a reverse-DNS application identifier.',
    );
  }
  return bundleId;
}

/**
 * The store identities the mobile app association files are built from.
 *
 * Apple and Google each decide whether an app may use this deployment's
 * hostname as a passkey relying party by fetching a document from that
 * hostname and matching it against the installed app: Apple against the team
 * identifier and bundle identifier the app was signed with, Google against the
 * certificate the Play Store signed it with. Both are public values, and both
 * identify one district's apps, so they are tenant configuration rather than
 * application literals (issue #647).
 *
 * Each reader answers null when its value is absent, because a deployment
 * with no store build is a legitimate deployment: the association documents
 * are then not served at all, native passkeys are unavailable, and the
 * emailed code — which needs none of this — is unaffected. A malformed value
 * is still an error, since the failure it would otherwise produce is a
 * document Apple or Google silently refuses.
 */

const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

function optional(
  environment: DeploymentEnvironment,
  name: string,
): string | null {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/** The Apple Developer team identifier that signs this district's iOS app. */
export function appleAppTeamId(
  environment: DeploymentEnvironment = process.env,
): string | null {
  const teamId = optional(environment, 'PSD_EOC_APPLE_APP_TEAM_ID');
  if (teamId === null) {
    return null;
  }
  if (!APPLE_TEAM_ID_PATTERN.test(teamId)) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_APPLE_APP_TEAM_ID must be a ten-character Apple team identifier.',
    );
  }
  return teamId;
}

/** The Android application id this district ships, as Play holds it. */
export function androidApplicationId(
  environment: DeploymentEnvironment = process.env,
): string | null {
  const applicationId = optional(environment, 'PSD_EOC_ANDROID_APPLICATION_ID');
  if (applicationId === null) {
    return null;
  }
  if (
    applicationId.length > 255 ||
    !BUNDLE_ID_PATTERN.test(applicationId) ||
    applicationId !== applicationId.toLowerCase()
  ) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_ANDROID_APPLICATION_ID must be a lower-case reverse-DNS application id.',
    );
  }
  return applicationId;
}

const SHA256_FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u;
/** More than one accommodates a signing-key rotation, and nothing beyond. */
const MAX_SIGNING_FINGERPRINTS = 4;

/**
 * The SHA-256 fingerprints of the certificates Play signs this app with.
 *
 * A list rather than one value because an app-signing key rotation has two
 * live certificates at once, and a document naming only one of them locks out
 * every device holding the other.
 */
export function androidSigningFingerprints(
  environment: DeploymentEnvironment = process.env,
): readonly string[] {
  const configured = optional(
    environment,
    'PSD_EOC_ANDROID_SIGNING_FINGERPRINTS',
  );
  if (configured === null) {
    return Object.freeze([]);
  }
  const fingerprints = configured
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  if (
    fingerprints.length === 0 ||
    fingerprints.length > MAX_SIGNING_FINGERPRINTS ||
    new Set(fingerprints).size !== fingerprints.length ||
    fingerprints.some(
      (fingerprint) => !SHA256_FINGERPRINT_PATTERN.test(fingerprint),
    )
  ) {
    throw new DeploymentConfigurationError(
      'PSD_EOC_ANDROID_SIGNING_FINGERPRINTS must be up to four distinct colon-separated SHA-256 certificate fingerprints.',
    );
  }
  return Object.freeze(fingerprints);
}
