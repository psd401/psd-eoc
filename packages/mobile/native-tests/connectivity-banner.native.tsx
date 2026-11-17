import { describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

const mockRetryConnection = jest.fn(async () => {});
let mockAuthPhase = 'offline-cached';

jest.mock('../src/lib/auth/auth-provider', () => ({
  useMobileAuth: () => ({
    retryConnection: mockRetryConnection,
    state: { phase: mockAuthPhase },
  }),
}));

import { ConnectivityBanner } from '../src/lib/auth/connectivity-banner';

// The banner's outermost host view is the safe-area native view. Its edges
// prop is what reaches native: the top, left, and right insets are applied and
// the bottom is not, which is SafeAreaView edges={['top', 'left', 'right']}.
const BANNER_NATIVE_EDGES = {
  top: 'additive',
  right: 'additive',
  bottom: 'off',
  left: 'additive',
};

describe('connectivity banner native safe-area boundary', () => {
  test('keeps the visible retry target below the top inset and invokes one retry', async () => {
    mockAuthPhase = 'offline-cached';
    await render(<ConnectivityBanner />);

    const safeArea = screen.root;
    expect(safeArea?.type).toBe('RNCSafeAreaView');
    expect(safeArea?.props.edges).toEqual(BANNER_NATIVE_EDGES);
    expect(safeArea?.props.accessibilityRole).toBe('alert');

    await fireEvent.press(
      screen.getByRole('button', { name: 'Retry secure connection' }),
    );
    expect(mockRetryConnection).toHaveBeenCalledTimes(1);
  });

  test('keeps checking copy below the top inset without exposing retry', async () => {
    mockAuthPhase = 'cached-checking';
    await render(<ConnectivityBanner />);

    expect(screen.root?.type).toBe('RNCSafeAreaView');
    expect(screen.root?.props.edges).toEqual(BANNER_NATIVE_EDGES);
    expect(screen.getByText('Checking secure connection')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Retry secure connection' }),
    ).toBeNull();
  });
});
