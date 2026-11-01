import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

/**
 * Issue #598. The third sign-in flow: an invited partner agency responder
 * proves one address with an emailed code, inside the app, with no browser
 * redirect. Google and app-store review sign-in must be untouched by it —
 * Play has rejected sign-in changes three times.
 */

const mockRequestPartnerCode = jest.fn<(email: string) => Promise<boolean>>(
  async () => true,
);
const mockCompletePartnerSignIn = jest.fn<(code: string) => Promise<void>>(
  async () => {},
);
const mockResetPartnerSignIn = jest.fn(() => {});
const mockBeginGoogleSignIn = jest.fn(async () => {});
const mockBeginAppReviewSignIn = jest.fn(async () => {});
let mockPartnerCodeRequested = false;
let mockSignInError: string | null = null;
let mockIsSigningIn = false;

jest.mock('../src/lib/auth', () => ({
  useMobileAuth: () => ({
    beginAppReviewSignIn: mockBeginAppReviewSignIn,
    beginGoogleSignIn: mockBeginGoogleSignIn,
    completePartnerSignIn: mockCompletePartnerSignIn,
    isSigningIn: mockIsSigningIn,
    partnerCodeRequested: mockPartnerCodeRequested,
    requestPartnerCode: mockRequestPartnerCode,
    resetPartnerSignIn: mockResetPartnerSignIn,
    signInError: mockSignInError,
    signOut: jest.fn(async () => {}),
    state: { message: null, phase: 'signed-out' },
  }),
}));

import SignInScreen, {
  PARTNER_SIGN_IN_TEST_IDS,
  partnerCodeDigits,
} from '../src/app/(auth)/sign-in';

beforeEach(() => {
  process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = 'https://eoc.example.invalid';
  mockRequestPartnerCode.mockClear();
  mockCompletePartnerSignIn.mockClear();
  mockResetPartnerSignIn.mockClear();
  mockBeginGoogleSignIn.mockClear();
  mockBeginAppReviewSignIn.mockClear();
  mockPartnerCodeRequested = false;
  mockSignInError = null;
  mockIsSigningIn = false;
});

function openPartner(): void {
  fireEvent.press(
    screen.getByRole('button', { name: 'Partner agency sign-in' }),
  );
}

describe('partner agency sign-in', () => {
  test('is hidden until asked for, so staff see only Google sign-in', () => {
    render(<SignInScreen />);
    expect(screen.queryByTestId(PARTNER_SIGN_IN_TEST_IDS.email)).toBeNull();
    // Google is still the one thing on the card.
    expect(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    ).toBeTruthy();

    openPartner();
    expect(screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.email)).toBeTruthy();
    // The code step belongs to the second step only.
    expect(screen.queryByTestId(PARTNER_SIGN_IN_TEST_IDS.code)).toBeNull();
  });

  test('asks the pool for a code, and never through Google or app review', async () => {
    render(<SignInScreen />);
    openPartner();

    const request = screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.requestCode);
    // An empty address sends nothing.
    fireEvent.press(request);
    expect(mockRequestPartnerCode).not.toHaveBeenCalled();

    fireEvent.changeText(
      screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.email),
      'responder@agency.example.invalid',
    );
    fireEvent.press(request);

    await waitFor(() => {
      expect(mockRequestPartnerCode).toHaveBeenCalledWith(
        'responder@agency.example.invalid',
      );
    });
    expect(mockBeginGoogleSignIn).not.toHaveBeenCalled();
    expect(mockBeginAppReviewSignIn).not.toHaveBeenCalled();
  });

  test('the code field offers the OS one-time-code autofill on both platforms', () => {
    mockPartnerCodeRequested = true;
    render(<SignInScreen />);
    openPartner();

    const code = screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.code);
    // `one-time-code` is the cross-platform value: iOS reads it as the
    // one-time-code content type and Android as its OTP autofill hint.
    expect(code.props.autoComplete).toBe('one-time-code');
    expect(code.props.textContentType).toBe('oneTimeCode');
    // A numeric pad, not a secure field: the code is pasteable and visible,
    // which is what makes a pasted or autofilled code land intact.
    expect(code.props.keyboardType).toBe('number-pad');
    expect(code.props.secureTextEntry).toBeFalsy();
  });

  test('a pasted code keeps its digits and drops the rest', () => {
    // Paste and autofill both arrive as one text change. Mail clients and
    // password managers hand over padding and punctuation around the code.
    expect(partnerCodeDigits(' 123 456 ')).toBe('123456');
    expect(partnerCodeDigits('Your code is 123456.')).toBe('123456');
    expect(partnerCodeDigits('12345678901234')).toBe('12345678');
    expect(partnerCodeDigits('no digits here')).toBe('');
  });

  test('answers the outstanding flow with the code once it is long enough', async () => {
    mockPartnerCodeRequested = true;
    render(<SignInScreen />);
    openPartner();

    const verify = screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.verify);
    const code = screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.code);

    fireEvent.changeText(code, '123');
    fireEvent.press(verify);
    expect(mockCompletePartnerSignIn).not.toHaveBeenCalled();

    fireEvent.changeText(code, '1 2 3 4 5 6');
    fireEvent.press(verify);

    await waitFor(() => {
      expect(mockCompletePartnerSignIn).toHaveBeenCalledWith('123456');
    });
  });

  test('a refused code says so beside the form and offers another address', async () => {
    mockPartnerCodeRequested = true;
    mockSignInError = 'The sign-in details were not accepted.';
    render(<SignInScreen />);
    openPartner();

    fireEvent.changeText(
      screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.code),
      '999999',
    );
    fireEvent.press(screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.verify));

    await waitFor(() => {
      expect(screen.getByText('Partner sign-in did not complete')).toBeTruthy();
    });
    // One message for every refusal: a wrong code, no admission, an ended
    // admission and a disabled account all read the same.
    expect(
      screen.getByText('The sign-in details were not accepted.'),
    ).toBeTruthy();

    fireEvent.press(screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.startOver));
    expect(mockResetPartnerSignIn).toHaveBeenCalled();
  });

  test('nothing is submittable while a request is already in flight', () => {
    mockPartnerCodeRequested = true;
    mockIsSigningIn = true;
    render(<SignInScreen />);
    openPartner();

    fireEvent.changeText(
      screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.code),
      '123456',
    );
    fireEvent.press(screen.getByTestId(PARTNER_SIGN_IN_TEST_IDS.verify));
    expect(mockCompletePartnerSignIn).not.toHaveBeenCalled();
  });
});
