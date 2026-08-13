/** Minimal native surface used to fail closed Expo's persisted side channel. */
export interface ExpoServerRegistrationModule {
  readonly getInstallationIdAsync?: () => Promise<string>;
  readonly setRegistrationInfoAsync?: (
    registrationInfo: string,
  ) => Promise<void>;
}

export const DISABLED_EXPO_AUTO_REGISTRATION_INFO = JSON.stringify({
  isEnabled: false,
});

/**
 * Expo 57's public disable helper passes null, while its iOS native method
 * accepts a non-null String. Persist an explicit disabled record instead.
 */
export async function disableExpoAutoRegistration(
  nativeModule: ExpoServerRegistrationModule | null,
): Promise<void> {
  if (nativeModule?.setRegistrationInfoAsync === undefined) {
    throw new Error('Expo server-registration storage is unavailable.');
  }
  await nativeModule.setRegistrationInfoAsync(
    DISABLED_EXPO_AUTO_REGISTRATION_INFO,
  );
}
