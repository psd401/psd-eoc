import type { LocalAuthenticator } from './auth-controller';
import { isIssue21SyntheticFixtureEnabled } from '../start/issue-21-synthetic-fixture';

export function isIssue32SyntheticAuthenticatorEnabled(): boolean {
  return (
    isIssue21SyntheticFixtureEnabled() &&
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE === 'issue-32' &&
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE === 'issue-32'
  );
}

/**
 * Simulator-only auth adapter for the issue-32 notification journey. The
 * ordinary issue-21 fixture and every non-development build still use the OS
 * authenticator; this exact extra flag exists because Xcode 26 removed the
 * simulator biometric command used by headless CI.
 */
export function createIssue32SyntheticAuthenticator(): LocalAuthenticator {
  if (!isIssue32SyntheticAuthenticatorEnabled()) {
    throw new TypeError('The issue-32 synthetic authenticator is disabled.');
  }
  return Object.freeze({
    async authenticate() {
      if (!isIssue32SyntheticAuthenticatorEnabled()) {
        return Object.freeze({
          success: false as const,
          message: 'The issue-32 synthetic authenticator is disabled.',
        });
      }
      return Object.freeze({ success: true as const });
    },
  });
}
