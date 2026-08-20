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
