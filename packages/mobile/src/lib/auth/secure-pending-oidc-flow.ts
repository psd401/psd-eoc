import * as SecureStore from 'expo-secure-store';

import {
  createPendingOidcFlowStore,
  PENDING_OIDC_FLOW_KEY,
  type PendingOidcFlowStore,
} from './pending-oidc-flow';

/**
 * Device-only and readable while unlocked, deliberately unlike the session
 * vault. A cold start caused by the Android callback deep link has to resume
 * before any local authentication has happened, so this record cannot sit
 * behind the vault's passcode gate.
 */
const pendingFlowOptions: SecureStore.SecureStoreOptions = Object.freeze({
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'net.psd401.eoc.pending-oidc',
});

/** Native encrypted storage for one in-flight OIDC attempt. */
export function createSecurePendingOidcFlowStore(): PendingOidcFlowStore {
  return createPendingOidcFlowStore({
    read: () =>
      SecureStore.getItemAsync(PENDING_OIDC_FLOW_KEY, pendingFlowOptions),
    write: (value) =>
      SecureStore.setItemAsync(
        PENDING_OIDC_FLOW_KEY,
        value,
        pendingFlowOptions,
      ),
    remove: () =>
      SecureStore.deleteItemAsync(PENDING_OIDC_FLOW_KEY, pendingFlowOptions),
  });
}
