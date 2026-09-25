import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

const mockBeginAppReviewSignIn = jest.fn<
  (email: string, code: string) => Promise<void>
>(async () => {});
const mockBeginGoogleSignIn = jest.fn(async () => {});
let mockSignInError: string | null = null;

jest.mock('../src/lib/auth', () => ({
  useMobileAuth: () => ({
    beginAppReviewSignIn: mockBeginAppReviewSignIn,
    beginGoogleSignIn: mockBeginGoogleSignIn,
    isSigningIn: false,
    signInError: mockSignInError,
    signOut: jest.fn(async () => {}),
    state: { message: null, phase: 'signed-out' },
  }),
}));

import SignInScreen from '../src/app/(auth)/sign-in';

beforeEach(() => {
  process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = 'https://eoc.example.invalid';
  mockBeginAppReviewSignIn.mockClear();
  mockBeginGoogleSignIn.mockClear();
  mockSignInError = null;
});

function openReview(): void {
  fireEvent.press(
    screen.getByRole('button', { name: 'App store review sign-in' }),
  );
}

describe('app store review sign-in', () => {
  test('is hidden until asked for, so staff see only Google sign-in', () => {
    render(<SignInScreen />);
    expect(screen.queryByTestId('app-review-email')).toBeNull();
    openReview();
    expect(screen.getByTestId('app-review-email')).toBeTruthy();
    expect(screen.getByTestId('app-review-code')).toBeTruthy();
  });

  test('signs in with the review account and code, never through Google', async () => {
    render(<SignInScreen />);
    openReview();

    const submit = screen.getByRole('button', {
      name: 'Sign in for app review',
    });
    // Nothing to send until both fields are filled.
    fireEvent.press(submit);
    expect(mockBeginAppReviewSignIn).not.toHaveBeenCalled();

    fireEvent.changeText(
      screen.getByTestId('app-review-email'),
      'review@example.invalid',
    );
    fireEvent.changeText(
      screen.getByTestId('app-review-code'),
      'synthetic-review-code-0123',
    );
    fireEvent.press(submit);

    await waitFor(() => {
      expect(mockBeginAppReviewSignIn).toHaveBeenCalledWith(
        'review@example.invalid',
        'synthetic-review-code-0123',
      );
    });
    expect(mockBeginGoogleSignIn).not.toHaveBeenCalled();
  });

  test('says why a refused review sign-in failed, next to the form', async () => {
    mockSignInError = 'The review sign-in details were not accepted.';
    render(<SignInScreen />);
    openReview();
    fireEvent.changeText(
      screen.getByTestId('app-review-email'),
      'review@example.invalid',
    );
    fireEvent.changeText(screen.getByTestId('app-review-code'), 'wrong-code');
    fireEvent.press(
      screen.getByRole('button', { name: 'Sign in for app review' }),
    );

    await waitFor(() => {
      expect(screen.getByText('Review sign-in did not complete')).toBeTruthy();
    });
    expect(
      screen.getByText('The review sign-in details were not accepted.'),
    ).toBeTruthy();
  });
});
