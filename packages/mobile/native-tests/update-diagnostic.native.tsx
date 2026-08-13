import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockUpdateConstants: {
  isEnabled: unknown;
  isEmbeddedLaunch: unknown;
  isEmergencyLaunch: unknown;
  updateId: unknown;
  runtimeVersion: unknown;
  channel: unknown;
  applicationId: unknown;
  applicationVersion: unknown;
  nativeBuildVersion: unknown;
} = {
  isEnabled: true,
  isEmbeddedLaunch: true,
  isEmergencyLaunch: false,
  updateId: '10000000-0000-4000-8000-000000000001',
  runtimeVersion: '1.0.0',
  channel: 'production',
  applicationId: 'net.psd401.eoc',
  applicationVersion: '1.0.0',
  nativeBuildVersion: '1',
};

jest.mock('expo-application', () => ({
  get applicationId() {
    return mockUpdateConstants.applicationId;
  },
  get nativeApplicationVersion() {
    return mockUpdateConstants.applicationVersion;
  },
  get nativeBuildVersion() {
    return mockUpdateConstants.nativeBuildVersion;
  },
}));

const mockCheckForUpdateAsync = jest.fn();
const mockFetchUpdateAsync = jest.fn();
const mockReloadAsync = jest.fn();
const mockReadLogEntriesAsync = jest.fn();
const mockSetExtraParamAsync = jest.fn();
const mockSetUpdateRequestHeadersOverride = jest.fn();
const mockSetUpdateURLAndRequestHeadersOverride = jest.fn();

jest.mock('expo-updates', () => ({
  get isEnabled() {
    return mockUpdateConstants.isEnabled;
  },
  get isEmbeddedLaunch() {
    return mockUpdateConstants.isEmbeddedLaunch;
  },
  get isEmergencyLaunch() {
    return mockUpdateConstants.isEmergencyLaunch;
  },
  get updateId() {
    return mockUpdateConstants.updateId;
  },
  get runtimeVersion() {
    return mockUpdateConstants.runtimeVersion;
  },
  get channel() {
    return mockUpdateConstants.channel;
  },
  checkForUpdateAsync: mockCheckForUpdateAsync,
  fetchUpdateAsync: mockFetchUpdateAsync,
  reloadAsync: mockReloadAsync,
  readLogEntriesAsync: mockReadLogEntriesAsync,
  setExtraParamAsync: mockSetExtraParamAsync,
  setUpdateRequestHeadersOverride: mockSetUpdateRequestHeadersOverride,
  setUpdateURLAndRequestHeadersOverride:
    mockSetUpdateURLAndRequestHeadersOverride,
}));

import ReleaseDiagnosticScreen from '../src/app/release-diagnostic';
import { createLaunchedUpdateDiagnostic } from '../src/lib/release/update-diagnostic';

const EMBEDDED_UPDATE_ID = '10000000-0000-4000-8000-000000000001';
const DOWNLOADED_UPDATE_ID = '20000000-0000-4000-8000-000000000002';

const forbiddenUpdateCalls = [
  mockCheckForUpdateAsync,
  mockFetchUpdateAsync,
  mockReloadAsync,
  mockReadLogEntriesAsync,
  mockSetExtraParamAsync,
  mockSetUpdateRequestHeadersOverride,
  mockSetUpdateURLAndRequestHeadersOverride,
] as const;

function expectNoUpdateSideEffects(): void {
  for (const call of forbiddenUpdateCalls) {
    expect(call).not.toHaveBeenCalled();
  }
}

describe('authenticated release diagnostic', () => {
  beforeEach(() => {
    Object.assign(mockUpdateConstants, {
      isEnabled: true,
      isEmbeddedLaunch: true,
      isEmergencyLaunch: false,
      updateId: EMBEDDED_UPDATE_ID,
      runtimeVersion: '1.0.0',
      channel: 'production',
      applicationId: 'net.psd401.eoc',
      applicationVersion: '1.0.0',
      nativeBuildVersion: '1',
    });
  });

  test('shows a complete embedded launch identity as accessible read-only evidence', () => {
    render(<ReleaseDiagnosticScreen />);

    expect(
      screen.getByRole('header', { name: 'Release diagnostics' }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Evidence status: Identity available'),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Application ID: net.psd401.eoc'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Application version: 1.0.0')).toBeTruthy();
    expect(screen.getByLabelText('Native build version: 1')).toBeTruthy();
    expect(
      screen.getByLabelText('Launch source: Embedded in this installed binary'),
    ).toBeTruthy();
    expect(
      screen.getByText(/TestFlight, Play, or the private OTA verifier build/iu),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(`Update ID: ${EMBEDDED_UPDATE_ID}`),
    ).toBeTruthy();
    expect(screen.getByLabelText('Runtime version: 1.0.0')).toBeTruthy();
    expect(screen.getByLabelText('Update channel: production')).toBeTruthy();
    expect(screen.getByLabelText('Emergency launch: No')).toBeTruthy();
    expect(screen.getByText(EMBEDDED_UPDATE_ID).props.selectable).toBe(true);
    expect(screen.getAllByText('1.0.0')).toHaveLength(2);
    for (const version of screen.getAllByText('1.0.0')) {
      expect(version.props.selectable).toBe(true);
    }
    expect(screen.getByText('production').props.selectable).toBe(true);
    expect(
      screen.getByText(/cannot check for, download, apply, or publish/iu),
    ).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).not.toContain(
      'Embedded in this store build',
    );
    expectNoUpdateSideEffects();
  });

  test('distinguishes a downloaded OTA update by its exact update ID', () => {
    Object.assign(mockUpdateConstants, {
      isEmbeddedLaunch: false,
      updateId: DOWNLOADED_UPDATE_ID,
      runtimeVersion: '1.0.0',
      channel: 'production',
    });

    render(<ReleaseDiagnosticScreen />);

    expect(
      screen.getByLabelText('Launch source: Downloaded over-the-air update'),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(`Update ID: ${DOWNLOADED_UPDATE_ID}`),
    ).toBeTruthy();
    expectNoUpdateSideEffects();
  });

  test('fails closed when expo-updates identity is disabled, invalid, or incomplete', () => {
    Object.assign(mockUpdateConstants, {
      isEnabled: false,
      isEmbeddedLaunch: true,
      isEmergencyLaunch: false,
      updateId: 'Bearer secret-provider-token',
      runtimeVersion: '1.0.0\nstaff@example.org',
      channel: null,
      applicationId: 'wrong.example.app',
      applicationVersion: 'Bearer-secret',
      nativeBuildVersion: 'staff@example.org',
    });

    const diagnostic = createLaunchedUpdateDiagnostic(mockUpdateConstants);
    expect(diagnostic).toEqual({
      status: 'unknown',
      launchSource: 'unknown',
      updateId: null,
      runtimeVersion: null,
      channel: null,
      isEmergencyLaunch: null,
      applicationId: null,
      applicationVersion: null,
      nativeBuildVersion: null,
    });
    expect(Object.isFrozen(diagnostic)).toBe(true);

    render(<ReleaseDiagnosticScreen />);

    expect(
      screen.getByLabelText(
        'Evidence status: Unknown — do not use as release evidence',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Launch source: Unknown')).toBeTruthy();
    expect(
      screen.UNSAFE_getByProps({ accessibilityRole: 'alert' }),
    ).toBeTruthy();
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered).not.toContain('secret-provider-token');
    expect(rendered).not.toContain('staff@example.org');
    expect(rendered).not.toContain('wrong.example.app');
    expectNoUpdateSideEffects();
  });

  test('fails incomplete enabled identity closed while preserving only safe fields', () => {
    const diagnostic = createLaunchedUpdateDiagnostic({
      isEnabled: true,
      isEmbeddedLaunch: false,
      isEmergencyLaunch: true,
      updateId: DOWNLOADED_UPDATE_ID,
      runtimeVersion: '1.0.0',
      channel: 'production channel',
      applicationId: 'net.psd401.eoc',
      applicationVersion: '1.0.0',
      nativeBuildVersion: '2',
    });

    expect(diagnostic).toEqual({
      status: 'unknown',
      launchSource: 'downloaded',
      updateId: DOWNLOADED_UPDATE_ID,
      runtimeVersion: '1.0.0',
      channel: null,
      isEmergencyLaunch: true,
      applicationId: 'net.psd401.eoc',
      applicationVersion: '1.0.0',
      nativeBuildVersion: '2',
    });
  });

  test('rejects malicious installed-application identity while updates stay enabled', () => {
    Object.assign(mockUpdateConstants, {
      applicationId: 'wrong.example.app',
      applicationVersion: '1.0.0\nstaff@example.org',
      nativeBuildVersion: 'Bearer-secret',
    });

    const diagnostic = createLaunchedUpdateDiagnostic(mockUpdateConstants);
    expect(diagnostic).toEqual({
      status: 'unknown',
      launchSource: 'embedded',
      updateId: EMBEDDED_UPDATE_ID,
      runtimeVersion: '1.0.0',
      channel: 'production',
      isEmergencyLaunch: false,
      applicationId: null,
      applicationVersion: null,
      nativeBuildVersion: null,
    });

    render(<ReleaseDiagnosticScreen />);
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered).not.toContain('wrong.example.app');
    expect(rendered).not.toContain('staff@example.org');
    expect(rendered).not.toContain('Bearer-secret');
    expect(
      screen.getByLabelText(
        'Evidence status: Unknown — do not use as release evidence',
      ),
    ).toBeTruthy();
    expectNoUpdateSideEffects();
  });

  test('keeps the route authenticated and source free of update or provider operations', () => {
    const layoutSource = readFileSync(
      join(__dirname, '../src/app/_layout.tsx'),
      'utf8',
    );
    const homeSource = readFileSync(
      join(__dirname, '../src/app/index.tsx'),
      'utf8',
    );
    const diagnosticSource = readFileSync(
      join(__dirname, '../src/lib/release/update-diagnostic.ts'),
      'utf8',
    );
    const screenSource = readFileSync(
      join(__dirname, '../src/app/release-diagnostic.tsx'),
      'utf8',
    );
    const protectedStart = layoutSource.indexOf(
      '<Stack.Protected guard={hasCachedShell}>',
    );
    const route = layoutSource.indexOf('name="release-diagnostic"');
    const protectedEnd = layoutSource.indexOf(
      '</Stack.Protected>',
      protectedStart,
    );

    expect(protectedStart).toBeGreaterThanOrEqual(0);
    expect(route).toBeGreaterThan(protectedStart);
    expect(route).toBeLessThan(protectedEnd);
    expect(layoutSource.indexOf('name="release-diagnostic"', route + 1)).toBe(
      -1,
    );
    expect(homeSource).toContain(
      'accessibilityLabel="Open release diagnostics"',
    );
    expect(homeSource).toContain(
      'accessibilityHint="Shows read-only launched-update identity"',
    );
    expect(homeSource).not.toContain(
      'accessibilityHint="Shows read-only build and launched-update identity"',
    );
    expect(homeSource).toContain("router.push('/release-diagnostic' as Href)");

    const executableSource = `${diagnosticSource}\n${screenSource}`;
    expect(executableSource).toContain(
      "import * as Updates from 'expo-updates';",
    );
    expect(executableSource).toContain(
      "import * as Application from 'expo-application';",
    );
    expect(executableSource).not.toMatch(
      /checkForUpdateAsync|fetchUpdateAsync|reloadAsync|readLogEntriesAsync|setExtraParamAsync|setUpdateRequestHeadersOverride|setUpdateURLAndRequestHeadersOverride|requestAuthenticated|executeCapability|\bfetch\s*\(|Linking\.openURL/iu,
    );
    expectNoUpdateSideEffects();
  });
});
