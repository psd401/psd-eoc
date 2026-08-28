import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

export type LaunchedUpdateDiagnosticStatus = 'known' | 'unknown';
export type LaunchedUpdateMode = 'embedded-only' | 'unknown';
export type LaunchedUpdateSource = 'embedded' | 'unknown';

export interface LaunchedUpdateDiagnostic {
  readonly status: LaunchedUpdateDiagnosticStatus;
  readonly mode: LaunchedUpdateMode;
  readonly launchSource: LaunchedUpdateSource;
  readonly updateId: string | null;
  readonly runtimeVersion: string | null;
  readonly channel: string | null;
  readonly isEmergencyLaunch: boolean | null;
  readonly applicationId: string | null;
  readonly applicationVersion: string | null;
  readonly configuredRuntimeVersion: string | null;
  readonly nativeBuildVersion: string | null;
  /** Why the build could not be confirmed; empty when it was. */
  readonly unmetConditions: readonly string[];
}

export interface ReadOnlyUpdateConstants {
  readonly isEnabled: unknown;
  readonly isEmbeddedLaunch: unknown;
  readonly isUsingEmbeddedAssets: unknown;
  readonly isEmergencyLaunch: unknown;
  readonly checkAutomatically: unknown;
  readonly updateId: unknown;
  readonly runtimeVersion: unknown;
  readonly channel: unknown;
  readonly configuredUpdatesEnabled: unknown;
  readonly configuredCheckAutomatically: unknown;
  readonly configuredUpdateUrl: unknown;
  readonly configuredApplicationVersion: unknown;
  readonly configuredApplicationId: unknown;
  readonly configuredRuntimeVersion: unknown;
  readonly applicationId: unknown;
  readonly applicationVersion: unknown;
  readonly nativeBuildVersion: unknown;
}

const APPLICATION_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u;
const APPLICATION_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){2}$/u;
const NATIVE_BUILD_VERSION_PATTERN = /^[1-9][0-9]{0,17}$/u;

function exactToken(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/**
 * Reduces native update constants to the non-sensitive, read-only identity used
 * for physical-device release evidence. Invalid or incomplete identity fails
 * closed as unknown; this function never checks, downloads, applies, or
 * publishes an update.
 */
export function createLaunchedUpdateDiagnostic(
  constants: ReadOnlyUpdateConstants,
): LaunchedUpdateDiagnostic {
  // The installed binary is the authority on which application it is. The
  // configuration only gets a veto: if it is present and disagrees, something
  // is wrong; if it is absent, that is normal for a release build.
  const nativeApplicationId = exactToken(
    constants.applicationId,
    APPLICATION_ID_PATTERN,
  );
  const configuredApplicationId = exactToken(
    constants.configuredApplicationId,
    APPLICATION_ID_PATTERN,
  );
  const applicationId =
    configuredApplicationId !== null &&
    configuredApplicationId !== nativeApplicationId
      ? null
      : nativeApplicationId;
  const applicationVersion = exactToken(
    constants.applicationVersion,
    APPLICATION_VERSION_PATTERN,
  );
  const nativeBuildVersion = exactToken(
    constants.nativeBuildVersion,
    NATIVE_BUILD_VERSION_PATTERN,
  );
  // Every condition below is read from a native module. The application
  // configuration is deliberately not consulted: a release build resolves and
  // rewrites parts of it, so requiring it to echo the build back was the
  // reason a correct binary reported an incomplete identity.
  //
  // Each failure is named. A device that cannot confirm its own build has to
  // say which fact was missing, otherwise the screen is only capable of
  // saying "no".
  const unmetConditions: string[] = [];
  if (constants.isEnabled !== false) {
    unmetConditions.push('Remote updates are not switched off.');
  }
  if (constants.updateId !== null && constants.updateId !== undefined) {
    unmetConditions.push('A downloaded update is running.');
  }
  if (constants.isEmergencyLaunch === true) {
    unmetConditions.push('The application started in emergency recovery.');
  }
  if (applicationId === null) {
    unmetConditions.push('The application identifier is unavailable.');
  }
  if (applicationVersion === null) {
    unmetConditions.push('The application version is unavailable.');
  }
  if (nativeBuildVersion === null) {
    unmetConditions.push('The build number is unavailable.');
  }

  if (unmetConditions.length > 0) {
    return Object.freeze({
      status: 'unknown',
      mode: 'unknown',
      launchSource: 'unknown',
      updateId: null,
      runtimeVersion: null,
      channel: null,
      isEmergencyLaunch: constants.isEmergencyLaunch === true ? true : null,
      applicationId: null,
      applicationVersion: null,
      configuredRuntimeVersion: null,
      nativeBuildVersion: null,
      unmetConditions: Object.freeze([...unmetConditions]),
    });
  }

  return Object.freeze({
    status: 'known',
    mode: 'embedded-only',
    launchSource: 'embedded',
    updateId: null,
    runtimeVersion: null,
    channel: null,
    isEmergencyLaunch: false,
    applicationId,
    applicationVersion,
    configuredRuntimeVersion: applicationVersion,
    nativeBuildVersion,
    unmetConditions: Object.freeze([]),
  });
}

/** Reads only synchronous expo-updates and expo-application identity constants. */
export function readLaunchedUpdateDiagnostic(): LaunchedUpdateDiagnostic {
  return createLaunchedUpdateDiagnostic({
    isEnabled: Updates.isEnabled,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    isUsingEmbeddedAssets: Updates.isUsingEmbeddedAssets,
    isEmergencyLaunch: Updates.isEmergencyLaunch,
    checkAutomatically: Updates.checkAutomatically,
    updateId: Updates.updateId,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
    configuredUpdatesEnabled: Constants.expoConfig?.updates?.enabled,
    configuredCheckAutomatically:
      Constants.expoConfig?.updates?.checkAutomatically,
    configuredUpdateUrl: Constants.expoConfig?.updates?.url,
    configuredApplicationVersion: Constants.expoConfig?.version,
    configuredApplicationId:
      Platform.OS === 'ios'
        ? Constants.expoConfig?.ios?.bundleIdentifier
        : Platform.OS === 'android'
          ? Constants.expoConfig?.android?.package
          : undefined,
    configuredRuntimeVersion: Constants.expoConfig?.runtimeVersion,
    applicationId: Application.applicationId,
    applicationVersion: Application.nativeApplicationVersion,
    nativeBuildVersion: Application.nativeBuildVersion,
  });
}
