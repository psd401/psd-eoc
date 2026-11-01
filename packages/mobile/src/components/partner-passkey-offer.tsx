import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useMobileAuth } from '../lib/auth';

/**
 * The offer to add a passkey, shown once to a partner who has just signed in
 * with an emailed code.
 *
 * It is here rather than on the sign-in screen because the sign-in is already
 * over by the time there is anything to offer: the session is enrolled, the
 * partner is in, and this is about the next time. Declining it costs nothing
 * — the emailed code keeps working and the next code sign-in offers again —
 * so there is no step to complete and nothing is blocked behind it.
 *
 * It appears only when the server handed this device a hand-off and the
 * device can run a ceremony, so it is never an offer that cannot be accepted.
 *
 * Issue #647.
 */

export const PARTNER_PASSKEY_OFFER_TEST_IDS = Object.freeze({
  offer: 'partner-passkey-offer',
  add: 'partner-passkey-add',
  dismiss: 'partner-passkey-dismiss',
});

export function PartnerPasskeyOffer() {
  const {
    partnerPasskeyOffer,
    enrollPartnerPasskey,
    dismissPartnerPasskeyOffer,
  } = useMobileAuth();
  if (!partnerPasskeyOffer.offered) return null;
  const { busy, error } = partnerPasskeyOffer;

  return (
    <View
      accessibilityRole="summary"
      style={styles.card}
      testID={PARTNER_PASSKEY_OFFER_TEST_IDS.offer}
    >
      <Text accessibilityRole="header" style={styles.title}>
        Sign in faster next time
      </Text>
      <Text style={styles.body}>
        Add a passkey and this device signs you in with Face ID, your Android
        biometric, or its passcode. Your emailed code keeps working either way.
      </Text>
      {error === null ? null : (
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.error}
        >
          {error}
        </Text>
      )}
      <Pressable
        accessibilityHint="Asks this device to create a passkey for your partner agency account"
        accessibilityLabel="Add a passkey to this device"
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={() => {
          void enrollPartnerPasskey();
        }}
        style={({ pressed }) => [
          styles.primaryButton,
          pressed && !busy && styles.pressed,
          busy && styles.disabled,
        ]}
        testID={PARTNER_PASSKEY_OFFER_TEST_IDS.add}
      >
        {busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : null}
        <Text style={styles.primaryButtonText}>
          {busy ? 'Adding a passkey' : 'Add a passkey'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityHint="Keeps using emailed codes to sign in"
        accessibilityLabel="Not now"
        accessibilityRole="button"
        disabled={busy}
        onPress={dismissPartnerPasskeyOffer}
        style={({ pressed }) => [styles.link, pressed && styles.pressed]}
        testID={PARTNER_PASSKEY_OFFER_TEST_IDS.dismiss}
      >
        <Text style={styles.linkText}>Not now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#E8F1F8',
    borderColor: '#9DB8CF',
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 17,
  },
  title: {
    color: '#102A43',
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 24,
  },
  body: {
    color: '#334E68',
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    color: '#6B101B',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 22,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#175A8E',
    borderRadius: 12,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    marginTop: 4,
    minHeight: 52,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.76,
  },
  disabled: {
    opacity: 0.6,
  },
  link: {
    alignSelf: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  linkText: {
    color: '#175A8E',
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
    textDecorationLine: 'underline',
  },
});
