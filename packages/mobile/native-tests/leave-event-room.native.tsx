import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

// Jest only permits a mock factory to close over names prefixed `mock`.
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockCanGoBack = jest.fn<() => boolean>();

jest.mock('expo-router', () => ({
  Redirect: () => null,
  Stack: Object.assign(() => null, { Screen: () => null }),
  useRouter: () => ({
    back: mockBack,
    replace: mockReplace,
    canGoBack: mockCanGoBack,
  }),
}));

jest.mock('../src/lib/auth', () => ({
  useMobileAuth: () => ({ hasCachedShell: true, state: { phase: 'online' } }),
}));

import { LeaveEventRoomButton } from '../src/app/(app)/_layout';

describe('leaving the event room', () => {
  beforeEach(() => {
    mockBack.mockClear();
    mockReplace.mockClear();
    mockCanGoBack.mockReset();
  });

  test('returns to the event list when the room is its own root', () => {
    // A room opened from a push notification is the first screen in this
    // stack, so the navigator renders no back control. Without this the
    // operator who ended an event had no way out and had to force-quit.
    mockCanGoBack.mockReturnValue(false);
    render(<LeaveEventRoomButton />);
    fireEvent.press(screen.getByRole('button', { name: 'Events' }));
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockBack).not.toHaveBeenCalled();
  });

  test('goes back when there is somewhere to go back to', () => {
    mockCanGoBack.mockReturnValue(true);
    render(<LeaveEventRoomButton />);
    fireEvent.press(screen.getByRole('button', { name: 'Events' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
