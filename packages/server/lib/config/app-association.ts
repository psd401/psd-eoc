import {
  androidApplicationId,
  androidSigningFingerprints,
  appleAppTeamId,
  iosBundleId,
  type DeploymentEnvironment,
} from './deployment';

/**
 * The two documents that let this district's own app use this deployment's
 * hostname as a passkey relying party.
 *
 * A passkey is bound to a hostname, and a native app is not a page on that
 * hostname, so each platform resolves the question the same way: it fetches a
 * document from the hostname and checks that the document names the app in
 * front of it. Apple reads `/.well-known/apple-app-site-association` and
 * matches `webcredentials` against the team and bundle identifier the app was
 * signed with; Google reads `/.well-known/assetlinks.json` and matches
 * `delegate_permission/common.get_login_creds` against the certificate Play
 * signed it with.
 *
 * Both are built here from tenant configuration, from the same
 * `psdEoc:applicationOrigin` the relying-party id itself is derived from, so
 * the pool's WebAuthn configuration, the web ceremony's origin, and these two
 * documents cannot name different hostnames. A deployment that has not
 * configured its store identities serves neither document: `null` is the
 * answer for an unconfigured deployment, the routes then answer the way they
 * would for any path they do not serve, native passkeys are simply
 * unavailable, and the emailed code is untouched.
 *
 * Neither document grants access. They state which app may ask this hostname
 * for a credential; `authorizePartnerSignIn` still decides who gets in.
 *
 * Issue #647.
 */

/** Apple's `webcredentials` service, and only that service. */
export interface AppleAppSiteAssociation {
  readonly webcredentials: Readonly<{ apps: readonly string[] }>;
}

/**
 * One Digital Asset Links statement, carrying the login-credentials relation
 * and nothing else. `delegate_permission/common.handle_all_urls` would make
 * this app the handler for every link on the district's domain, which is a
 * different decision from passkeys and is not taken here.
 */
export interface AndroidAssetLinkStatement {
  readonly relation: readonly string[];
  readonly target: Readonly<{
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: readonly string[];
  }>;
}

export const ANDROID_LOGIN_CREDENTIALS_RELATION =
  'delegate_permission/common.get_login_creds';

/**
 * Apple's association document, or null when this deployment ships no signed
 * iOS app it can name.
 */
export function appleAppSiteAssociation(
  environment: DeploymentEnvironment = process.env,
): AppleAppSiteAssociation | null {
  const teamId = appleAppTeamId(environment);
  if (teamId === null) {
    return null;
  }
  return Object.freeze({
    webcredentials: Object.freeze({
      apps: Object.freeze([`${teamId}.${iosBundleId(environment)}`]),
    }),
  });
}

/**
 * Google's association document, or null when this deployment ships no Play
 * app it can name. Both the application id and at least one signing
 * fingerprint are required: a statement missing either names no app.
 */
export function androidAssetLinks(
  environment: DeploymentEnvironment = process.env,
): readonly AndroidAssetLinkStatement[] | null {
  const packageName = androidApplicationId(environment);
  const fingerprints = androidSigningFingerprints(environment);
  if (packageName === null || fingerprints.length === 0) {
    return null;
  }
  return Object.freeze([
    Object.freeze({
      relation: Object.freeze([ANDROID_LOGIN_CREDENTIALS_RELATION]),
      target: Object.freeze({
        namespace: 'android_app' as const,
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      }),
    }),
  ]);
}
