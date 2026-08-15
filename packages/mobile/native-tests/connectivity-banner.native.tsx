import { describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const mockRetryConnection = jest.fn(async () => {});
let mockAuthPhase = 'offline-cached';

jest.mock('../src/lib/auth/auth-provider', () => ({
  useMobileAuth: () => ({
    retryConnection: mockRetryConnection,
    state: { phase: mockAuthPhase },
  }),
}));

import { ConnectivityBanner } from '../src/lib/auth/connectivity-banner';

describe('connectivity banner native safe-area boundary', () => {
  test('keeps the visible retry target below the top inset and invokes one retry', () => {
    mockAuthPhase = 'offline-cached';
    render(<ConnectivityBanner />);

    const safeArea = screen.UNSAFE_getByType(SafeAreaView);
    expect(safeArea.props.edges).toEqual(['top', 'left', 'right']);
    expect(safeArea.props.accessibilityRole).toBe('alert');

    fireEvent.press(
      screen.getByRole('button', { name: 'Retry secure connection' }),
    );
    expect(mockRetryConnection).toHaveBeenCalledTimes(1);
  });

  test('keeps checking copy below the top inset without exposing retry', () => {
    mockAuthPhase = 'cached-checking';
    render(<ConnectivityBanner />);

    expect(screen.UNSAFE_getByType(SafeAreaView).props.edges).toEqual([
      'top',
      'left',
      'right',
    ]);
    expect(screen.getByText('Checking secure connection')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Retry secure connection' }),
    ).toBeNull();
  });
});
