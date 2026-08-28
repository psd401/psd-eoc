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

  test('refuses a build whose own runtime says it cannot be trusted', () => {
    const mutations: ReadonlyArray<
      readonly [string, Partial<ReadOnlyUpdateConstants>, string]
    > = [
      [
        'remote updates on',
        { isEnabled: true },
        'Remote updates are not switched off.',
      ],
      [
        'downloaded update running',
        { updateId: 'unexpected' },
        'A downloaded update is running.',
      ],
      [
        'emergency fallback',
        { isEmergencyLaunch: true },
        'The application started in emergency recovery.',
      ],
      [
        'application identifier malformed',
        { applicationId: 'not-an-identifier' },
        'The application identifier is unavailable.',
      ],
      [
        'configuration names a different application',
        { configuredApplicationId: 'org.example.other' },
        'The application identifier is unavailable.',
      ],
      [
        'installed version malformed',
        { applicationVersion: 'Bearer-secret' },
        'The application version is unavailable.',
      ],
      [
        'build number malformed',
        { nativeBuildVersion: 'staff@example.org' },
        'The build number is unavailable.',
      ],
    ];

    for (const [name, mutation, reason] of mutations) {
      const diagnostic = createLaunchedUpdateDiagnostic({
        ...validEmbeddedOnlyConstants(),
        ...mutation,
      });
      expect({ name, status: diagnostic.status }).toEqual({
        name,
        status: 'unknown',
      });
      // A refusal has to say what was missing, or the screen can only say no.
      expect({ name, reasons: diagnostic.unmetConditions }).toEqual({
        name,
        reasons: [reason],
      });
      expect(Object.isFrozen(diagnostic)).toBe(true);
    }
  });

  test('confirms a release build that does not restate its own configuration', () => {
    // A release build resolves and rewrites parts of the application
    // configuration, so requiring it to echo the build back rejected correct
    // devices. Only the running binary's own facts decide.
    const releaseShapes: ReadonlyArray<
      readonly [string, Partial<ReadOnlyUpdateConstants>]
    > = [
      [
        'configuration absent',
        {
          configuredUpdatesEnabled: undefined,
          configuredCheckAutomatically: undefined,
          configuredUpdateUrl: undefined,
          configuredApplicationVersion: undefined,
          configuredApplicationId: undefined,
          configuredRuntimeVersion: undefined,
        },
      ],
      [
        'runtime version resolved to a string',
        { configuredRuntimeVersion: '1.0.2' },
      ],
      ['native runtime version reported', { runtimeVersion: '1.0.2' }],
      ['channel reported', { channel: 'production' }],
      ['automatic checking unreported', { checkAutomatically: undefined }],
      ['embedded asset flag unreported', { isUsingEmbeddedAssets: undefined }],
      ['update identifier undefined', { updateId: undefined }],
    ];

    for (const [name, mutation] of releaseShapes) {
      const diagnostic = createLaunchedUpdateDiagnostic({
        ...validEmbeddedOnlyConstants(),
        ...mutation,
      });
      expect({
        name,
        status: diagnostic.status,
        reasons: diagnostic.unmetConditions,
      }).toEqual({
        name,
        status: 'known',
        reasons: [],
      });
      expect(diagnostic.applicationId).toBe('org.example.eoc');
      expect(diagnostic.nativeBuildVersion).toBe('3');
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
