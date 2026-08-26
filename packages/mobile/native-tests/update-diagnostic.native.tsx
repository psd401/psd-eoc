import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockUpdateConstants: {
  isEnabled: unknown;
  isEmbeddedLaunch: unknown;
  isUsingEmbeddedAssets: unknown;
  isEmergencyLaunch: unknown;
  checkAutomatically: unknown;
  updateId: unknown;
  runtimeVersion: unknown;
  channel: unknown;
  applicationId: unknown;
  applicationVersion: unknown;
  nativeBuildVersion: unknown;
} = {
  isEnabled: false,
  isEmbeddedLaunch: false,
  isUsingEmbeddedAssets: true,
  isEmergencyLaunch: false,
  checkAutomatically: 'NEVER',
  updateId: null,
  runtimeVersion: '',
  channel: '',
  applicationId: 'org.example.eoc',
  applicationVersion: '1.0.2',
  nativeBuildVersion: '3',
};

let mockExpoConfig: unknown = {
  version: '1.0.2',
  ios: { bundleIdentifier: 'org.example.eoc' },
  android: { package: 'org.example.eoc' },
  runtimeVersion: { policy: 'appVersion' },
  updates: {
    enabled: false,
    checkAutomatically: 'NEVER',
  },
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

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
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
  get isUsingEmbeddedAssets() {
    return mockUpdateConstants.isUsingEmbeddedAssets;
  },
  get isEmergencyLaunch() {
    return mockUpdateConstants.isEmergencyLaunch;
  },
  get checkAutomatically() {
    return mockUpdateConstants.checkAutomatically;
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
import {
  createLaunchedUpdateDiagnostic,
  type ReadOnlyUpdateConstants,
} from '../src/lib/release/update-diagnostic';

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

function validEmbeddedOnlyConstants(): ReadOnlyUpdateConstants {
  return {
    ...mockUpdateConstants,
    configuredUpdatesEnabled: false,
    configuredCheckAutomatically: 'NEVER',
    configuredUpdateUrl: undefined,
    configuredApplicationVersion: '1.0.2',
    configuredApplicationId: 'org.example.eoc',
    configuredRuntimeVersion: { policy: 'appVersion' },
  };
}

describe('authenticated release diagnostic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockUpdateConstants, {
      isEnabled: false,
      isEmbeddedLaunch: false,
      isUsingEmbeddedAssets: true,
      isEmergencyLaunch: false,
      checkAutomatically: 'NEVER',
      updateId: null,
      runtimeVersion: '',
      channel: '',
      applicationId: 'org.example.eoc',
      applicationVersion: '1.0.2',
      nativeBuildVersion: '3',
    });
    mockExpoConfig = {
      version: '1.0.2',
      ios: { bundleIdentifier: 'org.example.eoc' },
      android: { package: 'org.example.eoc' },
      runtimeVersion: { policy: 'appVersion' },
      updates: {
        enabled: false,
        checkAutomatically: 'NEVER',
      },
    };
  });

  test('shows verified embedded-only identity as accessible read-only evidence', () => {
    render(<ReleaseDiagnosticScreen />);

    expect(
      screen.getByRole('header', { name: 'Release diagnostics' }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Evidence status: Identity available'),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Application ID: org.example.eoc'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Application version: 1.0.2')).toBeTruthy();
    expect(screen.getByLabelText('Native build version: 3')).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Remote updates: Disabled — embedded store bundle only',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Launch source: Embedded in this installed binary'),
    ).toBeTruthy();
    expect(
      screen.getByText(/physical TestFlight or Google Play installation/iu),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Remote update ID: Not applicable — remote updates disabled',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Configured runtime version: 1.0.2'),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Remote update channel: Not applicable — remote updates disabled',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Emergency launch: No')).toBeTruthy();
    expect(screen.getAllByText('1.0.2')).toHaveLength(2);
    for (const version of screen.getAllByText('1.0.2')) {
      expect(version.props.selectable).toBe(true);
    }
    expect(
      screen.getByText(/cannot check for, download, apply, or publish/iu),
    ).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).not.toContain('OTA verifier');
    expectNoUpdateSideEffects();
  });

  test('accepts only the exact deliberate embedded-only native and app config fingerprint', () => {
    const mutations: ReadonlyArray<
      readonly [string, Partial<ReadOnlyUpdateConstants>]
    > = [
      ['native service enabled', { isEnabled: true }],
      ['config still enables updates', { configuredUpdatesEnabled: true }],
      ['config missing', { configuredUpdatesEnabled: undefined }],
      ['native automatic checking', { checkAutomatically: 'ON_LOAD' }],
      [
        'configured automatic checking',
        { configuredCheckAutomatically: 'ON_LOAD' },
      ],
      [
        'configured update URL',
        { configuredUpdateUrl: 'https://example.test' },
      ],
      ['native embedded marker drift', { isEmbeddedLaunch: true }],
      ['embedded assets missing', { isUsingEmbeddedAssets: false }],
      ['emergency fallback', { isEmergencyLaunch: true }],
      ['unexpected update ID', { updateId: 'unexpected' }],
      ['unexpected native runtime', { runtimeVersion: '1.0.1' }],
      ['unexpected channel', { channel: 'production' }],
      [
        'configured version mismatch',
        { configuredApplicationVersion: '1.0.0' },
      ],
      [
        'configured application ID mismatch',
        { configuredApplicationId: 'org.example.other' },
      ],
      [
        'runtime policy mismatch',
        { configuredRuntimeVersion: { policy: 'sdkVersion' } },
      ],
      ['application ID mismatch', { applicationId: 'wrong.example.app' }],
      ['installed version malformed', { applicationVersion: 'Bearer-secret' }],
      ['build version malformed', { nativeBuildVersion: 'staff@example.org' }],
    ];

    for (const [name, mutation] of mutations) {
      const diagnostic = createLaunchedUpdateDiagnostic({
        ...validEmbeddedOnlyConstants(),
        ...mutation,
      });
      const expectedEmergencyLaunch =
        mutation.isEmergencyLaunch === true ? true : null;
      expect({ name, diagnostic }).toEqual({
        name,
        diagnostic: {
          status: 'unknown',
          mode: 'unknown',
          launchSource: 'unknown',
          updateId: null,
          runtimeVersion: null,
          channel: null,
          isEmergencyLaunch: expectedEmergencyLaunch,
          applicationId: null,
          applicationVersion: null,
          configuredRuntimeVersion: null,
          nativeBuildVersion: null,
        },
      });
      expect(Object.isFrozen(diagnostic)).toBe(true);
    }
  });

  test('scrubs invalid values from the rendered unknown state', () => {
    Object.assign(mockUpdateConstants, {
      isEnabled: true,
      isEmergencyLaunch: true,
      updateId: 'Bearer secret-provider-token',
      runtimeVersion: '1.0.1\nstaff@example.org',
      channel: 'production',
      applicationId: 'wrong.example.app',
      applicationVersion: 'Bearer-secret',
      nativeBuildVersion: 'staff@example.org',
    });
    mockExpoConfig = null;

    render(<ReleaseDiagnosticScreen />);

    expect(
      screen.getByLabelText(
        'Evidence status: Unknown — do not use as release evidence',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Launch source: Unknown')).toBeTruthy();
    expect(screen.getByText('Emergency fallback is active')).toBeTruthy();
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered).not.toContain('secret-provider-token');
    expect(rendered).not.toContain('staff@example.org');
    expect(rendered).not.toContain('wrong.example.app');
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
      'accessibilityHint="Shows read-only installed release identity"',
    );
    expect(homeSource).toContain("router.push('/release-diagnostic' as Href)");

    const executableSource = `${diagnosticSource}\n${screenSource}`;
    expect(executableSource).toContain(
      "import * as Updates from 'expo-updates';",
    );
    expect(executableSource).toContain(
      "import * as Application from 'expo-application';",
    );
    expect(executableSource).toContain(
      "import Constants from 'expo-constants';",
    );
    expect(executableSource).not.toContain('net.psd401.eoc');
    expect(executableSource).not.toMatch(
      /checkForUpdateAsync|fetchUpdateAsync|reloadAsync|readLogEntriesAsync|setExtraParamAsync|setUpdateRequestHeadersOverride|setUpdateURLAndRequestHeadersOverride|requestAuthenticated|executeCapability|\bfetch\s*\(|Linking\.openURL/iu,
    );
    expectNoUpdateSideEffects();
  });
});
