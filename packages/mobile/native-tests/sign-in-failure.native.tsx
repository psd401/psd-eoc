import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

const mockBeginGoogleSignIn = jest.fn(async () => {
  throw new Error('synthetic sign-in start failure');
});
const mockSignOut = jest.fn(async () => {});

jest.mock('../src/lib/auth', () => ({
  useMobileAuth: () => ({
    beginGoogleSignIn: mockBeginGoogleSignIn,
    isSigningIn: false,
    signInError: null,
    signOut: mockSignOut,
    state: { message: null, phase: 'signed-out' },
  }),
}));

import SignInScreen from '../src/app/(auth)/sign-in';

beforeEach(() => {
  process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = 'https://eoc.example.invalid';
  mockBeginGoogleSignIn.mockClear();
});

describe('sign-in failure feedback', () => {
  test('a sign-in that cannot start says so at the button and offers a retry', async () => {
    render(<SignInScreen />);

    // Nothing claims a failure before anyone presses anything.
    expect(screen.queryByText(/Sign-in did not start/iu)).toBeNull();

    fireEvent.press(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    );

    // The press has to repaint something next to the control it came from,
    // otherwise the button reads as dead.
    await waitFor(() => {
      expect(screen.getByText(/Sign-in did not start/iu)).toBeTruthy();
    });
    expect(screen.getByText(/could not start secure sign-in/iu)).toBeTruthy();

    const retry = screen.getByRole('button', {
      name: 'Try signing in again',
    });
    fireEvent.press(retry);

    await waitFor(() => {
      expect(mockBeginGoogleSignIn).toHaveBeenCalledTimes(2);
    });
  });
});
