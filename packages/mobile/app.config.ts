import {
  AndroidConfig,
  withAndroidManifest,
  withStringsXml,
} from 'expo/config-plugins';
import type { ConfigContext, ExpoConfig } from 'expo/config';

type AppConfigEnvironment = Readonly<Record<string, string | undefined>>;

const PUSH_REGISTRATION_ENV = 'EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED';
const API_BASE_URL_ENV = 'EXPO_PUBLIC_PSD_EOC_API_BASE_URL';

export function withPushProviderConfig(
  config: ConfigContext['config'],
  environment: AppConfigEnvironment = process.env,
): ConfigContext['config'] {
  if (environment[PUSH_REGISTRATION_ENV] !== 'true') return config;

  const googleServicesFile = environment.GOOGLE_SERVICES_JSON?.trim();
  if (!googleServicesFile) {
    // Secret EAS variables are unavailable while the CLI evaluates config on
    // the operator's machine. Enforce the credential only where EAS exposes
    // it and Android will consume it, without coupling the iOS build to FCM.
    if (
      environment.EAS_BUILD === 'true' &&
      environment.EAS_BUILD_PLATFORM === 'android'
    ) {
      throw new Error(
        'GOOGLE_SERVICES_JSON must be a protected EAS file variable for the push-enabled Android build.',
      );
    }
    return config;
  }

  return {
    ...config,
    android: {
      ...config.android,
      googleServicesFile,
    },
  };
}

/**
 * The hostname a partner's passkey is bound to.
 *
 * It is the host of the deployment this build talks to, which is already
 * configured — the server derives the relying-party id from the same origin,
 * and the association documents are served from it. Reading it here rather
 * than configuring a second copy is what keeps a passkey bound to a hostname
 * this build can actually reach.
 *
 * A build pointed at an http loopback server, which is what the end-to-end
 * harness runs, gets nothing: Apple and Google validate association files
 * only over HTTPS, so a loopback entitlement would be an entitlement that can
 * never be satisfied (issue #647).
 */
export function partnerPasskeyRelyingPartyHost(
  environment: AppConfigEnvironment = process.env,
): string | null {
  const configured = environment[API_BASE_URL_ENV]?.trim();
  if (configured === undefined || configured.length === 0) return null;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === 'https:' && parsed.hostname.includes('.')
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/**
 * The Android asset statement, which points at the document the deployment
 * serves rather than restating it.
 *
 * Google's `include` form is what keeps the Play signing fingerprint out of
 * this repository and out of the built app: the certificate this app was
 * signed with is named once, in the district's own tenant configuration, and
 * the app only says where to look it up.
 */
export function androidAssetStatements(
  environment: AppConfigEnvironment = process.env,
): string | null {
  const host = partnerPasskeyRelyingPartyHost(environment);
  return host === null
    ? null
    : JSON.stringify([
        { include: `https://${host}/.well-known/assetlinks.json` },
      ]);
}

const ASSET_STATEMENTS_RESOURCE = 'asset_statements';

/**
 * Declares the association on both platforms, from the one configured origin.
 *
 * iOS needs the `webcredentials` associated domain before its passkey sheet
 * will offer a credential for that hostname. Android needs nothing for the
 * ceremony itself — the credential manager checks the hosted document — but
 * the asset statement is what lets the platform resolve the relationship
 * without a round trip at the moment of signing in, so both are declared.
 */
export function withPartnerPasskeyAssociation(
  config: ExpoConfig,
  environment: AppConfigEnvironment = process.env,
): ExpoConfig {
  const host = partnerPasskeyRelyingPartyHost(environment);
  const statements = androidAssetStatements(environment);
  if (host === null || statements === null) return config;

  const associatedDomain = `webcredentials:${host}`;
  const withDomains: ExpoConfig = {
    ...config,
    ios: {
      ...config.ios,
      associatedDomains: [
        ...(config.ios?.associatedDomains ?? []).filter(
          (domain) => domain !== associatedDomain,
        ),
        associatedDomain,
      ],
    },
  };

  const withStatements = withStringsXml(withDomains, (modConfig) => {
    modConfig.modResults = AndroidConfig.Strings.setStringItem(
      [
        {
          _: statements,
          $: { name: ASSET_STATEMENTS_RESOURCE, translatable: 'false' },
        },
      ],
      modConfig.modResults,
    );
    return modConfig;
  });

  return withAndroidManifest(withStatements, (modConfig) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      modConfig.modResults,
    );
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      application,
      ASSET_STATEMENTS_RESOURCE,
      `@string/${ASSET_STATEMENTS_RESOURCE}`,
      'resource',
    );
    return modConfig;
  });
}

export default ({ config }: ConfigContext): ExpoConfig =>
  withPartnerPasskeyAssociation(withPushProviderConfig(config) as ExpoConfig);
