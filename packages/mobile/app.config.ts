import type { ConfigContext, ExpoConfig } from 'expo/config';

type AppConfigEnvironment = Readonly<Record<string, string | undefined>>;

const PUSH_REGISTRATION_ENV = 'EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED';

export function withPushProviderConfig(
  config: ConfigContext['config'],
  environment: AppConfigEnvironment = process.env,
): ConfigContext['config'] {
  if (environment[PUSH_REGISTRATION_ENV] !== 'true') return config;

  const googleServicesFile = environment.GOOGLE_SERVICES_JSON?.trim();
  if (!googleServicesFile) {
    throw new Error(
      'GOOGLE_SERVICES_JSON must be a protected EAS file variable for the push-enabled build.',
    );
  }

  return {
    ...config,
    android: {
      ...config.android,
      googleServicesFile,
    },
  };
}

export default ({ config }: ConfigContext): ExpoConfig =>
  withPushProviderConfig(config) as ExpoConfig;
