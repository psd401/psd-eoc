import * as Updates from 'expo-updates';

export type LaunchedUpdateDiagnosticStatus = 'known' | 'unknown';
export type LaunchedUpdateSource = 'downloaded' | 'embedded' | 'unknown';

export interface LaunchedUpdateDiagnostic {
  readonly status: LaunchedUpdateDiagnosticStatus;
  readonly launchSource: LaunchedUpdateSource;
  readonly updateId: string | null;
  readonly runtimeVersion: string | null;
  readonly channel: string | null;
  readonly isEmergencyLaunch: boolean | null;
}

export interface ReadOnlyUpdateConstants {
  readonly isEnabled: unknown;
  readonly isEmbeddedLaunch: unknown;
  readonly isEmergencyLaunch: unknown;
  readonly updateId: unknown;
  readonly runtimeVersion: unknown;
  readonly channel: unknown;
}

const UPDATE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RELEASE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

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
  if (
    constants.isEnabled !== true ||
    typeof constants.isEmbeddedLaunch !== 'boolean' ||
    typeof constants.isEmergencyLaunch !== 'boolean'
  ) {
    return Object.freeze({
      status: 'unknown',
      launchSource: 'unknown',
      updateId: null,
      runtimeVersion: null,
      channel: null,
      isEmergencyLaunch: null,
    });
  }

  const updateId = exactToken(constants.updateId, UPDATE_ID_PATTERN);
  const runtimeVersion = exactToken(
    constants.runtimeVersion,
    RELEASE_TOKEN_PATTERN,
  );
  const channel = exactToken(constants.channel, RELEASE_TOKEN_PATTERN);

  return Object.freeze({
    status:
      updateId !== null && runtimeVersion !== null && channel !== null
        ? 'known'
        : 'unknown',
    launchSource: constants.isEmbeddedLaunch ? 'embedded' : 'downloaded',
    updateId,
    runtimeVersion,
    channel,
    isEmergencyLaunch: constants.isEmergencyLaunch,
  });
}

/** Reads only synchronous expo-updates identity constants. */
export function readLaunchedUpdateDiagnostic(): LaunchedUpdateDiagnostic {
  return createLaunchedUpdateDiagnostic({
    isEnabled: Updates.isEnabled,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    isEmergencyLaunch: Updates.isEmergencyLaunch,
    updateId: Updates.updateId,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
  });
}
