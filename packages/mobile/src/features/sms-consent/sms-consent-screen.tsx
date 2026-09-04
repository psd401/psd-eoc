import type { MySmsConsentView } from '@psd-eoc/contracts';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '../../lib/auth';
import { getEventTheme } from '../../theme/event-theme';
import { readMySmsConsent, recordSmsConsent, withdrawSmsConsent } from './api';
import { resolveSmsConsentSubmission, smsConsentSummary } from './model';

/** Stable identifiers for the native end-to-end flows. */
export const SMS_CONSENT_TEST_IDS = Object.freeze({
  agreeSwitch: 'sms-consent-agree',
  homeEntry: 'sms-consent-home-entry',
  notice: 'sms-consent-notice',
  numberInput: 'sms-consent-number',
  submit: 'sms-consent-submit',
  summary: 'sms-consent-summary',
  withdraw: 'sms-consent-withdraw',
});

type Notice = Readonly<{ kind: 'error' | 'success'; message: string }>;

function failureMessage(error: unknown, fallback: string): string {
  // Never interpolates the number that was submitted; the server's message is
  // already free of it and anything else falls back to fixed copy.
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback;
}

/**
 * The staff-facing consent screen, and the one a carrier reviewer is shown.
 *
 * The disclosure is rendered above the agreement control and is never
 * collapsed, because a toll-free review asks what the person read at the
 * moment they agreed.
 */
export function SmsConsentScreen() {
  const { requestAuthenticated } = useMobileAuth();
  const theme = getEventTheme('drill');
  const [view, setView] = useState<MySmsConsentView | null>(null);
  const [typedNumber, setTypedNumber] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setView(await readMySmsConsent(requestAuthenticated, signal));
      } catch (error) {
        setNotice({
          kind: 'error',
          message: failureMessage(
            error,
            'Your text message settings could not be loaded.',
          ),
        });
      }
    },
    [requestAuthenticated],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const submit = useCallback(async () => {
    if (view === null || busy) return;
    const resolved = resolveSmsConsentSubmission({ typedNumber, agreed });
    if (resolved.kind === 'blocked') {
      setNotice({ kind: 'error', message: resolved.message });
      return;
    }
    setBusy(true);
    try {
      await recordSmsConsent(requestAuthenticated, {
        phoneNumber: resolved.phoneNumber,
        // The version this screen actually rendered, not the current build's.
        disclosureVersion: view.disclosure.version,
        idempotencyKey: Crypto.randomUUID(),
      });
      setTypedNumber('');
      setAgreed(false);
      setNotice({
        kind: 'success',
        message: 'Saved. You will get emergency texts at this number.',
      });
      await load();
    } catch (error) {
      setNotice({
        kind: 'error',
        message: failureMessage(
          error,
          'The number could not be saved. Try again.',
        ),
      });
    } finally {
      setBusy(false);
    }
  }, [agreed, busy, load, requestAuthenticated, typedNumber, view]);

  const withdraw = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await withdrawSmsConsent(requestAuthenticated, {
        idempotencyKey: Crypto.randomUUID(),
      });
      setNotice({
        kind: 'success',
        message: 'Stopped. PSD EOC will no longer text you.',
      });
      await load();
    } catch (error) {
      setNotice({
        kind: 'error',
        message: failureMessage(
          error,
          'The change could not be saved. Try again.',
        ),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, load, requestAuthenticated]);

  if (view === null) {
    return (
      <SafeAreaView
        edges={['left', 'right', 'bottom']}
        style={[styles.page, { backgroundColor: theme.colors.pageBackground }]}
      >
        <View style={styles.loading}>
          <ActivityIndicator accessibilityLabel="Loading your text message settings" />
          {notice === null ? null : (
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.notice, { color: theme.colors.textPrimary }]}
              testID={SMS_CONSENT_TEST_IDS.notice}
            >
              {notice.message}
            </Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const consented = view.consent.status === 'consented';

  return (
    <SafeAreaView
      edges={['left', 'right', 'bottom']}
      style={[styles.page, { backgroundColor: theme.colors.pageBackground }]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text style={[styles.title, { color: theme.colors.textPrimary }]}>
          Emergency text messages
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.summary, { color: theme.colors.textMuted }]}
          testID={SMS_CONSENT_TEST_IDS.summary}
        >
          {smsConsentSummary(view.consent)}
        </Text>

        {notice === null ? null : (
          <Text
            accessibilityLiveRegion="assertive"
            style={[
              styles.notice,
              {
                color:
                  notice.kind === 'error'
                    ? theme.colors.textPrimary
                    : theme.colors.textMuted,
              },
            ]}
            testID={SMS_CONSENT_TEST_IDS.notice}
          >
            {notice.message}
          </Text>
        )}

        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Text style={[styles.cardTitle, { color: theme.colors.textPrimary }]}>
            What you are agreeing to
          </Text>
          {view.disclosure.terms.map((term) => (
            <Text
              key={term}
              style={[styles.term, { color: theme.colors.textMuted }]}
            >
              {term}
            </Text>
          ))}
          <Pressable
            accessibilityRole="link"
            onPress={() => {
              void Linking.openURL(view.disclosure.privacyPolicyUrl);
            }}
          >
            <Text style={[styles.link, { color: theme.colors.textPrimary }]}>
              Read the privacy policy
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.label, { color: theme.colors.textPrimary }]}>
          Mobile number
        </Text>
        <TextInput
          accessibilityLabel="Your mobile number"
          autoComplete="tel"
          editable={!busy}
          inputMode="tel"
          keyboardType="phone-pad"
          onChangeText={setTypedNumber}
          placeholder="(253) 555-0123"
          placeholderTextColor={theme.colors.textMuted}
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              color: theme.colors.textPrimary,
            },
          ]}
          testID={SMS_CONSENT_TEST_IDS.numberInput}
          value={typedNumber}
        />

        <View style={styles.agreeRow}>
          {/*
            Starts off. A pre-agreed control is not consent under carrier
            rules, and this switch is what the whole record rests on.
          */}
          <Switch
            accessibilityLabel={view.disclosure.agreementLabel}
            disabled={busy}
            onValueChange={setAgreed}
            testID={SMS_CONSENT_TEST_IDS.agreeSwitch}
            value={agreed}
          />
          <Text style={[styles.agreeText, { color: theme.colors.textPrimary }]}>
            {view.disclosure.agreementLabel}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => {
            void submit();
          }}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
            },
            pressed && styles.pressed,
          ]}
          testID={SMS_CONSENT_TEST_IDS.submit}
        >
          <Text
            style={[styles.buttonText, { color: theme.colors.textPrimary }]}
          >
            {consented ? 'Use this number instead' : 'Sign me up'}
          </Text>
        </Pressable>

        {consented ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => {
              void withdraw();
            }}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
              },
              pressed && styles.pressed,
            ]}
            testID={SMS_CONSENT_TEST_IDS.withdraw}
          >
            <Text
              style={[styles.buttonText, { color: theme.colors.textPrimary }]}
            >
              Stop texting me
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  agreeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  agreeText: { flex: 1, fontSize: 15, lineHeight: 21 },
  button: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 16,
    paddingVertical: 14,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    marginTop: 20,
    padding: 16,
  },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  content: { padding: 20 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 17,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  label: { fontSize: 15, fontWeight: '600', marginTop: 20 },
  link: { fontSize: 15, fontWeight: '600', marginTop: 4 },
  loading: { alignItems: 'center', flex: 1, gap: 12, justifyContent: 'center' },
  notice: { fontSize: 15, lineHeight: 21, marginTop: 12 },
  page: { flex: 1 },
  pressed: { opacity: 0.7 },
  summary: { fontSize: 15, lineHeight: 21, marginTop: 8 },
  term: { fontSize: 14, lineHeight: 20 },
  title: { fontSize: 24, fontWeight: '700' },
});
