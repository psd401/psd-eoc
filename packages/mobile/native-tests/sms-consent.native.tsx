import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';

const DISCLOSURE = {
  version: '2026-09-04',
  summary:
    'Example School District will text emergency notifications from PSD EOC to the mobile number you enter below.',
  terms: [
    'PSD EOC texts you only about emergency activations, drills, and the delivery tests that prove the system still reaches you. It is never used for marketing.',
    'Message frequency varies with real events and scheduled drills.',
    'Message and data rates may apply.',
    'Reply STOP to any PSD EOC text to stop receiving them. To start again, text START or UNSTOP to that same number.',
    'Reply HELP for help, or contact servicecentral@example.invalid or +12535550123.',
    'Your mobile number and this consent record are used only to notify you and to show a carrier that the message was permitted. They are not sold or shared for marketing.',
  ],
  agreementLabel:
    'I agree to receive emergency text messages from PSD EOC at this number.',
  privacyPolicyUrl: 'https://eoc.example.invalid/privacy',
};

const mockRequestAuthenticated = jest.fn();

jest.mock('../src/lib/auth', () => ({
  useMobileAuth: () => ({ requestAuthenticated: mockRequestAuthenticated }),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
}));

import {
  SMS_CONSENT_TEST_IDS,
  SmsConsentScreen,
} from '../src/features/sms-consent/sms-consent-screen';

function respondWith(consent: unknown) {
  mockRequestAuthenticated.mockImplementation(
    // The screen passes its own schema; the transport is mocked, so the
    // fixture stands in for a parsed server response.
    (async (options: { method: string }) =>
      options.method === 'GET'
        ? { consent, disclosure: DISCLOSURE }
        : {
            consentId: '11111111-1111-4111-8111-111111111111',
            disclosureVersion: DISCLOSURE.version,
            status: 'consented',
            recordedAt: '2026-09-04T00:00:00.000Z',
          }) as never,
  );
}

beforeEach(() => {
  mockRequestAuthenticated.mockReset();
});

describe('mobile SMS consent screen', () => {
  test('shows every disclosure term before anyone can agree', async () => {
    respondWith({ status: 'none' });

    render(<SmsConsentScreen />);

    // A carrier review is shown this screen and asks what the person read, so
    // each required line has to be on it rather than behind a link.
    for (const term of DISCLOSURE.terms) {
      expect(await screen.findByText(term)).toBeTruthy();
    }
  });

  test('leaves the agreement control off until the person turns it on', async () => {
    respondWith({ status: 'none' });

    render(<SmsConsentScreen />);

    const agree = await screen.findByTestId(SMS_CONSENT_TEST_IDS.agreeSwitch);
    expect(agree.props.value).toBe(false);
  });

  test('refuses to submit an untouched agreement control', async () => {
    respondWith({ status: 'none' });
    render(<SmsConsentScreen />);
    const input = await screen.findByTestId(SMS_CONSENT_TEST_IDS.numberInput);

    fireEvent.changeText(input, '(253) 555-0123');
    fireEvent.press(screen.getByTestId(SMS_CONSENT_TEST_IDS.submit));

    await waitFor(() => {
      expect(screen.getByTestId(SMS_CONSENT_TEST_IDS.notice)).toBeTruthy();
    });
    // One GET on mount and nothing else: no consent was recorded.
    expect(
      mockRequestAuthenticated.mock.calls.filter(
        ([options]) => (options as { method: string }).method !== 'GET',
      ),
    ).toHaveLength(0);
  });

  test('records the normalized number once the box is on', async () => {
    respondWith({ status: 'none' });
    render(<SmsConsentScreen />);
    const input = await screen.findByTestId(SMS_CONSENT_TEST_IDS.numberInput);

    fireEvent.changeText(input, '(253) 555-0123');
    fireEvent(
      screen.getByTestId(SMS_CONSENT_TEST_IDS.agreeSwitch),
      'valueChange',
      true,
    );
    fireEvent.press(screen.getByTestId(SMS_CONSENT_TEST_IDS.submit));

    await waitFor(() => {
      const mutations = mockRequestAuthenticated.mock.calls.filter(
        ([options]) => (options as { method: string }).method === 'POST',
      );
      expect(mutations).toHaveLength(1);
      expect((mutations[0]?.[0] as { body: unknown }).body).toEqual({
        phoneNumber: '+12535550123',
        disclosureVersion: '2026-09-04',
        agreed: true,
      });
    });
  });

  test('shows only the last four digits of a number already on file', async () => {
    respondWith({
      status: 'consented',
      lastFourDigits: '0123',
      disclosureVersion: '2026-09-04',
      consentedAt: '2026-09-04T00:00:00.000Z',
    });

    render(<SmsConsentScreen />);

    const summary = await screen.findByTestId(SMS_CONSENT_TEST_IDS.summary);
    const summaryText = String(summary.props.children);
    expect(summaryText).toContain('0123');
    // Scoped to the summary on purpose: the disclosure legitimately prints the
    // district's own support number, and asserting over the whole screen would
    // match that instead of proving anything about the staff member's number.
    expect(summaryText).not.toMatch(/\d{7,}/u);
    expect(summaryText).not.toContain('+1');
    expect(screen.getByTestId(SMS_CONSENT_TEST_IDS.withdraw)).toBeTruthy();
  });

  test('offers no withdrawal when there is nothing to withdraw', async () => {
    respondWith({ status: 'none' });

    render(<SmsConsentScreen />);

    await screen.findByTestId(SMS_CONSENT_TEST_IDS.submit);
    expect(screen.queryByTestId(SMS_CONSENT_TEST_IDS.withdraw)).toBeNull();
  });
});
