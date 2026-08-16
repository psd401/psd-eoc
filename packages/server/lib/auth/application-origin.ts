export const PRODUCTION_APPLICATION_ORIGIN = 'https://eoc.psd401.net' as const;

export type ApplicationOriginEnvironment = Readonly<
  Record<string, string | undefined>
>;

/**
 * Resolves the browser-visible application origin without trusting proxy
 * headers. Production is pinned to the same fixed public origin as OIDC;
 * local development and tests retain their request origin.
 */
export function applicationOriginForRequest(
  requestUrl: string | URL,
  environment: ApplicationOriginEnvironment = process.env,
): string {
  return environment.NODE_ENV === 'production'
    ? PRODUCTION_APPLICATION_ORIGIN
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
