import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

/**
 * Issue #647. The offer to add a passkey after an emailed-code sign-in.
 *
 * What is worth proving on a rendered screen is that the offer is absent
 * unless there is something to accept, that declining it is one press and
 * costs nothing, and that a failed enrollment says so where it happened —
 * never where it could be read as a problem with the session the partner
 * already has.
 */

const mockEnrollPartnerPasskey = jest.fn<() => Promise<boolean>>(
  async () => true,
);
const mockDismissPartnerPasskeyOffer = jest.fn(() => {});
let mockOffer: Readonly<{
  offered: boolean;
  busy: boolean;
  error: string | null;
}> = { offered: false, busy: false, error: null };

jest.mock('../src/lib/auth', () => ({
  useMobileAuth: () => ({
    partnerPasskeyOffer: mockOffer,
    enrollPartnerPasskey: mockEnrollPartnerPasskey,
    dismissPartnerPasskeyOffer: mockDismissPartnerPasskeyOffer,
  }),
}));

import {
  PARTNER_PASSKEY_OFFER_TEST_IDS,
  PartnerPasskeyOffer,
} from '../src/components/partner-passkey-offer';

beforeEach(() => {
  mockEnrollPartnerPasskey.mockClear();
  mockDismissPartnerPasskeyOffer.mockClear();
  mockOffer = { offered: false, busy: false, error: null };
});

describe('the partner passkey offer', () => {
  test('is absent unless the server and the device both allow one', () => {
    // The provider makes the offer only when it holds a hand-off and the
    // device can run a ceremony, so an absent offer is the common case and
    // must render nothing at all.
    render(<PartnerPasskeyOffer />);
    expect(
      screen.queryByTestId(PARTNER_PASSKEY_OFFER_TEST_IDS.offer),
    ).toBeNull();
  });

  test('adds a passkey on one press', async () => {
    mockOffer = { offered: true, busy: false, error: null };
    render(<PartnerPasskeyOffer />);
    expect(
      screen.getByTestId(PARTNER_PASSKEY_OFFER_TEST_IDS.offer),
    ).toBeTruthy();
    // The copy says plainly that the emailed code keeps working, because a
    // partner must not read this as losing the path they already have.
    expect(
      screen.getByText(/Your emailed code keeps working either way\./u),
    ).toBeTruthy();

    fireEvent.press(screen.getByTestId(PARTNER_PASSKEY_OFFER_TEST_IDS.add));
    await waitFor(() => {
      expect(mockEnrollPartnerPasskey).toHaveBeenCalledTimes(1);
    });
  });

  test('declining it enrolls nothing', () => {
    mockOffer = { offered: true, busy: false, error: null };
    render(<PartnerPasskeyOffer />);
    fireEvent.press(screen.getByTestId(PARTNER_PASSKEY_OFFER_TEST_IDS.dismiss));
    expect(mockDismissPartnerPasskeyOffer).toHaveBeenCalledTimes(1);
    expect(mockEnrollPartnerPasskey).not.toHaveBeenCalled();
  });

  test('nothing is pressable while a ceremony is running', () => {
    mockOffer = { offered: true, busy: true, error: null };
    render(<PartnerPasskeyOffer />);
    fireEvent.press(screen.getByTestId(PARTNER_PASSKEY_OFFER_TEST_IDS.add));
    fireEvent.press(screen.getByTestId(PARTNER_PASSKEY_OFFER_TEST_IDS.dismiss));
    expect(mockEnrollPartnerPasskey).not.toHaveBeenCalled();
    expect(mockDismissPartnerPasskeyOffer).not.toHaveBeenCalled();
    expect(screen.getByText('Adding a passkey')).toBeTruthy();
  });

  test('a failed enrollment is reported here, beside the offer', () => {
    mockOffer = {
      offered: true,
      busy: false,
      error:
        'PSD EOC could not add a passkey to this device. Your emailed code still works.',
    };
    render(<PartnerPasskeyOffer />);
    expect(
      screen.getByText(
        'PSD EOC could not add a passkey to this device. Your emailed code still works.',
      ),
    ).toBeTruthy();
    // And the offer stays, so the partner may try again or put it away.
    expect(screen.getByTestId(PARTNER_PASSKEY_OFFER_TEST_IDS.add)).toBeTruthy();
  });
});
