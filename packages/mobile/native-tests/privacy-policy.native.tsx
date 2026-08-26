import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { Linking } from 'react-native';

const mockBeginGoogleSignIn = jest.fn(async () => {});
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
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

describe('mobile privacy-policy access', () => {
  test('opens the configured application privacy route before sign-in', async () => {
    render(<SignInScreen />);

    fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));

    await waitFor(() => {
      expect(Linking.openURL).toHaveBeenCalledWith(
        'https://eoc.example.invalid/privacy',
      );
    });
    expect(
      screen.getAllByText(/designated staff access group/iu).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Peninsula School District/iu)).toBeNull();
    expect(screen.queryByText(/PSD Google Group/iu)).toBeNull();
  });

  test('reports a failed browser handoff without blocking sign-in', async () => {
    jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValueOnce(new Error('synthetic browser failure'));
    render(<SignInScreen />);

    fireEvent.press(screen.getByRole('link', { name: 'Privacy policy' }));

    await waitFor(() => {
      expect(
        screen.getByText(/could not open the privacy policy/iu),
      ).toBeTruthy();
    });
    expect(screen.getByText('Action needs attention')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Sign in with Google' }),
    ).toBeTruthy();
  });
});
