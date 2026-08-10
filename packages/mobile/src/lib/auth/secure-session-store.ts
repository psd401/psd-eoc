import {
  IdempotencyKeySchema,
  OpaqueSessionBearerSchema,
  SessionEstablishmentResultSchema,
} from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import type { AuthStorage, StoredAuthVault } from './auth-controller';
import { clearMarkerThenVault } from './storage-safety';

const MARKER_KEY = 'psd-eoc.auth.enrolled.v1';
const VAULT_KEY = 'psd-eoc.auth.vault.v1';
const INSTALLATION_KEY = 'psd-eoc.auth.installation.v1';
const MARKER_VALUE = 'enrolled-v1';
const INSTALLATION_PATTERN = /^[A-Za-z0-9_-]{16,255}$/u;

const markerOptions: SecureStore.SecureStoreOptions = Object.freeze({
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'net.psd401.eoc.auth-marker',
});

const vaultOptions: SecureStore.SecureStoreOptions = Object.freeze({
  // An explicit LocalAuthentication success gates every read. This device-only
  // accessibility also preserves the required OS passcode fallback on iOS.
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  keychainService: 'net.psd401.eoc.auth-vault',
});

const installationOptions: SecureStore.SecureStoreOptions = Object.freeze({
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'net.psd401.eoc.installation',
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseStoredAuthVault(value: string): StoredAuthVault {
  const parsed = record(JSON.parse(value));
  if (
    parsed === null ||
    Object.keys(parsed).some(
      (key) =>
        key !== 'refreshToken' &&
        key !== 'pendingRefreshIdempotencyKey' &&
        key !== 'session',
    ) ||
    (parsed.pendingRefreshIdempotencyKey !== null &&
      typeof parsed.pendingRefreshIdempotencyKey !== 'string')
  ) {
    throw new Error('The stored mobile session is invalid.');
  }
  const pendingRefreshIdempotencyKey =
    parsed.pendingRefreshIdempotencyKey === null
      ? null
      : IdempotencyKeySchema.parse(parsed.pendingRefreshIdempotencyKey);
  return Object.freeze({
    refreshToken: OpaqueSessionBearerSchema.parse(parsed.refreshToken),
    pendingRefreshIdempotencyKey,
    session: SessionEstablishmentResultSchema.parse(parsed.session),
  });
}

function serializeVault(vault: StoredAuthVault): string {
  return JSON.stringify({
    refreshToken: OpaqueSessionBearerSchema.parse(vault.refreshToken),
    pendingRefreshIdempotencyKey: vault.pendingRefreshIdempotencyKey,
    session: SessionEstablishmentResultSchema.parse(vault.session),
  });
}

async function requireSecureStore(): Promise<void> {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error('SecureStore is unavailable.');
  }
}

/** Native encrypted storage. Callers must authenticate locally before readVault. */
export function createSecureSessionStore(): AuthStorage {
  return Object.freeze({
    async getOrCreateInstallationId(): Promise<string> {
      await requireSecureStore();
      const existing = await SecureStore.getItemAsync(
        INSTALLATION_KEY,
        installationOptions,
      );
      if (existing !== null) {
        if (!INSTALLATION_PATTERN.test(existing)) {
          throw new Error('The stored installation identifier is invalid.');
        }
        return existing;
      }
      const installationId = Crypto.randomUUID();
      await SecureStore.setItemAsync(
        INSTALLATION_KEY,
        installationId,
        installationOptions,
      );
      return installationId;
    },

    async hasEnrollment(): Promise<boolean> {
      await requireSecureStore();
      return (
        (await SecureStore.getItemAsync(MARKER_KEY, markerOptions)) ===
        MARKER_VALUE
      );
    },

    async readVault(): Promise<StoredAuthVault | null> {
      await requireSecureStore();
      const value = await SecureStore.getItemAsync(VAULT_KEY, vaultOptions);
      return value === null ? null : parseStoredAuthVault(value);
    },

    async writeVault(vault: StoredAuthVault): Promise<void> {
      await requireSecureStore();
      await SecureStore.setItemAsync(
        VAULT_KEY,
        serializeVault(vault),
        vaultOptions,
      );
      await SecureStore.setItemAsync(MARKER_KEY, MARKER_VALUE, markerOptions);
    },

    async clearSession(): Promise<void> {
      // Marker-first means a crash can leave an unreachable encrypted bearer,
      // but can never make the next launch treat that bearer as enrolled.
      await clearMarkerThenVault(
        () => SecureStore.deleteItemAsync(MARKER_KEY, markerOptions),
        () => SecureStore.deleteItemAsync(VAULT_KEY, vaultOptions),
      );
    },
  });
}
