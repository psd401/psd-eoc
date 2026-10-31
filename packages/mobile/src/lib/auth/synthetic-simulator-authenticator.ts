import { isIssue21SyntheticFixtureEnabled } from '../start/issue-21-synthetic-fixture';
import type { LocalAuthenticator } from './auth-controller';

/**
 * Whether this build stands in for the device owner's unlock.
 *
 * It exists because Xcode 26 removed the simulator biometric command a
 * headless run used, so a simulator falls through to the device passcode
 * sheet that no automated run can answer. It must never be reachable from a
 * build anyone installs, so it is only enabled for one of the two end-to-end
 * journeys, each identified by the exact set of flags that journey sets:
 *
 * - the issue-32 notification journey, whose in-process fixtures stand in for
 *   the server entirely; and
 * - the issue-598 native partner journey, which has no in-process fixture
 *   because it drives the real client against a server on this machine's
 *   loopback — an origin a store build can never have, because the app only
 *   accepts http loopback in a development build.
 *
 * Every arm also requires a development build.
 */
export function isSyntheticSimulatorAuthenticatorEnabled(): boolean {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return false;
  if (process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE !== 'issue-32') {
    return false;
  }
  if (isIssue21SyntheticFixtureEnabled()) {
    return (
      process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE === 'issue-32'
    );
  }
  return (
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE === undefined &&
    isLoopbackApiOrigin(process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL)
  );
}

function isLoopbackApiOrigin(value: string | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value ?? '');
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  );
}

/** Simulator-only unlock adapter for the end-to-end journeys above. */
export function createSyntheticSimulatorAuthenticator(): LocalAuthenticator {
  if (!isSyntheticSimulatorAuthenticatorEnabled()) {
    throw new TypeError('The synthetic simulator authenticator is disabled.');
  }
  return Object.freeze({
    async authenticate() {
      // Re-checked on every unlock, not only at construction: a build that
      // stops qualifying mid-session must stop standing in immediately.
      if (!isSyntheticSimulatorAuthenticatorEnabled()) {
        return Object.freeze({
          success: false as const,
          message: 'The synthetic simulator authenticator is disabled.',
        });
      }
      return Object.freeze({ success: true as const });
    },
  });
}
