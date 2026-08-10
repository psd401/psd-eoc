import * as LocalAuthentication from 'expo-local-authentication';

import type { LocalAuthenticator } from './auth-controller';
import { PSD_EOC_LOCAL_AUTH_POLICY } from './local-auth-policy';

export const PSD_EOC_LOCAL_AUTH_OPTIONS: LocalAuthentication.LocalAuthenticationOptions =
  PSD_EOC_LOCAL_AUTH_POLICY;

function failureMessage(error: LocalAuthentication.LocalAuthenticationError) {
  switch (error) {
    case 'not_enrolled':
    case 'passcode_not_set':
      return 'Set up Face ID, a biometric, or a device passcode in system settings before unlocking PSD EOC.';
    case 'lockout':
      return 'Device authentication is temporarily locked. Use the system-provided device passcode option or try again later.';
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
      return 'PSD EOC remains locked. Unlock when you are ready.';
    default:
      return 'PSD EOC could not verify device authentication. Try again or contact district technology support.';
  }
}

export function createLocalAuthenticator(): LocalAuthenticator {
  return Object.freeze({
    async authenticate() {
      const result = await LocalAuthentication.authenticateAsync(
        PSD_EOC_LOCAL_AUTH_OPTIONS,
      );
      return result.success
        ? Object.freeze({ success: true as const })
        : Object.freeze({
            success: false as const,
            message: failureMessage(result.error),
          });
    },
  });
}
