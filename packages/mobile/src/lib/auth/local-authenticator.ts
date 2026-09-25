import * as LocalAuthentication from 'expo-local-authentication';

import type { LocalAuthenticator } from './auth-controller';
import { PSD_EOC_LOCAL_AUTH_POLICY } from './local-auth-policy';

export const PSD_EOC_LOCAL_AUTH_OPTIONS: LocalAuthentication.LocalAuthenticationOptions =
  PSD_EOC_LOCAL_AUTH_POLICY;

/**
 * The device has no screen lock of any kind, so there is nothing for the
 * operating system to check. Refusing here used to throw away a good sign-in
 * on such a device, including a store reviewer's test phone.
 */
function deviceHasNoLock(
  error: LocalAuthentication.LocalAuthenticationError,
): boolean {
  return error === 'not_enrolled' || error === 'passcode_not_set';
}

function failureMessage(error: LocalAuthentication.LocalAuthenticationError) {
  switch (error) {
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
      // A device with a screen lock is always asked for it. Only a device that
      // has none is let through, because there is nothing to ask for.
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        return Object.freeze({ success: true as const });
      }
      const result = await LocalAuthentication.authenticateAsync(
        PSD_EOC_LOCAL_AUTH_OPTIONS,
      );
      if (result.success || deviceHasNoLock(result.error)) {
        return Object.freeze({ success: true as const });
      }
      return Object.freeze({
        success: false as const,
        message: failureMessage(result.error),
      });
    },
  });
}
