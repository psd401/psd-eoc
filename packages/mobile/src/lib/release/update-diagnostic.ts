import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

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
  readonly configuredRuntimeVersion: unknown;
  readonly applicationId: unknown;
  readonly applicationVersion: unknown;
  readonly nativeBuildVersion: unknown;
}

const APPLICATION_ID = 'net.psd401.eoc';
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
  const applicationId =
    constants.applicationId === APPLICATION_ID ? APPLICATION_ID : null;
  const applicationVersion = exactToken(
    constants.applicationVersion,
    APPLICATION_VERSION_PATTERN,
  );
  const nativeBuildVersion = exactToken(
    constants.nativeBuildVersion,
    NATIVE_BUILD_VERSION_PATTERN,
  );
  const configuredApplicationVersion = exactToken(
    constants.configuredApplicationVersion,
    APPLICATION_VERSION_PATTERN,
  );
  const usesAppVersionRuntimePolicy =
    typeof constants.configuredRuntimeVersion === 'object' &&
    constants.configuredRuntimeVersion !== null &&
    !Array.isArray(constants.configuredRuntimeVersion) &&
    Object.keys(constants.configuredRuntimeVersion).length === 1 &&
    'policy' in constants.configuredRuntimeVersion &&
    constants.configuredRuntimeVersion.policy === 'appVersion';

  const isVerifiedEmbeddedOnly =
    constants.configuredUpdatesEnabled === false &&
    constants.configuredCheckAutomatically === 'NEVER' &&
    constants.configuredUpdateUrl === undefined &&
    constants.isEnabled === false &&
    constants.checkAutomatically === 'NEVER' &&
    constants.isEmbeddedLaunch === false &&
    constants.isUsingEmbeddedAssets === true &&
    constants.isEmergencyLaunch === false &&
    constants.updateId === null &&
    constants.runtimeVersion === '' &&
    constants.channel === '' &&
    usesAppVersionRuntimePolicy &&
    applicationId !== null &&
    applicationVersion !== null &&
    configuredApplicationVersion === applicationVersion &&
    nativeBuildVersion !== null;

  if (!isVerifiedEmbeddedOnly) {
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
    configuredRuntimeVersion: Constants.expoConfig?.runtimeVersion,
    applicationId: Application.applicationId,
    applicationVersion: Application.nativeApplicationVersion,
    nativeBuildVersion: Application.nativeBuildVersion,
  });
}
