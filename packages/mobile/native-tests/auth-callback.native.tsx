import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

const mockCompleteGoogleSignIn = jest.fn<(...args: string[]) => Promise<void>>(
  async () => {},
);
const mockReplace = jest.fn();

let mockParams: Record<string, string | string[] | undefined> = {};
let mockIsSigningIn = false;
let mockHasCachedShell = false;
let mockSignInError: string | null = null;

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('../src/lib/auth', () => ({
  useMobileAuth: () => ({
    completeGoogleSignIn: mockCompleteGoogleSignIn,
    hasCachedShell: mockHasCachedShell,
    isSigningIn: mockIsSigningIn,
    signInError: mockSignInError,
  }),
}));

import AuthCallbackScreen from '../src/app/auth/callback';

const CODE = 'synthetic-authorization-code';
const STATE = `m1.${'S'.repeat(43)}`;

beforeEach(() => {
  mockParams = {};
  mockIsSigningIn = false;
  mockHasCachedShell = false;
  mockSignInError = null;
  mockCompleteGoogleSignIn.mockClear();
  mockReplace.mockClear();
});

describe('android OIDC callback route', () => {
  test('resumes a cold-started redirect instead of discarding the code', async () => {
    // The process was restarted by the intent, so no promptAsync is listening.
    mockParams = { code: CODE, state: STATE };

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(mockCompleteGoogleSignIn).toHaveBeenCalledTimes(1);
    });
    expect(mockCompleteGoogleSignIn).toHaveBeenCalledWith(CODE, STATE);
  });

  test('shows a completing state while the resume is in flight', async () => {
    mockParams = { code: CODE, state: STATE };
    // Never settles, which is exactly the window this screen exists to cover.
    mockCompleteGoogleSignIn.mockImplementation(() => new Promise(() => {}));

    render(<AuthCallbackScreen />);
    await act(async () => {});

    expect(screen.getByText('Completing sign-in')).toBeTruthy();
    expect(screen.queryByText('Sign-in did not complete')).toBeNull();
  });

  test('leaves for the guarded home once enrollment succeeds', async () => {
    mockParams = { code: CODE, state: STATE };
    mockCompleteGoogleSignIn.mockImplementation(async () => {
      mockHasCachedShell = true;
    });

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
  });

  test('does not resume while promptAsync still owns the redirect', async () => {
    // iOS, and the Android case where the in-process listener is still alive.
    mockIsSigningIn = true;
    mockParams = { code: CODE, state: STATE };

    render(<AuthCallbackScreen />);

    await act(async () => {});
    expect(mockCompleteGoogleSignIn).not.toHaveBeenCalled();
    expect(screen.getByText('Completing sign-in')).toBeTruthy();
  });

  test('shows a sign-in error for a callback with no authorization code', async () => {
    mockParams = { state: STATE };

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(screen.getByText('Sign-in did not complete')).toBeTruthy();
    });
    expect(mockCompleteGoogleSignIn).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Google did not return a usable sign-in result/u),
    ).toBeTruthy();
  });

  test('shows a sign-in error for a callback with no state', async () => {
    mockParams = { code: CODE };

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(screen.getByText('Sign-in did not complete')).toBeTruthy();
    });
    expect(mockCompleteGoogleSignIn).not.toHaveBeenCalled();
  });

  test('refuses a repeated query parameter rather than guessing a value', async () => {
    mockParams = { code: [CODE, 'second-code'], state: STATE };

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(screen.getByText('Sign-in did not complete')).toBeTruthy();
    });
    expect(mockCompleteGoogleSignIn).not.toHaveBeenCalled();
  });

  test('reports a provider refusal without attempting an exchange', async () => {
    mockParams = { error: 'access_denied', state: STATE };

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(
        screen.getByText(/Google refused the sign-in attempt/u),
      ).toBeTruthy();
    });
    expect(mockCompleteGoogleSignIn).not.toHaveBeenCalled();
  });

  test('surfaces the failure reason when the resume is rejected', async () => {
    mockParams = { code: CODE, state: STATE };
    mockCompleteGoogleSignIn.mockImplementation(async () => {
      mockSignInError = 'Your district account is not in a designated group.';
    });

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(
        screen.getByText('Your district account is not in a designated group.'),
      ).toBeTruthy();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('offers a way back to sign-in that never dead-ends', async () => {
    mockParams = {};

    render(<AuthCallbackScreen />);

    await waitFor(() => {
      expect(screen.getByText('Sign-in did not complete')).toBeTruthy();
    });
    fireEvent.press(screen.getByRole('button', { name: 'Return to sign-in' }));
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  test('resumes only once even when the screen re-renders', async () => {
    mockParams = { code: CODE, state: STATE };

    const view = render(<AuthCallbackScreen />);
    await waitFor(() => {
      expect(mockCompleteGoogleSignIn).toHaveBeenCalledTimes(1);
    });
    view.rerender(<AuthCallbackScreen />);
    await act(async () => {});

    expect(mockCompleteGoogleSignIn).toHaveBeenCalledTimes(1);
  });
});
