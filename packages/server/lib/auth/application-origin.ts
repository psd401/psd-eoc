import { applicationOrigin } from '../config/deployment';

export type ApplicationOriginEnvironment = Readonly<
  Record<string, string | undefined>
>;

/**
 * Resolves the browser-visible application origin without trusting proxy
 * headers. Production uses the configured public origin, the same one OIDC
 * redirects to; local development and tests retain their request origin.
 */
export function applicationOriginForRequest(
  requestUrl: string | URL,
  environment: ApplicationOriginEnvironment = process.env,
): string {
  return environment.NODE_ENV === 'production'
    ? applicationOrigin(environment)
    : new URL(requestUrl).origin;
}

/** Resolves a relative application destination and rejects external URLs. */
export function applicationUrlForRequest(
  requestUrl: string | URL,
  destination: string,
  environment: ApplicationOriginEnvironment = process.env,
): URL {
  const origin = applicationOriginForRequest(requestUrl, environment);
  const resolved = new URL(destination, `${origin}/`);
  if (resolved.origin !== origin) {
    throw new TypeError('Application redirects must remain same-origin.');
  }
  return resolved;
}
