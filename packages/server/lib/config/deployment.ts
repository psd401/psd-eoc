import { OrganizationNameSchema } from '@psd-eoc/contracts';
import { isIP } from 'node:net';

/**
 * The values that differ between one district's deployment and another's.
 *
 * This repository is meant to be cloned and run by any district, so nothing
 * that identifies Peninsula School District — its domain, its AWS account, its
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
