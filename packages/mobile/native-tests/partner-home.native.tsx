import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import type * as ReactModule from 'react';
import type * as ReactNativeModule from 'react-native';

/**
 * Issue #598. What a partner may do on the home screen.
 *
 * The server refuses `create-activation-preview` and `start-event` for a
 * partner admission whatever this screen offers, but `list-facilities`
 * deliberately returns every non-isolated site in the district to a partner —
 * they need the names to read an event. Without this gate the screen would
 * therefore offer a start card per school that could only ever be refused.
 * Joining an active event is the one action a partner has here, and it stays.
 */

const mockFacility = Object.freeze({
  id: '00000000-0000-4000-8000-0000000000f1',
  code: 'STS',
  name: 'Synthetic Test School',
  isolated: false,
});

const mockActiveEvent = Object.freeze({
  event: {
    id: '00000000-0000-4000-8000-0000000000e1',
    facilityId: mockFacility.id,
    kind: 'real',
    templateMode: 'real',
    createdAt: '2026-08-10T17:30:00.000Z',
    activatedAt: '2026-08-10T17:30:00.000Z',
  },
  facilityName: mockFacility.name,
  eventTypeName: 'Synthetic lockdown',
});

const mockHomeData = Object.freeze({
  facilities: [mockFacility],
  eventTypes: [],
  threats: [],
  activeEvents: [mockActiveEvent],
});

let mockIsPartnerSession = false;

// The screen's effects depend on these by identity. Fresh objects per render
// would re-fire them forever, so every injected value is a stable singleton,
// exactly as the real hooks are.
const mockRouter = Object.freeze({ push: jest.fn(), replace: jest.fn() });
const mockRequestAuthenticated = jest.fn();
const mockRetryConnection = jest.fn(async () => {});
const mockAuthState = Object.freeze({
  message: null,
  phase: 'online',
  session: {
    session: { id: '00000000-0000-4000-8000-000000000012' },
    user: { id: '00000000-0000-4000-8000-000000000011' },
    deviceEnrollment: { id: '00000000-0000-4000-8000-000000000013' },
  },
});
const mockStartMutation = Object.freeze({
  acknowledge: jest.fn(() => true),
  acknowledgeUnresolved: jest.fn(),
  claimSuccessFeedback: jest.fn(() => null),
  continueWithoutRecovery: jest.fn(),
  isPendingNow: () => false,
  snapshot: Object.freeze({ phase: 'empty' }),
  submitJoin: jest.fn(() => ({ accepted: false })),
});

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof ReactModule>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      useEffect(effect, [effect]);
    },
    useIsFocused: () => true,
    useRouter: () => mockRouter,
  };
});

// The start components are the screen's vocabulary, not its policy. Every
// string this test asserts on lives in the screen itself; stubbing the
// components keeps their own native dependencies out of this render.
jest.mock('../src/components/start', () => {
  const { Text } = jest.requireActual<typeof ReactNativeModule>('react-native');
  const stub =
    (label: string) =>
    ({
      facilityName,
      mode,
    }: Readonly<{ facilityName?: string; mode?: string }>) => (
      <Text>{[label, mode, facilityName].filter(Boolean).join(' ')}</Text>
    );
  return {
    ActivationResult: stub('activation-result'),
    ActiveEventJoinAction: stub('join'),
    Call911Affordance: () => <Text>call 911</Text>,
    ISSUE_21_MAESTRO_IDS: {},
    OtherSessionStartMutationAttention: stub('other-session'),
    StartModeAction: stub('start'),
    StartMutationAttention: stub('attention'),
    StartMutationRecoveryBlockedAttention: stub('recovery-blocked'),
    StartMutationRecoveryCheckingAttention: stub('recovery-checking'),
    SyntheticModeBanner: () => <Text>synthetic</Text>,
    UnresolvedOutcomeNotice: stub('unresolved'),
    announceActivationResult: jest.fn(),
  };
});

jest.mock('../src/features/sms-consent/sms-consent-screen', () => ({
  SMS_CONSENT_TEST_IDS: { homeEntry: 'sms-consent-home-entry' },
}));

jest.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Success: 'success' },
  notificationAsync: jest.fn(async () => {}),
}));

jest.mock('../src/lib/auth', () => ({
  OFFLINE_ACTION_MESSAGE: 'Offline.',
  useMobileAuth: () => ({
    isPartnerSession: mockIsPartnerSession,
    requestAuthenticated: mockRequestAuthenticated,
    retryConnection: mockRetryConnection,
    state: mockAuthState,
  }),
}));

jest.mock('../src/lib/start', () => ({
  StartClientError: class StartClientError extends Error {},
  deliverClaimedStartMutationSuccessFeedback: jest.fn(),
  isIssue21SyntheticFixtureEnabled: () => false,
  loadStartHomeData: jest.fn(async () => mockHomeData),
  requestStartRouteNavigation: jest.fn(),
  useStartMutation: () => mockStartMutation,
  useStartMutationHardwareBackGuard: jest.fn(),
  useStartMutationNavigationGuard: jest.fn(),
}));

import HomeScreen from '../src/app/index';

beforeEach(() => {
  mockIsPartnerSession = false;
});

describe('the home screen for a partner', () => {
  test('staff keep the start section and its per-site modes', async () => {
    render(<HomeScreen />);
    await waitFor(() => {
      expect(screen.getByText('Start an event')).toBeTruthy();
    });
    expect(screen.getByText('STAFF EMERGENCY OPERATIONS')).toBeTruthy();
    expect(screen.getByText(mockFacility.name)).toBeTruthy();
  });

  test('a partner is never offered a way to start an event', async () => {
    mockIsPartnerSession = true;
    render(<HomeScreen />);

    // Active events still load and are still joinable.
    await waitFor(() => {
      expect(screen.getByText('Active events')).toBeTruthy();
    });

    expect(screen.queryByText('Start an event')).toBeNull();
    // The start card named each site; with the section gone, so is the
    // district-wide list of schools a partner would otherwise be shown.
    expect(screen.queryByText(mockFacility.code)).toBeNull();
    expect(
      screen.queryByText(
        'Choosing a site and mode does not start an event or notify anyone. You confirm before anything is sent.',
      ),
    ).toBeNull();
  });

  test('a partner is told whose job starting and ending an event is', async () => {
    mockIsPartnerSession = true;
    render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByText('PARTNER AGENCY OPERATIONS')).toBeTruthy();
    });
    expect(screen.queryByText('STAFF EMERGENCY OPERATIONS')).toBeNull();
    expect(
      screen.getByText(
        'Join an active event at a site you cover and post what you are seeing. District staff start and end events.',
      ),
    ).toBeTruthy();
  });
});
