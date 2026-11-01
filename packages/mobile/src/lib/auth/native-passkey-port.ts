import type {
  PartnerPasskeyCreationOptions,
  PartnerPasskeyRequestOptions,
} from '@psd-eoc/contracts';
import { requireOptionalNativeModule } from 'expo';

import type { PartnerPasskeyPort } from './partner-passkey-client';

/**
 * The platform authenticator, at the dependency boundary.
 *
 * WebAuthn on a phone is the operating system's job: iOS runs the ceremony
 * through its own passkey sheet and Android through the credential manager.
 * `react-native-passkeys` is the Expo module that exposes both, and this is
 * the only file that knows it exists.
 *
 * The native module is required optionally rather than imported, for two
 * reasons. A build made before this change has no such module, and asking for
 * one that is absent must mean "this device has no passkeys" rather than a
 * crash at startup — the emailed code is the fallback and must keep working.
 * And the module's own JavaScript wrapper types reach for a WebAuthn types
 * package that is not a dependency of this app, so taking the native module
 * directly keeps the one shape that crosses this boundary the one the
 * contracts already define.
 *
 * Nothing here decides anything. What to do with a device that cannot run a
 * ceremony, or a ceremony the person dismissed, is in
 * `partner-passkey-client`, which is testable without a device.
 *
 * Issue #647.
 */

/**
 * The native module's surface, narrowed to what partner sign-in uses.
 *
 * `create` and `get` take and return the base64url JSON documents WebAuthn
 * defines, which is exactly what the server sends and expects back, so
 * nothing is re-encoded on the way through.
 */
interface ReactNativePasskeysModule {
  isSupported(): boolean;
  create(request: unknown): Promise<unknown>;
  get(request: unknown): Promise<unknown>;
}

const passkeys = requireOptionalNativeModule<ReactNativePasskeysModule>(
  'ReactNativePasskeys',
);

export const nativePasskeyPort: PartnerPasskeyPort = Object.freeze({
  isSupported(): boolean {
    if (passkeys === null) return false;
    try {
      return passkeys.isSupported();
    } catch {
      // A module that cannot answer is a device that cannot be relied on for
      // a ceremony, which is the emailed code's case.
      return false;
    }
  },
  create(options: PartnerPasskeyCreationOptions) {
    if (passkeys === null) {
      return Promise.reject(new Error('This build cannot create a passkey.'));
    }
    return passkeys.create(options);
  },
  get(options: PartnerPasskeyRequestOptions) {
    if (passkeys === null) {
      return Promise.reject(new Error('This build cannot use a passkey.'));
    }
    return passkeys.get(options);
  },
});
