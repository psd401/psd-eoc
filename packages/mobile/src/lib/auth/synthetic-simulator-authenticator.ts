import { isIssue21SyntheticFixtureEnabled } from '../start/issue-21-synthetic-fixture';
import type { LocalAuthenticator } from './auth-controller';

/**
 * Whether this build stands in for the device owner's unlock.
 *
 * It exists because Xcode 26 removed the simulator biometric command a
 * headless run used, so a simulator falls through to the device passcode
 * sheet that no automated run can answer. It must never be reachable from a
 * build anyone installs, so each of the two end-to-end journeys names itself
 * in the fixture flag, and neither journey's value satisfies the other's arm:
 *
 * - `issue-32`, the notification journey, whose in-process fixtures stand in
 *   for the server entirely and which must therefore have both of them; and
 * - `issue-598`, the native partner journey, which must have neither, because
 *   it drives the real client against a server on this machine's loopback —
 *   an origin a store build can never have, since the app only accepts http
 *   loopback in a development build.
 *
 * A build left over from one journey therefore cannot stand in during the
 * other, and every arm also requires a development build.
 */
export function isSyntheticSimulatorAuthenticatorEnabled(): boolean {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return false;
  switch (process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE) {
    case 'issue-32':
      return (
        isIssue21SyntheticFixtureEnabled() &&
        process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE === 'issue-32'
      );
    case 'issue-598':
      return (
        !isIssue21SyntheticFixtureEnabled() &&
        process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE === undefined &&
        process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE === undefined &&
        isLoopbackApiOrigin(process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL)
      );
    default:
      return false;
  }
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
